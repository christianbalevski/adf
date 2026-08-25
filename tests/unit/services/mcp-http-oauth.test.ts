import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'http'
import type { Server, IncomingMessage, ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import {
  AdfOAuthClientProvider,
  startOAuthCallbackServer,
  runMcpHttpOAuthFlow,
  type McpHttpOAuthIO,
} from '../../../src/main/services/mcp-http-oauth'
import type { McpOAuthStore, McpOAuthRecord, McpOAuthInvalidateScope } from '../../../src/main/services/mcp-oauth.types'
import { canonicalizeServerUrl } from '../../../src/main/services/mcp-oauth.types'

/**
 * Sub-task A tests (docs/design/mcp-http-oauth.md). Two layers:
 *  - Full flow: a mock authorization server on http loopback (RFC 8414
 *    metadata + RFC 7591 DCR + token endpoint) driven end-to-end by
 *    runMcpHttpOAuthFlow. The browser hop is short-circuited: io.openUrl
 *    parses the authorization URL and fetches the loopback callback with
 *    code+state, exactly as a real browser redirect would.
 *  - Unit: the provider methods (metadata shape, state, store round-trip) and
 *    the callback server (state validation, single-use, code extraction).
 *
 * The mock AS advertises an https authorization_endpoint (so the provider's
 * https-only guard passes) that is never actually fetched — only its query is
 * read by openUrl — while /register and /token stay on http loopback.
 */

/** Map-backed McpOAuthStore for tests. */
function makeStore(): McpOAuthStore & { map: Map<string, McpOAuthRecord> } {
  const map = new Map<string, McpOAuthRecord>()
  return {
    map,
    async get(url) { return map.get(url) },
    async save(url, record) { map.set(url, record) },
    async invalidate(url, scope: McpOAuthInvalidateScope = 'all') {
      const rec = map.get(url)
      if (!rec) return
      if (scope === 'all') { map.delete(url); return }
      if (scope === 'tokens') { const { tokens: _t, ...rest } = rec; map.set(url, { ...rest, updatedAt: Date.now() }) }
      if (scope === 'client') { const { clientInformation: _c, ...rest } = rec; map.set(url, { ...rest, updatedAt: Date.now() }) }
    },
  }
}

interface MockAS {
  server: Server
  origin: string
  hits: { register: number; token: number; grants: string[] }
  close(): Promise<void>
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (c) => { data += c })
    req.on('end', () => resolve(data))
  })
}

