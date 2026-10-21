import { basename, join } from 'node:path'
import { app, BrowserWindow, Notification } from 'electron'
import { IPC } from '../../../shared/constants/ipc-channels'
import type { AgentState, NotificationsSnapshot, PendingNotification } from '../../../shared/types/ipc.types'
import { NativeNotifier, type NativeNotifierPlatform, type NativeToastHandle } from '../../runtime/native-notifier'
import { MenuBarController } from '../../tray/menu-bar'
import type { MenuBarAction, MenuBarAgent, MenuBarSnapshot } from '../../tray/menu-bar-model'

/**
 * Native notifier, macOS menu bar icon and approvals reveal in daemon mode,
 * fed from the client stream's `approvals` snapshots instead of the
 * in-process ApprovalHub. The Electron halves are the same classes embedded
 * mode uses (native-notifier.ts, tray/menu-bar.ts); this file supplies their
 * platform hooks, as ipc/index.ts does for embedded.
 *
 * Reveals (a toast or menu bar click) queue for a loading renderer, exactly
 * like embedded `sendReveal`: pushed once the page has loaded, and pulled by
 * APPROVALS_GET_PENDING_REVEAL. The queue is per window (agent windows).
 */

/** `runtimeId`: the asking runtime, omitted for the primary runtime (multi-runtime.md §6.1). */
type ApprovalRevealPayload = { filePath?: string; notificationId?: string; runtimeId?: string }

export interface ApprovalsUiDeps {
  /** Read per notification: the client key nativeNotificationsEnabled. */
  notificationsEnabled: () => boolean
  menuBarEnabled: () => boolean
  /** Running agents and their display states (the event bridge's view); `runtimeId` for a runtime other than This computer. */
  agents: () => ReadonlyArray<{ filePath: string; state: AgentState; activeLoops?: number; runtimeId?: string }>
  /** The open file and its display state, shown as the foreground agent. */
  foreground: () => { filePath: string; state: AgentState; runtimeId?: string } | null
  /** Today's token totals (cached from the daemon; read synchronously when the menu opens). */
  tokensToday: () => { input: number; output: number }
  showMainWindow?: () => BrowserWindow | null
  openFile?: (filePath: string) => void
  /** Open `filePath` on another runtime than This computer, in the main window (multi-runtime.md §6.6). */
  openFileOn?: (runtimeId: string, filePath: string) => void
  /** The main window; default the first window. */
  mainWindow?: () => BrowserWindow | null
  /**
   * Agent windows (agent-windows.md): the agent window a reveal goes to (the
   * one that owns the request's notice, else one that shows the agent), or
   * null for the main window.
   */
  revealWindow?: (payload: ApprovalRevealPayload) => BrowserWindow | null
  /** Whether the window that shows `entry`'s notice has focus (no OS notification then). Default: any window. */
  noticeFocused?: (entry: PendingNotification) => boolean
  /** The name an OS notification gives the entry's runtime: only while Studio has more than one runtime (multi-runtime.md §6.1). */
  runtimeName?: (runtimeId: string | undefined) => string | null
  log?: Pick<Console, 'warn'>
}

/** A reveal of one request: its file, its id and, for a runtime other than the primary, its runtime (an untagged push either way). */
function revealOf(entry: Pick<PendingNotification, 'filePath' | 'id' | 'runtimeId'>): ApprovalRevealPayload {
  return { filePath: entry.filePath, notificationId: entry.id, ...(entry.runtimeId ? { runtimeId: entry.runtimeId } : {}) }
}

export class ApprovalsUi {
  /** webContents id → the reveal its loading page has not taken yet. */
  private readonly pendingReveals = new Map<number, ApprovalRevealPayload>()
  private pending: PendingNotification[] = []
  private readonly notifier: NativeNotifier
  private menuBar: MenuBarController | null = null
  private seeded = false

  constructor(private readonly deps: ApprovalsUiDeps) {
    this.notifier = new NativeNotifier(this.platform())
    // Menu bar: macOS only, as in embedded mode.
    if (process.platform === 'darwin') {
      this.menuBar = new MenuBarController({
        iconPath: join(__dirname, '../../resources/tray/trayTemplate.png'),
        getSnapshot: () => this.menuBarSnapshot(),
        onAction: (action) => this.onMenuBarAction(action),
      })
      this.menuBar.setEnabled(deps.menuBarEnabled())
    }
  }

  /** The agent files of one runtime (omitted: the primary) with an approval or a question waiting for an answer now. */
  pendingFilePaths(runtimeId?: string): string[] {
    return [...new Set(this.pending.filter((p) => p.runtimeId === runtimeId).map((p) => p.filePath))]
  }

  /**
   * One approvals snapshot. The first one is the state Studio found on
   * connecting: adopted without toasts (NativeNotifier.seed), as embedded
   * seeds from the hub before subscribing.
   */
  apply(snapshot: NotificationsSnapshot): void {
    this.pending = snapshot.pending ?? []
    if (!this.seeded) {
      this.seeded = true
      this.notifier.seed(this.pending)
    } else {
      this.notifier.apply(snapshot)
    }
    this.menuBar?.refresh()
  }

  /** Agents changed state: the icon's tooltip counts running agents. */
  refresh(): void {
    this.menuBar?.refresh()
  }

