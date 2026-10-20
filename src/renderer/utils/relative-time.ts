/**
 * Short relative times for list rows ("just now", "5m ago", "3h ago",
 * "2d ago", then the date), with the absolute time for a tooltip.
 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export function relativeTime(timestamp: number, now: number): string {
  if (!Number.isFinite(timestamp)) return ''
  const diff = now - timestamp
  if (diff < MINUTE) return 'just now'
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}d ago`
  const d = new Date(timestamp)
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  return d.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' })
}

/** "Updated 12s ago" granularity, for panel freshness stamps. */
export function ageInSeconds(timestamp: number, now: number): string {
  const diff = Math.max(0, now - timestamp)
  if (diff < MINUTE) return `${Math.floor(diff / 1000)}s ago`
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`
  return `${Math.floor(diff / HOUR)}h ago`
}

export function absoluteTime(timestamp: number): string {
  if (!Number.isFinite(timestamp)) return ''
  return new Date(timestamp).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

/** Timestamps as the backends send them: epoch ms, or an ISO / SQLite datetime string (UTC). */
export function toEpochMs(value: string | number | null | undefined): number {
  if (typeof value === 'number') return value
  if (!value) return NaN
  // SQLite's CURRENT_TIMESTAMP ("2026-10-20 12:00:00") is UTC without a zone.
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value) ? `${value.replace(' ', 'T')}Z` : value
  return Date.parse(iso)
}
