/**
 * Calendar-day key in the user's LOCAL time zone, `YYYY-MM-DD`.
 *
 * The token-usage ledger is bucketed and read by this key on both sides of
 * the IPC boundary. `toISOString().slice(0, 10)` would give the UTC day,
 * which drifts from what the renderer's "today" / "last N days" mean for
 * anyone not on UTC.
 */
export function localDateKey(d: Date = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
