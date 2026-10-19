import type { PendingNotification } from '../../../shared/types/ipc.types'

/**
 * Studio windows in daemon mode (#149 step 1, docs/design/agent-windows.md).
 *
 * The main window and every agent window is its own client session on the
 * daemon (D5). The session objects live in index.ts; this file holds the
 * parts that decide between windows and need no Electron:
 *
 * - `NoticeOwners`: the one window that shows a pending approval or question
 *   as a notice (in-app toast, OS notification click). The focused window
 *   that shows the agent, else the main window. Decided once, when the
 *   request arrives, and kept until it is answered: a notice is never shown
 *   in two windows and never moves between them.
 */

/**
 * The header main/index.ts puts on every `adf-file://` request (a
 * webRequest hook, which knows the webContents): the daemon-mode handler
 * serves the file from that window's agent.
 */
export const ADF_WINDOW_HEADER = 'X-ADF-Window'

/** One window as the notice rule sees it. `filePath`: the agent it shows (its session's current file). */
export interface WindowView {
  /** The window's webContents id. */
  id: number
  main: boolean
  focused: boolean
  filePath: string | null
}

/** The window that shows the notice of a request for `filePath`, or null when there is no window. */
export function noticeWindow(filePath: string, windows: readonly WindowView[], samePath: (a: string | null, b: string | null) => boolean): number | null {
  const focused = windows.find((w) => w.focused && samePath(w.filePath, filePath))
  if (focused) return focused.id
  const main = windows.find((w) => w.main)
  if (main) return main.id
  // No main window (macOS keeps Studio open without one): a window that shows the agent.
  return windows.find((w) => samePath(w.filePath, filePath))?.id ?? null
}

export class NoticeOwners {
  /** Notification id → webContents id of the window that shows it. */
  private readonly owners = new Map<string, number>()

  constructor(private readonly samePath: (a: string | null, b: string | null) => boolean) {}

  /**
   * One approvals snapshot: requests not seen before get their window,
   * answered ones are forgotten. Run before the native notifier reads
   * `owner` for the same snapshot.
   */
  assign(pending: readonly PendingNotification[], windows: readonly WindowView[]): void {
    const live = new Set(pending.map((n) => n.id))
    for (const id of [...this.owners.keys()]) if (!live.has(id)) this.owners.delete(id)
    for (const n of pending) {
      if (this.owners.has(n.id)) continue
      const id = noticeWindow(n.filePath, windows, this.samePath)
      if (id !== null) this.owners.set(n.id, id)
    }
  }

  owner(notificationId: string): number | null {
    return this.owners.get(notificationId) ?? null
  }

  /** The notification ids whose notice `windowId` shows. */
  idsFor(windowId: number): string[] {
    return [...this.owners].filter(([, owner]) => owner === windowId).map(([id]) => id)
  }

  /** A window closed: its requests are the main window's now (still pending, still in its list). */
  moveTo(fromWindowId: number, toWindowId: number | null): void {
    for (const [id, owner] of [...this.owners]) {
      if (owner !== fromWindowId) continue
      if (toWindowId === null) this.owners.delete(id)
      else this.owners.set(id, toWindowId)
    }
  }
}
