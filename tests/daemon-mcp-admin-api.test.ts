// Settings → MCP routes (W1-D): probe, registration test and its
// interactive steps relayed to the client, server logs, OAuth status (a
// flag, never a token), sign-out and the Python runtime. The client
// manager, the OAuth flow and the auth preflight are faked; no process is
// spawned and no PodmanService is constructed.
import { afterEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  class FakeManager {
    static instances: FakeManager[] = []
    listeners: Record<string, (...a: unknown[]) => void> = {}
    constructor() { FakeManager.instances.push(this) }
    on(event: string, fn: (...a: unknown[]) => void) { this.listeners[event] = fn; return this }
    async connect(cfg: { name: string }) {
      this.listeners.log?.(cfg.name, { timestamp: 1, stream: 'stderr', message: `hello from ${cfg.name}` })
      return [{ name: 'search' }]
    }
    getServerState() { return { error: undefined, logs: [] } }
    getServerReportedVersion() { return undefined }
    async disconnectAll() {}
  }
  return {
    FakeManager,
    oauthFlow: vi.fn(),
    preflight: vi.fn(),
  }
})
vi.mock('../src/main/services/mcp-client-manager', () => ({ McpClientManager: h.FakeManager }))
vi.mock('../src/main/services/mcp-http-oauth', async (orig) => ({ ...(await orig<object>()), runMcpHttpOAuthFlow: h.oauthFlow }))
vi.mock('../src/main/services/mcp-auth-preflight', async (orig) => ({ ...(await orig<object>()), runMcpAuthPreflight: h.preflight }))

import { createDaemonHttpApi, type DaemonHttpApiOptions } from '../src/main/daemon/http-api'
import { RuntimeService } from '../src/main/runtime/runtime-service'

