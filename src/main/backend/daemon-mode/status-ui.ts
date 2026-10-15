import { BrowserWindow, dialog, Notification, shell } from 'electron'
import { buildApplicationMenu } from '../../menu'
import { daemonExitSentence, type ConnectionState, type DaemonConnection, type DaemonExit } from './connection'

/**
 * The visible "backend not connected" state (tracker W2-C). The renderer
 * does not know which backend it talks to, so Studio main shows it:
 *
 * - every transition is logged, and the menu is rebuilt on every one;
 * - while Studio waits for the daemon at boot (§8.2 step 5) the Help menu
 *   and Settings → Backend name what it waits for and, past a moment, the
 *   taskbar shows an indeterminate progress bar; waiting on another
 *   daemon process ("Waiting for the ADF daemon (pid N)…") also raises one
 *   OS notification;
 * - the Help menu gains a status line and "Reconnect to the ADF Daemon"
 *   while the connection is down (menu.ts DaemonMenuOptions);
 * - a disconnect that lasts past a short grace period raises a dialog, with
 *   Reconnect now / Open daemon log: never two at once, and not again within
 *   a cooldown;
 * - after such a dialog, the reconnect raises an OS notification so the user
 *   learns it is back;
 * - local mode, the daemon's process is gone (`exited`, not a dropped
 *   connection): the status line says so; a daemon Studio starts again by
 *   itself gets a notification, any other exit a dialog at once, with
 *   "Start the ADF Daemon", whatever the cooldown (each exit is a new
 *   outage);
 * - a connector that failed (no daemon, refused attach) raises one dialog
 *   with the reason and the recovery override.
 *
 * Calls made while disconnected fail with the client's "Cannot reach daemon"
 * error, which the renderer shows where the call came from.
 */

const DISCONNECT_GRACE_MS = 3_000
/** No second disconnect dialog within this long of the last one. */
export const DISCONNECT_DIALOG_COOLDOWN_MS = 60_000
/** Boot waits shorter than this show no progress bar. */
const BOOT_PROGRESS_DELAY_MS = 1_000

type Log = Pick<Console, 'log' | 'warn' | 'error'>

/** The Help menu's status line; null while connected. */
export function connectionProblem(state: ConnectionState, baseUrl: string | null): string | null {
  switch (state.state) {
    case 'connected':
      return null
    case 'connecting':
      return `ADF daemon: ${state.progress ?? 'connecting…'}`
    case 'disconnected':
      if (state.exited) return `ADF daemon: exited (pid ${state.exited.pid}); agents are stopped${state.exited.respawning ? ', starting it again' : ''}`
      return `ADF daemon: not connected${baseUrl ? ` (${baseUrl})` : ''}, retrying`
    case 'failed':
      return 'ADF daemon: not connected'
  }
}

export class ConnectionStatusUi {
  private graceTimer: ReturnType<typeof setTimeout> | null = null
  private dialogShownThisEpisode = false
  private dialogOpen = false
  private lastDialogAt = 0
  private failureShown = false
  private wasDisconnected = false
  private disposed = false
  private progressTimer: ReturnType<typeof setTimeout> | null = null
  private progressShown = false
  private waitNoticeShown = false
  /** The daemon exit last shown (each markExited is a new one). */
  private shownExit: DaemonExit | null = null
  private readonly unsubscribe: () => void

  constructor(
    private readonly connection: DaemonConnection,
    private readonly actions: {
      reconnect: () => void
      openLog: () => void
      recoveryHint: string
      useEmbeddedForSession?: () => void
      openBackendSettings?: () => void
      /** Studio is starting the daemon again (local mode): it announces the result itself. */
      reviving?: () => boolean
    },
    private readonly log: Log = console,
  ) {
    this.unsubscribe = connection.onState((state) => this.onState(state))
    if (connection.state.state === 'connecting') this.startBootProgress()
  }

  dispose(): void {
    this.disposed = true
    this.unsubscribe()
    if (this.graceTimer) clearTimeout(this.graceTimer)
    this.graceTimer = null
    this.stopBootProgress()
  }

  private startBootProgress(): void {
    if (this.progressTimer || this.progressShown) return
    this.progressTimer = setTimeout(() => {
      this.progressTimer = null
      if (this.connection.state.state !== 'connecting') return
      this.progressShown = true
      this.setProgress(2)
    }, BOOT_PROGRESS_DELAY_MS)
    this.progressTimer.unref?.()
  }

