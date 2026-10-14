/**
 * Client sessions over HTTP (design daemon-backend.md D5): the /client/*
 * routes through the shared daemon client, several clients on one daemon in
 * real time, REST writes and HIL reaching every session, slow and dropped
 * readers, delta latency on loopback, and the unchanged GET /events stream.
 */
import { mkdtempSync, readFileSync } from 'node:fs'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  const dir = join(tmpdir(), `adf-daemon-client-routes-${process.pid}`)
  return {
    app: { getPath: () => dir, on: () => {}, getName: () => 'adf-daemon-client-routes', getVersion: () => '0.0.0-test' },
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

import type { FastifyInstance } from 'fastify'
import { createDaemonHttpApi, type DaemonHttpApiOptions } from '../src/main/daemon/http-api'
import { DaemonEventBus, type DaemonEventEnvelope } from '../src/main/daemon/event-bus'
import { ClientSessionRegistry, runtimeDocumentHost, wireApprovalsToClientSessions, wireRuntimeToClientSessions } from '../src/main/daemon/client-sessions'
import { registerDaemonEventBus } from '../src/main/runtime/emit-umbilical'
import { RuntimeService } from '../src/main/runtime/runtime-service'
import { AgentRuntimeBuilder } from '../src/main/runtime/agent-runtime-builder'
import { approvalHub } from '../src/main/runtime/approval-hub'
import { withSource } from '../src/main/runtime/execution-context'
import { createHeadlessAgent, MockLLMProvider } from '../src/main/runtime/headless'
import { clearAllUmbilicalBuses } from '../src/main/runtime/umbilical-bus'
import { DaemonClient, type ClientFrame, type EventStream, type ResumeInfo, type StreamGap } from '../src/shared/daemon-client'
import type { AgentConfig } from '../src/shared/types/adf-v02.types'

afterAll(() => clearAllUmbilicalBuses())
// Real agents and megabytes through loopback sockets.
vi.setConfig({ testTimeout: 30_000 })

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
  approvalHub.clear()
})

async function waitFor(check: () => boolean, ms = 8000, what = 'condition'): Promise<void> {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await new Promise(r => setTimeout(r, 10))
  }
}

/** A file-backed agent the daemon builder can load, and its id. */
function agentFile(dir: string, name: string): { filePath: string; agentId: string } {
  const filePath = join(dir, `${name}.adf`)
  const created = createHeadlessAgent({ filePath, name, provider: new MockLLMProvider() })
  const agentId = created.workspace.getAgentConfig().id
  created.dispose()
  return { filePath, agentId }
}

async function serve(runtime: RuntimeService, opts: DaemonHttpApiOptions = {}, beforeListen?: (server: FastifyInstance) => void): Promise<{ server: FastifyInstance; client: DaemonClient; port: number }> {
  const server = createDaemonHttpApi(runtime, opts)
  beforeListen?.(server)
  await server.listen({ host: '127.0.0.1', port: 0 })
  cleanups.push(() => server.close())
  const port = (server.server.address() as AddressInfo).port
  return { server, client: new DaemonClient({ baseUrl: `http://127.0.0.1:${port}` }), port }
}

interface Reader {
  sessionId: string
  frames: ClientFrame[]
  gaps: StreamGap[]
  resumes: ResumeInfo[]
  stream: EventStream<ClientFrame>
  received: Array<{ frame: ClientFrame; at: number }>
}

async function reader(client: DaemonClient, opts: { focus?: string | null; client?: string; umbilical?: boolean } = {}): Promise<Reader> {
  const { sessionId } = await client.createClientSession({ client: opts.client ?? 'test', version: '1', ...(opts.umbilical ? { umbilical: true } : {}) })
  if (opts.focus !== undefined) await client.setClientSessionFocus(sessionId, opts.focus)
  const out: Reader = { sessionId, frames: [], gaps: [], resumes: [], received: [], stream: null as never }
  let open = false
  out.stream = client.clientSessionEvents(sessionId, {
    onEvent: (frame) => { out.frames.push(frame); out.received.push({ frame, at: Date.now() }) },
    onGap: (gap) => out.gaps.push(gap),
    onResume: (info) => out.resumes.push(info),
    onState: (info) => { if (info.state === 'open') open = true },
    minBackoffMs: 20,
    maxBackoffMs: 50,
  }).start()
  cleanups.push(() => out.stream.close())
  await waitFor(() => open, 5000, 'stream open')
  return out
}

const isDelta = (f: ClientFrame) => f.kind === 'executor' && f.event.type.includes('delta')
/** A frame without its cursor (sessions number their own), for comparing sessions. */
const bodyOf = (f: ClientFrame) => { const { cursor: _c, ...rest } = f as ClientFrame & { cursor: number }; return JSON.stringify(rest) }
const executorTypes = (r: Reader, agentId: string) => r.frames.filter(f => f.kind === 'executor' && f.agentId === agentId).map(f => f.kind === 'executor' && f.event.type)

