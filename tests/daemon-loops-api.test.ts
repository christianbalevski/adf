import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  const dir = join(tmpdir(), `adf-daemon-loops-api-${process.pid}`)
  return {
    app: {
      getPath: () => dir,
      on: () => {},
      getName: () => 'adf-daemon-loops-api-test',
      getVersion: () => '0.0.0-test',
    },
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

const servers: Array<{ close: () => Promise<unknown> }> = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()))
})

function setup() {
  const provider = new MockLLMProvider({ tokensPerResponse: 40 })
  const runtime = new RuntimeService({ enforceReviewGate: false })
  const ref = runtime.createAgent({ name: 'agent-1', provider })
  const server = createDaemonHttpApi(runtime)
  servers.push(server)
  return { ref, server, provider }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 50))

describe('daemon loop API', () => {
  it('lists, creates, updates and deletes inner loops through the loop pool', async () => {
    const { ref, server } = setup()
    const base = `/agents/${ref.id}/loops`

    const initial = await server.inject({ method: 'GET', url: base })
    expect(initial.statusCode).toBe(200)
    expect(initial.json()).toEqual({
      agentId: ref.id,
      loops: [expect.objectContaining({ name: 'main', isMain: true, enabled: true, status: 'idle', config: null })],
    })

    const created = await server.inject({
      method: 'POST',
      url: base,
      payload: { name: 'consolidator', goal: 'Consolidate memories into mind.md.', autostart: false },
    })
    expect(created.statusCode).toBe(201)
    const body = created.json()
    expect(body.loop).toEqual(expect.objectContaining({
      name: 'consolidator',
      isMain: false,
      enabled: true,
      entryCount: 0,
      config: expect.objectContaining({ name: 'consolidator', goal: 'Consolidate memories into mind.md.', enabled: true, autostart: false }),
    }))
    expect(Array.isArray(body.effectiveTools)).toBe(true)
    expect(body.kickoff).toBeNull()

    const listed = await server.inject({ method: 'GET', url: base })
    expect(listed.json().loops.map((l: { name: string }) => l.name)).toEqual(['main', 'consolidator'])

    const config = await server.inject({ method: 'GET', url: `/agents/${ref.id}/config` })
    expect(config.json().config.loops).toEqual([expect.objectContaining({ name: 'consolidator' })])

    const one = await server.inject({ method: 'GET', url: `${base}/consolidator` })
    expect(one.statusCode).toBe(200)
    expect(one.json().loop.name).toBe('consolidator')

    const duplicate = await server.inject({ method: 'POST', url: base, payload: { name: 'consolidator', goal: 'again' } })
    expect(duplicate.statusCode).toBe(409)
    const badName = await server.inject({ method: 'POST', url: base, payload: { name: 'Not Valid', goal: 'x' } })
    expect(badName.statusCode).toBe(400)
    const badTool = await server.inject({ method: 'POST', url: base, payload: { name: 'researcher', goal: 'x', tools: ['sys_update_config'] } })
    expect(badTool.statusCode).toBe(400)

    const disabled = await server.inject({ method: 'PATCH', url: `${base}/consolidator`, payload: { enabled: false } })
    expect(disabled.statusCode).toBe(200)
    expect(disabled.json()).toEqual(expect.objectContaining({ updated: ['enabled'], loop: expect.objectContaining({ enabled: false }) }))

    const rename = await server.inject({ method: 'PATCH', url: `${base}/consolidator`, payload: { name: 'other' } })
    expect(rename.statusCode).toBe(400)
    const empty = await server.inject({ method: 'PATCH', url: `${base}/consolidator`, payload: {} })
    expect(empty.statusCode).toBe(400)
    const patchMain = await server.inject({ method: 'PATCH', url: `${base}/main`, payload: { goal: 'x' } })
    expect(patchMain.statusCode).toBe(409)

    const deleted = await server.inject({ method: 'DELETE', url: `${base}/consolidator` })
    expect(deleted.statusCode).toBe(200)
    expect(deleted.json()).toEqual({ agentId: ref.id, name: 'consolidator', archivedEntries: 0, interruptedTurn: false })

    const gone = await server.inject({ method: 'DELETE', url: `${base}/consolidator` })
    expect(gone.statusCode).toBe(404)
    const deleteMain = await server.inject({ method: 'DELETE', url: `${base}/main` })
    expect(deleteMain.statusCode).toBe(409)
  })

  it('chats with, reads and clears one loop without touching main', async () => {
    const { ref, server } = setup()
    await server.inject({
      method: 'POST',
      url: `/agents/${ref.id}/loops`,
      payload: { name: 'researcher', goal: 'Research what main asks for.', autostart: false },
    })

    const chat = await server.inject({
      method: 'POST',
      url: `/agents/${ref.id}/chat`,
      payload: { text: 'hello researcher', loop: 'researcher' },
    })
    expect(chat.statusCode).toBe(202)
    await settle()

    const loopPage = await server.inject({ method: 'GET', url: `/agents/${ref.id}/loop?loop=researcher` })
    expect(loopPage.statusCode).toBe(200)
    expect(loopPage.json()).toEqual(expect.objectContaining({
      loop: 'researcher',
      entries: expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content_json: expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('hello researcher') })]),
        }),
      ]),
    }))

    const mainPage = await server.inject({ method: 'GET', url: `/agents/${ref.id}/loop` })
    expect(mainPage.json().loop).toBe('main')
    expect(JSON.stringify(mainPage.json().entries)).not.toContain('hello researcher')

    const history = await server.inject({ method: 'GET', url: `/agents/${ref.id}/chat?loop=researcher` })
    expect(history.statusCode).toBe(200)
    expect(history.json()).toEqual(expect.objectContaining({ loop: 'researcher', chatHistory: expect.objectContaining({ total: expect.any(Number) }) }))

    const info = await server.inject({ method: 'GET', url: `/agents/${ref.id}/loops/researcher` })
    expect(info.json().loop.entryCount).toBeGreaterThan(0)

    const cleared = await server.inject({ method: 'DELETE', url: `/agents/${ref.id}/chat?loop=researcher` })
    expect(cleared.statusCode).toBe(200)
    expect(cleared.json()).toEqual({ agentId: ref.id, loop: 'researcher', success: true })
    const after = await server.inject({ method: 'GET', url: `/agents/${ref.id}/loop?loop=researcher` })
    expect(after.json().total).toBe(0)

    expect((await server.inject({ method: 'GET', url: `/agents/${ref.id}/loop?loop=nope` })).statusCode).toBe(404)
    expect((await server.inject({ method: 'GET', url: `/agents/${ref.id}/chat?loop=nope` })).statusCode).toBe(404)
    expect((await server.inject({ method: 'POST', url: `/agents/${ref.id}/chat`, payload: { text: 'x', loop: 'nope' } })).statusCode).toBe(404)

    const abort = await server.inject({ method: 'POST', url: `/agents/${ref.id}/abort?loop=researcher` })
    expect(abort.statusCode).toBe(200)
    expect(abort.json()).toEqual({ success: true, loop: 'researcher' })
    expect((await server.inject({ method: 'POST', url: `/agents/${ref.id}/abort?loop=nope` })).statusCode).toBe(404)

    await server.inject({ method: 'PATCH', url: `/agents/${ref.id}/loops/researcher`, payload: { enabled: false } })
    await settle()
    expect((await server.inject({ method: 'POST', url: `/agents/${ref.id}/abort?loop=researcher` })).statusCode).toBe(409)
    const toDisabled = await server.inject({ method: 'POST', url: `/agents/${ref.id}/chat`, payload: { text: 'x', loop: 'researcher' } })
    expect(toDisabled.statusCode).toBe(409)
  })

  it('schedules a timer onto an inner loop and rejects unknown loops', async () => {
    const { ref, server } = setup()
    await server.inject({
      method: 'POST',
      url: `/agents/${ref.id}/loops`,
      payload: { name: 'consolidator', goal: 'Consolidate memories.', autostart: false },
    })

    const timer = await server.inject({
      method: 'POST',
      url: `/agents/${ref.id}/timers`,
      payload: { mode: 'interval', every_ms: 3_600_000, scope: ['agent'], loop: 'consolidator', payload: 'consolidate' },
    })
    expect(timer.statusCode).toBe(200)
    const timers = await server.inject({ method: 'GET', url: `/agents/${ref.id}/timers` })
    expect(timers.json().timers).toEqual([expect.objectContaining({ id: timer.json().id, loop: 'consolidator' })])

    const unknown = await server.inject({
      method: 'POST',
      url: `/agents/${ref.id}/timers`,
      payload: { mode: 'interval', every_ms: 60_000, scope: ['agent'], loop: 'nope' },
    })
    expect(unknown.statusCode).toBe(404)

    const id = timer.json().id
    const moved = await server.inject({
      method: 'PUT',
      url: `/agents/${ref.id}/timers/${id}`,
      payload: { mode: 'interval', every_ms: 1_800_000, scope: ['agent'], loop: 'main', payload: 'consolidate' },
    })
    expect(moved.statusCode).toBe(200)
    const afterMove = (await server.inject({ method: 'GET', url: `/agents/${ref.id}/timers` })).json().timers
    expect(afterMove).toEqual([expect.objectContaining({ id })])
    expect(afterMove[0].loop ?? 'main').toBe('main')

    const back = await server.inject({
      method: 'PUT',
      url: `/agents/${ref.id}/timers/${id}`,
      payload: { mode: 'interval', every_ms: 1_800_000, scope: ['agent'], loop: 'consolidator' },
    })
    expect(back.statusCode).toBe(200)
    expect((await server.inject({ method: 'GET', url: `/agents/${ref.id}/timers` })).json().timers).toEqual([expect.objectContaining({ id, loop: 'consolidator' })])

    const kept = await server.inject({ method: 'PUT', url: `/agents/${ref.id}/timers/${id}`, payload: { mode: 'interval', every_ms: 900_000, scope: ['agent'] } })
    expect(kept.statusCode).toBe(200)
    expect((await server.inject({ method: 'GET', url: `/agents/${ref.id}/timers` })).json().timers[0].loop).toBe('consolidator')

    const moveUnknown = await server.inject({ method: 'PUT', url: `/agents/${ref.id}/timers/${id}`, payload: { mode: 'interval', every_ms: 60_000, loop: 'nope' } })
    expect(moveUnknown.statusCode).toBe(404)
  })

  it('clears a loop model / compaction override with null', async () => {
    const { ref, server } = setup()
    const base = `/agents/${ref.id}/loops`
    await server.inject({ method: 'POST', url: base, payload: { name: 'critic', goal: 'Review drafts.', autostart: false, compact_threshold: 50_000 } })
    const set = await server.inject({ method: 'GET', url: `${base}/critic` })
    expect(set.json().loop.config.compact_threshold).toBe(50_000)

    const cleared = await server.inject({ method: 'PATCH', url: `${base}/critic`, payload: { compact_threshold: null, model: null } })
    expect(cleared.statusCode).toBe(200)
    expect(cleared.json().updated).toEqual(expect.arrayContaining(['compact_threshold', 'model']))
    const after = await server.inject({ method: 'GET', url: `${base}/critic` })
    expect(after.json().loop.config.compact_threshold).toBeUndefined()
    expect(after.json().loop.config.model).toBeUndefined()

    const badNull = await server.inject({ method: 'PATCH', url: `${base}/critic`, payload: { goal: null } })
    expect(badNull.statusCode).toBe(400)
  })

  it('compacts one loop on demand and lists asks with their loop', async () => {
    const { ref, server } = setup()
    await server.inject({ method: 'POST', url: `/agents/${ref.id}/loops`, payload: { name: 'researcher', goal: 'Research.', autostart: false } })

    const empty = await server.inject({ method: 'POST', url: `/agents/${ref.id}/compact?loop=researcher` })
    expect(empty.statusCode).toBe(409)
    expect((await server.inject({ method: 'POST', url: `/agents/${ref.id}/compact?loop=nope` })).statusCode).toBe(404)

    await server.inject({ method: 'POST', url: `/agents/${ref.id}/chat`, payload: { text: 'find the standings API notes', loop: 'researcher' } })
    await settle()
    const compacted = await server.inject({ method: 'POST', url: `/agents/${ref.id}/compact?loop=researcher` })
    expect(compacted.statusCode).toBe(200)
    expect(compacted.json()).toEqual({ agentId: ref.id, loop: 'researcher', success: true })

    const asks = await server.inject({ method: 'GET', url: `/agents/${ref.id}/asks` })
    expect(asks.json()).toEqual({ agentId: ref.id, asks: [] })
    const answer = await server.inject({ method: 'POST', url: `/agents/${ref.id}/asks/ask_1/respond`, payload: { answer: 'x', loop: 'researcher' } })
    expect(answer.statusCode).toBeGreaterThanOrEqual(400)
  })

  it('interrupts a turn and leaves the loop idle and working (unlike abort)', async () => {
    const { ref, server } = setup()
    const idle = await server.inject({ method: 'POST', url: `/agents/${ref.id}/interrupt` })
    expect(idle.statusCode).toBe(200)
    expect(idle.json()).toEqual({ success: true, interrupted: false, loop: 'main' })

    await server.inject({ method: 'POST', url: `/agents/${ref.id}/chat`, payload: { text: 'first' } })
    const interrupted = await server.inject({ method: 'POST', url: `/agents/${ref.id}/interrupt` })
    expect(interrupted.statusCode).toBe(200)
    expect(interrupted.json()).toEqual(expect.objectContaining({ success: true, loop: 'main' }))
    await settle()

    const status = await server.inject({ method: 'GET', url: `/agents/${ref.id}/status` })
    expect(status.json().runtimeState).not.toBe('stopped')
    const accepted = await server.inject({ method: 'POST', url: `/agents/${ref.id}/chat`, payload: { text: 'second' } })
    expect(accepted.statusCode).toBe(202)
    await settle()
    // The executor still runs turns: the second message got a reply.
    const entries = (await server.inject({ method: 'GET', url: `/agents/${ref.id}/loop` })).json().entries as Array<{ role: string; content_json: unknown }>
    const second = entries.findIndex(e => JSON.stringify(e.content_json).includes('second'))
    expect(second).toBeGreaterThanOrEqual(0)
    expect(entries.slice(second + 1).some(e => e.role === 'assistant')).toBe(true)
    expect((await server.inject({ method: 'POST', url: `/agents/${ref.id}/interrupt?loop=nope` })).statusCode).toBe(404)
  })

  it('stamps a side loop’s clear with its loop even outside a turn', async () => {
    const bus = new DaemonEventBus(500)
    registerDaemonEventBus(bus)
    const seen: DaemonEventEnvelope[] = []
    const unsubscribe = bus.subscribe(envelope => seen.push(envelope))
    try {
      const { ref, server } = setup()
      await server.inject({ method: 'POST', url: `/agents/${ref.id}/loops`, payload: { name: 'researcher', goal: 'Research.', autostart: false } })
      await server.inject({ method: 'POST', url: `/agents/${ref.id}/chat`, payload: { text: 'side', loop: 'researcher' } })
      await settle()
      await server.inject({ method: 'DELETE', url: `/agents/${ref.id}/chat?loop=researcher` })
      const cleared = seen.filter(e => e.event.agent_id === ref.id && e.event.event_type === 'loop.cleared')
      expect(cleared.length).toBeGreaterThan(0)
      expect(cleared.every(e => e.event.loop === 'researcher')).toBe(true)
    } finally {
      unsubscribe()
    }
  })

  it('stamps inner-loop umbilical events with the loop name and leaves main unstamped', async () => {
    const bus = new DaemonEventBus(500)
    registerDaemonEventBus(bus)
    const seen: DaemonEventEnvelope[] = []
    const unsubscribe = bus.subscribe(envelope => seen.push(envelope))
    try {
      const { ref, server } = setup()
      await server.inject({
        method: 'POST',
        url: `/agents/${ref.id}/loops`,
        payload: { name: 'researcher', goal: 'Research.', autostart: false },
      })
      await server.inject({ method: 'POST', url: `/agents/${ref.id}/chat`, payload: { text: 'side', loop: 'researcher' } })
      await settle()
      await server.inject({ method: 'POST', url: `/agents/${ref.id}/chat`, payload: { text: 'front' } })
      await settle()

      const mine = seen.filter(e => e.event.agent_id === ref.id && e.event.event_type === 'turn.completed')
      expect(mine.some(e => e.event.loop === 'researcher')).toBe(true)
      expect(mine.some(e => e.event.loop === undefined)).toBe(true)
    } finally {
      unsubscribe()
    }
  })
})
