import { create } from 'zustand'
import type { NotificationsSnapshot, PendingNotification, ResolvedNotification } from '../../shared/types/ipc.types'

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
  resolvePendingApproval?: (
    filePath: string,
    approvalId: string,
    approved: boolean,
    feedback?: string
  ) => Promise<{ success: boolean; error?: string }>
  onPendingNotificationsChanged?: (callback: (snapshot: NotificationsSnapshot) => void) => () => void
}

export function approvalsBridge(): NotificationsBridge | undefined {
  return (globalThis as { adfApi?: NotificationsBridge }).adfApi
}

/** A transient "agent X needs you" notice, shown when that agent is not open. */
export interface ApprovalToast {
  /** Same id as the notification it announces — answering it kills the toast. */
  id: string
  kind: PendingNotification['kind']
  agentName: string
  loop: string
  /** Tool name for an approval, question preview for an ask. */
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
   * pending ones. Session-scoped and main-process-owned, exactly like
   * `approvals`: every push replaces it.
   */
  history: ResolvedNotification[]
  /** Title-bar dropdown visibility. */
  panelOpen: boolean
  /** Corner notices for requests that arrived while their agent was off-screen. */
  toasts: ApprovalToast[]

  setSnapshot: (snapshot: NotificationsSnapshot) => void
  setPanelOpen: (open: boolean) => void
  togglePanel: () => void
  pushToast: (toast: ApprovalToast) => void
  dismissToast: (id: string) => void
  reset: () => void
}

export const useApprovalsStore = create<ApprovalsStoreState>((set) => ({
  approvals: [],
  history: [],
  panelOpen: false,
  toasts: [],

  setSnapshot: ({ pending, history }) =>
    set((state) => ({
      approvals: pending,
      history,
      // A toast for a request that no longer exists is a lie — drop it the
      // moment the snapshot says it was answered (from any surface).
      toasts: state.toasts.filter((t) => pending.some((a) => a.id === t.id))
      // The panel is NOT closed when the last pending row goes: answering the
      // final approval while looking at the list would yank the list out from
      // under the click, and the row you just answered is precisely what you
      // want to see (greyed, with its outcome) immediately afterwards.
    })),

  setPanelOpen: (panelOpen) => set({ panelOpen }),
  togglePanel: () => set((state) => ({ panelOpen: !state.panelOpen })),

  pushToast: (toast) =>
    set((state) =>
      state.toasts.some((t) => t.id === toast.id)
        ? state
        // At most three on screen; the oldest falls off.
        : { toasts: [...state.toasts, toast].slice(-3) }
    ),

  dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),

  reset: () => set({ approvals: [], history: [], panelOpen: false, toasts: [] })
}))
