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

  it('stdio: a uvx probe without args still runs uv tool run, so uv reports the missing package', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await probeMcpServer({ name: 'py', command: 'uvx' }, { uvManager, onLog: () => {} })
    expect(h.FakeManager.instances[0].connects[0].cfg).toMatchObject({ command: '/bin/uv', args: ['tool', 'run'] })
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('Failed to resolve uv binary'), expect.anything())
    warn.mockRestore()
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

const appServerOAuthStore = { get: async () => undefined, save: async () => {}, invalidate: async () => {} }

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
    appOAuthStore: { forServer: () => appServerOAuthStore },
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
    expect(h.oauthFlow).toHaveBeenCalledWith('https://mcp.example.test/mcp', appServerOAuthStore, d.oauthIO, { clientId: undefined, scopes: ['read'] })
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

  it('shared container without podman says compute is not ready, flagged for the compute sheet', async () => {
    const d = deps({ podman: { ...deps().podman, findPodman: async () => null } })
    const result = await runMcpRegistrationTest({ registration: { name: 'gh', type: 'npm', npmPackage: '@acme/gh' } }, d)
    expect(result.success).toBe(false)
    expect(result.computeUnavailable).toBe(true)
    expect(result.error).toMatch(/^MCP server "gh" runs in a container, and the compute environment is not ready: Podman is not installed\./)
  })

  it('a container that fails for another reason is a plain error', async () => {
    const d = deps({
      podman: { ...deps().podman, ensureRunning: async () => { throw new Error('image pull failed') } },
      podmanAvailability: async () => ({ available: true, machineRequired: false, platform: 'linux', installMethods: [], prerequisites: [] }),
    })
    const result = await runMcpRegistrationTest({ registration: { name: 'gh', type: 'npm', npmPackage: '@acme/gh' } }, d)
    expect(result.computeUnavailable).toBeUndefined()
    expect(result.error).toMatch(/^MCP container for "gh" is not ready: image pull failed/)
  })

  it('with MCP servers on this computer accepted, a default registration tests on the host', async () => {
    const d = deps({ computeSettings: () => ({ hostAccessEnabled: true, hostApproved: [], mcpOnHost: true }) })
    const result = await runMcpRegistrationTest({ registration: { name: 'gh', type: 'npm', npmPackage: '@acme/gh' } }, d)
    expect(result.location).toBe('host')
    expect(d.podman.ensureRunning).not.toHaveBeenCalled()
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
  it('writes a missing file under the registration\'s own ~ and never overwrites an existing one', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const root = mkdtempSync(join(tmpdir(), 'adf-mcp-test-home-'))
    // The server's ~ is its own folder under the user data dir, not the user's home.
    const home = join(root, 'mcp-home', 'app', 'gh')
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, ADF_USER_DATA_DIR: process.env.ADF_USER_DATA_DIR }
    process.env.HOME = root
    process.env.USERPROFILE = root
    process.env.ADF_USER_DATA_DIR = root
    try {
      mkdirSync(join(home, '.config', 'gh'), { recursive: true })
      writeFileSync(join(home, '.config', 'gh', 'hosts.yml'), 'old-token')
      const result = await runMcpRegistrationTest({
        registration: { name: 'gh', type: 'npm', npmPackage: '@acme/gh', runLocation: 'host', credentialFiles: [{ path: '~/.config/gh/hosts.yml' }, { path: '~/.config/gh/config.yml' }] },
        credentialFiles: [
          { path: '~/.config/gh/hosts.yml', contentB64: Buffer.from('new-token').toString('base64') },
          { path: '~/.config/gh/config.yml', contentB64: Buffer.from('fresh').toString('base64') },
        ],
      }, deps())
      expect(result.success).toBe(true)
      expect(readFileSync(join(home, '.config', 'gh', 'hosts.yml'), 'utf-8')).toBe('old-token')
      expect(readFileSync(join(home, '.config', 'gh', 'config.yml'), 'utf-8')).toBe('fresh')
      expect(existsSync(join(root, '.config', 'gh', 'config.yml'))).toBe(false)
      expect(result.notes).toEqual([
        '~/.config/gh/hosts.yml already exists — kept the existing file.',
        'Wrote ~/.config/gh/config.yml.',
      ])
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('runMcpRegistrationTest: Gmail built-in OAuth client', () => {
  const KEYS = '~/.gmail-mcp/gcp-oauth.keys.json'
  const BUILT_IN = '{"installed":{"client_id":"0-synthetic.apps.googleusercontent.com","client_secret":"synthetic"}}'
  const gmail = {
    name: 'gmail', type: 'npm', npmPackage: '@gongrzhe/server-gmail-autoauth-mcp', runLocation: 'host', auth: true, authArgs: ['auth'],
    credentialFiles: [{ path: KEYS, required: true }, { path: '~/.gmail-mcp/credentials.json' }],
  }

  async function withHome(fn: (home: string, fs: typeof import('node:fs'), join: typeof import('node:path').join) => Promise<void>) {
    const fs = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const root = fs.mkdtempSync(join(tmpdir(), 'adf-mcp-gmail-home-'))
    // The Settings server's ~ is its own folder (mcp-server-home.ts).
    const home = join(root, 'mcp-home', 'app', 'gmail')
    fs.mkdirSync(home, { recursive: true })
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, ADF_USER_DATA_DIR: process.env.ADF_USER_DATA_DIR }
    process.env.HOME = root
    process.env.USERPROFILE = root
    process.env.ADF_USER_DATA_DIR = root
    try {
      await fn(home, fs, join)
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
      vi.unstubAllGlobals()
      fs.rmSync(root, { recursive: true, force: true })
    }
  }

  it('no file chosen and none on the host: writes the built-in client 0600 before the sign-in', () => withHome(async (home, fs, join) => {
    vi.stubGlobal('__ADF_GMAIL_OAUTH_CLIENT__', BUILT_IN)
    const keysPath = join(home, '.gmail-mcp', 'gcp-oauth.keys.json')
    const d = deps({ authPreflight: vi.fn(async () => { expect(fs.readFileSync(keysPath, 'utf-8')).toBe(BUILT_IN) }) })
    const result = await runMcpRegistrationTest({ registration: gmail }, d)
    expect(result).toMatchObject({ success: true, location: 'host', authRan: true })
    expect(d.authPreflight).toHaveBeenCalledOnce()
    if (process.platform !== 'win32') expect(fs.statSync(keysPath).mode & 0o777).toBe(0o600)
    expect(fs.existsSync(join(home, '.gmail-mcp', 'credentials.json'))).toBe(false)
    expect(result.notes).toEqual([`Wrote the built-in OAuth client to ${KEYS}.`])
    expect(JSON.stringify(result)).not.toContain('synthetic')
  }))

  it('a chosen file wins over the built-in client', () => withHome(async (home, fs, join) => {
    vi.stubGlobal('__ADF_GMAIL_OAUTH_CLIENT__', BUILT_IN)
    const result = await runMcpRegistrationTest({
      registration: gmail,
      credentialFiles: [{ path: KEYS, contentB64: Buffer.from('own-client').toString('base64') }],
    }, deps())
    expect(result.success).toBe(true)
    expect(fs.readFileSync(join(home, '.gmail-mcp', 'gcp-oauth.keys.json'), 'utf-8')).toBe('own-client')
    expect(result.notes).toEqual([`Wrote ${KEYS}.`])
  }))

  it('an existing host client and token file are never modified', () => withHome(async (home, fs, join) => {
    vi.stubGlobal('__ADF_GMAIL_OAUTH_CLIENT__', BUILT_IN)
    fs.mkdirSync(join(home, '.gmail-mcp'))
    fs.writeFileSync(join(home, '.gmail-mcp', 'gcp-oauth.keys.json'), 'existing-client')
    fs.writeFileSync(join(home, '.gmail-mcp', 'credentials.json'), 'existing-tokens')
    const result = await runMcpRegistrationTest({ registration: gmail }, deps())
    expect(result.success).toBe(true)
    expect(fs.readFileSync(join(home, '.gmail-mcp', 'gcp-oauth.keys.json'), 'utf-8')).toBe('existing-client')
    expect(fs.readFileSync(join(home, '.gmail-mcp', 'credentials.json'), 'utf-8')).toBe('existing-tokens')
    expect(result.notes).toEqual([])
  }))

  it('Host access off: a host draft tests in the container and nothing is written to the host home', () => withHome(async (home, fs, join) => {
    vi.stubGlobal('__ADF_GMAIL_OAUTH_CLIENT__', BUILT_IN)
    const result = await runMcpRegistrationTest({ registration: gmail }, deps({ computeSettings: () => ({ hostAccessEnabled: false, hostApproved: [] }) }))
    expect(result.location).toBe('shared container')
    expect(fs.existsSync(join(home, '.gmail-mcp'))).toBe(false)
    expect(JSON.stringify(result.notes)).not.toContain('built-in')
  }))

  it('an existing token file with no client: does not write the client, says why, leaves the tokens byte-identical', () => withHome(async (home, fs, join) => {
    vi.stubGlobal('__ADF_GMAIL_OAUTH_CLIENT__', BUILT_IN)
    fs.mkdirSync(join(home, '.gmail-mcp'))
    fs.writeFileSync(join(home, '.gmail-mcp', 'credentials.json'), 'existing-tokens')
    const result = await runMcpRegistrationTest({ registration: gmail }, deps())
    expect(fs.existsSync(join(home, '.gmail-mcp', 'gcp-oauth.keys.json'))).toBe(false)
    expect(fs.readFileSync(join(home, '.gmail-mcp', 'credentials.json'), 'utf-8')).toBe('existing-tokens')
    expect(result.notes).toEqual([expect.stringMatching(/^Did not write the built-in OAuth client: ~\/.gmail-mcp\/credentials.json already exists/)])
    expect(JSON.stringify(result)).not.toContain('synthetic')
  }))

  it('builds without a client keep the manual flow; other packages never get it', () => withHome(async (home, fs, join) => {
    await runMcpRegistrationTest({ registration: gmail }, deps())
    expect(fs.existsSync(join(home, '.gmail-mcp'))).toBe(false)
    vi.stubGlobal('__ADF_GMAIL_OAUTH_CLIENT__', BUILT_IN)
    await runMcpRegistrationTest({ registration: { ...gmail, npmPackage: '@someone/gmail-mcp' } }, deps())
    expect(fs.existsSync(join(home, '.gmail-mcp'))).toBe(false)
  }))
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

describe('runMcpRegistrationTest: bundled Gmail server', () => {
  const GMAIL = '@gongrzhe/server-gmail-autoauth-mcp'
  const gmail = { name: 'gmail', type: 'npm', npmPackage: GMAIL, runLocation: 'host', auth: true, authArgs: ['auth'] }

  async function withBundle(fn: (entry: string) => Promise<void>) {
    const fs = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const resources = fs.mkdtempSync(join(tmpdir(), 'adf-connect-bundle-'))
    const entry = join(resources, 'mcp-servers', 'gmail', 'index.mjs')
    fs.mkdirSync(join(resources, 'mcp-servers', 'gmail'), { recursive: true })
    fs.writeFileSync(entry, '')
    const proc = process as { resourcesPath?: string }
    const saved = proc.resourcesPath
    proc.resourcesPath = resources
    Object.defineProperty(process.versions, 'electron', { value: '43.0.0', configurable: true, enumerable: true })
    try {
      await fn(entry)
    } finally {
      proc.resourcesPath = saved
      delete (process.versions as { electron?: string }).electron
      fs.rmSync(resources, { recursive: true, force: true })
    }
  }

  it('host, bundle present: auth preflight and connect run Studio\'s executable on the bundled entry', () => withBundle(async (entry) => {
    const d = deps()
    const result = await runMcpRegistrationTest({ registration: gmail }, d)
    expect(d.authPreflight).toHaveBeenCalledWith(expect.objectContaining({ command: process.execPath, args: [entry] }), expect.objectContaining({ authArgs: ['auth'] }))
    expect(h.FakeManager.instances[0].connects[0].cfg).toMatchObject({ command: process.execPath, args: [entry] })
    expect(result).toMatchObject({ success: true, location: 'host' })
  }))

  it('edited args, another package or the shared container keep npx', () => withBundle(async () => {
    await runMcpRegistrationTest({ registration: { ...gmail, args: ['--x'] } }, deps())
    expect(h.FakeManager.instances.at(-1)!.connects[0].cfg).toMatchObject({ command: 'npx', args: ['-y', GMAIL, '--x'] })
    await runMcpRegistrationTest({ registration: { ...gmail, npmPackage: '@acme/gh' } }, deps())
    expect(h.FakeManager.instances.at(-1)!.connects[0].cfg).toMatchObject({ command: 'npx', args: ['-y', '@acme/gh'] })
    const shared = await runMcpRegistrationTest({ registration: gmail }, deps({ computeSettings: () => ({ hostAccessEnabled: false, hostApproved: [] }) }))
    expect(shared.location).toBe('shared container')
    const transport = h.FakeManager.instances.at(-1)!.connects[0].opts?.externalTransport as { opts: { command: string; args: string[] } }
    expect(transport.opts).toMatchObject({ command: 'npx', args: ['-y', GMAIL] })
  }))

  it('no bundle (dev, npm daemon): npx exactly as before', async () => {
    const d = deps()
    await runMcpRegistrationTest({ registration: gmail }, d)
    expect(h.FakeManager.instances[0].connects[0].cfg).toMatchObject({ command: 'npx', args: ['-y', GMAIL] })
  })
})
