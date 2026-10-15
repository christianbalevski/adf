/**
 * Client sessions (design daemon-backend.md D5): the per-session ring, focus
 * filtering, gaps, back-pressure, expiry and the orphan rule, and the frame
 * producers, against fake sinks and fake services. The HTTP side and real
 * agents are in daemon-client-routes.test.ts.
 */
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ClientSessionRegistry,
  runAsClientWrite,
  wireApprovalsToClientSessions,
  wireComputeToClientSessions,
  wireMeshToClientSessions,
  wireRuntimeToClientSessions,
  wireTrackedDirWatcherToClientSessions,
  withInstallProgress,
  type ClientDocumentHost,
  type ClientFrame,
  type ClientStreamSink,
} from '../src/main/daemon/client-sessions'
import { emitAgentConfigChanged } from '../src/main/runtime/agent-runtime-signals'
import type { RuntimeAgentEvent } from '../src/main/runtime/runtime-service'
import type { AgentExecutionEvent } from '../src/shared/types/ipc.types'

const AGENT_1 = randomUUID()
const AGENT_2 = randomUUID()
const FILE_1 = '/agents/agent-1.adf'
const FILE_2 = '/agents/agent-2.adf'

interface Parsed {
  event?: string
  id?: string
  data: Record<string, unknown>
}

/** A sink that records writes; `accept` false makes it refuse like a full socket. */
class FakeSink extends EventEmitter implements ClientStreamSink {
  text = ''
  accept = true
  destroyed = false
  writes = 0
  write(chunk: string): boolean {
    this.text += chunk
    this.writes++
    return this.accept
  }
  destroy(): void {
    this.destroyed = true
  }
  drain(): void {
    this.accept = true
    this.emit('drain')
  }
  blocks(): Parsed[] {
    const out: Parsed[] = []
    for (const block of this.text.split('\n\n')) {
      const parsed: Partial<Parsed> = {}
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) parsed.event = line.slice(7)
        else if (line.startsWith('id: ')) parsed.id = line.slice(4)
        else if (line.startsWith('data: ')) parsed.data = JSON.parse(line.slice(6))
      }
      if (parsed.data) out.push(parsed as Parsed)
    }
    return out
  }
  frames(): ClientFrame[] {
    return this.blocks().filter(b => b.id !== undefined).map(b => b.data as unknown as ClientFrame)
  }
  controls(name: string): Array<Record<string, unknown>> {
    return this.blocks().filter(b => b.event === name).map(b => b.data)
  }
}

const tick = () => new Promise(resolve => setImmediate(resolve))
const quiet = () => {}

let registries: ClientSessionRegistry[] = []
function registry(opts: ConstructorParameters<typeof ClientSessionRegistry>[0] = {}): ClientSessionRegistry {
  const sessions = new ClientSessionRegistry({ log: quiet, ...opts })
  registries.push(sessions)
  return sessions
}
afterEach(() => {
  for (const r of registries) r.dispose()
  registries = []
})

function exec(agentId: string, type: AgentExecutionEvent['type'], payload: unknown = {}, loop?: string): RuntimeAgentEvent {
  return { agentId, filePath: agentId === AGENT_1 ? FILE_1 : FILE_2, event: { type, payload, timestamp: 1, ...(loop ? { loop } : {}) } }
}

function open(sessions: ClientSessionRegistry, opts: { focus?: string; since?: number } = {}) {
  const { sessionId, epoch } = sessions.create({ client: 'test', version: '1' })
  if (opts.focus) sessions.setFocus(sessionId, opts.focus)
  const sink = new FakeSink()
  sessions.attach(sessionId, sink, opts.since !== undefined ? { since: opts.since } : {})
  return { sessionId, epoch, sink }
}

