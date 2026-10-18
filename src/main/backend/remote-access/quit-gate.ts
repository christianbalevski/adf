/**
 * Quitting Studio while other computers are connected (owner decision 5,
 * 2026-10-18; docs/design/remote-access.md §3.6): when the daemon would stop
 * with Studio and a paired computer is connected, Studio asks first, every
 * time: "N computers are connected. Keep the daemon running for them, or
 * stop it?" It remembers nothing: Keep Running applies to this quit only and
 * never changes the keep-running setting.
 *
 * Both quit paths go through `hold`: the app quit (menu, Cmd+Q, tray) and,
 * on Windows and Linux, closing the main window (which quits). A quit from a
 * signal, a session end, an update or a restart is not held.
 */

export type QuitAnswer = 'keep' | 'stop' | 'cancel'

export interface QuitGateDeps {
  /** The daemon stops when Studio quits (local mode, Studio started it, keep-running off). */
  daemonWouldStop: () => boolean
  /** Devices connected now; null when it cannot be read (then Studio asks anyway). */
  connectedCount: () => Promise<number | null>
  /** The question; one answer per quit attempt. `null`: the count is unknown. */
  ask: (count: number | null) => Promise<QuitAnswer>
  log?: Pick<Console, 'log'>
}

export function quitQuestion(count: number | null): { title: string; message: string; detail: string; buttons: [string, string, string] } {
  if (count === null) {
    // Security review 5: an unreadable count never quits without asking.
    return {
      title: 'Quit',
      message: 'Devices may be connected',
      detail: 'Studio could not read whether devices are connected. Keep the daemon running for them, or stop it. Stopping disconnects any and stops your agents. Keep running applies to this quit only.',
      buttons: ['Keep running', 'Stop daemon', 'Cancel'],
    }
  }
  return {
    title: 'Quit',
    message: `${count} ${count === 1 ? 'device' : 'devices'} connected`,
    detail: 'Keep the daemon running for them, or stop it. Stopping disconnects them and stops your agents. Keep running applies to this quit only.',
    buttons: ['Keep running', 'Stop daemon', 'Cancel'],
  }
}

export class RemoteQuitGate {
  /** The answer for the quit in progress; null until one was given. */
  private answer: 'keep' | 'stop' | null = null
  private asking: Promise<void> | null = null
  private readonly log: Pick<Console, 'log'>

  constructor(private readonly deps: QuitGateDeps) {
    this.log = deps.log ?? console
  }

  /** Keep the daemon running for this quit (the user chose Keep Running). */
  get keepDaemonForThisQuit(): boolean {
    return this.answer === 'keep'
  }

  /**
   * True: the quit may go on now. False: it is held while Studio checks and
   * asks; `resume` runs once it may go on (not after Cancel).
   */
  hold(resume: () => void): boolean {
    if (this.answer !== null) return true
    if (this.asking) return false
    // The daemon keeps running anyway (keep-running on, started by the CLI, not local mode): nothing to ask.
    if (!this.deps.daemonWouldStop()) return true
    this.asking = (async () => {
      let decided: 'keep' | 'stop' | 'cancel' = 'stop'
      try {
        let count: number | null
        try {
          count = await this.deps.connectedCount()
        } catch (err) {
          this.log.log(`[Remote access] Could not read the connected devices at quit (${err instanceof Error ? err.message : String(err)}); asking anyway`)
          count = null
        }
        if (count === null || count > 0) {
          decided = await this.deps.ask(count)
          this.log.log(`[Remote access] Quit with ${count ?? 'an unknown number of'} device(s) connected: ${decided === 'keep' ? 'Keep running (this quit only)' : decided === 'stop' ? 'Stop daemon' : 'Cancel'}`)
        }
      } catch (err) {
        // The question itself failed (no window): the safe answer keeps the devices connected.
        this.log.log(`[Remote access] The quit question failed (${err instanceof Error ? err.message : String(err)}); the daemon keeps running for this quit`)
        decided = 'keep'
      } finally {
        this.asking = null
      }
      if (decided === 'cancel') return
      this.answer = decided
      resume()
    })()
    return false
  }
}
