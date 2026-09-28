// History tab: the persisted rows of one loop, a page at a time, with token
// usage per entry, role/tool filters and a full-entry view.

import { Box, Text } from 'ink'
import { useTheme } from '../../app/theme'
import { useActions, useStore } from '../../state/store'
import { useAgent, useLoops, useSelectedLoop } from '../../state/hooks'
import { List } from '../../ui/List'
import { formatClock, truncate } from '../../ui/text'
import type { Key } from '../../app/keys'
import type { LoopEntry } from '../../api/types'
import { TabBar, cells, fitColumns, row } from './common'
import { useHistoryPage } from './hooks'
import { ROLE_FILTERS, entryMatches, formatTokens, summarizeEntry } from './model'
import { confirmClearHistory, openEntryDialog } from './ops'
import type { TabProps } from './LoopsTab'

export const HISTORY_PAGE = 30

export function HistoryTab({ agentId, width, height, focused, view, setView, tabKeys }: TabProps) {
  const theme = useTheme()
  const store = useStore()
  const actions = useActions()
  const agent = useAgent(agentId)
  const loops = useLoops(agentId) ?? []
  const loop = useSelectedLoop(agentId)
  const page = useHistoryPage(agentId, loop, view.historyOffset, HISTORY_PAGE)
  const label = agent?.summary.handle || agent?.summary.name || agentId
  const entries = (page.data?.entries ?? []).filter(e => entryMatches(e, view.role, ''))
  const ordered = [...entries].reverse()
  const index = Math.min(view.historyIndex, Math.max(0, ordered.length - 1))
  const w = width
  const total = page.data?.total ?? 0
  const offset = page.data?.offset ?? 0
  const count = page.data?.entries.length ?? 0

  const go = (next: number | null) => setView({ historyOffset: next, historyIndex: 0 })
  const older = () => { if (page.data && offset > 0) go(Math.max(0, offset - HISTORY_PAGE)) }
  const newer = () => {
    if (!page.data || view.historyOffset === null) return
    const next = offset + HISTORY_PAGE
    go(next + HISTORY_PAGE >= total ? null : next)
  }
  const cycleLoop = (d: number) => {
    if (loops.length === 0) return
    const at = Math.max(0, loops.findIndex(l => l.info.name === loop))
    const next = loops[(at + d + loops.length) % loops.length].info.name
    actions.selectLoop(agentId, next)
    go(null)
  }

  const onKey = (input: string, key: Key, entry: LoopEntry | undefined): boolean => {
    if (tabKeys(input, key)) return true
    if (input === 'f') { setView({ role: ROLE_FILTERS[(ROLE_FILTERS.indexOf(view.role) + 1) % ROLE_FILTERS.length], historyIndex: 0 }); return true }
    if (input === '<' || input === ',') { older(); return true }
    if (input === '>' || input === '.') { newer(); return true }
    if (input === 'l') { cycleLoop(1); return true }
    if (input === 'L') { cycleLoop(-1); return true }
    if (input === 'r') { page.reload(); return true }
    if (input === 'c') { void confirmClearHistory(actions, store.getState(), agentId, loop).then(ok => { if (ok) go(null) }); return true }
    if (input === 'i' && entry) { openEntryDialog(actions, { entry, loop }); return true }
    return false
  }

  const roleOf = (e: LoopEntry) => {
    const s = summarizeEntry(e)
    return s.kinds.includes('tool_result') ? 'result' : s.kinds.includes('tool_use') ? 'tool' : s.kinds.includes('context') ? 'context' : e.role
  }
  const fitted = fitColumns<LoopEntry>([
    { title: 'SEQ', width: 6, align: 'right', priority: 0, value: e => String(e.seq) },
    { title: 'TIME', width: 8, priority: 3, value: e => formatClock(e.created_at) },
    { title: 'ROLE', width: 9, priority: 0, value: roleOf },
    { title: 'TOKENS', width: 22, priority: 2, value: formatTokens },
    { title: 'CONTENT', width: 16, priority: 0, flex: true, value: e => summarizeEntry(e).text },
  ], w - 2)
  const cols = (e: LoopEntry | null) => cells(fitted, e)

  const range = count ? `${offset + 1}-${offset + count} of ${total}` : `0 of ${total}`
  return (
    <Box flexDirection="column" width={w} height={height}>
      <Text bold color={theme.color.loop} wrap="truncate-end">
        {theme.glyph.loop} History of {label} {theme.glyph.pointer} {loop}
        <Text color={theme.color.muted}>  rows {range} {theme.glyph.sep} show {view.role}{view.historyOffset === null ? ' (live)' : ''}</Text>
      </Text>
      <TabBar tab="history" width={w} hints={HISTORY_TAB_HINTS} />
      {page.error ? <Text color={theme.color.error}>{truncate(`History: ${page.error}`, w)}</Text> : null}
      <Text color={theme.color.muted} bold>{'  '}{row(cols(null), w - 2)}</Text>
      <List
        items={ordered}
        getKey={e => String(e.seq)}
        height={Math.max(1, height - 4 - (page.error ? 1 : 0))}
        width={w}
        active={focused}
        selectedIndex={index}
        onSelectedIndexChange={i => setView({ historyIndex: i })}
        onSubmit={e => openEntryDialog(actions, { entry: e, loop })}
        onKey={onKey}
        filter={(e, q) => entryMatches(e, 'all', q)}
        emptyText={page.loading ? 'Loading…' : total === 0 ? `${loop} has no history yet.` : `No ${view.role} entries on this page (f changes the filter, < older).`}
        renderItem={(e, { selected, width: rw }) => (
          <Text
            wrap="truncate-end"
            backgroundColor={selected ? theme.color.selectionBg : undefined}
            inverse={theme.mono && selected}
            bold={selected}
            color={selected ? theme.color.selectionFg : e.role === 'user' ? theme.color.user : theme.color.assistant}
          >
            {selected ? `${theme.glyph.pointer} ` : '  '}{row(cols(e), rw - 2)}
          </Text>
        )}
      />
    </Box>
  )
}

export const HISTORY_TAB_HINTS = [
  { keys: 'enter', label: 'open entry' },
  { keys: '/', label: 'filter text/tool' },
  { keys: 'f', label: 'role' },
  { keys: '< >', label: 'older/newer' },
  { keys: 'l', label: 'next loop' },
  { keys: 'c', label: 'clear' },
]
