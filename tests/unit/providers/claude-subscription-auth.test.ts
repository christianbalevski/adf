import { EventEmitter } from 'node:events'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  files: new Set<string>(),
  versions: new Map<string, string>(),
  statusJson: '',
  execCalls: [] as string[][],
  /** Side effects and result of a non-version exec (an update or the installer). */
  onExec: null as null | ((path: string, args: string[]) => { err?: Error; stdout?: string; stderr?: string } | void),
  children: [] as Array<{ stdout: EventEmitter; stderr: EventEmitter; stdin: { write: (s: string) => void; written: string[] }; kill: () => void; killed: boolean } & EventEmitter>,
}))

vi.mock('node:fs/promises', () => ({
  access: async (p: string) => { if (!h.files.has(p)) throw new Error('ENOENT') },
  readFile: async () => { throw new Error('ENOENT') },
}))

vi.mock('node:child_process', () => ({
  execFile: (path: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    h.execCalls.push([path, ...args])
    setImmediate(() => {
      if (args[0] === '--version') {
        const v = h.versions.get(path)
        return v ? cb(null, `${v} (Claude Code)\n`, '') : cb(new Error('boom'), '', '')
      }
      if (args[0] === 'auth' && args[1] === 'status') return cb(null, h.statusJson, '')
      const r = h.onExec?.(path, args)
      cb(r?.err ?? null, r?.stdout ?? '', r?.stderr ?? '')
    })
  },
  spawn: () => {
    const written: string[] = []
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      stdin: { write: (s: string) => { written.push(s) }, written },
      killed: false,
      kill: () => { child.killed = true },
    })
    h.children.push(child)
    return child
  },
}))

const CLAUDE_URL = 'https://claude.ai/oauth/authorize?code=true&state=s'
const OLD = '/claude-old'
const NEW = join('/claude-new', process.platform === 'win32' ? 'claude.exe' : 'claude')

type AuthModule = typeof import('../../../src/main/providers/claude-subscription/auth-manager')
type CodeModule = typeof import('../../../src/main/providers/claude-subscription/claude-code')

let auth: AuthModule
let code: CodeModule
const savedEnv = { path: process.env.PATH, override: process.env.ADF_CLAUDE_CODE_PATH, appData: process.env.APPDATA }

const statusCalls = () => h.execCalls.filter(c => c[1] === 'auth' && c[2] === 'status').length

beforeEach(async () => {
  h.files.clear()
  h.versions.clear()
  h.execCalls.length = 0
  h.children.length = 0
  h.onExec = null
  h.statusJson = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'agent-1@example.test', subscriptionType: 'max' })
  process.env.ADF_CLAUDE_CODE_PATH = OLD
  process.env.PATH = ''
  delete process.env.APPDATA
  h.files.add(OLD)
  h.versions.set(OLD, '2.1.250')
  vi.resetModules()
  auth = await import('../../../src/main/providers/claude-subscription/auth-manager')
  code = await import('../../../src/main/providers/claude-subscription/claude-code')
})

afterEach(() => {
  process.env.PATH = savedEnv.path
  if (savedEnv.override === undefined) delete process.env.ADF_CLAUDE_CODE_PATH
  else process.env.ADF_CLAUDE_CODE_PATH = savedEnv.override
  if (savedEnv.appData !== undefined) process.env.APPDATA = savedEnv.appData
})

