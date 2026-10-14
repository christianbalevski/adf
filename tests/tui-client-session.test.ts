/**
 * The terminal app's store on the client-session stream of a real daemon
 * (design daemon-backend.md D5): the chat view's agent streams tokens with
 * `umbilical.stream_deltas` off, other agents update from non-delta frames,
 * a gap resyncs, and a Studio-like session on the same daemon sees the same
 * state. The old-daemon fallback is in tests/tui/client-session-fallback.test.ts.
 */
import { mkdtempSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  const dir = join(tmpdir(), `adf-tui-client-session-${process.pid}`)
  return {
    app: { getPath: () => dir, on: () => {}, getName: () => 'adf-tui-client-session', getVersion: () => '0.0.0-test' },
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
import { DaemonEventBus } from '../src/main/daemon/event-bus'
import { ClientSessionRegistry, loadedAgentDocumentHost, wireApprovalsToClientSessions, wireEventBusToClientSessions, wireRuntimeToClientSessions } from '../src/main/daemon/client-sessions'
import { CLIENT_API_VERSION } from '../src/main/daemon/routes/meta-routes'
import { registerDaemonEventBus } from '../src/main/runtime/emit-umbilical'
import { RuntimeService } from '../src/main/runtime/runtime-service'
import { AgentRuntimeBuilder } from '../src/main/runtime/agent-runtime-builder'
import { approvalHub } from '../src/main/runtime/approval-hub'
import { createHeadlessAgent, MockLLMProvider } from '../src/main/runtime/headless'
import { clearAllUmbilicalBuses } from '../src/main/runtime/umbilical-bus'
import { DaemonClient as TuiClient } from '../src/main/tui/api/client'
import { createTuiStore, type TuiStore } from '../src/main/tui/state/store'
import { transcriptKey } from '../src/main/tui/state/types'
import { DaemonClient, SUPPORTED_CLIENT_API_VERSION, type ClientFrame } from '../src/shared/daemon-client'

afterAll(() => clearAllUmbilicalBuses())
vi.setConfig({ testTimeout: 30_000 })

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
  approvalHub.clear()
})

async function waitFor(check: () => boolean, ms = 10_000, what = 'condition'): Promise<void> {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await new Promise(r => setTimeout(r, 10))
  }
}

/** Streams its answer in four pieces, 70 ms apart: longer than the executor's 50 ms delta flush, so a client sees it mid-turn. */
class SlowStreamProvider extends MockLLMProvider {
  override async createMessage(opts: Parameters<MockLLMProvider['createMessage']>[0]) {
    const result = await super.createMessage({ ...opts, onTextDelta: undefined })
    const text = (result.content[0] as { text?: string }).text ?? ''
    const size = Math.ceil(text.length / 4)
    for (let i = 0; i < text.length; i += size) {
      opts.onTextDelta?.(text.slice(i, i + size))
      await new Promise(r => setTimeout(r, 70))
    }
    return result
  }
}

function agentFile(dir: string, name: string): { filePath: string; agentId: string } {
  const filePath = join(dir, `${name}.adf`)
  const created = createHeadlessAgent({ filePath, name, provider: new MockLLMProvider() })
  const agentId = created.workspace.getAgentConfig().id
  created.dispose()
  return { filePath, agentId }
}

