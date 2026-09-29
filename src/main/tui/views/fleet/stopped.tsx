// Tracked agents that are not loaded ("stopped"), everywhere an agent can be
// selected: the running/all filter (remembered in tui-prefs.json), what `s` /
// Enter do for one, and the panel Chat / Files / Loops / Inspect show instead
// of errors while such an agent is selected.

import { Box, Text } from 'ink'
import { useTheme, type Theme } from '../../app/theme'
import { useKeys } from '../../app/keys'
import { getPrefs, savePrefs } from '../../app/prefs'
import { useStore } from '../../state/store'
import { useTracked, useViewState } from '../../state/hooks'
import { Spinner } from '../../ui/Spinner'
import { folderName, stoppedError, stoppedLabel, type TrackedAgent } from '../../state/tracked'
import type { TuiStore } from '../../state/store'
import type { TuiState } from '../../state/types'

/** viewState key: `'all'` (default) or `'running'` (hide not-loaded tracked agents). */
export const AGENTS_FILTER_KEY = 'fleet.agentsFilter'

export type AgentsFilter = 'all' | 'running'

export function readAgentsFilter(state: Pick<TuiState, 'viewState'>): AgentsFilter {
  const raw = state.viewState[AGENTS_FILTER_KEY]
  if (raw === 'all' || raw === 'running') return raw
  return getPrefs().agents === 'running' ? 'running' : 'all'
}

/** Show every tracked agent, or only the loaded ones. `mode` omitted = toggle. Remembered across launches. */
export function setAgentsFilter(store: Pick<TuiStore, 'getState' | 'actions'>, mode?: AgentsFilter, announce = true): AgentsFilter {
  const next: AgentsFilter = mode ?? (readAgentsFilter(store.getState()) === 'all' ? 'running' : 'all')
  store.actions.setViewState(AGENTS_FILTER_KEY, next)
  savePrefs({ agents: next })
  if (announce) {
    const hidden = store.getState().tracked?.stopped.length ?? 0
    store.actions.toast(next === 'running'
      ? `Showing running agents only${hidden ? ` (${hidden} stopped hidden)` : ''} · H or /agents all shows every tracked agent`
      : 'Showing every tracked agent: stopped ones are dimmed · H or /agents running hides them', 'info', 3000)
  }
  return next
}

export function useAgentsFilter(): AgentsFilter {
  const [raw] = useViewState<AgentsFilter | null>(AGENTS_FILTER_KEY, null)
  return raw ?? (getPrefs().agents === 'running' ? 'running' : 'all')
}

/** What `s` / Enter do for a stopped agent, in words. */
export function stoppedAction(entry: TrackedAgent): string {
  switch (entry.agent.status) {
    case 'needs_review': return 'review'
    case 'password_protected': return ''
    case 'unreadable': return ''
    default: return 'start'
  }
}

/** Load + start (or review) a stopped agent: `s` and Enter everywhere. */
export function startStopped(store: TuiStore, entry: TrackedAgent): void {
  void store.actions.startTracked(entry.key)
}

export function stoppedGlyph(theme: Theme, entry: TrackedAgent, errors: Record<string, string>): { glyph: string; color: string | undefined } {
  const label = stoppedLabel(entry, errors)
  if (label === 'load error' || label === 'unreadable') return { glyph: theme.glyph.cross, color: theme.color.error }
  if (label === 'needs review') return { glyph: theme.glyph.warn, color: theme.color.warn }
  return { glyph: theme.glyph.ring, color: theme.color.dim }
}

/**
 * Chat, Files, Loops and Inspect with a stopped agent selected: say so, why
 * it is not running, and how to start it (`s` / Enter here).
 */
export function StoppedAgentPanel({ entry, width, height, focused, what }: { entry: TrackedAgent; width: number; height: number; focused: boolean; what: string }) {
  const theme = useTheme()
  const store = useStore()
  const tracked = useTracked()
  const errors = tracked?.errors ?? {}
  const busy = tracked?.busy[entry.agent.filePath]
  const action = stoppedAction(entry)
  const error = stoppedError(entry, errors)
  const label = stoppedLabel(entry, errors)
  const glyph = stoppedGlyph(theme, entry, errors)
  const a = entry.agent

  useKeys((input, key) => {
    if (key.ctrl || key.meta) return false
    if ((input === 's' || key.return) && action) { startStopped(store, entry); return true }
    return false
  }, { layer: 'main', active: focused })

  const why = a.status === 'needs_review'
    ? `Not reviewed on this daemon yet, so it does not load${a.autostart ? ' (it is set to autostart)' : ''}. s reviews it: see what it can do, then accept and start it.`
    : a.status === 'password_protected'
      ? `Its identity is password-protected, so it does not load on its own. Load it with /load ${a.filePath} and unlock it.`
      : a.status === 'unreadable'
        ? 'Not a loadable agent file.'
        : a.status === 'not_autostart'
          ? 'Not set to autostart, so it only runs when you start it.'
          : 'Set to autostart, but not running in the daemon now.'
  return (
    <Box flexDirection="column" width={width} height={height} paddingX={1}>
      <Text wrap="truncate-end">
        <Text color={glyph.color}>{glyph.glyph} </Text>
        <Text bold color={theme.color.text}>{a.name}</Text>
        <Text color={glyph.color}>  {label}</Text>
      </Text>
      <Text color={theme.color.dim} wrap="truncate-middle">{a.filePath}</Text>
      <Text> </Text>
      <Text color={theme.color.muted} wrap="wrap">This agent is not running, so it has no {what} to show yet.</Text>
      <Text color={theme.color.muted} wrap="wrap">{why}</Text>
      {error ? <><Text> </Text><Text color={theme.color.error} wrap="wrap">{a.status === 'unreadable' ? '' : 'Last load failed: '}{error}</Text></> : null}
      <Text> </Text>
      {busy
        ? <Spinner label={`${busy === 'starting' ? 'Starting' : 'Loading'} ${a.name}…`} />
        : action
          ? <Text wrap="wrap"><Text bold color={theme.color.accent}>s</Text><Text color={theme.color.muted}> or </Text><Text bold color={theme.color.accent}>Enter</Text><Text color={theme.color.text}> {action === 'review' ? 'reviews it' : 'starts it (loads it into the daemon, then starts it)'}</Text>{focused ? null : <Text color={theme.color.dim}> · focus this pane first (Shift+Tab / click)</Text>}</Text>
          : null}
      <Text color={theme.color.dim} wrap="wrap">Tracked folder {folderName(entry.folder)} · {a.autostart ? 'autostart on' : 'autostart off'}{a.reviewed ? '' : ' · not reviewed'}</Text>
    </Box>
  )
}
