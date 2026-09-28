import { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text } from 'ink'
import { useTheme } from '../../app/theme'
import { WHEEL_STEP, useKeys } from '../../app/keys'
import { useActions, useStore } from '../../state/store'
import { useAgent, useLoops } from '../../state/hooks'
import { List } from '../../ui/List'
import { Table } from '../../ui/Table'
import { formatClock, previewJson, truncate } from '../../ui/text'
import type { DaemonClient } from '../../api/client'
import type { AdfLogEntry } from '../../api/types'
import { LinesView } from './LinesView'
import { plain, valueLines, type Line } from './format'
import { useDaemonData } from './hooks'
import { useInspectState } from './state'
import { adapterLines, identityLines, mcpLines, runtimeLines, usageLines } from './diag-lines'

interface TabProps { agentId: string; width: number; height: number; focused: boolean }

function DiagTab<T>({ agentId, width, height, focused, load, build, hint }: TabProps & {
  load: (client: DaemonClient) => Promise<T>
  build: (data: T) => Line[]
  hint?: string
}) {
  const theme = useTheme()
  const [inspect] = useInspectState()
  const { data, error, loading, loadedAt, reload } = useDaemonData(agentId, load)
  useKeys((input, key) => {
    if (key.ctrl || key.meta) return false
    if (input === 'r') { reload(); return true }
    return false
  }, { layer: 'main', active: focused })
  const lines = useMemo(() => {
    if (error) return [plain(`Could not load: ${error}`, 'error'), plain('r retries.', 'muted')]
    if (data === undefined) return []
    return inspect.json ? valueLines(data, true) : build(data)
  }, [data, error, inspect.json, build])
  return (
    <Box flexDirection="column" width={width} height={height}>
      <LinesView lines={lines} width={width} height={Math.max(1, height - 1)} active={focused} emptyText={loading ? 'Loading…' : 'Nothing to show.'} />
      <Text color={theme.color.dim} wrap="truncate-end">
        r refresh {theme.glyph.sep} /json raw {hint ? `${theme.glyph.sep} ${hint} ` : ''}{theme.glyph.sep} {loading ? 'loading…' : loadedAt ? `as of ${formatClock(loadedAt)}` : ''}
      </Text>
    </Box>
  )
}

export function RuntimeTab(props: TabProps) {
  const loops = useLoops(props.agentId)
  const build = useMemo(() => (d: Awaited<ReturnType<DaemonClient['agentRuntime']>>) => runtimeLines(d, loops), [loops])
  return <DiagTab {...props} load={c => c.agentRuntime(props.agentId)} build={build} />
}

export function UsageTab(props: TabProps) {
  const agent = useAgent(props.agentId)
  const build = useMemo(() => (d: Awaited<ReturnType<DaemonClient['agentUsage']>>) => usageLines(d, agent?.tokens, agent?.lastModel), [agent?.tokens, agent?.lastModel])
  return <DiagTab {...props} load={c => c.agentUsage(props.agentId)} build={build} />
}

export function McpTab(props: TabProps) {
  return <DiagTab {...props} load={c => c.agentMcp(props.agentId)} build={mcpLines} />
}

export function AdaptersTab(props: TabProps) {
  return <DiagTab {...props} load={c => c.agentAdapters(props.agentId)} build={adapterLines} />
}

export function IdentityTab(props: TabProps) {
  return <DiagTab {...props} load={c => c.identities(props.agentId)} build={identityLines} hint="metadata only" />
}

// --- logs -------------------------------------------------------------------------

const LOG_LIMIT = 200
const LOG_POLL_MS = 2000

