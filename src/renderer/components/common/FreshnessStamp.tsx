import { useEffect, useState } from 'react'
import { absoluteTime, ageInSeconds } from '../../utils/relative-time'

/**
 * "Updated 12s ago" and a refresh button, for a panel that shows a fetch
 * rather than following a push: the age says how stale the view may be, and
 * the button is how to make it current.
 */
export function FreshnessStamp({ at, onRefresh, className = '' }: {
  /** When the shown data was fetched; null before the first fetch lands. */
  at: number | null
  onRefresh: () => void
  className?: string
}) {
  const [now, setNow] = useState(() => Date.now())
  const age = at === null ? 0 : now - at
  // Seconds tick while the age reads in seconds, then every half minute.
  const tick = age < 60_000 ? 1000 : 30_000
  useEffect(() => {
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), tick)
    return () => clearInterval(timer)
  }, [at, tick])

  return (
    <span className={`inline-flex items-center gap-1 text-[10px] text-[var(--adf-ui-text-subtle)] shrink-0 ${className}`}>
      {at !== null && (
        <span className="tabular-nums" title={absoluteTime(at)}>Updated {ageInSeconds(at, now)}</span>
      )}
      <button
        type="button"
        onClick={onRefresh}
        title="Refresh"
        aria-label="Refresh"
        className="w-5 h-5 flex items-center justify-center rounded hover:bg-neutral-200 dark:hover:bg-neutral-700 hover:text-neutral-700 dark:hover:text-neutral-200"
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="23 4 23 10 17 10" />
          <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
        </svg>
      </button>
    </span>
  )
}
