import { create } from 'zustand'
import type { PendingNotification } from '../../shared/types/ipc.types'

/**
 * The notifications slice of the preload bridge.
 *
 * Reached through `globalThis` rather than `window.adfApi` because the web
 * tsconfig does not include the preload's Window augmentation — every direct
 * `window.adfApi` reference in the renderer is unchecked there. One
 * locally-typed accessor gives this feature real types instead.
 */
interface NotificationsBridge {
  listPendingNotifications?: () => Promise<PendingNotification[]>
  resolvePendingApproval?: (
    filePath: string,
    approvalId: string,
    approved: boolean,
    feedback?: string
  ) => Promise<{ success: boolean; error?: string }>
  onPendingNotificationsChanged?: (callback: (notifications: PendingNotification[]) => void) => () => void
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
  /** Title-bar dropdown visibility. */
  panelOpen: boolean
  /** Corner notices for requests that arrived while their agent was off-screen. */
  toasts: ApprovalToast[]

  setApprovals: (approvals: PendingNotification[]) => void
  setPanelOpen: (open: boolean) => void
  togglePanel: () => void
  pushToast: (toast: ApprovalToast) => void
  dismissToast: (id: string) => void
  reset: () => void
}

export const useApprovalsStore = create<ApprovalsStoreState>((set) => ({
  approvals: [],
  panelOpen: false,
  toasts: [],

  setApprovals: (approvals) =>
    set((state) => ({
      approvals,
      // A toast for a request that no longer exists is a lie — drop it the
      // moment the snapshot says it was answered (from any surface).
      toasts: state.toasts.filter((t) => approvals.some((a) => a.id === t.id)),
      // Nothing left to decide: close the dropdown rather than leave an empty
      // panel floating over the app.
      panelOpen: approvals.length === 0 ? false : state.panelOpen
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

  reset: () => set({ approvals: [], panelOpen: false, toasts: [] })
}))
