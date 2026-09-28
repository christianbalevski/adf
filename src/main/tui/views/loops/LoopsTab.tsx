// The Loops tab: every loop of the selected agent (main + inner) with live
// status, and what wakes it (timers, triggers). The highlighted row is the
// selected loop, so Chat opens on it.

import { Box, Text } from 'ink'
import { useTheme } from '../../app/theme'
import { useActions, useStore } from '../../state/store'
import { useAgent, useLoops, useSelectedLoop } from '../../state/hooks'
import { List } from '../../ui/List'
import { formatAgo, truncate } from '../../ui/text'
import type { Timer } from '../../api/types'
import type { Key } from '../../app/keys'
import type { LoopState } from '../../state/types'
import { TabBar, cells, fitColumns, loopStatusColor, loopStatusWord, row, type ColumnSpec, type LoopsViewState } from './common'
import { useAgentTimers, useAsyncData, useEventTick, useLoopsRev, useNow } from './hooks'
import { describeTimer, formatRelative, formatWhen, timersForLoop, triggersForLoop } from './model'
import { confirmClearHistory, confirmDeleteLoop, openChat, openLoopWizard, openSendDialog, openTimerDialog, toggleLoopEnabled } from './ops'

export interface TabProps {
  agentId: string
  width: number
  height: number
  focused: boolean
  view: LoopsViewState
  setView: (patch: Partial<LoopsViewState>) => void
  /** Shared tab keys (←→). Returns true when consumed. */
  tabKeys: (input: string, key: Key) => boolean
}

const DETAIL_ROWS = 9

