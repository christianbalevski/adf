// Characterization of Studio's MCP_PROBE_SERVER and MCP_REGISTRATION_TEST
// handlers (ipc/index.ts), written against their bodies before they moved
// into services/mcp-connect-tests.ts (rule E1). The client manager, the OAuth
// flow and the podman transport are faked; what is pinned is the argument
// validation, the connect config each branch builds, the logs it hands back
// and the result shape.
import { describe, expect, it, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  class FakeManager {
    static instances: FakeManager[] = []
    static tools: unknown[] | null = [{ name: 'search', description: 'Search' }]
    static error = 'boom'
    connects: Array<{ cfg: Record<string, unknown>; opts?: Record<string, unknown> }> = []
    listeners: Record<string, (...a: unknown[]) => void> = {}
    disconnected = false
    oauthFactory: unknown
    constructor(_scratch?: unknown, oauthFactory?: unknown) {
      this.oauthFactory = oauthFactory
      FakeManager.instances.push(this)
    }
    on(event: string, fn: (...a: unknown[]) => void) { this.listeners[event] = fn; return this }
    async connect(cfg: Record<string, unknown>, opts?: Record<string, unknown>) {
      this.connects.push({ cfg, opts })
      this.listeners.log?.(cfg.name, { timestamp: 1, stream: 'stderr', message: 'started' })
      return FakeManager.tools
    }
    getServerState(name: string) {
      return { name, error: FakeManager.error, logs: [{ stream: 'stderr', message: 'line-1' }, { stream: 'stdout', message: 'x' }] }
    }
    getServerReportedVersion() { return '1.2.3' }
    async disconnectAll() { this.disconnected = true }
  }
  return { FakeManager, oauthFlow: vi.fn(async () => ({ authorized: true })) }
})

vi.mock('../../../src/main/services/mcp-client-manager', () => ({ McpClientManager: h.FakeManager }))
vi.mock('../../../src/main/services/mcp-http-oauth', async (orig) => ({ ...(await orig<object>()), runMcpHttpOAuthFlow: h.oauthFlow }))
vi.mock('../../../src/main/services/podman-stdio-transport', () => ({
  PodmanStdioTransport: class { constructor(readonly opts: unknown) {} },
}))

import { appendMcpLog, probeMcpServer, runMcpRegistrationTest, type McpRegistrationTestDeps } from '../../../src/main/services/mcp-connect-tests'

beforeEach(() => {
  h.FakeManager.instances.length = 0
  h.FakeManager.tools = [{ name: 'search', description: 'Search' }]
  h.oauthFlow.mockClear()
})

const uvManager = { ensureUv: vi.fn(async () => '/bin/uv') }

describe('probeMcpServer', () => {
  it('rejects bad args with the IPC error shape', async () => {
    const onLog = vi.fn()
    expect(await probeMcpServer({ name: 'x', transport: 'http' }, { uvManager, onLog })).toEqual({
      success: false, tools: [], error: 'Invalid arguments: HTTP probes require url; stdio probes require command.',
    })
  })

  it('stdio: resolves uvx to uv tool run, connects, disconnects, returns tools; logs go to the sink', async () => {
    const onLog = vi.fn()
    const result = await probeMcpServer({ name: 'py', command: 'uvx', args: ['mcp-server-x'], env: { A: '1' } }, { uvManager, onLog })
    expect(result).toEqual({ success: true, tools: [{ name: 'search', description: 'Search' }] })
    const m = h.FakeManager.instances[0]
    expect(m.connects[0].cfg).toEqual({ name: 'py', transport: 'stdio', command: '/bin/uv', args: ['tool', 'run', 'mcp-server-x'], env: { A: '1' } })
    expect(m.disconnected).toBe(true)
    expect(onLog).toHaveBeenCalledWith('py', { timestamp: 1, stream: 'stderr', message: 'started' })
  })

  it('http: maps headerEnv and the bearer env var; a failed connect reports the server error', async () => {
    h.FakeManager.tools = null
    const result = await probeMcpServer({
      name: 'remote', transport: 'http', url: 'https://mcp.example.test/mcp',
      headers: { 'X-A': '1' }, headerEnv: [{ key: 'Authorization', value: 'TOKEN' }], bearerTokenEnvVar: 'TOKEN',
    }, { uvManager, onLog: () => {} })
    expect(result).toEqual({ success: false, tools: [], error: 'boom' })
    expect(h.FakeManager.instances[0].connects[0].cfg).toEqual({
      name: 'remote', transport: 'http', url: 'https://mcp.example.test/mcp', env: undefined, headers: { 'X-A': '1' },
      header_env: [{ header: 'Authorization', env: 'TOKEN', required: true }], bearer_token_env_var: 'TOKEN',
    })
  })
})

