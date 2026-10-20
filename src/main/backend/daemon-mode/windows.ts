import type { PendingNotification } from '../../../shared/types/ipc.types'
import { noticeKey, type RuntimeId } from '../../../shared/runtime-tag'
// One source for main/index.ts and the real-Electron test (tests/electron/adf-file-window-header.cjs).
import ADF_FILE_WINDOW from './adf-file-window.json'

export { ADF_FILE_WINDOW }

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
export const ADF_WINDOW_HEADER = ADF_FILE_WINDOW.windowHeader

/**
 * One window as the notice rule sees it. `filePath`: the agent it shows (its
 * session's current file); `runtimeId`: that agent's runtime, omitted for the
 * primary runtime (multi-runtime.md §6.1: the rule compares agent refs).
 */
export interface WindowView {
  /** The window's webContents id. */
  id: number
  main: boolean
  focused: boolean
  filePath: string | null
  runtimeId?: RuntimeId
}

/** Path equality under a runtime's path rule (`runtimeId` omitted: the primary runtime). */
export type RuntimeSamePath = (a: string | null, b: string | null, runtimeId?: RuntimeId) => boolean

/** The window that shows the notice of a request for `filePath` on `runtimeId`, or null when there is no window. */
export function noticeWindow(filePath: string, windows: readonly WindowView[], samePath: RuntimeSamePath, runtimeId?: RuntimeId): number | null {
  const shows = (w: WindowView): boolean => w.runtimeId === runtimeId && samePath(w.filePath, filePath, runtimeId)
  const focused = windows.find((w) => w.focused && shows(w))
  if (focused) return focused.id
  const main = windows.find((w) => w.main)
  if (main) return main.id
  // No main window (macOS keeps Studio open without one): a window that shows the agent.
  return windows.find(shows)?.id ?? null
}

/**
 * The notice window of each pending request, keyed by `noticeKey(runtimeId,
 * id)`: the plain notification id for the primary runtime, so equal ids on
 * two runtimes stay distinct.
 */
export class NoticeOwners {
  /** Notice key → webContents id of the window that shows it. */
  private readonly owners = new Map<string, number>()

  constructor(private readonly samePath: RuntimeSamePath) {}

  /**
   * One approvals snapshot: requests not seen before get their window,
   * answered ones are forgotten. Run before the native notifier reads
   * `owner` for the same snapshot.
   */
  assign(pending: readonly PendingNotification[], windows: readonly WindowView[]): void {
    const live = new Set(pending.map((n) => noticeKey(n.runtimeId, n.id)))
    for (const key of [...this.owners.keys()]) if (!live.has(key)) this.owners.delete(key)
    for (const n of pending) {
      const key = noticeKey(n.runtimeId, n.id)
      if (this.owners.has(key)) continue
      const id = noticeWindow(n.filePath, windows, this.samePath, n.runtimeId)
      if (id !== null) this.owners.set(key, id)
    }
  }

  /** The window of a notice key (`noticeKey(runtimeId, id)`). */
  owner(key: string): number | null {
    return this.owners.get(key) ?? null
  }

  /** The notice keys whose notice `windowId` shows. */
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
