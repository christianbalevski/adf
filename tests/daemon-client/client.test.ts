// The shared daemon client (src/shared/daemon-client, design D8): token scope,
// the 401 re-read, redirects, per-call timeouts and arbitrary SSE paths. Fetch
// is faked, except in 'redirects' (two loopback servers on ephemeral ports);
// nothing here starts a daemon or reads the real token file.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DaemonClient as SharedDaemonClient, DaemonError, EventStream, staticCredentials, type ConnectionInfo, type DaemonCredentials } from '../../src/shared/daemon-client'
import { DaemonClient as TuiDaemonClient } from '../../src/main/tui/api/client'
import { daemonCredentials } from '../../src/main/cli/daemon-url'
import { DAEMON_TOKEN_FILENAME } from '../../src/main/daemon/daemon-token'
import { mintLocalProof } from '../../src/main/daemon/local-access'

const LOCAL_TOKEN = 'l'.repeat(43)

interface Call { url: string; headers: Record<string, string> }

/** A fetch that records every call and answers `status` (or a function of the call). */
function fakeFetch(answer: number | ((call: Call) => number) = 200): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const impl = async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), headers: { ...(init?.headers as Record<string, string>) } }
    calls.push(call)
    const status = typeof answer === 'function' ? answer(call) : answer
    return new Response(status === 200 ? '{"ok":true}' : '{"error":"nope"}', { status })
  }
  return { fetch: impl as typeof fetch, calls }
}

const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

/** Isolated settings dir; `withToken` writes this machine's daemon token file. */
function localEnv(withToken = true): { env: NodeJS.ProcessEnv; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'adf-daemon-client-'))
  dirs.push(dir)
  if (withToken) writeFileSync(join(dir, DAEMON_TOKEN_FILENAME), `${LOCAL_TOKEN}\n`)
  return { env: { ADF_DAEMON_SETTINGS: join(dir, 'adf-settings.json') }, dir }
}