/** Mock authorization server: RFC 8414 metadata, DCR /register, /token. */
async function startMockAS(opts: { hangToken?: boolean } = {}): Promise<MockAS> {
  const hits = { register: 0, token: 0, grants: [] as string[] }
  let origin = ''
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', origin)
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        issuer: origin,
        // https so the provider's guard passes; never fetched (browser hop is
        // short-circuited), only its query is parsed by openUrl.
        authorization_endpoint: `https://127.0.0.1${new URL(origin).port ? ':' + new URL(origin).port : ''}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      }))
      return
    }
    if (url.pathname === '/register' && req.method === 'POST') {
      hits.register++
      const body = JSON.parse((await readBody(req)) || '{}')
      res.writeHead(201, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        client_id: 'mock-client-id',
        redirect_uris: body.redirect_uris ?? [],
        grant_types: body.grant_types,
        response_types: body.response_types,
        token_endpoint_auth_method: 'none',
        client_id_issued_at: Math.floor(Date.now() / 1000),
      }))
      return
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      hits.token++
      const params = new URLSearchParams(await readBody(req))
      hits.grants.push(params.get('grant_type') ?? '')
      // Stalled token endpoint: accept the request but never send a response,
      // so the flow's overall deadline (not undici's default) must cut it off.
      if (opts.hangToken) return
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        access_token: `access-${hits.token}`,
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: `refresh-${hits.token}`,
        scope: 'read',
      }))
      return
    }
    // RFC 9728 protected-resource metadata not served → 404, SDK falls back to
    // treating the server URL as the authorization server.
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  origin = `http://127.0.0.1:${port}`
  return {
    server,
    origin,
    hits,
    close: () => new Promise<void>((r) => {
      // Force-close any lingering sockets (e.g. a hung /token request whose
      // client was aborted) so server.close resolves promptly.
      ;(server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.()
      server.close(() => r())
    }),
  }
}

let toClose: Array<{ close(): void | Promise<void> }> = []
afterEach(async () => {
  for (const c of toClose) { try { await c.close() } catch { /* ignore */ } }
  toClose = []
})

describe('runMcpHttpOAuthFlow (full flow against a mock AS)', () => {
  it('drives DCR → authorize → token exchange to authorized:true and persists tokens + client info', async () => {
    const as = await startMockAS()
    toClose.push(as)
    const store = makeStore()

    // Browser hop: parse the authorization URL and hit the loopback callback.
    const openUrl = vi.fn(async (authUrl: string) => {
      const u = new URL(authUrl)
      const state = u.searchParams.get('state')!
      const redirectUri = u.searchParams.get('redirect_uri')!
      await fetch(`${redirectUri}?code=the-code&state=${encodeURIComponent(state)}`)
    })
    const io: McpHttpOAuthIO = { openUrl, log: () => {} }

    const result = await runMcpHttpOAuthFlow(as.origin, store, io)

    expect(result).toEqual({ authorized: true })
    expect(openUrl).toHaveBeenCalledTimes(1)
    // Opened URL was the https authorization endpoint.
    expect((openUrl.mock.calls[0][0] as string).startsWith('https://')).toBe(true)
    expect(as.hits.register).toBe(1)
    expect(as.hits.grants).toEqual(['authorization_code'])

    const record = store.map.get(as.origin)!
    expect(record.tokens?.access_token).toBe('access-1')
    expect(record.tokens?.refresh_token).toBe('refresh-1')
    expect(record.clientInformation?.client_id).toBe('mock-client-id')
    expect(record.discoveryState?.authorizationServerUrl).toBeTruthy()
    // Minted-for url stamped for later URL-binding at read time.
    expect(record.serverUrl).toBe(canonicalizeServerUrl(as.origin))
  })

  it('bounds the token-exchange hop: a stalled /token response fails at the deadline, not undici default', async () => {
    const as = await startMockAS({ hangToken: true })
    toClose.push(as)
    const store = makeStore()

    const openUrl = vi.fn(async (authUrl: string) => {
      const u = new URL(authUrl)
      const state = u.searchParams.get('state')!
      const redirectUri = u.searchParams.get('redirect_uri')!
      await fetch(`${redirectUri}?code=the-code&state=${encodeURIComponent(state)}`)
    })
    const io: McpHttpOAuthIO = { openUrl, log: () => {} }

    const started = Date.now()
    const result = await runMcpHttpOAuthFlow(as.origin, store, io, { timeoutMs: 800 })
    const elapsed = Date.now() - started

    expect(result.authorized).toBe(false)
    expect(result.error).toMatch(/timed out/i)
    // Cut off near the deadline, nowhere near undici's ~300s default.
    expect(elapsed).toBeLessThan(5000)
    expect(store.map.get(as.origin)?.tokens).toBeUndefined()
    // The code exchange was actually attempted (request reached /token).
    expect(as.hits.token).toBe(1)
  })

  it('reuses a stored refresh token on a second run: AUTHORIZED with no browser hop and no re-registration', async () => {
    const as = await startMockAS()
    toClose.push(as)
    const store = makeStore()

    const openUrl = vi.fn(async (authUrl: string) => {
      const u = new URL(authUrl)
      const state = u.searchParams.get('state')!
      const redirectUri = u.searchParams.get('redirect_uri')!
      await fetch(`${redirectUri}?code=the-code&state=${encodeURIComponent(state)}`)
    })
    const io: McpHttpOAuthIO = { openUrl, log: () => {} }

    const first = await runMcpHttpOAuthFlow(as.origin, store, io)
    expect(first.authorized).toBe(true)
    expect(openUrl).toHaveBeenCalledTimes(1)

    const second = await runMcpHttpOAuthFlow(as.origin, store, io)
    expect(second.authorized).toBe(true)
    // No new browser hop, no new DCR — just a refresh_token grant.
    expect(openUrl).toHaveBeenCalledTimes(1)
    expect(as.hits.register).toBe(1)
    expect(as.hits.grants).toEqual(['authorization_code', 'refresh_token'])
    expect(store.map.get(as.origin)?.tokens?.access_token).toBe('access-2')
  })

  it('a forged-state callback does not settle or persist tokens — the flow times out instead', async () => {
    // A stray/forged redirect (wrong state) must NOT tear down the in-flight
    // authorization (that would be a local DoS); with no genuine redirect to
    // follow, the flow simply reaches its deadline. No tokens are minted.
    const as = await startMockAS()
    toClose.push(as)
    const store = makeStore()

    const openUrl = vi.fn(async (authUrl: string) => {
      const u = new URL(authUrl)
      const redirectUri = u.searchParams.get('redirect_uri')!
      // Deliberately wrong state.
      await fetch(`${redirectUri}?code=the-code&state=WRONG`)
    })
    const io: McpHttpOAuthIO = { openUrl, log: () => {} }

    const result = await runMcpHttpOAuthFlow(as.origin, store, io, { timeoutMs: 300 })
    expect(result.authorized).toBe(false)
    expect(result.error).toMatch(/timed out/i)
    // No token exchange happened, nothing persisted.
    expect(as.hits.token).toBe(0)
    expect(store.map.get(as.origin)?.tokens).toBeUndefined()
  })
})

describe('AdfOAuthClientProvider', () => {
  const io: McpHttpOAuthIO = { openUrl: () => {}, log: () => {} }

  it('builds the expected client metadata (public client, DCR grants, scopes joined)', () => {
    const store = makeStore()
    const p = new AdfOAuthClientProvider('https://mcp.example.com', store, io, {
      redirectUrl: 'http://127.0.0.1:5000/callback',
      scopes: ['read', 'write'],
    })
    expect(p.redirectUrl).toBe('http://127.0.0.1:5000/callback')
    expect(p.clientMetadata).toEqual({
      client_name: 'ADF Studio',
      redirect_uris: ['http://127.0.0.1:5000/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'read write',
    })
  })

  it('omits scope from metadata when none configured', () => {
    const p = new AdfOAuthClientProvider('https://mcp.example.com', makeStore(), io, {
      redirectUrl: 'http://127.0.0.1:5000/callback',
    })
    expect('scope' in p.clientMetadata).toBe(false)
  })

  it('generates fresh random state and exposes it for callback validation', () => {
    const p = new AdfOAuthClientProvider('https://mcp.example.com', makeStore(), io, {
      redirectUrl: 'http://127.0.0.1:5000/callback',
    })
    expect(p.lastState).toBeUndefined()
    const s1 = p.state()
    expect(p.lastState).toBe(s1)
    expect(s1.length).toBeGreaterThan(20)
    const s2 = p.state()
    expect(s2).not.toBe(s1)
    expect(p.lastState).toBe(s2)
  })

  it('round-trips tokens, client information and discovery state through the store', async () => {
    const store = makeStore()
    const url = 'https://mcp.example.com'
    const p = new AdfOAuthClientProvider(url, store, io, { redirectUrl: 'http://127.0.0.1:5000/callback' })

    expect(await p.tokens()).toBeUndefined()
    expect(await p.clientInformation()).toBeUndefined()

    await p.saveClientInformation({ client_id: 'abc', redirect_uris: [] } as never)
    await p.saveTokens({ access_token: 'tok', token_type: 'Bearer', refresh_token: 'ref' })
    await p.saveDiscoveryState({ authorizationServerUrl: 'https://as.example.com' } as never)

    expect((await p.clientInformation())?.client_id).toBe('abc')
    expect((await p.tokens())?.access_token).toBe('tok')
    expect((await p.discoveryState())?.authorizationServerUrl).toBe('https://as.example.com')
    // All merged into one record.
    const rec = store.map.get(url)!
    expect(rec.tokens && rec.clientInformation && rec.discoveryState).toBeTruthy()
  })

  it('short-circuits DCR when a static clientId is provided', async () => {
    const store = makeStore()
    const p = new AdfOAuthClientProvider('https://mcp.example.com', store, io, {
      redirectUrl: 'http://127.0.0.1:5000/callback',
      clientId: 'preregistered',
    })
    expect((await p.clientInformation())?.client_id).toBe('preregistered')
  })

  it('keeps the PKCE verifier in memory (never touches the store)', async () => {
    const store = makeStore()
    const p = new AdfOAuthClientProvider('https://mcp.example.com', store, io, { redirectUrl: 'http://127.0.0.1:5000/callback' })
    expect(() => p.codeVerifier()).toThrow(/code verifier/)
    p.saveCodeVerifier('verifier-123')
    expect(p.codeVerifier()).toBe('verifier-123')
    expect(store.map.size).toBe(0)
  })

  it('refuses to open a non-https authorization URL', async () => {
    const opened: string[] = []
    const p = new AdfOAuthClientProvider('https://mcp.example.com', makeStore(),
      { openUrl: (u) => { opened.push(u) } },
      { redirectUrl: 'http://127.0.0.1:5000/callback' })
    await expect(p.redirectToAuthorization(new URL('http://evil.example.com/authorize'))).rejects.toThrow(/non-https/)
    expect(opened).toEqual([])
    await p.redirectToAuthorization(new URL('https://as.example.com/authorize?state=x'))
    expect(opened).toEqual(['https://as.example.com/authorize?state=x'])
  })

  it('maps invalidateCredentials scopes to the store', async () => {
    const store = makeStore()
    const url = 'https://mcp.example.com'
    const p = new AdfOAuthClientProvider(url, store, io, { redirectUrl: 'http://127.0.0.1:5000/callback' })
    await p.saveTokens({ access_token: 'tok', token_type: 'Bearer' })
    await p.saveClientInformation({ client_id: 'abc', redirect_uris: [] } as never)

    await p.invalidateCredentials('tokens')
    expect((await p.tokens())).toBeUndefined()
    expect((await p.clientInformation())?.client_id).toBe('abc')

    await p.invalidateCredentials('all')
    expect(store.map.has(url)).toBe(false)
  })
})

describe('startOAuthCallbackServer', () => {
  it('resolves waitForCode with the code when state matches, and serves a close-tab page', async () => {
    const server = await startOAuthCallbackServer(() => 'good-state')
    toClose.push({ close: () => server.close() })

    const res = await fetch(`${server.url}?code=xyz&state=good-state`)
    expect(res.status).toBe(200)
    expect((await res.text()).toLowerCase()).toContain('authorization complete')
    await expect(server.waitForCode).resolves.toBe('xyz')
  })

  it('binds loopback only', async () => {
    const server = await startOAuthCallbackServer(() => 'good-state')
    toClose.push({ close: () => server.close() })
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
  })

  it('answers 400 on a state mismatch but KEEPS listening, then resolves on a later valid callback', async () => {
    const server = await startOAuthCallbackServer(() => 'good-state')
    toClose.push({ close: () => server.close() })

    // Stray/forged hit: 400, but the listener must stay up (no DoS teardown).
    const bad = await fetch(`${server.url}?code=xyz&state=bad-state`)
    expect(bad.status).toBe(400)

    // waitForCode is still pending — a subsequent genuine redirect resolves it.
    const good = await fetch(`${server.url}?code=real&state=good-state`)
    expect(good.status).toBe(200)
    await expect(server.waitForCode).resolves.toBe('real')
  })

  it('rejects waitForCode when close() is called before a callback', async () => {
    const server = await startOAuthCallbackServer(() => 'good-state')
    server.close()
    await expect(server.waitForCode).rejects.toThrow(/closed before/)
  })

  it('is single-use: a second valid callback does not reach the (closed) server', async () => {
    const server = await startOAuthCallbackServer(() => 'good-state')
    toClose.push({ close: () => server.close() })
    const url = server.url

    const first = await fetch(`${url}?code=one&state=good-state`)
    expect(first.status).toBe(200)
    await expect(server.waitForCode).resolves.toBe('one')

    // The listener has closed; a second request should fail to connect.
    await expect(fetch(`${url}?code=two&state=good-state`)).rejects.toThrow()
  })

  it('times out and rejects waitForCode', async () => {
    const server = await startOAuthCallbackServer(() => 'good-state', 150)
    toClose.push({ close: () => server.close() })
    await expect(server.waitForCode).rejects.toThrow(/timed out/i)
  })
})