const TOKEN = 'mcp-access-SECRET-77'
const cleanups: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => {
  h.oauthFlow.mockReset()
  h.preflight.mockReset()
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

function setup(opts: Partial<DaemonHttpApiOptions> = {}, settingsData: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { compute: { hostAccessEnabled: true, hostApproved: [] }, ...settingsData }
  const server = createDaemonHttpApi(new RuntimeService({ enforceReviewGate: false }), { settingsStore: { get: (k: string) => data[k] }, ...opts })
  cleanups.push(() => server.close())
  return server
}

const uvManager = {
  ensureUv: vi.fn(async () => '/bin/uv'),
  getUvVersion: vi.fn(async () => '0.5.1'),
  isPythonAvailable: vi.fn(async () => true),
  ensurePython: vi.fn(async () => {}),
}

describe('probe and logs', () => {
  it('POST /admin/mcp/probe answers as Studio and keeps the run logs for GET /admin/mcp/logs/:serverName', async () => {
    const server = setup({ routes: { gaps: { uvManager } } })
    const res = await server.inject({ method: 'POST', url: '/admin/mcp/probe', payload: { name: 'fs', command: 'node', args: ['server.js'] } })
    expect(res.json()).toEqual({ success: true, tools: [{ name: 'search' }] })
    const logs = await server.inject({ method: 'GET', url: '/admin/mcp/logs/fs' })
    expect(logs.json()).toEqual({ logs: [{ timestamp: 1, stream: 'stderr', message: 'hello from fs' }] })
    expect((await server.inject({ method: 'GET', url: '/admin/mcp/logs/other' })).json()).toEqual({ logs: [] })
    const bad = await server.inject({ method: 'POST', url: '/admin/mcp/probe', payload: { transport: 'http', name: 'x' } })
    expect(bad.json()).toEqual({ success: false, tools: [], error: 'Invalid arguments: HTTP probes require url; stdio probes require command.' })
  })
})

describe('registration test interactive steps', () => {
  it('an OAuth authorization URL is handed to the client while the test runs', async () => {
    const store = { get: vi.fn(async () => undefined), save: vi.fn(async () => {}), invalidate: vi.fn(async () => {}) }
    const server = setup({ routes: { gaps: { mcpAppOAuthStore: store, uvManager } } })
    let release!: () => void
    h.oauthFlow.mockImplementation(async (_url: string, _store: unknown, io: { openUrl(u: string): void }) => {
      io.openUrl('https://auth.example.test/authorize?state=abc')
      await new Promise<void>((r) => { release = r })
      return { authorized: true }
    })
    const pending = server.inject({ method: 'POST', url: '/admin/mcp/registration-test', payload: { interactionTag: 'tag-1', registration: { name: 'remote', type: 'http', url: 'https://mcp.example.test/mcp', oauth: true } } })
    await vi.waitFor(() => expect(h.oauthFlow).toHaveBeenCalled())
    const list = (await server.inject({ method: 'GET', url: '/admin/mcp/interactions?tag=tag-1' })).json()
    expect(list.interactions).toEqual([expect.objectContaining({ kind: 'open_url', tag: 'tag-1', serverName: 'remote', url: 'https://auth.example.test/authorize?state=abc' })])
    expect((await server.inject({ method: 'POST', url: `/admin/mcp/interactions/${list.interactions[0].id}/continue` })).json()).toEqual({ success: true })
    release()
    const res = await pending
    expect(res.json()).toMatchObject({ success: true, location: 'remote http', oauthRan: true, authRan: true })
    expect((await server.inject({ method: 'GET', url: '/admin/mcp/interactions' })).json()).toEqual({ interactions: [] })
    expect((await server.inject({ method: 'POST', url: '/admin/mcp/interactions/nope/continue' })).statusCode).toBe(404)
  })

  it('the stdio auth preflight Continue prompt waits for the client', async () => {
    const server = setup({ routes: { gaps: { uvManager } } })
    let confirmed = false
    h.preflight.mockImplementation(async (_cfg: unknown, _opts: unknown, io: { confirm(i: { serverName: string; authUrlOpened: boolean }): Promise<void> }) => {
      await io.confirm({ serverName: 'gh', authUrlOpened: true })
      confirmed = true
    })
    const pending = server.inject({ method: 'POST', url: '/admin/mcp/registration-test', payload: { registration: { name: 'gh', type: 'npm', npmPackage: '@acme/gh', runLocation: 'host', auth: true } } })
    let id = ''
    await vi.waitFor(async () => {
      const list = (await server.inject({ method: 'GET', url: '/admin/mcp/interactions' })).json()
      expect(list.interactions).toHaveLength(1)
      expect(list.interactions[0]).toMatchObject({ kind: 'confirm', serverName: 'gh', authUrlOpened: true })
      id = list.interactions[0].id
    })
    expect(confirmed).toBe(false)
    await server.inject({ method: 'POST', url: `/admin/mcp/interactions/${id}/continue` })
    const res = await pending
    expect(confirmed).toBe(true)
    expect(res.json()).toMatchObject({ success: true, location: 'host', authRan: true })
  })

  it('without an app OAuth store an OAuth remote fails plainly', async () => {
    const server = setup()
    const res = await server.inject({ method: 'POST', url: '/admin/mcp/registration-test', payload: { registration: { name: 'remote', type: 'http', url: 'https://mcp.example.test/mcp', oauth: true } } })
    expect(res.json()).toMatchObject({ success: false, oauthRan: true, error: 'MCP OAuth sign-in is not available on this host: it has no app-level OAuth token store.' })
    expect(h.oauthFlow).not.toHaveBeenCalled()
  })
})

describe('OAuth status and sign-out', () => {
  it('status is a flag only; sign-out clears the store record', async () => {
    const store = { get: vi.fn(async () => ({ tokens: { access_token: TOKEN, token_type: 'bearer', refresh_token: TOKEN }, updatedAt: 1 })), save: vi.fn(), invalidate: vi.fn(async () => {}) }
    const server = setup({ routes: { gaps: { mcpAppOAuthStore: store } } })
    const status = await server.inject({ method: 'GET', url: '/admin/mcp/oauth/status?url=https%3A%2F%2Fmcp.example.test%2Fmcp' })
    expect(status.json()).toEqual({ signedIn: true })
    expect(status.body).not.toContain(TOKEN)
    expect(store.get).toHaveBeenCalledWith('https://mcp.example.test/mcp')
    expect((await server.inject({ method: 'GET', url: '/admin/mcp/oauth/status' })).json()).toEqual({ signedIn: false })
    const out = await server.inject({ method: 'POST', url: '/admin/mcp/oauth/signout', payload: { url: 'https://mcp.example.test/mcp' } })
    expect(out.json()).toEqual({ success: true })
    expect(store.invalidate).toHaveBeenCalledWith('https://mcp.example.test/mcp', 'all')
  })

  it('without a store: signed out, and sign-out refuses', async () => {
    const server = setup()
    expect((await server.inject({ method: 'GET', url: '/admin/mcp/oauth/status?url=https%3A%2F%2Fx.test' })).json()).toEqual({ signedIn: false })
    expect((await server.inject({ method: 'POST', url: '/admin/mcp/oauth/signout', payload: { url: 'https://x.test' } })).json().success).toBe(false)
  })
})

describe('POST /admin/mcp/python-runtime', () => {
  it('ensures uv and Python with the daemon UvManager', async () => {
    const server = setup({ routes: { gaps: { uvManager } } })
    expect((await server.inject({ method: 'POST', url: '/admin/mcp/python-runtime' })).json()).toEqual({ success: true, uvAvailable: true, uvVersion: '0.5.1', pythonAvailable: true, uvPath: '/bin/uv' })
  })
})
