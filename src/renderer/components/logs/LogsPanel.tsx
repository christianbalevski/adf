import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useAppStore } from '../../stores/app.store'
import { useDocumentStore } from '../../stores/document.store'
import { usePollWhenVisible } from '../../hooks/usePollWhenVisible'
import { FreshnessStamp } from '../common/FreshnessStamp'
import type { AdfLogEntry, LogLevel } from '../../../shared/types/adf-v02.types'
import { LOGS_MAX_IN_MEMORY, LOGS_PAGE, appendLogs, filterLogs, showingLabel } from './logs-model'

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: 'text-neutral-500',
  info: 'text-blue-600 dark:text-blue-400',
  warn: 'text-amber-600 dark:text-yellow-400',
  error: 'text-red-600 dark:text-red-400'
}

const LEVEL_LABELS: Record<LogLevel, string> = {
  debug: 'DBG',
  info: 'INF',
  warn: 'WRN',
  error: 'ERR'
}

/** Shared by the bottom panel's toolbars (Logs, Tasks). */
export const PANEL_SELECT_CLASS =
  'bg-white dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300 border border-neutral-300 dark:border-neutral-700 rounded px-1.5 py-0.5 text-[11px] outline-none'
export const PANEL_BUTTON_CLASS =
  'hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-300 px-1.5 py-0.5 rounded text-[11px]'
export const PANEL_LIVE_ON_CLASS =
  'bg-green-50 dark:bg-green-900/40 text-green-700 dark:text-green-400 border border-green-200 dark:border-green-800'

export function formatTime(ts: number): string {
  const d = new Date(ts)
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  const s = String(d.getSeconds()).padStart(2, '0')
  const ms = String(d.getMilliseconds()).padStart(3, '0')
  return `${h}:${m}:${s}.${ms}`
}

/** Returns the current log count for use in tab badges */
export function useLogsCount(): number {
  const [count, setCount] = useState(0)
  const filePath = useDocumentStore((s) => s.filePath)

  useEffect(() => {
    if (!filePath) { setCount(0); return }
    window.adfApi?.getLogs(1).then(({ count: c }) => setCount(c))
  }, [filePath])

  return count
}

