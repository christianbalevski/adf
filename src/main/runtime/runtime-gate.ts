/**
 * Cross-cutting kill switch for the runtime.
 *
 * EmergencyStop sets `stopped=true` before tearing anything down. Every code
 * path that can fire an agent turn or a timer consults the gate first and
 * no-ops when stopped, so in-flight microtasks queued before dispose can't
 * leak past the kill switch. Any deliberate start action (user click, IPC
 * AGENT_START, autostart on boot) calls `resume()` to unfreeze.
 */
class RuntimeGateImpl {
  private _stopped = false

  get stopped(): boolean {
    return this._stopped
  }

  stop(): void {
    if (!this._stopped) {
      this._stopped = true
      console.log('[RuntimeGate] stopped')
    }
  }

  resume(): void {
    if (this._stopped) {
      this._stopped = false
      console.log('[RuntimeGate] resumed')
    }
  }
}

export const RuntimeGate = new RuntimeGateImpl()