describe('Claude sign-in flow', () => {
  it('concurrent starts share one claude auth login', async () => {
    const m = auth.getClaudeAuthManager()
    const a = m.startAuthFlowDetached()
    const b = m.startAuthFlowDetached()
    await vi.waitFor(() => expect(h.children).toHaveLength(1))
    h.children[0].stdout.emit('data', Buffer.from(`Open ${CLAUDE_URL}\n`))
    const [fa, fb] = await Promise.all([a, b])
    expect(fa.url).toBe(CLAUDE_URL)
    expect(fb).toBe(fa)
    expect(await m.startAuthFlowDetached()).toBe(fa)
    expect(h.children).toHaveLength(1)
  })

  it('a child that exits before printing a URL leaves no dead pending flow', async () => {
    const m = auth.getClaudeAuthManager()
    const start = m.startAuthFlowDetached()
    await vi.waitFor(() => expect(h.children).toHaveLength(1))
    h.children[0].stderr.emit('data', Buffer.from('Error: network down\n'))
    h.children[0].emit('exit', 1)
    const flow = await start
    expect(flow.url).toBeUndefined()
    await expect(flow.completion).rejects.toThrow('network down')
    h.statusJson = JSON.stringify({ loggedIn: false })
    const status = await m.getAuthStatus()
    expect(status).toMatchObject({ authenticated: false, flowError: 'Claude sign-in failed: Error: network down' })
    expect('flowPending' in status && status.flowPending).toBeFalsy()
    void m.startAuthFlowDetached()
    await vi.waitFor(() => expect(h.children).toHaveLength(2))
  })

  it('a failed re-sign-in carries flowError next to the earlier account; a new start clears it', async () => {
    const m = auth.getClaudeAuthManager()
    const start = m.startAuthFlowDetached()
    await vi.waitFor(() => expect(h.children).toHaveLength(1))
    h.children[0].stderr.emit('data', Buffer.from('Error: access denied\n'))
    h.children[0].emit('exit', 1)
    await expect((await start).completion).rejects.toThrow('access denied')
    expect(await m.getAuthStatus()).toMatchObject({
      authenticated: true,
      email: 'agent-1@example.test',
      flowError: 'Claude sign-in failed: Error: access denied',
    })

    const restart = m.startAuthFlowDetached()
    await vi.waitFor(() => expect(h.children).toHaveLength(2))
    const pending = await m.getAuthStatus()
    expect(pending).toMatchObject({ authenticated: true, flowPending: true })
    expect('flowError' in pending ? pending.flowError : undefined).toBeUndefined()
    h.children[1].emit('exit', 0)
    await (await restart).completion
    const done = await m.getAuthStatus()
    expect(done).toMatchObject({ authenticated: true })
    expect('flowError' in done ? done.flowError : undefined).toBeUndefined()
  })

  it('a spawn error resolves the URL wait instead of hanging', async () => {
    const m = auth.getClaudeAuthManager()
    const start = m.startAuthFlowDetached()
    await vi.waitFor(() => expect(h.children).toHaveLength(1))
    h.children[0].emit('error', new Error('spawn EACCES'))
    const flow = await start
    await expect(flow.completion).rejects.toThrow('spawn EACCES')
    h.statusJson = JSON.stringify({ loggedIn: false })
    expect(await m.getAuthStatus()).toMatchObject({ flowError: 'spawn EACCES' })
  })

  it('cancel then restart keeps the new flow when the old child exits late', async () => {
    h.statusJson = JSON.stringify({ loggedIn: false })
    const m = auth.getClaudeAuthManager()
    const first = m.startAuthFlowDetached()
    await vi.waitFor(() => expect(h.children).toHaveLength(1))
    h.children[0].stdout.emit('data', Buffer.from(CLAUDE_URL))
    const old = await first
    m.cancelAuthFlow()
    expect(h.children[0].killed).toBe(true)

    void m.startAuthFlowDetached()
    await vi.waitFor(() => expect(h.children).toHaveLength(2))
    h.children[0].emit('exit', null)
    await expect(old.completion).rejects.toThrow('cancelled')

    const status = await m.getAuthStatus()
    expect(status).toMatchObject({ authenticated: false, flowPending: true })
    expect('flowError' in status ? status.flowError : undefined).toBeUndefined()
    m.submitCode('abc')
    expect(h.children[1].stdin.written).toEqual(['abc\n'])
  })
})

describe('Claude auth status cache', () => {
  it('caches and dedupes, re-reads on fresh, logout and login completion', async () => {
    const m = auth.getClaudeAuthManager()
    const [a, b] = await Promise.all([m.getAuthStatus(), m.getAuthStatus()])
    expect(a).toMatchObject({ authenticated: true, email: 'agent-1@example.test', plan: 'max' })
    expect(b).toBe(a)
    await m.getAuthStatus()
    expect(statusCalls()).toBe(1)

    await m.getAuthStatus({ fresh: true })
    expect(statusCalls()).toBe(2)

    await m.logout()
    h.statusJson = JSON.stringify({ loggedIn: false })
    expect(await m.getAuthStatus()).toMatchObject({ authenticated: false })
    expect(statusCalls()).toBe(3)

    const start = m.startAuthFlowDetached()
    await vi.waitFor(() => expect(h.children).toHaveLength(1))
    h.children[0].stdout.emit('data', Buffer.from(CLAUDE_URL))
    const flow = await start
    // Pending status is never cached.
    expect(await m.getAuthStatus()).toMatchObject({ flowPending: true, flowUrl: CLAUDE_URL })
    expect(await m.getAuthStatus()).toMatchObject({ flowPending: true })
    expect(statusCalls()).toBe(5)

    h.statusJson = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'agent-2@example.test' })
    h.children[0].emit('exit', 0)
    await flow.completion
    expect(await m.getAuthStatus()).toMatchObject({ authenticated: true, email: 'agent-2@example.test' })
    expect(await m.getAuthStatus()).not.toHaveProperty('flowPending')
    expect(statusCalls()).toBe(6)
  })

  it('reports a re-sign-in as pending while the old account is still signed in', async () => {
    const m = auth.getClaudeAuthManager()
    void m.startAuthFlowDetached()
    await vi.waitFor(() => expect(h.children).toHaveLength(1))
    expect(await m.getAuthStatus()).toMatchObject({ authenticated: true, flowPending: true })
  })
})

