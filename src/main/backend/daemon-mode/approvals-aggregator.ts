import type { NotificationsSnapshot } from '../../../shared/types/ipc.types'
import type { RuntimeId } from '../../../shared/runtime-tag'

/**
 * One approvals list across the runtime set (docs/design/multi-runtime.md
 * §6.1). Each runtime's main-window stream feeds its snapshot here; the
 * merged snapshot lists pending entries oldest first and history newest
 * first, each entry of a runtime other than the primary with its
 * `runtimeId`. The primary runtime's entries carry no `runtimeId`.
 *
 * With the primary runtime only (or every other runtime's list empty), the
 * merged snapshot IS the primary's snapshot object: the push is byte for
 * byte what it was before (§4.6).
 */
export class ApprovalsAggregator {
  private readonly snapshots = new Map<RuntimeId, NotificationsSnapshot>()

  constructor(private readonly primary: RuntimeId) {}

  /** A runtime's latest snapshot. */
  set(runtimeId: RuntimeId, snapshot: NotificationsSnapshot): void {
    this.snapshots.set(runtimeId, snapshot)
  }

  /** A runtime left the set: its entries go. Answers whether it had any. */
  delete(runtimeId: RuntimeId): boolean {
    const had = this.snapshots.get(runtimeId)
    this.snapshots.delete(runtimeId)
    return !!had && ((had.pending?.length ?? 0) > 0 || (had.history?.length ?? 0) > 0)
  }

  /** The runtimes that have sent a snapshot. */
  runtimes(): RuntimeId[] {
    return [...this.snapshots.keys()]
  }

  merged(): NotificationsSnapshot {
    const primary = this.snapshots.get(this.primary)
    const others = [...this.snapshots].filter(([id, s]) => id !== this.primary && ((s.pending?.length ?? 0) > 0 || (s.history?.length ?? 0) > 0))
    if (others.length === 0) return primary ?? { pending: [], history: [] }
    const pending = [...(primary?.pending ?? [])]
    const history = [...(primary?.history ?? [])]
    for (const [runtimeId, s] of others) {
      for (const p of s.pending ?? []) pending.push({ ...p, runtimeId })
      for (const h of s.history ?? []) history.push({ ...h, runtimeId })
    }
    // Stable sorts: entries of one runtime keep that runtime's order.
    pending.sort((a, b) => a.requestedAt - b.requestedAt)
    history.sort((a, b) => b.resolvedAt - a.resolvedAt)
    return { pending, history }
  }
}