describe('client session routes', () => {
  it('create, focus, documents and end through the shared client; refusals carry codes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-client-routes-'))
    const one = agentFile(dir, 'agent-1')
    const two = agentFile(dir, 'agent-2')
    const runtime = new RuntimeService({ settings: { get: (k: string) => (k === 'reviewedAgents' ? [one.agentId, two.agentId] : undefined) }, providerFactory: () => new MockLLMProvider(), agentRuntimeBuilder: new AgentRuntimeBuilder() })
    cleanups.push(() => unloadAll(runtime))
    const { server, client } = await serve(runtime)
    await runtime.loadAgent(one.filePath)

    expect((await server.inject({ method: 'POST', url: '/client/sessions', payload: { client: 'studio' } })).json()).toMatchObject({ code: 'bad_request' })
    expect((await server.inject({ method: 'POST', url: '/client/sessions', payload: { client: 'studio', version: '1', exitDaemonWhenClosed: 'yes' } })).statusCode).toBe(400)
    const created = await client.createClientSession({ client: 'studio', version: '0.7.0', exitDaemonWhenClosed: false })
    expect(created).toEqual({ sessionId: expect.any(String), epoch: expect.any(String) })

    expect(await client.setClientSessionFocus(created.sessionId, 'agent-1')).toEqual({ sessionId: created.sessionId, focus: one.agentId })
    expect(await client.setClientSessionFocus(created.sessionId, null)).toEqual({ sessionId: created.sessionId, focus: null })
    expect((await server.inject({ method: 'PUT', url: `/client/sessions/${created.sessionId}/focus`, payload: { agentId: 3 } })).statusCode).toBe(400)

    // Open documents (W2-A): a running agent's file and a closed one; the holder is the session, never named in the answer.
    const held = await client.holdClientSessionDocument(created.sessionId, { filePath: one.filePath })
    expect(held).toMatchObject({ agentId: one.agentId, running: true, holders: 1 })
    expect(await client.holdClientSessionDocument(created.sessionId, { filePath: two.filePath })).toMatchObject({ agentId: two.agentId, running: false })
    expect(JSON.stringify(held)).not.toContain(created.sessionId)
    expect(runtime.getAgentOrDocument(two.agentId)).toBeTruthy()
    await expect(client.holdClientSessionDocument(created.sessionId, { filePath: join(dir, 'missing.adf') })).rejects.toMatchObject({ status: 404 })
    await expect(client.releaseClientSessionDocument(created.sessionId, randomUUID())).rejects.toMatchObject({ status: 404, body: { code: 'document_not_held' } })
    expect(await client.releaseClientSessionDocument(created.sessionId, one.agentId)).toEqual({ sessionId: created.sessionId, agentId: one.agentId, released: true })

    // Ending the session releases the rest: the closed file's document closes.
    expect(await client.endClientSession(created.sessionId)).toEqual({ sessionId: created.sessionId, ended: true })
    expect(runtime.getAgentOrDocument(two.agentId)).toBeUndefined()
    await expect(client.endClientSession(created.sessionId)).rejects.toMatchObject({ status: 404, body: { code: 'session_not_found' } })
    const events = await server.inject({ method: 'GET', url: `/client/sessions/${created.sessionId}/events` })
    expect(events.statusCode).toBe(404)
    expect(events.json()).toMatchObject({ code: 'session_not_found' })
    expect((await server.inject({ method: 'GET', url: `/client/sessions/${randomUUID()}/events?since=-1` })).statusCode).toBe(404)
  })

  it('orphan rule through HTTP: a Studio session that disconnects and expires stops a Studio-started daemon', async () => {
    const runtime = new RuntimeService({ enforceReviewGate: false })
    const requestShutdown = vi.fn()
    const sessions = new ClientSessionRegistry({ expiryMs: 60, startedBy: 'studio', requestShutdown, log: () => {} })
    const { client } = await serve(runtime, { requestShutdown, routes: { startedBy: 'studio', clientSessions: sessions } })
    const { sessionId } = await client.createClientSession({ client: 'studio', version: '1', exitDaemonWhenClosed: true })
    let open = false
    const stream = client.clientSessionEvents(sessionId, { onEvent: () => {}, onState: (s) => { if (s.state === 'open') open = true } }).start()
    await waitFor(() => open)
    await new Promise(r => setTimeout(r, 150))
    expect(requestShutdown).not.toHaveBeenCalled() // connected: never expires
    stream.close()
    await waitFor(() => requestShutdown.mock.calls.length === 1, 2000, 'orphan shutdown')
    expect(sessions.has(sessionId)).toBe(false)
  })
})