  private stopBootProgress(): void {
    if (this.progressTimer) { clearTimeout(this.progressTimer); this.progressTimer = null }
    if (this.progressShown) { this.progressShown = false; this.setProgress(-1) }
  }

  /** 2 = indeterminate, -1 = none (BrowserWindow.setProgressBar). */
  private setProgress(value: number): void {
    for (const win of BrowserWindow.getAllWindows()) {
      try { if (!win.isDestroyed()) win.setProgressBar(value) } catch { /* window going away */ }
    }
  }

  private onState(state: ConnectionState): void {
    if (this.disposed) return
    buildApplicationMenu()
    if (state.state === 'connecting') {
      this.startBootProgress()
      if (state.progress?.startsWith('Waiting for the ADF daemon') && !this.waitNoticeShown) {
        this.waitNoticeShown = true
        this.notify('ADF Studio', `${state.progress} Studio connects when it answers.`)
      }
      return
    }
    this.stopBootProgress()
    if (state.state === 'disconnected' && state.exited) {
      this.wasDisconnected = true
      if (state.exited === this.shownExit) return
      this.shownExit = state.exited
      if (this.graceTimer) { clearTimeout(this.graceTimer); this.graceTimer = null }
      this.dialogShownThisEpisode = true
      if (state.exited.respawning) {
        this.notify('ADF Studio', `${daemonExitSentence(state.exited)} Studio is starting it again.`)
        return
      }
      // A new outage: shown whatever the cooldown, but never two dialogs at once.
      if (!this.dialogOpen) void this.showExitedDialog(state.exited)
      return
    }
    if (state.state === 'disconnected') {
      this.wasDisconnected = true
      this.log.warn(`[Backend] Lost the connection to the ADF daemon${state.error ? `: ${state.error}` : ''}; reconnecting`)
      if (!this.graceTimer && !this.dialogShownThisEpisode) {
        this.graceTimer = setTimeout(() => {
          this.graceTimer = null
          if (this.connection.state.state !== 'disconnected') return
          // One dialog at a time, and not again right after the last one (a flapping daemon).
          if (this.dialogOpen || Date.now() - this.lastDialogAt < DISCONNECT_DIALOG_COOLDOWN_MS) return
          void this.showDisconnectedDialog()
        }, DISCONNECT_GRACE_MS)
        this.graceTimer.unref?.()
      }
      return
    }
    if (state.state === 'connected') {
      if (this.graceTimer) { clearTimeout(this.graceTimer); this.graceTimer = null }
      if (this.wasDisconnected) {
        this.log.log('[Backend] Reconnected to the ADF daemon')
        // Studio started the daemon again: that path sends its own notice (with what it restarted).
        if (this.dialogShownThisEpisode && !this.actions.reviving?.()) this.notify('ADF Studio', 'Reconnected to the ADF daemon.')
      }
      this.wasDisconnected = false
      this.dialogShownThisEpisode = false
      this.shownExit = null
      return
    }
    if (state.state === 'failed' && !this.failureShown) {
      this.failureShown = true
      void this.showFailedDialog(state.message)
    }
  }

