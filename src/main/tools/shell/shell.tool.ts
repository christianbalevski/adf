/**
 * Shell tool — single tool that replaces most of the agent's tool catalog
 * with a bash-like interface.
 *
 * Implements the Tool interface. When shell is enabled, absorbed tools are NOT
 * injected as individual schemas to the LLM — saving thousands of tokens per turn.
 */

import { z } from 'zod'
import type { Tool, ToolCategory } from '../tool.interface'
import type { ToolResult, ToolProviderFormat } from '@shared/types/tool.types'
import type { AdfWorkspace } from '../../adf/adf-workspace'
import type { ToolRegistry } from '../tool-registry'
import type { AgentConfig } from '@shared/types/adf-v02.types'
import type { McpClientManager } from '../mcp/mcp-client-manager'
import { parse, ParseError } from './parser/parser'
import { preflight } from './executor/preflight'
import { executeNode, type ExecutorContext } from './executor/pipeline-executor'
import { EnvironmentResolver } from './executor/environment'
import type { AdfEventDispatch } from '@shared/types/adf-event.types'

const InputSchema = z.object({
  command: z.string().describe('Bash command or pipeline')
})


export class ShellTool implements Tool {
  readonly name = 'adf_shell'
  readonly description = 'Execute shell commands. Supports pipes, redirection, variables, and chaining.'
  readonly inputSchema = InputSchema
  readonly category: ToolCategory = 'system'

  private toolRegistry: ToolRegistry
  private workspace: AdfWorkspace
  private config: AgentConfig
  private mcpClientManager: McpClientManager | null
  private env: EnvironmentResolver

  /** Callback fired when shell command is intercepted by on_tool_call trigger */
  onToolCallIntercepted?: (tool: string, args: string, taskId: string, origin: string) => void
  /** Callback for HIL approval — returns true if user approves the tool call */
  onApprovalRequired?: (toolName: string, command: string) => Promise<boolean>

  constructor(
    toolRegistry: ToolRegistry,
    workspace: AdfWorkspace,
    config: AgentConfig,
    mcpClientManager?: McpClientManager | null
  ) {
    this.toolRegistry = toolRegistry
    this.workspace = workspace
    this.config = config
    this.mcpClientManager = mcpClientManager ?? null
    this.env = new EnvironmentResolver(config, workspace)
  }

  /** Set trigger context for current turn (called per-turn by executor) */
  setTriggerContext(dispatch: AdfEventDispatch): void {
    this.env.setTriggerContext(dispatch)
  }

  /** Update config reference (for when config changes between turns) */
  updateConfig(config: AgentConfig): void {
    this.config = config
  }

  async execute(input: unknown, workspace: AdfWorkspace): Promise<ToolResult> {
    const { command } = input as z.infer<typeof InputSchema>
    const startTime = Date.now()

    if (!command || !command.trim()) {
      return { content: JSON.stringify({ exit_code: 0, stdout: '', stderr: '' }), isError: false }
    }

    try {
      // 1. Parse
      const ast = parse(command)

      // 2. Pre-flight permission check
      const check = preflight(ast, this.config, workspace, command)
      if (!check.allowed) {
        // HIL approval: pause and ask user, proceed if approved
        if (check.approval_required?.length) {
          if (!this.onApprovalRequired) {
            return { content: JSON.stringify({
              exit_code: 130, stdout: '', stderr:
                `Tools [${check.approval_required.join(', ')}] require approval but no approval handler is configured.`
            }), isError: false }
          }
          // Request approval for each tool — reject entire pipeline if any denied
          for (const toolName of check.approval_required) {
            const approved = await this.onApprovalRequired(toolName, command)
            if (!approved) {
              return { content: JSON.stringify({
                exit_code: 130, stdout: '',
                stderr: `Tool "${toolName}" was rejected by the user.`
              }), isError: false }
            }
          }
          // All approved — check if there are also on_tool_call intercepts
          if (!check.intercepted_tools?.length) {
            // All clear — fall through to execution
          }
        }

        // on_tool_call trigger interception: create task, notify, block
        if (check.intercepted_tools?.length) {
          if (check.task_id && this.onToolCallIntercepted) {
            const originLabel = this.config.id
              ? `agent:${this.config.name}:${this.config.id}`
              : `agent:${this.config.name}`
            const argsStr = JSON.stringify({
              command,
              resolved: check.resolved_tools,
              intercepted_by: check.intercepted_tools
            })
            for (const tool of check.intercepted_tools) {
              this.onToolCallIntercepted(tool, argsStr, check.task_id, originLabel)
            }
          }

          const result: Record<string, unknown> = {
            exit_code: check.exit_code,
            stdout: '',
            stderr: check.stderr ?? '',
          }
          if (check.task_id) {
            result.task_id = check.task_id
            result.status = check.status
            result.stderr = `Command intercepted: tools [${check.intercepted_tools.join(', ')}] match on_tool_call trigger. ` +
              `Task ${check.task_id} created. ` +
              `Check status with \`ps ${check.task_id}\` or \`wait ${check.task_id}\`. ` +
              `Do not retry this command — it will be resolved by the operator.`
          }
          return { content: JSON.stringify(result), isError: false }
        }

        // Disabled tool or other non-approval/non-intercept block
        if (!check.approval_required?.length) {
          return { content: JSON.stringify({
            exit_code: check.exit_code, stdout: '', stderr: check.stderr ?? ''
          }), isError: false }
        }
      }

      // 3. Execute pipeline with timeout + abort signal
      const timeoutMs = this.config.limits?.execution_timeout_ms ?? 30_000
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), timeoutMs)

