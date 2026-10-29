import { EventEmitter } from 'node:events'
import type { ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DaemonEventBus } from '../src/main/daemon/event-bus'
import { streamDaemonEvents } from '../src/main/daemon/event-stream'

class Sink extends EventEmitter {
  chunks: string[] = []
  blocked = false
  destroyed = false
  write(chunk: string): boolean { this.chunks.push(chunk); return !this.blocked }
  destroy(): this { this.destroyed = true; this.emit('close'); return this }
  drain(): void { this.blocked = false; this.emit('drain') }
  get cursors(): number[] { return this.chunks.flatMap(chunk => [...chunk.matchAll(/^id: (\d+)$/gm)].map(m => Number(m[1]))) }
}

const stops: Array<() => void> = []
afterEach(() => { for (const stop of stops.splice(0)) stop(); vi.useRealTimers() })
function attach(bus: DaemonEventBus, sink: Sink, options: Parameters<typeof streamDaemonEvents>[2] = {}): void {
  stops.push(streamDaemonEvents(bus, sink as unknown as ServerResponse, options))
}
function publish(bus: DaemonEventBus, agentId = 'a'): void {
  bus.publish({ seq: 0, event_type: 'test.event', source: 'test', timestamp: 0, agent_id: agentId, payload: {} })
}

describe('daemon event stream backpressure', () => {
  it('pauses frames and heartbeats, then resumes buffered events once and in order', () => {
    vi.useFakeTimers()
    const bus = new DaemonEventBus(10)
    const sink = new Sink()
    attach(bus, sink)
    sink.blocked = true
    publish(bus)
    publish(bus)
    publish(bus)
    vi.advanceTimersByTime(60_000)
    expect(sink.chunks).toHaveLength(2) // greeting and the first accepted frame
    expect(sink.cursors).toEqual([1])
    expect(sink.listenerCount('drain')).toBe(1)
    sink.drain()
    expect(sink.cursors).toEqual([1, 2, 3])
    publish(bus)
    expect(sink.cursors).toEqual([1, 2, 3, 4])
    expect(sink.listenerCount('drain')).toBe(0)
  })

  it('disconnects an evicted slow reader and reports the loss on resume', () => {
    const bus = new DaemonEventBus(2)
    const slow = new Sink()
    const fast = new Sink()
    attach(bus, slow)
    attach(bus, fast)
    slow.blocked = true
    for (let i = 0; i < 20; i++) publish(bus)
    expect(slow.cursors).toEqual([1])
    expect(fast.cursors).toHaveLength(20)
    slow.drain()
    expect(slow.destroyed).toBe(true)
    expect(slow.listenerCount('drain')).toBe(0)
    const resumed = new Sink()
    attach(bus, resumed, { since: 1, epoch: bus.epoch })
    expect(resumed.chunks[0]).toContain('event: stream.gap')
    expect(resumed.chunks[0]).toContain('"reason":"evicted"')
    expect(resumed.cursors).toEqual([19, 20])
    publish(bus)
    expect(slow.cursors).toEqual([1])
    expect(resumed.cursors).toEqual([19, 20, 21])
  })

  it('honours backpressure during the greeting and initial replay', () => {
    const bus = new DaemonEventBus(10)
    for (let i = 0; i < 3; i++) publish(bus)
    const sink = new Sink()
    sink.blocked = true
    attach(bus, sink, { since: 1 })
    publish(bus)
    expect(sink.cursors).toEqual([])
    sink.drain()
    expect(sink.cursors).toEqual([2, 3, 4])
  })

  it('starts live-only subscriptions at the current cursor and filters replay', () => {
    const bus = new DaemonEventBus(10)
    publish(bus)
    const sink = new Sink()
    attach(bus, sink, { since: Number.MAX_SAFE_INTEGER, agentId: 'a' })
    expect(sink.cursors).toEqual([])
    sink.blocked = true
    publish(bus)
    publish(bus, 'other')
    publish(bus)
    sink.drain()
    expect(sink.cursors).toEqual([2, 4])
  })

  it('removes its drain listener and stops writing when the reader closes', () => {
    vi.useFakeTimers()
    const bus = new DaemonEventBus()
    const sink = new Sink()
    attach(bus, sink)
    sink.blocked = true
    publish(bus)
    sink.destroy()
    const count = sink.chunks.length
    expect(sink.listenerCount('drain')).toBe(0)
    publish(bus)
    sink.drain()
    vi.advanceTimersByTime(60_000)
    expect(sink.chunks).toHaveLength(count)
  })
})
