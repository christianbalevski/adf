import { describe, expect, it } from 'vitest'

import { DaemonEventBus } from '../src/main/daemon/event-bus'

describe('DaemonEventBus', () => {
  it('assigns global sequence numbers and replays events since a cursor', () => {
    const bus = new DaemonEventBus(10)

    const first = bus.publish({ type: 'daemon.started' })
    const second = bus.publish({ type: 'agent.loaded', agentId: '00000000-0000-0000-0000-000000000001', payload: { name: 'one' } })
    const third = bus.publish({ type: 'agent.loaded', agentId: '00000000-0000-0000-0000-000000000002', payload: { name: 'two' } })

    expect(first.seq).toBe(1)
    expect(second.seq).toBe(2)
    expect(third.seq).toBe(3)
    expect(bus.getSince(1).map(event => event.seq)).toEqual([2, 3])
    expect(bus.getSince(1, '00000000-0000-0000-0000-000000000001').map(event => event.seq)).toEqual([2])
  })

  it('keeps only the configured ring buffer capacity', () => {
    const bus = new DaemonEventBus(2)
    bus.publish({ type: 'one' })
    bus.publish({ type: 'two' })
    bus.publish({ type: 'three' })

    expect(bus.getSince(0).map(event => event.type)).toEqual(['two', 'three'])
  })

  it('notifies subscribers and supports unsubscribe', () => {
    const bus = new DaemonEventBus()
    const seen: string[] = []
    const unsubscribe = bus.subscribe(event => seen.push(event.type))

    bus.publish({ type: 'one' })
    unsubscribe()
    bus.publish({ type: 'two' })

    expect(seen).toEqual(['one'])
  })
})
