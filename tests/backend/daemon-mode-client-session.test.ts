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
})