describe('token scope', () => {
  const creds = (token: string): DaemonCredentials => ({ token: () => token, localProof: () => ({ 'X-ADF-Local-Proof': 'proof' }) })

  it('attaches the token and local proof only to the configured origin', async () => {
    const { fetch, calls } = fakeFetch()
    const client = new SharedDaemonClient({ baseUrl: 'http://127.0.0.1:7385/', credentials: creds('daemon-a'), fetch })
    await client.health()
    expect(calls[0].url).toBe('http://127.0.0.1:7385/health')
    expect(calls[0].headers.Authorization).toBe('Bearer daemon-a')
    expect(calls[0].headers['X-ADF-Local-Proof']).toBe('proof')
    // A path that turns the URL into another host gets no credentials.
    await client.request('GET', '@evil.example/steal')
    expect(new URL(calls[1].url).hostname).toBe('evil.example')
    expect(calls[1].headers.Authorization).toBeUndefined()
    expect(calls[1].headers['X-ADF-Local-Proof']).toBeUndefined()
  })

  it('carries credentials through withBaseUrl only to the same origin', async () => {
    const { fetch, calls } = fakeFetch()
    const base = new SharedDaemonClient({ baseUrl: 'http://127.0.0.1:7385', credentials: creds('daemon-a'), fetch })
    const same = base.withBaseUrl('http://127.0.0.1:7385/')
    const other = base.withBaseUrl('http://daemon-b.example:7385')
    const otherWithToken = base.withBaseUrl('http://daemon-b.example:7385', 'daemon-b')
    expect(same.hasToken).toBe(true)
    expect(other.hasToken).toBe(false)
    await same.health()
    await other.health()
    await otherWithToken.health()
    expect(calls.map(c => c.headers.Authorization)).toEqual(['Bearer daemon-a', undefined, 'Bearer daemon-b'])
    // An explicit token for B stays with B: B's client never sends it back to A.
    await otherWithToken.withBaseUrl('http://127.0.0.1:7385').health()
    expect(calls[3].headers.Authorization).toBeUndefined()
    // And B's own token is bound to B's origin like any other.
    await otherWithToken.request('GET', '@127.0.0.1:7385/health')
    expect(calls[4].headers.Authorization).toBeUndefined()
  })

  it('asks credentialsFor for another origin, with that origin', async () => {
    const asked: string[] = []
    const { fetch, calls } = fakeFetch()
    const base = new SharedDaemonClient({
      baseUrl: 'http://127.0.0.1:7385',
      credentials: creds('daemon-a'),
      credentialsFor: url => { asked.push(url); return staticCredentials(`for ${url}`) },
      fetch,
    })
    await base.withBaseUrl('https://daemon-b.example/').health()
    expect(asked).toEqual(['https://daemon-b.example'])
    expect(calls[0].headers.Authorization).toBe('Bearer for https://daemon-b.example')
  })

  it('sends the token on a stream to an arbitrary path and query, only to the configured origin', async () => {
    const seen: Call[] = []
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), headers: { ...(init?.headers as Record<string, string>) } })
      throw new Error('offline')
    }) as typeof globalThis.fetch
    const client = new SharedDaemonClient({ baseUrl: 'http://127.0.0.1:7385', credentials: creds('daemon-a'), fetch })
    const stream = client.events({ path: '/client/sessions/s-1/events', query: { focus: 'agent-1', empty: '' }, onEvent: () => {}, minBackoffMs: 5, maxBackoffMs: 5 }).start()
    await until(() => seen.length >= 1)
    stream.close()
    const url = new URL(seen[0].url)
    expect(url.pathname).toBe('/client/sessions/s-1/events')
    expect(url.searchParams.get('focus')).toBe('agent-1')
    expect(url.searchParams.has('empty')).toBe(false)
    expect(url.searchParams.get('since')).toBe(String(Number.MAX_SAFE_INTEGER))
    expect(seen[0].headers.Authorization).toBe('Bearer daemon-a')
    expect(seen[0].headers.Accept).toBe('text/event-stream')

    seen.length = 0
    const escaped = client.events({ path: '@evil.example/events', onEvent: () => {}, minBackoffMs: 5, maxBackoffMs: 5 }).start()
    await until(() => seen.length >= 1)
    escaped.close()
    expect(new URL(seen[0].url).hostname).toBe('evil.example')
    expect(seen[0].headers.Authorization).toBeUndefined()
  })
})

