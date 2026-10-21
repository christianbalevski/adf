/**
 * Studio's client session over the daemon's /client/* routes (W2-B, design
 * D5.1): version check, session header, focus and holds, a 404 on reconnect
 * opening a new session (focus and documents first, then frames, then a
 * resync), and the "update the daemon" refusal.
 */
import { describe, expect, it } from 'vitest'
import { DaemonClient, SUPPORTED_CLIENT_API_VERSION } from '../../src/shared/daemon-client'
import { createDaemonClientSession, type ClientFrame, type ClientStreamListener, type StreamGap } from '../../src/main/backend/daemon-mode/client-stream'
import { createFakeDaemon } from './daemon-mode-fakes'
import { DaemonModeSession } from '../../src/main/backend/daemon-mode/session'
import { EventBridge } from '../../src/main/backend/daemon-mode/event-bridge'
import { IPC } from '../../src/shared/constants/ipc-channels'

const BASE = 'http://127.0.0.1:47385'
const quiet = { log: () => {}, warn: () => {} }
const sse = (...blocks: string[]) => ({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, raw: blocks.join('') })
const frame = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`

async function waitFor(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

function recorder() {
  const frames: ClientFrame[] = []
  const gaps: StreamGap[] = []
  const fatal: string[] = []
  const reattached: boolean[] = []
  const listener: ClientStreamListener = {
    onFrame: (f) => { frames.push(f) },
    onGap: (g) => { gaps.push(g) },
    onConnection: () => {},
    onReattached: async (info) => { reattached.push(info.epochChanged) },
    onFatal: (m) => { fatal.push(m) },
  }
  return { frames, gaps, fatal, reattached, listener }
}

describe('Studio client session (W2-B)', () => {
  it('refuses a daemon with another client API version, with an "update the daemon" message', async () => {
    const daemon = createFakeDaemon(BASE)
    daemon.routes.set('GET /version', () => ({ version: '9.0.0', clientApiVersion: SUPPORTED_CLIENT_API_VERSION + 1 }))
    const session = createDaemonClientSession(new DaemonClient({ baseUrl: BASE, fetch: daemon.fetch }), { version: '1.0.0', exitDaemonWhenClosed: true, log: quiet })
    const r = recorder()
    session.start(r.listener)
    await waitFor(() => r.fatal.length > 0, 'the refusal')
    expect(r.fatal[0]).toContain(`9.0.0 speaks client API ${SUPPORTED_CLIENT_API_VERSION + 1}; this Studio needs ${SUPPORTED_CLIENT_API_VERSION}. Update the daemon`)
    expect(daemon.requests.some((q) => q.path === '/client/sessions')).toBe(false)
    await session.end()
  })

  it('a proxy\'s 502, 503 or 504 while the daemon behind it is down is retried, never fatal; the session opens once it answers', async () => {
    const daemon = createFakeDaemon(BASE)
    const gateway = [502, 503, 504]
    daemon.routes.set('GET /version', () => (gateway.length ? { status: gateway.shift(), raw: 'Bad Gateway' } : { version: '0.9.0', clientApiVersion: SUPPORTED_CLIENT_API_VERSION }))
    daemon.routes.set('POST /client/sessions', () => ({ sessionId: 's-1', epoch: 'e1', expiresInMs: 60_000 }))
    daemon.routes.set('GET /client/sessions/s-1/events', () => sse())
    const session = createDaemonClientSession(new DaemonClient({ baseUrl: BASE, fetch: daemon.fetch }), { version: '1.0.0', exitDaemonWhenClosed: false, log: quiet, retryMs: 5 })
    const r = recorder()
    session.start(r.listener)
    await waitFor(() => daemon.requests.some((q) => q.path === '/client/sessions'), 'the session opened')
    expect(gateway).toEqual([])
    expect(r.fatal).toEqual([])
    await session.end()
  })

  it('opens a session with exitDaemonWhenClosed, sends focus and holds under it, reads frames and turn ends, and a 404 on reconnect opens a new session', async () => {
    const daemon = createFakeDaemon(BASE)
    let created = 0
    daemon.routes.set('GET /version', () => ({ version: '1.0.0', clientApiVersion: SUPPORTED_CLIENT_API_VERSION }))
    daemon.routes.set('POST /client/sessions', () => ({ status: 201, body: { sessionId: `s${++created}`, epoch: 'e1' } }))
    daemon.routes.set('PUT /client/sessions/s1/focus', ({ body }) => ({ sessionId: 's1', focus: (body as { agentId: string }).agentId }))
    daemon.routes.set('POST /client/sessions/s1/documents', () => ({ agentId: 'a1', filePath: 'C:/a.adf', running: false, needsPassword: false }))
    let s1Served = false
    daemon.routes.set('GET /client/sessions/s1/events', () => {
      if (s1Served) return { status: 404, body: { error: 'No client session s1', code: 'session_not_found' } }
      s1Served = true
      return sse(
        frame({ kind: 'executor', cursor: 1, agentId: 'a1', filePath: 'C:/a.adf', event: { type: 'state_changed', payload: { state: 'thinking' }, timestamp: 1 } }),
        frame({ kind: 'turn', cursor: 2, agentId: 'a1', filePath: 'C:/a.adf', outcome: 'discarded', turnIds: ['t1'], unansweredTurnIds: [] }),
        frame({ kind: 'umbilical', cursor: 3, agentId: 'a1', event: { seq: 2, event_type: 'tool.started', timestamp: 2, source: 'agent', agent_id: 'a1', payload: {} } }),
      )
    })
    daemon.routes.set('PUT /client/sessions/s2/focus', ({ body }) => ({ sessionId: 's2', focus: (body as { agentId: string }).agentId }))
    daemon.routes.set('GET /client/sessions/s2/events', () => sse(frame({ kind: 'push', cursor: 1, topic: 'templates', agentId: null, filePath: null, payload: {} })))
    daemon.routes.set('DELETE /client/sessions/s2', () => ({ sessionId: 's2', ended: true }))

    const session = createDaemonClientSession(new DaemonClient({ baseUrl: BASE, fetch: daemon.fetch }), { version: '1.0.0', exitDaemonWhenClosed: true, log: quiet })
    const r = recorder()
    await session.setFocus('a1') // before the session exists: sent once it opens
    session.start(r.listener)
    expect(await session.holdDocument('C:/a.adf')).toMatchObject({ agentId: 'a1', running: false })
    expect(daemon.requests.find((q) => q.path === '/client/sessions')?.body).toEqual({ client: 'studio', version: '1.0.0', exitDaemonWhenClosed: true })
    expect(daemon.requests.find((q) => q.path === '/client/sessions/s1/focus')?.body).toEqual({ agentId: 'a1' })
    expect(session.sessionId).toBe('s1')

    await waitFor(() => r.frames.length >= 2, 'the first frames')
    expect(r.frames.slice(0, 2)).toEqual([
      { kind: 'executor', agentId: 'a1', filePath: 'C:/a.adf', event: { type: 'state_changed', payload: { state: 'thinking' }, timestamp: 1 } },
      { kind: 'turn', agentId: 'a1', filePath: 'C:/a.adf', outcome: 'discarded', turnIds: ['t1'], unansweredTurnIds: [] },
    ])

    // The stream ends, the reconnect answers 404: a new session, reattached before its frames, then a resync.
    await waitFor(() => session.sessionId === 's2' && r.gaps.some((g) => g.reason === 'new_session'), 'the new session')
    expect(r.reattached).toContain(true)
    await waitFor(() => r.frames.some((f) => f.kind === 'push'), 'the new session\'s frames')
    expect(daemon.requests.find((q) => q.path === '/client/sessions/s2/focus')?.body).toEqual({ agentId: 'a1' })
    await session.end()
    expect(daemon.requests.some((q) => q.method === 'DELETE' && q.path === '/client/sessions/s2')).toBe(true)
    expect(session.sessionId).toBeNull()
  })

  it('a quit while the new session is re-held starts no stream and reports no gap (W5-F)', async () => {
    const daemon = createFakeDaemon(BASE)
    let created = 0
    daemon.routes.set('GET /version', () => ({ version: '1.0.0', clientApiVersion: SUPPORTED_CLIENT_API_VERSION }))
    daemon.routes.set('POST /client/sessions', () => ({ status: 201, body: { sessionId: `s${++created}`, epoch: 'e1' } }))
    let s1Served = false
    daemon.routes.set('GET /client/sessions/s1/events', () => {
      if (s1Served) return { status: 404, body: { error: 'No client session s1', code: 'session_not_found' } }
      s1Served = true
      return sse(frame({ kind: 'push', cursor: 1, topic: 'templates', agentId: null, filePath: null, payload: {} }))
    })
    daemon.routes.set('GET /client/sessions/s2/events', () => sse(frame({ kind: 'push', cursor: 1, topic: 'templates', agentId: null, filePath: null, payload: {} })))
    daemon.routes.set('POST /client/sessions/s2/quit', () => ({ sessionId: 's2', ended: true, stopping: false, otherSessions: 0 }))

    const session = createDaemonClientSession(new DaemonClient({ baseUrl: BASE, fetch: daemon.fetch }), { version: '1.0.0', exitDaemonWhenClosed: true, log: quiet })
    const r = recorder()
    let quitDone = false
    // Studio quits while the reopen re-holds its documents on s2.
    r.listener.onReattached = async () => { await session.quit(false); quitDone = true }
    session.start(r.listener)
    await waitFor(() => quitDone, 'the quit during the reopen')
    await new Promise((res) => setTimeout(res, 100))
    expect(daemon.requests.some((q) => q.path === '/client/sessions/s2/quit')).toBe(true)
    expect(daemon.requests.some((q) => q.path === '/client/sessions/s2/events')).toBe(false)
    expect(r.gaps.some((g) => g.reason === 'new_session')).toBe(false)
    expect(session.sessionId).toBeNull()
  })
})

describe('Studio replay ordering', () => {
  it.each([false, true])('delivers exact replay after reattachment and cancels pending replay on end (end=%s)', async (endDuringReattach) => {
    let streams = 0
    let release!: () => void
    let reattaching = false
    const pending = new Promise<void>((r) => { release = r })
    const hello = 'event: stream.hello\ndata: {"epoch":"e1","oldestCursor":1,"latestCursor":2}\n\n'
    const fetchImpl = (async (input: unknown) => {
      const path = new URL(String(input)).pathname
      if (path === '/version') return Response.json({ clientApiVersion: SUPPORTED_CLIENT_API_VERSION })
      if (path === '/client/sessions') return Response.json({ sessionId: 's1' })
      if (path.endsWith('/events')) {
        if (++streams === 1) return new Response(hello)
        return new Response(new ReadableStream({ start(c) {
          c.enqueue(new TextEncoder().encode(hello + frame({ kind: 'push', cursor: 1, topic: 'file_renamed', payload: { oldPath: '/agents/old.adf', newPath: '/agents/new.adf' } }) + frame({ kind: 'push', cursor: 2, topic: 'templates', payload: {} })))
        } }))
      }
      return Response.json({})
    }) as typeof fetch
    const session = createDaemonClientSession(new DaemonClient({ baseUrl: BASE, fetch: fetchImpl }), { version: '1', exitDaemonWhenClosed: false, log: quiet })
    const r = recorder()
    r.listener.onReattached = async () => { reattaching = true; await pending }
    try {
      session.start(r.listener)
      await waitFor(() => reattaching, 'the re-hold')
      await new Promise((res) => setTimeout(res, 30))
      expect(r.frames).toEqual([])
      if (endDuringReattach) {
        await session.end()
        release()
        await new Promise((res) => setTimeout(res, 30))
        expect(r.frames).toEqual([])
        expect(r.gaps).toEqual([])
      } else {
        release()
        await waitFor(() => r.frames.length === 2, 'the ordered replay')
        expect(r.frames.map((f) => f.kind === 'push' ? f.topic : f.kind)).toEqual(['file_renamed', 'templates'])
      }
    } finally { release(); await session.end() }
  })

  it('resyncs on bounded replay overflow', async () => {
    let streams = 0
    let release!: () => void
    let reattaching = false
    const pending = new Promise<void>((r) => { release = r })
    const hello = 'event: stream.hello\ndata: {"epoch":"e1","oldestCursor":1,"latestCursor":4100}\n\n'
    const fetchImpl = (async (input: unknown) => {
      const path = new URL(String(input)).pathname
      if (path === '/version') return Response.json({ clientApiVersion: SUPPORTED_CLIENT_API_VERSION })
      if (path === '/client/sessions') return Response.json({ sessionId: 's1' })
      if (path.endsWith('/events')) {
        if (++streams === 1) return new Response(hello)
        return new Response(new ReadableStream({ start(c) {
          const frames = Array.from({ length: 4100 }, (_, n) => frame({ kind: 'push', cursor: n + 1, topic: 'templates', payload: {} })).join('')
          c.enqueue(new TextEncoder().encode(hello + frames))
        } }))
      }
      return Response.json({})
    }) as typeof fetch
    const session = createDaemonClientSession(new DaemonClient({ baseUrl: BASE, fetch: fetchImpl }), { version: '1', exitDaemonWhenClosed: false, log: quiet })
    const r = recorder()
    r.listener.onReattached = async () => { reattaching = true; await pending }
    try {
      session.start(r.listener)
      await waitFor(() => reattaching, 'the re-hold')
      await new Promise((res) => setTimeout(res, 50))
      expect(r.frames).toEqual([])
      release()
      await waitFor(() => r.gaps.length > 0, 'the replay overflow gap')
      expect(r.gaps).toContainEqual({ reason: 'evicted', dropped: 4096 })
      expect(r.frames).toHaveLength(4)
    } finally { release(); await session.end() }
  })

  it('re-holds a renamed document by stable agent identity, falling back to its path after restart', async () => {
    const daemon = createFakeDaemon(BASE)
    daemon.routes.set('GET /version', () => ({ clientApiVersion: SUPPORTED_CLIENT_API_VERSION }))
    daemon.routes.set('POST /client/sessions', () => ({ sessionId: 's1' }))
    daemon.routes.set('GET /client/sessions/s1/events', () => sse())
    daemon.routes.set('POST /client/sessions/s1/documents', ({ body }) => {
      if ((body as { agentId?: string }).agentId === 'missing') return { status: 404, body: { code: 'agent_not_found' } }
      return { agentId: 'a1', filePath: '/agents/new.adf' }
    })
    const session = createDaemonClientSession(new DaemonClient({ baseUrl: BASE, fetch: daemon.fetch }), { version: '1', exitDaemonWhenClosed: false, log: quiet })
    try {
      session.start(recorder().listener)
      expect(await session.holdDocument('/agents/old.adf', 'a1')).toMatchObject({ filePath: '/agents/new.adf' })
      expect(daemon.requests.filter((r) => r.path.endsWith('/documents')).map((r) => r.body)).toEqual([{ agentId: 'a1' }])
      await session.holdDocument('/agents/old.adf', 'missing')
      expect(daemon.requests.filter((r) => r.path.endsWith('/documents')).slice(-2).map((r) => r.body)).toEqual([{ agentId: 'missing' }, { filePath: '/agents/old.adf' }])
    } finally { await session.end() }
  })
})


describe('reattach across daemon document lifecycle changes', () => {
  it('forwards a replayed rename to the renderer after identity re-hold already adopted its canonical path', async () => {
    let streams = 0
    const holds: unknown[] = []
    const oldPath = '/agents/old.adf'
    const newPath = '/agents/new.adf'
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      const path = new URL(String(input)).pathname
      if (path === '/version') return Response.json({ clientApiVersion: SUPPORTED_CLIENT_API_VERSION })
      if (path === '/client/sessions') return Response.json({ sessionId: 's1' })
      if (path.endsWith('/documents')) {
        const body = JSON.parse(String(init?.body))
        holds.push(body)
        return Response.json({ agentId: 'a1', filePath: body.agentId ? newPath : oldPath })
      }
      if (path.endsWith('/events')) {
        streams++
        return new Response(new ReadableStream({ start(c) {
          const hello = 'event: stream.hello\ndata: {"epoch":"e1","oldestCursor":1,"latestCursor":1}\n\n'
          c.enqueue(new TextEncoder().encode(hello + (streams > 1 ? frame({ kind: 'push', cursor: 1, topic: 'file_renamed', agentId: 'a1', payload: { oldPath, newPath } }) : '')))
        } }))
      }
      return Response.json({})
    }) as typeof fetch
    const client = new DaemonClient({ baseUrl: BASE, fetch: fetchImpl })
    const clientSession = createDaemonClientSession(client, { version: '1', exitDaemonWhenClosed: false, log: quiet })
    const session = new DaemonModeSession(clientSession, quiet, undefined, true)
    const sent: Array<{ channel: string; args: unknown[] }> = []
    const bridge = new EventBridge({ session, output: { send: (channel, ...args) => { sent.push({ channel, args }) }, sendAll() {} }, batcher: { push() {}, flush() {} }, client: () => client, onFileRenamed: (a, b) => session.rekey(a, b), log: quiet })
    try {
      clientSession.start({ onConnection() {}, onGap() {}, onFrame: (f) => bridge.handleFrame(f), onReattached: () => session.reattach() })
      await session.openFile(oldPath, async () => null)
      await waitFor(() => streams === 1, 'the initial stream')
      clientSession.reconnect()
      await waitFor(() => sent.some((p) => p.channel === IPC.FILE_RENAMED), 'the renderer rename')
      expect(holds).toEqual([{ filePath: oldPath }, { agentId: 'a1' }])
      expect(session.filePath).toBe(newPath)
      expect(session.current?.opened?.filePath).toBe(newPath)
      expect(sent).toContainEqual({ channel: IPC.FILE_RENAMED, args: [{ oldPath, newPath }] })
    } finally { bridge.dispose(); await clientSession.end() }
  })

  it('replaces an expired session during FILE_OPEN without waiting on its own serialized reattach', async () => {
    const daemon = createFakeDaemon(BASE)
    let created = 0
    daemon.routes.set('GET /version', () => ({ clientApiVersion: SUPPORTED_CLIENT_API_VERSION }))
    daemon.routes.set('POST /client/sessions', () => ({ sessionId: `s${++created}` }))
    daemon.routes.set('GET /client/sessions/s1/events', () => sse())
    daemon.routes.set('GET /client/sessions/s2/events', () => sse())
    daemon.routes.set('POST /client/sessions/s1/documents', () => ({ status: 404, body: { code: 'session_not_found' } }))
    daemon.routes.set('POST /client/sessions/s2/documents', () => ({ agentId: 'a1', filePath: '/agents/agent-1.adf' }))
    daemon.routes.set('PUT /client/sessions/s2/focus', () => ({}))
    const clientSession = createDaemonClientSession(new DaemonClient({ baseUrl: BASE, fetch: daemon.fetch }), { version: '1', exitDaemonWhenClosed: false, log: quiet })
    const session = new DaemonModeSession(clientSession, quiet)
    try {
      clientSession.start({ onConnection() {}, onGap() {}, onFrame() {}, onReattached: () => session.reattach() })
      await session.openFile('/agents/agent-1.adf', async () => null)
      expect(session.agentId).toBe('a1')
      expect(clientSession.sessionId).toBe('s2')
      await waitFor(() => daemon.requests.some((r) => r.path === '/client/sessions/s2/events'), 'the replacement stream')
    } finally { await clientSession.end() }
  })
})

describe('calls while the session cannot open (A4)', () => {
  /** A daemon whose proxy answers 502 to every /version: the open keeps retrying. */
  function gatewayDown() {
    const daemon = createFakeDaemon(BASE)
    daemon.routes.set('GET /version', () => ({ status: 502, raw: 'Bad Gateway' }))
    return daemon
  }

  it('end() during the open retry: a waiting call fails at once, and the retry stops', async () => {
    const daemon = gatewayDown()
    const session = createDaemonClientSession(new DaemonClient({ baseUrl: BASE, fetch: daemon.fetch }), { version: '1.0.0', exitDaemonWhenClosed: false, log: quiet, retryMs: 50 })
    session.start(recorder().listener)
    await waitFor(() => daemon.requests.filter((q) => q.path === '/version').length >= 2, 'the open retried')
    const held = session.holdDocument('/srv/agents/agent-1.adf').then(() => 'held', (err: Error) => err.message)
    await session.end()
    const outcome = await Promise.race([held, new Promise((r) => setTimeout(() => r('still waiting'), 1_000))])
    expect(outcome).toBe('Opening the file: Studio is not connected to the ADF daemon')
    const tries = daemon.requests.filter((q) => q.path === '/version').length
    await new Promise((r) => setTimeout(r, 200))
    expect(daemon.requests.filter((q) => q.path === '/version').length).toBe(tries)
  })

  it('a call waits for the open within its bound, then fails visibly as not connected', async () => {
    const daemon = gatewayDown()
    const session = createDaemonClientSession(new DaemonClient({ baseUrl: BASE, fetch: daemon.fetch }), { version: '1.0.0', exitDaemonWhenClosed: false, log: quiet, retryMs: 20, sessionWaitMs: 150 })
    session.start(recorder().listener)
    await waitFor(() => daemon.requests.some((q) => q.path === '/version'), 'the open started')
    const started = Date.now()
    await expect(session.holdDocument('/srv/agents/agent-1.adf')).rejects.toThrow('Opening the file: Studio is not connected to the ADF daemon')
    expect(Date.now() - started).toBeLessThan(1_000)
    await session.end()
  })

  it('after end(), the session has no id and calls fail at once', async () => {
    const daemon = createFakeDaemon(BASE)
    daemon.routes.set('GET /version', () => ({ version: '0.9.0', clientApiVersion: SUPPORTED_CLIENT_API_VERSION }))
    daemon.routes.set('POST /client/sessions', () => ({ sessionId: 's-1', epoch: 'e1', expiresInMs: 60_000 }))
    daemon.routes.set('GET /client/sessions/s-1/events', () => sse())
    const session = createDaemonClientSession(new DaemonClient({ baseUrl: BASE, fetch: daemon.fetch }), { version: '1.0.0', exitDaemonWhenClosed: false, log: quiet, retryMs: 5 })
    session.start(recorder().listener)
    await waitFor(() => session.sessionId === 's-1', 'the session opened')
    await session.end()
    expect(session.sessionId).toBeNull()
    await expect(session.holdDocument('/srv/agents/agent-1.adf')).rejects.toThrow('Opening the file: Studio is not connected to the ADF daemon')
  })
})
