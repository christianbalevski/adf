import { describe, expect, it } from 'vitest'

import { DaemonEventBus } from '../src/main/daemon/event-bus'
import type { UmbilicalEvent } from '../src/main/runtime/umbilical-bus'

function event(partial: Partial<UmbilicalEvent> & { event_type: string }): UmbilicalEvent {
  return {
    seq: partial.seq ?? 0,
    event_type: partial.event_type,
    timestamp: partial.timestamp ?? 0,
    source: partial.source ?? 'system:test',
    agent_id: partial.agent_id ?? null,
    payload: partial.payload ?? {},
  }
}

describe('DaemonEventBus', () => {
  it('assigns transport cursors and replays events since a cursor', () => {
    const bus = new DaemonEventBus(10)

    const first = bus.publish(event({ event_type: 'daemon.started' }))
    const second = bus.publish(event({ event_type: 'agent.loaded', agent_id: '00000000-0000-0000-0000-000000000001', seq: 7, payload: { name: 'agent-1' } }))
    const third = bus.publish(event({ event_type: 'agent.loaded', agent_id: '00000000-0000-0000-0000-000000000002', seq: 9, payload: { name: 'agent-2' } }))

    expect(first.cursor).toBe(1)
    expect(second.cursor).toBe(2)
    expect(third.cursor).toBe(3)
    expect(bus.getSince(1).map(e => e.cursor)).toEqual([2, 3])
    expect(bus.getSince(1, '00000000-0000-0000-0000-000000000001').map(e => e.cursor)).toEqual([2])
  })

  it('carries the canonical envelope through unchanged', () => {
    const bus = new DaemonEventBus(10)
    const published = bus.publish(event({
      event_type: 'tool.completed',
      seq: 42,
      timestamp: 1710000000000,
      source: 'agent:turn-abc',
      agent_id: '00000000-0000-0000-0000-000000000001',
      payload: { name: 'db_query' },
    }))

    expect(published.event).toEqual({
      seq: 42,
      event_type: 'tool.completed',
      timestamp: 1710000000000,
      source: 'agent:turn-abc',
      agent_id: '00000000-0000-0000-0000-000000000001',
      payload: { name: 'db_query' },
    })
  })

  it('keeps only the configured ring buffer capacity', () => {
    const bus = new DaemonEventBus(2)
    bus.publish(event({ event_type: 'one' }))
    bus.publish(event({ event_type: 'two' }))
    bus.publish(event({ event_type: 'three' }))

    expect(bus.getSince(0).map(e => e.event.event_type)).toEqual(['two', 'three'])
  })

  it('notifies subscribers and supports unsubscribe', () => {
    const bus = new DaemonEventBus()
    const seen: string[] = []
    const unsubscribe = bus.subscribe(e => seen.push(e.event.event_type))

    bus.publish(event({ event_type: 'one' }))
    unsubscribe()
    bus.publish(event({ event_type: 'two' }))

    expect(seen).toEqual(['one'])
  })
})