describe('client sessions: delivery', () => {
  it('delivers frames per agent in emission order, with contiguous cursors', async () => {
    const sessions = registry()
    const { sink } = open(sessions)
    for (let i = 0; i < 20; i++) {
      sessions.publishExecutor(exec(i % 2 ? AGENT_2 : AGENT_1, 'tool_call_start', { name: `t${i}` }))
      sessions.publishHost({ agentId: AGENT_1, filePath: FILE_1, type: 'agent_state_changed', payload: { filePath: FILE_1, state: 'active', i }, timestamp: 1 })
    }
    await tick()
    const frames = sink.frames()
    expect(frames.map(f => f.cursor)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1))
    const names = (agentId: string) => frames.filter(f => f.kind === 'executor' && f.agentId === agentId).map(f => (f.event.payload as { name: string }).name)
    expect(names(AGENT_1)).toEqual(['t0', 't2', 't4', 't6', 't8', 't10', 't12', 't14', 't16', 't18'])
    expect(names(AGENT_2)).toEqual(['t1', 't3', 't5', 't7', 't9', 't11', 't13', 't15', 't17', 't19'])
    expect(frames.filter(f => f.kind === 'host').map(f => (f as { payload: { i: number } }).payload.i)).toEqual(Array.from({ length: 20 }, (_, i) => i))
    // One socket write for the whole burst (after hello).
    expect(sink.writes).toBe(2)
  })

  it('three sessions, two focused on agent-1: same non-delta frames everywhere, deltas only for the focused two', async () => {
    const sessions = registry()
    const a = open(sessions, { focus: AGENT_1 })
    const b = open(sessions, { focus: AGENT_1 })
    const c = open(sessions, { focus: AGENT_2 })
    for (let i = 0; i < 5; i++) {
      sessions.publishExecutor(exec(AGENT_1, 'text_delta_batch', { delta: `x${i}` }))
      sessions.publishExecutor(exec(AGENT_1, 'thinking_delta', { delta: `t${i}` }))
      sessions.publishExecutor(exec(AGENT_1, 'tool_call_start', { name: `a1-${i}` }))
      sessions.publishExecutor(exec(AGENT_2, 'tool_call_start', { name: `a2-${i}` }))
    }
    sessions.publishExecutor(exec(AGENT_2, 'text_delta', { delta: 'c only' }))
    await tick()
    const nonDelta = (sink: FakeSink) => sink.frames().filter(f => f.kind === 'executor' && !f.event.type.includes('delta')).map(f => f.kind === 'executor' && (f.event.payload as { name: string }).name)
    expect(nonDelta(a.sink)).toEqual(nonDelta(c.sink))
    expect(nonDelta(b.sink)).toEqual(nonDelta(c.sink))
    const deltas = (sink: FakeSink) => sink.frames().filter(f => f.kind === 'executor' && f.event.type.includes('delta')).map(f => f.kind === 'executor' && `${f.agentId === AGENT_1 ? 1 : 2}:${(f.event.payload as { delta: string }).delta}`)
    expect(deltas(a.sink)).toEqual(['1:x0', '1:t0', '1:x1', '1:t1', '1:x2', '1:t2', '1:x3', '1:t3', '1:x4', '1:t4'])
    expect(deltas(b.sink)).toEqual(deltas(a.sink))
    expect(deltas(c.sink)).toEqual(['2:c only'])
  })

  it('a session without focus gets no deltas at all; focus by handle resolves to the id', async () => {
    const sessions = registry({ resolveAgentId: (id) => (id === 'agent-1' ? AGENT_1 : null) })
    const { sessionId, sink } = open(sessions)
    sessions.publishExecutor(exec(AGENT_1, 'text_delta', { delta: 'lost' }))
    expect(sessions.setFocus(sessionId, 'agent-1')).toBe(AGENT_1)
    sessions.publishExecutor(exec(AGENT_1, 'text_delta', { delta: 'kept' }))
    expect(sessions.setFocus(sessionId, null)).toBeNull()
    sessions.publishExecutor(exec(AGENT_1, 'text_delta', { delta: 'lost again' }))
    await tick()
    expect(sink.frames().map(f => f.kind === 'executor' && (f.event.payload as { delta: string }).delta)).toEqual(['kept'])
  })

  it('tool_call_result: full for the focused session, content stripped (with its size) for the others', async () => {
    const sessions = registry()
    const focused = open(sessions, { focus: AGENT_1 })
    const other = open(sessions, { focus: AGENT_2 })
    const content = 'x'.repeat(5000)
    sessions.publishExecutor(exec(AGENT_1, 'tool_call_result', { name: 'fs_read', id: 'tu-1', result: { content, isError: false }, targetPaths: ['a.md'] }))
    await tick()
    const [full] = focused.sink.frames()
    const [stripped] = other.sink.frames()
    expect(full).toMatchObject({ kind: 'executor', event: { payload: { result: { content, isError: false } } } })
    expect(full).not.toHaveProperty('stripped')
    expect(stripped).toMatchObject({ kind: 'executor', stripped: 'tool_result', event: { type: 'tool_call_result', payload: { name: 'fs_read', id: 'tu-1', result: { isError: false }, resultSize: 5000, targetPaths: ['a.md'] } } })
    expect(JSON.stringify(stripped)).not.toContain('xxxx')
  })

  it('serializes BigInt and cycles without throwing; undefined keys are absent', async () => {
    const sessions = registry()
    const { sink } = open(sessions, { focus: AGENT_1 })
    const cyclic: Record<string, unknown> = { name: 'loop' }
    cyclic.self = cyclic
    sessions.publishExecutor(exec(AGENT_1, 'tool_call_start', { big: 10n, cyclic, missing: undefined, list: [undefined, 1] }))
    await tick()
    const [frame] = sink.frames()
    expect(frame.kind === 'executor' && frame.event.payload).toEqual({ big: '10', cyclic: { name: 'loop', self: '[Circular]' }, list: [null, 1] })
  })
})

