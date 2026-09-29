/**
 * GET /events resume semantics: ?since= / Last-Event-ID, the stream.hello
 * frame (epoch + cursor window) and stream.gap when a resume cannot be exact.
 */
import { request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createDaemonHttpApi } from '../src/main/daemon/http-api'
import { DaemonEventBus } from '../src/main/daemon/event-bus'
import { RuntimeService } from '../src/main/runtime/runtime-service'

interface Frame { id?: string; event?: string; data?: unknown }

let server: FastifyInstance | null = null
afterEach(async () => { await server?.close(); server = null })

async function start(bus: DaemonEventBus): Promise<number> {
  server = createDaemonHttpApi(new RuntimeService({ enforceReviewGate: false }), { eventBus: bus })
  await server.listen({ host: '127.0.0.1', port: 0 })
  return (server.server.address() as AddressInfo).port
}

function publish(bus: DaemonEventBus, n: number): void {
  for (let i = 0; i < n; i++) {
    bus.publish({ seq: 0, event_type: `test.e${i}`, timestamp: 0, source: 'system:test', agent_id: null, payload: {} })
  }
}

/** Open the stream, collect frames until `count` data frames arrived, then hang up. */
function readFrames(port: number, path: string, count: number, headers: Record<string, string> = {}): Promise<{ status: number; frames: Frame[] }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, headers }, (res) => {
      if (res.statusCode !== 200) {
        let body = ''
        res.on('data', (c) => { body += c })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, frames: [{ data: JSON.parse(body) }] }))
        return
      }
      const frames: Frame[] = []
      let buffer = ''
      const timer = setTimeout(() => { res.destroy(); resolve({ status: 200, frames }) }, 1500)
      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf-8')
        let at = buffer.indexOf('\n\n')
        while (at >= 0) {
          const block = buffer.slice(0, at)
          buffer = buffer.slice(at + 2)
          const frame: Frame = {}
          for (const line of block.split('\n')) {
            if (line.startsWith('id: ')) frame.id = line.slice(4)
            else if (line.startsWith('event: ')) frame.event = line.slice(7)
            else if (line.startsWith('data: ')) frame.data = JSON.parse(line.slice(6))
          }
          if (frame.data !== undefined) frames.push(frame)
          at = buffer.indexOf('\n\n')
        }
        if (frames.length >= count) { clearTimeout(timer); res.destroy(); resolve({ status: 200, frames }) }
      })
    })
    req.on('error', reject)
    req.end()
  })
}

describe('GET /events resume', () => {
  it('opens with stream.hello (epoch + cursor window), then replays after ?since=', async () => {
    const bus = new DaemonEventBus(10)
    publish(bus, 3)
    const port = await start(bus)
    const { frames } = await readFrames(port, '/events?since=1', 3)
    expect(frames[0]).toEqual({ event: 'stream.hello', data: { epoch: bus.epoch, oldestCursor: 1, latestCursor: 3 } })
    expect(frames.slice(1).map(f => f.id)).toEqual(['2', '3'])
  })

  it('honours Last-Event-ID; ?since= wins when both are sent', async () => {
    const bus = new DaemonEventBus(10)
    publish(bus, 4)
    const port = await start(bus)
    const byHeader = await readFrames(port, '/events', 3, { 'Last-Event-ID': '2' })
    expect(byHeader.frames.slice(1).map(f => f.id)).toEqual(['3', '4'])
    const both = await readFrames(port, '/events?since=3', 2, { 'Last-Event-ID': '1' })
    expect(both.frames.slice(1).map(f => f.id)).toEqual(['4'])
    const bad = await readFrames(port, '/events', 1, { 'Last-Event-ID': 'nope' })
    expect(bad.status).toBe(400)
    expect(bad.frames[0].data).toMatchObject({ code: 'bad_request' })
  })

  it('sends stream.gap when the cursor is older than the buffer', async () => {
    const bus = new DaemonEventBus(3)
    publish(bus, 10)
    const port = await start(bus)
    const { frames } = await readFrames(port, '/events?since=2', 5)
    expect(frames[1]).toEqual({
      event: 'stream.gap',
      data: { reason: 'evicted', epoch: bus.epoch, requestedCursor: 2, oldestCursor: 8, latestCursor: 10 },
    })
    expect(frames.slice(2).map(f => f.id)).toEqual(['8', '9', '10'])
    // Exactly at the edge of the buffer: nothing lost, no gap.
    const edge = await readFrames(port, '/events?since=7', 4)
    expect(edge.frames.map(f => f.event)).toEqual(['stream.hello', 'test.e7', 'test.e8', 'test.e9'])
  })

  it('sends stream.gap (epoch_changed) and replays the whole buffer for a cursor from another daemon run', async () => {
    const bus = new DaemonEventBus(10)
    publish(bus, 2)
    const port = await start(bus)
    const { frames } = await readFrames(port, '/events?since=500&epoch=previous-run', 4)
    expect(frames[1]).toMatchObject({ event: 'stream.gap', data: { reason: 'epoch_changed', epoch: bus.epoch, requestedCursor: 500 } })
    expect(frames.slice(2).map(f => f.id)).toEqual(['1', '2'])
    // Same epoch: a normal resume.
    const same = await readFrames(port, `/events?since=1&epoch=${bus.epoch}`, 2)
    expect(same.frames.map(f => f.event)).toEqual(['stream.hello', 'test.e1'])
  })
})