/** A daemon with agent-1 and agent-2 loaded, the umbilical bus, client sessions and a request log. */
async function daemon(opts: { ringFrames?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'adf-tui-session-'))
  const one = agentFile(dir, 'agent-1')
  const two = agentFile(dir, 'agent-2')
  const bus = new DaemonEventBus(5000)
  registerDaemonEventBus(bus)
  const runtime = new RuntimeService({
    settings: { get: (k: string) => (k === 'reviewedAgents' ? [one.agentId, two.agentId] : undefined) },
    providerFactory: () => new SlowStreamProvider({ tokensPerResponse: 120 }),
    agentRuntimeBuilder: new AgentRuntimeBuilder(),
  })
  cleanups.push(async () => { for (const a of runtime.listAgents()) await runtime.unloadAgent(a.id, { mode: 'immediate' }).catch(() => {}) })
  const sessions = new ClientSessionRegistry({ log: () => {}, documents: loadedAgentDocumentHost(runtime), resolveAgentId: (id) => runtime.getAgent(id)?.id ?? null, ...(opts.ringFrames ? { ringFrames: opts.ringFrames } : {}) })
  cleanups.push(wireRuntimeToClientSessions(sessions, runtime), wireEventBusToClientSessions(sessions, bus), wireApprovalsToClientSessions(sessions, approvalHub))
  const server = createDaemonHttpApi(runtime, { eventBus: bus, routes: { clientSessions: sessions } })
  await server.listen({ host: '127.0.0.1', port: 0 })
  cleanups.push(() => server.close())
  const baseUrl = `http://127.0.0.1:${(server.server.address() as AddressInfo).port}`
  await runtime.loadAgent(one.filePath)
  await runtime.loadAgent(two.filePath)
  const requests: string[] = []
  const fetchLog: typeof fetch = (input, init) => {
    const url = new URL(String(input))
    requests.push(`${init?.method ?? 'GET'} ${url.pathname}`)
    return fetch(input, init)
  }
  return { runtime, sessions, bus, one, two, baseUrl, requests, fetchLog }
}

async function tui(baseUrl: string, fetchImpl: typeof fetch, view = 'chat'): Promise<TuiStore> {
  const store = createTuiStore({ client: new TuiClient({ baseUrl, fetch: fetchImpl }), initialView: view, clientVersion: 'test' })
  cleanups.push(() => store.close())
  await store.start()
  return store
}

const items = (store: TuiStore, agentId: string) => store.getState().transcripts[transcriptKey(agentId, 'main')]?.items ?? []