describe('client sessions: ring, gaps and resume', () => {
  it('keeps the newest 4096 frames; a resume past the window gets stream.gap, then the rest', async () => {
    const sessions = registry()
    const { sessionId } = sessions.create({ client: 'test', version: '1' })
    for (let i = 0; i < 5000; i++) sessions.publishExecutor(exec(AGENT_1, 'tool_call_start', { i }))
    expect(sessions.stats(sessionId)).toMatchObject({ frames: 4096, oldestCursor: 905, latestCursor: 5000 })
    const sink = new FakeSink()
    sessions.attach(sessionId, sink, { since: 0 })
    await tick()
    expect(sink.controls('stream.gap')).toEqual([expect.objectContaining({ reason: 'evicted', requestedCursor: 0, oldestCursor: 905, latestCursor: 5000, dropped: 904 })])
    const frames = sink.frames()
    expect(frames.length).toBe(4096)
    expect(frames[0].cursor).toBe(905)
    expect(sessions.stats(sessionId).dropped).toBe(904)
  })

  it('an exact resume replays only what the client missed, with no gap', async () => {
    const sessions = registry()
    const { sessionId, epoch, sink } = open(sessions)
    for (let i = 0; i < 10; i++) sessions.publishExecutor(exec(AGENT_1, 'tool_call_start', { i }))
    await tick()
    sessions.detach(sessionId, sink)
    for (let i = 10; i < 15; i++) sessions.publishExecutor(exec(AGENT_1, 'tool_call_start', { i }))
    const again = new FakeSink()
    sessions.attach(sessionId, again, { since: 10, epoch })
    await tick()
    expect(again.controls('stream.hello')).toEqual([{ epoch, oldestCursor: 1, latestCursor: 15 }])
    expect(again.controls('stream.gap')).toEqual([])
    expect(again.frames().map(f => f.cursor)).toEqual([11, 12, 13, 14, 15])
  })

  it('a cursor from another epoch gets stream.gap epoch_changed and the whole ring', async () => {
    const sessions = registry()
    const { sessionId, epoch } = sessions.create({ client: 'test', version: '1' })
    for (let i = 0; i < 3; i++) sessions.publishExecutor(exec(AGENT_1, 'tool_call_start', { i }))
    const sink = new FakeSink()
    sessions.attach(sessionId, sink, { since: 2, epoch: randomUUID() })
    await tick()
    expect(sink.controls('stream.gap')).toEqual([expect.objectContaining({ reason: 'epoch_changed', epoch, requestedCursor: 2 })])
    expect(sink.frames().map(f => f.cursor)).toEqual([1, 2, 3])
  })

  it('a ring over its character budget evicts the oldest frames (the newest always stays)', () => {
    const sessions = registry({ ringChars: 10_000 })
    const { sessionId } = sessions.create({ client: 'test', version: '1' })
    sessions.setFocus(sessionId, AGENT_1)
    for (let i = 0; i < 50; i++) sessions.publishExecutor(exec(AGENT_1, 'tool_call_start', { pad: 'p'.repeat(1000) }))
    const stats = sessions.stats(sessionId)
    expect(stats.chars).toBeLessThanOrEqual(10_000)
    expect(stats.frames).toBeGreaterThan(1)
    sessions.publishExecutor(exec(AGENT_1, 'tool_call_start', { pad: 'p'.repeat(50_000) }))
    expect(sessions.stats(sessionId).frames).toBe(1)
  })

  it('back-pressure: a slow reader with many agents stays bounded and sees a gap, never silent loss', async () => {
    const sessions = registry({ ringFrames: 4096, ringChars: 2 * 1024 * 1024 })
    const { sessionId, sink } = open(sessions)
    sink.accept = false // the socket is full from the first write on
    await tick()
    const agents = Array.from({ length: 50 }, () => randomUUID())
    for (let i = 0; i < 20_000; i++) {
      sessions.publishExecutor({ agentId: agents[i % 50], filePath: null, event: { type: 'tool_call_start', payload: { i, pad: 'p'.repeat(200) }, timestamp: 1 } })
      if (i % 1000 === 0) await tick()
    }
    await tick()
    const stats = sessions.stats(sessionId)
    expect(stats.paused).toBe(true)
    expect(stats.frames).toBeLessThanOrEqual(4096)
    expect(stats.chars).toBeLessThanOrEqual(2 * 1024 * 1024)
    // The full socket was handed the hello and one refused chunk, nothing more.
    expect(sink.writes).toBe(2)
    expect(sink.text.length).toBeLessThan(64 * 1024 + 1024)

    sink.drain()
    await tick()
    const gaps = sink.controls('stream.gap')
    expect(gaps).toHaveLength(1)
    const frames = sink.frames()
    const dropped = gaps[0].dropped as number
    expect(dropped).toBeGreaterThan(0)
    expect(dropped + frames.length).toBe(20_000)
    expect(frames.at(-1)!.cursor).toBe(20_000)
    // Contiguous cursors except one jump, exactly where the gap says.
    const jumps = frames.slice(1).map((f, i) => f.cursor - frames[i].cursor).filter(d => d !== 1)
    expect(jumps).toEqual([dropped + 1])
    expect(frames.find(f => f.cursor > (gaps[0].requestedCursor as number))!.cursor).toBe((gaps[0].requestedCursor as number) + dropped + 1)
    // Per-agent order still holds for what was delivered.
    const seq = frames.filter(f => f.kind === 'executor' && f.agentId === agents[7]).map(f => f.kind === 'executor' && (f.event.payload as { i: number }).i) as number[]
    expect(seq).toEqual([...seq].sort((x, y) => x - y))
  })

  it('a second stream for the session replaces the first', () => {
    const sessions = registry()
    const { sessionId, sink } = open(sessions)
    const next = new FakeSink()
    sessions.attach(sessionId, next)
    expect(sink.destroyed).toBe(true)
    expect(sessions.stats(sessionId).connected).toBe(true)
  })
})

