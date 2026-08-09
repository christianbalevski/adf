/**
 * Shell tool — a bash-like interface that sits ALONGSIDE the agent's other
 * tools and can drive any of them by name.
 *
 * Implements the Tool interface. Enabling shell does not hide anything; a tool
 * appears as its own schema based solely on its enabled+visible flags. To
 * reclaim context (e.g. small/local models), hide the shell-drivable tools
 * (visible:false) — see shell-absorption.ts — and the shell still runs them.
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
import { protectionGatedRegistry } from './executor/protection-gated-registry'
import type { ShellGate } from './commands/types'
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
  /** Live config source. The shell gate MUST evaluate the agent's CURRENT
   *  config — a snapshot captured at construction goes stale the moment
   *  sys_update_config (or the UI) changes tool flags, making enabled tools
   *  exit 126 and `config set` lie. Reading through a provider function makes
   *  staleness structurally impossible: no fan-out site can forget to notify. */
  private getConfig: () => AgentConfig
  private mcpClientManager: McpClientManager | null
  private env: EnvironmentResolver

  /** Callback fired when shell command is intercepted by on_tool_call trigger */
  onToolCallIntercepted?: (tool: string, args: string, taskId: string, origin: string) => void
  /** Callback for HIL approval — returns true if user approves the tool call */
  onApprovalRequired?: (toolName: string, command: string) => Promise<boolean>
  /** Callback for HIL override approval when a pipeline tool call hits a data protection */
  onProtectionBlocked?: ShellGate['onProtectionBlocked']

  constructor(
    toolRegistry: ToolRegistry,
    workspace: AdfWorkspace,
    config: AgentConfig | (() => AgentConfig),
    mcpClientManager?: McpClientManager | null
  ) {
    this.toolRegistry = toolRegistry
    this.workspace = workspace
    this.getConfig = typeof config === 'function' ? config : () => config
    this.mcpClientManager = mcpClientManager ?? null
    this.env = new EnvironmentResolver(this.getConfig(), workspace)
  }

  /** Set trigger context for current turn (called per-turn by executor) */
  setTriggerContext(dispatch: AdfEventDispatch): void {
    this.env.setTriggerContext(dispatch)
  }

  /** Re-point the shell at a live config source (e.g. the owning executor's
   *  config). assembleAgent calls this on every assembly so a shell reused
   *  across registry lifetimes always gates against the current executor. */
  setConfigProvider(getConfig: () => AgentConfig): void {
    this.getConfig = getConfig
  }

  /** Update config reference (for when config changes between turns).
   *  Prefer setConfigProvider — a static snapshot set here goes stale again
   *  the next time config changes without this being called. */
  updateConfig(config: AgentConfig): void {
    this.getConfig = () => config
  }

  async execute(input: unknown, workspace: AdfWorkspace): Promise<ToolResult> {
    const { command } = input as z.infer<typeof InputSchema>
    const startTime = Date.now()

    if (!command || !command.trim()) {
      return { content: JSON.stringify({ exit_code: 0, stdout: '', stderr: '' }), isError: false }
    }

    // Resolve the CURRENT config once per command — the gate inside the
    // executor must see live enabled/restricted flags, not a construction-time
    // snapshot (stale snapshots made enabled tools exit 126).
    const config = this.getConfig()

    try {
      // 1. Parse
      const ast = parse(command)

      // 2. Execute pipeline with timeout + abort signal. Permission gating is
      // enforced per-command inside the executor (via ctx.gate) rather than by
      // a pre-walk here, so scripts, xargs, and $() substitutions — which build
      // sub-pipelines at runtime — inherit the same disabled/HIL/on_tool_call
      // checks instead of bypassing them.
      const timeoutMs = config.limits?.execution_timeout_ms ?? 60_000
      const ac = new AbortController()
      let timer = setTimeout(() => ac.abort(), timeoutMs)

      // Pause the shell timeout while a human decision is pending — otherwise
      // the 60s timer fires mid-approval and the pipeline dies with exit 124
      // while the HIL task is still parked.
      const pauseTimeout = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
        async (...args: A): Promise<R> => {
          clearTimeout(timer)
          try {
            return await fn(...args)
          } finally {
            timer = setTimeout(() => ac.abort(), timeoutMs)
          }
        }

      const gate: ShellGate = {
        command,
        onApprovalRequired: this.onApprovalRequired ? pauseTimeout(this.onApprovalRequired) : undefined,
        onProtectionBlocked: this.onProtectionBlocked ? pauseTimeout(this.onProtectionBlocked) : undefined,
        onToolCallIntercepted: this.onToolCallIntercepted,
      }

      const ctx: ExecutorContext = {
        workspace,
        toolRegistry: protectionGatedRegistry(this.toolRegistry, gate),
        config,
        env: this.env,
        mcpClientManager: this.mcpClientManager,
        gate,
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
