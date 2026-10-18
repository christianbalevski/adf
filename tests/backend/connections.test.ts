/**
 * Settings → Connection (docs/design/settings-scopes.md §5): the saved
 * connections Studio shares with `adf` (cli-remotes.json and the keychain,
 * here a test keychain file), the rows of the page, Connect, Add connection
 * with a token, Remove, and the remote connector on a saved connection.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('./daemon-mode-electron')).electronStub.module)

import { SUPPORTED_CLIENT_API_VERSION } from '../../src/shared/daemon-client'
import { createBackendSettingsStore, defaultBackendConfig, resolveBootBackend, type SecretCodec, type StudioBackendConfig } from '../../src/main/backend/backend-config'
import { buildConnectionsView, ConnectionError, currentConnection, forgetConnection, keychainSentence, remotesEnv, saveConnection, savedConnections, savedConnectionTarget } from '../../src/main/backend/connections'
import { createConnections } from '../../src/main/backend/connections-ipc'
import { remoteDaemonConnector, RemoteConnectError } from '../../src/main/backend/daemon-mode/remote/connector'
import { loadRemotes, readRemoteToken, remoteNameFor, saveRemotes, savedRemoteToken, selectedRemote, storeRemoteToken } from '../../src/main/cli/remotes'
import type { BackendDaemonStatus } from '../../src/shared/types/backend.types'
import type { RemoteDiscoveryEntry } from '../../src/shared/types/remote-access-ipc.types'

const quiet = { log: () => {}, warn: () => {} }
const HUB = 'http://100.101.102.103:7385'
const LAN = 'http://192.168.1.20:7385'
const TOKEN = 'adfd_' + 'a'.repeat(40)

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'adf-connections-'))
  dirs.push(dir)
  return dir
}

/** Studio's and the CLI's view of one settings folder, with a test keychain (never the real one). */
function sharedEnv(dir = tempDir()): NodeJS.ProcessEnv {
  const env = { ...remotesEnv(dir, process.env), ADF_TEST_KEYCHAIN_FILE: join(dir, 'keychain.json'), ADF_TEST_SEAMS: '1' }
  delete env.ADF_KEYCHAIN
  delete env.ADF_SECRET_STORE
  return env
}

const codec: SecretCodec = {
  available: () => true,
  encrypt: (plain) => 'safe:' + Buffer.from(plain).toString('base64'),
  decrypt: (stored) => Buffer.from(stored.slice(5), 'base64').toString(),
}

/** An ADF daemon stand-in: /health, /version behind the token, /remote/hello with its fingerprint (or none). */
function fakeDaemon(opts: { fingerprint?: string | null; name?: string } = {}) {
  const requests: Array<{ url: string; auth: string | null }> = []
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const auth = new Headers(init?.headers).get('authorization')
    requests.push({ url: url.toString(), auth })
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    if (url.pathname === '/health') return json(200, { ok: true })
    if (url.pathname === '/remote/hello') {
      if (opts.fingerprint === null) return json(404, { error: 'Remote access is off on this computer.', code: 'remote_access_off' })
      return json(200, { v: 1, name: opts.name ?? 'rawl-hub', fingerprint: opts.fingerprint ?? 'ABCD-EFGH', pairingOpen: false, api: '2' })
    }
    if (auth !== `Bearer ${TOKEN}`) return json(401, { error: 'Unauthorized' })
    if (url.pathname === '/version') return json(200, { version: '0.9.0', clientApiVersion: SUPPORTED_CLIENT_API_VERSION, pid: 1, startedBy: 'cli' })
    return json(404, { error: 'not found' })
  }) as typeof fetch
  return { fetch, requests, tokenSent: () => requests.some((r) => r.auth === `Bearer ${TOKEN}`) }
}

const daemonStatus = (connection: BackendDaemonStatus['connection']): BackendDaemonStatus => ({
  connection, progress: null, message: null, url: null, pid: 1, version: '0.9.0', startedBy: 'studio', how: 'attached', localProof: null, trust: null, keychainProblem: null, logFile: null,
})

