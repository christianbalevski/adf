import { create } from 'zustand'
import type { NotificationHistoryPage, NotificationsSnapshot, PendingNotification, ResolvedNotification } from '../../shared/types/ipc.types'
import { noticeKey } from '../../shared/runtime-tag'

/**
 * The notifications slice of the preload bridge.
 *
 * Reached through `globalThis` rather than `window.adfApi` because the web
 * tsconfig does not include the preload's Window augmentation — every direct
 * `window.adfApi` reference in the renderer is unchecked there. One
 * locally-typed accessor gives this feature real types instead.
 */
interface NotificationsBridge {
  listPendingNotifications?: () => Promise<NotificationsSnapshot>
  clearNotificationHistory?: () => Promise<{ success: boolean; error?: string }>
  getNotificationHistory?: (before?: number) => Promise<NotificationHistoryPage>
  resolvePendingApproval?: (
    filePath: string,
    approvalId: string,
    approved: boolean,
    feedback?: string
  ) => Promise<{ success: boolean; error?: string }>
  /** The raw tool input of one pending approval (the snapshot carries none). */
  getApprovalInput?: (filePath: string, approvalId: string) => Promise<unknown>
  onPendingNotificationsChanged?: (callback: (snapshot: NotificationsSnapshot) => void) => () => void
  setBadgeCount?: (count: number) => Promise<void>
}

/**
 * `runtimeId`: the surface of a request's runtime (docs/design/multi-runtime.md
 * §6.1), so its answer goes there; omitted, This computer's. With This
 * computer only, that is window.adfApi itself.
 */
export function approvalsBridge(runtimeId?: string): NotificationsBridge | undefined {
  const api = (globalThis as { adfApi?: NotificationsBridge & { runtimeId?: string; runtime?: (id: string) => NotificationsBridge } }).adfApi
  const target = runtimeId || 'local'
  const own = typeof api?.runtimeId === 'string' && api.runtimeId ? api.runtimeId : 'local'
  if (own === target || typeof api?.runtime !== 'function') return api
  return api.runtime(target)
}

/** Where the bell remembers when its panel was last opened (unread 'finished' rows). Shared by every window of this origin. */
export const NOTIFICATIONS_SEEN_KEY = 'adf.notifications.seenAt'

function readSeenAt(): number {
  try {
    const value = Number(globalThis.localStorage?.getItem(NOTIFICATIONS_SEEN_KEY))
    return Number.isFinite(value) ? value : 0
  } catch { return 0 }
}

/** 'finished' rows newer than the last time the panel was opened. */
export function unreadFinished(history: ResolvedNotification[], seenAt: number): number {
  return history.reduce((n, entry) => n + (entry.kind === 'finished' && entry.resolvedAt > seenAt ? 1 : 0), 0)
}

/** A transient "agent X needs you" / "agent X finished" notice, shown when that agent is not open. */
export interface ApprovalToast {
  /** The key of the notification it announces (noticeKey: its id, with its runtime for one other than This computer) — answering it kills the toast. */
  id: string
  /** The request's runtime; omitted for This computer. */
  runtimeId?: string
  kind: PendingNotification['kind']
  agentName: string
  loop: string
  /** Tool name for an approval, question preview for an ask, reply preview for a finished turn. */
  detail: string
  filePath: string
}

interface ApprovalsStoreState {
  /**
   * The main process's full snapshot, oldest first. Never merged: every push
   * replaces this array, so an answered request cannot linger.
   */
  approvals: PendingNotification[]
  /**
   * Recently resolved rows, newest first — the greyed-out tail under the
   * pending ones. This is the bounded live tail; older rows are fetched
   * a page at a time from their runtime.
   */
  history: ResolvedNotification[]
  historyPage: (NotificationHistoryPage & { runtimeId: string }) | null
  historyLoading: boolean
  historyError: string | null
  /** Title-bar dropdown visibility. */
  panelOpen: boolean
  /** Corner notices for requests that arrived while their agent was off-screen. */
  toasts: ApprovalToast[]
  /** When the panel was last opened (ms); 'finished' rows after it are unread. */
  seenAt: number
  /** The previous seenAt, captured when the panel opens for row highlighting. */
  openedSeenAt: number