export function LoopsTab({ agentId, width, height, focused, setView, tabKeys }: TabProps) {
  const theme = useTheme()
  const store = useStore()
  const actions = useActions()
  const agent = useAgent(agentId)
  const loops = useLoops(agentId)
  const selected = useSelectedLoop(agentId)
  const timers = useAgentTimers(agentId)
  const now = useNow()
  const rev = useLoopsRev()
  const turnTick = useEventTick(agentId, ['turn.completed', 'loop.cleared'])
  const names = (loops ?? []).map(l => l.info.name).join(',')
  const last = useAsyncData(names ? async c => {
    const out: Record<string, number> = {}
    await Promise.all(names.split(',').map(async name => {
      try {
        const page = await c.loopHistory(agentId, { loop: name, limit: 1 })
        const entry = page.entries[page.entries.length - 1]
        if (entry) out[name] = entry.created_at
      } catch { /* shown as unknown */ }
    }))
    return out
  } : null, [agentId, names, rev, turnTick])

  const items = loops ?? []
  const index = Math.max(0, items.findIndex(l => l.info.name === selected))
  const current = items[index]
  const config = agent?.config
  const label = agent?.summary.handle || agent?.summary.name || agentId
  const inner = Math.max(0, items.length - 1)
  const detailRows = Math.min(DETAIL_ROWS, Math.max(0, height - 8))
  const listRows = Math.max(1, height - 3 - detailRows - (loops && inner === 0 ? 3 : 0) - (agent?.loopsError ? 1 : 0))
  const w = width

  const flags = (l: LoopState) => {
    const src = l.info.isMain ? { autonomous: config?.autonomous, autostart: config?.autostart } : l.info.config ?? {}
    return [src.autonomous ? 'auton' : '', src.autostart ? 'start' : ''].filter(Boolean).join(' ') || '-'
  }
  const model = (l: LoopState) => (l.info.isMain ? config?.model?.model_id ?? '' : l.info.config?.model?.model_id ?? 'inherit')
  const tools = (l: LoopState) => (l.info.isMain ? '' : String(l.info.effectiveTools?.length ?? l.info.config?.tools?.length ?? 0))
  const wakes = (l: LoopState) => {
    const ts = timers.data ? timersForLoop(timers.data, l.info.name) : []
    const trig = triggersForLoop(config?.triggers, l.info.name).filter(t => t.enabled)
    const parts: string[] = []
    if (ts[0]) parts.push(`${describeTimer(ts[0], now)} ${formatRelative(ts[0].next_wake_at, now)}${ts.length > 1 ? ` +${ts.length - 1}` : ''}`)
    if (trig.length) parts.push(`${trig.length} trigger${trig.length === 1 ? '' : 's'}`)
    return parts.join(' · ') || (l.info.isMain ? 'you' : 'on demand')
  }

  const onKey = (input: string, key: Key, loop: LoopState | undefined): boolean => {
    if (tabKeys(input, key)) return true
    const state = store.getState()
    if (input === 'n') { openLoopWizard(actions, { agentId, mode: 'create' }); return true }
    if (input === 'r') { void actions.refreshLoops(agentId); timers.reload(); last.reload(); return true }
    if (!loop) return false
    const name = loop.info.name
    if (input === 'e') {
      if (loop.info.isMain) actions.toast('main is the agent itself: edit its instructions, model and tools in the agent config', 'info')
      else openLoopWizard(actions, { agentId, mode: 'edit', name })
      return true
    }
    if (input === 'x') { void toggleLoopEnabled(actions, state, agentId, name); return true }
    if (input === 'd' || key.delete) { void confirmDeleteLoop(actions, state, agentId, name); return true }
    if (input === 's') { openSendDialog(actions, { agentId, loop: name }); return true }
    if (input === 't') { openTimerDialog(actions, { agentId, loop: name }); return true }
    if (input === 'c') { void confirmClearHistory(actions, state, agentId, name); return true }
    if (input === 'h') { setView({ tab: 'history', historyOffset: null, historyIndex: 0 }); return true }
    return false
  }

  const specs: ColumnSpec<LoopState>[] = [
    { title: 'MSGS', width: 5, align: 'right', priority: 1, value: l => String(l.info.entryCount) },
    { title: 'TOOLS', width: 5, align: 'right', priority: 3, value: tools },
    { title: 'LAST', width: 5, align: 'right', priority: 6, value: l => (last.data?.[l.info.name] ? formatAgo(last.data[l.info.name], now) : '-') },
    { title: 'MODEL', width: 14, priority: 4, value: model },
    { title: 'FLAGS', width: 11, priority: 5, value: flags },
    { title: 'WAKES ON', width: 18, priority: 0, flex: true, value: wakes },
  ]
  const rest = fitColumns(specs, Math.max(10, w - 2 - 26))
  const cols = (l: LoopState | null): Array<[string, number, ('left' | 'right')?]> => [
    [l ? l.info.name : 'LOOP', 14],
    [l ? loopStatusWord(l) : 'STATUS', 10],
    ...cells(rest, l),
  ]

  return (
    <Box flexDirection="column" width={w} height={height}>
      <Text bold color={theme.color.loop} wrap="truncate-end">
        {theme.glyph.loop} Loops of {label}
        <Text color={theme.color.muted}>  {items.length} loop{items.length === 1 ? '' : 's'} (main + {inner} inner){timers.error ? `  timers: ${timers.error}` : ''}</Text>
      </Text>
      <TabBar tab="loops" width={w} hints={LOOPS_TAB_HINTS} />
      {agent?.loopsError ? <Text color={theme.color.error}>{truncate(agent.loopsError, w)}</Text> : null}
      <Text color={theme.color.muted} bold>{'  '}{row(cols(null), w - 2)}</Text>
      <List
        items={items}
        getKey={l => l.info.name}
        height={listRows}
        width={w}
        active={focused}
        selectedIndex={index}
        onSelectedIndexChange={(_i, l) => { if (l) actions.selectLoop(agentId, l.info.name) }}
        onSubmit={l => openChat(actions, agentId, l.info.name)}
        onKey={onKey}
        emptyText={loops ? 'No loops.' : 'Loading loops…'}
        renderItem={(l, { selected: isSelected, width: rw }) => {
          const status = loopStatusWord(l)
          const c = cols(l)
          return (
            <Text
              wrap="truncate-end"
              backgroundColor={isSelected ? theme.color.selectionBg : undefined}
              inverse={theme.mono && isSelected}
              color={isSelected ? theme.color.selectionFg : !l.info.enabled ? theme.color.dim : theme.color.text}
              bold={isSelected}
            >
              {isSelected ? `${theme.glyph.pointer} ` : '  '}
              <Text color={isSelected ? undefined : l.info.isMain ? theme.color.accent : theme.color.loop}>{row([c[0]], 14)} </Text>
              <Text color={isSelected ? undefined : loopStatusColor(theme, status)}>{row([c[1]], 10)} </Text>
              {row(c.slice(2), Math.max(1, rw - 28))}
            </Text>
          )
        }}
      />
      {loops && inner === 0 ? (
        <Text color={theme.color.muted} wrap="wrap">Loops are this agent's parallel chat threads, each with its own history. Press n to add an inner loop: a memory consolidator on a daily timer, a researcher you hand questions to, a critic, a reflector.</Text>
      ) : null}
      {current && detailRows > 2 ? <LoopDetail loop={current} agentId={agentId} width={w} rows={detailRows} now={now} lastAt={last.data?.[current.info.name]} timers={timers.data ?? []} /> : null}
    </Box>
  )
}

