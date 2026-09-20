import { describe, it, expect } from 'vitest'
import { MessageBus, type MessageBusLogEntry } from '../../../src/main/runtime/message-bus'

/**
 * The fleet map polls the bus log every 5s. Without a cursor it re-received all
 * 200 entries (content and all) every cycle; `getLog(sinceSeq)` returns only
 * what was appended after the caller's last read.
 */

function entry(messageId: string): MessageBusLogEntry {
  return {
    timestamp: Date.now(),
    messageId,
    from: 'agent-1',
    to: ['agent-2'],
    channel: 'general',
    type: 'text',
    content: `hello from ${messageId}`,
    delivered: true,
    deliveredTo: ['agent-2']
  }
}

describe('MessageBus log cursor', () => {
  it('stamps a monotonic seq on every appended entry', () => {
    const bus = new MessageBus()
    bus.logEntry(entry('m1'))
    bus.logEntry(entry('m2'))

    const log = bus.getLog()
    expect(log.map((e) => e.seq)).toEqual([1, 2])
  })

  it('returns only entries newer than the cursor', () => {
    const bus = new MessageBus()
    bus.logEntry(entry('m1'))
    bus.logEntry(entry('m2'))

    const first = bus.getLog()
    const cursor = first[first.length - 1].seq!

    expect(bus.getLog(cursor)).toEqual([])

    bus.logEntry(entry('m3'))
    const tail = bus.getLog(cursor)
    expect(tail).toHaveLength(1)
    expect(tail[0].messageId).toBe('m3')
    expect(tail[0].seq).toBe(3)
  })

  it('leaves the caller-supplied entry unmutated', () => {
    const bus = new MessageBus()
    const original = entry('m1')
    bus.logEntry(original)
    expect(original.seq).toBeUndefined()
    expect(bus.getLog()[0].seq).toBe(1)
  })

  it('keeps climbing after a clear so a stale cursor never re-reads', () => {
    const bus = new MessageBus()
    bus.logEntry(entry('m1'))
    bus.clearLog()
    bus.logEntry(entry('m2'))

    expect(bus.getLog()[0].seq).toBe(2)
    expect(bus.getLog(1).map((e) => e.messageId)).toEqual(['m2'])
  })

  it('caps the log at 200 entries', () => {
    const bus = new MessageBus()
    for (let i = 0; i < 210; i++) bus.logEntry(entry(`m${i}`))
    const log = bus.getLog()
    expect(log).toHaveLength(200)
    expect(log[0].messageId).toBe('m10')
    expect(log[log.length - 1].seq).toBe(210)
  })
})
