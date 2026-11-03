// Several registrations of one MCP server (e.g. two accounts of the same
// package): each additional instance runs with its own HOME folder and keeps
// its credentials apart from the first. Generic — the fake server here is a
// plain stdio script that keeps a token under ~, nothing Gmail-specific.
//
// Never touches the real home: HOME (os.homedir() on POSIX) and the user data
// dir are temp dirs for the whole file.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { McpClientManager } from '../../../src/main/services/mcp-client-manager'
import {
  asAdditionalInstance,
  buildMcpServerConfigFromRegistration,
  mcpCredentialNamespace,
  mcpOAuthStoreKey,
  pinServerConfigToRegistration,
  registrationDisplayName,
  sameMcpServerSource,
  type McpInstanceServerConfig,
} from '../../../src/shared/utils/mcp-config'
import {
  containerIsolatedHomeEnv,
  hostIsolatedHomeEnv,
  hostMcpInstanceHome,
  mcpServerContainerHome,
} from '../../../src/main/services/mcp-instance-home'
import {
  captureCredentialFile,
  credentialFilePurposes,
  materializeCredentialFiles,
  writeBackCredentialFiles,
  type CredentialContainerTarget,
} from '../../../src/main/services/mcp-credential-files'
import { resolveMcpEnvVars } from '../../../src/main/services/mcp-spawn-utils'
import { runMcpAuthPreflight } from '../../../src/main/services/mcp-auth-preflight'
import { AppSettingsOAuthStore, instanceOAuthStore } from '../../../src/main/services/mcp-oauth-store'
import { mcpOAuthSignOut, mcpOAuthStatus, runMcpRegistrationTest } from '../../../src/main/services/mcp-connect-tests'
import { McpInstallTool } from '../../../src/main/tools/built-in/mcp-install.tool'
import { draftFromRegistryEntry, isRegistrationNameLocked, isRegistryEntryRegistered } from '../../../src/renderer/components/mcp/McpAddServerModal'
import { uninstallsPackageOnRemove } from '../../../src/renderer/components/mcp/McpStatusDashboard'
import type { McpRegistryEntry } from '../../../src/shared/constants/mcp-registry'
import { GMAIL_BUNDLED_CLIENT_NPM_PACKAGE, GMAIL_BUNDLED_CLIENT_PATH, GMAIL_BUNDLED_TOKEN_PATH } from '../../../src/shared/utils/gmail-oauth-client'
import type { McpServerConfig } from '../../../src/shared/types/adf-v02.types'
import type { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import type { McpServerRegistration } from '../../../src/shared/types/ipc.types'

const TOKEN_PATH = '~/.fake-mcp/token'

let root: string
let realHome: string
let userData: string
let serverScript: string
const savedEnv: Record<string, string | undefined> = {}

function setEnv(key: string, value: string | undefined): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

/** A minimal stdio MCP server: keeps a token at ~/.fake-mcp/token and reports its home. */
const FAKE_SERVER = String.raw`
const fs = require('fs'), path = require('path'), os = require('os'), readline = require('readline')
const tokenPath = () => path.join(os.homedir(), '.fake-mcp', 'token')
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n')
const text = (id, t) => send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: t }] } })
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m; try { m = JSON.parse(line) } catch { return }
  if (m.method === 'initialize') {
    send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1.0.0' } } })
  } else if (m.method === 'tools/list') {
    const obj = { type: 'object', properties: { account: { type: 'string' } } }
    send({ jsonrpc: '2.0', id: m.id, result: { tools: [
      { name: 'whoami', description: 'home', inputSchema: obj },
      { name: 'sign_in', description: 'store a token', inputSchema: obj },
      { name: 'read_token', description: 'read the token', inputSchema: obj },
    ] } })
  } else if (m.method === 'tools/call') {
    const name = m.params.name
    if (name === 'whoami') text(m.id, JSON.stringify({ HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, homedir: os.homedir(), npmCache: process.env.npm_config_cache }))
    else if (name === 'sign_in') { fs.mkdirSync(path.dirname(tokenPath()), { recursive: true }); fs.writeFileSync(tokenPath(), m.params.arguments.account); text(m.id, 'ok') }
    else text(m.id, fs.existsSync(tokenPath()) ? fs.readFileSync(tokenPath(), 'utf8') : '')
  } else if (m.id !== undefined) {
    send({ jsonrpc: '2.0', id: m.id, result: {} })
  }
})
`

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'adf-mcp-instances-'))
  realHome = join(root, 'home')
  userData = join(root, 'user-data')
  mkdirSync(realHome, { recursive: true })
  mkdirSync(userData, { recursive: true })
  setEnv('HOME', realHome)
  setEnv('USERPROFILE', realHome)
  setEnv('ADF_USER_DATA_DIR', userData)
  serverScript = join(root, 'fake-mcp-server.cjs')
  writeFileSync(serverScript, FAKE_SERVER)
})

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  rmSync(root, { recursive: true, force: true })
})