describe('401 re-read', () => {
  it('retries once when the credentials report a new token', async () => {
    let token = 'stale'
    let refreshes = 0
    const credentials: DaemonCredentials = { token: () => token, refresh: () => { refreshes++; token = 'fresh'; return true } }
    const { fetch, calls } = fakeFetch(call => (call.headers.Authorization === 'Bearer fresh' ? 200 : 401))
    const client = new SharedDaemonClient({ baseUrl: 'http://127.0.0.1:7385', credentials, fetch })
    await expect(client.health()).resolves.toEqual({ ok: true })
    expect(calls.map(c => c.headers.Authorization)).toEqual(['Bearer stale', 'Bearer fresh'])
    expect(refreshes).toBe(1)
  })

  it('never refreshes for a request that left the configured origin', async () => {
    let refreshes = 0
    const credentials: DaemonCredentials = { token: () => 'a', refresh: () => { refreshes++; return true } }
    const { fetch, calls } = fakeFetch(401)
    const client = new SharedDaemonClient({ baseUrl: 'http://127.0.0.1:7385', credentials, fetch })
    await expect(client.request('GET', '@evil.example/x')).rejects.toBeInstanceOf(DaemonError)
    expect(calls).toHaveLength(1)
    expect(refreshes).toBe(0)
  })

  it('terminal app: picks up the local token file after a 401 from this machine’s daemon', async () => {
    const { env, dir } = localEnv(false)
    const { fetch, calls } = fakeFetch(call => (call.headers.Authorization === `Bearer ${LOCAL_TOKEN}` ? 200 : 401))
    const client = new TuiDaemonClient({ baseUrl: 'http://127.0.0.1:7385', localToken: true, env, fetch })
    expect(client.hasToken).toBe(false)
    writeFileSync(join(dir, DAEMON_TOKEN_FILENAME), `${LOCAL_TOKEN}\n`) // daemon first start
    await expect(client.health()).resolves.toEqual({ ok: true })
    expect(calls.map(c => c.headers.Authorization)).toEqual([undefined, `Bearer ${LOCAL_TOKEN}`])
  })

  it.each([
    ['a remote host', 'http://daemon.example:7385'],
    ['a remote https proxy', 'https://daemon.example'],
    ['a forwarded loopback port (ssh -L)', 'http://127.0.0.1:9999'],
  ])('terminal app: never sends the local token to %s, before or after a 401', async (_label, baseUrl) => {
    const { env } = localEnv(true)
    const { fetch, calls } = fakeFetch(401)
    const client = new TuiDaemonClient({ baseUrl, localToken: true, env, fetch })
    expect(client.hasToken).toBe(false)
    await expect(client.health()).rejects.toMatchObject({ status: 401 })
    expect(calls).toHaveLength(1)
    expect(calls[0].headers.Authorization).toBeUndefined()
    // Switching to it from the local daemon (/url) does not carry the local token either.
    const local = new TuiDaemonClient({ baseUrl: 'http://127.0.0.1:7385', localToken: true, env, fetch })
    expect(local.hasToken).toBe(true)
    await expect(local.withBaseUrl(baseUrl).health()).rejects.toMatchObject({ status: 401 })
    expect(calls.slice(1).map(c => c.headers.Authorization)).toEqual([undefined])
  })

  it('terminal app: --token is never re-read and stays with its own origin', async () => {
    const { env } = localEnv(true)
    const { fetch, calls } = fakeFetch(401)
    const client = new TuiDaemonClient({ baseUrl: 'http://127.0.0.1:7385', token: 'explicit', localToken: true, env, fetch })
    await expect(client.health()).rejects.toMatchObject({ status: 401 })
    expect(calls.map(c => c.headers.Authorization)).toEqual(['Bearer explicit'])
    await expect(client.withBaseUrl('http://daemon.example:7385').health()).rejects.toMatchObject({ status: 401 })
    expect(calls[1].headers.Authorization).toBeUndefined()
  })

  it('daemonCredentials resolves for its own URL only', () => {
    const { env } = localEnv(true)
    expect(daemonCredentials('http://127.0.0.1:7385', { localToken: true, env }).token()).toBe(LOCAL_TOKEN)
    expect(daemonCredentials('http://daemon.example:7385', { localToken: true, env }).token()).toBeUndefined()
    expect(daemonCredentials('http://daemon.example:7385', { localToken: true, env }).refresh?.()).toBe(false)
    expect(daemonCredentials('http://127.0.0.1:7385', { env }).token()).toBeUndefined()
  })
})