describe('one list for Studio and adf (cli-remotes.json and the keychain)', () => {
  it('a connection Studio pairs is the CLI\'s saved remote: same file, same keychain account, same name rule', async () => {
    const env = sharedEnv()
    const { name, store } = await saveConnection(env, { url: HUB, token: TOKEN, fingerprint: 'ABCD-EFGH', hostName: 'Rawl Hub', deviceId: 'dev1', label: 'agent-2 laptop' })
    expect(name).toBe('rawl-hub')
    expect(store.where).toBe('keychain')
    // The CLI reads it: its list, its token for that origin, `adf remotes use rawl-hub`.
    expect(loadRemotes(env).remotes['rawl-hub']).toMatchObject({ url: HUB, fingerprint: 'ABCD-EFGH', deviceId: 'dev1', label: 'agent-2 laptop', hostName: 'Rawl Hub' })
    expect(savedRemoteToken(HUB, env)).toBe(TOKEN)
    expect(selectedRemote({ ...env, ADF_REMOTE: 'rawl-hub' })?.remote.url).toBe(HUB)
    expect(JSON.parse(readFileSync(env.ADF_TEST_KEYCHAIN_FILE!, 'utf8'))).toEqual({ 'remote-token:ABCD-EFGH': TOKEN })
    // Pairing the same computer again keeps its name; another computer with that host name gets the next one.
    expect((await saveConnection(env, { url: LAN, token: TOKEN, fingerprint: 'ABCD-EFGH', hostName: 'Other name', deviceId: 'dev2', label: 'x' })).name).toBe('rawl-hub')
    expect((await saveConnection(env, { url: 'https://hub2.example.com', token: TOKEN, fingerprint: 'QQQQ-QQQQ', hostName: 'rawl hub', deviceId: 'dev3', label: 'x' })).name).toBe('rawl-hub-2')
    expect(remoteNameFor('rawl hub', loadRemotes(env).remotes)).toBe('rawl-hub-3')
  })

  it('a remote `adf pair` saved shows in Studio as Paired, and Studio reads its token', async () => {
    const env = sharedEnv()
    // What adf pair writes (pair.ts): the list entry and the keychain account.
    saveRemotes({ v: 1, default: 'desk', remotes: { desk: { url: HUB, fingerprint: 'DESK-2345', deviceId: 'dev9', label: 'laptop', pairedAt: '2026-10-18T10:00:00Z', hostName: 'desk' } } }, env)
    await storeRemoteToken('DESK-2345', TOKEN, env)
    const view = buildConnectionsView({ active: { mode: 'local', remoteName: null, config: defaultBackendConfig() }, configured: defaultBackendConfig(), daemon: daemonStatus('connected'), saved: savedConnections(env), discovery: null })
    expect(view.rows.find((r) => r.id === 'remote:desk')).toMatchObject({ name: 'desk', state: 'paired', action: 'connect', fingerprint: 'DESK-2345', encrypted: true, removable: true })
    expect((await savedConnectionTarget(defaultBackendConfig(), 'desk', env)).token).toBe(TOKEN)
  })

  it('Remove forgets the entry and its token; a token another name still uses stays; the CLI default is cleared', async () => {
    const env = sharedEnv()
    await saveConnection(env, { url: HUB, token: TOKEN, fingerprint: 'ABCD-EFGH', hostName: 'hub', deviceId: 'd', label: 'l' })
    const file = loadRemotes(env)
    file.remotes.alias = { ...file.remotes.hub }
    file.default = 'hub'
    saveRemotes(file, env)
    expect(await forgetConnection(env, 'hub')).toBe(true)
    expect(loadRemotes(env)).toMatchObject({ default: null, remotes: { alias: { fingerprint: 'ABCD-EFGH' } } })
    expect(readRemoteToken('ABCD-EFGH', env)).toBe(TOKEN)
    expect(await forgetConnection(env, 'alias')).toBe(true)
    expect(readRemoteToken('ABCD-EFGH', env)).toBeNull()
    expect(await forgetConnection(env, 'alias')).toBe(false)
  })

  it('a token the keychain does not give ends the attempt with the sentence; nothing falls back', async () => {
    const env = sharedEnv()
    saveRemotes({ v: 1, default: null, remotes: { hub: { url: HUB, fingerprint: 'ABCD-EFGH', deviceId: '', label: '', pairedAt: '' } } }, env)
    const error = await savedConnectionTarget(defaultBackendConfig(), 'hub', env).catch((e) => e)
    expect(error).toBeInstanceOf(ConnectionError)
    expect(error).toMatchObject({ code: 'keychain', message: keychainSentence('hub') })
    expect(keychainSentence('hub')).toBe('Studio could not read the token for hub from the OS keychain. Allow ADF Studio to use it, or pair again.')
    expect(await savedConnectionTarget(defaultBackendConfig(), 'nobody', env).catch((e) => e)).toMatchObject({ code: 'not_configured' })
  })

  it('plain http to a LAN address needs the confirmation Studio recorded for that origin', async () => {
    const env = sharedEnv()
    await saveConnection(env, { url: LAN, token: TOKEN, fingerprint: 'ABCD-EFGH', hostName: 'hub', deviceId: '', label: '' })
    expect(await savedConnectionTarget(defaultBackendConfig(), 'hub', env).catch((e) => e)).toMatchObject({ code: 'transport' })
    expect((await savedConnectionTarget({ insecureHttpOrigins: ['http://192.168.1.20:7385'] }, 'hub', env)).url).toBe(LAN)
  })
})