      const ctx: ExecutorContext = {
        workspace,
        toolRegistry: this.toolRegistry,
        config: this.config,
        env: this.env,
        mcpClientManager: this.mcpClientManager,
        signal: ac.signal,
      }

      let result: { exit_code: number; stdout: string; stderr: string }
      try {
        result = await Promise.race([
          executeNode(ast, '', ctx),
          new Promise<never>((_, reject) => {
            ac.signal.addEventListener('abort', () =>
              reject(new ShellTimeoutError(timeoutMs))
            )
          }),
        ])
      } finally {
        clearTimeout(timer)
      }

      // 4. Log to adf_logs
      const durationMs = Date.now() - startTime
      const summary = command.length > 80 ? command.slice(0, 77) + '...' : command
      try {
        workspace.insertLog('info', 'adf_shell', 'execute', summary, `duration_ms=${durationMs}`)
      } catch { /* logging failure is non-fatal */ }

      return {
        content: JSON.stringify({
          exit_code: result.exit_code,
          stdout: result.stdout,
          stderr: result.stderr,
        }),
        isError: false,
      }
    } catch (error) {
      if (error instanceof ParseError) {
        const summary = command.length > 80 ? command.slice(0, 77) + '...' : command
        try { workspace.insertLog('warn', 'adf_shell', 'parse_error', summary, error.message) } catch { /* non-fatal */ }
        return {
          content: JSON.stringify({
            exit_code: 1,
            stdout: '',
            stderr: `parse error: ${error.message}`,
          }),
          isError: false,
        }
      }
      if (error instanceof ShellTimeoutError) {
        const durationMs = Date.now() - startTime
        const summary = command.length > 80 ? command.slice(0, 77) + '...' : command
        try {
          workspace.insertLog('warn', 'adf_shell', 'timeout', summary, `duration_ms=${durationMs}`)
        } catch { /* logging failure is non-fatal */ }
        return {
          content: JSON.stringify({
            exit_code: 124,
            stdout: '',
            stderr: `shell: command timed out after ${error.timeoutMs / 1000}s`,
          }),
          isError: false,
        }
      }
      const summary = command.length > 80 ? command.slice(0, 77) + '...' : command
      try { workspace.insertLog('error', 'adf_shell', 'error', summary, String(error).slice(0, 200)) } catch { /* non-fatal */ }
      return {
        content: JSON.stringify({
          exit_code: 1,
          stdout: '',
          stderr: `shell error: ${String(error)}`,
        }),
        isError: false,
      }
    }
  }

  toProviderFormat(): ToolProviderFormat {
    return {
      name: this.name,
      description: this.description,
      input_schema: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'Bash command or pipeline',
          }
        },
        required: ['command'],
      }
    }
  }
}

class ShellTimeoutError extends Error {
  constructor(public timeoutMs: number) {
    super(`Shell command timed out after ${timeoutMs}ms`)
    this.name = 'ShellTimeoutError'
  }
}
