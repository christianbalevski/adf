/**
 * Emit a runtime event onto both the daemon event bus (external /events SSE
 * consumers) and the per-agent umbilical bus (internal tap consumers).
 *
 * Every call site that used to call `eventBus.publish(...)` directly must go
 * through this helper so `source` is populated from the AsyncLocalStorage
 * context. Two guards enforce this:
 *   - tests/unit/umbilical-emit-guard.test.ts   — no direct `eventBus.publish(`
 *   - tests/unit/umbilical-event-registry.test.ts — event_type literals must be
 *     members of UMBILICAL_EVENT_TYPES.
 *
 * Payload is an event-type-specific object. See docs/guides/umbilical-events.md
 * for the canonical shapes of tool.*, db.*, message.*, lambda.*.
 */

import type { DaemonEventBus } from '../daemon/event-bus'
import { currentSourceOrUnknown, currentAgentId, currentLoop, currentTurnId } from './execution-context'
import { getUmbilicalBus, type UmbilicalEvent } from './umbilical-bus'

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
  /**
   * Cognition loop that produced the event. Pass 'main' for an explicit main
   * (never filled from context). Absent: the async context's loop, but only
   * when the event is for the context's own agent. Only inner loops are
   * stamped onto the envelope; main stays absent.
   */
  loop?: string
  payload?: Record<string, unknown>
}

export function emitUmbilicalEvent(input: EmitUmbilicalInput): void {
  const source = input.source ?? currentSourceOrUnknown()
  const contextAgentId = currentAgentId()
  const agentId = input.agentId ?? contextAgentId ?? null
  const timestamp = input.timestamp ?? Date.now()
  const payload = input.payload ?? {}
  // Another agent's event (e.g. mesh delivery into agent-2 from agent-1's
  // inner-loop turn) must not carry the sender's loop.
  const loop = input.loop ?? (agentId !== null && agentId === contextAgentId ? currentLoop() : undefined)
  const loopField = loop && loop !== 'main' ? { loop } : {}
  // Same rule for the turn: only the context agent's own events belong to its turn.
  const turnId = agentId !== null && agentId === contextAgentId ? currentTurnId() : undefined
  const turnField = turnId ? { turn_id: turnId } : {}

  // Temporary diagnostic — remove after the "nothing fires" issue is understood.
  if (process.env.ADF_UMBILICAL_TRACE === '1') {
    console.log(`[Umbilical:trace] type=${input.event_type} agentId=${agentId ?? '<none>'} source=${source}`)
  }

  // 1. Per-agent umbilical bus (in-process taps). This assigns the canonical
  //    per-agent `seq` that the daemon bus and the wire format both carry.
  let event: UmbilicalEvent = {
    seq: 0,
    event_type: input.event_type,
    timestamp,
    source,
    agent_id: agentId,
    ...loopField,
    ...turnField,
    payload,
  }

  if (agentId) {
    const bus = getUmbilicalBus(agentId)
    if (bus) {
      event = bus.publish({
        event_type: input.event_type,
        timestamp,
        source,
        agent_id: agentId,
        ...loopField,
        ...turnField,
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

  // 2. Daemon bus (external /events subscribers) — same canonical envelope.
  if (daemonEventBus) {
    daemonEventBus.publish(event)
  }
}
