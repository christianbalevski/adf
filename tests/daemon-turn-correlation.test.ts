/**
 * The turnId POST /agents/:id/chat (and /trigger) answers with is the
 * `turn_id` of every umbilical event of the turn that runs it — including a
 * chat that interrupted a running turn and was replayed.
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  const dir = join(tmpdir(), `adf-daemon-turn-corr-${process.pid}`)
  return {
    app: { getPath: () => dir, on: () => {}, getName: () => 'adf-daemon-turn-corr', getVersion: () => '0.0.0-test' },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (s: string) => Buffer.from(s, 'utf-8'),
      decryptString: (b: Buffer) => b.toString('utf-8'),
    },
    shell: { openExternal: async () => {} },
    ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {}, removeAllListeners: () => {} },
    BrowserWindow: class {},
    dialog: {},
  }
})

import { createDaemonHttpApi } from '../src/main/daemon/http-api'
import { DaemonEventBus, type DaemonEventEnvelope } from '../src/main/daemon/event-bus'
import { registerDaemonEventBus } from '../src/main/runtime/emit-umbilical'
import { RuntimeService } from '../src/main/runtime/runtime-service'
import { MockLLMProvider } from '../src/main/runtime/headless'

const cleanups: Array<() => Promise<unknown>> = []
const runtimes: RuntimeService[] = []
afterEach(async () => { for (const c of cleanups.splice(0)) await c() })
// shutdownAll latches a process-wide teardown gate: once, at the end.
afterAll(async () => { for (const r of runtimes) await r.shutdownAll({ mode: 'immediate' }) })

function setup(latencyMs: number | (() => number) = 0) {
  const bus = new DaemonEventBus(2000)
  registerDaemonEventBus(bus)
  const runtime = new RuntimeService({ enforceReviewGate: false })
  const ref = runtime.createAgent({ name: 'agent-1', provider: new MockLLMProvider({ tokensPerResponse: 20, latencyMs }) })
  const server = createDaemonHttpApi(runtime, { eventBus: bus })
  cleanups.push(() => server.close())
  runtimes.push(runtime)
  const events: DaemonEventEnvelope['event'][] = []
  bus.subscribe(e => { if (e.event.agent_id === ref.id) events.push(e.event) })
  return { ref, server, events }
}

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out')
    await new Promise(r => setTimeout(r, 10))
  }
}

describe('chat turn correlation', () => {
  it('stamps the 202 turnId on the events of that turn', async () => {
    const { ref, server, events } = setup()
    const res = await server.inject({ method: 'POST', url: `/agents/${ref.id}/chat`, payload: { text: 'hello' } })
    expect(res.statusCode).toBe(202)
    const { turnId } = res.json() as { turnId: string }
    expect(turnId).toMatch(/^turn_/)
    await waitFor(() => events.some(e => e.event_type === 'turn.completed'))
    const completed = events.find(e => e.event_type === 'turn.completed')!
    expect(completed.turn_id).toBe(turnId)
    const thinking = events.find(e => e.event_type === 'agent.state.changed' && e.payload.state === 'thinking')
    expect(thinking?.turn_id).toBe(turnId)
    // Everything the turn emitted carries it (nothing from another turn).
    const inTurn = events.filter(e => e.turn_id)
    expect(inTurn.length).toBeGreaterThan(1)
    expect(new Set(inTurn.map(e => e.turn_id))).toEqual(new Set([turnId]))
  })

  it('/trigger turnIds are stamped too', async () => {
    const { ref, server, events } = setup()
    const res = await server.inject({
      method: 'POST', url: `/agents/${ref.id}/trigger`,
      payload: { type: 'chat', data: { message: { seq: 1, role: 'user', content_json: [{ type: 'text', text: 'hi' }], created_at: 1 } } },
    })
    expect(res.statusCode).toBe(202)
    const { turnId } = res.json() as { turnId: string }
    await waitFor(() => events.some(e => e.event_type === 'turn.completed'))
    expect(events.find(e => e.event_type === 'turn.completed')?.turn_id).toBe(turnId)
  })

  it('a chat that interrupts a running turn keeps its own id through the replay', async () => {
    const { ref, server, events } = setup(300)
    const first = (await server.inject({ method: 'POST', url: `/agents/${ref.id}/chat`, payload: { text: 'first' } })).json().turnId as string
    await waitFor(() => events.some(e => e.event_type === 'agent.state.changed' && e.payload.state === 'thinking' && e.turn_id === first))
    const second = (await server.inject({ method: 'POST', url: `/agents/${ref.id}/chat`, payload: { text: 'second' } })).json().turnId as string
    await waitFor(() => events.some(e => e.event_type === 'turn.completed' && e.turn_id === second && !e.payload.interrupted))
    const firstCompletions = events.filter(e => e.event_type === 'turn.completed' && e.turn_id === first)
    // The interrupted first turn ends as interrupted (or absorbs nothing); never under the second id.
    for (const c of firstCompletions) expect(c.payload.interrupted).toBe(true)
  })

  it('a burst of chats during a turn: none dropped, delivered in order, every turnId completes', async () => {
    const { ref, server, events } = setup(300)
    const post = async (text: string) =>
      (await server.inject({ method: 'POST', url: `/agents/${ref.id}/chat`, payload: { text } })).json().turnId as string
    const first = await post('first')
    await waitFor(() => events.some(e => e.event_type === 'agent.state.changed' && e.payload.state === 'thinking' && e.turn_id === first))
    const rest = await Promise.all([post('second'), post('third'), post('fourth')])
    const all = [first, ...rest]
    const completed = (): Set<string> => {
      const ids = new Set<string>()
      for (const e of events) {
        if (e.event_type !== 'turn.completed' || e.payload.interrupted) continue
        if (e.turn_id) ids.add(e.turn_id)
        for (const id of (e.payload.absorbed_turn_ids as string[] | undefined) ?? []) ids.add(id)
      }
      return ids
    }
    await waitFor(() => all.every(id => completed().has(id)))
    // Chats queued behind a replay are delivered at its start, under its id.
    for (const e of events.filter(e => e.event_type === 'chat.delivered')) {
      expect(rest).toContain(e.turn_id)
      for (const id of e.payload.turn_ids as string[]) expect(rest.indexOf(id)).toBeGreaterThan(rest.indexOf(e.turn_id!))
    }
    const loop = (await server.inject({ method: 'GET', url: `/agents/${ref.id}/loop?limit=50` })).json() as { entries?: Array<{ role: string; content_json: Array<{ text?: string }> }> }
    const texts = (loop.entries ?? []).filter(r => r.role === 'user').map(r => r.content_json.map(b => b.text ?? '').join(''))
    expect(texts.filter(t => ['first', 'second', 'third', 'fourth'].includes(t))).toEqual(['first', 'second', 'third', 'fourth'])
  })

  it('chats sent during a compaction queue and replay as one turn with chat.delivered ids', async () => {
    let latency = 0
    const { ref, server, events } = setup(() => latency)
    const post = async (text: string) =>
      (await server.inject({ method: 'POST', url: `/agents/${ref.id}/chat`, payload: { text } })).json().turnId as string
    const warm = await post('warm')
    await waitFor(() => events.some(e => e.event_type === 'turn.completed' && e.turn_id === warm))
    latency = 300
    const before = events.length
    const compacting = server.inject({ method: 'POST', url: `/agents/${ref.id}/compact` })
    await waitFor(() => events.slice(before).some(e => e.event_type === 'context.injected'))
    const ids = [await post('q1'), await post('q2'), await post('q3')]
    expect((await compacting).statusCode).toBe(200)
    await waitFor(() => events.some(e => e.event_type === 'turn.completed' && e.turn_id === ids[0] && !e.payload.interrupted))
    const done = events.find(e => e.event_type === 'turn.completed' && e.turn_id === ids[0])!
    expect(done.payload.absorbed_turn_ids).toEqual([ids[1], ids[2]])
    const delivered = events.filter(e => e.event_type === 'chat.delivered')
    expect(delivered.length).toBe(1)
    expect(delivered[0].turn_id).toBe(ids[0])
    expect(delivered[0].payload).toMatchObject({ delivery: 'turn_start', count: 2, turn_ids: [ids[1], ids[2]] })
  })
})