function fakeRegistration(partial: Partial<McpServerRegistration> = {}): McpServerRegistration {
  return { id: 'mcp:one', name: 'fake', type: 'custom', command: process.execPath, args: [serverScript], runLocation: 'host', ...partial }
}

function memStore(rows: Record<string, string> = {}) {
  return {
    rows,
    getDecrypted: (p: string) => rows[p] ?? null,
    hasRow: (p: string) => p in rows,
    setIdentitySealed: (p: string, v: string) => { rows[p] = v },
  }
}

function record(content: string): string {
  return JSON.stringify({ encoding: 'base64', data: Buffer.from(content).toString('base64'), mode: 0o600 })
}

describe('adding a registered server again', () => {
  it('numbers the name -2, then -3, and flags the instance; the first is untouched', () => {
    const first = fakeRegistration()
    expect(asAdditionalInstance(first, [])).toBe(first)
    expect(first.isolatedHome).toBeUndefined()

    const second = asAdditionalInstance(fakeRegistration({ id: 'mcp:two' }), [first])
    expect(second).toMatchObject({ name: 'fake-2', isolatedHome: true })
    const third = asAdditionalInstance(fakeRegistration({ id: 'mcp:three' }), [first, second])
    expect(third).toMatchObject({ name: 'fake-3', isolatedHome: true })
    // A free name the user chose is kept; the instance is still flagged.
    expect(asAdditionalInstance(fakeRegistration({ id: 'mcp:w', name: 'fake_work' }), [first])).toMatchObject({ name: 'fake_work', isolatedHome: true })
    // A different command is a different server.
    expect(asAdditionalInstance(fakeRegistration({ id: 'mcp:o', args: ['other.js'] }), [first])).toMatchObject({ name: 'fake' })
  })

  it('matches the same package, URL or command only', () => {
    expect(sameMcpServerSource({ npmPackage: '@x/a' }, { npmPackage: '@x/a', name: 'n' } as McpServerRegistration)).toBe(true)
    expect(sameMcpServerSource({ npmPackage: '@x/a' }, { npmPackage: '@x/b' })).toBe(false)
    expect(sameMcpServerSource({ type: 'uvx', pypiPackage: 'p' }, { type: 'uvx', pypiPackage: 'p' })).toBe(true)
    expect(sameMcpServerSource({ type: 'http', url: 'https://m.example/mcp' }, { type: 'http', url: 'https://m.example/mcp' })).toBe(true)
    expect(sameMcpServerSource({ type: 'http', url: 'https://m.example/mcp' }, { npmPackage: '@x/a' })).toBe(false)
    expect(sameMcpServerSource({ type: 'custom', command: 'node', args: ['a'] }, { type: 'custom', command: 'node', args: ['b'] })).toBe(false)
  })

  it('a catalog card for a registered entry starts an additional instance', () => {
    const entry: McpRegistryEntry = { name: 'fakecat', displayName: 'Fake', description: 'd', category: 'tools', requiredEnvKeys: [], verified: false, npmPackage: '@x/fakecat' }
    const fresh = draftFromRegistryEntry(entry, 'mcp:a', [])
    expect(fresh).toMatchObject({ name: 'fakecat', npmPackage: '@x/fakecat' })
    expect(fresh.isolatedHome).toBeUndefined()
    expect(isRegistryEntryRegistered(entry, [])).toBe(false)

    const existing = [{ ...fresh, version: '1.0.0' }]
    expect(isRegistryEntryRegistered(entry, existing)).toBe(true)
    const again = draftFromRegistryEntry(entry, 'mcp:b', existing)
    expect(again).toMatchObject({ name: 'fakecat-2', npmPackage: '@x/fakecat', isolatedHome: true })
    const third = draftFromRegistryEntry(entry, 'mcp:c', [...existing, again])
    expect(third.name).toBe('fakecat-3')
  })

  it('the name is read-only once an additional instance is saved; a first registration stays editable', () => {
    const saved = fakeRegistration({ id: 'mcp:two', name: 'fake-2', isolatedHome: true })
    expect(isRegistrationNameLocked(saved, saved)).toBe(true)
    expect(isRegistrationNameLocked(null, saved)).toBe(false) // still being added
    expect(isRegistrationNameLocked(fakeRegistration(), fakeRegistration())).toBe(false)
  })

  it('removing one instance keeps the package the other still runs from', () => {
    const one: McpServerRegistration = { id: 'mcp:1', name: 'fakecat', type: 'npm', npmPackage: '@x/fakecat', managed: true }
    const two: McpServerRegistration = { ...one, id: 'mcp:2', name: 'fakecat-2', isolatedHome: true }
    expect(uninstallsPackageOnRemove(two, [one, two])).toBe(false)
    expect(uninstallsPackageOnRemove(one, [one, two])).toBe(false)
    expect(uninstallsPackageOnRemove(one, [one])).toBe(true)
  })

  it('shows the label, falling back to the name', () => {
    expect(registrationDisplayName({ name: 'fake-2' })).toBe('fake-2')
    expect(registrationDisplayName({ name: 'fake-2', label: '  Work  ' })).toBe('Work')
    expect(registrationDisplayName({ name: 'fake-2', label: ' ' })).toBe('fake-2')
  })
})