export function LogsTab({ agentId, width, height, focused }: TabProps) {
  const theme = useTheme()
  const actions = useActions()
  const { client } = useStore()
  const [inspect, update] = useInspectState()
  const follow = inspect.logsFollow
  const [logs, setLogs] = useState<AdfLogEntry[]>([])
  const [error, setError] = useState<string | undefined>(undefined)
  const [cursor, setCursor] = useState(0)
  const [pinned, setPinned] = useState(true)
  const [detail, setDetail] = useState(false)
  const lastId = useRef(0)

  const loadAll = async () => {
    const result = await actions.run('Logs', c => c.logs(agentId, { limit: LOG_LIMIT }))
    if (!result) { setError('could not load logs'); return }
    const sorted = [...result.logs].sort((a, b) => a.id - b.id)
    lastId.current = sorted.at(-1)?.id ?? 0
    setLogs(sorted)
    setError(undefined)
  }

  useEffect(() => { lastId.current = 0; setLogs([]); void loadAll() }, [agentId])

  useEffect(() => {
    if (!follow) return
    let stopped = false
    const timer = setInterval(async () => {
      try {
        const result = await client.logsAfter(agentId, lastId.current)
        if (stopped) return
        setError(undefined)
        if (result.logs.length === 0) return
        const fresh = [...result.logs].sort((a, b) => a.id - b.id)
        lastId.current = fresh.at(-1)?.id ?? lastId.current
        setLogs(prev => [...prev, ...fresh].slice(-2000))
      } catch (err) {
        // Shown in the header row; a toast every poll would drown the screen.
        if (!stopped) setError(`follow failed, retrying: ${err instanceof Error ? err.message : String(err)}`)
      }
    }, LOG_POLL_MS)
    return () => { stopped = true; clearInterval(timer) }
  }, [agentId, follow])

  const tail = follow && pinned
  const index = tail ? Math.max(0, logs.length - 1) : Math.min(cursor, Math.max(0, logs.length - 1))
  const current = logs[index]
  const detailRows = detail && current ? Math.min(8, Math.floor(height / 3)) : 0

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Text wrap="truncate-end" color={theme.color.muted}>
        {logs.length} entries {theme.glyph.sep} {follow ? (tail ? 'following' : 'follow on, scrolled') : 'follow off'}{error ? ` ${theme.glyph.sep} ${error}` : ''}
      </Text>
      <List
        items={logs}
        getKey={l => String(l.id)}
        height={Math.max(1, height - 2 - (detailRows ? detailRows + 1 : 0))}
        width={width}
        active={focused}
        selectedIndex={index}
        onSelectedIndexChange={i => { setCursor(i); setPinned(i >= logs.length - 1) }}
        filter={(l, q) => `${l.level} ${l.origin ?? ''} ${l.event ?? ''} ${l.target ?? ''} ${l.message}`.toLowerCase().includes(q.toLowerCase())}
        onKey={(input, key) => {
          if (key.ctrl || key.meta) return false
          if (key.return) { setDetail(d => !d); return true }
          if (input === 'f') { update({ logsFollow: !follow }); setPinned(true); return true }
          if (input === 'r') { void loadAll(); return true }
          return false
        }}
        emptyText="No log entries."
        renderItem={(l, { selected, width: w }) => {
          const fg = selected ? theme.color.selectionFg : undefined
          const levelColor = l.level === 'error' ? theme.color.error : l.level === 'warn' ? theme.color.warn : l.level === 'debug' ? theme.color.dim : theme.color.info
          return (
            <Text wrap="truncate-end" backgroundColor={selected ? theme.color.selectionBg : undefined} inverse={theme.mono && selected}>
              <Text color={fg ?? theme.color.dim}>{formatClock(l.created_at)} </Text>
              <Text color={fg ?? levelColor}>{String(l.level).padEnd(5)} </Text>
              <Text color={fg ?? theme.color.muted}>{truncate(`${l.origin ?? '-'}${l.event ? `/${l.event}` : ''}`, 22).padEnd(22)} </Text>
              <Text color={fg ?? theme.color.text}>{truncate(l.message.replace(/\s+/g, ' '), Math.max(4, w - 40))}</Text>
            </Text>
          )
        }}
      />
      {detailRows && current ? (
        <Box flexDirection="column" height={detailRows + 1}>
          <Text color={theme.color.dim}>{theme.glyph.hbar.repeat(Math.max(1, width))}</Text>
          <LinesView lines={valueLines({ ...current, data: parseMaybeJson(current.data) }, inspect.json)} width={width} height={detailRows} active={false} />
        </Box>
      ) : null}
      <Text color={theme.color.dim} wrap="truncate-end">enter detail {theme.glyph.sep} f follow {theme.glyph.sep} r reload {theme.glyph.sep} / filter {theme.glyph.sep} G newest</Text>
    </Box>
  )
}

function parseMaybeJson(text: string | null): unknown {
  if (!text) return text
  try { return JSON.parse(text) } catch { return text }
}

// --- tables -----------------------------------------------------------------------

const PAGE = 50

