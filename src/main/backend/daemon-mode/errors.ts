/**
 * Errors daemon-mode handlers throw. An invoke handler that throws makes the
 * renderer's `ipcRenderer.invoke` reject with the message, which the existing
 * error UI shows; nothing is swallowed.
 */

export const DAEMON_MODE_UNAVAILABLE = 'daemon_mode_unavailable'
export const BACKEND_NOT_CONNECTED = 'backend_not_connected'

/**
 * A channel, or one step of it, whose daemon route or producer has not landed
 * yet. `workstream` names the tracker workstream that adds it
 * (docs/design/daemon-backend-tracker.md §4), so the message says exactly
 * what is missing. Never a fallback to embedded state.
 */
export class DaemonModeUnavailableError extends Error {
  readonly code = DAEMON_MODE_UNAVAILABLE
  constructor(readonly what: string, readonly workstream: string, readonly detail?: string) {
    super(`${what} is not available in daemon mode yet: ${workstream}${detail ? ` (${detail})` : ''}`)
    this.name = 'DaemonModeUnavailableError'
  }
}

/** Studio could not reach the daemon (not started, refused, exited). */
export class BackendNotConnectedError extends Error {
  readonly code = BACKEND_NOT_CONNECTED
  constructor(message: string) {
    super(message)
    this.name = 'BackendNotConnectedError'
  }
}
