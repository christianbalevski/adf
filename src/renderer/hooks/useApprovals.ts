import { useEffect, useRef } from 'react'
import { approvalsBridge, useApprovalsStore } from '../stores/approvals.store'
import { useDocumentStore } from '../stores/document.store'
import { useMeshGraphStore, type PendingInteraction } from '../stores/mesh-graph.store'
import type { PendingNotification } from '../../shared/types/ipc.types'

/** How long a "waiting on you" toast stays up before it dismisses itself. */
const TOAST_TTL_MS = 8_000

/**
 * Project the hub snapshot onto the fleet map's per-agent pending badge.
 *
 * The map shows at most one alert per agent (an executor is blocked on one
 * request at a time from the user's point of view), so the oldest wins — the
 * snapshot is already oldest-first.
 *
 * This replaces the map's previous ad-hoc feed: a 5s MESH_PENDING_INTERACTIONS
 * poll plus live agent events. That feed had a real hole — the background-agent
 * event stream forwards `ask_request`/`tool_approval_request` but NOT their
 * resolutions, so a background agent's badge stuck around until the next poll.
 * One source of truth removes the hole and the poll.
 */
function toPendingInteractions(notifications: PendingNotification[]): Record<string, PendingInteraction> {
  const byAgent: Record<string, PendingInteraction> = {}
  for (const n of notifications) {
    if (byAgent[n.filePath]) continue
    byAgent[n.filePath] = {
      type: n.kind,
      requestId: n.requestId,
      question: n.question,
      toolName: n.toolName,
      input: n.input,
      reason: n.reason,
      protection: n.protection,
      canAlwaysApprove: n.canAlwaysApprove,
      alwaysApproveBlockedReason: n.alwaysApproveBlockedReason
    }
  }
  return byAgent
}

/**
 * Feeds the approvals store — and the fleet map's pending badge — from the
 * main process's global ApprovalHub.
 *
 * One initial pull (so a reloaded window paints a correct badge immediately)
 * plus a full-snapshot push on every change. Mount once, at the app root.
 *
 * Toasts are derived here rather than in the store because "is this agent
 * on-screen?" is renderer state the main process does not have: a request for
 * the OPEN agent already renders its in-chat card, so announcing it again would
 * be noise — only off-screen agents (including every backgrounded one, which
 * has no in-chat card anywhere) get a toast.
 */
export function useApprovalEvents() {
  const seenIds = useRef<Set<string>>(new Set())
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  useEffect(() => {
    const api = approvalsBridge()
    if (!api?.onPendingNotificationsChanged) return

    // Captured for the unmount cleanup — refs are stable, .current is not.
    const pendingTimers = timers.current

    const commit = (notifications: PendingNotification[]): void => {
      useApprovalsStore.getState().setApprovals(notifications)
      useMeshGraphStore.getState().setAllPendingInteractions(toPendingInteractions(notifications))
    }

    const apply = (notifications: PendingNotification[]): void => {
      const store = useApprovalsStore.getState()
      const openFilePath = useDocumentStore.getState().filePath
      const live = new Set(notifications.map((n) => n.id))

      for (const n of notifications) {
        if (seenIds.current.has(n.id)) continue
        seenIds.current.add(n.id)
        if (n.filePath === openFilePath) continue
        store.pushToast({
          id: n.id,
          kind: n.kind,
          agentName: n.agentName,
          loop: n.loop,
          detail: n.kind === 'ask' ? n.preview : (n.toolName ?? 'tool'),
          filePath: n.filePath
        })
        const timer = setTimeout(() => {
          pendingTimers.delete(n.id)
          useApprovalsStore.getState().dismissToast(n.id)
        }, TOAST_TTL_MS)
        pendingTimers.set(n.id, timer)
      }

      // Forget answered ids so the set does not grow across a long session.
      for (const id of seenIds.current) {
        if (!live.has(id)) seenIds.current.delete(id)
      }

      commit(notifications)
    }

    const unsubscribe = api.onPendingNotificationsChanged(apply)
    void api.listPendingNotifications?.().then((notifications) => {
      // First paint only seeds the list — a pull is not an "arrival", so it
      // must not fire toasts for requests that were already pending.
      for (const n of notifications ?? []) seenIds.current.add(n.id)
      commit(notifications ?? [])
    }).catch(() => { /* hub unavailable — badge stays at 0 */ })

    return () => {
      unsubscribe?.()
      for (const timer of pendingTimers.values()) clearTimeout(timer)
      pendingTimers.clear()
    }
  }, [])
}
