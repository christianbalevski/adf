/**
 * Remote access end to end (docs/design/remote-access.md):
 * the built daemon (out/main/daemon.js, Electron as Node, isolated settings,
 * a free port, fake compute) and Studio main's real handlers against it
 * (daemon mode in local mode, the remote-access IPC, pairing, the quit
 * count). A fake second computer pairs over the daemon's loopback listener
 * (it serves /remote/hello and /pair/* too), then streams with its token
 * until it is revoked.
 *
 * Opt-in: ADF_E2E_REMOTE_ACCESS=1 after `npx electron-vite build`. While it
 * runs the daemon may listen on this computer's private LAN and Tailscale
 * addresses (device tokens only). The daemon is killed with taskkill /T /F,
 * never stopped gracefully.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('../backend/daemon-mode-electron')).electronStub.module)

import { ensureDaemonToken } from '../../src/main/daemon/daemon-token'
import { registerDaemonModeHandlers, type DaemonModeHandle } from '../../src/main/backend/daemon-mode'
import { registerRemoteAccessHandlers, type RemoteAccessIpc } from '../../src/main/backend/remote-access-ipc'
import { createBackendSettingsStore, resolveBootBackend, type SecretCodec } from '../../src/main/backend/backend-config'
import { createConnections, registerConnectionHandlers } from '../../src/main/backend/connections-ipc'
import { SavedConnectionsCache } from '../../src/main/backend/connections'
import { loadRemotes, readRemoteToken } from '../../src/main/cli/remotes'
import type { ConnectionsView } from '../../src/shared/types/connection.types'
import { IPC } from '../../src/shared/constants/ipc-channels'
import { electronStub } from '../backend/daemon-mode-electron'
import type { RemoteAccessView, RemoteDeviceAddResult, RemotePairState } from '../../src/shared/types/remote-access-ipc.types'

const REPO = resolve(__dirname, '../..')
const BUNDLE = join(REPO, 'out/main/daemon.js')
const ELECTRON = join(REPO, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const enabled = process.env.ADF_E2E_REMOTE_ACCESS === '1' && existsSync(BUNDLE)

const codec: SecretCodec = {
  available: () => true,
  encrypt: (plain) => 'safe:' + Buffer.from(plain).toString('base64'),
  decrypt: (stored) => Buffer.from(stored.slice(5), 'base64').toString(),
}
const quiet = { log: () => {}, warn: () => {}, error: () => {} }

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as { port: number }).port
  await new Promise<void>((r) => server.close(() => r()))
  return port
}

async function until<T>(read: () => T | Promise<T>, ok: (v: T) => boolean, ms = 15_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await read()
    if (ok(v)) return v
    if (Date.now() > end) throw new Error(`timed out; last: ${JSON.stringify(v)}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

describe.skipIf(!enabled)('remote access: Studio main against the built daemon', () => {
  let dir: string
  let port: number
  let base: string
  let child: ChildProcess
  let handle: DaemonModeHandle
  let remote: RemoteAccessIpc
  const events: Array<Record<string, unknown>> = []
  const asked: string[] = []
  const notices: string[] = []
  let store: ReturnType<typeof createBackendSettingsStore>
  /** This Studio's saved connections: its own folder and a test keychain, never the real one. */
  let clientEnv: NodeJS.ProcessEnv
  const invoke = <T>(channel: string, ...args: unknown[]) => electronStub.handlers.get(channel)!({}, ...args) as Promise<T>

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'adf-remote-e2e-'))
    port = await freePort()
    base = `http://127.0.0.1:${port}`
    const token = ensureDaemonToken(dir).token
    // One name: the runtime alias is what other computers see.
    writeFileSync(join(dir, 'adf-settings.json'), JSON.stringify({ runtimeAlias: 'agent-1 e2e' }))
    const out = openSync(join(dir, 'adf-daemon.log'), 'a')
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      ADF_DAEMON_PORT: String(port),
      ADF_DAEMON_HOST: '127.0.0.1',
      ADF_DAEMON_SETTINGS: join(dir, 'adf-settings.json'),
      ADF_DAEMON_PIDFILE: join(dir, 'daemon.pid'),
      ADF_DAEMON_STARTED_BY: 'studio',
      ADF_TEST_SEAMS: '1',
      ADF_COMPUTE: 'fake',
      ADF_TEST_KEYCHAIN_FILE: join(dir, 'keychain.json'),
      ADF_USER_DATA_DIR: dir,
    }
    delete env.ADF_DAEMON_TOKEN
    delete env.ADF_KEYCHAIN
    delete env.ADF_SECRET_STORE
    child = spawn(ELECTRON, [BUNDLE], { env, stdio: ['ignore', out, out], windowsHide: true })
    await until(() => fetch(`${base}/health`).then((r) => r.ok, () => false), (ok) => ok, 60_000)

    const boot = resolveBootBackend(join(dir, 'studio-backend.json'), {}, quiet)
    store = createBackendSettingsStore({ boot, codec, log: quiet })
    handle = registerDaemonModeHandlers({
      mode: 'local',
      userDataDir: dir,
      connect: Object.assign(async () => ({ baseUrl: base, logFile: join(dir, 'adf-daemon.log'), description: 'the e2e daemon', source: { token: () => token }, how: 'spawned' as const }), { logFile: join(dir, 'adf-daemon.log') }),
      leases: { registerClient: async () => {} },
      ipcMain: { handle: () => {}, on: () => {} } as never,
      keepDaemonRunning: false,
      onRemoteAccessEvent: (payload) => { events.push(payload as Record<string, unknown>); remote?.onDaemonEvent(payload) },
      log: quiet,
    })
    expect(await handle.ready).toBe(true)
    clientEnv = { ...process.env, ADF_DAEMON_SETTINGS: join(dir, 'client', 'adf-settings.json'), ADF_TEST_KEYCHAIN_FILE: join(dir, 'client-keychain.json'), ADF_TEST_SEAMS: '1' }
    delete clientEnv.ADF_KEYCHAIN
    delete clientEnv.ADF_SECRET_STORE
    // One cache for both, as Studio main has (index.ts).
    const savedCache = new SavedConnectionsCache(clientEnv)
    remote = registerRemoteAccessHandlers({
      savedCache,
      mode: 'local',
      daemon: () => handle,
      backend: store,
      codec,
      window: () => null,
      keepDaemonRunning: () => false,
      remotesEnv: clientEnv,
      overrides: {
        host: { confirm: async () => true, askClaim: async ({ claim }) => { asked.push(claim.deviceName); return true }, notify: (t) => notices.push(t), pollMs: 200 },
        discovery: { feed: () => null },
        consentPollMs: 1_000,
      },
      log: quiet,
    })
    registerConnectionHandlers(createConnections({
      boot, backend: store, env: clientEnv, saved: savedCache,
      daemonStatus: () => handle.status(),
      discovery: () => remote.discovery.snapshot(),
      confirm: async () => true,
      push: () => {},
      log: quiet,
    }))
  }, 90_000)

  afterAll(() => {
    remote?.dispose()
    // Never a graceful stop (Podman safety): kill the tree.
    if (child?.pid) {
      try {
        if (process.platform === 'win32') execFileSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true, stdio: 'ignore' })
        else child.kill('SIGKILL')
      } catch { /* already gone */ }
    }
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* the log may still be open */ }
  })

  it('on, a token for a computer, pairing with the host\'s Allow, revoke closes the stream, off', async () => {
    const off = await invoke<RemoteAccessView>(IPC.REMOTE_ACCESS_GET)
    expect(off).toMatchObject({ available: true, error: null })
    expect(off.status?.enabled).toBe(false)

    const on = await invoke<{ ok: boolean; view: RemoteAccessView }>(IPC.REMOTE_ACCESS_SET, { enabled: true })
    expect(on.ok).toBe(true)
    expect(on.view.status?.enabled).toBe(true)
    const fingerprint = on.view.status!.fingerprint!
    expect(fingerprint).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}$/)
    expect(on.view.status!.name).toBe('agent-1 e2e')
    console.log(`[e2e] on: ${on.view.status!.state}: ${on.view.status!.message}`)

    // Consent per network (owner decision 2026-10-18 b): this computer's networks are new to the
    // isolated settings, so nothing listens beyond loopback until each is allowed.
    const waiting = on.view.status!.networks.filter((n) => !n.allowed && n.id)
    expect(on.view.status!.addresses.filter((a) => a.listening)).toEqual([])
    if (on.view.status!.addresses.length > 0) expect(on.view.status!.state).toBe('paused')
    // Studio asks once per network (Not now here): "Remote access paused on <network>."
    // The notice is in the window, never a dialog (consent review 3): one per network.
    if (waiting.length) await until(() => invoke<Array<{ message: string }>>(IPC.NETWORK_NOTICES_GET), (a) => waiting.every((n) => a.some((x) => x.message === `Remote access paused on ${n.label}.`)), 15_000)
    expect(electronStub.calls.filter((c) => c.api === 'dialog.showMessageBox')).toEqual([])
    for (const n of waiting) {
      expect(await invoke(IPC.NETWORK_ALLOW, n.id)).toEqual({ ok: true })
      console.log(`[e2e] allowed ${n.label}`)
    }
    const allowedView = await invoke<RemoteAccessView>(IPC.REMOTE_ACCESS_GET)
    expect(allowedView.status!.networks.filter((n) => n.id).every((n) => n.allowed)).toBe(true)
    expect(allowedView.status!.allowedNetworks.map((n) => n.id).sort()).toEqual(waiting.map((n) => n.id).sort())
    for (const a of allowedView.status!.addresses.filter((x) => x.allowed)) expect(a.listening || a.problem !== null).toBe(true)

    // Add a computer: a device token, accepted on the loopback listener, refused on the management routes.
    const added = await invoke<RemoteDeviceAddResult>(IPC.REMOTE_ACCESS_DEVICE_ADD, 'agent-3 desktop')
    expect(added.ok).toBe(true)
    if (!added.ok) return
    expect(added.token).toMatch(/^adfd_/)
    expect((await fetch(`${base}/agents`, { headers: { Authorization: `Bearer ${added.token}` } })).status).toBe(200)
    const refused = await fetch(`${base}/remote-access`, { headers: { Authorization: `Bearer ${added.token}` } })
    expect(refused.status).toBe(403)
    expect((await refused.json()).code).toBe('device_token_refused')

    // Pair: the host opens a window, the other computer enters the code, the host allows it.
    const opened = await invoke<{ ok: boolean; view: RemoteAccessView }>(IPC.REMOTE_ACCESS_PAIRING_OPEN)
    expect(opened.ok).toBe(true)
    const code = opened.view.status!.pairing!.code
    expect(code).toMatch(/^\d{6}$/)
    const started = await invoke<RemotePairState>(IPC.REMOTE_PAIR_START, { url: base, deviceName: 'agent-2 laptop' })
    expect(started).toMatchObject({ step: 'need_code', host: { fingerprint, name: 'agent-1 e2e' } })
    const wrong = await invoke<RemotePairState>(IPC.REMOTE_PAIR_SUBMIT_CODE, code === '000000' ? '111111' : '000000')
    expect(wrong).toMatchObject({ step: 'need_code', code: 'wrong_code', attemptsLeft: 4 })
    // One claim per 2 s per address (§5.5): at once is rate_limited, and the dialog keeps the code field.
    expect(await invoke<RemotePairState>(IPC.REMOTE_PAIR_SUBMIT_CODE, code)).toMatchObject({ step: 'need_code', code: 'rate_limited' })
    await new Promise((r) => setTimeout(r, 2_100))
    expect(await invoke<RemotePairState>(IPC.REMOTE_PAIR_SUBMIT_CODE, code)).toMatchObject({ step: 'waiting' })
    await until(() => remote.pairing.state.step, (s) => s === 'paired' || s === 'failed', 30_000)
    expect(remote.pairing.state).toMatchObject({ step: 'paired' })
    expect(asked).toEqual(['agent-2 laptop'])
    // Saved where adf pair saves it (settings-scopes.md §5.2): cli-remotes.json and the keychain, shared with the CLI.
    const saved = loadRemotes(clientEnv).remotes['agent-1-e2e']
    expect(saved).toMatchObject({ url: base, fingerprint, label: 'agent-2 laptop', hostName: 'agent-1 e2e' })
    const pairedToken = readRemoteToken(fingerprint, clientEnv)!
    expect(pairedToken).toMatch(/^adfd_/)
    expect(remote.pairing.state).toMatchObject({ savedId: 'remote:agent-1-e2e' })
    // Settings → Connection: This computer in use, the paired computer as Paired with Connect, never a Pair row for it.
    const list = await invoke<ConnectionsView>(IPC.CONNECTION_LIST)
    expect(list.current).toMatchObject({ id: 'local', name: 'This computer', state: 'connected' })
    expect(list.rows.find((r) => r.id === 'remote:agent-1-e2e')).toMatchObject({ state: 'paired', action: 'connect', fingerprint })
    expect(list.rows.filter((r) => r.action === 'pair' && r.fingerprint === fingerprint)).toEqual([])
    await until(() => notices, (n) => n.includes('Device added: agent-2 laptop.'))
    await until(() => events.map((e) => e.type), (t) => t.includes('claim_pending') && t.includes('device_added'))
    console.log(`[e2e] events: ${events.map((e) => `${e.type}${e.reason ? `(${e.reason})` : ''}`).join(', ')}`)

    // The paired computer streams events with its token.
    const stream = await fetch(`${base}/events`, { headers: { Authorization: `Bearer ${pairedToken}`, Accept: 'text/event-stream' } })
    expect(stream.status).toBe(200)
    const reader = stream.body!.getReader()
    void reader.read()
    expect(await remote.host.connectedCount()).toBeGreaterThanOrEqual(1)

    // Revoke: confirmed, the stream ends, the token is refused with device_revoked.
    const pairedId = (await invoke<RemoteAccessView>(IPC.REMOTE_ACCESS_GET)).status!.devices.find((d) => d.label === 'agent-2 laptop')!.id
    const removed = await invoke<{ ok: boolean }>(IPC.REMOTE_ACCESS_DEVICE_REMOVE, pairedId)
    expect(removed.ok).toBe(true)
    const ended = await Promise.race([
      (async () => { for (;;) { const r = await reader.read().catch(() => ({ done: true })); if (r.done) return true } })(),
      new Promise<false>((r) => setTimeout(() => r(false), 5_000)),
    ])
    expect(ended).toBe(true)
    const revoked = await fetch(`${base}/agents`, { headers: { Authorization: `Bearer ${pairedToken}` } })
    expect(revoked.status).toBe(401)
    expect((await revoked.json()).code).toBe('device_revoked')
    await until(() => notices, (n) => n.includes('Device revoked: agent-2 laptop.'))

    // Remove each allowed network: its listeners close at once.
    for (const n of waiting) expect(await invoke(IPC.NETWORK_FORGET, n.id)).toEqual({ ok: true })
    const forgotten = await invoke<RemoteAccessView>(IPC.REMOTE_ACCESS_GET)
    expect(forgotten.status!.allowedNetworks).toEqual([])
    expect(forgotten.status!.addresses.filter((a) => a.listening)).toEqual([])

    const offAgain = await invoke<{ ok: boolean; view: RemoteAccessView }>(IPC.REMOTE_ACCESS_SET, { enabled: false })
    expect(offAgain.ok && offAgain.view.status?.enabled).toBe(false)
    expect((await fetch(`${base}/agents`, { headers: { Authorization: `Bearer ${added.token}` } })).status).toBe(401)
    console.log(`[e2e] daemon log tail:\n${readFileSync(join(dir, 'adf-daemon.log'), 'utf8').split('\n').filter((l) => l.includes('[remote-access]')).slice(-12).join('\n')}`)
  }, 120_000)
})