describe('client sessions: expiry, documents and the orphan rule', () => {
  function documents() {
    const held: string[] = []
    const released: string[] = []
    const host: ClientDocumentHost = {
      async hold(sessionId, request) { held.push(`${sessionId}:${request.agentId}`); return { agentId: request.agentId!, filePath: null } },
      release(sessionId, agentId) { released.push(`${sessionId}:${agentId}`) },
    }
    return { host, held, released }
  }

  it('expiry releases the held documents and tells onSessionEnded listeners', async () => {
    const docs = documents()
    const sessions = registry({ expiryMs: 30, documents: docs.host })
    const { sessionId, sink } = open(sessions)
    await sessions.holdDocument(sessionId, { agentId: AGENT_1 })
    await sessions.holdDocument(sessionId, { agentId: AGENT_2 })
    const ended = vi.fn()
    sessions.onSessionEnded(ended)
    sessions.detach(sessionId, sink)
    await new Promise(r => setTimeout(r, 80))
    expect(sessions.has(sessionId)).toBe(false)
    expect(docs.released.sort()).toEqual([`${sessionId}:${AGENT_1}`, `${sessionId}:${AGENT_2}`].sort())
    expect(ended).toHaveBeenCalledWith({ sessionId, client: 'test', reason: 'expired', documents: expect.arrayContaining([AGENT_1, AGENT_2]) })
  })

  it('a connected session never expires; a session that never connects does', async () => {
    const sessions = registry({ expiryMs: 30 })
    const connected = open(sessions)
    const idle = sessions.create({ client: 'test', version: '1' })
    await new Promise(r => setTimeout(r, 80))
    expect(sessions.has(connected.sessionId)).toBe(true)
    expect(sessions.has(idle.sessionId)).toBe(false)
  })

  it('release of a document the session does not hold is refused; end releases the rest', async () => {
    const docs = documents()
    const sessions = registry({ documents: docs.host })
    const { sessionId } = open(sessions)
    await sessions.holdDocument(sessionId, { agentId: AGENT_1 })
    await expect(sessions.releaseDocument(sessionId, AGENT_2)).rejects.toMatchObject({ status: 404, code: 'document_not_held' })
    await sessions.releaseDocument(sessionId, AGENT_1)
    await sessions.holdDocument(sessionId, { agentId: AGENT_2 })
    await sessions.end(sessionId)
    expect(docs.released).toEqual([`${sessionId}:${AGENT_1}`, `${sessionId}:${AGENT_2}`])
    await expect(sessions.end(sessionId)).rejects.toMatchObject({ status: 404, code: 'session_not_found' })
  })

  it('orphan rule: an expired exitDaemonWhenClosed session stops a Studio-started daemon when it is the last', async () => {
    const shutdown = vi.fn()
    const log: string[] = []
    const sessions = registry({ expiryMs: 20, startedBy: 'studio', requestShutdown: shutdown, log: (m) => log.push(m) })
    sessions.create({ client: 'studio', version: '1', exitDaemonWhenClosed: true })
    await new Promise(r => setTimeout(r, 60))
    expect(shutdown).toHaveBeenCalledOnce()
    expect(log.some(m => m.startsWith('Stopping the daemon:'))).toBe(true)
  })

  it('orphan rule: not while another session is open, not for a CLI-started daemon, not on DELETE', async () => {
    const shutdown = vi.fn()
    const log: string[] = []
    const withOther = registry({ expiryMs: 20, startedBy: 'studio', requestShutdown: shutdown, log: (m) => log.push(m) })
    open(withOther) // a connected terminal app
    withOther.create({ client: 'studio', version: '1', exitDaemonWhenClosed: true })
    const cli = registry({ expiryMs: 20, startedBy: 'cli', requestShutdown: shutdown, log: (m) => log.push(m) })
    cli.create({ client: 'studio', version: '1', exitDaemonWhenClosed: true })
    const deleted = registry({ expiryMs: 20, startedBy: 'studio', requestShutdown: shutdown, log: (m) => log.push(m) })
    const ended = deleted.create({ client: 'studio', version: '1', exitDaemonWhenClosed: true })
    await deleted.end(ended.sessionId)
    await new Promise(r => setTimeout(r, 60))
    expect(shutdown).not.toHaveBeenCalled()
    expect(log.filter(m => m.startsWith('Not stopping the daemon'))).toEqual([
      expect.stringContaining('1 other client session(s) are open'),
      expect.stringContaining('started by cli'),
    ])
  })
})

describe('client sessions: origin dedup', () => {
  it("a session's own config, file and document writes are not echoed to it; other sessions get them", async () => {
    const sessions = registry()
    const writer = open(sessions, { focus: AGENT_1 })
    const reader = open(sessions, { focus: AGENT_1 })
    runAsClientWrite(writer.sessionId, () => {
      sessions.publishPush('config_changed', { filePath: FILE_1, config: { name: 'agent-1' } as never }, { agentId: AGENT_1 })
      sessions.publishExecutor(exec(AGENT_1, 'file_updated', { path: 'notes.md', content: 'x' }))
      sessions.publishExecutor(exec(AGENT_1, 'document_updated', { content: 'doc' }))
      sessions.publishExecutor(exec(AGENT_1, 'tool_call_start', { name: 'still-sent' }))
    })
    sessions.publishPush('config_changed', { filePath: FILE_1, config: { name: 'agent-1b' } as never }, { agentId: AGENT_1 })
    await tick()
    const kinds = (sink: FakeSink) => sink.frames().map(f => (f.kind === 'push' ? f.topic : f.kind === 'executor' ? f.event.type : f.type))
    expect(kinds(writer.sink)).toEqual(['tool_call_start', 'config_changed'])
    expect(kinds(reader.sink)).toEqual(['config_changed', 'file_updated', 'document_updated', 'tool_call_start', 'config_changed'])
  })

  it('only the write itself is stamped: work the request queues (a turn, a timer) reaches the requester', async () => {
    const sessions = registry()
    const writer = open(sessions, { focus: AGENT_1 })
    runAsClientWrite(writer.sessionId, () => {
      sessions.publishExecutor(exec(AGENT_1, 'file_updated', { path: 'from-client.md', content: 'x' }))
      // A turn the request queued, as POST /chat does (process.nextTick), and a timer.
      process.nextTick(() => sessions.publishExecutor(exec(AGENT_1, 'file_updated', { path: 'from-turn.md', content: 'y' })))
      setTimeout(() => sessions.publishPush('config_changed', { filePath: FILE_1, config: { name: 'from-timer' } as never }, { agentId: AGENT_1 }), 5)
      void Promise.resolve().then(() => sessions.publishExecutor(exec(AGENT_1, 'document_updated', { content: 'from-continuation' })))
    })
    await new Promise(r => setTimeout(r, 30))
    const seen = writer.sink.frames().map(f => f.kind === 'executor' ? f.event.type + ':' + String((f.event.payload as { path?: string; content?: string }).path ?? (f.event.payload as { content?: string }).content) : f.kind === 'push' ? f.topic : '')
    expect(seen).toEqual(['document_updated:from-continuation', 'file_updated:from-turn.md', 'config_changed'])
  })
})