  setSnapshot: (snapshot: NotificationsSnapshot) => void
  browseHistory: (runtimeId: string, before?: number) => Promise<void>
  showRecentHistory: () => void
  setPanelOpen: (open: boolean) => void
  togglePanel: () => void
  pushToast: (toast: ApprovalToast) => void
  dismissToast: (id: string) => void
  /** Another window marked them read (storage event). */
  syncSeen: () => void
  reset: () => void
}

let historyRequest = 0

export const useApprovalsStore = create<ApprovalsStoreState>((set, get) => ({
  approvals: [],
  history: [],
  historyPage: null,
  historyLoading: false,
  historyError: null,
  panelOpen: false,
  toasts: [],
  seenAt: readSeenAt(),
  openedSeenAt: 0,

  setSnapshot: ({ pending, history }) =>
    set((state) => {
      const changed = JSON.stringify(state.history) !== JSON.stringify(history)
      if (changed) historyRequest++
      return {
        approvals: pending,
        history: changed ? history : state.history,
        // Only actual history changes invalidate browsing. Pending-only pushes
        // keep the page; a clear/new receipt also invalidates in-flight reads.
        ...(changed ? { historyPage: null, historyLoading: false, historyError: null } : {}),
        // A toast for a request that no longer exists is a lie — drop it the
        // moment the snapshot says it was answered (from any surface).
        // A 'finished' notice answers nothing: it stays until its timer or a click.
        toasts: state.toasts.filter((t) => t.kind === 'finished' || pending.some((a) => noticeKey(a.runtimeId, a.id) === t.id))
        // The panel is NOT closed when the last pending row goes: answering the
        // final approval while looking at the list would yank the list out from
        // under the click, and the row you just answered is precisely what you
        // want to see (greyed, with its outcome) immediately afterwards.
      }
    }),

  browseHistory: async (runtimeId, before) => {
    const request = ++historyRequest
    set({ historyLoading: true, historyError: null })
    try {
      const read = approvalsBridge(runtimeId)?.getNotificationHistory
      if (!read) throw new Error('This runtime does not support browsing notification history.')
      const page = await read(before)
      if (request === historyRequest) set({ historyPage: { ...page, runtimeId }, historyLoading: false })
    } catch (error) {
      if (request === historyRequest) set({ historyLoading: false, historyError: error instanceof Error ? error.message : 'Could not load notification history.' })
    }
  },

  showRecentHistory: () => {
    historyRequest++
    set({ historyPage: null, historyLoading: false, historyError: null })
  },

  setPanelOpen: (panelOpen) => set((state) => {
    if (state.panelOpen === panelOpen) return state
    if (!panelOpen) return { panelOpen }
    // Opening marks the current rows read in every window. A remote runtime
    // may timestamp its rows ahead of the local clock.
    const seenAt = Math.max(Date.now(), ...state.history.map((entry) => entry.resolvedAt))
    try { globalThis.localStorage?.setItem(NOTIFICATIONS_SEEN_KEY, String(seenAt)) } catch { /* storage unavailable: this window only */ }
    return { panelOpen, seenAt, openedSeenAt: state.seenAt }
  }),
  togglePanel: () => get().setPanelOpen(!get().panelOpen),

  syncSeen: () => set({ seenAt: readSeenAt() }),

  pushToast: (toast) =>
    set((state) =>
      state.toasts.some((t) => t.id === toast.id)
        ? state
        // At most three on screen; the oldest falls off.
        : { toasts: [...state.toasts, toast].slice(-3) }
    ),

  dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),

  reset: () => {
    historyRequest++
    set({ approvals: [], history: [], historyPage: null, historyLoading: false, historyError: null, panelOpen: false, toasts: [], seenAt: readSeenAt(), openedSeenAt: 0 })
  }
}))
