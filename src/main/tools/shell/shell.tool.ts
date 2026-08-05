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
import { executeNode, type ExecutorContext } from './executor/pipeline-executor'
import { EnvironmentResolver } from './executor/environment'
import type { AdfEventDispatch } from '@shared/types/adf-event.types'

const InputSchema = z.object({
  command: z.string().describe('Bash command or pipeline')
})


export class ShellTool implements Tool {
  readonly name = 'adf_shell'
  readonly description =
    'Execute shell commands against your workspace. Supports pipes, redirection, variables, chaining, ' +
    'and heredocs. Includes real jq 1.8.2 and real GNU coreutils (sort/uniq/wc/cut/tr via WASM), plus ' +
    'sqlite3, node, curl, and ADF commands (msg, timer, config, ...). `help` lists commands; ' +
    '`config tools [name]` shows tool schemas for writing lambdas; run saved scripts with `./script.sh`. ' +
    '`cat` on an image/audio/video file attaches it for viewing when your model supports that modality.'
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

      // 2. Execute pipeline with timeout + abort signal. Permission gating is
      // enforced per-command inside the executor (via ctx.gate) rather than by
      // a pre-walk here, so scripts, xargs, and $() substitutions — which build
      // sub-pipelines at runtime — inherit the same disabled/HIL/on_tool_call
      // checks instead of bypassing them.
      const timeoutMs = this.config.limits?.execution_timeout_ms ?? 60_000
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), timeoutMs)

      const ctx: ExecutorContext = {
        workspace,
        toolRegistry: this.toolRegistry,
        config: this.config,
        env: this.env,
        mcpClientManager: this.mcpClientManager,
        gate: {
          command,
          onApprovalRequired: this.onApprovalRequired,
          onToolCallIntercepted: this.onToolCallIntercepted,
        },
        signal: ac.signal,
      }

      let result: { exit_code: number; stdout: string; stderr: string; media?: Array<{ path: string; mime_type: string }> }
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
          ...(result.media?.length ? { media: result.media } : {}),
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
