import type { ResolvedNotification } from '../types/ipc.types'
import { noticeKey } from '../runtime-tag'

/**
 * How old a 'finished' row may be and still be announced. Generous, for a
 * remote runtime whose clock runs behind; a late-connecting runtime's older
 * history stays quiet.
 */
export const FINISHED_FRESH_MS = 120_000

/** Mark every 'finished' row of `history` seen without announcing it (a first snapshot). */
export function seedFinished(history: ResolvedNotification[], seen: Set<string>): void {
  for (const n of history) if (n.kind === 'finished') seen.add(noticeKey(n.runtimeId, n.id))
}

/**
 * The 'finished' rows of a history page that are news: not in `seen` and
 * recent. `seen` is updated and pruned to the page (history is newest first
 * and bounded). Returned oldest first. Shared by the OS notifier (main) and
 * the in-app notices (renderer), so both announce the same rows.
 */
export function newFinished(history: ResolvedNotification[], seen: Set<string>, now: number): ResolvedNotification[] {
  const out: ResolvedNotification[] = []
  const page = new Set<string>()
  for (const n of history) {
    if (n.kind !== 'finished') continue
    const key = noticeKey(n.runtimeId, n.id)
    page.add(key)
    if (seen.has(key)) continue
    seen.add(key)
    if (now - n.resolvedAt <= FINISHED_FRESH_MS) out.push(n)
  }
  for (const key of seen) if (!page.has(key)) seen.delete(key)
  return out.reverse()
}
