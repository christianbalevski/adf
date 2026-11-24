import { useEffect, useRef } from 'react'
import { approvalsBridge, NOTIFICATIONS_SEEN_KEY, useApprovalsStore } from '../stores/approvals.store'
import { useAppStore } from '../stores/app.store'
import { useDocumentStore } from '../stores/document.store'
import { useAgentStore, MAIN_LOOP } from '../stores/agent.store'
import { useMeshGraphStore, type PendingInteraction } from '../stores/mesh-graph.store'
import { useJumpToAgent } from './useJumpToAgent'
import type { NotificationsSnapshot, PendingNotification, ResolvedNotification } from '../../shared/types/ipc.types'
import { noticeKey } from '../../shared/runtime-tag'
import { newFinished, seedFinished } from '../../shared/utils/finished-notices'
import { agentKey } from '../../shared/types/agent-ref'
import { apiFor } from '../utils/runtime-api'

/** The open agent as a ref key (agentKey), compared with each request's: refs of two runtimes never match. */
function openRefKey(): string | null {
  const { filePath, runtimeId } = useDocumentStore.getState()
  return filePath ? agentKey({ runtimeId, filePath }) : null
}

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
export function toPendingInteractions(notifications: PendingNotification[]): Record<string, PendingInteraction> {
  const byAgent: Record<string, PendingInteraction> = {}
  for (const n of notifications) {
    // By agent key: the path on This computer, runtime and path on another runtime (multi-runtime.md §5.2).
    const key = agentKey({ runtimeId: n.runtimeId, filePath: n.filePath })
    if (byAgent[key]) continue
    // `questions` is optional only in the shared notification shape; every ask carries it.
    byAgent[key] = n.kind === 'ask' ? { type: 'ask', requestId: n.requestId, questions: n.questions ?? [], loop: n.loop } : {
      type: 'approval',
      requestId: n.requestId,
      approvalId: n.id,
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
 * The requests of one snapshot that get an in-app toast here: new ones (`seen`
 * is updated, answered ids leave it), not for the loop this window shows (its
 * chat shows the request; another loop's tab of the open agent does not), and,
 * with agent windows open, only those main names for this window (`notify`,
 * docs/design/agent-windows.md).
 */
export function arrivalsToAnnounce(snapshot: NotificationsSnapshot, seen: Set<string>, openFilePath: string | null, viewedLoop: string = MAIN_LOOP): PendingNotification[] {
  const mine = snapshot.notify ? new Set(snapshot.notify) : null
  const out: PendingNotification[] = []
  for (const n of snapshot.pending) {
    // Keys across runtimes (noticeKey): equal ids on two runtimes are two requests (multi-runtime.md §6.1).
    const key = noticeKey(n.runtimeId, n.id)
    if (seen.has(key)) continue
    seen.add(key)
    // `openFilePath` is the open agent's key: its path on This computer.
    if (agentKey({ runtimeId: n.runtimeId, filePath: n.filePath }) === openFilePath && (n.loop ?? MAIN_LOOP) === viewedLoop) continue
    if (mine && !mine.has(key)) continue
    out.push(n)
  }
  // Forget answered ids so the set does not grow across a long session.
  const live = new Set(snapshot.pending.map((n) => noticeKey(n.runtimeId, n.id)))
  for (const id of seen) if (!live.has(id)) seen.delete(id)
  return out
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
  const seenFinished = useRef<Set<string>>(new Set())
  // The first snapshot (pull or push) only seeds: its rows are not arrivals.
  const finishedSeeded = useRef(false)
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  // The initial pull is awaited, so a live push can land first. Once it has,
  // the pull's result is stale and must not overwrite it (B12).
  const hasAppliedPush = useRef(false)

  // The Dock icon shows the bell's number: the pending count, nothing else.
  // Sync the Dock badge and the open agent's visibility at mount and when
  // their inputs change.
  useEffect(() => {
    const setBadge = approvalsBridge()?.setBadgeCount
    const pushBadge = (count: number): void => { setBadge?.(count).catch(() => { /* no dock to badge */ }) }
    pushBadge(useApprovalsStore.getState().approvals.length)
    const offBadge = useApprovalsStore.subscribe((state, prev) => {
      if (state.approvals.length !== prev.approvals.length) pushBadge(state.approvals.length)
    })

    // Home leaves the agent open but off screen. Publish the final visibility
    // once after synchronous navigation updates to both stores.
    let active = true
    let queued = false
    const syncVisibility = () => {
      if (queued) return
      queued = true
      queueMicrotask(() => {
        queued = false
        if (!active) return
        const { filePath, runtimeId } = useDocumentStore.getState()
        if (!filePath) return
        void apiFor(runtimeId)?.setFileVisible?.(!useAppStore.getState().showHome)?.catch(() => { /* runtime unreachable */ })
      })
    }
    const offHome = useAppStore.subscribe((state, prev) => {
      if (state.showHome !== prev.showHome) syncVisibility()
    })
    const offDocument = useDocumentStore.subscribe((state, prev) => {
      if (state.filePath !== prev.filePath || state.runtimeId !== prev.runtimeId) syncVisibility()
    })
    syncVisibility()
    return () => {
      active = false
      offBadge()
      offHome()
      offDocument()
    }
  }, [])

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
      const store = useApprovalsStore.getState()
      const app = useAppStore.getState()
      const openKey = app.showHome ? null : openRefKey()
      const toast = (n: PendingNotification | ResolvedNotification, detail: string): void => {
        const key = noticeKey(n.runtimeId, n.id)
        store.pushToast({
          id: key,
          ...(n.runtimeId ? { runtimeId: n.runtimeId } : {}),
          kind: n.kind,
          agentName: n.agentName,
          loop: n.loop,
          detail,
          filePath: n.filePath
        })
        scheduleExpiry(key)
      }
      // Computed even with notices off, so turning them on later does not replay old arrivals.
      const arrivals = arrivalsToAnnounce(snapshot, seenIds.current, openKey, useAgentStore.getState().viewedLoop)
      // The runtime never records a row for an agent a client has open (ApprovalHub.announce).
      const finished = finishedSeeded.current ? newFinished(snapshot.history ?? [], seenFinished.current, Date.now()) : []
      if (!finishedSeeded.current) {
        finishedSeeded.current = true
        seedFinished(snapshot.history ?? [], seenFinished.current)
      }
      if (app.inAppNotifications) {
        for (const n of arrivals) toast(n, n.kind === 'ask' ? n.preview : (n.toolName ?? 'tool'))
        if (app.finishedNotificationsEnabled) for (const n of finished) toast(n, n.preview)
      }

      commit(snapshot)
    }

    const unsubscribe = api.onPendingNotificationsChanged(apply)
    // The panel opened in another window marks its 'finished' rows read here too.
    const onStorage = (event: StorageEvent): void => {
      if (event.key === NOTIFICATIONS_SEEN_KEY) useApprovalsStore.getState().syncSeen()
    }
    globalThis.addEventListener?.('storage', onStorage)
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
      for (const n of seeded.pending) seenIds.current.add(noticeKey(n.runtimeId, n.id))
      finishedSeeded.current = true
      seedFinished(seeded.history, seenFinished.current)
      commit(seeded)
    }).catch(() => { /* hub unavailable — badge stays at 0 */ })

    return () => {
      unsubscribe?.()
      globalThis.removeEventListener?.('storage', onStorage)
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
    type RevealPayload = { filePath?: string; notificationId?: string; runtimeId?: string }
    const api = (globalThis as {
      adfApi?: {
        onApprovalReveal?: (cb: (payload: RevealPayload) => void) => () => void
        getPendingApprovalReveal?: () => Promise<RevealPayload | null>
      }
    }).adfApi
    if (!api?.onApprovalReveal) return

    const reveal = ({ filePath, runtimeId }: RevealPayload): void => {
      if (filePath) {
        jumpToAgent(filePath, runtimeId)
        return
      }
      useApprovalsStore.getState().setPanelOpen(true)
    }
    const unsubscribe = api.onApprovalReveal(reveal)
    // A click that recreated the window was queued while this renderer loaded
    // and may have been pushed before the listener above existed.
    void api.getPendingApprovalReveal?.().then((pending) => { if (pending) reveal(pending) }).catch(() => {})
    return unsubscribe
  }, [jumpToAgent])
}