describe('the ADF format is unchanged', () => {
  it('the persisted server config never carries the instance marker; the pinned spawn config does', () => {
    const reg = fakeRegistration({ id: 'mcp:two', name: 'fake-2', isolatedHome: true, label: 'Work' })
    const persisted = buildMcpServerConfigFromRegistration(reg)
    expect(persisted).not.toHaveProperty('isolated_home')
    expect(JSON.stringify(persisted)).not.toMatch(/isolated|label|Work/)
    // .adf-supplied marker is ignored: the registration decides.
    const tampered = { ...persisted, isolated_home: true } as McpServerConfig
    expect((pinServerConfigToRegistration(tampered, fakeRegistration()) as McpInstanceServerConfig).isolated_home).toBeUndefined()
    expect(pinServerConfigToRegistration(persisted, reg).isolated_home).toBe(true)
  })
})

describe('two instances of one stdio server on the host (real spawn)', () => {
  let manager: McpClientManager
  afterEach(async () => { await manager?.disconnectAll() })

  async function call(name: string, tool: string, args: Record<string, unknown> = {}): Promise<string> {
    const r = await manager.callTool(name, tool, args)
    expect(r.isError).toBe(false)
    return r.content
  }

  it('the additional instance runs in its own home; both token files coexist and the first is untouched', async () => {
    const firstReg = fakeRegistration()
    const secondReg = asAdditionalInstance(fakeRegistration({ id: 'mcp:two' }), [firstReg])
    manager = new McpClientManager(root)
    // The .adf copy (agent-writable) tries to point the instance back at the shared home.
    const adfSecond: McpServerConfig = { ...buildMcpServerConfigFromRegistration(secondReg), env: { HOME: realHome, USERPROFILE: realHome } }
    expect(await manager.connect(pinServerConfigToRegistration(buildMcpServerConfigFromRegistration(firstReg), firstReg))).toHaveLength(3)
    expect(await manager.connect(pinServerConfigToRegistration(adfSecond, secondReg))).toHaveLength(3)

    const instanceHome = join(userData, 'mcp-instances', 'fake-2')
    const one = JSON.parse(await call('fake', 'whoami'))
    const two = JSON.parse(await call('fake-2', 'whoami'))
    expect(one.homedir).toBe(realHome)
    expect(two).toMatchObject({ HOME: instanceHome, USERPROFILE: instanceHome, homedir: instanceHome })
    // npx keeps using the real npm cache, never one per instance folder.
    expect(two.npmCache ?? '').not.toContain(instanceHome)
    if (process.platform !== 'win32' && !process.env.npm_config_cache) expect(two.npmCache).toBe(join(realHome, '.npm'))

    await call('fake', 'sign_in', { account: 'first@example.com' })
    await call('fake-2', 'sign_in', { account: 'second@example.com' })
    expect(readFileSync(join(realHome, '.fake-mcp', 'token'), 'utf8')).toBe('first@example.com')
    expect(readFileSync(join(instanceHome, '.fake-mcp', 'token'), 'utf8')).toBe('second@example.com')
    expect(await call('fake', 'read_token')).toBe('first@example.com')
    expect(await call('fake-2', 'read_token')).toBe('second@example.com')
  }, 60_000)

  it('the Settings Connect test runs an additional instance in its own home (isolatedHome survives the IPC schema)', async () => {
    const reg = fakeRegistration({ id: 'mcp:three', name: 'fake-3', isolatedHome: true, credentialFiles: [{ path: TOKEN_PATH }] })
    const result = await runMcpRegistrationTest({
      registration: reg,
      credentialFiles: [{ path: TOKEN_PATH, contentB64: Buffer.from('third@example.com').toString('base64') }],
    }, {
      computeSettings: () => ({ hostAccessEnabled: true, hostApproved: [] }),
      uvManager: { ensureUv: async () => 'uv' },
      podman: { ensureRunning: async () => {}, findPodman: async () => null, ensureWorkspace: async () => {}, execInContainer: async () => {} },
      appOAuthStore: null,
      oauthIO: { openUrl: () => {}, log: () => {} },
      authPreflight: async () => {},
      onLog: () => {},
    })
    expect(result).toMatchObject({ success: true, location: 'host' })
    expect(readFileSync(join(userData, 'mcp-instances', 'fake-3', '.fake-mcp', 'token'), 'utf8')).toBe('third@example.com')
    expect(readFileSync(join(realHome, '.fake-mcp', 'token'), 'utf8')).toBe('first@example.com')
  }, 60_000)

  it('a normal server gets no override: its config env and the inherited HOME stand', () => {
    const normal = pinServerConfigToRegistration(buildMcpServerConfigFromRegistration(fakeRegistration()), fakeRegistration())
    expect(hostIsolatedHomeEnv(normal, {})).toEqual({})
    expect(containerIsolatedHomeEnv(normal, '/workspace/a/home', {})).toEqual({})
    expect(mcpServerContainerHome(normal, '/workspace/a/home')).toBe('/workspace/a/home')
  })

  it('the override never sets a blocked variable and keeps a cache the env already names', () => {
    const cfg = { name: 'fake-2', isolated_home: true }
    const env = hostIsolatedHomeEnv(cfg, { NPM_CONFIG_CACHE: '/c' })
    expect(Object.keys(env).sort()).toEqual(['HOME', 'USERPROFILE'])
    expect(Object.keys(hostIsolatedHomeEnv(cfg, {})).every((k) => ['HOME', 'USERPROFILE', 'npm_config_cache'].includes(k))).toBe(true)
  })

  it('refuses a name that is not one plain path segment', () => {
    expect(() => hostMcpInstanceHome('../escape')).toThrow(/cannot name an instance folder/)
    expect(() => mcpServerContainerHome({ name: 'a/b', isolated_home: true }, '/h')).toThrow(/cannot name an instance folder/)
  })
})