export function TablesTab({ agentId, width, height, focused }: TabProps) {
  const theme = useTheme()
  const [inspect] = useInspectState()
  const tables = useDaemonData(agentId, c => c.tables(agentId))
  const [open, setOpen] = useState<string | null>(null)
  const [offset, setOffset] = useState(0)
  const [rowIndex, setRowIndex] = useState(0)
  const [rowDetail, setRowDetail] = useState(false)
  const rows = useDaemonData(open ? `${agentId}:${open}:${offset}` : null, c => c.table(agentId, open ?? '', { limit: PAGE, offset }))
  const total = tables.data?.tables.find(t => t.name === open)?.row_count

  useEffect(() => { setOpen(null); setOffset(0) }, [agentId])

  useKeys((input, key) => {
    if (!open || key.ctrl || key.meta) return false
    const count = rows.data?.rows.length ?? 0
    if (key.escape || key.backspace) {
      if (rowDetail) setRowDetail(false)
      else { setOpen(null); setOffset(0); setRowIndex(0) }
      return true
    }
    if (rowDetail) return false
    if (key.upArrow || input === 'k') { setRowIndex(i => Math.max(0, i - 1)); return true }
    if (key.downArrow || input === 'j') { setRowIndex(i => Math.min(Math.max(0, count - 1), i + 1)); return true }
    if (input === 'n' || key.pageDown) { if (count === PAGE) { setOffset(o => o + PAGE); setRowIndex(0) } return true }
    if (input === 'p' || key.pageUp) { setOffset(o => Math.max(0, o - PAGE)); setRowIndex(0); return true }
    if (key.return && count > 0) { setRowDetail(true); return true }
    if (input === 'r') { rows.reload(); return true }
    return false
  }, { layer: 'main', active: focused && !!open })

  if (!open) {
    return (
      <Box flexDirection="column" width={width} height={height}>
        {tables.error ? <Text color={theme.color.error}>Could not load tables: {tables.error}</Text> : null}
        <List
          items={tables.data?.tables ?? []}
          getKey={t => t.name}
          height={Math.max(1, height - 1 - (tables.error ? 1 : 0))}
          width={width}
          active={focused}
          filter={(t, q) => t.name.toLowerCase().includes(q.toLowerCase())}
          onSubmit={t => { setOpen(t.name); setOffset(0); setRowIndex(0) }}
          onKey={(input, key) => { if (input === 'r' && !key.ctrl) { tables.reload(); return true } return false }}
          emptyText={tables.loading ? 'Loading tables…' : 'No local tables.'}
          renderItem={(t, { selected, width: w }) => (
            <Text wrap="truncate-end" backgroundColor={selected ? theme.color.selectionBg : undefined} inverse={theme.mono && selected} color={selected ? theme.color.selectionFg : theme.color.text}>
              {selected ? theme.glyph.pointer : ' '} {truncate(t.name, Math.max(8, w - 16)).padEnd(Math.max(8, w - 16))} <Text color={selected ? undefined : theme.color.muted}>{String(t.row_count).padStart(8)} rows</Text>
            </Text>
          )}
        />
        <Text color={theme.color.dim} wrap="truncate-end">enter browse rows {theme.glyph.sep} / filter {theme.glyph.sep} r refresh</Text>
      </Box>
    )
  }

  const data = rows.data
  const columns = (data?.columns ?? []).slice(0, 8).map(name => ({ key: name, title: name, minWidth: 6, value: (row: Record<string, unknown>) => cell(row[name]) }))
  const selectedRow = data?.rows[rowIndex]
  return (
    <Box flexDirection="column" width={width} height={height}>
      <Text wrap="truncate-end">
        <Text bold color={theme.color.accent}>{open}</Text>
        <Text color={theme.color.muted}> rows {offset + 1}-{offset + (data?.rows.length ?? 0)}{total !== undefined ? ` of ${total}` : ''}{(data?.columns.length ?? 0) > 8 ? ` ${theme.glyph.sep} first 8 of ${data?.columns.length} columns (enter shows all)` : ''}</Text>
      </Text>
      {rows.error ? <Text color={theme.color.error}>Could not load rows: {rows.error}</Text> : null}
      {rowDetail && selectedRow ? (
        <LinesView lines={valueLines(selectedRow, inspect.json)} width={width} height={Math.max(1, height - 2)} active={focused} />
      ) : (
        <Box height={Math.max(1, height - 2)} flexDirection="column">
          {data ? <Table columns={columns} rows={data.rows} getKey={r => rowKey(r, data.rows)} width={width} selectedIndex={rowIndex} height={Math.max(2, height - 2)} emptyText="No rows." onWheel={delta => setRowIndex(i => Math.max(0, Math.min((data.rows.length || 1) - 1, i + delta * WHEEL_STEP)))} /> : <Text color={theme.color.muted}>Loading rows…</Text>}
        </Box>
      )}
      <Text color={theme.color.dim} wrap="truncate-end">{rowDetail ? 'esc back to rows' : `enter row detail ${theme.glyph.sep} n/p page ${theme.glyph.sep} esc tables ${theme.glyph.sep} r refresh`}</Text>
    </Box>
  )
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value.replace(/\s+/g, ' ')
  return previewJson(value, 200)
}

function rowKey(row: Record<string, unknown>, all: Record<string, unknown>[]): string {
  return String(all.indexOf(row))
}