describe('client sessions: producers', () => {
  function fakeAgent() {
    const workspace = {
      inbox: { unread: [{ id: 'm1' }], read: [{ id: 'm0' }], archived: [] } as Record<string, unknown[]>,
      callback: null as ((scope: string) => void) | null,
      getInbox(status: string) { return this.inbox[status] ?? [] },
      setOnDataChangeCallback(cb: ((scope: string) => void) | null) { this.callback = cb },
    }
    const mcpManager = Object.assign(new EventEmitter(), { getServerState: (name: string) => (name === 'fs' ? { toolCount: 4 } : null) })
    const adapterManager = new EventEmitter()
    return { workspace, mcpManager, adapterManager }
  }

  function fakeRuntime() {
    return Object.assign(new EventEmitter(), { listAgents: () => [] as Array<{ id: string; filePath: string | null }> })
  }

  it('maps runtime events, and the loaded agent\'s MCP, adapter, inbox, workspace and config signals', async () => {
    const sessions = registry()
    const runtime = fakeRuntime()
    const unwire = wireRuntimeToClientSessions(sessions, runtime as never)
    const { sink } = open(sessions, { focus: AGENT_1 })
    const agent = fakeAgent()
    runtime.emit('agent-loaded', { agentId: AGENT_1, filePath: FILE_1, ref: {}, agent })
    runtime.emit('agent-event', exec(AGENT_1, 'tool_call_start', { name: 'x' }))
    runtime.emit('agent-lifecycle', { agentId: AGENT_1, filePath: FILE_1, type: 'agent_started', payload: { filePath: FILE_1 }, timestamp: 1 })
    agent.mcpManager.emit('status-changed', 'fs', 'connected', undefined)
    agent.adapterManager.emit('status-changed', 'telegram', 'error', 'bad token')
    agent.adapterManager.emit('inbound', 'telegram', {}, { inboxId: 'm1' })
    agent.workspace.callback!('inbox')
    agent.workspace.callback!('inbox')
    emitAgentConfigChanged(agent.workspace, { name: 'agent-1' } as never)
    await new Promise(r => setTimeout(r, 300))
    const frames = sink.frames()
    const push = (topic: string) => frames.filter(f => f.kind === 'push' && f.topic === topic).map(f => f.kind === 'push' && { agentId: f.agentId, filePath: f.filePath, payload: f.payload })
    expect(frames[0]).toMatchObject({ kind: 'executor', agentId: AGENT_1, event: { type: 'tool_call_start' } })
    expect(frames[1]).toMatchObject({ kind: 'host', type: 'agent_started' })
    expect(push('mcp_status')).toEqual([{ agentId: AGENT_1, filePath: FILE_1, payload: { name: 'fs', status: 'connected', toolCount: 4 } }])
    expect(push('adapter_status')).toEqual([{ agentId: AGENT_1, filePath: FILE_1, payload: { type: 'telegram', status: 'error', error: 'bad token' } }])
    expect(push('inbox')).toEqual([{ agentId: AGENT_1, filePath: FILE_1, payload: { inbox: { version: 1, messages: [{ id: 'm1' }, { id: 'm0' }] } } }])
    expect(push('mesh')).toEqual([{ agentId: AGENT_1, filePath: FILE_1, payload: { type: 'message_routed', payload: { filePath: 'station:telegram', toFilePaths: [FILE_1] }, timestamp: expect.any(Number) } }])
    expect(push('workspace_data')).toEqual([{ agentId: AGENT_1, filePath: FILE_1, payload: { scope: 'inbox' } }]) // coalesced
    expect(push('config_changed')).toEqual([{ agentId: AGENT_1, filePath: FILE_1, payload: { filePath: FILE_1, config: { name: 'agent-1' } } }])

    // A moved file: the path follows, and the rename is pushed once even when the watcher announces it too.
    const watcher = new EventEmitter()
    wireTrackedDirWatcherToClientSessions(sessions, watcher as never)
    runtime.emit('agent-path-changed', { agentId: AGENT_1, oldFilePath: FILE_1, filePath: '/agents/agent-1b.adf' })
    watcher.emit('file_renamed', { oldPath: FILE_1, newPath: '/agents/agent-1b.adf' })
    agent.mcpManager.emit('status-changed', 'fs', 'error', 'gone')
    await tick()
    const after = sink.frames().slice(frames.length)
    expect(after.map(f => f.kind === 'push' && f.topic)).toEqual(['agent_path_changed', 'file_renamed', 'mcp_status'])
    expect(after[2]).toMatchObject({ filePath: '/agents/agent-1b.adf' })

    // Unload detaches the per-agent producers.
    runtime.emit('agent-unloaded', { agentId: AGENT_1, filePath: '/agents/agent-1b.adf' })
    agent.mcpManager.emit('status-changed', 'fs', 'connected')
    expect(agent.workspace.callback).toBeNull()
    unwire()
    runtime.emit('agent-event', exec(AGENT_1, 'tool_call_start'))
    await tick()
    expect(sink.frames().length).toBe(frames.length + 3)
  })

  it('mesh, compute, approvals and the tracked-folder watcher', async () => {
    const sessions = registry()
    sessions.indexAgent(FILE_2, AGENT_2)
    const { sink } = open(sessions, { focus: AGENT_2 })
    const other = open(sessions)
    const mesh = Object.assign(new EventEmitter(), { persisted: null as ((filePath: string, config: unknown) => void) | null, setConfigPersistedListener(l: never) { this.persisted = l } })
    wireMeshToClientSessions(sessions, mesh as never)
    const compute = new EventEmitter()
    wireComputeToClientSessions(sessions, compute)
    const listeners: Array<(snapshot: unknown) => void> = []
    wireApprovalsToClientSessions(sessions, { subscribe: (l) => { listeners.push(l as never); return () => {} } })
    const watcher = new EventEmitter()
    wireTrackedDirWatcherToClientSessions(sessions, watcher as never)

    mesh.emit('mesh_event', { type: 'agent_joined', payload: { filePath: FILE_2 }, timestamp: 1 })
    mesh.emit('inbox_updated', { filePath: FILE_2, inbox: [{ id: 'm' }] })
    mesh.emit('agent_incoming', { filePath: FILE_2, fromAgent: 'agent-1', toAgent: 'agent-2', content: 'hi' })
    mesh.persisted!(FILE_2, { name: 'agent-2' })
    compute.emit('container-phase', { containerName: 'adf-agent-2', phase: 'ready', agentId: AGENT_2, timestamp: 1 })
    compute.emit('browser-session', { agentId: AGENT_2, agentName: 'agent-2', agentFilePath: FILE_2, containerName: 'adf-agent-2', hostPort: 6080, timestamp: 1 })
    listeners[0]({ pending: [], history: [] })
    watcher.emit('tracked_dirs', { dirPath: '/agents' })
    watcher.emit('autostart', { outcome: 'skipped', filePath: FILE_1, name: 'agent-1', reason: 'leased_elsewhere', message: 'agent-1 is running in the ADF daemon, pid 4242', source: 'watcher' })
    watcher.emit('autostart_overflow', { dropped: 3, queueLimit: 100 })
    await tick()
    expect(sink.frames().map(f => f.kind === 'push' && [f.topic, f.agentId])).toEqual([
      ['mesh', AGENT_2], ['inbox', AGENT_2], ['inter_agent_message', AGENT_2], ['config_changed', AGENT_2],
      ['compute_phase', AGENT_2], ['browser_session', AGENT_2], ['approvals', null], ['tracked_dirs', null],
      ['autostart', null], ['autostart_overflow', null],
    ])
    expect(sink.frames()[1]).toMatchObject({ payload: { inbox: { version: 1, messages: [{ id: 'm' }] } } })
    expect(sink.frames()[2]).toMatchObject({ payload: { fromAgent: 'agent-1', toAgent: 'agent-2', content: 'hi', direction: 'incoming' } })
    // A session not focused on agent-2: inbox counts and the message without its content.
    expect(other.sink.frames()[1]).toEqual(expect.objectContaining({ stripped: 'stub', payload: { counts: { unread: 1, read: 0, archived: 0 } } }))
    expect(other.sink.frames()[2]).toEqual(expect.objectContaining({ stripped: 'stub', payload: { fromAgent: 'agent-1', toAgent: 'agent-2', direction: 'incoming', size: 2 } }))
  })

  it('install progress: installing per line, then installed or error; the caller\'s callback and other members still work', async () => {
    const sessions = registry()
    const { sink } = open(sessions)
    const service = {
      prefix: 'svc',
      async install(name: string, onProgress?: (m: string) => void) { onProgress?.('step 1'); if (name === 'bad') throw new Error('nope'); return { name } },
      listInstalled() { return [this.prefix] },
    }
    const wrapped = withInstallProgress(service, 'mcp_install', 1, sessions)
    const own: string[] = []
    await expect(wrapped.install('good', (m) => own.push(m))).resolves.toEqual({ name: 'good' })
    await expect(wrapped.install('bad')).rejects.toThrow('nope')
    expect(wrapped.listInstalled()).toEqual(['svc'])
    expect(own).toEqual(['step 1'])
    const python = withInstallProgress({ async install(_n: string, _v?: string, p?: (m: string) => void) { p?.('uv'); return {} } }, 'sandbox_install', 2, sessions)
    await python.install('pkg')
    await tick()
    expect(sink.frames().map(f => f.kind === 'push' && [f.topic, f.payload])).toEqual([
      ['mcp_install', { package: 'good', status: 'installing', progress: 'step 1' }],
      ['mcp_install', { package: 'good', status: 'installed' }],
      ['mcp_install', { package: 'bad', status: 'installing', progress: 'step 1' }],
      ['mcp_install', { package: 'bad', status: 'error', error: 'Error: nope' }],
      ['sandbox_install', { package: 'pkg', status: 'installing', progress: 'uv' }],
      ['sandbox_install', { package: 'pkg', status: 'installed' }],
    ])
  })

  it('umbilical envelopes go only to sessions that asked; turn.delta only to those not focused on the agent', async () => {
    const sessions = registry()
    const plain = open(sessions)
    const { sessionId } = sessions.create({ client: 'tui', version: '1', umbilical: true })
    sessions.setFocus(sessionId, AGENT_1)
    const sink = new FakeSink()
    sessions.attach(sessionId, sink)
    const other = sessions.create({ client: 'tui-2', version: '1', umbilical: true })
    const otherSink = new FakeSink()
    sessions.attach(other.sessionId, otherSink)
    const envelope = (event_type: string) => ({ seq: 1, event_type, timestamp: 1, source: 'agent:x', agent_id: AGENT_1, payload: {} })
    sessions.publishUmbilical(envelope('turn.delta'))
    sessions.publishUmbilical(envelope('turn.completed'))
    await tick()
    expect(plain.sink.frames()).toEqual([])
    expect(sink.frames()).toEqual([{ cursor: 1, kind: 'umbilical', agentId: AGENT_1, event: envelope('turn.completed') }])
    expect(otherSink.frames().map(f => f.kind === 'umbilical' && f.event.event_type)).toEqual(['turn.delta', 'turn.completed'])
    // disconnect: the session stays, its client resumes.
    sessions.disconnect(sessionId)
    expect(sink.destroyed).toBe(true)
    expect(sessions.stats(sessionId).connected).toBe(false)
  })

  it('turn bookkeeping (D5): executor frames carry turnId and absorbedTurnIds, focused or not; chat.discarded is a turn frame for every session', async () => {
    const sessions = registry()
    const focused = open(sessions, { focus: AGENT_1 })
    const other = open(sessions)
    sessions.indexAgent(FILE_1, AGENT_1)
    sessions.publishExecutor({ ...exec(AGENT_1, 'tool_call_result', { result: { content: 'x' } }), turnId: 'turn_1' })
    sessions.publishExecutor({ ...exec(AGENT_1, 'turn_complete', {}), turnId: 'turn_1', absorbedTurnIds: ['turn_0'] })
    sessions.publishExecutor(exec(AGENT_1, 'state_changed', { state: 'idle' }))
    sessions.publishUmbilical({ seq: 2, event_type: 'chat.discarded', timestamp: 1, source: 'agent:x', agent_id: AGENT_1, loop: 'side', payload: { reason: 'stopped', count: 1, turn_ids: ['turn_q'], unanswered_turn_ids: ['turn_c'] } })
    sessions.publishUmbilical({ seq: 3, event_type: 'chat.discarded', timestamp: 1, source: 'agent:x', agent_id: AGENT_1, payload: { reason: 'stopped', count: 0, turn_ids: [] } })
    await tick()
    for (const { sink } of [focused, other]) {
      const frames = sink.frames()
      expect(frames.map(f => f.kind === 'executor' ? [f.event.type, f.turnId ?? null, f.absorbedTurnIds ?? null] : f.kind)).toEqual([
        ['tool_call_result', 'turn_1', null],
        ['turn_complete', 'turn_1', ['turn_0']],
        ['state_changed', null, null],
        'turn',
      ])
      expect(frames[3]).toEqual({ cursor: 4, kind: 'turn', agentId: AGENT_1, filePath: FILE_1, loop: 'side', outcome: 'discarded', turnIds: ['turn_q'], unansweredTurnIds: ['turn_c'] })
    }
    // The unfocused session's tool result is stripped, its turn id kept.
    expect(other.sink.frames()[0]).toMatchObject({ stripped: 'tool_result', turnId: 'turn_1' })
  })

  it('no session: producers do no serialization work', () => {
    const sessions = registry()
    const payload = { get expensive() { throw new Error('serialized') } }
    expect(() => sessions.publishExecutor(exec(AGENT_1, 'tool_call_start', payload))).not.toThrow()
  })
})