describe('auth preflight spawn env', () => {
  const recordEnv = (out: string) => `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.env)); process.exit(0)`
  const io = { openUrl: () => {}, log: () => {} }

  it('host: an additional instance authorizes in its own home, config env cannot move it; a normal server keeps the real home', async () => {
    const out = join(root, 'preflight-env.json')
    const cfg: McpInstanceServerConfig = { name: 'fake-2', transport: 'stdio', command: process.execPath, args: ['-e', recordEnv(out)], env: { HOME: realHome }, isolated_home: true }
    await runMcpAuthPreflight(cfg, {}, io)
    const env = JSON.parse(readFileSync(out, 'utf8'))
    expect(env.HOME).toBe(join(userData, 'mcp-instances', 'fake-2'))
    expect(env.USERPROFILE).toBe(env.HOME)

    const { isolated_home: _drop, ...normal } = cfg
    void _drop
    await runMcpAuthPreflight({ ...normal, name: 'fake', env: undefined }, {}, io)
    expect(JSON.parse(readFileSync(out, 'utf8')).HOME).toBe(realHome)
  }, 30_000)

  it.skipIf(process.platform === 'win32')('container: the --env-file ends with the instance HOME under the agent home', async () => {
    const out = join(root, 'container-env-file')
    const fakePodman = join(root, 'fake-podman.sh')
    // podman exec -i --env-file <file> ... : $4 is the env file.
    writeFileSync(fakePodman, `#!/bin/sh\ncp "$4" ${JSON.stringify(out)}\n`)
    chmodSync(fakePodman, 0o755)
    const cfg: McpInstanceServerConfig = { name: 'fake-2', transport: 'stdio', env: { HOME: '/elsewhere' }, isolated_home: true }
    await runMcpAuthPreflight(cfg, { container: { podmanBin: fakePodman, containerName: 'adf-mcp', command: 'node', args: ['s.js'], home: '/workspace/a/home' } }, io)
    const lines = readFileSync(out, 'utf8').trim().split('\n')
    // podman: later lines win.
    expect(lines.filter((l) => l.startsWith('HOME=')).pop()).toBe('HOME=/workspace/a/home/.mcp-instances/fake-2')
    expect(lines).toContain('USERPROFILE=/workspace/a/home/.mcp-instances/fake-2')
    expect(lines).toContain('npm_config_cache=/workspace/a/home/.npm')
  }, 30_000)
})

