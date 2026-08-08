/**
 * Command handler interface and result types for the shell.
 */

import type { AdfWorkspace } from '../../../adf/adf-workspace'
import type { ToolRegistry } from '../../tool-registry'
import type { AgentConfig } from '@shared/types/adf-v02.types'
import type { ProtectionDenial } from '@shared/types/tool.types'
import type { EnvironmentResolver } from '../executor/environment'
import type { ArgumentNode } from '../parser/ast'

/**
 * Permission gate carried on the execution context. Enforced per-command in
 * the pipeline executor so EVERY path — interactive shell, scripts, xargs,
 * $() substitution, trigger/timer commands — inherits the same disabled /
 * HIL-approval / on_tool_call checks. Authorized .sh scripts bypass
 * disabled+approval (same privilege as the UI).
 */
export interface ShellGate {
  /** Set from isFileAuthorized() for an authorized .sh script. Never derived
   *  from parsed input, so the agent cannot forge it via a command flag. */
  authorized?: boolean
  /** Original command string, for approval prompts / intercept task args. */
  command?: string
  /** HIL approval callback; absent → restricted tools fail closed (exit 130). */
  onApprovalRequired?: (toolName: string, command: string) => Promise<boolean>
  /** HIL override request when a tool call inside the pipeline is denied by a
   *  data protection (file/meta/config lock); absent → denial surfaces as-is. */
  onProtectionBlocked?: (
    toolName: string,
    input: Record<string, unknown>,
    protection: ProtectionDenial,
    command: string
  ) => Promise<{ approved: boolean; modifiedArgs?: Record<string, unknown>; feedback?: string }>
  /** on_tool_call interception notifier. */
  onToolCallIntercepted?: (tool: string, args: string, taskId: string, origin: string) => void
}

export interface CommandContext {
  /** Piped stdin from previous stage */
  stdin: string
  /** Parsed positional arguments */
  args: string[]
  /** Parsed flags: --flag value or -f value or --bool-flag (true) */
  flags: Record<string, string | boolean | string[]>
  /** Original resolved argv (flags + positionals, unparsed) — used by
   *  WASM applet handlers to pass arguments through verbatim */
  rawArgs?: string[]
  /** True when the pipeline runs under an authorized .sh script (set by the
   *  executor gate from isFileAuthorized). Never derived from parsed input, so
   *  the agent cannot forge it. Lets commands bypass protection like the UI. */
  authorized?: boolean
  /** Permission gate, forwarded so command handlers that re-enter the executor
   *  (e.g. xargs) propagate gating to the sub-commands they spawn. */
  gate?: ShellGate
  /** Abort signal (shell timeout/cancel) — forwarded to worker-backed applets
   *  so a cancelled shell terminates in-flight WASM. */
  signal?: AbortSignal
  /** Nesting depth of script/xargs re-entry, to bound runaway recursion
   *  (e.g. a .sh that runs itself). */
  depth?: number
  /** Agent workspace (VFS, database, identity) */
  workspace: AdfWorkspace
  /** Tool registry for dispatching to underlying tools */
  toolRegistry: ToolRegistry
  /** Agent config */
  config: AgentConfig
  /** Environment variable resolver */
  env: EnvironmentResolver
}

export interface CommandResult {
  exit_code: number
  stdout: string
  stderr: string
  /** Media files read during this command (images/audio/video). The executor
   *  injects them as multimodal blocks after the tool result when the model
   *  supports that modality — base64 never flows through stdout. */
  media?: Array<{ path: string; mime_type: string }>
}

export interface CommandHandler {
  /** Primary command name (e.g. 'cat', 'grep', 'msg') */
  name: string
  /** Alternative names (e.g. ['wget'] for curl) */
  aliases?: string[]
  /** One-line description for help listing */
  summary: string
  /** Detailed help text shown via -h */
  helpText: string
  /** Category for grouping in help output */
  category: CommandCategory
  /** Which underlying tools this command uses (for preflight permission checks) */
  resolvedTools: string[]
  /** Resolve additional tools dynamically from command args (e.g. MCP tool names).
   *  Called by preflight when resolvedTools is empty or incomplete. */
  resolveToolsFromArgs?(args: ArgumentNode[]): string[]
  /** Short flags that take a value argument (e.g. new Set(['d', 'f']) for cut -d "," -f 2).
   *  All other single-char flags are treated as boolean. */
  valueFlags?: Set<string>
  /** Execute the command */
  execute(ctx: CommandContext): Promise<CommandResult>
}

export type CommandCategory =
  | 'filesystem'
  | 'text'
  | 'data'
  | 'messaging'
  | 'network'
  | 'timers'
  | 'code'
  | 'process'
  | 'identity'
  | 'mcp'
  | 'general'

/** Standard exit codes */
export const EXIT = {
  SUCCESS: 0,
  ERROR: 1,
  DISABLED: 126,
  NOT_FOUND: 127,
  APPROVAL: 128,
  INTERCEPTED: 130,
} as const

/** Helper to create a successful result */
export function ok(stdout: string): CommandResult {
  return { exit_code: EXIT.SUCCESS, stdout, stderr: '' }
}

/** Helper to create an error result */
export function err(stderr: string, code: number = EXIT.ERROR): CommandResult {
  return { exit_code: code, stdout: '', stderr }
}
