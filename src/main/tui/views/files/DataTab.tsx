// Read-only agent data next to the files: mesh inbox / outbox and meta.
// List on the left, the selected record in the viewer on the right.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Box, Text } from 'ink'
import { useTheme, type Theme } from '../../app/theme'
import { useClient, useTuiSelector } from '../../state/store'
import { List } from '../../ui/List'
import { displayWidth, formatAgo, oneLine, truncate } from '../../ui/text'
import type { InboxMessage, MetaEntry, OutboxMessage, UmbilicalEvent } from '../../api/types'
import type { FilesPane } from './state'
import { Viewer } from './Viewer'

export type DataKind = 'inbox' | 'outbox' | 'meta'

export const STATUS_FILTERS: Record<DataKind, Array<string | undefined>> = {
  inbox: [undefined, 'unread', 'read', 'archived'],
  outbox: [undefined, 'pending', 'sent', 'delivered', 'failed'],
  meta: [undefined],
}

interface Record_ {
  key: string
  status?: string
  who: string
  title: string
  at?: number
  detail: string
  detailName: string
}

function statusColor(theme: Theme, status: string | undefined): string | undefined {
  switch (status) {
    case 'unread':
    case 'pending': return theme.color.accent
    case 'failed': return theme.color.error
    case 'delivered':
    case 'sent': return theme.color.success
    case 'readonly':
    case 'increment': return theme.color.warn
    default: return theme.color.muted
  }
}

function header(fields: Array<[string, unknown]>): string {
  return fields
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k.padEnd(10)} ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('\n')
}

const iso = (ms: number | undefined) => (ms ? new Date(ms).toISOString() : undefined)

function inboxRecord(m: InboxMessage): Record_ {
  return {
    key: m.id,
    status: m.status,
    who: m.sender_alias || m.from,
    title: m.subject || oneLine(m.content),
    at: m.received_at,
    detailName: 'message.md',
    detail: `${header([
      ['from', m.sender_alias ? `${m.sender_alias} <${m.from}>` : m.from],
      ['to', m.to],
      ['subject', m.subject],
      ['status', m.status],
      ['received', iso(m.received_at)],
      ['sent', iso(m.sent_at)],
      ['thread', m.thread_id],
      ['reply to', m.reply_to],
      ['network', m.network],
      ['source', m.source],
      ['attached', m.attachments?.length ? `${m.attachments.length} attachment(s)` : undefined],
    ])}\n\n${m.content}`,
  }
}

function outboxRecord(m: OutboxMessage): Record_ {
  return {
    key: m.id,
    status: m.status,
    who: m.recipient_alias || m.to,
    title: m.subject || oneLine(m.content),
    at: m.created_at,
    detailName: 'message.md',
    detail: `${header([
      ['to', m.recipient_alias ? `${m.recipient_alias} <${m.to}>` : m.to],
      ['from', m.from],
      ['subject', m.subject],
      ['status', m.status_code ? `${m.status} (HTTP ${m.status_code})` : m.status],
      ['created', iso(m.created_at)],
      ['delivered', iso(m.delivered_at)],
      ['thread', m.thread_id],
      ['address', m.address],
      ['network', m.network],
      ['attached', m.attachments?.length ? `${m.attachments.length} attachment(s)` : undefined],
    ])}\n\n${m.content}`,
  }
}

function metaRecord(e: MetaEntry): Record_ {
  let pretty = e.value
  let name = 'value.txt'
  try {
    const parsed = JSON.parse(e.value)
    if (parsed && typeof parsed === 'object') {
      pretty = JSON.stringify(parsed, null, 2)
      name = 'value.json'
    }
  } catch { /* plain value */ }
  return {
    key: e.key,
    status: e.protection,
    who: e.key,
    title: oneLine(e.value),
    detailName: name,
    detail: pretty,
  }
}

export interface DataTabProps {
  kind: DataKind
  width: number
  height: number
  focused: boolean
  agentId: string
  agentLabel: string
  pane: FilesPane
  setPane: (pane: FilesPane) => void
}

