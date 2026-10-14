import type { ClientSession, ClientStreamListener } from '../../src/main/backend/daemon-mode/client-stream'

/**
 * A scripted daemon for daemon-mode unit tests: `fetch` answers from a route
 * table and records every request (method, path, query, auth header).
 */
export interface FakeDaemon {
  fetch: typeof fetch
  requests: Array<{ method: string; path: string; query: Record<string, string>; auth: string | null; body: unknown }>
  routes: Map<string, (req: { query: Record<string, string>; body: unknown }) => { status?: number; body?: unknown; headers?: Record<string, string>; raw?: string } | unknown>
}

export function createFakeDaemon(baseUrl = 'http://127.0.0.1:47385'): FakeDaemon {
  const daemon: FakeDaemon = {
    requests: [],
    routes: new Map(),
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url)
      if (url.origin !== new URL(baseUrl).origin) throw new Error(`fake daemon: unexpected origin ${url.origin}`)
      const method = (init?.method ?? 'GET').toUpperCase()
      const query = Object.fromEntries(url.searchParams.entries())
      const headers = (init?.headers ?? {}) as Record<string, string>
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      daemon.requests.push({ method, path: url.pathname, query, auth: headers.Authorization ?? null, body })
      const route = daemon.routes.get(`${method} ${url.pathname}`)
      if (!route) {
        return new Response(JSON.stringify({ message: `Route ${method}:${url.pathname} not found`, error: 'Not Found', statusCode: 404 }), { status: 404 })
      }
      const answer = route({ query, body }) as { status?: number; body?: unknown; headers?: Record<string, string>; raw?: string } | undefined
      if (answer && typeof answer === 'object' && ('status' in answer || 'raw' in answer)) {
        return new Response(answer.raw ?? JSON.stringify(answer.body ?? {}), { status: answer.status ?? 200, headers: answer.headers })
      }
      return new Response(JSON.stringify(answer ?? {}), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch,
  }
  return daemon
}

/** A client session the test drives: frames, gaps and connection changes on demand. */
export interface FakeClientSession extends ClientSession {
  listener: ClientStreamListener | null
  focus: Array<string | null>
  held: string[]
  released: string[]
  reconnects: number
  ended: boolean
  holdsAvailable: boolean
}

export function createFakeClientSession(resolveHold: (filePath: string) => string | null = () => null): FakeClientSession {
  const s: FakeClientSession = {
    kind: 'client-session',
    limitations: [],
    listener: null,
    focus: [],
    held: [],
    released: [],
    reconnects: 0,
    ended: false,
    holdsAvailable: false,
    start(listener) { s.listener = listener; listener.onConnection({ state: 'open' }) },
    async setFocus(agentId) { s.focus.push(agentId) },
    async holdDocument(filePath) {
      if (!s.holdsAvailable) {
        const { DaemonModeUnavailableError } = await import('../../src/main/backend/daemon-mode/errors')
        throw new DaemonModeUnavailableError('Holding an agent file as an open document', 'W2-B')
      }
      const agentId = resolveHold(filePath)
      if (!agentId) throw new Error('unknown file')
      s.held.push(agentId)
      return { agentId }
    },
    async releaseDocument(agentId) { s.released.push(agentId) },
    reconnect() { s.reconnects++ },
    async end() { s.ended = true },
  }
  return s
}
