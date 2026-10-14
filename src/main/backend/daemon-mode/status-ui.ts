import { dialog, Notification, shell } from 'electron'
import { buildApplicationMenu } from '../../menu'
import type { ConnectionState, DaemonConnection } from './connection'

/**
 * The visible "backend not connected" state (tracker W2-C). The renderer
 * does not know which backend it talks to, so Studio main shows it:
 *
 * - every transition is logged;
 * - the Help menu gains a status line and "Reconnect to the ADF Daemon"
 *   while the connection is down (menu.ts DaemonMenuOptions);
 * - a disconnect that lasts past a short grace period raises one dialog per
 *   episode, with Reconnect now / Open daemon log;
 * - after such a dialog, the reconnect raises an OS notification so the user
 *   learns it is back;
 * - a connector that failed (no daemon, refused attach) raises one dialog
 *   with the reason and the recovery override.
 *
 * Calls made while disconnected fail with the client's "Cannot reach daemon"
 * error, which the renderer shows where the call came from.
 */

const DISCONNECT_GRACE_MS = 3_000

type Log = Pick<Console, 'log' | 'warn' | 'error'>

/** The Help menu's status line; null while connected or still connecting at boot. */
export function connectionProblem(state: ConnectionState, baseUrl: string | null): string | null {
  switch (state.state) {
    case 'connected':
    case 'connecting':
      return null
    case 'disconnected':
      return `ADF daemon: not connected${baseUrl ? ` (${baseUrl})` : ''}, retrying`
    case 'failed':
      return 'ADF daemon: not connected'
  }
}

export class ConnectionStatusUi {
  private graceTimer: ReturnType<typeof setTimeout> | null = null
  private dialogShownThisEpisode = false
  private failureShown = false
  private wasDisconnected = false
  private disposed = false
  private lastProblem: string | null = null
  private readonly unsubscribe: () => void

  constructor(
    private readonly connection: DaemonConnection,
    private readonly actions: { reconnect: () => void; openLog: () => void; recoveryHint: string },
    private readonly log: Log = console,
  ) {
    this.unsubscribe = connection.onState((state) => this.onState(state))
  }

  dispose(): void {
    this.disposed = true
    this.unsubscribe()
    if (this.graceTimer) clearTimeout(this.graceTimer)
    this.graceTimer = null
  }

  private onState(state: ConnectionState): void {
    if (this.disposed) return
    const problem = connectionProblem(state, this.connection.baseUrl)
    if (problem !== this.lastProblem) {
      this.lastProblem = problem
      buildApplicationMenu()
    }
    if (state.state === 'disconnected') {
      this.wasDisconnected = true
      this.log.warn(`[Backend] Lost the connection to the ADF daemon${state.error ? `: ${state.error}` : ''}; reconnecting`)
      if (!this.graceTimer && !this.dialogShownThisEpisode) {
        this.graceTimer = setTimeout(() => {
          this.graceTimer = null
          if (this.connection.state.state === 'disconnected') void this.showDisconnectedDialog()
        }, DISCONNECT_GRACE_MS)
        this.graceTimer.unref?.()
      }
      return
    }
    if (state.state === 'connected') {
      if (this.graceTimer) { clearTimeout(this.graceTimer); this.graceTimer = null }
      if (this.wasDisconnected) {
        this.log.log('[Backend] Reconnected to the ADF daemon')
        if (this.dialogShownThisEpisode) this.notify('ADF Studio', 'Reconnected to the ADF daemon.')
      }
      this.wasDisconnected = false
      this.dialogShownThisEpisode = false
      return
    }
    if (state.state === 'failed' && !this.failureShown) {
      this.failureShown = true
      void this.showFailedDialog(state.message)
    }
  }

  private async showDisconnectedDialog(): Promise<void> {
    this.dialogShownThisEpisode = true
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
    }
  }

  private async showFailedDialog(message: string): Promise<void> {
    const logFile = this.connection.logFile
    const buttons = [...(logFile ? ['Open Daemon Log'] : []), 'OK']
    try {
      const { response } = await dialog.showMessageBox({
        type: 'error',
        title: 'ADF daemon not available',
        message: 'Studio could not connect to an ADF daemon.',
        detail: `${message}\n\n${this.actions.recoveryHint}`,
        buttons,
        defaultId: buttons.length - 1,
        noLink: true,
      })
      if (buttons[response] === 'Open Daemon Log') this.actions.openLog()
    } catch (err) {
      this.log.warn('[Backend] Could not show the connection failure dialog:', err)
    }
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