describe('client sessions: daemon wiring', () => {
  it('createDaemonClientSessions (what daemon/index.ts calls) wires every producer, registers the registry and wraps the installers', async () => {
    const { createDaemonClientSessions } = await import('../src/main/daemon/client-wiring')
    const { daemonClientSessions } = await import('../src/main/daemon/client-sessions')
    const runtime = Object.assign(new EventEmitter(), {
      listAgents: () => [], getAgentOrDocument: () => undefined,
      openDocument: async () => ({}), releaseDocument: async () => ({}), releaseDocumentHolder: async () => [], setDocumentHolderCheck: vi.fn(),
    })
    const mesh = new EventEmitter()
    const compute = new EventEmitter()
    const watcher = new EventEmitter()
    const approvals: Array<(s: unknown) => void> = []
    const bus: Array<(e: { event: unknown }) => void> = []
    const installer = { async install(_name: string, ...rest: unknown[]) { for (const arg of rest) if (typeof arg === 'function') (arg as (m: string) => void)('step'); return {} } }
    const built = createDaemonClientSessions({
      runtime: runtime as never, mesh, compute, trackedDirWatcher: watcher,
      approvals: { subscribe: (l) => { approvals.push(l as never); return () => {} } },
      eventBus: { subscribe: (l) => { bus.push(l as never); return () => {} } },
      packages: { mcp: installer, python: installer, adapters: installer, sandbox: installer },
      options: { log: quiet },
    })
    registries.push(built.sessions)
    try {
      expect(daemonClientSessions()).toBe(built.sessions)
      expect(runtime.setDocumentHolderCheck).toHaveBeenCalledWith(expect.any(Function))
      const { sessionId } = built.sessions.create({ client: 'tui', version: '1', umbilical: true })
      const sink = new FakeSink()
      built.sessions.attach(sessionId, sink)
      runtime.emit('agent-event', exec(AGENT_1, 'state_changed', { state: 'idle' }))
      mesh.emit('mesh_event', { type: 'agent_joined', payload: { filePath: FILE_1 }, timestamp: 1 })
      compute.emit('container-phase', { containerName: 'c', phase: 'ready', timestamp: 1 })
      watcher.emit('tracked_dirs', { dirPath: '/agents' })
      approvals[0]({ pending: [], history: [] })
      bus[0]({ event: { seq: 1, event_type: 'turn.completed', timestamp: 1, source: 'x', agent_id: AGENT_1, payload: {} } })
      await built.packages.mcp.install('pkg')
      await built.packages.python.install('pkg')
      await built.packages.adapters.install('pkg')
      await built.packages.sandbox.install('pkg')
      await tick()
      expect(sink.frames().map(f => f.kind === 'push' ? f.topic : f.kind)).toEqual([
        'executor', 'mesh', 'compute_phase', 'tracked_dirs', 'approvals', 'umbilical',
        'mcp_install', 'mcp_install', 'mcp_install', 'mcp_install', 'adapter_install', 'adapter_install', 'sandbox_install', 'sandbox_install',
      ])
    } finally {
      built.unwire()
    }
    expect(daemonClientSessions()).toBeNull()
  })
})

