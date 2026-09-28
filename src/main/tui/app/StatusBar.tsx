import { Box, Text } from 'ink'
import { useTheme, stateColor } from './theme'
import { useShell } from './shell-context'
import { useStore, useTuiSelector } from '../state/store'
import { useActiveView, useFocus, useLoop, useSelectedAgent, useSelectedLoop } from '../state/hooks'
import { isBusyState } from '../state/reducer'
import { createScope } from '../commands/registry'
import { Spinner } from '../ui/Spinner'
import { KeyHints, type KeyHintSpec } from '../ui/KeyHint'
import { displayWidth, formatCount, truncate } from '../ui/text'
import { MAIN_LOOP } from '../api/types'

export const GLOBAL_HINTS: KeyHintSpec[] = [
  { keys: 'ctrl+k', label: 'palette' },
  { keys: 'tab', label: 'focus' },
  { keys: 'ctrl+b', label: 'sidebar' },
  { keys: '?', label: 'help' },
  { keys: 'ctrl+c', label: 'quit' },
]

/** Bottom bar: agent › loop, live state, model, token tally, then key hints. */
export function StatusBar({ width }: { width: number }) {
  const theme = useTheme()
  const store = useStore()
  const { views, exit } = useShell()
  const activeView = useActiveView()
  const focus = useFocus()
  const agent = useSelectedAgent()
  const loopName = useSelectedLoop()
  const loop = useLoop(agent?.summary.id, loopName)
  // Views derive their hints from their own viewState (tab, pane): re-render on it.
  useTuiSelector(s => s.viewState[s.activeView])

  const view = views.find(v => v.id === activeView)
  const viewHints = typeof view?.keyHints === 'function' ? view.keyHints(createScope(store, exit)) : view?.keyHints ?? []

  const state = loopName === MAIN_LOOP
    ? agent?.executorState ?? agent?.status?.runtimeState
    : !loop?.info.enabled ? 'off' : loop?.executorState ?? loop?.info.status
  const busy = isBusyState(state) || state === 'running'
  const model = loop?.info.config?.model?.model_id ?? agent?.config?.model?.model_id ?? agent?.lastModel
  const tokens = agent ? agent.tokens.input + agent.tokens.output : 0

  // The left side gets at most ~45% of the bar; the model and token tally are
  // left out rather than cut to a meaningless "m…".
  const name = agent ? agent.summary.handle || agent.summary.name : ''
  const budget = Math.max(24, Math.floor(width * 0.45))
  const baseWidth = displayWidth(` ${name} ${theme.glyph.pointer} ${theme.glyph.loop} ${loopName}  ${theme.glyph.dot} ${state ?? '…'}`)
  const modelRoom = Math.min(24, budget - baseWidth - 2)
  const modelText = model && modelRoom >= 8 ? truncate(model, modelRoom) : ''
  const tokenText = agent && tokens > 0 ? `${formatCount(agent.tokens.input)}${theme.glyph.arrow}${formatCount(agent.tokens.output)} tok` : ''
  const showTokens = !!tokenText && baseWidth + (modelText ? 2 + displayWidth(modelText) : 0) + 2 + displayWidth(tokenText) <= budget
  const leftWidth = agent
    ? Math.min(budget, baseWidth + (modelText ? 2 + displayWidth(modelText) : 0) + (showTokens ? 2 + displayWidth(tokenText) : 0))
    : 18

  const left = agent ? (
    <Text wrap="truncate-end">
      <Text bold color={theme.color.text}> {name}</Text>
      <Text color={theme.color.dim}> {theme.glyph.pointer} </Text>
      <Text color={loopName === MAIN_LOOP ? theme.color.accent : theme.color.loop}>{theme.glyph.loop} {loopName}</Text>
      <Text>  </Text>
      {busy ? <Spinner label={state} color={theme.color.live} /> : <Text color={stateColor(theme, state)}>{theme.glyph.dot} {state ?? '…'}</Text>}
      {modelText ? <Text color={theme.color.muted}>  {modelText}</Text> : null}
      {showTokens ? <Text color={theme.color.dim}>  {tokenText}</Text> : null}
    </Text>
  ) : (
    <Text color={theme.color.muted}> no agent selected</Text>
  )

  const focusHint: KeyHintSpec = { keys: 'tab', label: `focus: ${focus}` }
  const hints = [...viewHints, focusHint, ...GLOBAL_HINTS.filter(h => h.keys !== 'tab')]
  return (
    <Box width={width} height={1} justifyContent="space-between" backgroundColor={theme.color.surface}>
      <Box flexShrink={0} width={leftWidth}>{left}</Box>
      <Box flexShrink={1} marginLeft={2}><KeyHints hints={hints} /></Box>
    </Box>
  )
}
