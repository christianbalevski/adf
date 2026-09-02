import { useEffect, useRef } from 'react'
import { approvalsBridge, useApprovalsStore } from '../stores/approvals.store'
import { useDocumentStore } from '../stores/document.store'
import { useMeshGraphStore, type PendingInteraction } from '../stores/mesh-graph.store'
import { useJumpToAgent } from './useJumpToAgent'
import type { NotificationsSnapshot, PendingNotification } from '../../shared/types/ipc.types'

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
  // The initial pull is awaited, so a live push can land first. Once it has,
  // the pull's result is stale and must not overwrite it (B12).
  const hasAppliedPush = useRef(false)

  useEffect(() => {
    const api = approvalsBridge()
    if (!api?.onPendingNotificationsChanged) return

    // Captured for the unmount cleanup — refs are stable, .current is not.
    const pendingTimers = timers.current

    // Auto-expiry that respects modal dialogs (B14): a <dialog> opened with
    // showModal() puts a top layer above the toast, so it is both unclickable
    // and hidden behind the backdrop. Letting it expire there loses it silently.
    // While any modal dialog is open, re-arm instead of dismissing; once it
    // closes the toast is reachable again and the normal TTL applies.
    const scheduleExpiry = (id: string): void => {
      const timer = setTimeout(() => {
        if (typeof document !== 'undefined' && document.querySelector('dialog[open]')) {
          scheduleExpiry(id)
          return
        }
        pendingTimers.delete(id)
        useApprovalsStore.getState().dismissToast(id)
      }, TOAST_TTL_MS)
      pendingTimers.set(id, timer)
    }

    const commit = (snapshot: NotificationsSnapshot): void => {
      useApprovalsStore.getState().setSnapshot(snapshot)
      // The map badges what is still BLOCKING — history is menu-only.
      useMeshGraphStore.getState().setAllPendingInteractions(toPendingInteractions(snapshot.pending))
    }

    const apply = (snapshot: NotificationsSnapshot): void => {
      hasAppliedPush.current = true
      const notifications = snapshot.pending
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
        scheduleExpiry(n.id)
      }

      // Forget answered ids so the set does not grow across a long session.
      for (const id of seenIds.current) {
        if (!live.has(id)) seenIds.current.delete(id)
      }

      commit(snapshot)
    }

    const unsubscribe = api.onPendingNotificationsChanged(apply)
    void api.listPendingNotifications?.().then((snapshot) => {
      // A push already applied a (newer) snapshot while this pull was in flight
      // — the pull is stale, so drop it rather than clobber the fresher state.
      if (hasAppliedPush.current) return
      const seeded: NotificationsSnapshot = {
        pending: snapshot?.pending ?? [],
        history: snapshot?.history ?? []
      }
      // First paint only seeds the list — a pull is not an "arrival", so it
      // must not fire toasts for requests that were already pending.
      for (const n of seeded.pending) seenIds.current.add(n.id)
      commit(seeded)
    }).catch(() => { /* hub unavailable — badge stays at 0 */ })

    return () => {
      unsubscribe?.()
      for (const timer of pendingTimers.values()) clearTimeout(timer)
      pendingTimers.clear()
    }
  }, [])
}

/**
 * Handle a clicked OS notification.
 *
 * Main has already restored and focused the window by the time this fires; all
 * that is left is pointing the UI at the thing the user clicked. A per-request
 * toast carries the agent's path and jumps exactly where the bell's row click
 * jumps (same `useJumpToAgent`, so the two can never diverge); a coalesced
 * summary stands for several agents at once, so the only honest destination is
 * the bell panel itself.
 *
 * Mount once, at the app root, next to `useApprovalEvents`.
 */
export function useApprovalDeepLink(): void {
  const jumpToAgent = useJumpToAgent()

  useEffect(() => {
    const api = (globalThis as {
      adfApi?: {
        onApprovalReveal?: (
          cb: (payload: { filePath?: string; notificationId?: string }) => void
        ) => () => void
      }
    }).adfApi
    if (!api?.onApprovalReveal) return

    return api.onApprovalReveal(({ filePath }) => {
      if (filePath) {
        jumpToAgent(filePath)
        return
      }
      useApprovalsStore.getState().setPanelOpen(true)
    })
  }, [jumpToAgent])
}
