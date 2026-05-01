import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useAppStore } from '../../stores/app.store'
import { useDocumentStore } from '../../stores/document.store'
import type { AdfLogEntry, LogLevel } from '../../../shared/types/adf-v02.types'

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: 'text-neutral-500',
  info: 'text-blue-400',
  warn: 'text-yellow-400',
  error: 'text-red-400'
}

const LEVEL_LABELS: Record<LogLevel, string> = {
  debug: 'DBG',
  info: 'INF',
  warn: 'WRN',
  error: 'ERR'
}

const MAX_IN_MEMORY = 2000

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
  const [levelFilter, setLevelFilter] = useState<LogLevel | 'all'>('all')
  const [originFilter, setOriginFilter] = useState<string>('all')
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [userScrolledUp, setUserScrolledUp] = useState(false)

  const scrollRef = useRef<HTMLDivElement>(null)
  const highestIdRef = useRef(0)

  // Load logs when file changes (or on initial mount)
  useEffect(() => {
    setLogs([])
    setExpandedId(null)
    setOriginFilter('all')
    setUserScrolledUp(false)
    highestIdRef.current = 0

    if (!filePath) return

    window.adfApi?.getLogs(500).then(({ logs: fetched }) => {
      // getLogs returns newest-first, reverse for chronological
      const chronological = [...fetched].reverse()
      setLogs(chronological)
      if (chronological.length > 0) {
        highestIdRef.current = chronological[chronological.length - 1].id
      }
    })
  }, [filePath])

  // Auto-scroll to bottom when new logs arrive (unless user scrolled up)
  useEffect(() => {
    if (!userScrolledUp && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [logs, userScrolledUp])

  // Auto-refresh interval
  const fetchingRef = useRef(false)
  useEffect(() => {
    if (!autoRefresh) return
    const interval = setInterval(() => {
      if (fetchingRef.current) return // skip if previous poll still in-flight
      fetchingRef.current = true
      window.adfApi?.getLogsAfterId(highestIdRef.current).then(({ logs: newLogs }) => {
        if (newLogs.length === 0) return
        highestIdRef.current = newLogs[newLogs.length - 1].id
        setLogs((prev) => {
          // Deduplicate: skip entries already present (race between initial load & poll)
          const lastPrevId = prev.length > 0 ? prev[prev.length - 1].id : 0
          const fresh = newLogs.filter(e => e.id > lastPrevId)
          if (fresh.length === 0) return prev
          const combined = [...prev, ...fresh]
          return combined.length > MAX_IN_MEMORY
            ? combined.slice(combined.length - MAX_IN_MEMORY)
            : combined
        })
      }).finally(() => { fetchingRef.current = false })
    }, 2000)
    return () => clearInterval(interval)
  }, [autoRefresh])

  const handleManualRefresh = useCallback(() => {
    window.adfApi?.getLogsAfterId(highestIdRef.current).then(({ logs: newLogs }) => {
      if (newLogs.length === 0) return
      highestIdRef.current = newLogs[newLogs.length - 1].id
      setLogs((prev) => {
        const lastPrevId = prev.length > 0 ? prev[prev.length - 1].id : 0
        const fresh = newLogs.filter(e => e.id > lastPrevId)
        if (fresh.length === 0) return prev
        const combined = [...prev, ...fresh]
        return combined.length > MAX_IN_MEMORY
          ? combined.slice(combined.length - MAX_IN_MEMORY)
          : combined
      })
    })
  }, [])

  const handleClear = useCallback(() => {
    window.adfApi?.clearLogs().then(() => {
      setLogs([])
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

  const filtered = logs.filter((l) => {
    if (levelFilter !== 'all' && l.level !== levelFilter) return false
    if (originFilter !== 'all' && (l.origin ?? '') !== originFilter) return false
    return true
  })

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-1 text-xs text-neutral-400 shrink-0">
        {/* Level filter */}
        <select
          value={levelFilter}
          onChange={(e) => setLevelFilter(e.target.value as LogLevel | 'all')}
          className="bg-neutral-800 text-neutral-300 border border-neutral-700 rounded px-1.5 py-0.5 text-[11px] outline-none"
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
          className="bg-neutral-800 text-neutral-300 border border-neutral-700 rounded px-1.5 py-0.5 text-[11px] outline-none max-w-[140px]"
        >
          <option value="all">All Origins</option>
          {distinctOrigins.map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </select>

        {/* Auto-refresh toggle */}
        <button
          onClick={() => setAutoRefresh(!autoRefresh)}
          className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] ${
            autoRefresh
              ? 'bg-green-900/40 text-green-400 border border-green-800'
              : 'hover:bg-neutral-800 text-neutral-500'
          }`}
          title={autoRefresh ? 'Stop auto-refresh' : 'Start auto-refresh (2s)'}
        >
          {autoRefresh && (
            <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
          )}
          Auto
        </button>

        {/* Manual refresh (when auto is off) */}
        {!autoRefresh && (
          <button
            onClick={handleManualRefresh}
            className="hover:bg-neutral-800 text-neutral-500 hover:text-neutral-300 px-1.5 py-0.5 rounded text-[11px]"
            title="Refresh"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
          </button>
        )}

        <div className="flex-1" />

        {/* Clear */}
        <button
          onClick={handleClear}
          className="hover:bg-neutral-800 text-neutral-500 hover:text-neutral-300 px-1.5 py-0.5 rounded text-[11px]"
          title="Clear all logs"
        >
          Clear
        </button>
      </div>

      {/* Log content */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-auto font-mono text-[11px] leading-[18px] px-3 py-1"
      >
        {filtered.length === 0 ? (
          <div className="text-neutral-600 py-4 text-center">No log entries</div>
        ) : (
          filtered.map((entry) => (
            <LogRow
              key={entry.id}
              entry={entry}
              expanded={expandedId === entry.id}
              onToggle={() => setExpandedId(expandedId === entry.id ? null : entry.id)}
            />
          ))
        )}
      </div>
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
        className={`flex gap-2 ${hasData ? 'cursor-pointer hover:bg-neutral-900/50' : ''}`}
      >
        <span className="text-neutral-600 shrink-0 select-none">
          [{formatTime(entry.created_at)}]
        </span>
        <span className={`shrink-0 font-semibold ${LEVEL_COLORS[level] || 'text-neutral-500'}`}>
          {LEVEL_LABELS[level] || level.toUpperCase().slice(0, 3)}
        </span>
        {entry.origin && (
          <span className="text-purple-400 shrink-0">{entry.origin}</span>
        )}
        {entry.event && (
          <span className="text-cyan-400 shrink-0">{entry.event}</span>
        )}
        <span className="text-neutral-300">
          {entry.origin || entry.event ? '— ' : ''}{entry.message}
        </span>
        {hasData && (
          <span className="text-neutral-600 shrink-0 select-none">
            {expanded ? '\u25BC' : '\u25B6'}
          </span>
        )}
      </div>
      {expanded && entry.data && (
        <pre className="ml-8 my-1 px-2 py-1.5 bg-neutral-900 border border-neutral-800 rounded text-[10px] text-neutral-400 overflow-x-auto whitespace-pre-wrap">
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