describe('client sessions: review fixes', () => {
  it('a stream that closed before attach is not attached, and the session still expires', async () => {
    const sessions = registry({ expiryMs: 30 })
    const { sessionId } = sessions.create({ client: 'test', version: '1' })
    const sink = new FakeSink()
    sink.destroyed = true
    sessions.attach(sessionId, sink)
    expect(sessions.stats(sessionId).connected).toBe(false)
    expect(sink.writes).toBe(0)
    await new Promise(r => setTimeout(r, 80))
    expect(sessions.has(sessionId)).toBe(false)
  })

  it('unfocused sessions get the background whitelist and stubs; the focused one gets full payloads', async () => {
    const sessions = registry()
    const focused = open(sessions, { focus: AGENT_1 })
    const other = open(sessions, { focus: AGENT_2 })
    const big = 'b'.repeat(50_000)
    sessions.publishExecutor(exec(AGENT_1, 'file_updated', { path: 'notes.md', content: big, previousContent: big }))
    sessions.publishExecutor(exec(AGENT_1, 'chat_updated', { uiLog: [{ text: big }], contextBaseline: 12 }))
    sessions.publishExecutor(exec(AGENT_1, 'context_injected', { category: 'system', content: big }))
    sessions.publishExecutor(exec(AGENT_1, 'tool_call_start', { name: 'fs_write', id: 'tu1', input: { content: big } }))
    sessions.publishExecutor(exec(AGENT_1, 'state_changed', { state: 'thinking' }))
    await tick()
    expect(focused.sink.frames().every(f => !('stripped' in f))).toBe(true)
    expect(JSON.stringify(focused.sink.frames()).length).toBeGreaterThan(200_000)
    const stubs = other.sink.frames()
    expect(stubs.map(f => f.kind === 'executor' && [f.event.type, f.stripped ?? 'full'])).toEqual([
      ['file_updated', 'stub'], ['chat_updated', 'stub'], ['context_injected', 'stub'], ['tool_call_start', 'tool_input'], ['state_changed', 'full'],
    ])
    expect(stubs[0]).toMatchObject({ event: { payload: { path: 'notes.md', size: expect.any(Number) } } })
    expect(stubs[1]).toMatchObject({ event: { payload: { contextBaseline: 12 } } })
    // tool_call_start keeps its input (the mesh graph's args and msg_send pulse), each field cut to 2048 characters.
    expect(stubs[3]).toMatchObject({ event: { payload: { name: 'fs_write', id: 'tu1', inputTruncated: true } } })
    expect(((stubs[3] as { event: { payload: { input: { content: string } } } }).event.payload.input.content)).toHaveLength(2049)
    expect(JSON.stringify(stubs).length).toBeLessThan(4_000)
    // A small input arrives untouched.
    sessions.publishExecutor(exec(AGENT_1, 'tool_call_start', { name: 'msg_send', id: 'tu2', input: { recipient: 'agent-2', content: 'hi' } }))
    await tick()
    expect(other.sink.frames().at(-1)).toEqual(expect.objectContaining({ event: expect.objectContaining({ payload: { name: 'msg_send', id: 'tu2', input: { recipient: 'agent-2', content: 'hi' } } }) }))
    expect(other.sink.frames().at(-1)).not.toHaveProperty('stripped')
  })

  it('one large write does not gap other sessions: only the focused reader gets an oversized gap', async () => {
    const sessions = registry({ maxFrameChars: 10_000 })
    const focused = open(sessions, { focus: AGENT_1 })
    const other = open(sessions, { focus: AGENT_2 })
    const plain = open(sessions)
    sessions.publishExecutor(exec(AGENT_1, 'file_updated', { path: 'huge.md', content: 'h'.repeat(20_000) }))
    sessions.publishExecutor(exec(AGENT_1, 'state_changed', { state: 'idle' }))
    await tick()
    expect(focused.sink.controls('stream.gap')).toEqual([expect.objectContaining({ reason: 'oversized', dropped: 1, size: expect.any(Number) })])
    expect(focused.sink.frames().map(f => f.kind === 'executor' && f.event.type)).toEqual(['state_changed'])
    for (const s of [other, plain]) {
      expect(s.sink.controls('stream.gap')).toEqual([])
      expect(s.sink.frames().map(f => f.kind === 'executor' && f.event.type)).toEqual(['file_updated', 'state_changed'])
    }
  })

  it('orphan rule: Studio expires while the TUI is attached; the TUI is told, and the daemon stops when the TUI ends', async () => {
    const shutdown = vi.fn()
    const sessions = registry({ expiryMs: 20, startedBy: 'studio', requestShutdown: shutdown })
    sessions.create({ client: 'studio', version: '1', exitDaemonWhenClosed: true })
    const tui = open(sessions)
    await new Promise(r => setTimeout(r, 60))
    expect(shutdown).not.toHaveBeenCalled()
    expect(tui.sink.frames().filter(f => f.kind === 'push' && f.topic === 'daemon_orphan_hold')).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ holding: true, sessions: 1 }) }),
    ])
    await sessions.end(tui.sessionId)
    // Deferred a moment, so the TUI's own DELETE is answered before the server closes (W4-A).
    expect(shutdown).not.toHaveBeenCalled()
    await new Promise(r => setTimeout(r, 80))
    expect(shutdown).toHaveBeenCalledOnce()
  })

  it('orphan rule: a Studio that comes back clears the pending shutdown', async () => {
    const shutdown = vi.fn()
    const sessions = registry({ expiryMs: 20, startedBy: 'studio', requestShutdown: shutdown })
    sessions.create({ client: 'studio', version: '1', exitDaemonWhenClosed: true })
    const tui = open(sessions)
    await new Promise(r => setTimeout(r, 60))
    const back = open(sessions)
    void back
    const studio2 = sessions.create({ client: 'studio', version: '1', exitDaemonWhenClosed: true })
    sessions.attach(studio2.sessionId, new FakeSink())
    await tick()
    await sessions.end(tui.sessionId)
    expect(shutdown).not.toHaveBeenCalled()
    expect(tui.sink.frames().filter(f => f.kind === 'push' && f.topic === 'daemon_orphan_hold').map(f => f.kind === 'push' && (f.payload as { holding: boolean }).holding)).toEqual([true, false])
  })

  it('no session: adapter inbound reads no inbox', () => {
    const sessions = registry()
    const runtime = Object.assign(new EventEmitter(), { listAgents: () => [] })
    wireRuntimeToClientSessions(sessions, runtime as never)
    const getInbox = vi.fn(() => [])
    const adapterManager = new EventEmitter()
    runtime.emit('agent-loaded', { agentId: AGENT_1, filePath: FILE_1, ref: {}, agent: { workspace: { getInbox, setOnDataChangeCallback: () => {} }, adapterManager } })
    adapterManager.emit('inbound', 'telegram', {}, { inboxId: 'm1' })
    expect(getInbox).not.toHaveBeenCalled()
  })

  it('an unserializable payload keeps its frame: kind and type stay, the payload says why', async () => {
    const sessions = registry()
    const { sink } = open(sessions, { focus: AGENT_1 })
    const payload = { get broken() { throw new Error('no getter for you') } }
    sessions.publishExecutor(exec(AGENT_1, 'tool_call_start', payload))
    await tick()
    expect(sink.frames()).toEqual([expect.objectContaining({ kind: 'executor', unserializable: true, event: expect.objectContaining({ type: 'tool_call_start', payload: { unserializable: 'no getter for you' } }) })])
  })
})
