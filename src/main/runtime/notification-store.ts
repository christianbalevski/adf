import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import type { NotificationsSnapshot, ResolvedNotification } from '../../shared/types/ipc.types'
import { readJsonOrQuarantine, replaceFileStrict } from '../utils/atomic-json'

// An ordinary runtime-local file, outside the ADF format. Persist only the
// fields needed to display history, never tool inputs or executor callbacks.
const notice = z.object({
  id: z.string(),
  kind: z.enum(['approval', 'ask']),
  requestId: z.string(),
  filePath: z.string(),
  agentName: z.string(),
  loop: z.string(),
  toolName: z.string().optional(),
  preview: z.string(),
  question: z.string().optional(),
  requestedAt: z.number().min(-8.64e15).max(8.64e15),
})
/** Keep historical receipts identical before and after a restart. */
export function notificationReceipt(entry: ResolvedNotification): ResolvedNotification {
  return { ...notice.parse(entry), outcome: entry.outcome, resolvedAt: entry.resolvedAt }
}

const storedSnapshot = z.object({
  pending: z.array(notice),
  history: z.array(notice.extend({
    outcome: z.enum(['approved', 'rejected', 'answered', 'expired', 'completed']),
    resolvedAt: z.number().min(-8.64e15).max(8.64e15),
  })),
})

export class NotificationStore {
  constructor(private readonly path: string) {}

  load(): ResolvedNotification[] {
    let raw: string
    try { raw = readFileSync(this.path, 'utf8') } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      // An unreadable existing file is not an empty history to overwrite.
      throw err
    }
    let data: unknown
    try { data = JSON.parse(raw) } catch {
      const result = readJsonOrQuarantine(this.path)
      if (result.corruptUnpreserved || !result.quarantinedTo) throw new Error('Could not preserve damaged notification history')
      console.warn('[Notifications] Damaged history preserved at', result.quarantinedTo)
      return []
    }
    const saved = storedSnapshot.parse(data)
    // Executor callbacks do not survive a process restart. Keep the receipt,
    // but never restore an actionable approval without its executor.
    const resolvedAt = Date.now()
    return [
      ...saved.pending.map((entry): ResolvedNotification => ({ ...entry, outcome: 'expired', resolvedAt })),
      ...saved.history,
    ].sort((a, b) => b.resolvedAt - a.resolvedAt)
  }

  save(snapshot: NotificationsSnapshot): void {
    mkdirSync(dirname(this.path), { recursive: true })
    replaceFileStrict(this.path, JSON.stringify(storedSnapshot.parse(snapshot)))
  }
}
