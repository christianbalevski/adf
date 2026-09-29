// Shared bits of the loops manager: view state, tab bar, status words and
// the error-capturing wrapper used by dialogs that show their own outcome.

import type { ReactNode } from 'react'
import { Box, Text } from 'ink'
import { useTheme, stateColor, type Theme } from '../../app/theme'
import { keyLabel } from '../../app/keys'
import type { KeyHintSpec } from '../../ui/KeyHint'
import { fit, truncate } from '../../ui/text'
import type { DaemonClient } from '../../api/client'
import type { TuiActions } from '../../state/store'
import type { LoopState, TuiState } from '../../state/types'
import type { RoleFilter } from './model'

export const VIEW_ID = 'loops'

export type LoopsTab = 'loops' | 'timers' | 'triggers' | 'history'
export const TABS: Array<{ id: LoopsTab; title: string }> = [
  { id: 'loops', title: 'Loops' },
  { id: 'timers', title: 'Timers' },
  { id: 'triggers', title: 'Triggers' },
  { id: 'history', title: 'History' },
]

export interface LoopsViewState {
  tab: LoopsTab
  /** Timers tab: every agent's timers, soonest first. */
  fleet: boolean
  timerIndex: number
  triggerIndex: number
  role: RoleFilter
  /** History page offset; null = newest page. */
  historyOffset: number | null
  historyIndex: number
}

export const INITIAL_VIEW_STATE: LoopsViewState = {
  tab: 'loops',
  fleet: false,
  timerIndex: 0,
  triggerIndex: 0,
  role: 'all',
  historyOffset: null,
  historyIndex: 0,
}

export function readViewState(state: TuiState): LoopsViewState {
  const raw = state.viewState[VIEW_ID] as Partial<LoopsViewState> | undefined
  return { ...INITIAL_VIEW_STATE, ...(raw ?? {}) }
}

export function patchViewState(actions: TuiActions, state: TuiState, patch: Partial<LoopsViewState>): void {
  actions.setViewState(VIEW_ID, { ...readViewState(state), ...patch })
}

/** Open the loops view on a tab. */
export function openTab(actions: TuiActions, state: TuiState, tab: LoopsTab, patch: Partial<LoopsViewState> = {}): void {
  patchViewState(actions, state, { ...patch, tab })
  actions.setView(VIEW_ID)
  if (state.focus === 'input') actions.setFocus('main')
}

export function cycleTab(tab: LoopsTab, delta: number): LoopsTab {
  const at = TABS.findIndex(t => t.id === tab)
  return TABS[(at + delta + TABS.length) % TABS.length].id
}

/** Tabs plus the active tab's keys (the status bar only re-reads hints on its own renders). */
export function TabBar({ tab, width, hints = [] }: { tab: LoopsTab; width: number; hints?: KeyHintSpec[] }) {
  const theme = useTheme()
  return (
    <Box width={width}>
      <Text wrap="truncate-end">
        {TABS.map((t, i) => {
          const active = t.id === tab
          return (
            <Text key={t.id}>
              {i > 0 ? <Text color={theme.color.dim}> {theme.glyph.sep} </Text> : null}
              <Text bold={active} underline={active && theme.mono} color={active ? theme.color.loop : theme.color.muted} inverse={active && theme.mono}>
                {active ? `[${t.title}]` : t.title}
              </Text>
            </Text>
          )
        })}
        <Text color={theme.color.dim}>{'   '}</Text>
        {[{ keys: 'left right', label: 'tab' }, ...hints].map((h, i) => (
          <Text key={`${h.keys}:${h.label}`}>
            {i > 0 ? <Text color={theme.color.dim}> </Text> : null}
            <Text color={theme.color.accent}>{h.keys.split(' ').map(keyLabel).join('/')}</Text>
            <Text color={theme.color.dim}> {h.label}</Text>
          </Text>
        ))}
      </Text>
    </Box>
  )
}

export function agentName(state: TuiState, agentId: string): string {
  const summary = state.agents[agentId]?.summary
  return summary?.handle || summary?.name || agentId
}

/** 'off' | executor state while busy | idle/running from the pool. */
export function loopStatusWord(loop: LoopState): string {
  if (!loop.info.enabled) return 'off'
  const live = loop.executorState
  if (live && live !== 'idle' && live !== 'stopped') return live
  return loop.info.status
}

export function loopStatusColor(theme: Theme, word: string): string | undefined {
  if (word === 'off') return theme.color.dim
  if (word === 'running') return theme.color.live
  return stateColor(theme, word)
}

export type Attempt<T> = { ok: true; value: T } | { ok: false; error: string }

/** Run a daemon call through `actions.run` but keep the error for an in-dialog outcome screen. */
export async function attempt<T>(actions: TuiActions, label: string, fn: (client: DaemonClient) => Promise<T>): Promise<Attempt<T>> {
  const result = await actions.run<Attempt<T>>(label, async client => {
    try {
      return { ok: true, value: await fn(client) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
  return result ?? { ok: false, error: 'failed' }
}

export interface ColumnSpec<T> {
  title: string
  width: number
  value: (item: T) => string
  align?: 'left' | 'right'
  /** Lower survives longer when the pane is narrow. */
  priority: number
  /** Takes the leftover width (at least `width`). */
  flex?: boolean
}

/** Drop the lowest-priority columns until the row fits; the flex column takes the rest. */
export function fitColumns<T>(specs: ColumnSpec<T>[], width: number): ColumnSpec<T>[] {
  let kept = [...specs]
  const total = (cols: ColumnSpec<T>[]) => cols.reduce((sum, c) => sum + c.width + 1, 0)
  while (kept.length > 1 && total(kept) > width) {
    const drop = kept.filter(c => !c.flex).sort((a, b) => b.priority - a.priority)[0]
    if (!drop) break
    kept = kept.filter(c => c !== drop)
  }
  const spare = Math.max(0, width - total(kept))
  return kept.map(c => (c.flex ? { ...c, width: c.width + spare } : c))
}

export function cells<T>(cols: ColumnSpec<T>[], item: T | null): Array<[string, number, ('left' | 'right')?]> {
  return cols.map(c => [item === null ? c.title : c.value(item), c.width, c.align])
}

/** One fixed-width row from cells. */
export function row(cells: Array<[string, number, ('left' | 'right')?]>, width: number): string {
  return truncate(cells.map(([text, w, align]) => fit(text, w, align)).join(' '), width)
}

export function Section({ title, children }: { title: string; children?: ReactNode }) {
  const theme = useTheme()
  return (
    <Box flexDirection="column">
      <Text bold color={theme.color.muted}>{title}</Text>
      {children}
    </Box>
  )
}
