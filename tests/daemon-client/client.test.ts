// The shared daemon client (src/shared/daemon-client, design D8): token scope,
// the 401 re-read, per-call timeouts and arbitrary SSE paths. Fetch is faked:
// nothing here opens a socket or reads the real token file.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DaemonClient as SharedDaemonClient, DaemonError, staticCredentials, type DaemonCredentials } from '../../src/shared/daemon-client'
import { DaemonClient as TuiDaemonClient } from '../../src/main/tui/api/client'
import { daemonCredentials } from '../../src/main/cli/daemon-url'
import { DAEMON_TOKEN_FILENAME } from '../../src/main/daemon/daemon-token'

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
})

async function until(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