describe('timeouts', () => {
  const hanging = (async (_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
  })) as typeof fetch

  it('per call through request()', async () => {
    const client = new SharedDaemonClient({ baseUrl: 'http://127.0.0.1:7385', fetch: hanging, timeoutMs: 60_000 })
    await expect(client.request('GET', '/health', { timeoutMs: 20 })).rejects.toMatchObject({ status: null, message: expect.stringContaining('timed out after 20ms') })
  })

  it('per call for typed methods through withTimeout(), keeping the credentials', async () => {
    const seen: Array<string | undefined> = []
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push((init?.headers as Record<string, string>).Authorization)
      return hanging(input, init)
    }) as typeof globalThis.fetch
    const client = new SharedDaemonClient({ baseUrl: 'http://127.0.0.1:7385', credentials: staticCredentials('t'), fetch, timeoutMs: 60_000 })
    await expect(client.withTimeout(20).agents()).rejects.toMatchObject({ message: expect.stringContaining('timed out after 20ms') })
    expect(seen).toEqual(['Bearer t'])
  })

  it('does not send a mutation when its caller already cancelled it', async () => {
    const { fetch, calls } = fakeFetch()
    const client = new SharedDaemonClient({ baseUrl: 'http://daemon.example', fetch })
    const controller = new AbortController()
    controller.abort(new Error('cancelled by caller'))
    await expect(client.request('POST', '/agents/create', { body: {}, signal: controller.signal }))
      .rejects.toMatchObject({ status: null, message: expect.stringContaining('cancelled by caller') })
    expect(calls).toHaveLength(0)
  })

  it.each([200, 401, 500])('keeps the deadline active while an HTTP %i body stalls', async (status) => {
    const server = createServer((_req, res) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.write('{"unfinished":')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const client = new SharedDaemonClient({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, timeoutMs: 200 })
    try {
      await expect(client.request('GET', '/slow'))
        .rejects.toMatchObject({ status: null, message: expect.stringContaining('timed out after 200ms') })
    } finally {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('honours caller cancellation after response headers arrive', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.write('{"unfinished":')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const controller = new AbortController()
    const client = new SharedDaemonClient({
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      fetch: async (input, init) => {
        const response = await fetch(input, init)
        setTimeout(() => controller.abort(new Error('cancelled while reading')), 20)
        return response
      },
    })
    try {
      await expect(client.request('GET', '/slow', { signal: controller.signal }))
        .rejects.toMatchObject({ status: null, unreachable: true })
    } finally {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})

describe('origins', () => {
  it.each([
    ['IPv6 loopback', 'http://[::1]:7385', 'http://[::1]:7385/'],
    ['default http port', 'http://daemon.example', 'http://daemon.example:80'],
    ['default https port', 'https://daemon.example:443', 'https://daemon.example'],
  ])('%s: the same origin keeps the token', async (_label, baseUrl, sameAs) => {
    const { fetch, calls } = fakeFetch()
    const client = new SharedDaemonClient({ baseUrl, credentials: staticCredentials('t'), fetch })
    await client.health()
    await client.withBaseUrl(sameAs).health()
    expect(calls.map(c => c.headers.Authorization)).toEqual(['Bearer t', 'Bearer t'])
  })

  it.each([
    ['IPv6 vs IPv4 loopback', 'http://[::1]:7385', 'http://127.0.0.1:7385'],
    ['http vs https', 'http://daemon.example', 'https://daemon.example'],
    ['another port', 'https://daemon.example', 'https://daemon.example:8443'],
  ])('%s: another origin gets no token', async (_label, baseUrl, other) => {
    const { fetch, calls } = fakeFetch()
    await new SharedDaemonClient({ baseUrl, credentials: staticCredentials('t'), fetch }).withBaseUrl(other).health()
    expect(calls[0].headers.Authorization).toBeUndefined()
  })

  it('an opaque origin (file:, data:) never gets credentials', async () => {
    const { fetch, calls } = fakeFetch()
    const client = new SharedDaemonClient({ baseUrl: 'file:///tmp/daemon', credentials: staticCredentials('t'), fetch })
    expect(client.headers().Authorization).toBeUndefined()
    await client.withBaseUrl('file:///other').health()
    expect(calls[0].headers.Authorization).toBeUndefined()
  })
})

describe('withBaseUrl with a token (terminal app /url … --token)', () => {
  it('keeps the local proof for this machine’s daemon, as before the move', async () => {
    const { env, dir } = localEnv(false)
    const { proof } = mintLocalProof(dir)
    const { fetch, calls } = fakeFetch()
    const client = new TuiDaemonClient({ baseUrl: 'http://daemon.example:7385', localToken: true, env, fetch })
    const local = client.withBaseUrl('http://127.0.0.1:7385', 'T')
    expect(local).toBeInstanceOf(TuiDaemonClient)
    await local.unlockIdentity('passphrase')
    expect(calls[0].headers.Authorization).toBe('Bearer T')
    expect(calls[0].headers['X-ADF-Local-Proof']).toBe(proof)
    // A remote daemon with a token gets the token, never the proof.
    await local.withBaseUrl('http://daemon.example:7385', 'R').unlockIdentity('passphrase')
    expect(calls[1].headers.Authorization).toBe('Bearer R')
    expect(calls[1].headers['X-ADF-Local-Proof']).toBeUndefined()
  })

  it('derived clients keep the subclass', () => {
    const client = new TuiDaemonClient({ baseUrl: 'http://127.0.0.1:7385' })
    expect(client.withTimeout(5)).toBeInstanceOf(TuiDaemonClient)
    expect(client.withBaseUrl('http://daemon.example').withTimeout(5)).toBeInstanceOf(TuiDaemonClient)
    class Studio extends SharedDaemonClient {}
    expect(new Studio({ baseUrl: 'http://127.0.0.1:7385' }).withBaseUrl('http://daemon.example')).toBeInstanceOf(Studio)
  })
})

describe('redirects', () => {
  const servers: Server[] = []
  afterAll(async () => { await Promise.all(servers.map(s => new Promise(resolve => s.close(resolve)))) })

  async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
    const server = createServer(handler)
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }

  /** B records what reaches it; A redirects everything to B with `status`. */
  async function pair(status: number): Promise<{ a: string; reachedB: Array<{ url?: string; headers: Record<string, unknown>; body: string }> }> {
    const reachedB: Array<{ url?: string; headers: Record<string, unknown>; body: string }> = []
    const b = await listen((req, res) => {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => { reachedB.push({ url: req.url, headers: req.headers, body }); res.end('{"ok":true}') })
    })
    const a = await listen((req, res) => { res.writeHead(status, { Location: `${b}${req.url}` }); res.end() })
    return { a, reachedB }
  }

  const creds: DaemonCredentials = { token: () => 'secret', localProof: () => ({ 'X-ADF-Local-Proof': 'proof' }) }

  it.each([302, 307, 308])('a %i to another origin is refused: no token, proof or body reaches it', async status => {
    const { a, reachedB } = await pair(status)
    const client = new SharedDaemonClient({ baseUrl: a, credentials: creds })
    const err = await client.unlockIdentity('the-passphrase').catch(e => e)
    expect(err).toBeInstanceOf(DaemonError)
    expect(err.status).toBe(status)
    expect(err.message).toMatch(/redirect.*not followed/)
    expect(reachedB).toEqual([])
  })

  it('the event stream refuses a redirect too, and keeps retrying the daemon itself', async () => {
    const { a, reachedB } = await pair(302)
    const states: ConnectionInfo[] = []
    const stream = new SharedDaemonClient({ baseUrl: a, credentials: creds }).events({ onEvent: () => {}, onState: s => states.push(s), minBackoffMs: 5, maxBackoffMs: 5 }).start()
    await until(() => states.filter(s => s.error).length >= 2)
    stream.close()
    expect(states.find(s => s.error)?.error).toMatch(/redirect.*not followed/)
    expect(reachedB).toEqual([])
  })
})

describe('event stream', () => {
  /** A fetch that answers each connection with the next SSE script (then stays pending). */
  function sseFetch(scripts: string[]): { fetch: typeof fetch; urls: string[] } {
    const urls: string[] = []
    const impl = async (input: string | URL | Request, init?: RequestInit) => {
      urls.push(String(input))
      const script = scripts.shift()
      if (script === undefined) {
        return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
      }
      return new Response(script, { headers: { 'Content-Type': 'text/event-stream' } })
    }
    return { fetch: impl as typeof fetch, urls }
  }
  const hello = (epoch: string, latest: number) => `event: stream.hello\ndata: ${JSON.stringify({ epoch, oldestCursor: 1, latestCursor: latest })}\n\n`
  const frame = (cursor: number, id: string) => `data: ${JSON.stringify({ cursor, kind: 'host', id })}\n\n`

  interface ClientFrame { cursor: number; kind: string; id: string }
  const isClientFrame = (v: unknown): v is ClientFrame => !!v && typeof v === 'object' && (v as ClientFrame).kind === 'host'

  it.each([
    ['a new epoch', [hello('e1', 2) + frame(1, 'a') + frame(2, 'b'), hello('e2', 2) + frame(1, 'c') + frame(2, 'd')]],
    ['the cursor going backwards', [frame(1, 'a') + frame(2, 'b'), frame(1, 'c') + frame(2, 'd')]],
  ])('custom cursor-scoped keys are forgotten on a daemon restart (%s)', async (_label, scripts) => {
    const got: string[] = []
    const { fetch } = sseFetch([...scripts])
    const stream = new EventStream<ClientFrame>({
      baseUrl: 'http://127.0.0.1:7385', path: '/client/sessions/s-1/events', fetch, isFrame: isClientFrame,
      dedupeKey: f => ({ key: `k:${f.cursor}`, cursorScoped: true }),
      onEvent: f => got.push(f.id), minBackoffMs: 5, maxBackoffMs: 5,
    }).start()
    await until(() => got.length >= 4)
    stream.close()
    expect(got).toEqual(['a', 'b', 'c', 'd'])
  })

  it('durable custom keys still dedupe a replay across a reconnect', async () => {
    const got: string[] = []
    const { fetch } = sseFetch([hello('e1', 2) + frame(1, 'a') + frame(2, 'b'), hello('e1', 3) + frame(2, 'b') + frame(3, 'c')])
    const stream = new EventStream<ClientFrame>({
      baseUrl: 'http://127.0.0.1:7385', fetch, isFrame: isClientFrame,
      dedupeKey: f => ({ key: f.id, cursorScoped: false }),
      onEvent: f => got.push(f.id), minBackoffMs: 5, maxBackoffMs: 5,
    }).start()
    await until(() => got.length >= 3)
    stream.close()
    expect(got).toEqual(['a', 'b', 'c'])
  })

  it('re-reads a function query on every reconnect; since/epoch stay the stream’s', async () => {
    let focus = 'agent-1'
    const { fetch, urls } = sseFetch([hello('e1', 1) + frame(1, 'a')])
    const stream = new EventStream<ClientFrame>({
      baseUrl: 'http://127.0.0.1:7385', path: '/client/sessions/s-1/events', fetch, isFrame: isClientFrame,
      query: () => ({ focus, since: 99, epoch: 'caller' }), onEvent: () => { focus = 'agent-2' }, minBackoffMs: 5, maxBackoffMs: 5,
    }).start()
    await until(() => urls.length >= 2)
    stream.close()
    const [first, second] = urls.map(u => new URL(u).searchParams)
    expect(first.get('focus')).toBe('agent-1')
    expect(first.get('since')).toBe(String(Number.MAX_SAFE_INTEGER))
    expect(first.has('epoch')).toBe(false)
    expect(second.get('focus')).toBe('agent-2')
    expect(second.get('since')).toBe('1')
    expect(second.get('epoch')).toBe('e1')
  })

  it('a resume cursor without a hello epoch sends no caller epoch', async () => {
    const { fetch, urls } = sseFetch([])
    const stream = new EventStream<ClientFrame>({
      baseUrl: 'http://127.0.0.1:7385', fetch, since: 5, query: { epoch: 'caller' }, onEvent: () => {},
    }).start()
    await until(() => urls.length >= 1)
    stream.close()
    const params = new URL(urls[0]).searchParams
    expect(params.get('since')).toBe('5')
    expect(params.has('epoch')).toBe(false)
  })

  it('cancels the body of a non-ok answer', async () => {
    let cancelled = 0
    const fetch = (async () => new Response(new ReadableStream({ cancel: () => { cancelled++ } }), { status: 503 })) as typeof globalThis.fetch
    const states: ConnectionInfo[] = []
    const stream = new EventStream({ baseUrl: 'http://127.0.0.1:7385', fetch, onEvent: () => {}, onState: s => states.push(s), minBackoffMs: 5, maxBackoffMs: 5 }).start()
    await until(() => cancelled >= 1 && states.some(s => s.error))
    stream.close()
    expect(states.find(s => s.error)?.error).toMatch(/HTTP 503/)
  })
})

async function until(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