const LIVE_EVENTS: Record<DataKind, string[]> = {
  inbox: ['message.received'],
  outbox: ['message.sent', 'message.queued', 'message.delivery_failed'],
  meta: [],
}

export function DataTab({ kind, width, height, focused, agentId, agentLabel, pane, setPane }: DataTabProps) {
  const theme = useTheme()
  const client = useClient()
  const [records, setRecords] = useState<Record_[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filterIndex, setFilterIndex] = useState(0)
  const [cursor, setCursor] = useState<string | undefined>(undefined)
  const [loadedAt, setLoadedAt] = useState<number | null>(null)
  const status = STATUS_FILTERS[kind][filterIndex]

  const reload = useCallback(async () => {
    try {
      let next: Record_[]
      if (kind === 'inbox') {
        const result = await client.inbox(agentId, status as InboxMessage['status'] | undefined)
        next = [...result.messages].sort((a, b) => b.received_at - a.received_at).map(inboxRecord)
      } else if (kind === 'outbox') {
        const result = await client.outbox(agentId, status as OutboxMessage['status'] | undefined)
        next = [...result.messages].sort((a, b) => b.created_at - a.created_at).map(outboxRecord)
      } else {
        const result = await client.meta(agentId)
        next = [...result.entries].sort((a, b) => a.key.localeCompare(b.key)).map(metaRecord)
      }
      setRecords(next)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setRecords(prev => prev ?? [])
    }
    setLoadedAt(Date.now())
  }, [client, agentId, kind, status])

  useEffect(() => {
    setRecords(null)
    void reload()
  }, [reload])

  const lastEvents = useTuiSelector(s => s.lastEvents)
  const seen = useRef<UmbilicalEvent | undefined>(lastEvents[lastEvents.length - 1])
  useEffect(() => {
    let hit = false
    for (let i = lastEvents.length - 1; i >= 0 && lastEvents[i] !== seen.current; i--) {
      if (lastEvents[i].agent_id === agentId && LIVE_EVENTS[kind].includes(lastEvents[i].event_type)) hit = true
    }
    seen.current = lastEvents[lastEvents.length - 1]
    if (hit) void reload()
  }, [lastEvents])

  const items = records ?? []
  const index = Math.max(0, items.findIndex(r => r.key === cursor))
  const selected = items[index]

  const split = width >= 70
  const listWidth = split ? Math.max(28, Math.min(56, Math.floor(width * 0.45))) : width
  const viewerWidth = split ? width - listWidth - 2 : width
  const showList = split || pane === 'list'
  const showViewer = split || pane === 'viewer'
  const title = kind === 'meta' ? 'Meta' : kind === 'inbox' ? 'Inbox' : 'Outbox'
  const filters = STATUS_FILTERS[kind]
  const summary = records ? `${records.length}${status ? ` ${status}` : ''}` : `loading${theme.glyph.ellipsis}`

  const statusText = (r: Record_) => (kind === 'meta' ? (r.status && r.status !== 'none' ? r.status : '') : (r.status ?? ''))
  const statusWidth = Math.max(0, ...items.map(r => statusText(r).length))
  const longestWho = Math.max(4, ...items.map(r => displayWidth(r.who)))

  const renderRow = (r: Record_, isSelected: boolean, w: number) => {
    const fg = (c: string | undefined) => (isSelected ? theme.color.selectionFg : c)
    const age = r.at ? formatAgo(r.at) : ''
    const whoWidth = Math.min(longestWho, Math.max(6, Math.floor(w * 0.4)))
    const titleWidth = Math.max(1, w - 2 - (statusWidth ? statusWidth + 1 : 0) - whoWidth - 1 - (age ? age.length + 1 : 0))
    const who = truncate(r.who, whoWidth)
    const text = truncate(r.title, titleWidth)
    return (
      <Text
        wrap="truncate-end"
        backgroundColor={isSelected ? theme.color.selectionBg : undefined}
        inverse={theme.mono && isSelected}
        bold={isSelected || r.status === 'unread'}
      >
        <Text color={fg(theme.color.accent)}>{isSelected ? `${theme.glyph.pointer} ` : '  '}</Text>
        {statusWidth ? <Text color={fg(statusColor(theme, r.status))}>{statusText(r).padEnd(statusWidth)} </Text> : null}
        <Text color={fg(kind === 'meta' ? theme.color.info : theme.color.live)}>{who}{' '.repeat(Math.max(0, whoWidth - displayWidth(who)))} </Text>
        <Text color={fg(theme.color.text)}>{text}{' '.repeat(Math.max(0, titleWidth - displayWidth(text)))}</Text>
        {age ? <Text color={fg(theme.color.dim)}> {age}</Text> : null}
      </Text>
    )
  }

  return (
    <Box flexDirection="row" width={width} height={height}>
      {showList ? (
        <Box flexDirection="column" width={listWidth} height={height}>
          <Text wrap="truncate-end">
            <Text bold color={focused && pane === 'list' ? theme.color.accent : theme.color.muted} inverse={theme.mono && focused && pane === 'list'}>{title}</Text>
            <Text color={theme.color.muted}> {summary} {theme.glyph.sep} read-only</Text>
            {filters.length > 1 ? <Text color={theme.color.dim}> {theme.glyph.sep} f {filters.map(f => f ?? 'all').join('/')}</Text> : null}
          </Text>
          {error ? <Text color={theme.color.error} wrap="truncate-end">{error}</Text> : null}
          <List
            items={items}
            getKey={r => r.key}
            height={Math.max(1, height - 1 - (error ? 1 : 0))}
            width={listWidth}
            active={focused && pane === 'list'}
            selectedIndex={index}
            onSelectedIndexChange={(_i, r) => setCursor(r?.key)}
            onSubmit={() => setPane('viewer')}
            filter={(r, q) => `${r.who} ${r.title} ${r.status ?? ''}`.toLowerCase().includes(q.toLowerCase())}
            onKey={(input, key) => {
              if (input === 'r' && !key.ctrl) { void reload(); return true }
              if (input === 'f' && !key.ctrl && filters.length > 1) { setFilterIndex(i => (i + 1) % filters.length); return true }
              return false
            }}
            emptyText={records ? (kind === 'meta' ? `No meta entries in ${agentLabel}.` : `No ${status ?? ''} messages in the ${kind} of ${agentLabel}.`.replace('  ', ' ')) : `Loading${theme.glyph.ellipsis}`}
            renderItem={(r, { selected: isSelected, width: w }) => renderRow(r, isSelected, w)}
          />
        </Box>
      ) : null}
      {showViewer ? (
        <Box
          flexDirection="column"
          width={split ? viewerWidth + 2 : viewerWidth}
          height={height}
          borderStyle={split ? (theme.ascii ? 'classic' : 'single') : undefined}
          borderTop={false}
          borderRight={false}
          borderBottom={false}
          borderColor={focused && pane === 'viewer' ? theme.color.borderFocus : theme.color.border}
          paddingLeft={split ? 1 : 0}
        >
          <Viewer
            width={viewerWidth}
            height={height}
            active={focused && pane === 'viewer'}
            title={selected ? (kind === 'meta' ? selected.key : `${selected.who} ${theme.glyph.sep} ${truncate(selected.title, 40)}`) : title}
            meta={selected?.status ? [selected.status] : loadedAt ? [`loaded ${formatAgo(loadedAt)} ago`] : []}
            name={selected?.detailName ?? 'empty.txt'}
            text={selected?.detail ?? ''}
            plain={kind !== 'meta'}
            loading={records === null}
            resetKey={`${kind}:${selected?.key ?? ''}`}
            onBack={() => setPane('list')}
            emptyText={selected ? '(empty)' : 'Nothing selected.'}
          />
        </Box>
      ) : null}
    </Box>
  )
}