  setMenuBarEnabled(enabled: boolean): void {
    this.menuBar?.setEnabled(enabled)
  }

  /** APPROVALS_GET_PENDING_REVEAL, for the asking window (default: the main window). */
  takePendingReveal(windowId?: number): ApprovalRevealPayload | null {
    const id = windowId ?? this.mainWindow()?.webContents.id
    if (id === undefined) return null
    const payload = this.pendingReveals.get(id) ?? null
    this.pendingReveals.delete(id)
    return payload
  }

  dispose(): void {
    try { this.menuBar?.dispose() } catch { /* best effort */ }
    this.menuBar = null
  }

  private menuBarSnapshot(): MenuBarSnapshot {
    // Keyed by runtime and path: equal paths on two computers are two agents.
    const agents = new Map<string, MenuBarAgent>()
    const key = (a: { filePath: string; runtimeId?: string }): string => `${a.runtimeId ?? ''}\n${a.filePath}`
    const on = (a: { runtimeId?: string }) => (a.runtimeId ? { runtimeId: a.runtimeId } : {})
    for (const a of this.deps.agents()) {
      agents.set(key(a), { filePath: a.filePath, name: basename(a.filePath, '.adf'), state: a.state, activeLoops: a.activeLoops, ...on(a) })
    }
    const fg = this.deps.foreground()
    if (fg) agents.set(key(fg), { filePath: fg.filePath, name: basename(fg.filePath, '.adf'), state: fg.state, foreground: true, ...on(fg) })
    return { surface: 'ADF Studio', pending: this.pending, agents: [...agents.values()], tokensToday: this.deps.tokensToday() }
  }

  private onMenuBarAction(action: MenuBarAction): void {
    switch (action.type) {
      case 'reveal':
        this.sendReveal(revealOf(action.notification))
        return
      case 'open-agent':
        // Another runtime's path is on that computer: opened there, never as a path on This computer.
        if (action.runtimeId) this.deps.openFileOn?.(action.runtimeId, action.filePath)
        else this.deps.openFile?.(action.filePath)
        return
      case 'show':
        this.focusMainWindow() ?? this.deps.showMainWindow?.()
        return
      case 'settings': {
        const win = this.focusMainWindow() ?? this.deps.showMainWindow?.() ?? null
        if (!win || win.isDestroyed()) return
        const send = (): void => {
          if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(IPC.MENU_ACTION, 'open-settings')
        }
        if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send)
        else send()
        return
      }
      case 'quit':
        app.quit()
        return
    }
  }

  private mainWindow(): BrowserWindow | null {
    if (this.deps.mainWindow) return this.deps.mainWindow()
    const windows = BrowserWindow.getAllWindows()
    return windows.length > 0 ? windows[0] : null
  }

  /** A minimised window is restored first: focus() on it is a no-op on Windows. */
  private focusMainWindow(): BrowserWindow | null {
    const win = this.mainWindow()
    if (!win || win.isDestroyed()) return null
    if (win.isMinimized()) win.restore()
    if (!win.isVisible()) win.show()
    win.focus()
    app.focus?.({ steal: true })
    return win
  }

  private sendReveal(payload: ApprovalRevealPayload): void {
    const send = (win: BrowserWindow): void => {
      if (win.isDestroyed() || win.webContents.isDestroyed()) return
      try { win.webContents.send(IPC.APPROVALS_REVEAL, payload) } catch { /* window going away */ }
    }
    // An agent window that owns the notice or shows the agent (agent-windows.md); the main window is left as it is.
    const agentWin = this.deps.revealWindow?.(payload) ?? null
    let win: BrowserWindow | null
    if (agentWin && !agentWin.isDestroyed()) {
      if (agentWin.isMinimized()) agentWin.restore()
      agentWin.focus()
      app.focus?.({ steal: true })
      win = agentWin
    } else {
      win = this.focusMainWindow() ?? this.deps.showMainWindow?.() ?? null
    }
    if (!win || win.isDestroyed()) return
    if (!win.webContents.isLoading()) {
      send(win)
      return
    }
    const target = win
    this.pendingReveals.set(target.webContents.id, payload)
    target.webContents.once('did-finish-load', () => send(target))
  }

  private platform(): NativeNotifierPlatform {
    return {
      isSupported: () => {
        try { return Notification.isSupported() } catch { return false }
      },
      isEnabled: () => this.deps.notificationsEnabled(),
      isWindowFocused: (entry) => this.deps.noticeFocused ? this.deps.noticeFocused(entry) : BrowserWindow.getFocusedWindow() !== null,
      now: () => Date.now(),
      show: (request): NativeToastHandle | null => {
        try {
          const toast = new Notification({ title: request.title, body: request.body })
          toast.on('click', () => request.onClick())
          toast.show()
          return { close: () => toast.close() }
        } catch (err) {
          ;(this.deps.log ?? console).warn('[Notifications] Failed to show OS notification:', err)
          return null
        }
      },
      reveal: (entry) => this.sendReveal(revealOf(entry)),
      openPanel: () => this.sendReveal({}),
      runtimeName: (entry) => this.deps.runtimeName?.(entry.runtimeId) ?? null,
    }
  }
}
