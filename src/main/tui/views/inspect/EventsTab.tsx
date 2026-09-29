// The live umbilical event tail. Runtime › Events shows every agent (a / l
// narrow it); Inspect › Events is the same tail locked to the selected agent.
//
// Built for a firehose: the store keeps up to MAX_LAST_EVENTS (5000); this
// view re-reads them at most every 100ms, renders only the visible rows (List
// windows), summarizes each event once (eventRow cache, bounded JSON), and
// anchors the cursor on the event itself, so rows dropping off the old end
// never drag the selection. ↑ pauses following; End / G follows again.

import { useCallback, useMemo, useState } from 'react'
import { Box, Text } from 'ink'
import { useTheme } from '../../app/theme'
import { useSelectedAgentId, useSelectedLoop, useThrottledSelector } from '../../state/hooks'
import { List } from '../../ui/List'
import { TextInput } from '../../ui/TextInput'
import { formatClock, truncate } from '../../ui/text'
import { MAIN_LOOP, type UmbilicalEvent } from '../../api/types'
import { useAgentName } from './hooks'
import type { EventFilters } from './state'
import { eventKey, eventRow, filterEvents } from './events'
import { valueLines } from './format'
import { LineText } from './LinesView'

const EMPTY: UmbilicalEvent[] = []
/** Re-read the live tail at most this often (a busy stream coalesces). */
export const EVENTS_REFRESH_MS = 100

export interface EventsTabProps {
  width: number
  height: number
  focused: boolean
  filters: EventFilters
  update: (patch: Partial<EventFilters>) => void
  /** 'agent': locked to the selected agent (Inspect). 'all': every agent (Runtime). */
  scope: 'agent' | 'all'
  /** Raw JSON in the detail pane (/json). */
  json: boolean
}

export function EventsTab({ width, height, focused, filters: stored, update, scope, json }: EventsTabProps) {
  const theme = useTheme()
  const filters: EventFilters = scope === 'agent' ? { ...stored, agent: 'selected' } : stored
  const live = useThrottledSelector(s => s.lastEvents ?? EMPTY, EVENTS_REFRESH_MS)
  const selectedAgentId = useSelectedAgentId()
  const selectedLoop = useSelectedLoop()
  const nameOf = useAgentName()
  const [frozen, setFrozen] = useState<UmbilicalEvent[] | null>(null)
  const [clearedAfter, setClearedAfter] = useState<number>(0)
  const [anchor, setAnchor] = useState<string | null>(null)
  const [pinned, setPinned] = useState(true)
  const [detail, setDetail] = useState(false)
  // One inline editor at a time: the type filter (t) or free-text search (/).
  const [editing, setEditing] = useState<'type' | 'search' | null>(null)
  const [draft, setDraft] = useState(filters.types)
  const [query, setQuery] = useState('')

  const source = frozen ?? live
  const { types, agent, loop } = filters
  const events = useMemo(
    () => {
      let matched = filterEvents(source, { types, agent, loop, follow: true }, { selectedAgentId, selectedLoop })
      if (clearedAfter) matched = matched.filter(e => e.timestamp > clearedAfter)
      const q = query.trim().toLowerCase()
      if (q) matched = matched.filter(e => eventRow(e).search.includes(q) || nameOf(e.agent_id).toLowerCase().includes(q))
      return matched
    },
    [source, types, agent, loop, selectedAgentId, selectedLoop, clearedAfter, query, nameOf],
  )
  const indexOf = useMemo(() => {
    const map = new Map<string, number>()
    events.forEach((e, i) => map.set(eventKey(e), i))
    return map
  }, [events])
  const lastFrozen = frozen?.at(-1)
  const newWhileFrozen = lastFrozen ? live.length - 1 - live.lastIndexOf(lastFrozen) : 0
  const following = filters.follow && pinned && !frozen
  const anchored = anchor === null ? -1 : indexOf.get(anchor) ?? -1
  const index = following || anchored < 0 ? Math.max(0, events.length - 1) : anchored
  const current = events[index]

  const detailRows = detail && current ? Math.max(4, Math.floor((height - 3) / 2)) : 0
  const listHeight = Math.max(1, height - 2 - (editing ? 1 : 0) - (detailRows ? detailRows + 1 : 0))
  const nameWidth = 10
  const loopWidth = 12
  const typeWidth = 22
  const agentLabel = filters.agent === 'selected' || filters.loop === 'selected' ? (selectedAgentId ? nameOf(selectedAgentId) : 'selected (none)') : 'all agents'
  const loopLabel = filters.loop === 'selected' ? selectedLoop : 'all loops'

  const onSelect = useCallback((i: number, item: UmbilicalEvent | undefined) => {
    setAnchor(item ? eventKey(item) : null)
    setPinned(i >= events.length - 1)
  }, [events.length])

  const onKey = (input: string, key: { return: boolean; escape: boolean; backspace: boolean; ctrl: boolean; meta: boolean }) => {
    if (key.ctrl || key.meta) return false
    if (key.return) { setDetail(d => !d); return true }
    // Back out of the detail first (Backspace or Esc), then Esc goes on up.
    if ((key.escape || key.backspace) && detail) { setDetail(false); return true }
    if (input === ' ') {
      if (frozen) { setFrozen(null); setPinned(true) } else setFrozen(live)
      return true
    }
    if (input === 'a' && scope === 'all') { update({ agent: filters.agent === 'all' ? 'selected' : 'all', loop: filters.agent === 'all' ? filters.loop : 'all' }); return true }
    if (input === 'l') { update({ loop: filters.loop === 'all' ? 'selected' : 'all' }); return true }
    if (input === 't') { setDraft(filters.types); setEditing('type'); return true }
    if (input === '/') { setDraft(query); setEditing('search'); return true }
    if (key.escape && query) { setQuery(''); return true }
    if (input === 'f') { update({ follow: !filters.follow }); setPinned(true); return true }
    if (input === 'c') { setClearedAfter(Date.now()); return true }
    if (input === 'x' && (filters.types || (scope === 'all' && filters.agent !== 'all') || filters.loop !== 'all')) {
      update({ types: '', agent: scope === 'all' ? 'all' : 'selected', loop: 'all' })
      return true
    }
    return false
  }

  const status = [
    frozen ? `paused${newWhileFrozen > 0 ? ` (+${newWhileFrozen} new)` : ''}` : following ? 'following' : 'scrolled (End follows)',
    agentLabel,
    loopLabel,
    filters.types ? `type: ${filters.types}` : 'all types',
    query ? `search: ${query}` : '',
    clearedAfter ? `cleared ${formatClock(clearedAfter)}` : '',
  ].filter(Boolean).join(` ${theme.glyph.sep} `)

  const detailLines = useMemo(() => (detailRows && current ? valueLines(current, json).slice(0, detailRows) : []), [detailRows, current, json])

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Text wrap="truncate-end">
        <Text bold color={theme.color.live}>Umbilical </Text>
        <Text color={theme.color.muted}>{events.length}/{source.length} events {theme.glyph.sep} {status}</Text>
      </Text>
      {editing ? (
        <TextInput
          focused={focused}
          keyLayer="main"
          prompt={editing === 'type' ? 'type filter › ' : 'search › '}
          placeholder={editing === 'type' ? 'e.g. tool. turn.completed -turn.delta' : 'text in the type, loop, agent or payload'}
          value={draft}
          onChange={setDraft}
          maxRows={1}
          onKey={(_input, key) => {
            if (key.escape) { setEditing(null); return true }
            return false
          }}
          onSubmit={value => {
            if (editing === 'type') update({ types: value.trim() })
            else setQuery(value.trim())
            setEditing(null)
            return true
          }}
        />
      ) : null}
      <List
        items={events}
        getKey={eventKey}
        height={listHeight}
        width={width}
        active={focused && !editing}
        selectedIndex={index}
        onSelectedIndexChange={onSelect}
        wheelSelects
        onKey={(input, key) => onKey(input, key)}
        emptyText={source.length === 0 ? 'No events yet. They stream in live from the daemon.' : 'No event matches the filters (x resets them).'}
        renderItem={(e, { selected, width: w }) => (
          <EventLine event={e} selected={selected} width={w} name={nameOf(e.agent_id)} widths={[nameWidth, loopWidth, typeWidth]} />
        )}
      />
      {detailRows && current ? (
        <Box flexDirection="column" height={detailRows + 1}>
          <Text color={theme.color.dim}>{theme.glyph.hbar.repeat(Math.max(1, width))}</Text>
          {detailLines.map((line, i) => <LineText key={i} line={line} width={width} />)}
        </Box>
      ) : null}
      <Text color={theme.color.dim} wrap="truncate-end">
        enter detail {theme.glyph.sep} space {frozen ? 'resume' : 'pause'} {theme.glyph.sep} t type {theme.glyph.sep} {scope === 'all' ? `a agent ${theme.glyph.sep} ` : ''}l loop {theme.glyph.sep} End follow {theme.glyph.sep} / search {theme.glyph.sep} c clear {theme.glyph.sep} x reset
      </Text>
    </Box>
  )
}