describe('the rows of the Connection page', () => {
  const saved = { 'rawl-hub': { url: HUB, fingerprint: 'ABCD-EFGH', deviceId: 'd', label: 'l', pairedAt: '' } }
  const entry = (over: Partial<RemoteDiscoveryEntry> = {}): RemoteDiscoveryEntry => ({ fingerprint: 'ABCD-EFGH', name: 'rawl-hub', url: HUB, address: '100.101.102.103', kind: 'tailnet', encrypted: true, pairingOpen: false, alreadyPaired: true, clash: null, ...over })
  const local = (over: Partial<Parameters<typeof buildConnectionsView>[0]> = {}) => buildConnectionsView({
    active: { mode: 'local', remoteName: null, config: defaultBackendConfig() }, configured: defaultBackendConfig(), daemon: daemonStatus('connected'), saved, discovery: null, ...over,
  })

  it('This computer in use: Connected, no action; a saved remote: Paired, Connect; no Inside Studio row', async () => {
    const view = local()
    expect(view.current).toEqual({ id: 'local', kind: 'local', name: 'This computer', url: null, state: 'connected' })
    expect(view.rows.map((r) => [r.id, r.state, r.action])).toEqual([['local', 'connected', null], ['remote:rawl-hub', 'paired', 'connect']])
  })

  it('a paired computer found on the network is its saved row, never a second row with Pair; one not paired is Not paired with Pair', async () => {
    const view = local({ discovery: { browsing: true, problem: null, entries: [entry({ pairingOpen: true }), entry({ fingerprint: 'NEWW-2345', name: 'desk', url: LAN, address: '192.168.1.20', kind: 'lan', encrypted: false, alreadyPaired: false })] } })
    expect(view.rows.filter((r) => r.fingerprint === 'ABCD-EFGH')).toEqual([expect.objectContaining({ id: 'remote:rawl-hub', state: 'paired', action: 'connect', pairingOpen: true })])
    expect(view.rows.at(-1)).toMatchObject({ id: `found:NEWW-2345@${LAN}`, kind: 'found', name: 'desk', state: 'not-paired', action: 'pair', address: '192.168.1.20' })
    expect(view.discovery).toEqual({ browsing: true, problem: null })
    expect(view.rows.some((r) => r.state === 'paired' && r.action === 'pair')).toBe(false)
  })

  it('one fingerprint at two addresses: separate Not paired rows, flagged; when saved, the warning goes on the saved row', async () => {
    const clash = [entry({ clash: 2, alreadyPaired: false, fingerprint: 'NEWW-2345' }), entry({ clash: 2, alreadyPaired: false, fingerprint: 'NEWW-2345', url: LAN, address: '192.168.1.20' })]
    expect(local({ discovery: { browsing: true, problem: null, entries: clash } }).rows.filter((r) => r.kind === 'found').map((r) => [r.address, r.clash])).toEqual([['100.101.102.103', 2], ['192.168.1.20', 2]])
    const savedClash = clash.map((e) => ({ ...e, fingerprint: 'ABCD-EFGH' }))
    const view = local({ discovery: { browsing: true, problem: null, entries: savedClash } })
    expect(view.rows.filter((r) => r.kind === 'found')).toEqual([])
    expect(view.rows.find((r) => r.id === 'remote:rawl-hub')?.clash).toBe(2)
  })

  it('a remote in use: its row shows the link state and no action, is not removable; This computer offers Connect', async () => {
    const config: StudioBackendConfig = { ...defaultBackendConfig(), mode: 'remote', remote: { url: null, token: null, allowInsecureHttp: false, name: 'rawl-hub' } }
    const view = buildConnectionsView({ active: { mode: 'remote', remoteName: 'rawl-hub', config }, configured: config, daemon: daemonStatus('disconnected'), saved, discovery: null })
    expect(view.current).toEqual({ id: 'remote:rawl-hub', kind: 'remote', name: 'rawl-hub', url: HUB, state: 'retrying' })
    expect(view.rows.map((r) => [r.id, r.state, r.action, r.removable])).toEqual([['local', null, 'connect', false], ['remote:rawl-hub', 'retrying', null, false]])
  })

  it('the remote URL of studio-backend.json is one row; with a saved twin, the saved row shows unless the URL is in use', async () => {
    const slot: StudioBackendConfig = { ...defaultBackendConfig(), remote: { url: 'https://adf.example.com', token: 'safe:x', allowInsecureHttp: false, paired: { fingerprint: 'SLOT-2345', name: 'office', deviceId: 'd', label: 'l' } } }
    expect(local({ configured: slot }).rows.find((r) => r.id === 'remote')).toMatchObject({ name: 'office', state: 'paired', action: 'connect', address: 'adf.example.com' })
    const twin: StudioBackendConfig = { ...slot, remote: { ...slot.remote, paired: { ...slot.remote.paired!, fingerprint: 'ABCD-EFGH' } } }
    expect(local({ configured: twin }).rows.map((r) => r.id)).toEqual(['local', 'remote:rawl-hub'])
    const inUse: StudioBackendConfig = { ...twin, mode: 'remote' }
    const view = buildConnectionsView({ active: { mode: 'remote', remoteName: null, config: inUse }, configured: inUse, daemon: daemonStatus('connected'), saved, discovery: null })
    expect(view.rows.map((r) => [r.id, r.state])).toEqual([['local', null], ['remote', 'connected']])
    expect(currentConnection({ active: { mode: 'remote', remoteName: null, config: { ...inUse, remote: { ...inUse.remote, paired: null } } }, daemon: null, saved })).toMatchObject({ name: 'adf.example.com', state: 'connecting' })
  })

  it('Inside Studio (legacy) is a row only while it runs or is saved; the saved next connection is not removable', async () => {
    expect(buildConnectionsView({ active: { mode: 'embedded', remoteName: null, config: defaultBackendConfig() }, configured: { ...defaultBackendConfig(), mode: 'embedded' }, daemon: null, saved, discovery: null }).rows.slice(0, 2).map((r) => [r.id, r.state, r.action]))
      .toEqual([['local', null, 'connect'], ['embedded', 'connected', null]])
    const next: StudioBackendConfig = { ...defaultBackendConfig(), mode: 'remote', remote: { url: null, token: null, allowInsecureHttp: false, name: 'rawl-hub' } }
    expect(local({ configured: next }).rows.find((r) => r.id === 'remote:rawl-hub')).toMatchObject({ action: 'connect', removable: false })
  })
})

