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

type Server = ReturnType<typeof setup>

/** Poll GET /jobs/:id until the job leaves `running`. */
async function awaitJob(server: Server, jobId: string): Promise<Record<string, any>> {
  for (let i = 0; i < 500; i++) {
    const job = (await server.inject({ method: 'GET', url: `/jobs/${jobId}` })).json()
    if (job.state !== 'running') return job
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`job ${jobId} still running`)
}

async function startTest(server: Server, payload: unknown): Promise<string> {
  const res = await server.inject({ method: 'POST', url: '/admin/mcp/registration-test', payload: payload as object })
  expect(res.statusCode).toBe(202)
  const body = res.json()
  expect(body.job).toMatchObject({ id: body.jobId, kind: 'mcp.registration-test', state: 'running' })
  return body.jobId
}

describe('registration test as a job, with interactive steps', () => {
  it('an OAuth authorization URL is handed to the client while the test runs; the result arrives on the job', async () => {
    const store = { get: vi.fn(async () => undefined), save: vi.fn(async () => {}), invalidate: vi.fn(async () => {}) }
    const server = setup({ routes: { gaps: { mcpAppOAuthStore: store, uvManager } } })
    let release!: () => void
    h.oauthFlow.mockImplementation(async (_url: string, _store: unknown, io: { openUrl(u: string): void }) => {
      io.openUrl('https://auth.example.test/authorize?state=abc')
      await new Promise<void>((r) => { release = r })
      return { authorized: true }
    })
    const jobId = await startTest(server, { registration: { name: 'remote', type: 'http', url: 'https://mcp.example.test/mcp', oauth: true } })
    await vi.waitFor(() => expect(h.oauthFlow).toHaveBeenCalled())
    const list = (await server.inject({ method: 'GET', url: `/admin/mcp/interactions?jobId=${jobId}` })).json()
    expect(list.interactions).toEqual([expect.objectContaining({ jobId, kind: 'open_url', state: 'pending', serverName: 'remote', url: 'https://auth.example.test/authorize?state=abc' })])
    expect((await server.inject({ method: 'POST', url: `/admin/mcp/interactions/${list.interactions[0].id}/continue` })).json()).toEqual({ success: true })
    release()
    const job = await awaitJob(server, jobId)
    expect(job.state).toBe('succeeded')
    expect(job.result).toMatchObject({ success: true, location: 'remote http', oauthRan: true, authRan: true })
    expect((await server.inject({ method: 'GET', url: '/admin/mcp/interactions' })).json()).toEqual({ interactions: [] })
    expect((await server.inject({ method: 'POST', url: '/admin/mcp/interactions/nope/continue' })).statusCode).toBe(404)
    expect((await server.inject({ method: 'GET', url: '/jobs/no-such-job' })).statusCode).toBe(404)
  })

  it('the stdio auth preflight Continue prompt waits for the client', async () => {
    const server = setup({ routes: { gaps: { uvManager } } })
    let confirmed = false
    h.preflight.mockImplementation(async (_cfg: unknown, _opts: unknown, io: { confirm(i: { serverName: string; authUrlOpened: boolean }): Promise<void> }) => {
      await io.confirm({ serverName: 'gh', authUrlOpened: true })
      confirmed = true
    })
    const jobId = await startTest(server, { registration: { name: 'gh', type: 'npm', npmPackage: '@acme/gh', runLocation: 'host', auth: true } })
    let id = ''
    await vi.waitFor(async () => {
      const list = (await server.inject({ method: 'GET', url: `/admin/mcp/interactions?jobId=${jobId}` })).json()
      expect(list.interactions).toHaveLength(1)
      expect(list.interactions[0]).toMatchObject({ kind: 'confirm', state: 'pending', serverName: 'gh', authUrlOpened: true })
      id = list.interactions[0].id
    })
    expect(confirmed).toBe(false)
    await server.inject({ method: 'POST', url: `/admin/mcp/interactions/${id}/continue` })
    const job = await awaitJob(server, jobId)
    expect(confirmed).toBe(true)
    expect(job.result).toMatchObject({ success: true, location: 'host', authRan: true, notes: [] })
  })

  it('an unanswered confirm is kept as timed_out and named in the result', async () => {
    const server = setup({ routes: { gaps: { uvManager, mcpConfirmTimeoutMs: 50 } } })
    let afterConfirm!: () => void
    const gate = new Promise<void>((r) => { afterConfirm = r })
    h.preflight.mockImplementation(async (_cfg: unknown, _opts: unknown, io: { confirm(i: { serverName: string; authUrlOpened: boolean }): Promise<void> }) => {
      await io.confirm({ serverName: 'gh', authUrlOpened: false })
      await gate // hold the run so the timed-out step can be observed
    })
    const jobId = await startTest(server, { registration: { name: 'gh', type: 'npm', npmPackage: '@acme/gh', runLocation: 'host', auth: true } })
    await vi.waitFor(async () => {
      const list = (await server.inject({ method: 'GET', url: `/admin/mcp/interactions?jobId=${jobId}` })).json()
      expect(list.interactions).toEqual([expect.objectContaining({ kind: 'confirm', state: 'timed_out' })])
      // A timed-out step cannot be answered any more.
      expect((await server.inject({ method: 'POST', url: `/admin/mcp/interactions/${list.interactions[0].id}/continue` })).statusCode).toBe(404)
    })
    afterConfirm()
    const job = await awaitJob(server, jobId)
    expect(job.result.notes).toEqual([expect.stringMatching(/^No one confirmed the authorization step for "gh"/)])
    expect((await server.inject({ method: 'GET', url: '/admin/mcp/interactions' })).json()).toEqual({ interactions: [] })
  })

  it('POST /jobs/:id/cancel stops a running test and releases its pending steps', async () => {
    const server = setup({ routes: { gaps: { uvManager } } })
    let preflightDone = false
    h.preflight.mockImplementation(async (_cfg: unknown, _opts: unknown, io: { confirm(i: { serverName: string; authUrlOpened: boolean }): Promise<void> }) => {
      await io.confirm({ serverName: 'gh', authUrlOpened: true })
      preflightDone = true
    })
    const jobId = await startTest(server, { registration: { name: 'gh', type: 'npm', npmPackage: '@acme/gh', runLocation: 'host', auth: true } })
    await vi.waitFor(async () => expect((await server.inject({ method: 'GET', url: `/admin/mcp/interactions?jobId=${jobId}` })).json().interactions).toHaveLength(1))
    const cancel = await server.inject({ method: 'POST', url: `/jobs/${jobId}/cancel` })
    expect(cancel.json()).toMatchObject({ cancelled: true, job: { state: 'cancelled', error: 'Cancelled by the client' } })
    await vi.waitFor(async () => expect((await server.inject({ method: 'GET', url: '/admin/mcp/interactions' })).json().interactions).toEqual([]))
    expect(preflightDone).toBe(true) // the waiting confirm was released
    expect((await server.inject({ method: 'GET', url: `/jobs/${jobId}` })).json().state).toBe('cancelled')
    expect((await server.inject({ method: 'POST', url: `/jobs/${jobId}/cancel` })).json()).toMatchObject({ cancelled: false })
  })

  it('without an app OAuth store an OAuth remote fails plainly', async () => {
    const server = setup()
    const jobId = await startTest(server, { registration: { name: 'remote', type: 'http', url: 'https://mcp.example.test/mcp', oauth: true } })
    const job = await awaitJob(server, jobId)
    expect(job.result).toMatchObject({ success: false, oauthRan: true, error: 'MCP OAuth sign-in is not available on this host: it has no app-level OAuth token store.' })
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
  it('runs as a job with the daemon UvManager', async () => {
    const server = setup({ routes: { gaps: { uvManager } } })
    const res = await server.inject({ method: 'POST', url: '/admin/mcp/python-runtime' })
    expect(res.statusCode).toBe(202)
    const job = await awaitJob(server, res.json().jobId)
    expect(job).toMatchObject({ kind: 'mcp.python-runtime', state: 'succeeded', result: { success: true, uvAvailable: true, uvVersion: '0.5.1', pythonAvailable: true, uvPath: '/bin/uv' } })
  })
})