describe('credential stores are per instance', () => {
  const pkgFirst: McpServerConfig = { name: 'fake', transport: 'stdio', npm_package: '@x/fake', credential_files: [{ path: TOKEN_PATH }] }
  const pkgSecond: McpInstanceServerConfig = { ...pkgFirst, name: 'fake-2', isolated_home: true }

  it('keystore purposes: the first keeps package-then-name, an instance uses its name only', () => {
    expect(credentialFilePurposes(pkgFirst, TOKEN_PATH)).toEqual(['mcp:@x/fake:file:~/.fake-mcp/token', 'mcp:fake:file:~/.fake-mcp/token'])
    expect(credentialFilePurposes(pkgSecond, TOKEN_PATH)).toEqual(['mcp:fake-2:file:~/.fake-mcp/token'])
    expect(mcpCredentialNamespace({ name: 'fake', npmPackage: '@x/fake' })).toBe('@x/fake')
    expect(mcpCredentialNamespace({ name: 'fake-2', npmPackage: '@x/fake', isolatedHome: true })).toBe('fake-2')
  })

  it('host materialize and write-back use the instance home and its name-scoped purpose', async () => {
    const store = memStore({
      // The first instance's grant (package namespace) must never reach the second.
      'mcp:@x/fake:file:~/.fake-mcp/token': record('first-sealed'),
      'mcp:fake-2:file:~/.fake-mcp/token': record('second-sealed'),
    })
    await materializeCredentialFiles(store, pkgSecond, { kind: 'host' })
    const instanceFile = join(userData, 'mcp-instances', 'fake-2', '.fake-mcp', 'token')
    expect(readFileSync(instanceFile, 'utf8')).toBe('second-sealed')

    writeFileSync(instanceFile, 'second-refreshed')
    await writeBackCredentialFiles(store, pkgSecond, { kind: 'host' }, '2026-11-03T00:00:00.000Z')
    expect(JSON.parse(store.rows['mcp:fake-2:file:~/.fake-mcp/token']).data).toBe(Buffer.from('second-refreshed').toString('base64'))
    expect(JSON.parse(store.rows['mcp:@x/fake:file:~/.fake-mcp/token']).data).toBe(Buffer.from('first-sealed').toString('base64'))

    // An instance with nothing sealed starts empty — it does not inherit the first's grant.
    const fresh = memStore({ 'mcp:@x/fake:file:~/.fake-mcp/token': record('first-sealed') })
    await materializeCredentialFiles(fresh, { ...pkgSecond, name: 'fake-4' }, { kind: 'host' })
    expect(existsSync(join(userData, 'mcp-instances', 'fake-4', '.fake-mcp', 'token'))).toBe(false)
  })

  it('container materialize targets <agent home>/.mcp-instances/<name>', async () => {
    const croot = join(root, 'container')
    const copies: string[] = []
    const target: CredentialContainerTarget = {
      kind: 'container', containerName: 'adf-mcp', home: `${croot}/home`,
      copyToContainer: async (h, c) => { copies.push(c); mkdirSync(join(c, '..'), { recursive: true }); writeFileSync(c, readFileSync(h)) },
      copyFromContainer: async (c, h) => { writeFileSync(h, readFileSync(c)) },
      fileExists: async (_n, p) => existsSync(p),
    }
    const store = memStore({ 'mcp:fake-2:file:~/.fake-mcp/token': record('in-container') })
    await materializeCredentialFiles(store, pkgSecond, target)
    expect(copies).toEqual([`${croot}/home/.mcp-instances/fake-2/.fake-mcp/token`])
    await materializeCredentialFiles(memStore({ 'mcp:@x/fake:file:~/.fake-mcp/token': record('first') }), pkgFirst, target)
    expect(copies[1]).toBe(`${croot}/home/.fake-mcp/token`)
  })

  it('captureCredentialFile seals an instance under its name', () => {
    const store = memStore()
    captureCredentialFile(store, pkgSecond, TOKEN_PATH, Buffer.from('x'), 'now')
    expect(Object.keys(store.rows)).toEqual(['mcp:fake-2:file:~/.fake-mcp/token'])
  })

  it('per-agent env credentials: an instance reads its name namespace only', () => {
    const rows: Record<string, string> = { 'mcp:@x/fake:API_KEY': 'first-key', 'mcp:fake-2:API_KEY': 'second-key' }
    const get = (k: string) => rows[k] ?? null
    const withKey = (cfg: McpServerConfig) => ({ ...cfg, env_keys: ['API_KEY'] })
    expect(resolveMcpEnvVars(withKey(pkgFirst), get)).toEqual({ API_KEY: 'first-key' })
    expect(resolveMcpEnvVars(withKey(pkgSecond), get)).toEqual({ API_KEY: 'second-key' })
    expect(resolveMcpEnvVars(withKey({ ...pkgSecond, name: 'fake-5' }), get)).toEqual({})
  })
})

