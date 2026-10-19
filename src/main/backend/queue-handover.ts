import type { QueueHandoverEntry } from '../../shared/types/ipc.types'

/**
 * Queued messages of agent windows (docs/design/agent-windows.md §5).
 *
 * A message the owner types while a loop is mid-turn waits in the window's
 * queue until the turn ends. An agent window mirrors its queues here on
 * every change (WINDOW_QUEUE_SYNC). When it closes, what it still held is
 * handed to the main window (QUEUE_HANDOVER_READY, then QUEUE_HANDOVER_TAKE),
 * whose queue sends it when the loop's turn ends, as for any agent in the
 * background. Nothing is dropped: a handover waits here until the main
 * window takes it (macOS without a main window: until one opens).
 */
export class QueueHandover {
  /** webContents id → the window's queues as it last reported them. */
  private readonly mirrors = new Map<number, QueueHandoverEntry[]>()
  private pending: QueueHandoverEntry[] = []

  /** WINDOW_QUEUE_SYNC: the window's whole queue state now; malformed entries are ignored. */
  mirror(windowId: number, entries: unknown): void {
    const valid = Array.isArray(entries) ? entries.filter(isEntry).filter((e) => e.messages.length > 0) : []
    if (valid.length > 0) this.mirrors.set(windowId, valid)
    else this.mirrors.delete(windowId)
  }

  /** The window closed: true when it left messages for the main window. */
  closed(windowId: number): boolean {
    const left = this.mirrors.get(windowId)
    this.mirrors.delete(windowId)
    if (!left?.length) return false
    this.pending.push(...left)
    return true
  }

  /** QUEUE_HANDOVER_TAKE: everything handed over so far, once. */
  take(): QueueHandoverEntry[] {
    const out = this.pending
    this.pending = []
    return out
  }

  get waiting(): number {
    return this.pending.length
  }
}

function isEntry(value: unknown): value is QueueHandoverEntry {
  const e = value as Partial<QueueHandoverEntry> | null
  return !!e && typeof e.filePath === 'string' && !!e.filePath && typeof e.loop === 'string' && Array.isArray(e.messages)
    && e.messages.every((m) => !!m && typeof m.id === 'string' && typeof m.text === 'string')
}