describe('Connect, Add connection and Remove (Studio main)', () => {
  function setup(opts: { daemon?: ReturnType<typeof fakeDaemon>; confirm?: boolean; studioBackend?: Record<string, unknown> } = {}) {
    const dir = tempDir()
    const env = sharedEnv(dir)
    const path = join(dir, 'studio-backend.json')
    writeFileSync(path, JSON.stringify(opts.studioBackend ?? { v: 1, mode: 'local' }))
    const boot = resolveBootBackend(path, {}, quiet)
    const switches: string[] = []
    const store = createBackendSettingsStore({
      boot, codec, log: quiet,
      savedRemote: (name) => savedConnections(env)[name] ?? null,
      confirmModeSwitch: async (target) => { switches.push(target); return true },
      applyModeSwitch: () => 'Studio restarts now.',
    })
    const confirms: Array<{ message: string; detail: string }> = []
    const pushes: unknown[] = []
    const daemon = opts.daemon ?? fakeDaemon()
    const connections = createConnections({
      boot, backend: store, env,
      daemonStatus: () => daemonStatus('connected'),
      discovery: () => null,
      confirm: async (p) => { confirms.push(p); return opts.confirm ?? true },
      push: (v) => pushes.push(v),
      fetch: daemon.fetch,
      log: quiet,
    })
    return { env, path, store, connections, confirms, pushes, switches, daemon }
  }

  it('Connect to a saved connection reads its token first, then saves it as the connection and restarts (the switch dialog)', async () => {
    const s = setup()
    await saveConnection(s.env, { url: HUB, token: TOKEN, fingerprint: 'ABCD-EFGH', hostName: 'rawl-hub', deviceId: '', label: '' })
    const result = await s.connections.use('remote:rawl-hub')
    expect(result).toMatchObject({ ok: true, notices: ['Studio restarts now.'] })
    expect(s.switches).toEqual(['remote'])
    expect(JSON.parse(readFileSync(s.path, 'utf8'))).toMatchObject({ mode: 'remote', remote: { name: 'rawl-hub' } })
    expect(s.store.get().configured).toMatchObject({ mode: 'remote', remoteName: 'rawl-hub' })
    expect(s.pushes.length).toBeGreaterThan(0)
  })

  it('Connect with a token the keychain does not give: the sentence, nothing saved, no restart', async () => {
    const s = setup()
    saveRemotes({ v: 1, default: null, remotes: { 'rawl-hub': { url: HUB, fingerprint: 'ABCD-EFGH', deviceId: '', label: '', pairedAt: '' } } }, s.env)
    expect(await s.connections.use('remote:rawl-hub')).toEqual({ ok: false, code: 'keychain', error: keychainSentence('rawl-hub') })
    expect(s.switches).toEqual([])
    expect(JSON.parse(readFileSync(s.path, 'utf8')).mode).toBe('local')
  })

  it('Connect refuses a computer not paired and an unknown id; Connect to This computer while it runs is a plain save', async () => {
    const s = setup()
    expect(await s.connections.use(`found:NEWW-2345@${LAN}`)).toEqual({ ok: false, code: 'not_paired', error: 'Pair first.' })
    expect(await s.connections.use('remote:nobody')).toMatchObject({ ok: false, code: 'not_configured' })
    expect(await s.connections.use(42)).toMatchObject({ ok: false, code: 'invalid' })
    expect(await s.connections.use('local')).toMatchObject({ ok: true })
    expect(s.switches).toEqual([])
  })

  it('Add connection with a token: hello pins the fingerprint before the token is sent; saved like a pairing; plain LAN http is recorded for that origin', async () => {
    const s = setup()
    const added = await s.connections.add({ url: LAN, token: TOKEN, allowInsecureHttp: true })
    expect(added).toMatchObject({ ok: true, id: 'remote:rawl-hub', notices: ['Saved rawl-hub.'] })
    expect(loadRemotes(s.env).remotes['rawl-hub']).toMatchObject({ url: LAN, fingerprint: 'ABCD-EFGH' })
    expect(readRemoteToken('ABCD-EFGH', s.env)).toBe(TOKEN)
    expect(JSON.parse(readFileSync(s.path, 'utf8')).insecureHttpOrigins).toEqual(['http://192.168.1.20:7385'])
    // The hello came first, without the token.
    expect(s.daemon.requests[0]).toMatchObject({ url: `${LAN}/remote/hello`, auth: null })
  })

  it('Add connection: an address a saved connection was paired at, now answering with another fingerprint, is refused; the token is not sent', async () => {
    const s = setup({ daemon: fakeDaemon({ fingerprint: 'EVIL-2345' }) })
    await saveConnection(s.env, { url: HUB, token: 'adfd_old', fingerprint: 'ABCD-EFGH', hostName: 'rawl-hub', deviceId: '', label: '' })
    const result = await s.connections.add({ url: HUB, token: TOKEN })
    expect(result).toMatchObject({ ok: false, code: 'fingerprint_mismatch' })
    expect(s.daemon.tokenSent()).toBe(false)
    expect(readRemoteToken('ABCD-EFGH', s.env)).toBe('adfd_old')
  })

  it('Add connection where nothing answers hello (remote access off): the remote URL of studio-backend.json, after asking before it replaces another', async () => {
    const s = setup({ daemon: fakeDaemon({ fingerprint: null }), studioBackend: { v: 1, mode: 'local', remote: { url: 'https://old.example.com', token: codec.encrypt('adfd_old'), allowInsecureHttp: false } } })
    const result = await s.connections.add({ url: 'https://adf.example.com', token: TOKEN })
    expect(s.confirms).toEqual([{ message: 'Replace connection', detail: 'Replaces old.example.com.', ok: 'Replace' }])
    expect(result).toMatchObject({ ok: true, id: 'remote', notices: ["Saved. No fingerprint: Studio cannot check this computer's identity."] })
    expect(s.store.config().remote).toMatchObject({ url: 'https://adf.example.com' })
    expect(loadRemotes(s.env).remotes).toEqual({})
    const declined = setup({ daemon: fakeDaemon({ fingerprint: null }), confirm: false, studioBackend: { v: 1, mode: 'local', remote: { url: 'https://old.example.com', token: codec.encrypt('adfd_old'), allowInsecureHttp: false } } })
    expect(await declined.connections.add({ url: 'https://adf.example.com', token: TOKEN })).toEqual({ ok: false, code: 'cancelled', error: 'Nothing changed.' })
  })

  it('Add connection refuses a bad address, unconfirmed plain http, a bad token and a token the daemon refuses', async () => {
    const s = setup()
    expect(await s.connections.add({ url: 'ftp://x', token: TOKEN })).toMatchObject({ ok: false, code: 'invalid_url' })
    expect(await s.connections.add({ url: LAN, token: TOKEN })).toMatchObject({ ok: false, code: 'insecure_url_unconfirmed' })
    expect(await s.connections.add({ url: HUB, token: 'has space' })).toMatchObject({ ok: false, code: 'invalid_token' })
    expect(await s.connections.add({ url: HUB, token: 'adfd_wrong' })).toMatchObject({ ok: false, code: 'unreachable' })
    expect(loadRemotes(s.env).remotes).toEqual({})
  })

  it('Remove asks first, then forgets; the connection in use or saved as the next one cannot be removed', async () => {
    const s = setup()
    await saveConnection(s.env, { url: HUB, token: TOKEN, fingerprint: 'ABCD-EFGH', hostName: 'rawl-hub', deviceId: '', label: '' })
    expect(await s.connections.remove('local')).toEqual({ ok: false, code: 'in_use', error: 'In use.' })
    const removed = await s.connections.remove('remote:rawl-hub')
    expect(s.confirms).toEqual([{ message: 'Remove rawl-hub', detail: 'Studio and the adf command forget its address and token. rawl-hub still lists this device; revoke it there.', ok: 'Remove' }])
    expect(removed).toMatchObject({ ok: true, notices: ['Removed rawl-hub.'] })
    expect(loadRemotes(s.env).remotes).toEqual({})
    expect(readRemoteToken('ABCD-EFGH', s.env)).toBeNull()

    const next = setup()
    await saveConnection(next.env, { url: HUB, token: TOKEN, fingerprint: 'ABCD-EFGH', hostName: 'rawl-hub', deviceId: '', label: '' })
    await next.connections.use('remote:rawl-hub')
    expect(await next.connections.remove('remote:rawl-hub')).toEqual({ ok: false, code: 'in_use', error: 'In use.' })
    const kept = setup({ confirm: false })
    await saveConnection(kept.env, { url: HUB, token: TOKEN, fingerprint: 'ABCD-EFGH', hostName: 'rawl-hub', deviceId: '', label: '' })
    expect(await kept.connections.remove('remote:rawl-hub')).toEqual({ ok: false, code: 'cancelled', error: 'Nothing changed.' })
    expect(Object.keys(loadRemotes(kept.env).remotes)).toEqual(['rawl-hub'])
  })
})

