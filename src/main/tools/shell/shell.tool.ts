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
import { DOCS_GUIDES_URL } from '../../../shared/constants/adf-defaults'

const InputSchema = z.object({
  command: z.string().describe('Bash command or pipeline')
})


export class ShellTool implements Tool {
  readonly name = 'adf_shell'
  /**
   * The full shell guide lives HERE rather than in a system-prompt section so
   * it rides with the schema: when the shell is hidden (visible:false) the
   * agent pays zero context for it, and no prompt-assembly conditional exists.
   */
  readonly description = `A virtual shell over your workspace, not real bash — but its core utilities ARE real: \`jq\` is real jq 1.8.2 and \`sort\`/\`uniq\`/\`wc\`/\`cut\`/\`tr\` are real GNU coreutils (via WASM), so their full flag surfaces and semantics work (jq \`def\`/\`foreach\`/\`@base64\`/slurp, \`sort -t/-k\`, \`tr\` ranges/classes, \`cut -c\`, ...). Standard syntax works — pipes, \`&&\`/\`||\`/\`;\`, redirects, \`$VAR\`, \`$(cmd)\`, quoting, heredocs. Deviations from bash:

- Supported beyond the basics: glob expansion in arguments (\`grep TODO *.md\`) and \`2>&1\`.
- Not supported: background \`&\` (treated as \`;\`), subshells, arithmetic, process substitution, arrays, and control flow (if/for/while/case) — chain with \`&&\`/\`||\`, iterate with \`xargs\`, or put logic in a script (below).
- The filesystem is flat (no real directories): \`pwd\` returns \`/\`, \`grep pattern .\` searches all files. grep/sed are built-ins (not GNU): JS/ERE regex, and \`2>/dev/null\` is silently ignored. They implement the common flags (grep \`-i/-v/-c/-n/-r/-o/-F/-w/-x/-l/-q/-m/-A/-B/-C\`; sed \`s///[gi]\` with \`&\` and \`\\1\`) and REJECT anything else (e.g. grep \`-P\`, sed addresses/\`-n\`) with a clear error rather than silently misbehaving — so a rejected flag is a one-line fix, not wrong output.
- \`cat\` prints raw contents (\`cat -n\` for line numbers). \`cat\` on an image/audio/video file attaches it for viewing if your model supports that modality — you'll see a marker in stdout and receive the media alongside the result.
- Prefer \`fs_write\` over echo/heredoc for multi-line files. To EDIT a file, use \`fs_write\` mode="edit" (exact old_text→new_text, add replace_all for all occurrences, or an atomic edits[] batch) rather than \`sed\`/rewriting the whole file — it's precise and concurrency-safe.
- Exit code 130 means the call is awaiting or was refused human approval — a task was created, do not retry.
- Pipelines return the LAST stage's exit code (no pipefail): \`rm x 2>&1 | cat\` exits 0 even though rm failed. To branch on a gated/failed producer, don't pipe it — capture stderr and check the code directly: \`cmd 2>err.txt; echo $?\`.

Beyond filesystem/text commands: \`jq\`, \`sqlite3\`, \`node\`, \`curl\`, plus ADF-specific \`msg\`, \`who\`, \`ping\`, \`at\`, \`crontab\`, \`whoami\`, \`config\`, \`status\`, \`state\`. \`state [idle|hibernate|off]\` is sys_set_state — chain your last bookkeeping into the yield (\`meta set status "shipped" && state idle\`); it ends the turn when the whole invocation returns, so put it last. \`help\` lists everything; \`<command> -h\` for details. \`curl\` wraps the sys_fetch tool: stdout is a JSON envelope \`{status,headers,body}\` (\`curl -s url | jq -r .body\`), and \`-o\` saves just the raw body.

Scripts: save pipelines or code as VFS files and run them with \`./name.sh\` (parsed as one script — heredocs and comments work; failures don't stop the script unless you chain with \`&&\`) or \`./name.ts\`/\`./name.js\` (runs as a lambda with the \`adf\` object). For work that runs without waking you, point a timer or trigger at the file: \`sys_set_timer\` with \`scope: ["system"], lambda: "path/script.sh"\` (or \`.ts:fn\`), or a trigger target's \`lambda\`/\`command\` field.

Tool discovery: the shell sits alongside your other tools — it can run any of them by name whether or not they appear as a schema. \`config tools\` lists every tool (including any hidden ones); \`config tools <name>\` returns full schemas — fetch these before writing lambda code that calls \`adf.<tool>(...)\`. Hiding a tool (\`visible: false\` via sys_update_config) drops its schema to save context but the shell can still call it; surface it again by setting \`visible: true\`. \`adf <tool> '<json>'\` invokes any tool directly (input is one single-quoted JSON object) — the door for tools without a dedicated command.

Command permissions: shell commands are gated solely by the tools they resolve to — if a command exits 126, the named tool is disabled; ask the owner to enable that tool rather than retrying. Pure text/data commands (\`jq\`, \`sort\`, \`tr\`, ...) use no tools and always run.

Execution surfaces — pick by where the work must run:
- \`adf_shell\`: your workspace (VFS), synchronous, mid-turn. Default choice.
- \`sys_code\` / lambdas: sandboxed JS/TS against workspace tools (\`adf.*\`) — use for logic, loops, or headless trigger-driven work.
- \`compute_exec\`: a real OS in a container — only when you need real processes, packages, or a browser.
- \`fs_transfer\`: the airlock moving files between VFS and host/container. Not an execution surface.

Event context arrives as env vars (\`$EVENT_TYPE\`, \`$MSG_ID\`, \`$TIMER_ID\`, ...) — \`env\` lists them.

Full guide: ${DOCS_GUIDES_URL}/tools.md`
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