function deps(over: Partial<McpRegistrationTestDeps> = {}): McpRegistrationTestDeps {
  return {
    computeSettings: () => ({ hostAccessEnabled: true, hostApproved: [] }),
    uvManager,
    podman: {
      ensureRunning: vi.fn(async () => {}),
      findPodman: vi.fn(async () => '/usr/bin/podman'),
      ensureWorkspace: vi.fn(async () => {}),
      execInContainer: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
    },
    appOAuthStore: { get: async () => undefined, save: async () => {}, invalidate: async () => {} },
    oauthIO: { openUrl: () => {} },
    authPreflight: vi.fn(async () => {}),
    onLog: () => {},
    ...over,
  }
}

describe('runMcpRegistrationTest', () => {
  it('bad args: a type-complete failure with the best-effort location', async () => {
    const result = await runMcpRegistrationTest({ registration: { url: 'not a url', name: 'r' } }, deps())
    expect(result).toMatchObject({ success: false, tools: [], location: 'remote http', authRan: false, notes: [] })
    expect(result.error).toMatch(/^Invalid arguments:/)
    expect(await runMcpRegistrationTest({ registration: { runLocation: 'host' } }, deps())).toMatchObject({ location: 'host' })
    expect(await runMcpRegistrationTest(null, deps())).toMatchObject({ location: 'shared container' })
  })

  it('remote http with OAuth runs the sign-in first, then connects', async () => {
    const d = deps()
    const result = await runMcpRegistrationTest({ registration: { name: 'r', type: 'http', url: 'https://mcp.example.test/mcp', oauth: true, oauthScopes: ['read'] } }, d)
    expect(h.oauthFlow).toHaveBeenCalledWith('https://mcp.example.test/mcp', d.appOAuthStore, d.oauthIO, { clientId: undefined, scopes: ['read'] })
    expect(result).toEqual({
      success: true, tools: [{ name: 'search', description: 'Search' }], location: 'remote http', authRan: true, oauthRan: true,
      notes: ['Interactive OAuth sign-in runs in a browser during this test.'], serverVersion: '1.2.3',
    })
  })

  it('remote http: a sign-in that does not complete fails with its error and no connect', async () => {
    h.oauthFlow.mockResolvedValueOnce({ authorized: false, error: 'denied' } as never)
    const result = await runMcpRegistrationTest({ registration: { name: 'r', type: 'http', url: 'https://mcp.example.test/mcp', oauth: true } }, deps())
    expect(result).toMatchObject({ success: false, error: 'denied', oauthRan: true, stderrTail: ['line-1'] })
    expect(h.FakeManager.instances[0].connects).toEqual([])
  })

  it('host: resolves the npm launch, runs the auth preflight when auth is set, connects over stdio', async () => {
    const d = deps()
    const result = await runMcpRegistrationTest({
      registration: { name: 'gh', type: 'npm', npmPackage: '@acme/gh', args: ['--x'], runLocation: 'host', auth: true, authArgs: ['auth'], env: [{ key: 'K', value: 'v' }, { key: 'EMPTY', value: '' }] },
    }, d)
    expect(d.authPreflight).toHaveBeenCalledWith(expect.objectContaining({ command: 'npx', args: ['-y', '@acme/gh', '--x'] }), { authArgs: ['auth'], authPort: undefined, resolvedEnv: { K: 'v' } })
    expect(h.FakeManager.instances[0].connects[0].cfg).toEqual({ name: 'gh', transport: 'stdio', command: 'npx', args: ['-y', '@acme/gh', '--x'], env: { K: 'v' } })
    expect(result).toMatchObject({ success: true, location: 'host', authRan: true, oauthRan: false, notes: [] })
  })

  it('host access off: runs in the shared container under a throwaway home, cleaned up after', async () => {
    const d = deps({ computeSettings: () => ({ hostAccessEnabled: false, hostApproved: [] }) })
    const result = await runMcpRegistrationTest({ registration: { name: 'gh', type: 'npm', npmPackage: '@acme/gh', runLocation: 'host' } }, d)
    expect(result).toMatchObject({ success: true, location: 'shared container', authRan: false })
    expect(d.podman.ensureRunning).toHaveBeenCalled()
    const ws = (d.podman.ensureWorkspace as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(ws[0]).toBe('adf-mcp')
    expect(ws[1]).toMatch(/^\/workspace\/_settings_test_[0-9a-f-]{36}\/home$/)
    const connect = h.FakeManager.instances[0].connects[0]
    expect(connect.cfg).toEqual({ name: 'gh', transport: 'stdio', env: {} })
    expect(connect.opts?.externalTransport).toBeTruthy()
    await new Promise((r) => setTimeout(r, 0))
    expect((d.podman.execInContainer as ReturnType<typeof vi.fn>).mock.calls[0][2]).toMatch(/^rm -rf \/workspace\/_settings_test_/)
  })

  it('shared container without podman fails with the install hint', async () => {
    const d = deps({ podman: { ...deps().podman, findPodman: async () => null } })
    const result = await runMcpRegistrationTest({ registration: { name: 'gh', type: 'npm', npmPackage: '@acme/gh' } }, d)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/^Podman is unavailable/)
  })
})