describe('several clients on one daemon, in real time', () => {
  async function fleet(beforeListen?: (server: FastifyInstance) => void) {
    const dir = mkdtempSync(join(tmpdir(), 'adf-client-fleet-'))
    const one = agentFile(dir, 'agent-1')
    const two = agentFile(dir, 'agent-2')
    const runtime = new RuntimeService({
      settings: { get: (k: string) => (k === 'reviewedAgents' ? [one.agentId, two.agentId] : undefined) },
      providerFactory: () => new MockLLMProvider({ tokensPerResponse: 60, streamDeltas: true }),
      agentRuntimeBuilder: new AgentRuntimeBuilder(),
    })
    cleanups.push(() => unloadAll(runtime))
    const bus = new DaemonEventBus(5000)
    registerDaemonEventBus(bus)
    const served = await serve(runtime, { eventBus: bus }, beforeListen)
    await runtime.loadAgent(one.filePath)
    await runtime.loadAgent(two.filePath)
    return { runtime, one, two, bus, ...served }
  }

  it('three sessions, two focused on agent-1: the same non-delta frames per agent, deltas only to the focused two; a TUI session sees the same', async () => {
    const { runtime, client, one, two, bus } = await fleet()
    // /events streams agent-1's tokens too; the session streams must not carry them twice.
    await runtime.setAgentConfig(one.agentId, { ...runtime.getAgentConfig(one.agentId).config, umbilical: { ...(runtime.getAgentConfig(one.agentId).config.umbilical ?? {}), stream_deltas: true } } as never)
    const busDeltas: string[] = []
    cleanups.push(bus.subscribe(e => { if (e.event.event_type === 'turn.delta') busDeltas.push(e.event.agent_id ?? '') }))
    const a = await reader(client, { focus: one.agentId })
    const b = await reader(client, { focus: 'agent-1' })
    const c = await reader(client, { focus: null })
    const tui = await reader(client, { focus: one.agentId, client: 'tui', umbilical: true })
    await Promise.all([runtime.sendChat(one.agentId, 'hello one'), runtime.sendChat(two.agentId, 'hello two')])
    for (const r of [a, b, c, tui]) {
      await waitFor(() => executorTypes(r, one.agentId).includes('turn_complete') && executorTypes(r, two.agentId).includes('turn_complete'), 8000, 'both turns')
    }
    await new Promise(r => setTimeout(r, 100))
    for (const agentId of [one.agentId, two.agentId]) {
      const nonDelta = (r: Reader) => r.frames.filter(f => !isDelta(f) && f.kind !== 'umbilical' && 'agentId' in f && f.agentId === agentId)
      const label = (f: ClientFrame) => f.kind === 'executor' ? `executor:${f.event.type}` : f.kind === 'host' ? `host:${f.type}` : f.kind === 'push' ? `push:${f.topic}` : f.kind
      expect(nonDelta(a).length).toBeGreaterThan(3)
      // Same frames, same per-agent order, everywhere.
      for (const r of [b, c, tui]) expect(nonDelta(r).map(label)).toEqual(nonDelta(a).map(label))
      // Sessions focused alike get identical frames; an unfocused one gets each frame in full or as a marked stub.
      expect(nonDelta(b).map(bodyOf)).toEqual(nonDelta(a).map(bodyOf))
      expect(nonDelta(tui).map(bodyOf)).toEqual(nonDelta(a).map(bodyOf))
      nonDelta(c).forEach((f, i) => {
        if (!('stripped' in f)) expect(bodyOf(f)).toEqual(bodyOf(nonDelta(a)[i]))
      })
    }
    // The TUI session also gets the umbilical envelopes, never turn.delta: its tokens are the executor deltas.
    const umbilical = tui.frames.filter(f => f.kind === 'umbilical')
    expect(umbilical.some(f => f.kind === 'umbilical' && f.event.event_type === 'turn.completed')).toBe(true)
    expect(umbilical.filter(f => f.kind === 'umbilical' && f.event.event_type === 'turn.delta')).toEqual([])
    expect(busDeltas).toContain(one.agentId)
    expect(a.frames.some(f => f.kind === 'umbilical')).toBe(false)
    const deltas = (r: Reader, agentId: string) => r.frames.filter(f => isDelta(f) && f.kind === 'executor' && f.agentId === agentId).map(bodyOf)
    expect(deltas(a, one.agentId).length).toBeGreaterThan(0)
    expect(deltas(b, one.agentId)).toEqual(deltas(a, one.agentId))
    expect(deltas(tui, one.agentId)).toEqual(deltas(a, one.agentId))
    expect(deltas(c, one.agentId)).toEqual([])
    for (const r of [a, b, c]) expect(deltas(r, two.agentId)).toEqual([])
  })

  it('a REST write by one client reaches every other session as the frame an agent edit raises', async () => {
    const { client, one } = await fleet()
    const writer = await reader(client, { focus: one.agentId, client: 'studio' })
    const others = [await reader(client, { focus: one.agentId, client: 'tui' }), await reader(client, { focus: null, client: 'studio-2' })]
    const asWriter = client.withClientSession(writer.sessionId)
    const a = `/agents/${one.agentId}`

    const { config } = await asWriter.request<{ config: AgentConfig }>('GET', `${a}/config`)
    await asWriter.request('PUT', `${a}/config`, { body: { ...config, description: 'edited by the writer' } })
    await asWriter.request('PUT', `${a}/document`, { body: { content: '# From the writer' } })
    await asWriter.request('PUT', `${a}/files/content`, { query: { path: 'notes/a.md' }, body: { content: 'note' } })
    await asWriter.request('DELETE', `${a}/inbox`)
    // A client without a session (the CLI) edits too: every session gets it.
    await client.request('PUT', `${a}/config`, { body: { ...config, description: 'edited by the cli' } })

    const seen = (r: Reader) => r.frames
      .filter(f => (f.kind === 'push' && f.agentId === one.agentId) || (f.kind === 'executor' && f.agentId === one.agentId && ['file_updated', 'document_updated'].includes(f.event.type)))
      .map(f => f.kind === 'push'
        ? `${f.topic}${f.topic === 'config_changed' ? `:${(f.payload as { config: AgentConfig }).config.description}` : ''}`
        : f.kind === 'executor' ? `${f.event.type}:${JSON.stringify((f.event.payload as { content?: string; path?: string }).path ?? (f.event.payload as { content?: string }).content)}` : '')
    const expected = ['config_changed:edited by the writer', 'document_updated:"# From the writer"', 'file_updated:"notes/a.md"', 'inbox', 'config_changed:edited by the cli']
    for (const r of others) await waitFor(() => seen(r).length >= expected.length, 5000, 'write frames')
    for (const r of others) expect(seen(r)).toEqual(expected)
    await waitFor(() => seen(writer).length >= 2)
    // The writer's own echoes are skipped, as embedded Studio never echoes its own edits.
    expect(seen(writer)).toEqual(['inbox', 'config_changed:edited by the cli'])
    expect(others[0].frames.find(f => f.kind === 'push' && f.topic === 'inbox')).toMatchObject({ payload: { inbox: { version: 1, messages: [] } } })
  })

  it('a chat sent echoed by one session: its trigger_message reaches every other session, not the sender', async () => {
    const { client, one } = await fleet()
    const sender = await reader(client, { focus: one.agentId, client: 'studio' })
    const other = await reader(client, { focus: one.agentId, client: 'studio-2' })
    const { turnId } = await client.withClientSession(sender.sessionId).request<{ turnId: string }>('POST', `/agents/${one.agentId}/chat`, { body: { text: 'hello from the sender', echoed: true } })
    const turnEnded = (r: Reader) => r.frames.some(f => f.kind === 'executor' && f.agentId === one.agentId && f.event.type === 'turn_complete')
    await waitFor(() => turnEnded(sender) && turnEnded(other), 8000, 'turn complete on both sessions')
    const triggers = (r: Reader) => r.frames.filter(f => f.kind === 'executor' && f.agentId === one.agentId && f.event.type === 'trigger_message')
    expect(triggers(other)).toHaveLength(1)
    expect(JSON.stringify(triggers(other)[0])).toContain('hello from the sender')
    expect(triggers(sender)).toHaveLength(0)
    expect(turnId).toMatch(/^turn_/)
  })

  it('echo suppression is per event: an agent write raised during a client PUT still reaches the writer', async () => {
    // The client's request is held open 300 ms before its handler runs; the agent writes meanwhile, in its own turn.
    let inRequest: () => void = () => {}
    const requestOpen = new Promise<void>(resolve => { inRequest = resolve })
    const { runtime, client, one } = await fleet((server) => {
      server.addHook('onRequest', async (request) => {
        if (request.method === 'PUT' && request.url.includes('/files/content')) { inRequest(); await new Promise(r => setTimeout(r, 300)) }
      })
    })
    const writer = await reader(client, { focus: one.agentId })
    const paths = () => writer.frames.filter(f => f.kind === 'executor' && f.event.type === 'file_updated').map(f => f.kind === 'executor' && (f.event.payload as { path: string }).path)
    const put = client.withClientSession(writer.sessionId).request('PUT', `/agents/${one.agentId}/files/content`, { query: { path: 'notes/client.md' }, body: { content: 'from the client' } })
    await requestOpen
    withSource('agent:turn-x', one.agentId, () => { runtime.writeAgentFile(one.agentId, 'notes/agent.md', { content: 'from the agent' }) })
    await put
    await waitFor(() => paths().includes('notes/agent.md'), 5000, 'agent write')
    await new Promise(r => setTimeout(r, 100))
    expect(paths()).toEqual(['notes/agent.md'])
  })

  it('an agent turn a client started reaches that client: its file, document and config frames are not suppressed', async () => {
    const { runtime, client, one } = await fleet()
    const studio = await reader(client, { focus: one.agentId, client: 'studio' })
    const asStudio = client.withClientSession(studio.sessionId)
    // The turn (queued by the client's POST /chat) writes a file and document.md, and its config changes.
    const steps = [
      { name: 'fs_write', input: { mode: 'write', path: 'notes/turn.md', content: 'written in the turn' } },
      { name: 'fs_write', input: { mode: 'write', path: 'document.md', content: '# Written in the turn' } },
    ]
    let call = 0
    const provider = {
      name: 'scripted', modelId: 'scripted-v1',
      async createMessage() {
        const step = steps[call++]
        if (call === 2) {
          // Mid-turn, the running config changes (as sys_update_config would).
          const { config } = runtime.getAgentConfig(one.agentId)
          await runtime.setAgentConfig(one.agentId, { ...config, description: 'changed in the turn' })
        }
        if (!step) return { id: 'end', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }
        return { id: `s${call}`, content: [{ type: 'tool_use', id: `tu${call}`, name: step.name, input: step.input }], stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } }
      },
      async validateConfig() { return { valid: true } },
    }
    runtime.getLoadedAgent(one.agentId)!.agent.executor.updateProvider(provider as never)
    await asStudio.request('POST', `/agents/${one.agentId}/chat`, { body: { text: 'write things' } })
    const seen = () => studio.frames.filter(f => (f.kind === 'executor' && ['file_updated', 'document_updated'].includes(f.event.type)) || (f.kind === 'push' && f.topic === 'config_changed'))
      .map(f => f.kind === 'executor' ? `${f.event.type}:${String((f.event.payload as { path?: string }).path ?? '')}` : 'config_changed')
    await waitFor(() => seen().includes('file_updated:notes/turn.md') && seen().includes('document_updated:') && seen().includes('config_changed'), 8000, 'turn frames')
    // The client's own PUT is still suppressed.
    const before = seen().length
    await asStudio.request('PUT', `/agents/${one.agentId}/files/content`, { query: { path: 'notes/own.md' }, body: { content: 'mine' } })
    await new Promise(r => setTimeout(r, 150))
    expect(seen().slice(before)).toEqual([])
  })

  it('a HIL request reaches every session; one session resolves it and every session sees the resolution', async () => {
    const { runtime, client, one } = await fleet()
    const sessions = [await reader(client, { focus: one.agentId }), await reader(client, { focus: null }), await reader(client, { focus: one.agentId })]
    const executor = runtime.getLoadedAgent(one.agentId)!.agent.executor
    const pending = executor.requestHilApproval('fs_write', { path: 'a.md', content: 'x' })
    const requestId = executor.getPendingApprovals().at(-1)!.requestId
    const types = (r: Reader) => executorTypes(r, one.agentId)
    for (const r of sessions) await waitFor(() => types(r).includes('tool_approval_request'), 5000, 'approval request')
    const approvals = (r: Reader) => r.frames.filter(f => f.kind === 'push' && f.topic === 'approvals').map(f => f.kind === 'push' && (f.payload as { pending: Array<{ requestId: string }> }).pending.map(p => p.requestId))
    for (const r of sessions) await waitFor(() => approvals(r).some(ids => ids.includes(requestId)), 5000, 'approvals snapshot')

    await client.withClientSession(sessions[1].sessionId).request('POST', `/agents/${one.agentId}/tasks/${requestId}/resolve`, { body: { action: 'approve' } })
    await expect(pending).resolves.toMatchObject({ approved: true })
    for (const r of sessions) {
      await waitFor(() => types(r).includes('tool_approval_resolved'), 5000, 'resolution')
      await waitFor(() => { const last = approvals(r).at(-1); return !!last && !last.includes(requestId) }, 5000, 'approvals cleared')
    }
    const resolved = sessions.map(r => r.frames.filter(f => f.kind === 'executor' && f.event.type === 'tool_approval_resolved'))
    expect(resolved[2].map(bodyOf)).toEqual(resolved[0].map(bodyOf))
    // The unfocused session gets the same resolution as a stub (its approvals snapshot carries the rest).
    expect(resolved[1].map(f => f.kind === 'executor' && f.event.type)).toEqual(resolved[0].map(f => f.kind === 'executor' && f.event.type))
  })
})