describe('the remote connector on a saved connection', () => {
  const config = (name: string): StudioBackendConfig => ({ ...defaultBackendConfig(), mode: 'remote', remote: { url: null, token: null, allowInsecureHttp: false, name } })

  it('reads the token from the keychain, checks the pinned fingerprint, then the handshake', async () => {
    const env = sharedEnv()
    await saveConnection(env, { url: HUB, token: TOKEN, fingerprint: 'ABCD-EFGH', hostName: 'rawl-hub', deviceId: '', label: '' })
    const daemon = fakeDaemon()
    const progress: string[] = []
    const connected = await remoteDaemonConnector(config('rawl-hub'), codec, { env, fetch: daemon.fetch })((line) => progress.push(line))
    expect(connected.baseUrl).toBe(HUB)
    expect(connected.source.token()).toBe(TOKEN)
    expect(progress[0]).toBe('Reading the token for rawl-hub…')
    expect(daemon.requests.map((r) => new URL(r.url).pathname)).toEqual(['/remote/hello', '/health', '/version'])
  })

  it('another fingerprint at the saved address: refused before the token is sent', async () => {
    const env = sharedEnv()
    await saveConnection(env, { url: HUB, token: TOKEN, fingerprint: 'ABCD-EFGH', hostName: 'rawl-hub', deviceId: '', label: '' })
    const daemon = fakeDaemon({ fingerprint: 'EVIL-2345' })
    const error = await remoteDaemonConnector(config('rawl-hub'), codec, { env, fetch: daemon.fetch, retry: { maxAttempts: 1 } })(() => {}).catch((e) => e)
    expect(error).toBeInstanceOf(RemoteConnectError)
    expect(error).toMatchObject({ problem: 'fingerprint' })
    expect(error.message).toBe(`${HUB} is not rawl-hub (fingerprint EVIL-2345, paired as ABCD-EFGH); the token was not sent.`)
    expect(daemon.tokenSent()).toBe(false)
  })

  it('no token in the keychain: the keychain sentence', async () => {
    const env = sharedEnv()
    saveRemotes({ v: 1, default: null, remotes: { hub: { url: HUB, fingerprint: 'ABCD-EFGH', deviceId: '', label: '', pairedAt: '' } } }, env)
    const error = await remoteDaemonConnector(config('hub'), codec, { env, fetch: fakeDaemon().fetch })(() => {}).catch((e) => e)
    expect(error).toMatchObject({ problem: 'keychain', message: keychainSentence('hub') })
  })
})