function LoopDetail({ loop, agentId, width, rows, now, lastAt, timers }: { loop: LoopState; agentId: string; width: number; rows: number; now: number; lastAt?: number; timers: Timer[] }) {
  const theme = useTheme()
  const agent = useAgent(agentId)
  const config = agent?.config
  const info = loop.info
  const ts = timersForLoop(timers, info.name)
  const trig = triggersForLoop(config?.triggers, info.name)
  const goal = info.goal.replace(/\s+/g, ' ').trim()
  const toolList = info.isMain ? 'all of the agent\'s enabled tools' : (info.effectiveTools ?? info.config?.tools ?? []).join(', ') || '(none: only thinks)'
  const lines: Array<[string, string, string | undefined]> = [
    ['goal', goal || '(empty)', undefined],
    ['model', info.isMain ? `${config?.model?.provider ?? '?'} / ${config?.model?.model_id ?? '?'}` : info.config?.model ? `${info.config.model.provider} / ${info.config.model.model_id}` : `inherit (${config?.model?.model_id ?? 'host model'})`, undefined],
    ['flags', info.isMain
      ? `${config?.autonomous ? 'autonomous' : 'turn-based'}${config?.autostart ? ', autostart' : ''}`
      : `${info.enabled ? 'enabled' : 'disabled'}, ${info.config?.autonomous ? 'autonomous' : 'ends turn on text reply'}, ${info.config?.autostart ? 'autostart' : 'no autostart'}${info.config?.compact_threshold ? `, compacts at ${info.config.compact_threshold}` : ''}`, undefined],
    [info.isMain ? 'tools' : info.effectiveTools ? 'tools (live)' : 'tools', toolList, undefined],
    ['timers', ts.length ? ts.map(t => `#${t.id} ${describeTimer(t, now)}, next ${formatWhen(t.next_wake_at, now)}`).join(' · ') : 'none (t adds one)', ts.length ? theme.color.info : theme.color.dim],
    ['triggers', trig.length ? trig.map(t => `${t.type}${t.enabled ? '' : ' (off)'}`).join(', ') : 'none', trig.length ? theme.color.info : theme.color.dim],
    ['last', lastAt ? `${formatWhen(lastAt, now)} (${formatAgo(lastAt, now)} ago), ${info.entryCount} entries` : `${info.entryCount} entries`, undefined],
  ]
  return (
    <Box flexDirection="column" width={width} height={rows} borderStyle={theme.ascii ? 'classic' : 'single'} borderColor={theme.color.border} borderLeft={false} borderRight={false} borderBottom={false}>
      {lines.slice(0, rows - 1).map(([k, v, color]) => (
        <Text key={k} wrap="truncate-end">
          <Text color={theme.color.muted}>{k.padEnd(13)}</Text>
          <Text color={color ?? theme.color.text}>{truncate(v, Math.max(1, width - 13))}</Text>
        </Text>
      ))}
    </Box>
  )
}

export const LOOPS_TAB_HINTS = [
  { keys: 'enter', label: 'chat' },
  { keys: 'n', label: 'new' },
  { keys: 'e', label: 'edit' },
  { keys: 'x', label: 'on/off' },
  { keys: 's', label: 'send' },
  { keys: 't', label: 'schedule' },
  { keys: 'd', label: 'delete' },
  { keys: 'h', label: 'history' },
]