describe('the terminal app on a client session', () => {
  it('speaks the daemon\'s client API version', () => {
    expect(SUPPORTED_CLIENT_API_VERSION).toBe(CLIENT_API_VERSION)
  })

  it('streams the chat view\'s agent token by token with umbilical.stream_deltas off; other agents update live without deltas', async () => {
    const { runtime, sessions, bus, one, two, baseUrl, fetchLog } = await daemon()
    const store = await tui(baseUrl, fetchLog)
    expect(store.liveMode).toBe('session')
    store.actions.selectAgent(one.agentId)
    await store.actions.ensureTranscript(one.agentId, 'main')
    const sessionId = () => [...(sessions as unknown as { sessions: Map<string, unknown> }).sessions.keys()][0]
    await waitFor(() => sessions.stats(sessionId()).focus === one.agentId, 5000, 'focus on agent-1')

    const turnDeltasOnBus: string[] = []
    cleanups.push(bus.subscribe(e => { if (e.event.event_type === 'turn.delta') turnDeltasOnBus.push(e.event.agent_id ?? '') }))
    let streamed = ''
    const states2 = new Set<string>()
    let agent2Streaming = false
    cleanups.push(store.subscribe(() => {
      for (const item of items(store, one.agentId)) if (item.kind === 'assistant' && item.streaming && item.text.length > streamed.length) streamed = item.text
      const state2 = store.getState().agents[two.agentId]?.executorState
      if (state2) states2.add(state2)
      if (items(store, two.agentId).some(i => (i.kind === 'assistant' || i.kind === 'thinking') && i.streaming)) agent2Streaming = true
    }))

    await store.actions.sendChat('hello agent-1')
    await runtime.sendChat(two.agentId, 'hello agent-2')
    await waitFor(() => {
      const list = items(store, one.agentId)
      return list.some(i => i.kind === 'assistant' && !i.streaming && i.text.length > 0) && store.getState().agents[one.agentId]?.executorState === 'idle'
    }, 15_000, 'agent-1 answer')
    await waitFor(() => store.getState().agents[two.agentId]?.executorState === 'idle' && states2.has('thinking'), 15_000, 'agent-2 live status')

    expect(turnDeltasOnBus).toEqual([]) // stream_deltas is off: /events carries no tokens
    expect(streamed.length).toBeGreaterThan(0) // yet the chat view streamed them
    const answer = items(store, one.agentId).filter(i => i.kind === 'assistant').at(-1)
    expect(answer && answer.kind === 'assistant' && answer.text.startsWith(streamed.slice(0, 20))).toBe(true)
    expect(states2.has('thinking')).toBe(true)
    expect(agent2Streaming).toBe(false)

    // The chat view closes: the focus goes with it.
    store.actions.setView('fleet')
    await waitFor(() => sessions.stats(sessionId()).focus === null, 5000, 'focus cleared')
  })

  it('a stream.gap on resume reloads agents, approvals and the open transcript', async () => {
    const { runtime, sessions, one, baseUrl, requests, fetchLog } = await daemon({ ringFrames: 8 })
    const store = await tui(baseUrl, fetchLog)
    store.actions.selectAgent(one.agentId)
    await store.actions.ensureTranscript(one.agentId, 'main')
    const sessionId = [...(sessions as unknown as { sessions: Map<string, unknown> }).sessions.keys()][0]
    await waitFor(() => sessions.stats(sessionId).connected)
    // One frame the app has, so its resume names a cursor.
    runtime.emit('agent-event', { agentId: one.agentId, filePath: null, event: { type: 'tool_call_start', payload: { name: 'first' }, timestamp: Date.now() } })
    await waitFor(() => sessions.stats(sessionId).deliveredCursor === sessions.stats(sessionId).latestCursor && sessions.stats(sessionId).latestCursor > 0)
    await new Promise(r => setTimeout(r, 200))
    const before = requests.length

    sessions.disconnect(sessionId)
    // More frames than the ring holds, while the app is away.
    for (let i = 0; i < 30; i++) runtime.emit('agent-event', { agentId: one.agentId, filePath: null, event: { type: 'tool_call_start', payload: { name: 'x', i }, timestamp: Date.now() } })
    await waitFor(() => store.getState().toasts.some(t => t.text.includes('Events were missed')), 10_000, 'gap toast')
    await waitFor(() => requests.slice(before).includes('GET /agents') && requests.slice(before).includes(`GET /agents/${one.agentId}/loop`) && requests.slice(before).includes(`GET /agents/${one.agentId}/tasks`), 10_000, 'resync requests')
    expect(sessions.stats(sessionId).dropped).toBeGreaterThan(0)
  })

  it('a Studio-like session and the terminal app on one daemon see the same state', async () => {
    const { runtime, one, two, baseUrl, fetchLog } = await daemon()
    const studio = new DaemonClient({ baseUrl })
    const { sessionId } = await studio.createClientSession({ client: 'studio', version: 'test' })
    await studio.setClientSessionFocus(sessionId, one.agentId)
    const frames: ClientFrame[] = []
    let open = false
    const stream = studio.clientSessionEvents(sessionId, { onEvent: f => frames.push(f), onState: s => { if (s.state === 'open') open = true } }).start()
    cleanups.push(() => stream.close())
    await waitFor(() => open)
    const store = await tui(baseUrl, fetchLog)
    store.actions.selectAgent(one.agentId)
    await store.actions.ensureTranscript(one.agentId, 'main')

    await store.actions.sendChat('same for everyone')
    await runtime.sendChat(two.agentId, 'and for agent-2')
    const done = (agentId: string) => frames.some(f => f.kind === 'executor' && f.agentId === agentId && f.event.type === 'turn_complete')
    await waitFor(() => done(one.agentId) && done(two.agentId), 15_000, 'turns')
    await waitFor(() => store.getState().agents[one.agentId]?.executorState === 'idle' && store.getState().agents[two.agentId]?.executorState === 'idle', 15_000, 'tui idle')

    // Studio's streamed text is the TUI's answer.
    const studioText = frames.filter(f => f.kind === 'executor' && f.agentId === one.agentId && f.event.type === 'text_delta_batch')
      .map(f => f.kind === 'executor' ? ((f.event.payload as { deltas: string[] }).deltas.join('')) : '').join('')
    await waitFor(() => items(store, one.agentId).some(i => i.kind === 'assistant' && !i.streaming && i.text.trim() === studioText.trim()), 10_000, 'same answer')
    // The last executor state each saw, per agent.
    for (const agentId of [one.agentId, two.agentId]) {
      const last = frames.filter(f => f.kind === 'executor' && f.agentId === agentId && f.event.type === 'state_changed').at(-1)
      expect(last && last.kind === 'executor' && (last.event.payload as { state: string }).state).toBe(store.getState().agents[agentId]?.executorState)
    }
  })
})
