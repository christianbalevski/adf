// View contract. Each feature lives in views/<id>/ and default-exports a
// ViewDefinition from views/<id>/index.tsx. The shell renders the active
// view's `component` in the main pane (and its `sidebar`, if any, in place of
// the default fleet/loop tree).

import type { ComponentType } from 'react'
import type { CommandContext, CommandScope, PaletteAction, SlashCommand } from '../commands/types'
import type { KeyHintSpec } from '../ui/KeyHint'
import type { Overlay } from '../state/types'

export interface ViewProps {
  /** Cells available to the view (inside the main pane). */
  width: number
  height: number
  /** The main zone has focus (keys in layer 'main' reach the view). */
  focused: boolean
}

export interface SidebarProps {
  width: number
  height: number
  /** The sidebar zone has focus. */
  focused: boolean
}

export interface ViewDefinition {
  /** Stable id, also the directory name: 'fleet' | 'chat' | 'files' | 'loops' | 'inspect'. */
  id: string
  title: string
  /**
   * Hotkey: pressed alone when focus is not in the prompt, or with Alt from
   * anywhere. Digits by convention ('1'..'9').
   */
  key: string
  component: ComponentType<ViewProps>
  /** Replaces the default sidebar while this view is active. */
  sidebar?: ComponentType<SidebarProps>
  /** Hide the sidebar entirely while this view is active. */
  fullWidth?: boolean
  /**
   * The shell's prompt line (bottom of the main pane, focus zone 'input').
   * Undefined = shown with the default behavior (plain text is sent as chat
   * to the selected agent + loop); `false` hides it for this view.
   */
  prompt?: PromptConfig | false
  /** Hints for the status bar while this view is active. */
  keyHints?: KeyHintSpec[] | ((scope: CommandScope) => KeyHintSpec[])
  /** The view's full key reference for /help, in sections. Defaults to `keyHints`. */
  helpKeys?: HelpKeySection[]
  commands?: SlashCommand[]
  actions?: PaletteAction[]
  /**
   * Dialogs this view can open with `actions.pushOverlay({ kind: '<id>.<name>' })`.
   * Keys are the full kind, prefixed with the view id (e.g. 'loops.new').
   */
  overlays?: Record<string, ComponentType<OverlayProps>>
}

export interface HelpKeySection {
  /** e.g. 'Timers tab'; omitted = the view's main keys. */
  title?: string
  keys: KeyHintSpec[]
}

export interface OverlayProps {
  /** The overlay entry (id, kind, props passed to pushOverlay). */
  overlay: Overlay
  /** Pop this overlay. */
  close: () => void
  /** Cells available for the dialog. */
  width: number
  height: number
}

export interface PromptConfig {
  placeholder?: string | ((scope: CommandScope) => string)
  /**
   * Handle non-slash text. Return true when handled; false falls through to
   * the default (chat to the selected agent + loop). Slash input never gets
   * here — the shell runs it through the command registry.
   */
  onSubmit?: (text: string, ctx: CommandContext) => boolean | Promise<boolean>
  /** Keep ↑ history per key (e.g. per agent + loop). Default: one shared history. */
  historyKey?: (scope: CommandScope) => string
  /** Keep the unsent text per key and restore it when the key comes back. Default: 'shell'. */
  draftKey?: (scope: CommandScope) => string
  /**
   * Non-slash completions (e.g. `@path`), shown in the prompt's suggestion
   * menu and accepted with Tab. `cursor` is the caret offset (end of text).
   */
  complete?: (value: string, cursor: number, scope: CommandScope) => PromptCompletion[] | Promise<PromptCompletion[]>
}

export interface PromptCompletion {
  /** The whole prompt text after accepting. */
  value: string
  /** Caret offset after accepting. */
  cursor: number
  label: string
  description?: string
}
