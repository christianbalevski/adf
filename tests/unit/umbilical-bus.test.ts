/**
 * UmbilicalBus core tests — isolation, subscription, sequencing.
 * Tap dispatch, filter matching, and rate limiting are tested in tap-manager.test.ts.
 */

import { describe, it, expect, afterEach } from 'vitest'
import {
  UmbilicalBus,
  ensureUmbilicalBus,
  ensureWorkspaceUmbilicalBus,
  getUmbilicalBus,
  destroyUmbilicalBus,
  clearAllUmbilicalBuses,
} from '../../src/main/runtime/umbilical-bus'

afterEach(() => {
  clearAllUmbilicalBuses()
})

describe('UmbilicalBus', () => {
  it('publishes and receives events with monotonic seq', () => {
    const bus = new UmbilicalBus('agent-1')
    const received: number[] = []
    bus.subscribe(e => received.push(e.seq))

    bus.publish({ event_type: 'x', timestamp: 1, source: 'system:test', payload: {} })
    bus.publish({ event_type: 'y', timestamp: 2, source: 'system:test', payload: {} })
    bus.publish({ event_type: 'z', timestamp: 3, source: 'system:test', payload: {} })

    expect(received).toEqual([1, 2, 3])
  })

  it('unsubscribe stops delivery', () => {
    const bus = new UmbilicalBus('agent-1')
    const received: string[] = []
    const off = bus.subscribe(e => received.push(e.event_type))

    bus.publish({ event_type: 'a', timestamp: 0, source: 's', payload: {} })
    off()
    bus.publish({ event_type: 'b', timestamp: 0, source: 's', payload: {} })

    expect(received).toEqual(['a'])
  })

  it('teardown removes all listeners', () => {
    const bus = new UmbilicalBus('agent-1')
    let count = 0
    bus.subscribe(() => { count += 1 })
    bus.subscribe(() => { count += 1 })

    bus.publish({ event_type: 'x', timestamp: 0, source: 's', payload: {} })
    expect(count).toBe(2)

    bus.teardown()
    count = 0
    bus.publish({ event_type: 'x', timestamp: 0, source: 's', payload: {} })
    expect(count).toBe(0)
  })
})

describe('UmbilicalBus registry — cross-agent isolation', () => {
  it('ensures distinct bus instances per agent id', () => {
    const a = ensureUmbilicalBus('agent-a')
    const b = ensureUmbilicalBus('agent-b')
    expect(a).not.toBe(b)
    expect(a.agentId).toBe('agent-a')
    expect(b.agentId).toBe('agent-b')
  })

  it('getUmbilicalBus returns undefined for unknown agents', () => {
    expect(getUmbilicalBus('nobody')).toBeUndefined()
  })

  it('events on one agent bus do not leak to another', () => {
    const a = ensureUmbilicalBus('agent-a')
    const b = ensureUmbilicalBus('agent-b')

    const aReceived: string[] = []
    const bReceived: string[] = []
    a.subscribe(e => aReceived.push(e.event_type))
    b.subscribe(e => bReceived.push(e.event_type))

    a.publish({ event_type: 'only-for-a', timestamp: 0, source: 's', payload: {} })
    b.publish({ event_type: 'only-for-b', timestamp: 0, source: 's', payload: {} })

    expect(aReceived).toEqual(['only-for-a'])
    expect(bReceived).toEqual(['only-for-b'])
  })

  it('destroyUmbilicalBus tears down and removes from registry', () => {
    ensureUmbilicalBus('agent-x')
    expect(getUmbilicalBus('agent-x')).toBeDefined()
    destroyUmbilicalBus('agent-x')
    expect(getUmbilicalBus('agent-x')).toBeUndefined()
  })

  it('seeds sequence numbers from workspace metadata across bus recreation', () => {
    const meta = new Map<string, string>()
    const store = {
      getMeta: (key: string) => meta.get(key) ?? null,
      setMeta: (key: string, value: string) => { meta.set(key, value) },
    }
    const firstSeqs: number[] = []
    const first = ensureWorkspaceUmbilicalBus('agent-durable', store)
    first.subscribe(event => firstSeqs.push(event.seq))
    first.publish({ event_type: 'first', timestamp: 1, source: 'system:test', payload: {} })
    destroyUmbilicalBus('agent-durable')

    const secondSeqs: number[] = []
    const second = ensureWorkspaceUmbilicalBus('agent-durable', store)
    second.subscribe(event => secondSeqs.push(event.seq))
    second.publish({ event_type: 'second', timestamp: 2, source: 'system:test', payload: {} })

    expect(firstSeqs[0]).toBeGreaterThan(1)
    expect(secondSeqs[0]).toBeGreaterThan(firstSeqs[0])
  })
})
