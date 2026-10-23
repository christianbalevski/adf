/**
 * Cross-cutting kill switch for the runtime.
 *
 * EmergencyStop sets `stopped=true` before tearing anything down. Every code
 * path that can fire an agent turn or a timer consults the gate first and
 * no-ops when stopped, so in-flight microtasks queued before dispose can't
 * leak past the kill switch. Any deliberate start action (user click, IPC
 * AGENT_START, autostart on boot) calls `resume()` to unfreeze.
 *
 * `beginKill()` holds the gate closed for the whole of a Kill: until its
 * release runs, `resume()` refuses and every start path refuses with
 * KILL_IN_PROGRESS_ERROR, so nothing (a click that re-attaches an agent, a
 * message, a load) can reopen the gate while agents are still being stopped.
 *
 * `beginTeardown()` is the terminal form used by process shutdown paths
 * (teardownRuntime/stopAll with finalTeardown, daemon stopOnce,
 * RuntimeService.shutdownAll): once called, `resume()`
 * becomes a no-op and the gate stays closed until process exit, so an agent
 * whose start completes mid-shutdown can never re-open the gate behind the
 * teardown's back.
 */
export const KILL_IN_PROGRESS_ERROR = 'Kill is still stopping agents. Start it again once it finishes.'

class RuntimeGateImpl {
  private _stopped = false
  private _teardown = false
  private _kills = 0
  private _killEpoch = 0
  private _killSettled: Promise<void> = Promise.resolve()
  private _settleKill: (() => void) | null = null

  get stopped(): boolean {
    return this._stopped
  }

  /** True once a shutdown path has claimed the runtime for teardown. */
  get tearingDown(): boolean {
    return this._teardown
  }

  /** True while a Kill is stopping agents (between beginKill and its release). */
  get killing(): boolean {
    return this._kills > 0
  }

  /**
   * Counts the Kills begun. A start that awaits before it starts anything (a
   * provider check, a folder scan) takes it first and refuses when
   * `killedSince` says a Kill began in between: a start the user asked for
   * before the Kill is not carried out after it.
   */
  get killEpoch(): number {
    return this._killEpoch
  }

  killedSince(epoch: number): boolean {
    return this._killEpoch !== epoch || this._kills > 0
  }

  stop(): void {
    if (!this._stopped) {
      this._stopped = true
      console.log('[RuntimeGate] stopped')
    }
  }

  /**
   * A Kill begins: the gate closes and stays closed until the returned
   * release runs (call it in a finally). Overlapping Kills nest. After the
   * release the gate is still stopped: only a deliberate start reopens it.
   */
  beginKill(): () => void {
    this.stop()
    this._killEpoch++
    if (this._kills++ === 0) this._killSettled = new Promise((resolve) => { this._settleKill = resolve })
    let released = false
    return () => {
      if (released) return
      released = true
      if (--this._kills === 0) {
        this._settleKill?.()
        this._settleKill = null
      }
    }
  }

  /** Resolves once no Kill is running (at once when none is). */
  whenKillSettled(): Promise<void> {
    return this._killSettled
  }

  /**
   * Terminal stop for process shutdown. After this, `resume()` no-ops and
   * `stopped` remains true until process exit.
   */
  beginTeardown(): void {
    if (!this._teardown) {
      this._teardown = true
      console.log('[RuntimeGate] teardown begun — resume() disabled until process exit')
    }
    this.stop()
  }

  resume(): void {
    if (this._teardown) {
      console.warn('[RuntimeGate] resume() ignored — runtime teardown in progress')
      return
    }
    if (this._kills > 0) {
      console.warn('[RuntimeGate] resume() refused — Kill is still stopping agents')
      return
    }
    if (this._stopped) {
      this._stopped = false
      console.log('[RuntimeGate] resumed')
    }
  }

  /** Test-only escape hatch: clears stopped/teardown/kill state. Never call in production code. */
  _resetForTests(): void {
    this._stopped = false
    this._teardown = false
    this._kills = 0
    this._killEpoch = 0
    this._settleKill?.()
    this._settleKill = null
    this._killSettled = Promise.resolve()
  }
}

export const RuntimeGate = new RuntimeGateImpl()
