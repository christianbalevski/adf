/**
 * Emit a runtime event onto both the daemon event bus (external /events SSE
 * consumers) and the per-agent umbilical bus (internal tap consumers).
 *
 * Every call site that used to call `eventBus.publish(...)` directly must go
 * through this helper so `source` is populated from the AsyncLocalStorage
 * context. A CI guard (scripts/check-direct-event-publish.ts) fails the build
 * if a direct `eventBus.publish(` appears outside this file.
 *
 * Payload is an event-type-specific object. See docs/guides/umbilical-events.md
 * for the canonical shapes of tool.*, db.*, message.*, lambda.*.
 */

import type { DaemonEventBus } from '../daemon/event-bus'
import { currentSourceOrUnknown, currentAgentId } from './execution-context'
import { getUmbilicalBus } from './umbilical-bus'

let daemonEventBus: DaemonEventBus | null = null
const _missingBusWarned = new Set<string>()

/**
 * One-time registration of the daemon event bus. Called from daemon startup.
 * This keeps the helper self-contained while letting the daemon own the bus
 * lifecycle.
 */
export function registerDaemonEventBus(bus: DaemonEventBus): void {
  daemonEventBus = bus
}

export interface EmitUmbilicalInput {
  event_type: string
  /** Explicit agent id override. Defaults to currentAgentId() from the async context. */
  agentId?: string
  /** Explicit source override. Defaults to currentSource() from the async context. */
  source?: string
  /** Explicit timestamp. Defaults to Date.now(). */
  timestamp?: number
  payload?: Record<string, unknown>
}

export function emitUmbilicalEvent(input: EmitUmbilicalInput): void {
  const source = input.source ?? currentSourceOrUnknown()
  const agentId = input.agentId ?? currentAgentId() ?? null
  const timestamp = input.timestamp ?? Date.now()
  const payload = input.payload ?? {}

  // Temporary diagnostic — remove after the "nothing fires" issue is understood.
  if (process.env.ADF_UMBILICAL_TRACE === '1') {
    console.log(`[Umbilical:trace] type=${input.event_type} agentId=${agentId ?? '<none>'} source=${source}`)
  }

  // 1. Daemon bus (external /events subscribers)
  if (daemonEventBus) {
    daemonEventBus.publish({
      type: input.event_type,
      agentId,
      timestamp,
      payload: { ...payload, source },
    })
  }

  // 2. Per-agent umbilical bus (in-process taps)
  if (agentId) {
    const bus = getUmbilicalBus(agentId)
    if (bus) {
      bus.publish({
        event_type: input.event_type,
        timestamp,
        source,
        payload,
      })
    } else if (!_missingBusWarned.has(agentId)) {
      _missingBusWarned.add(agentId)
      console.warn(`[Umbilical] No bus for agentId=${agentId} — taps will not fire. Event: ${input.event_type}`)
    }
  } else if (!_missingBusWarned.has('__no_agent__')) {
    _missingBusWarned.add('__no_agent__')
    console.warn(`[Umbilical] Event emitted with no agentId context: ${input.event_type}. Origin site may be missing a withSource wrap with agentId.`)
  }
}