function EventLine({ event: e, selected, width: w, name, widths: [nameWidth, loopWidth, typeWidth] }: { event: UmbilicalEvent; selected: boolean; width: number; name: string; widths: [number, number, number] }) {
  const theme = useTheme()
  const loop = e.loop ?? MAIN_LOOP
  const fg = selected ? theme.color.selectionFg : undefined
  return (
    <Text wrap="truncate-end" backgroundColor={selected ? theme.color.selectionBg : undefined} inverse={theme.mono && selected}>
      <Text color={fg ?? theme.color.dim}>{formatClock(e.timestamp)} </Text>
      <Text color={fg ?? theme.color.text}>{truncate(name, nameWidth).padEnd(nameWidth)} </Text>
      <Text color={fg ?? (loop === MAIN_LOOP ? theme.color.muted : theme.color.loop)}>{truncate(loop, loopWidth).padEnd(loopWidth)} </Text>
      <Text color={fg ?? typeColor(theme, e.event_type)}>{truncate(e.event_type, typeWidth).padEnd(typeWidth)} </Text>
      <Text color={fg ?? theme.color.muted}>{truncate(eventRow(e).summary, Math.max(4, w - nameWidth - loopWidth - typeWidth - 12))}</Text>
    </Text>
  )
}

function typeColor(theme: ReturnType<typeof useTheme>, type: string): string | undefined {
  if (type.endsWith('.failed') || type.includes('error')) return theme.color.error
  if (type.startsWith('hil.') || type.startsWith('ask.')) return theme.color.warn
  if (type.startsWith('tool.')) return theme.color.tool
  if (type.startsWith('turn.') || type.startsWith('llm.')) return theme.color.assistant
  if (type.startsWith('loop.')) return theme.color.loop
  if (type.startsWith('agent.')) return theme.color.live
  return theme.color.info
}
