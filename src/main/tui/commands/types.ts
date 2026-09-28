// Command contracts. Slash commands are typed in the prompt (`/loop new …`);
// palette actions are picked from the Ctrl+K palette. Both are contributed by
// view modules (views/<name>/commands.ts via the ViewDefinition) and by
// commands/builtin — never registered by editing a shared file.

import type { DaemonClient } from '../api/client'
import type { TuiActions, TuiStore } from '../state/store'
import type { TuiState } from '../state/types'

export interface CommandContext {
  store: TuiStore
  actions: TuiActions
  client: DaemonClient
  /** Current state snapshot (read at call time). */
  state(): TuiState
  /** The selected agent id, if any. */
  agentId: string | null
  /** The selected loop of the selected agent (`main` by default). */
  loop: string
  /** Positional args (whitespace split, quotes respected). */
  args: string[]
  /** Everything after the command name, untouched. */
  rest: string
  /** Report an outcome visibly (toast). */
  print(text: string, level?: 'info' | 'success' | 'warn' | 'error'): void
  /** Leave the TUI (agents keep running in the daemon). */
  exit(): void
}

/** Context for availability checks and completion (no args yet). */
export type CommandScope = Omit<CommandContext, 'args' | 'rest'>

export interface SlashCommand {
  /** Without the slash, lowercase, e.g. `loop`. Subcommands are parsed from args. */
  name: string
  aliases?: string[]
  /** Usage hint shown in help/completion, e.g. `new <name> <goal…>`. */
  args?: string
  description: string
  /** Owning view id; set by the registry from the contributing view. */
  view?: string
  /** Hide when not applicable (e.g. needs a selected agent). */
  available?: (scope: CommandScope) => boolean
  /** Argument completions for the partial text after the name. */
  complete?: (partial: string, scope: CommandScope) => string[]
  run: (ctx: CommandContext) => void | Promise<void>
}

export interface PaletteAction {
  /** Unique id, `<view>.<verb>` by convention, e.g. `loops.new`. */
  id: string
  title: string
  /** Secondary text (current value, target). */
  hint?: string
  /** Group heading in the palette, e.g. `Loops`. */
  group?: string
  /** Extra match terms. */
  keywords?: string[]
  /** Displayed shortcut (the binding itself lives in the view's key handler). */
  shortcut?: string
  view?: string
  available?: (scope: CommandScope) => boolean
  run: (ctx: CommandContext) => void | Promise<void>
}

/** What a view (or builtin module) contributes. */
export interface CommandContribution {
  commands?: SlashCommand[]
  actions?: PaletteAction[]
}
