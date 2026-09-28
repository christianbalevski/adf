// Loops manager. An agent's loops are its parallel chat sessions/threads, each
// with its own history: `main` talks to the owner; inner loops (a memory
// consolidator on a daily timer, a researcher, a critic, a reflector) work on
// their own goal — on demand, on a timer (timer.loop) or a trigger
// (target.loop). Tabs: Loops · Timers · Triggers · History.

import { Box, Text } from 'ink'
import { useTheme } from '../../app/theme'
import { useStore } from '../../state/store'
import { useSelectedAgent, useViewState } from '../../state/hooks'
import type { Key } from '../../app/keys'
import type { CommandScope } from '../../commands/types'
import type { KeyHintSpec } from '../../ui/KeyHint'
import type { ViewDefinition, ViewProps } from '../types'
import { INITIAL_VIEW_STATE, TabBar, VIEW_ID, cycleTab, readViewState, type LoopsViewState } from './common'
import { LoopsTab, LOOPS_TAB_HINTS } from './LoopsTab'
import { TimersTab, TIMERS_TAB_HINTS } from './TimersTab'
import { TriggersTab, TRIGGERS_TAB_HINTS } from './TriggersTab'
import { HistoryTab, HISTORY_TAB_HINTS } from './HistoryTab'
import { LoopWizard } from './LoopWizard'
import { TimerDialog } from './TimerDialog'
import { TriggerDialog } from './TriggerDialog'
import { EntryDialog } from './EntryDialog'
import { SendDialog } from './SendDialog'
import { OVERLAY } from './ops'
import { loopsCommands } from './commands'

function LoopsView({ width, height, focused }: ViewProps) {
  const theme = useTheme()
  const store = useStore()
  const agent = useSelectedAgent()
  const [raw, setRaw] = useViewState<Partial<LoopsViewState>>(VIEW_ID, INITIAL_VIEW_STATE)
  const view: LoopsViewState = { ...INITIAL_VIEW_STATE, ...raw }
  const setView = (patch: Partial<LoopsViewState>) => setRaw(prev => ({ ...INITIAL_VIEW_STATE, ...prev, ...patch }))
  const tabKeys = (input: string, key: Key): boolean => {
    if (key.ctrl || key.meta || (key.shift && (key.leftArrow || key.rightArrow))) return false
    if (key.leftArrow || input === '[') { setView({ tab: cycleTab(view.tab, -1) }); return true }
    if (key.rightArrow || input === ']') { setView({ tab: cycleTab(view.tab, 1) }); return true }
    return false
  }
  const w = Math.max(20, width - 2)

  if (!agent && view.tab === 'timers') {
    return (
      <Box flexDirection="column" paddingX={1} width={width} height={height}>
        <TimersTab agentId="" width={w} height={height} focused={focused} view={{ ...view, fleet: true }} setView={setView} tabKeys={tabKeys} />
      </Box>
    )
  }
  if (!agent) {
    return (
      <Box flexDirection="column" paddingX={1} width={width} height={height}>
        <Text bold color={theme.color.loop}>{theme.glyph.loop} Loops</Text>
        <TabBar tab={view.tab} width={w} />
        <Text color={theme.color.muted} wrap="wrap">Select an agent (sidebar, /agent or Ctrl+K) to see its loops: main plus inner loops that run on their own goal, on demand or on a schedule.</Text>
        {store.getState().agentOrder.length === 0 ? <Text color={theme.color.dim}>No agents loaded in the daemon.</Text> : null}
      </Box>
    )
  }
  const props = { agentId: agent.summary.id, width: w, height, focused, view, setView, tabKeys }
  return (
    <Box flexDirection="column" paddingX={1} width={width} height={height}>
      {view.tab === 'timers' ? <TimersTab {...props} />
        : view.tab === 'triggers' ? <TriggersTab {...props} />
          : view.tab === 'history' ? <HistoryTab {...props} />
            : <LoopsTab {...props} />}
    </Box>
  )
}

function keyHints(scope: CommandScope): KeyHintSpec[] {
  const tab = readViewState(scope.state()).tab
  const common: KeyHintSpec = { keys: 'left right', label: 'tab' }
  switch (tab) {
    case 'timers': return [common, ...TIMERS_TAB_HINTS]
    case 'triggers': return [common, ...TRIGGERS_TAB_HINTS]
    case 'history': return [common, ...HISTORY_TAB_HINTS]
    default: return [common, ...LOOPS_TAB_HINTS]
  }
}

function placeholder(scope: CommandScope): string {
  return scope.agentId ? `message ${scope.loop} · /loop new · /timer add` : '/agent <name> to pick an agent'
}

const loops: ViewDefinition = {
  id: VIEW_ID,
  title: 'Loops',
  key: '4',
  component: LoopsView,
  keyHints,
  prompt: { placeholder },
  helpKeys: [
    { keys: [{ keys: 'left right', label: 'Tabs: Loops · Timers · Triggers · History ([ ])' }] },
    {
      title: 'Loops tab',
      keys: [
        { keys: 'up down', label: 'Select a loop (also selects it for Chat)' },
        { keys: 'enter', label: 'Chat with the loop' },
        { keys: 'n', label: 'New inner loop: memory consolidator, researcher, critic, reflector or blank' },
        { keys: 'e', label: 'Edit goal, tools, model, flags (diff + confirm)' },
        { keys: 'x', label: 'Enable / disable' },
        { keys: 's', label: 'Send a one-off message' },
        { keys: 't', label: 'Schedule: a timer that wakes this loop' },
        { keys: 'c', label: 'Clear its history (asks)' },
        { keys: 'd delete', label: 'Delete (asks; history archived to the audit log)' },
        { keys: 'h', label: 'Its history' },
        { keys: 'r', label: 'Refresh' },
      ],
    },
    { title: 'Timers tab', keys: [...TIMERS_TAB_HINTS, { keys: 'o', label: 'select that agent (all-agents list)' }] },
    { title: 'Triggers tab', keys: TRIGGERS_TAB_HINTS },
    { title: 'History tab', keys: [...HISTORY_TAB_HINTS, { keys: 'L', label: 'previous loop' }, { keys: 'i', label: 'entry details' }, { keys: 'r', label: 'reload' }] },
    {
      title: 'Loop and timer forms',
      keys: [
        { keys: 'up down', label: 'Field' },
        { keys: 'left right', label: 'Change a choice / toggle' },
        { keys: 'ctrl+o', label: 'Open the goal in $EDITOR' },
        { keys: 'ctrl+s', label: 'Review, then Enter / y applies' },
        { keys: 'esc', label: 'Cancel (from review: back to the form)' },
      ],
    },
  ],
  overlays: {
    [OVERLAY.loop]: LoopWizard,
    [OVERLAY.timer]: TimerDialog,
    [OVERLAY.trigger]: TriggerDialog,
    [OVERLAY.entry]: EntryDialog,
    [OVERLAY.send]: SendDialog,
  },
  ...loopsCommands,
}

export default loops