describe('slow and dropped readers', () => {
  /** A raw SSE reader that can stop reading (a slow client) and resume. */
  function rawReader(port: number, path: string) {
    const blocks: Array<{ event?: string; id?: string; data: Record<string, unknown> }> = []
    let res: IncomingMessage | null = null
    let buffer = ''
    const req = httpRequest({ host: '127.0.0.1', port, path, headers: { Accept: 'text/event-stream' } }, (response) => {
      res = response
      response.setEncoding('utf-8')
      response.on('data', (chunk: string) => {
        buffer += chunk
        let at = buffer.indexOf('\n\n')
        while (at >= 0) {
          const block = buffer.slice(0, at)
          buffer = buffer.slice(at + 2)
          const parsed: { event?: string; id?: string; data?: Record<string, unknown> } = {}
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) parsed.event = line.slice(7)
            else if (line.startsWith('id: ')) parsed.id = line.slice(4)
            else if (line.startsWith('data: ')) parsed.data = JSON.parse(line.slice(6))
          }
          if (parsed.data) blocks.push(parsed as { data: Record<string, unknown> })
          at = buffer.indexOf('\n\n')
        }
      })
    })
    req.end()
    cleanups.push(() => req.destroy())
    return {
      blocks,
      ready: () => res !== null,
      pause: () => res?.pause(),
      resume: () => res?.resume(),
      close: () => req.destroy(),
    }
  }

  function syntheticSetup(sessions: ClientSessionRegistry) {
    const runtime = new RuntimeService({ enforceReviewGate: false })
    cleanups.push(wireRuntimeToClientSessions(sessions, runtime))
    return runtime
  }

  it('a slow session gets stream.gap with the count; the fast sessions get every frame, within the latency budget', async () => {
    // Small rings, so the paused reader overflows its own however much the sockets buffer.
    const sessions = new ClientSessionRegistry({ ringFrames: 512, ringChars: 4 * 1024 * 1024, log: () => {} })
    const runtime = syntheticSetup(sessions)
    const { client, port } = await serve(runtime, { routes: { clientSessions: sessions } })
    const agentId = randomUUID()
    const fast = [await reader(client, { focus: agentId }), await reader(client, { focus: agentId })]
    const { sessionId: slowId } = await client.createClientSession({ client: 'slow', version: '1' })
    sessions.setFocus(slowId, agentId)
    const slow = rawReader(port, `/client/sessions/${slowId}/events`)
    await waitFor(() => slow.ready() && slow.blocks.length > 0)
    slow.pause()

    const content = 'r'.repeat(32 * 1024)
    const total = 1000
    for (let i = 0; i < total; i++) {
      runtime.emit('agent-event', { agentId, filePath: null, event: { type: 'tool_call_result', payload: { i, sentAt: Date.now(), result: { content, isError: false } }, timestamp: Date.now() } })
      runtime.emit('agent-event', { agentId, filePath: null, event: { type: 'text_delta_batch', payload: { delta: `d${i}`, sentAt: Date.now() }, timestamp: Date.now() } })
      if (i % 10 === 0) await new Promise(r => setTimeout(r, 10))
    }
    for (const r of fast) await waitFor(() => r.frames.length >= total * 2, 15_000, 'fast readers')
    for (const r of fast) {
      expect(r.gaps).toEqual([])
      expect(r.frames.map(f => f.cursor)).toEqual(Array.from({ length: total * 2 }, (_, i) => i + 1))
      const latencies = r.received.filter(x => isDelta(x.frame)).map(x => x.at - ((x.frame as { event: { payload: { sentAt: number } } }).event.payload.sentAt))
      expect(percentile(latencies, 95)).toBeLessThanOrEqual(50)
    }
    expect(sessions.stats(slowId)).toMatchObject({ paused: true })
    expect(sessions.stats(slowId).chars).toBeLessThanOrEqual(4 * 1024 * 1024)
    expect(sessions.stats(slowId).frames).toBeLessThanOrEqual(512)

    slow.resume()
    await waitFor(() => sessions.stats(slowId).deliveredCursor === total * 2, 15_000, 'slow reader drained')
    await waitFor(() => slow.blocks.some(b => b.id === String(total * 2)), 15_000, 'slow reader last frame')
    const gaps = slow.blocks.filter(b => b.event === 'stream.gap')
    expect(gaps).toHaveLength(1)
    expect(gaps[0].data).toMatchObject({ reason: 'evicted', dropped: expect.any(Number) })
    const frames = slow.blocks.filter(b => b.id !== undefined)
    expect(frames.length + (gaps[0].data.dropped as number)).toBe(total * 2)
  })

  it('a session that drops mid-turn and reconnects with since= gets exactly the missed frames', async () => {
    const sessions = new ClientSessionRegistry({ log: () => {} })
    const runtime = syntheticSetup(sessions)
    const { client, port } = await serve(runtime, { routes: { clientSessions: sessions } })
    const agentId = randomUUID()
    const steady = await reader(client, { focus: agentId })
    const { sessionId, epoch } = await client.createClientSession({ client: 'flaky', version: '1' })
    sessions.setFocus(sessionId, agentId)
    const first = rawReader(port, `/client/sessions/${sessionId}/events`)
    await waitFor(() => first.blocks.length > 0)
    const emit = (i: number) => runtime.emit('agent-event', { agentId, filePath: null, event: { type: i % 2 ? 'text_delta' : 'tool_call_start', payload: { i }, timestamp: 1 } })
    for (let i = 0; i < 10; i++) emit(i)
    await waitFor(() => first.blocks.filter(b => b.id).length === 10)
    first.close()
    await waitFor(() => !sessions.stats(sessionId).connected)
    for (let i = 10; i < 25; i++) emit(i)
    const again = rawReader(port, `/client/sessions/${sessionId}/events?since=10&epoch=${epoch}`)
    await waitFor(() => again.blocks.filter(b => b.id).length === 15)
    expect(again.blocks.filter(b => b.event === 'stream.gap')).toEqual([])
    expect(again.blocks.filter(b => b.id).map(b => (b.data as { event: { payload: { i: number } } }).event.payload.i)).toEqual(Array.from({ length: 15 }, (_, i) => i + 10))
    expect(steady.frames.map(f => f.cursor)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1))
    expect(steady.gaps).toEqual([])
  })

  it('the shared client reconnects on its own and reports an exact resume', async () => {
    const sessions = new ClientSessionRegistry({ log: () => {} })
    const runtime = syntheticSetup(sessions)
    const { client } = await serve(runtime, { routes: { clientSessions: sessions } })
    const agentId = randomUUID()
    const r = await reader(client, { focus: agentId })
    const emit = (i: number) => runtime.emit('agent-event', { agentId, filePath: null, event: { type: 'tool_call_start', payload: { i }, timestamp: 1 } })
    for (let i = 0; i < 5; i++) emit(i)
    await waitFor(() => r.frames.length === 5)
    r.stream.reconnect()
    for (let i = 5; i < 8; i++) emit(i)
    await waitFor(() => r.frames.length === 8)
    await waitFor(() => r.resumes.length === 1)
    expect(r.resumes[0]).toMatchObject({ exact: true })
    expect(r.frames.map(f => f.cursor)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })
})