describe('the Gmail built-in OAuth client follows the instance home (no Gmail-specific instance code)', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('writes the client into the instance folder even though the real home already has the first account\'s tokens', async () => {
    vi.stubGlobal('__ADF_GMAIL_OAUTH_CLIENT__', '{"installed":{"client_id":"built-in"}}')
    // The first account signed in on the real home.
    const realToken = join(realHome, GMAIL_BUNDLED_TOKEN_PATH.slice(2))
    mkdirSync(join(realToken, '..'), { recursive: true })
    writeFileSync(realToken, '{"refresh_token":"first"}')
    const cfg: McpInstanceServerConfig = {
      name: 'gmail-2', transport: 'stdio', npm_package: GMAIL_BUNDLED_CLIENT_NPM_PACKAGE, isolated_home: true,
      credential_files: [{ path: GMAIL_BUNDLED_CLIENT_PATH, required: true }, { path: GMAIL_BUNDLED_TOKEN_PATH }],
    }
    await materializeCredentialFiles(memStore(), cfg, { kind: 'host' })
    const instanceHome = join(userData, 'mcp-instances', 'gmail-2')
    expect(readFileSync(join(instanceHome, GMAIL_BUNDLED_CLIENT_PATH.slice(2)), 'utf8')).toContain('built-in')
    expect(existsSync(join(instanceHome, GMAIL_BUNDLED_TOKEN_PATH.slice(2)))).toBe(false)
    expect(readFileSync(realToken, 'utf8')).toBe('{"refresh_token":"first"}')
  })
})

