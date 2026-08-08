/**
 * Cross-cutting kill switch for the runtime.
 *
 * EmergencyStop sets `stopped=true` before tearing anything down. Every code
 * path that can fire an agent turn or a timer consults the gate first and
 * no-ops when stopped, so in-flight microtasks queued before dispose can't
 * leak past the kill switch. Any deliberate start action (user click, IPC
 * AGENT_START, autostart on boot) calls `resume()` to unfreeze.
 *
 * `beginTeardown()` is the terminal form used by process shutdown paths
 * (teardownRuntime/stopAll with finalTeardown, daemon stopOnce,
 * RuntimeService.shutdownAll): once called, `resume()`
 * becomes a no-op and the gate stays closed until process exit, so an agent
 * whose start completes mid-shutdown can never re-open the gate behind the
 * teardown's back.
 */
class RuntimeGateImpl {
  private _stopped = false
  private _teardown = false

  get stopped(): boolean {
    return this._stopped
  }

  /** True once a shutdown path has claimed the runtime for teardown. */
  get tearingDown(): boolean {
    return this._teardown
  }

  stop(): void {
    if (!this._stopped) {
      this._stopped = true
      console.log('[RuntimeGate] stopped')
    }
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
    if (this._stopped) {
      this._stopped = false
      console.log('[RuntimeGate] resumed')
    }
  }

  /** Test-only escape hatch: clears stopped/teardown state. Never call in production code. */
  _resetForTests(): void {
    this._stopped = false
    this._teardown = false
  }
}

export const RuntimeGate = new RuntimeGateImpl()
