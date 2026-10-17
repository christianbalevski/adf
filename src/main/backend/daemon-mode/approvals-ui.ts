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
 * APPROVALS_GET_PENDING_REVEAL.
 */

type ApprovalRevealPayload = { filePath?: string; notificationId?: string }

export interface ApprovalsUiDeps {
  /** Read per notification: the client key nativeNotificationsEnabled. */
  notificationsEnabled: () => boolean
  menuBarEnabled: () => boolean
  /** Running agents and their display states (the event bridge's view). */
  agents: () => ReadonlyArray<{ filePath: string; state: AgentState; activeLoops?: number }>
  /** The open file and its display state, shown as the foreground agent. */
  foreground: () => { filePath: string; state: AgentState } | null
  /** Today's token totals (cached from the daemon; read synchronously when the menu opens). */
  tokensToday: () => { input: number; output: number }
  showMainWindow?: () => BrowserWindow | null
  openFile?: (filePath: string) => void
  log?: Pick<Console, 'warn'>
}

export class ApprovalsUi {
  private pendingReveal: ApprovalRevealPayload | null = null
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

  /** The agent files with an approval or a question waiting for an answer now. */
  pendingFilePaths(): string[] {
    return [...new Set(this.pending.map((p) => p.filePath))]
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

  /** APPROVALS_GET_PENDING_REVEAL. */
  takePendingReveal(): ApprovalRevealPayload | null {
    const payload = this.pendingReveal
    this.pendingReveal = null
    return payload
  }

  dispose(): void {
    try { this.menuBar?.dispose() } catch { /* best effort */ }
    this.menuBar = null
  }

  private menuBarSnapshot(): MenuBarSnapshot {
    const agents = new Map<string, MenuBarAgent>()
    for (const a of this.deps.agents()) {
      agents.set(a.filePath, { filePath: a.filePath, name: basename(a.filePath, '.adf'), state: a.state, activeLoops: a.activeLoops })
    }
    const fg = this.deps.foreground()
    if (fg) agents.set(fg.filePath, { filePath: fg.filePath, name: basename(fg.filePath, '.adf'), state: fg.state, foreground: true })
    return { surface: 'ADF Studio', pending: this.pending, agents: [...agents.values()], tokensToday: this.deps.tokensToday() }
  }

  private onMenuBarAction(action: MenuBarAction): void {
    switch (action.type) {
      case 'reveal':
        this.sendReveal({ filePath: action.notification.filePath, notificationId: action.notification.id })
        return
      case 'open-agent':
        this.deps.openFile?.(action.filePath)
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
    const win = this.focusMainWindow() ?? this.deps.showMainWindow?.() ?? null
    if (!win || win.isDestroyed()) return
    if (!win.webContents.isLoading()) {
      send(win)
      return
    }
    this.pendingReveal = payload
    win.webContents.once('did-finish-load', () => send(win))
  }

  private platform(): NativeNotifierPlatform {
    return {
      isSupported: () => {
        try { return Notification.isSupported() } catch { return false }
      },
      isEnabled: () => this.deps.notificationsEnabled(),
      isWindowFocused: () => BrowserWindow.getFocusedWindow() !== null,
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
      reveal: (entry) => this.sendReveal({ filePath: entry.filePath, notificationId: entry.id }),
      openPanel: () => this.sendReveal({}),
    }
  }
}