    // Invocation-start snapshot, used ONLY for invocation-level settings
    // (timeout). The permission gate does NOT use this: the executor re-reads
    // the live provider before every command, so a `config set` mid-script is
    // visible to later commands in the same invocation.
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

      // Live provider handed to the executor AND the gate: the per-command
      // gate re-reads it so `config set X && use-X` works within ONE
      // invocation (the invocation-start `config` above is only for limits).
      // Read through `this` so setConfigProvider mid-execution is honored.
      const getConfig = () => this.getConfig()

      const gate: ShellGate = {
        command,
        getConfig,
        onApprovalRequired: this.onApprovalRequired ? pauseTimeout(this.onApprovalRequired) : undefined,
        onProtectionBlocked: this.onProtectionBlocked ? pauseTimeout(this.onProtectionBlocked) : undefined,
        onToolCallIntercepted: this.onToolCallIntercepted,
      }

      const ctx: ExecutorContext = {
        workspace,
        toolRegistry: protectionGatedRegistry(this.toolRegistry, gate),
        config,
        getConfig,
        env: this.env,
        mcpClientManager: this.mcpClientManager,
        gate,
        signal: ac.signal,
      }

      let result: {
        exit_code: number
        stdout: string
        stderr: string
        media?: Array<{ path: string; mime_type: string }>
        end_turn?: boolean
        target_state?: string
      }
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

      // `state idle` / `adf sys_set_state` inside the pipeline ends the turn
      // like a direct sys_set_state call: endTurn stops the tool loop and
      // target_state (top-level, same key sys_set_state uses) is what the
      // executor and the deferred/lambda paths read to apply the transition.
      return {
        content: JSON.stringify({
          exit_code: result.exit_code,
          stdout: result.stdout,
          stderr: result.stderr,
          ...(result.media?.length ? { media: result.media } : {}),
          ...(result.target_state ? { target_state: result.target_state } : {}),
        }),
        isError: false,
        ...(result.end_turn ? { endTurn: true } : {}),
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