  private async showDisconnectedDialog(): Promise<void> {
    this.dialogShownThisEpisode = true
    this.dialogOpen = true
    this.lastDialogAt = Date.now()
    const url = this.connection.baseUrl
    const logFile = this.connection.logFile
    const buttons = ['Reconnect Now', ...(logFile ? ['Open Daemon Log'] : []), 'Dismiss']
    try {
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        title: 'ADF daemon not connected',
        message: 'Studio lost its connection to the ADF daemon.',
        detail: `${url ? `Daemon: ${url}\n` : ''}Studio keeps trying to reconnect. Until it does, actions that need the backend fail.${logFile ? `\nDaemon log: ${logFile}` : ''}`,
        buttons,
        defaultId: 0,
        cancelId: buttons.length - 1,
        noLink: true,
      })
      if (buttons[response] === 'Reconnect Now') this.actions.reconnect()
      else if (buttons[response] === 'Open Daemon Log') this.actions.openLog()
    } catch (err) {
      this.log.warn('[Backend] Could not show the disconnected dialog:', err)
    } finally {
      this.dialogOpen = false
    }
  }

  /** Local mode, the daemon's process is gone and Studio does not start it again by itself: Start the ADF Daemon (the connector's revive), the log. */
  private async showExitedDialog(exit: DaemonExit): Promise<void> {
    this.dialogOpen = true
    this.lastDialogAt = Date.now()
    const logFile = this.connection.logFile
    // Only a connector that can start a daemon offers it (local mode); otherwise the stream keeps trying.
    const start = this.connection.canRevive
    const buttons = [...(start ? ['Start the ADF Daemon'] : []), ...(logFile ? ['Open Daemon Log'] : []), 'Dismiss']
    try {
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        title: 'ADF daemon exited',
        message: daemonExitSentence(exit),
        detail: `${exit.detail ? `${exit.detail}

` : ''}${start ? 'Start the ADF Daemon starts it from Studio and starts the agents that were running again (Help → Reconnect to the ADF Daemon does the same later). ' : 'Studio reconnects when a daemon answers again. '}Until then, actions that need the backend fail.${logFile ? `
Daemon log: ${logFile}` : ''}`,
        buttons,
        defaultId: 0,
        cancelId: buttons.length - 1,
        noLink: true,
      })
      if (buttons[response] === 'Start the ADF Daemon') this.actions.reconnect()
      else if (buttons[response] === 'Open Daemon Log') this.actions.openLog()
    } catch (err) {
      this.log.warn('[Backend] Could not show the daemon exit dialog:', err)
    } finally {
      this.dialogOpen = false
    }
  }

  /** A failed launch: Reconnect (Studio restarts and tries again), embedded for this session (local) or Settings → Backend (remote), the log. */
  private async showFailedDialog(message: string): Promise<void> {
    const logFile = this.connection.logFile
    const embedded = this.actions.useEmbeddedForSession
    const settings = this.actions.openBackendSettings
    const buttons = ['Reconnect', ...(embedded ? ['Use Embedded for This Session'] : []), ...(settings ? ['Open Settings → Backend'] : []), ...(logFile ? ['Open Daemon Log'] : []), 'OK']
    try {
      const { response } = await dialog.showMessageBox({
        type: 'error',
        title: 'ADF daemon not available',
        message: 'Studio could not connect to an ADF daemon.',
        detail: `${message}\n\nReconnect restarts Studio and tries again (Help → Reconnect to the ADF Daemon does the same later).${embedded ? ' Use Embedded for This Session restarts Studio running agents itself for this launch only; the saved mode stays.' : ''}\n\n${this.actions.recoveryHint}`,
        buttons,
        defaultId: buttons.length - 1,
        cancelId: buttons.length - 1,
        noLink: true,
      })
      if (buttons[response] === 'Reconnect') this.actions.reconnect()
      else if (buttons[response] === 'Use Embedded for This Session') embedded?.()
      else if (buttons[response] === 'Open Settings → Backend') settings?.()
      else if (buttons[response] === 'Open Daemon Log') this.actions.openLog()
    } catch (err) {
      this.log.warn('[Backend] Could not show the connection failure dialog:', err)
    }
  }

  /** A daemon notice (client stream `daemon_orphan_hold`), as a native notification. */
  notice(body: string): void {
    this.notify('ADF Studio', body)
  }

  private notify(title: string, body: string): void {
    try {
      if (!Notification.isSupported()) return
      new Notification({ title, body }).show()
    } catch (err) {
      this.log.warn('[Backend] Could not show a notification:', err)
    }
  }
}

/** "Open daemon log": the local daemon's log file in the OS default viewer. */
export async function openDaemonLog(logFile: string | null, log: Log = console): Promise<void> {
  if (!logFile) {
    log.warn('[Backend] The daemon runs on another machine; its log is there (adf daemon logs)')
    return
  }
  log.log(`[Backend] Opening the daemon log ${logFile}`)
  const error = await shell.openPath(logFile)
  if (error) {
    log.warn(`[Backend] Could not open the daemon log: ${error}`)
    await dialog.showMessageBox({ type: 'warning', message: 'Could not open the daemon log.', detail: `${logFile}\n\n${error}`, buttons: ['OK'] }).catch(() => {})
  }
}
