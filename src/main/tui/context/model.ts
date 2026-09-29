// /context: pure helpers for the context dialog and the chat footer's "ctx N%".
// The daemon's GET /agents/:id/context does the measuring (the loop
// executor's getContextBreakdown(), the same figures Studio's context modal
// shows) and the category split (src/shared/utils/context-breakdown.ts).

import type { AgentConfig, AgentContextResult, ContextCategory } from '../api/types'
import { cjs } from '../interop'
import * as contextNs from '../../../shared/utils/context-breakdown'

const { resolveLoopThreshold } = cjs(contextNs)

/** Overlay kind (registered by the shell's overlay host). */
export const CONTEXT_OVERLAY = 'context'

export interface ContextOverlayProps {
  agentId: string
  loop: string
}

/** Opens the context dialog on one (agent, loop). */
export function openContext(store: { actions: { pushOverlay(o: { kind: string; props?: Record<string, unknown> }): string } }, props: ContextOverlayProps): void {
  store.actions.pushOverlay({ kind: CONTEXT_OVERLAY, props: { ...props } })
}

export type Pressure = 'ok' | 'warn' | 'high'

/** Share of the compact threshold used: under 70% ok, under 90% warn, else high. */
export function pressureOf(percent: number): Pressure {
  return percent >= 90 ? 'high' : percent >= 70 ? 'warn' : 'ok'
}

/** Filled cells of a `width`-cell bar for `value` out of `max` (rounded: a negligible share shows empty). */
export function barFill(value: number, max: number, width: number): number {
  if (width <= 0 || max <= 0 || value <= 0) return 0
  return Math.min(width, Math.round((value / max) * width))
}

/** A bar as text: filled + empty cells. */
export function barText(value: number, max: number, width: number, ascii: boolean): { filled: string; empty: string } {
  const n = barFill(value, max, width)
  return { filled: (ascii ? '#' : '█').repeat(n), empty: (ascii ? '.' : '░').repeat(Math.max(0, width - n)) }
}

const SOURCE_TEXT: Record<AgentContextResult['compactThresholdSource'], string> = {
  loop: 'this loop’s own setting',
  agent: 'the agent’s context setting',
  model: 'the model setting',
  default: 'the default',
}

/** "auto-compacts at 100k (the agent’s context setting)". */
export function thresholdText(r: Pick<AgentContextResult, 'compactThreshold' | 'compactThresholdSource'>, fmt: (n: number) => string): string {
  return `auto-compacts at ${fmt(r.compactThreshold)} (${SOURCE_TEXT[r.compactThresholdSource]})`
}

/** One row of the category table: a category, or one of an expanded category's items. */
export type ContextRow =
  | { kind: 'category'; category: ContextCategory; expanded: boolean; expandable: boolean }
  | { kind: 'item'; categoryId: string; name: string; tokens: number; detail?: string }
  | { kind: 'more'; categoryId: string; hidden: number }

/** Categories in order, with the expanded one's top items under it. */
export function contextRows(categories: ContextCategory[], expanded: string | null): ContextRow[] {
  const rows: ContextRow[] = []
  for (const category of categories) {
    const expandable = category.items.length > 0
    const open = expandable && expanded === category.id
    rows.push({ kind: 'category', category, expanded: open, expandable })
    if (!open) continue
    for (const item of category.items) rows.push({ kind: 'item', categoryId: category.id, name: item.name, tokens: item.tokens, detail: item.detail })
    const hidden = (category.count ?? category.items.length) - category.items.length
    if (hidden > 0) rows.push({ kind: 'more', categoryId: category.id, hidden })
  }
  return rows
}

/** Index of the category row with `id` (the cursor moves over categories only). */
export function categoryIndex(categories: ContextCategory[], id: string | null): number {
  const i = categories.findIndex(c => c.id === id)
  return i < 0 ? 0 : i
}

/** First row to draw so that row `cursor` stays inside a `height`-row window. */
export function windowStart(total: number, cursor: number, height: number, current: number): number {
  if (total <= height) return 0
  let start = Math.min(current, total - height)
  if (cursor < start) start = cursor
  if (cursor >= start + height) start = cursor - height + 1
  return Math.max(0, start)
}

/** Percent of a threshold, rounded (null without a usable threshold). */
export function percentOf(tokens: number, threshold: number): number | null {
  if (!Number.isFinite(tokens) || tokens <= 0 || !Number.isFinite(threshold) || threshold <= 0) return null
  return Math.round((tokens / threshold) * 100)
}

/**
 * The chat footer's gauge: the loop's latest call input against the threshold
 * that loop auto-compacts at (Studio's status-bar gauge). Null until a call
 * completes while the terminal app watches, and after a compact / clear.
 */
export function loopContextPercent(config: AgentConfig | null | undefined, loop: string, lastInput: number | undefined): number | null {
  if (lastInput === undefined) return null
  return percentOf(lastInput, resolveLoopThreshold(config, loop))
}