describe('delta latency on loopback', () => {
  it('p95 from executor emit to the client is at most 50 ms', async () => {
    const sessions = new ClientSessionRegistry({ log: () => {} })
    const runtime = new RuntimeService({ enforceReviewGate: false })
    cleanups.push(wireRuntimeToClientSessions(sessions, runtime))
    const { client } = await serve(runtime, { routes: { clientSessions: sessions } })
    const agentId = randomUUID()
    const others = Array.from({ length: 10 }, () => randomUUID())
    // Two more sessions on the same daemon, one of them focused on the same agent.
    await reader(client, { focus: agentId })
    await reader(client, { focus: null })
    const latencies: number[] = []
    const { sessionId } = await client.createClientSession({ client: 'latency', version: '1' })
    await client.setClientSessionFocus(sessionId, agentId)
    let open = false
    const stream = client.clientSessionEvents(sessionId, {
      onEvent: (frame) => { if (isDelta(frame) && frame.kind === 'executor') latencies.push(performance.now() - (frame.event.payload as { sentAt: number }).sentAt) },
      onState: (s) => { if (s.state === 'open') open = true },
    }).start()
    cleanups.push(() => stream.close())
    await waitFor(() => open)
    const samples = 200
    for (let i = 0; i < samples; i++) {
      // A delta batch as the executor flushes it, while ten other agents keep the stream busy.
      runtime.emit('agent-event', { agentId, filePath: null, event: { type: 'text_delta_batch', payload: { delta: 'word '.repeat(20), sentAt: performance.now() }, timestamp: Date.now() } })
      for (const other of others) runtime.emit('agent-event', { agentId: other, filePath: null, event: { type: 'tool_call_start', payload: { name: 'x' }, timestamp: Date.now() } })
      await new Promise(res => setTimeout(res, 5))
    }
    await waitFor(() => latencies.length === samples, 10_000, 'all deltas')
    const p95 = percentile(latencies, 95)
    process.stderr.write(`[client stream] delta latency p50 ${percentile(latencies, 50).toFixed(2)} ms, p95 ${p95.toFixed(2)} ms, max ${Math.max(...latencies).toFixed(2)} ms over ${latencies.length} frames
`)
    expect(p95).toBeLessThanOrEqual(50)
  })
})

