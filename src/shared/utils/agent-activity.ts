/**
 * Pure helpers behind the overview's activity sparkline
 * (AgentVitalsService.getAgentActivity). No IO.
 */

import { localDateKey } from './date-key'

/** Days in the activity sparkline. */
export const ACTIVITY_DAYS = 14

/** `days` local date keys ending today, oldest first. */
export function localDayKeys(now: number, days = ACTIVITY_DAYS): string[] {
  const d = new Date(now)
  const out: string[] = []
  for (let i = days - 1; i >= 0; i--) {
    out.push(localDateKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - i)))
  }
  return out
}

/** Local midnight that starts the `days`-day window ending today (ms epoch). */
export function windowStartMs(now: number, days = ACTIVITY_DAYS): number {
  const d = new Date(now)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - (days - 1)).getTime()
}

/** Count timestamps per local day over the window; outside the window is dropped. Oldest first. */
export function bucketByLocalDay(timestamps: number[], now: number, days = ACTIVITY_DAYS): Array<{ date: string; count: number }> {
  const keys = localDayKeys(now, days)
  const counts = new Map(keys.map((k) => [k, 0]))
  for (const t of timestamps) {
    if (!Number.isFinite(t)) continue
    const k = localDateKey(new Date(t))
    const n = counts.get(k)
    if (n !== undefined) counts.set(k, n + 1)
  }
  return keys.map((date) => ({ date, count: counts.get(date) ?? 0 }))
}
