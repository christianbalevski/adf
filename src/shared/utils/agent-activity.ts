/**
 * Pure helpers behind the overview's activity sections, shared by the main
 * process (AgentVitalsService.getAgentActivity) and the renderer (merging the
 * live log into the recent list). No IO.
 */

import type { ActivityEvent } from '../types/agent-vitals.types'
import { localDateKey } from './date-key'

/** Lines in "Recent activity". */
export const RECENT_LIMIT = 8
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

/**
 * Fold runs of consecutive tool calls with the same name into one line
 * ("fs_write ×4"). Input and output are newest first; a group keeps its
 * newest time and seq.
 */
export function groupToolRuns(events: ActivityEvent[]): ActivityEvent[] {
  const out: ActivityEvent[] = []
  for (const e of events) {
    const prev = out[out.length - 1]
    if (prev && e.kind === 'tool' && prev.kind === 'tool' && prev.label === e.label) {
      prev.count = (prev.count ?? 1) + (e.count ?? 1)
      continue
    }
    out.push({ ...e })
  }
  return out
}

/** Merge event lists newest first (stable on ties), group tool runs, keep `limit`. */
export function mergeRecent(lists: ActivityEvent[][], limit = RECENT_LIMIT): ActivityEvent[] {
  const all = lists.flat().map((e, i) => ({ e, i }))
  all.sort((a, b) => b.e.at - a.e.at || a.i - b.i)
  return groupToolRuns(all.map((x) => x.e)).slice(0, limit)
}
