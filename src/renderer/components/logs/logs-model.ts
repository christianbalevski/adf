import type { AdfLogEntry, LogLevel } from '../../../shared/types/adf-v02.types'

/** Rows fetched on open and per "Load older". */
export const LOGS_PAGE = 500
/** Live appends trim the oldest rows past this (or past what was loaded, if more). */
export const LOGS_MAX_IN_MEMORY = 2000

export interface LogFilter {
  level: LogLevel | 'all'
  origin: string
  /** Case-insensitive; matched against message, origin, event, target and data. */
  text: string
}

export function filterLogs(logs: readonly AdfLogEntry[], filter: LogFilter): AdfLogEntry[] {
  const text = filter.text.trim().toLowerCase()
  if (filter.level === 'all' && filter.origin === 'all' && !text) return logs as AdfLogEntry[]
  return logs.filter((l) => {
    if (filter.level !== 'all' && l.level !== filter.level) return false
    if (filter.origin !== 'all' && (l.origin ?? '') !== filter.origin) return false
    if (text) {
      const hay = `${l.message}\u0000${l.origin ?? ''}\u0000${l.event ?? ''}\u0000${l.target ?? ''}\u0000${l.data ?? ''}`.toLowerCase()
      if (!hay.includes(text)) return false
    }
    return true
  })
}

/**
 * Append a poll's entries (oldest first) to the chronological list. Entries at
 * or below the newest id already held are dropped (the first load and a poll
 * can overlap). Past `cap` the oldest go; `added` is how many were new.
 */
export function appendLogs(prev: readonly AdfLogEntry[], incoming: readonly AdfLogEntry[], cap: number): { logs: AdfLogEntry[]; added: number } {
  const lastId = prev.length > 0 ? prev[prev.length - 1].id : 0
  const fresh = incoming.filter((e) => e.id > lastId)
  if (fresh.length === 0) return { logs: prev as AdfLogEntry[], added: 0 }
  const combined = [...prev, ...fresh]
  return { logs: combined.length > cap ? combined.slice(combined.length - cap) : combined, added: fresh.length }
}

/** The footer line: "Showing 500 of 1,234". */
export function showingLabel(shown: number, total: number): string {
  return `Showing ${shown.toLocaleString()} of ${Math.max(total, shown).toLocaleString()}`
}