describe('appendMcpLog', () => {
  it('keeps the last 500 entries per server', () => {
    const cache = new Map()
    for (let i = 0; i < 505; i++) appendMcpLog(cache, 's', { timestamp: i, stream: 'stdout', message: String(i) } as never)
    expect(cache.get('s')).toHaveLength(500)
    expect(cache.get('s')[0].message).toBe('5')
  })
})

describe('runMcpRegistrationTest: host credential files', () => {
  it('writes a missing file under ~ and never overwrites an existing one', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import('node:fs')
    const { tmpdir, homedir } = await import('node:os')
    const { join } = await import('node:path')
    const home = mkdtempSync(join(tmpdir(), 'adf-mcp-test-home-'))
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
    process.env.HOME = home
    process.env.USERPROFILE = home
    try {
      expect(homedir()).toBe(home)
      mkdirSync(join(home, '.config', 'gh'), { recursive: true })
      writeFileSync(join(home, '.config', 'gh', 'hosts.yml'), 'old-token')
      const result = await runMcpRegistrationTest({
        registration: { name: 'gh', type: 'npm', npmPackage: '@acme/gh', runLocation: 'host' },
        credentialFiles: [
          { path: '~/.config/gh/hosts.yml', contentB64: Buffer.from('new-token').toString('base64') },
          { path: '~/.config/gh/config.yml', contentB64: Buffer.from('fresh').toString('base64') },
        ],
      }, deps())
      expect(result.success).toBe(true)
      expect(readFileSync(join(home, '.config', 'gh', 'hosts.yml'), 'utf-8')).toBe('old-token')
      expect(readFileSync(join(home, '.config', 'gh', 'config.yml'), 'utf-8')).toBe('fresh')
      expect(result.notes).toEqual([
        '~/.config/gh/hosts.yml already exists on the host — kept the existing file.',
        'Wrote ~/.config/gh/config.yml to the host home.',
      ])
    } finally {
      process.env.HOME = saved.HOME
      process.env.USERPROFILE = saved.USERPROFILE
      if (saved.HOME === undefined) delete process.env.HOME
      if (saved.USERPROFILE === undefined) delete process.env.USERPROFILE
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('runMcpRegistrationTest: cancel signal', () => {
  it('stops at the next step, disconnects and answers Cancelled', async () => {
    const controller = new AbortController()
    let releasePreflight!: () => void
    const d = deps({ authPreflight: vi.fn(() => new Promise<void>((r) => { releasePreflight = r })) })
    const run = runMcpRegistrationTest({ registration: { name: 'gh', type: 'npm', npmPackage: '@acme/gh', runLocation: 'host', auth: true } }, { ...d, signal: controller.signal })
    await vi.waitFor(() => expect(d.authPreflight).toHaveBeenCalled())
    controller.abort()
    const result = await run
    expect(result).toMatchObject({ success: false, error: 'Cancelled', location: 'host' })
    const manager = h.FakeManager.instances.at(-1)!
    expect(manager.connects).toEqual([]) // never got to connect
    expect(manager.disconnected).toBe(true)
    releasePreflight()
  })
})