describe('HTTP OAuth: two registrations of one URL keep separate tokens', () => {
  const URL_ = 'https://remote.example/mcp'

  function settingsHandle() {
    const secrets = new Map<string, string>()
    return {
      getSecret: (k: string) => secrets.get(k) ?? null,
      secretStatus: (k: string) => (secrets.has(k) ? 'ok' as const : 'absent' as const),
      setSecret: (k: string, v: string) => { secrets.set(k, v) },
      delete: (k: string) => { secrets.delete(k) },
      secretWriteRefusal: () => null,
    }
  }

  it('each instance reads, writes and signs out of its own record', async () => {
    const app = new AppSettingsOAuthStore(settingsHandle())
    const first = instanceOAuthStore(app, { name: 'remote' })
    const second = instanceOAuthStore(app, { name: 'remote-2', isolated_home: true })
    expect(first).toBe(app)
    const tokens = (t: string) => ({ access_token: t, token_type: 'Bearer' })
    await first.save(URL_, { tokens: tokens('first'), serverUrl: URL_, updatedAt: 1 })
    await second.save(URL_, { tokens: tokens('second'), serverUrl: URL_, updatedAt: 2 })
    expect((await first.get(URL_))?.tokens?.access_token).toBe('first')
    // The URL binding still holds for the instance's record (fragment dropped by canonicalization).
    expect((await second.get(URL_))?.tokens?.access_token).toBe('second')

    // Settings status / sign-out address a row by mcpOAuthStoreKey.
    const key2 = mcpOAuthStoreKey(URL_, { name: 'remote-2', isolatedHome: true })
    expect(key2).not.toBe(URL_)
    expect(mcpOAuthStoreKey(URL_, { name: 'remote' })).toBe(URL_)
    expect(await mcpOAuthStatus(app, { url: key2 })).toEqual({ signedIn: true })
    expect(await mcpOAuthSignOut(app, { url: key2 })).toEqual({ success: true })
    expect(await mcpOAuthStatus(app, { url: key2 })).toEqual({ signedIn: false })
    expect(await mcpOAuthStatus(app, { url: URL_ })).toEqual({ signedIn: true })
  })
})

describe('mcp_install picks the right instance', () => {
  const regs: McpServerRegistration[] = [
    { id: 'mcp:1', name: 'fake', type: 'npm', npmPackage: '@x/fake', agentVisible: true, credentialFiles: [{ path: TOKEN_PATH }] },
    { id: 'mcp:2', name: 'fake-2', type: 'npm', npmPackage: '@x/fake', agentVisible: true, isolatedHome: true, label: 'Work', credentialFiles: [{ path: TOKEN_PATH }] },
  ]
  function workspace() {
    const config: { mcp: { servers: McpServerConfig[] } } = { mcp: { servers: [] } }
    return {
      config,
      ws: {
        getAgentConfig: vi.fn(() => config),
        setAgentConfig: vi.fn(),
        setIdentity: vi.fn(),
        setIdentitySealed: vi.fn(),
        getEnvelopeState: vi.fn(() => 'open'),
      },
    }
  }

  it('an explicit name selects the second instance and seals its files under its name', async () => {
    const { config, ws } = workspace()
    const connect = vi.fn().mockResolvedValue({ toolsDiscovered: 3 })
    const result = await new McpInstallTool(connect, () => regs).execute({
      package: '@x/fake', type: 'npm', name: 'fake-2',
      credential_files: [{ path: TOKEN_PATH, content: 'second' }],
    }, ws as unknown as AdfWorkspace)
    const content = JSON.parse(result.content)
    expect(content).toMatchObject({ success: true, name: 'fake-2', attached_existing: true })
    expect(content.message).toContain('"fake-2" (Work)')
    expect(config.mcp.servers.map((s: McpServerConfig) => s.name)).toEqual(['fake-2'])
    expect(config.mcp.servers[0]).not.toHaveProperty('isolated_home')
    expect(connect).toHaveBeenCalledWith('fake-2', expect.anything())
    expect(ws.setIdentitySealed).toHaveBeenCalledWith('mcp:fake-2:file:~/.fake-mcp/token', expect.any(String))
  })

  it('package only still attaches the first', async () => {
    const { config, ws } = workspace()
    const result = await new McpInstallTool(vi.fn().mockResolvedValue({ toolsDiscovered: 1 }), () => regs).execute({ package: '@x/fake', type: 'npm' }, ws as unknown as AdfWorkspace)
    expect(JSON.parse(result.content)).toMatchObject({ success: true, name: 'fake', attached_existing: true })
    expect(config.mcp.servers.map((s: McpServerConfig) => s.name)).toEqual(['fake'])
  })
})
