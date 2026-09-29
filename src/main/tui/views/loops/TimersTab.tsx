// Timers tab: the selected agent's timers, or (f) every agent's timers sorted
// by next fire time — the fleet's upcoming schedule.

import { Box, Text } from 'ink'
import { useTheme } from '../../app/theme'
import { useActions, useStore } from '../../state/store'
import { useAgent } from '../../state/hooks'
import { List } from '../../ui/List'
import { formatAgo, truncate } from '../../ui/text'
import type { Key } from '../../app/keys'
import { TabBar, cells, fitColumns, row, type ColumnSpec } from './common'
import { useAgentTimers, useFleetTimers, useNow, type FleetTimer } from './hooks'
import { describeTimer, formatRelative, formatWhen, timerLoop, timerTriggerWarning } from './model'
import { confirmDeleteTimer, openTimerDialog } from './ops'
import type { TabProps } from './LoopsTab'

export function TimersTab({ agentId, width, height, focused, view, setView, tabKeys }: TabProps) {
  const theme = useTheme()
  const store = useStore()
  const actions = useActions()
  const agent = useAgent(agentId)
  const now = useNow(15_000)
  const own = useAgentTimers(view.fleet ? null : agentId)
  const fleet = useFleetTimers(view.fleet)
  const label = agent?.summary.handle || agent?.summary.name || agentId
  const items: FleetTimer[] = view.fleet
    ? fleet.data ?? []
    : (own.data ?? [])
      .map(timer => ({ agentId, agentLabel: label, timer }))
      .sort((a, b) => (a.timer.expired ? 1 : 0) - (b.timer.expired ? 1 : 0) || a.timer.next_wake_at - b.timer.next_wake_at)
  const data = view.fleet ? fleet : own
  const index = Math.min(view.timerIndex, Math.max(0, items.length - 1))
  const warning = view.fleet ? null : timerTriggerWarning(agent?.config)
  const w = width
  const specs: ColumnSpec<FleetTimer>[] = [
    ...(view.fleet ? [{ title: 'AGENT', width: 12, priority: 0, value: (t: FleetTimer) => t.agentLabel }] : []),
    { title: 'ID', width: 4, priority: 0, value: t => `#${t.timer.id}` },
    { title: 'LOOP', width: 12, priority: 0, value: t => timerLoop(t.timer) ?? '(system)' },
    { title: 'SCHEDULE', width: 18, priority: 0, value: t => describeTimer(t.timer, now) },
    { title: 'NEXT', width: 22, priority: 1, flex: true, value: t => (t.timer.expired ? 'expired' : `${formatWhen(t.timer.next_wake_at, now)} ${formatRelative(t.timer.next_wake_at, now)}`) },
    { title: 'LAST', width: 8, priority: 4, value: t => (t.timer.last_fired_at ? `${formatAgo(t.timer.last_fired_at, now)} ago` : '-') },
    { title: 'RUNS', width: 4, align: 'right', priority: 5, value: t => String(t.timer.run_count) },
    { title: 'SCOPE', width: 10, priority: 3, value: t => `${t.timer.scope.join('+')}${t.timer.locked ? ' lock' : ''}` },
    { title: 'PAYLOAD', width: 14, priority: 2, value: t => t.timer.payload ?? '' },
  ]
  const fitted = fitColumns(specs, w - 2)
  const cols = (t: FleetTimer | null) => cells(fitted, t)

  const onKey = (input: string, key: Key, item: FleetTimer | undefined): boolean => {
    if (tabKeys(input, key)) return true
    if (input === 'f') { setView({ fleet: !view.fleet, timerIndex: 0 }); return true }
    if (input === 'r') { data.reload(); return true }
    if (input === 'n') { const id = item?.agentId ?? agentId; if (id) openTimerDialog(actions, { agentId: id }); else actions.toast('Select an agent first', 'warn'); return true }
    if (!item) return false
    if (input === 'e') { openTimerDialog(actions, { agentId: item.agentId, timerId: item.timer.id }); return true }
    if (input === 'd' || key.delete) { void confirmDeleteTimer(actions, store.getState(), item.agentId, item.timer); return true }
    if (input === 'o' && view.fleet) { actions.selectAgent(item.agentId); return true }
    return false
  }

  const title = view.fleet ? `Upcoming ${theme.glyph.sep} all agents` : `Timers of ${label}`
  return (
    <Box flexDirection="column" width={w} height={height}>
      <Text bold color={theme.color.loop} wrap="truncate-end">
        {theme.glyph.loop} {title}
        <Text color={theme.color.muted}>  {items.filter(i => !i.timer.expired).length} active{items.some(i => i.timer.expired) ? `, ${items.filter(i => i.timer.expired).length} expired` : ''}  {view.fleet ? 'f: this agent only' : 'f: all agents'}</Text>
      </Text>
      <TabBar tab="timers" width={w} hints={view.fleet ? [...TIMERS_TAB_HINTS, { keys: 'o', label: 'select agent' }] : TIMERS_TAB_HINTS} />
      {data.error ? <Text color={theme.color.error}>{truncate(`Timers: ${data.error}`, w)}</Text> : null}
      {view.fleet && fleet.failures.length ? <Text color={theme.color.warn}>{truncate(`Could not read: ${fleet.failures.join('; ')}`, w)}</Text> : null}
      {warning ? <Text color={theme.color.warn}>{truncate(`${theme.glyph.warn} ${warning}`, w)}</Text> : null}
      <Text color={theme.color.muted} bold>{'  '}{row(cols(null), w - 2)}</Text>
      <List
        items={items}
        getKey={t => `${t.agentId}:${t.timer.id}`}
        height={Math.max(1, height - 4 - (data.error ? 1 : 0) - (warning ? 1 : 0) - (view.fleet && fleet.failures.length ? 1 : 0))}
        width={w}
        active={focused}
        selectedIndex={index}
        onSelectedIndexChange={i => setView({ timerIndex: i })}
        onSubmit={t => openTimerDialog(actions, { agentId: t.agentId, timerId: t.timer.id })}
        onKey={onKey}
        emptyText={data.loading && !data.data ? 'Loading timers…' : view.fleet ? 'No timers on any agent. n adds one.' : 'No timers. n adds one; a timer with a loop runs that inner loop on a schedule.'}
        renderItem={(t, { selected, width: rw }) => (
          <Text
            wrap="truncate-end"
            backgroundColor={selected ? theme.color.selectionBg : undefined}
            inverse={theme.mono && selected}
            bold={selected}
            color={selected ? theme.color.selectionFg : t.timer.expired ? theme.color.dim : theme.color.text}
          >
            {selected ? `${theme.glyph.pointer} ` : '  '}{row(cols(t), rw - 2)}
          </Text>
        )}
      />
    </Box>
  )
}

export const TIMERS_TAB_HINTS = [
  { keys: 'n', label: 'new' },
  { keys: 'enter e', label: 'edit' },
  { keys: 'd', label: 'delete' },
  { keys: 'f', label: 'all agents' },
  { keys: 'r', label: 'refresh' },
]

