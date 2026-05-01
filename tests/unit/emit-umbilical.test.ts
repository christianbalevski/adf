/**
 * emit-umbilical helper tests.
 * Stamps source from AsyncLocalStorage and routes to both the daemon bus
 * and the per-agent umbilical bus.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { emitUmbilicalEvent, registerDaemonEventBus } from '../../src/main/runtime/emit-umbilical'
import { DaemonEventBus } from '../../src/main/daemon/event-bus'
import { ensureUmbilicalBus, clearAllUmbilicalBuses } from '../../src/main/runtime/umbilical-bus'
import { withSource } from '../../src/main/runtime/execution-context'

afterEach(() => {
  clearAllUmbilicalBuses()
  // Reset daemon bus registration to a fresh instance per test.
  registerDaemonEventBus(new DaemonEventBus(100))
})

describe('emitUmbilicalEvent', () => {
  it('stamps source from the current async context', () => {
    const bus = ensureUmbilicalBus('00000000-0000-0000-0000-000000000001')
    const received: string[] = []
    bus.subscribe(e => received.push(e.source))

    withSource('agent:turn-abc', '00000000-0000-0000-0000-000000000001', () => {
      emitUmbilicalEvent({ event_type: 'tool.completed', payload: { name: 't' } })
    })

    expect(received).toEqual(['agent:turn-abc'])
  })

  it('falls back to system:unknown when no context is set (production-safe path)', () => {
    const bus = ensureUmbilicalBus('00000000-0000-0000-0000-000000000001')
    const received: string[] = []
    bus.subscribe(e => received.push(e.source))

    // Explicit agentId bypasses the context lookup for agentId — and
    // currentSourceOrUnknown is the production-safe source fallback.
    emitUmbilicalEvent({
      event_type: 'system.something',
      agentId: '00000000-0000-0000-0000-000000000001',
      payload: {}
    })

    expect(received).toEqual(['system:unknown'])
  })

  it('routes to both daemon bus and per-agent umbilical bus', () => {
    const daemonBus = new DaemonEventBus(100)
    registerDaemonEventBus(daemonBus)
    const umbilical = ensureUmbilicalBus('00000000-0000-0000-0000-000000000001')

    const umbilicalReceived: string[] = []
    umbilical.subscribe(e => umbilicalReceived.push(e.event_type))

    withSource('lambda:x.ts:y', '00000000-0000-0000-0000-000000000001', () => {
      emitUmbilicalEvent({ event_type: 'custom.test', payload: { n: 1 } })
    })

    const daemonReceived = daemonBus.getSince(0)
    expect(daemonReceived).toHaveLength(1)
    expect(daemonReceived[0].type).toBe('custom.test')
    expect((daemonReceived[0].payload as Record<string, unknown>).source).toBe('lambda:x.ts:y')

    expect(umbilicalReceived).toEqual(['custom.test'])
  })

  it('explicit source override wins over context', () => {
    const bus = ensureUmbilicalBus('00000000-0000-0000-0000-000000000001')
    const received: string[] = []
    bus.subscribe(e => received.push(e.source))

    withSource('agent:t', '00000000-0000-0000-0000-000000000001', () => {
      emitUmbilicalEvent({
        event_type: 'x',
        source: 'system:manual',
        payload: {}
      })
    })

    expect(received).toEqual(['system:manual'])
  })
})