describe('Claude Code discovery', () => {
  it('prefers the newest install over an older one found first', async () => {
    process.env.PATH = '/claude-new'
    h.files.add(NEW)
    h.versions.set(OLD, '2.0.1')
    h.versions.set(NEW, '2.1.300')
    expect(await code.probeClaudeCode(true)).toEqual({ found: true, supported: true, install: { path: NEW, version: '2.1.300' } })
  })

  it('reports the newest unsupported install when none is supported', async () => {
    process.env.PATH = '/claude-new'
    h.files.add(NEW)
    h.versions.set(OLD, '2.0.1')
    h.versions.set(NEW, '2.0.9')
    expect(await code.probeClaudeCode(true)).toEqual({ found: true, supported: false, install: { path: NEW, version: '2.0.9' } })
  })

  it('dedupes concurrent probes and caches the result', async () => {
    const [a, b] = await Promise.all([code.probeClaudeCode(), code.probeClaudeCode()])
    expect(b).toBe(a)
    await code.probeClaudeCode()
    expect(h.execCalls.filter(c => c[1] === '--version')).toHaveLength(1)
  })
})

describe('Claude Code install', () => {
  const NATIVE = join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude')
  const isInstaller = (args: string[]) => args.some(a => a.includes('https://claude.ai/install.'))
  const installerRuns = () => h.execCalls.filter(c => isInstaller(c.slice(1))).length
  const updateRuns = () => h.execCalls.filter(c => c[1] === 'update').length
  const installNative = (version: string) => { h.files.add(NATIVE); h.versions.set(NATIVE, version) }

  it('runs the native installer when Claude Code is missing; concurrent callers share the run', async () => {
    h.files.clear()
    h.versions.clear()
    h.onExec = (_path, args) => { if (isInstaller(args)) installNative('2.1.300') }
    const m = auth.getClaudeAuthManager()
    expect(await m.getAuthStatus()).toMatchObject({ installed: false })
    const [a, b] = await Promise.all([code.installClaudeCode(), code.installClaudeCode()])
    expect(a).toEqual({ path: NATIVE, version: '2.1.300' })
    expect(b).toBe(a)
    expect(installerRuns()).toBe(1)
    expect(updateRuns()).toBe(0)
    // The manager's cached "not installed" is dropped.
    expect(await m.install()).toMatchObject({ authenticated: true, installed: true, version: '2.1.300' })
  })

  it('a supported install is left alone', async () => {
    expect(await code.installClaudeCode()).toEqual({ path: OLD, version: '2.1.250' })
    expect(installerRuns() + updateRuns()).toBe(0)
  })

  it('updates an outdated copy in place with claude update', async () => {
    h.versions.set(OLD, '2.0.1')
    h.onExec = (path, args) => { if (path === OLD && args[0] === 'update') h.versions.set(OLD, '2.1.300') }
    expect(await code.installClaudeCode()).toEqual({ path: OLD, version: '2.1.300' })
    expect(updateRuns()).toBe(1)
    expect(installerRuns()).toBe(0)
  })

  it('falls back to the native installer when claude update leaves it outdated', async () => {
    h.versions.set(OLD, '2.0.1')
    h.onExec = (_path, args) => {
      if (args[0] === 'update') return { stdout: 'Claude is up to date!' }
      if (isInstaller(args)) installNative('2.1.300')
    }
    expect(await code.installClaudeCode()).toEqual({ path: NATIVE, version: '2.1.300' })
    expect(updateRuns()).toBe(1)
    expect(installerRuns()).toBe(1)
  })

  it('a failed installer reports its last line and the manual install page', async () => {
    h.files.clear()
    h.versions.clear()
    h.onExec = (_path, args) => {
      if (isInstaller(args)) return { err: new Error('exit 22'), stderr: 'Downloading...\ncurl: (6) Could not resolve host: claude.ai\n' }
    }
    await expect(code.installClaudeCode()).rejects.toThrow(
      `Claude Code could not be installed: curl: (6) Could not resolve host: claude.ai. Install it from ${code.CLAUDE_CODE_INSTALL_URL}.`,
    )
  })
})

describe('claudeCodeEnv', () => {
  it('drops inherited Claude Code / Anthropic settings, keeps config dir and proxies, applies extra', () => {
    const vars = {
      ANTHROPIC_API_KEY: 'k', ANTHROPIC_CUSTOM_HEADERS: 'x', ANTHROPIC_MODEL: 'm', CLAUDE_CODE_EXTRA_BODY: '{}',
      CLAUDE_CODE_SIMPLE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDECODE: '1', ELECTRON_RUN_AS_NODE: '1',
      CLAUDE_CONFIG_DIR: '/cfg', HTTPS_PROXY: 'http://proxy', NO_PROXY: 'localhost', NODE_EXTRA_CA_CERTS: '/ca.pem',
    }
    const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]))
    Object.assign(process.env, vars)
    try {
      const env = code.claudeCodeEnv({ CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' })
      for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_MODEL', 'CLAUDE_CODE_EXTRA_BODY', 'CLAUDE_CODE_SIMPLE', 'CLAUDECODE', 'ELECTRON_RUN_AS_NODE']) {
        expect(env).not.toHaveProperty(k)
      }
      expect(env).toMatchObject({ CLAUDE_CONFIG_DIR: '/cfg', HTTPS_PROXY: 'http://proxy', NO_PROXY: 'localhost', NODE_EXTRA_CA_CERTS: '/ca.pem', CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' })
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })
})