describe('GET /events is unchanged', () => {
  /** Same normalization as runtime-service-events-snapshot.test.ts. */
  function normalize(event: DaemonEventEnvelope['event']): string {
    const source = event.source.replace(/^agent:.+$/, 'agent:<id>')
    const keys = Object.keys(event.payload ?? {}).sort().join(',')
    const state = event.event_type === 'agent.state.changed' ? ` state=${String((event.payload as { state?: unknown }).state)}` : ''
    return `${event.event_type} source=${source}${event.loop ? ` loop=${event.loop}` : ''}${state} {${keys}}`
  }

  /** The recorded snapshot of the first case there (load, startup turn, chat turn, state change, unload). */
  function recordedSnapshot(): string {
    const snap = readFileSync(join(__dirname, '__snapshots__', 'runtime-service-events-snapshot.test.ts.snap'), 'utf-8')
    const match = /exports\[`RuntimeService umbilical \/events output > is unchanged for load, startup turn, chat turn, state change and unload 1`\] = `\r?\n?"([\s\S]*?)"\r?\n?`;/.exec(snap)
    if (!match) throw new Error('snapshot not found')
    return match[1].replace(/\r\n/g, '\n')
  }

  it('the umbilical stream of an agent\'s life matches the recorded snapshot while client sessions stream it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-client-events-'))
    const { filePath, agentId } = agentFile(dir, 'agent-1')
    const bus = new DaemonEventBus(5000)
    registerDaemonEventBus(bus)
    const events: string[] = []
    cleanups.push(bus.subscribe(envelope => { if (envelope.event.agent_id === agentId) events.push(normalize(envelope.event)) }))
    const runtime = new RuntimeService({
      settings: { get: (key: string) => (key === 'reviewedAgents' ? [agentId] : undefined) },
      providerFactory: () => new MockLLMProvider({ tokensPerResponse: 10 }),
      agentRuntimeBuilder: new AgentRuntimeBuilder(),
    })
    const sessions = new ClientSessionRegistry({ log: () => {}, documents: runtimeDocumentHost(runtime) })
    cleanups.push(wireRuntimeToClientSessions(sessions, runtime))
    cleanups.push(wireApprovalsToClientSessions(sessions, approvalHub))
    const { client } = await serve(runtime, { eventBus: bus, routes: { clientSessions: sessions } })
    const focused = await reader(client, { focus: agentId })
    const unfocused = await reader(client, { focus: null })

    const ref = await runtime.loadAgent(filePath)
    await runtime.startAgent(ref.id)
    await waitFor(() => events.some(e => e.startsWith('turn.completed')))
    await runtime.sendChat(ref.id, 'hello')
    runtime.setAgentDisplayState(ref.id, 'hibernate')
    await runtime.unloadAgent(ref.id)

    expect(events.join('\n')).toBe(recordedSnapshot())
    await waitFor(() => focused.frames.some(f => f.kind === 'host' && f.type === 'agent_stopped'))
    await waitFor(() => unfocused.frames.some(f => f.kind === 'host' && f.type === 'agent_stopped'))
  })

  it('the SSE bytes of an /events frame are JSON.stringify of the envelope', async () => {
    const bus = new DaemonEventBus(10)
    const envelope = bus.publish({ seq: 3, event_type: 'test.wire', timestamp: 7, source: 'system:test', agent_id: null, payload: { nested: { a: [1, 'two', null] }, empty: {} } })
    const { port } = await serve(new RuntimeService({ enforceReviewGate: false }), { eventBus: bus })
    const text = await new Promise<string>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: '/events?since=0' }, (res) => {
        let body = ''
        res.setEncoding('utf-8')
        res.on('data', (chunk: string) => {
          body += chunk
          if (body.includes('test.wire') && body.endsWith('\n\n')) { req.destroy(); resolve(body) }
        })
      })
      req.on('error', reject)
      req.end()
    })
    expect(text).toContain(`id: 1\nevent: test.wire\ndata: ${JSON.stringify(envelope)}\n\n`)
    expect(text).toContain(`event: stream.hello\ndata: ${JSON.stringify({ epoch: bus.epoch, oldestCursor: 1, latestCursor: 1 })}\n\n`)
  })
})

/** Unload every agent. Never shutdownAll: it latches the process-wide RuntimeGate for every later test. */
async function unloadAll(runtime: RuntimeService): Promise<void> {
  for (const agent of runtime.listAgents()) await runtime.unloadAgent(agent.id, { mode: 'immediate' }).catch(() => {})
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}
