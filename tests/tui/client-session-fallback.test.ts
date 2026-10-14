// The terminal app against a daemon without client sessions (an older
// version, or another client API version): it keeps today's GET /events path
// and logs why once, in the activity log.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DaemonClient } from '../../src/main/tui/api/client'
import { createTuiStore, type TuiStore } from '../../src/main/tui/state/store'
import { startMockDaemon, type MockDaemon } from './fixtures/mock-daemon'

let mock: MockDaemon
let store: TuiStore | null = null

beforeEach(async () => { mock = await startMockDaemon({ stepMs: 5 }) })
afterEach(async () => {
  await store?.close()
  store = null
  await mock.close()
})

async function waitFor(check: () => boolean, ms = 8_000): Promise<void> {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out')
    await new Promise(r => setTimeout(r, 10))
  }
}

const notes = (s: TuiStore) => s.getState().activity.filter(a => a.type === 'client.fallback')

describe('client sessions: old-daemon fallback', () => {
  it('a daemon without /client/sessions: /events, logged once, also across reconnects', async () => {
    store = createTuiStore({ client: new DaemonClient({ baseUrl: mock.url }) })
    await store.start()
    expect(store.liveMode).toBe('events')
    await waitFor(() => mock.requests.some(r => r.startsWith('GET /events')))
    expect(mock.requests).toContain('GET /version')
    expect(mock.requests.some(r => r.startsWith('POST /client/sessions'))).toBe(false)
    expect(notes(store)).toEqual([expect.objectContaining({ summary: expect.stringContaining('the daemon has no client sessions (an older version)') })])

    mock.dropEventStreams()
    await waitFor(() => mock.requests.filter(r => r.startsWith('GET /events')).length >= 2)
    expect(notes(store)).toHaveLength(1)
    // Old behaviour stands: the stream still feeds the state. (Checked on the
    // event tail: the reconnect's resync reloads the agent status and may
    // overwrite the state before a poll sees it.)
    mock.emit({ event_type: 'agent.state.changed', agent_id: [...mock.agents.keys()][0], payload: { state: 'thinking' } })
    await waitFor(() => store!.getState().lastEvents.some(e => e.event_type === 'agent.state.changed' && e.payload?.state === 'thinking'))
  }, 30_000)

  it('another client API version: /events, with both versions named', async () => {
    const fetchImpl: typeof fetch = async (input, init) => {
      if (new URL(String(input)).pathname === '/version') {
        return new Response(JSON.stringify({ version: '9.0.0', clientApiVersion: 99, settingsPath: null, dataDir: null, runtimeId: null, pid: 1, startedBy: 'cli' }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return fetch(input, init)
    }
    store = createTuiStore({ client: new DaemonClient({ baseUrl: mock.url, fetch: fetchImpl }) })
    await store.start()
    expect(store.liveMode).toBe('events')
    expect(notes(store)).toEqual([expect.objectContaining({ summary: expect.stringContaining('the daemon speaks client API 99, this app 1') })])
  })

  it('clientSessions: false never asks', async () => {
    store = createTuiStore({ client: new DaemonClient({ baseUrl: mock.url }), clientSessions: false })
    await store.start()
    expect(store.liveMode).toBe('events')
    expect(mock.requests).not.toContain('GET /version')
    expect(notes(store)).toEqual([])
  })
})