export function LogsPanel() {
  const autoRefresh = useAppStore((s) => s.logsAutoRefresh)
  const setAutoRefresh = useAppStore((s) => s.setLogsAutoRefresh)

  const filePath = useDocumentStore((s) => s.filePath)

  const [logs, setLogs] = useState<AdfLogEntry[]>([])
  const logsRef = useRef(logs)
  logsRef.current = logs
  /** Rows in the log table, as of the last fetch (plus what polls appended since). */
  const [total, setTotal] = useState(0)
  const [levelFilter, setLevelFilter] = useState<LogLevel | 'all'>('all')
  const [originFilter, setOriginFilter] = useState<string>('all')
  const [textFilter, setTextFilter] = useState('')
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [userScrolledUp, setUserScrolledUp] = useState(false)
  const [fetchedAt, setFetchedAt] = useState<number | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)

  const scrollRef = useRef<HTMLDivElement>(null)
  const highestIdRef = useRef(0)
  /** How many rows the user asked for (first page + each "Load older"); live trims stop there. */
  const loadedTargetRef = useRef(LOGS_PAGE)
  /** Bumped per agent: a fetch that lands after a switch is dropped. */
  const generationRef = useRef(0)
  /** Polls wait for the first page, or the first one would ask for every row after id 0. */
  const initialLoadedRef = useRef(false)
  const fetchingRef = useRef(false)
  /** Set by "Load older": the list grew above the viewport, so the scroll moves with it. */
  const prependAnchorRef = useRef<number | null>(null)

  // Load logs when file changes (or on initial mount)
  useEffect(() => {
    const generation = ++generationRef.current
    setLogs([])
    setTotal(0)
    setExpandedId(null)
    setOriginFilter('all')
    setUserScrolledUp(false)
    setFetchedAt(null)
    highestIdRef.current = 0
    loadedTargetRef.current = LOGS_PAGE
    initialLoadedRef.current = false

    if (!filePath) return

    window.adfApi?.getLogs(LOGS_PAGE).then(({ logs: fetched, count }) => {
      if (generation !== generationRef.current) return
      // getLogs returns newest-first, reverse for chronological
      const chronological = [...fetched].reverse()
      setLogs(chronological)
      setTotal(count)
      setFetchedAt(Date.now())
      if (chronological.length > 0) {
        highestIdRef.current = chronological[chronological.length - 1].id
      }
      initialLoadedRef.current = true
    })
  }, [filePath])

  const fetchNew = useCallback(() => {
    if (!initialLoadedRef.current || fetchingRef.current) return
    const generation = generationRef.current
    fetchingRef.current = true
    window.adfApi?.getLogsAfterId(highestIdRef.current).then(({ logs: newLogs }) => {
      if (generation !== generationRef.current) return
      setFetchedAt(Date.now())
      if (newLogs.length === 0) return
      highestIdRef.current = Math.max(highestIdRef.current, newLogs[newLogs.length - 1].id)
      const { logs: next, added } = appendLogs(logsRef.current, newLogs, Math.max(LOGS_MAX_IN_MEMORY, loadedTargetRef.current))
      if (added === 0) return
      logsRef.current = next
      setLogs(next)
      setTotal((t) => t + added)
    }).finally(() => { fetchingRef.current = false })
  }, [])

  // Live: polls only while the panel is on screen and the window is shown.
  usePollWhenVisible(fetchNew, 2000, { enabled: autoRefresh, ref: scrollRef })

  const handleLoadOlder = useCallback(() => {
    if (loadingOlder) return
    const generation = generationRef.current
    const want = logs.length + LOGS_PAGE
    setLoadingOlder(true)
    window.adfApi?.getLogs(want).then(({ logs: fetched, count }) => {
      if (generation !== generationRef.current) return
      const chronological = [...fetched].reverse()
      loadedTargetRef.current = Math.max(loadedTargetRef.current, want)
      // Keep anything a poll appended past what this fetch saw.
      const merged = appendLogs(chronological, logsRef.current, Number.MAX_SAFE_INTEGER).logs
      prependAnchorRef.current = virtualizerRef.current?.getTotalSize() ?? null
      logsRef.current = merged
      setLogs(merged)
      setTotal(count)
      setUserScrolledUp(true)
      if (chronological.length > 0) {
        highestIdRef.current = Math.max(highestIdRef.current, chronological[chronological.length - 1].id)
      }
    }).finally(() => setLoadingOlder(false))
  }, [logs.length, loadingOlder])

  const handleClear = useCallback(() => {
    if (!window.confirm('Clear all logs? This cannot be undone.')) return
    window.adfApi?.clearLogs().then(() => {
      setLogs([])
      setTotal(0)
      highestIdRef.current = 0
    })
  }, [])

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current
    setUserScrolledUp(scrollHeight - scrollTop - clientHeight > 40)
  }, [])

  const distinctOrigins = useMemo(() => {
    const set = new Set<string>()
    for (const l of logs) { if (l.origin) set.add(l.origin) }
    return [...set].sort()
  }, [logs])

  const filtered = useMemo(
    () => filterLogs(logs, { level: levelFilter, origin: originFilter, text: textFilter }),
    [logs, levelFilter, originFilter, textFilter]
  )
  const filtering = filtered !== logs

  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 18,
    getItemKey: (index) => filtered[index]?.id ?? index,
    overscan: 20
  })
  const virtualizerRef = useRef(virtualizer)
  virtualizerRef.current = virtualizer

  // Older rows went in above: keep the rows the user was looking at in place.
  useLayoutEffect(() => {
    const before = prependAnchorRef.current
    if (before === null || !scrollRef.current) return
    prependAnchorRef.current = null
    scrollRef.current.scrollTop += virtualizer.getTotalSize() - before
  }, [logs, virtualizer])

  // Auto-scroll to bottom when new logs arrive (unless user scrolled up)
  useEffect(() => {
    if (!userScrolledUp && filtered.length > 0) {
      virtualizer.scrollToIndex(filtered.length - 1, { align: 'end' })
    }
  }, [filtered.length, userScrolledUp, virtualizer])

  const hasOlder = logs.length < total

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-1 text-xs text-neutral-500 dark:text-neutral-400 shrink-0">
        {/* Level filter */}
        <select
          value={levelFilter}
          onChange={(e) => setLevelFilter(e.target.value as LogLevel | 'all')}
          className={PANEL_SELECT_CLASS}
          aria-label="Level"
        >
          <option value="all">All Levels</option>
          <option value="debug">Debug</option>
          <option value="info">Info</option>
          <option value="warn">Warn</option>
          <option value="error">Error</option>
        </select>

        {/* Origin filter */}
        <select
          value={originFilter}
          onChange={(e) => setOriginFilter(e.target.value)}
          className={`${PANEL_SELECT_CLASS} max-w-[140px]`}
          aria-label="Origin"
        >
          <option value="all">All Origins</option>
          {distinctOrigins.map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </select>

        {/* Text filter */}
        <input
          value={textFilter}
          onChange={(e) => setTextFilter(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') setTextFilter('') }}
          placeholder="Filter…"
          aria-label="Filter logs"
          className={`${PANEL_SELECT_CLASS} w-40 min-w-0 placeholder:text-neutral-400 dark:placeholder:text-neutral-500 focus:border-blue-400`}
        />

        {/* Live toggle */}
        <button
          onClick={() => setAutoRefresh(!autoRefresh)}
          className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] ${
            autoRefresh ? PANEL_LIVE_ON_CLASS : PANEL_BUTTON_CLASS
          }`}
          title={autoRefresh ? 'Live: new entries appear every 2s while the panel is open. Click to pause.' : 'Paused. Click to follow new entries.'}
          aria-pressed={autoRefresh}
        >
          {autoRefresh && (
            <span className="w-1.5 h-1.5 rounded-full bg-green-500 dark:bg-green-400 animate-pulse" />
          )}
          Live
        </button>

        {/* Paused: how old the view is, and a way to catch up */}
        {!autoRefresh && <FreshnessStamp at={fetchedAt} onRefresh={fetchNew} />}

        <div className="flex-1" />

        {/* Clear */}
        <button
          onClick={handleClear}
          className={PANEL_BUTTON_CLASS}
          title="Clear all logs"
        >
          Clear
        </button>
      </div>

      {/* Log content (virtualized) */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-auto font-mono text-[11px] leading-[18px] px-3 py-1"
      >
        {filtered.length === 0 ? (
          <div className="text-neutral-400 dark:text-neutral-600 py-4 text-center">
            {logs.length > 0 && filtering ? 'No entries match' : 'No log entries'}
          </div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
            {virtualizer.getVirtualItems().map((item) => {
              const entry = filtered[item.index]
              return (
                <div
                  key={item.key}
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${item.start}px)` }}
                >
                  <LogRow
                    entry={entry}
                    expanded={expandedId === entry.id}
                    onToggle={() => setExpandedId(expandedId === entry.id ? null : entry.id)}
                  />
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Footer: how much of the log is loaded */}
      {total > 0 && (
        <div className="flex items-center gap-2 px-3 py-0.5 text-[10px] text-neutral-400 dark:text-neutral-500 border-t border-neutral-200 dark:border-white/5 shrink-0">
          <span className="tabular-nums">
            {filtering ? `${filtered.length.toLocaleString()} match · ` : ''}{showingLabel(logs.length, total)}
          </span>
          {hasOlder && (
            <>
              <span aria-hidden="true">·</span>
              <button
                onClick={handleLoadOlder}
                disabled={loadingOlder}
                className="text-blue-600 dark:text-blue-400 hover:underline disabled:opacity-50 disabled:no-underline"
              >
                {loadingOlder ? 'Loading…' : 'Load older'}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function LogRow({
  entry,
  expanded,
  onToggle
}: {
  entry: AdfLogEntry
  expanded: boolean
  onToggle: () => void
}) {
  const level = entry.level as LogLevel
  const hasData = entry.data !== null

  return (
    <div>
      <div
        onClick={hasData ? onToggle : undefined}
        className={`flex gap-2 ${hasData ? 'cursor-pointer hover:bg-neutral-100 dark:hover:bg-neutral-900/50' : ''}`}
      >
        <span className="text-neutral-400 dark:text-neutral-600 shrink-0 select-none" title={new Date(entry.created_at).toLocaleString()}>
          [{formatTime(entry.created_at)}]
        </span>
        <span className={`shrink-0 font-semibold ${LEVEL_COLORS[level] || 'text-neutral-500'}`}>
          {LEVEL_LABELS[level] || level.toUpperCase().slice(0, 3)}
        </span>
        {entry.origin && (
          <span className="text-purple-600 dark:text-purple-400 shrink-0">{entry.origin}</span>
        )}
        {entry.event && (
          <span className="text-cyan-700 dark:text-cyan-400 shrink-0">{entry.event}</span>
        )}
        <span className="text-neutral-800 dark:text-neutral-300 min-w-0 break-words">
          {entry.origin || entry.event ? '— ' : ''}{entry.message}
        </span>
        {hasData && (
          <span className="text-neutral-400 dark:text-neutral-600 shrink-0 select-none">
            {expanded ? '▼' : '▶'}
          </span>
        )}
      </div>
      {expanded && entry.data && (
        <pre className="ml-8 my-1 px-2 py-1.5 bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded text-[10px] text-neutral-600 dark:text-neutral-400 overflow-x-auto whitespace-pre-wrap">
          {formatJsonSafe(entry.data)}
        </pre>
      )}
    </div>
  )
}

function formatJsonSafe(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}
