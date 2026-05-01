/**
 * Command handler interface and result types for the shell.
 */

import type { AdfWorkspace } from '../../../adf/adf-workspace'
import type { ToolRegistry } from '../../tool-registry'
import type { AgentConfig } from '@shared/types/adf-v02.types'
import type { EnvironmentResolver } from '../executor/environment'
import type { ArgumentNode } from '../parser/ast'

export interface CommandContext {
  /** Piped stdin from previous stage */
  stdin: string
  /** Parsed positional arguments */
  args: string[]
  /** Parsed flags: --flag value or -f value or --bool-flag (true) */
  flags: Record<string, string | boolean | string[]>
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
export function err(stderr: string, code = EXIT.ERROR): CommandResult {
  return { exit_code: code, stdout: '', stderr }
}
