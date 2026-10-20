/**
 * Multi-runtime phase 1 (docs/design/multi-runtime.md §3, §4, §6.1): the
 * connection manager holding one RuntimeConnection per runtime, and
 * runtime-aware IPC.
 *
 * - Lifecycle: saved connections join the set and connect, in fixed order;
 *   a forgotten one disconnects (its agent windows close, its sessions end);
 *   quit ends every runtime in parallel and never stops a remote daemon.
 * - Each runtime keeps its own backoff; an unreachable runtime affects only
 *   its own calls; a 401 or a fingerprint mismatch fails that runtime only.
 * - Routing: no tag is the primary runtime; a tag names a runtime of the
 *   set; an agent window is served by its own runtime; the §4.3 refusals.
 * - Pushes of another runtime are tagged; the primary's never are.
 * - Approvals from every runtime are one list; equal ids stay distinct.
 *
 * Saved connections live in a temporary settings folder with the
 * user-only token file (ADF_KEYCHAIN=0, ADF_SECRET_STORE=file): the real
 * keychain is never opened. No network: every daemon is a fake fetch.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('./daemon-mode-electron')).electronStub.module)

import { electronStub } from './daemon-mode-electron'
import { createFakeClientSession, createFakeDaemon, type FakeClientSession, type FakeDaemon } from './daemon-mode-fakes'
import { AGENT_SESSION_END_TIMEOUT_MS, registerDaemonModeHandlers, type DaemonModeHandle } from '../../src/main/backend/daemon-mode'
import { PinMismatchError, type DaemonConnector } from '../../src/main/backend/daemon-mode/connection'
import { remoteDaemonConnector } from '../../src/main/backend/daemon-mode/remote/connector'
import { refusedTokenSentence } from '../../src/main/backend/daemon-mode/remote/connector'
import { ApprovalsAggregator } from '../../src/main/backend/daemon-mode/approvals-aggregator'
import { runtimeOrder } from '../../src/main/backend/daemon-mode/runtime-manager'
import { NoticeOwners } from '../../src/main/backend/daemon-mode/windows'
import { defaultBackendConfig, type SecretCodec } from '../../src/main/backend/backend-config'
import { loadRemotesAsync } from '../../src/main/cli/remotes'
import { remotesEnv, saveConnection } from '../../src/main/backend/connections'
import { SUPPORTED_CLIENT_API_VERSION } from '../../src/shared/daemon-client'
import { IPC } from '../../src/shared/constants/ipc-channels'
import type { NotificationsSnapshot, PendingNotification } from '../../src/shared/types/ipc.types'

const LOCAL_BASE = 'http://127.0.0.1:47380'
const TOKEN = 'a'.repeat(43)
const AGENT_1 = '6f1c2a4e-1b3d-4c5e-8f70-9a1b2c3d4e5f'
const AGENT_2 = '0d9e8f7a-6b5c-4d3e-9f21-0a9b8c7d6e5f'
const FILE_1 = join(tmpdir(), 'agents', 'agent-1.adf')
const REMOTE_FILE_2 = '/srv/agents/agent-2.adf'
const WINDOW = 7
const codec: SecretCodec = { available: () => true, encrypt: (p) => `safe:${p}`, decrypt: (s) => s.slice(5) }

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms))
async function until(check: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await tick()
  }
}

function pending(id: string, filePath: string, agentName: string, requestedAt = 1): PendingNotification {
  return { id, kind: 'approval', requestId: id, filePath, agentName, loop: 'main', toolName: 'fs_write', preview: '', requestedAt }
}

/** A remote computer: its daemon routes, its pairing hello and whether it answers at all. */
interface FakeHost {
  name: string
  url: string
  fingerprint: string
  daemon: FakeDaemon
  reachable: boolean
  /** The fingerprint /remote/hello shows (another computer at the address: another one). */
  shows: string
  sessions: FakeClientSession[]
  sleeps: number[]
  fetch: typeof fetch
}

function fakeHost(name: string, port: number, fingerprint: string): FakeHost {
  const url = `http://127.0.0.1:${port}`
  const daemon = createFakeDaemon(url)
  daemon.routes.set('GET /health', () => ({ ok: true }))
  daemon.routes.set('GET /version', () => ({ version: '0.9.0', clientApiVersion: SUPPORTED_CLIENT_API_VERSION, pid: port, startedBy: 'cli' }))
  daemon.routes.set('GET /agents', () => [])
  daemon.routes.set('GET /approvals', () => ({ pending: [], history: [] }))
  const host: FakeHost = {
    name, url, fingerprint, daemon, reachable: true, shows: fingerprint, sessions: [], sleeps: [],
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      if (!host.reachable) throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) })
      const path = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url).pathname
      if (path === '/remote/hello') return new Response(JSON.stringify({ v: 1, name, fingerprint: host.shows, pairingOpen: false, api: '2' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      return daemon.fetch(input, init)
    }) as typeof fetch,
  }
  return host
}

const dirs: string[] = []
const handles: DaemonModeHandle[] = []
afterEach(async () => {
  for (const h of handles.splice(0)) await h.shutdown().catch(() => {})
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function boot(opts: { hosts: FakeHost[]; save?: FakeHost[]; hooks?: Record<string, unknown>; slot?: FakeHost }) {
  const dir = mkdtempSync(join(tmpdir(), 'adf-multi-runtime-'))
  dirs.push(dir)
  // The user-only token file in the test's own folder: the OS keychain is never opened.
  const env = { ...remotesEnv(dir), ADF_KEYCHAIN: '0', ADF_SECRET_STORE: 'file' }
  delete (env as Record<string, string | undefined>).ADF_TEST_KEYCHAIN_FILE
  let pairedAt = 0
  const save = async (host: FakeHost) => {
    await saveConnection(env, { url: host.url, token: `${TOKEN}-${host.name}`, fingerprint: host.fingerprint, hostName: host.name, deviceId: `device-${host.name}`, label: 'Studio' }, { confirmFile: async () => true, now: new Date(Date.UTC(2026, 9, 20, 12, 0, pairedAt++)) })
  }
  for (const host of opts.save ?? opts.hosts) await save(host)

  const local = createFakeDaemon(LOCAL_BASE)
  local.routes.set('GET /agents', () => [])
  local.routes.set('GET /approvals', () => ({ pending: [], history: [] }))
  const localSessions: FakeClientSession[] = []
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const logs: string[] = []
  const log = { log: (m: string) => { logs.push(m) }, warn: (m: string) => { logs.push(String(m)) }, error: (m: string) => { logs.push(m) } }
  const closedWindows: number[] = []
  const keptWindows: number[] = []
  const hostOf = (name: string) => opts.hosts.find((h) => h.name === name)!
  const handle = registerDaemonModeHandlers({
    mode: 'local',
    userDataDir: dir,
    connect: Object.assign(async () => ({ baseUrl: LOCAL_BASE, logFile: join(dir, 'adf-daemon.log'), description: 'the fake local daemon', source: { token: () => TOKEN } }), { logFile: join(dir, 'adf-daemon.log') }),
    leases: { registerClient: async () => {} },
    ipcMain: {
      handle: (channel: string, fn: (...args: unknown[]) => unknown) => { handlers.set(channel, fn) },
      on: (channel: string, fn: (...args: unknown[]) => unknown) => { handlers.set(channel, fn) },
    } as never,
    fetch: local.fetch,
    createSession: () => {
      const s = createFakeClientSession()
      ;(s as { sessionId: string | null }).sessionId = `s-local-${localSessions.length + 1}`
      localSessions.push(s)
      return s
    },
    hooks: { closeAgentWindow: (id, keep) => { closedWindows.push(id); if (keep) keptWindows.push(id) }, ...opts.hooks },
    keepDaemonRunning: true,
    log,
    runtimeSet: {
      ...(opts.slot ? { slotConnector: () => {
        const host = opts.slot!
        const config = { ...defaultBackendConfig(), mode: 'remote' as const, remote: { url: host.url, token: codec.encrypt(TOKEN + '-' + host.name), allowInsecureHttp: false } }
        return remoteDaemonConnector(config, codec, { env, fetch: host.fetch, retry: { initialMs: 2, maxMs: 8 }, sleep: async (ms) => { host.sleeps.push(ms); await tick(ms) } })
      } } : {}),
      connectorFor: (name) => {
        const host = hostOf(name)
        const config = { ...defaultBackendConfig(), mode: 'remote' as const, remote: { url: null, token: null, allowInsecureHttp: false, name } }
        // The real connector of a saved connection; its backoff is this runtime's own.
        return remoteDaemonConnector(config, codec, { env, fetch: host.fetch, retry: { initialMs: 2, maxMs: 8 }, sleep: async (ms) => { host.sleeps.push(ms); await tick(ms) } })
      },
      overrides: (name) => {
        const host = opts.slot && opts.slot.name === name ? opts.slot : hostOf(name)
        return {
          fetch: host.fetch,
          createSession: () => {
            const s = createFakeClientSession()
            ;(s as { sessionId: string | null }).sessionId = `s-${name}-${host.sessions.length + 1}`
            host.sessions.push(s)
            return s
          },
        }
      },
    },
  })
  handles.push(handle)
  expect(await handle.ready).toBe(true)
  const sync = async () => handle.runtimes.sync((await loadRemotesAsync(env)).remotes)
  const invoke = (channel: string, sender: number | null, ...args: unknown[]) =>
    handlers.get(channel)!(sender === null ? {} : { sender: { id: sender } }, ...args)
  return { handle, env, local, localSessions, handlers, invoke, logs, closedWindows, keptWindows, sync, save, dir }
}

describe('RuntimeManager lifecycle', () => {
  it('saved connections join the set in pairedAt order and connect; This computer stays first', async () => {
    const host2 = fakeHost('host-2', 47392, 'FP-HOST-2')
    const host1 = fakeHost('host-1', 47391, 'FP-HOST-1')
    // host-2 was paired first.
    const t = await boot({ hosts: [host1, host2], save: [host2, host1] })
    await t.sync()
    expect(t.handle.runtimes.runtimes().map((r) => r.id)).toEqual(['local', 'remote:host-2', 'remote:host-1'])
    const r1 = t.handle.runtimes.get('remote:host-1')!
    const r2 = t.handle.runtimes.get('remote:host-2')!
    expect(await r1.ready).toBe(true)
    expect(await r2.ready).toBe(true)
    expect(r1.connection.state.state).toBe('connected')
    // Each remote got its own token, to its own origin only.
    expect(host1.daemon.requests.find((r) => r.path === '/agents')?.auth).toBe(`Bearer ${TOKEN}-host-1`)
    expect(host2.daemon.requests.find((r) => r.path === '/agents')?.auth).toBe(`Bearer ${TOKEN}-host-2`)
    // The primary's id did not change, and a second sync with the same list changes nothing.
    const before = t.handle.runtimes.runtimes()
    await t.sync()
    expect(t.handle.runtimes.runtimes()).toEqual(before)
  })

  it('a connection forgotten while Studio runs disconnects: its agent windows close and its sessions end', async () => {
    const host1 = fakeHost('host-1', 47391, 'FP-HOST-1')
    const t = await boot({ hosts: [host1] })
    await t.sync()
    const r1 = t.handle.runtimes.get('remote:host-1')!
    await r1.ready
    t.handle.windows.open({ id: WINDOW, send: () => {}, focused: () => false }, 'remote:host-1')
    await until(() => host1.sessions.length === 2)
    t.handle.runtimes.sync({})
    await until(() => t.handle.runtimes.get('remote:host-1') === null && host1.sessions.every((s) => s.ended))
    expect(t.closedWindows).toEqual([WINDOW])
    expect(t.handle.runtimes.runtimes().map((r) => r.id)).toEqual(['local'])
    expect(t.logs.some((l) => l.includes('[Runtimes] Disconnecting remote:host-1: it is no longer saved'))).toBe(true)
    // Its calls now refuse: it is not in the set.
    expect(() => t.invoke(IPC.FILE_GET_CURRENT, null, { $runtime: 'remote:host-1' })).toThrow('remote:host-1 is not connected.')
  })

  it('quit ends every runtime in parallel; a remote daemon is never asked to stop', async () => {
    const host1 = fakeHost('host-1', 47391, 'FP-HOST-1')
    const t = await boot({ hosts: [host1] })
    await t.sync()
    await t.handle.runtimes.get('remote:host-1')!.ready
    const quits: boolean[] = []
    t.localSessions[0].quit = async (stopDaemon: boolean) => { quits.push(stopDaemon); return { sessionId: 's-local-1', ended: true, stopping: false, reason: 'test', otherSessions: 0 } }
    host1.sessions[0].quit = async () => { throw new Error('a remote daemon must not get a quit request') }
    await t.handle.shutdown()
    expect(quits).toEqual([false])
    expect(host1.sessions[0].ended).toBe(true)
    expect(host1.daemon.requests.some((r) => r.path.includes('/quit'))).toBe(false)
  })
})

describe('RuntimeManager recovery and bounds', () => {
  it('Reconnect on a failed remote replaces its connection; Studio does not restart', async () => {
    const host1 = fakeHost('host-1', 47391, 'FP-HOST-1')
    const t = await boot({ hosts: [host1] })
    await t.sync()
    const failed = t.handle.runtimes.get('remote:host-1')!
    await failed.ready
    host1.daemon.routes.set('GET /files/agent', () => ({ status: 401, body: { error: 'Unauthorized' } }))
    await failed.ctx.runningAgentAt('/srv/agents/agent-1.adf').catch(() => null)
    await until(() => failed.connection.state.state === 'failed')
    host1.daemon.routes.delete('GET /files/agent')
    failed.reconnect()
    await until(() => t.handle.runtimes.get('remote:host-1') !== failed)
    const fresh = t.handle.runtimes.get('remote:host-1')!
    expect(await fresh.ready).toBe(true)
    expect(fresh.connection.state.state).toBe('connected')
    expect(t.handle.runtimes.runtimes().map((r) => r.id)).toEqual(['local', 'remote:host-1'])
    expect(electronStub.calls.filter((c) => c.api === 'dialog.showMessageBox' && JSON.stringify(c.args).includes('Restart Studio'))).toEqual([])
  })

  it('quit with a remote that does not answer stays within the session-end budget', async () => {
    const host1 = fakeHost('host-1', 47391, 'FP-HOST-1')
    const t = await boot({ hosts: [host1] })
    await t.sync()
    await t.handle.runtimes.get('remote:host-1')!.ready
    host1.sessions[0].end = () => new Promise(() => {})
    const started = Date.now()
    await t.handle.shutdown()
    expect(Date.now() - started).toBeLessThan(AGENT_SESSION_END_TIMEOUT_MS + 1_000)
    expect(t.logs.some((l) => l.includes('[Backend remote:host-1] Quit: the client session did not end within'))).toBe(true)
  })
})

describe('one runtime\'s trouble stays its own', () => {
  it('an unreachable remote retries on its own backoff; the others connect and answer', async () => {
    const host1 = fakeHost('host-1', 47391, 'FP-HOST-1')
    const host2 = fakeHost('host-2', 47392, 'FP-HOST-2')
    host2.reachable = false
    const t = await boot({ hosts: [host1, host2] })
    await t.sync()
    const r1 = t.handle.runtimes.get('remote:host-1')!
    const r2 = t.handle.runtimes.get('remote:host-2')!
    expect(await r1.ready).toBe(true)
    await until(() => host2.sleeps.length >= 4)
    // host-2's own doubling backoff, capped at its maximum; host-1 never waited.
    expect(host2.sleeps.slice(0, 4)).toEqual([2, 4, 8, 8])
    expect(host1.sleeps).toEqual([])
    expect(r2.connection.state.state).toBe('connecting')
    // The primary and host-1 answer while host-2 waits.
    expect(await t.invoke(IPC.FILE_GET_CURRENT, null)).toEqual({ filePath: null, agentRunning: false })
    expect(await t.invoke(IPC.FILE_GET_CURRENT, null, { $runtime: 'remote:host-1' })).toEqual({ filePath: null, agentRunning: false })
    expect(t.handle.connection.state.state).toBe('connected')
    // host-2 comes up: it connects on its own.
    host2.reachable = true
    expect(await r2.ready).toBe(true)
    expect(r2.connection.state.state).toBe('connected')
  })

  it('a 401 fails that runtime only, with the refused-token sentence', async () => {
    const host1 = fakeHost('host-1', 47391, 'FP-HOST-1')
    const host2 = fakeHost('host-2', 47392, 'FP-HOST-2')
    const t = await boot({ hosts: [host1, host2] })
    await t.sync()
    const r1 = t.handle.runtimes.get('remote:host-1')!
    const r2 = t.handle.runtimes.get('remote:host-2')!
    await r1.ready
    await r2.ready
    host1.daemon.routes.set('GET /agents/x/status', () => ({ status: 401, body: { error: 'Unauthorized' } }))
    host1.daemon.routes.set('GET /files/agent', () => ({ status: 401, body: { error: 'Unauthorized' } }))
    await r1.ctx.runningAgentAt('/srv/agents/agent-1.adf').catch(() => null)
    await until(() => r1.connection.state.state === 'failed')
    expect(r1.connection.state).toEqual({ state: 'failed', message: refusedTokenSentence(host1.url) })
    expect(r2.connection.state.state).toBe('connected')
    expect(t.handle.connection.state.state).toBe('connected')
    // No modal dialog for a remote's failure (§3.6).
    expect(electronStub.calls.filter((c) => c.api === 'dialog.showMessageBox' && JSON.stringify(c.args).includes('host-1'))).toEqual([])
  })

  it('another computer at a remote\'s address fails that runtime only; nothing is sent to it', async () => {
    const host1 = fakeHost('host-1', 47391, 'FP-HOST-1')
    const host2 = fakeHost('host-2', 47392, 'FP-HOST-2')
    const t = await boot({ hosts: [host1, host2] })
    await t.sync()
    const r1 = t.handle.runtimes.get('remote:host-1')!
    const r2 = t.handle.runtimes.get('remote:host-2')!
    await r1.ready
    await r2.ready
    host1.shows = 'FP-EVIL-1'
    const sentBefore = host1.daemon.requests.length
    // The stream drops: before the token goes out again, the fingerprint is checked.
    host1.sessions[0].listener!.onConnection({ state: 'reconnecting', error: 'the stream dropped' })
    await until(() => r1.connection.state.state === 'failed')
    expect(r1.connection.state).toEqual({ state: 'failed', message: `${host1.url} is not host-1 (fingerprint FP-EVIL-1, paired as FP-HOST-1); the token was not sent.` })
    expect(host1.daemon.requests.slice(sentBefore).filter((r) => r.auth)).toEqual([])
    expect(r2.connection.state.state).toBe('connected')
    expect(t.handle.connection.state.state).toBe('connected')
  })

  it('a pin mismatch from a connector fails that runtime (PinMismatchError)', async () => {
    // The connector half: a mismatch is a PinMismatchError, which DaemonConnection turns into "failed".
    const host1 = fakeHost('host-1', 47391, 'FP-HOST-1')
    const t = await boot({ hosts: [host1] })
    const connector = remoteDaemonConnector({ ...defaultBackendConfig(), mode: 'remote', remote: { url: null, token: null, allowInsecureHttp: false, name: 'host-1' } }, codec, { env: t.env, fetch: host1.fetch }) as DaemonConnector
    await connector(() => {})
    host1.shows = 'FP-EVIL-1'
    await expect(connector.pinCheck!()).rejects.toBeInstanceOf(PinMismatchError)
  })
})

describe('runtime-aware IPC routing (§4.3)', () => {
  async function connected() {
    const host1 = fakeHost('host-1', 47391, 'FP-HOST-1')
    host1.daemon.routes.set('GET /files/agent', (req) => ({ agentId: req.query.path === REMOTE_FILE_2 ? AGENT_2 : null, loaded: req.query.path === REMOTE_FILE_2 }))
    const t = await boot({ hosts: [host1] })
    await t.sync()
    await t.handle.runtimes.get('remote:host-1')!.ready
    return { ...t, host1 }
  }

  it('no tag: the primary runtime, with exactly the arguments of the call', async () => {
    const t = await connected()
    expect(await t.invoke(IPC.FILE_GET_CURRENT, null)).toEqual({ filePath: null, agentRunning: false })
    expect(await t.invoke(IPC.FILE_GET_CURRENT, 1)).toEqual({ filePath: null, agentRunning: false })
    expect(t.host1.daemon.requests.filter((r) => r.path === '/files/agent')).toEqual([])
  })

  it('a tag names a runtime of the set; its handler variant is chosen from that runtime\'s kind', async () => {
    const t = await connected()
    // FILE_REVEAL: This computer reveals in the folder; a remote runtime gets the remote variant, which shows the path (M5).
    const calls = electronStub.calls.length
    await t.invoke(IPC.FILE_REVEAL, null, { $runtime: 'remote:host-1' }, { filePath: REMOTE_FILE_2 })
    const shown = electronStub.calls.slice(calls).filter((c) => c.api === 'dialog.showMessageBox').map((c) => (c.args[0] as { message?: string }).message)
    expect(shown).toEqual([`This file is on ${new URL(t.host1.url).host}.`])
    expect(electronStub.calls.filter((c) => c.api === 'shell.showItemInFolder')).toEqual([])
    const ctx = t.handle.runtimes.contextFor(undefined, 'remote:host-1')
    expect(ctx.mode).toBe('remote')
    expect(ctx.runtime).toEqual({ id: 'remote:host-1', primary: false })
    expect(await ctx.runningAgentAt(REMOTE_FILE_2)).toBe(AGENT_2)
    expect(t.local.requests.filter((r) => r.path === '/files/agent')).toEqual([])
  })

  it('refuses a runtime not in the set, a studio call with a tag, and a closed window', async () => {
    const t = await connected()
    expect(() => t.invoke(IPC.FILE_GET_CURRENT, null, { $runtime: 'remote:host-9' })).toThrow('remote:host-9 is not connected.')
    expect(() => t.invoke(IPC.APPROVALS_GET_PENDING_REVEAL, null, { $runtime: 'remote:host-1' })).toThrow('This call has no runtime.')
    expect(t.logs.some((l) => l.includes('is a Studio call and has no runtime'))).toBe(true)
    t.handle.windows.open({ id: WINDOW, send: () => {}, focused: () => false })
    await t.handle.windows.close(WINDOW)
    expect(() => t.invoke(IPC.FILE_GET_CURRENT, WINDOW)).toThrow('This agent window is closed.')
    expect(() => t.invoke(IPC.FILE_GET_CURRENT, WINDOW, { $runtime: 'remote:host-1' })).toThrow('This agent window is closed.')
  })

  it('an agent window is served by its own runtime; a tag for another runtime is refused', async () => {
    const t = await connected()
    const pushes: Array<{ channel: string; args: unknown[] }> = []
    t.handle.windows.open({ id: WINDOW, send: (channel, ...args) => { pushes.push({ channel, args }) }, focused: () => false }, 'remote:host-1')
    expect(t.handle.windows.runtimeOf(WINDOW)).toBe('remote:host-1')
    expect(t.handle.runtimes.contextFor(WINDOW, null).runtime).toEqual({ id: 'remote:host-1', primary: false })
    expect(t.handle.runtimes.contextFor(WINDOW, 'remote:host-1').runtime).toEqual({ id: 'remote:host-1', primary: false })
    expect(() => t.invoke(IPC.FILE_GET_CURRENT, WINDOW, { $runtime: 'local' })).toThrow('This window shows an agent on host-1.')
    // A window of This computer, tagged with the remote.
    t.handle.windows.open({ id: WINDOW + 1, send: () => {}, focused: () => false })
    expect(() => t.invoke(IPC.FILE_GET_CURRENT, WINDOW + 1, { $runtime: 'remote:host-1' })).toThrow('This window shows an agent on This computer.')
    expect(t.handle.windows.runtimeOf(WINDOW + 1)).toBeNull()
  })

  it('a reloaded main window\'s session resync (no tag) asks the runtime of its open agent, and the answer names it', async () => {
    const t = await connected()
    const host = t.handle.runtimes.get('remote:host-1')!
    await host.session.openFile(REMOTE_FILE_2, async () => null)
    t.handle.runtimes.setMainOpenRuntime('remote:host-1')
    expect(await t.invoke(IPC.FILE_GET_CURRENT, 1)).toEqual({ filePath: REMOTE_FILE_2, agentRunning: false, runtimeId: 'remote:host-1' })
    // An agent window asks its own session, as before.
    t.handle.windows.open({ id: WINDOW, send: () => {}, focused: () => false })
    expect(await t.invoke(IPC.FILE_GET_CURRENT, WINDOW)).toEqual({ filePath: null, agentRunning: false })
    // The open agent back on This computer: its answer has no runtime, as before.
    t.handle.runtimes.setMainOpenRuntime('local')
    expect(await t.invoke(IPC.FILE_GET_CURRENT, 1)).toEqual({ filePath: null, agentRunning: false })
  })

  it('a send with a tag on a studio channel is dropped and logged', async () => {
    const t = await connected()
    // FILE_SHARE_DRAG_START is the one send channel (studio scope). Dropped: its handler (startDrag on the sender) never runs.
    expect(() => t.invoke(IPC.FILE_SHARE_DRAG_START, 1, { $runtime: 'remote:host-1' }, 'share-token')).not.toThrow()
    expect(t.logs.some((l) => l.includes('dropped: This call has no runtime.'))).toBe(true)
  })

  it('pushes: the primary\'s are untagged; another runtime\'s runtime-scoped pushes carry its tag', async () => {
    const t = await connected()
    const before = electronStub.pushes.length
    t.localSessions[0].listener!.onFrame({ kind: 'push', topic: 'file_renamed', payload: { oldPath: FILE_1, newPath: `${FILE_1}.x` } })
    t.host1.sessions[0].listener!.onFrame({ kind: 'push', topic: 'file_renamed', payload: { oldPath: REMOTE_FILE_2, newPath: `${REMOTE_FILE_2}.x` } })
    const renamed = electronStub.pushes.slice(before).filter((p) => p.channel === IPC.FILE_RENAMED).map((p) => p.args)
    expect(renamed).toEqual([
      [{ oldPath: FILE_1, newPath: `${FILE_1}.x` }],
      [{ $runtime: 'remote:host-1' }, { oldPath: REMOTE_FILE_2, newPath: `${REMOTE_FILE_2}.x` }],
    ])
  })

  it('approvals of every runtime are one untagged list; remote entries carry runtimeId', async () => {
    const t = await connected()
    const before = electronStub.pushes.length
    t.localSessions[0].listener!.onFrame({ kind: 'push', topic: 'approvals', payload: { pending: [pending('n1', FILE_1, 'agent-1', 2)], history: [] } })
    t.host1.sessions[0].listener!.onFrame({ kind: 'push', topic: 'approvals', payload: { pending: [pending('n1', REMOTE_FILE_2, 'agent-2', 1)], history: [] } })
    const last = electronStub.pushes.slice(before).filter((p) => p.channel === IPC.APPROVALS_CHANGED).at(-1)!
    expect(last.args).toHaveLength(1)
    expect((last.args[0] as NotificationsSnapshot).pending).toEqual([
      { ...pending('n1', REMOTE_FILE_2, 'agent-2', 1), runtimeId: 'remote:host-1' },
      pending('n1', FILE_1, 'agent-1', 2),
    ])
    // The runtime leaves: its entries go.
    t.handle.runtimes.sync({})
    await until(() => {
      const p = electronStub.pushes.filter((x) => x.channel === IPC.APPROVALS_CHANGED).at(-1)!.args[0] as NotificationsSnapshot
      return p.pending.length === 1
    })
  })
})

describe('phase 1 pieces', () => {
  it('ApprovalsAggregator: the primary\'s snapshot object itself while no other runtime has entries', () => {
    const agg = new ApprovalsAggregator('local')
    const local: NotificationsSnapshot = { pending: [pending('n1', FILE_1, 'agent-1')], history: [] }
    agg.set('local', local)
    agg.set('remote:host-1', { pending: [], history: [] })
    expect(agg.merged()).toBe(local)
    agg.set('remote:host-1', { pending: [], history: [{ ...pending('h1', REMOTE_FILE_2, 'agent-2'), outcome: 'approved', resolvedAt: 9 }] })
    const merged = agg.merged()
    expect(merged.history).toEqual([{ ...pending('h1', REMOTE_FILE_2, 'agent-2'), outcome: 'approved', resolvedAt: 9, runtimeId: 'remote:host-1' }])
    expect(agg.delete('remote:host-1')).toBe(true)
    expect(agg.merged()).toBe(local)
  })

  it('NoticeOwners: equal notification ids on two runtimes stay distinct', () => {
    const owners = new NoticeOwners((a, b) => !!a && a === b)
    const windows = [
      { id: 1, main: true, focused: false, filePath: null },
      { id: WINDOW, main: false, focused: true, filePath: REMOTE_FILE_2, runtimeId: 'remote:host-1' },
    ]
    owners.assign([pending('n1', FILE_1, 'agent-1'), { ...pending('n1', REMOTE_FILE_2, 'agent-2'), runtimeId: 'remote:host-1' }], windows)
    expect(owners.owner('n1')).toBe(1)
    expect(owners.owner('remote:host-1\nn1')).toBe(WINDOW)
    expect(owners.idsFor(WINDOW)).toEqual(['remote:host-1\nn1'])
  })

  it('runtimeOrder: kept order first, new ones by pairedAt, gone ones dropped', () => {
    expect(runtimeOrder([], { b: { pairedAt: '2026-01-02' }, a: { pairedAt: '2026-01-03' }, c: { pairedAt: '2026-01-01' } })).toEqual(['remote:c', 'remote:b', 'remote:a'])
    expect(runtimeOrder(['remote:a', 'remote:x'], { b: { pairedAt: '2026-01-01' }, a: { pairedAt: '2026-01-03' } })).toEqual(['remote:a', 'remote:b'])
  })
})

describe('phase 3: saving connects, Reconnect reopens, the slot, recent files (multi-runtime.md §3, §6.6, §7.5)', () => {
  it('a remote that connects for the first time asks for its saved agent windows once (runtimeConnected)', async () => {
    const connected: string[] = []
    const host1 = fakeHost('host-1', 47391, 'FP-HOST-1')
    const t = await boot({ hosts: [host1], hooks: { runtimeConnected: (id: string) => { connected.push(id) } } })
    await t.sync()
    await t.handle.runtimes.get('remote:host-1')!.ready
    await until(() => connected.length === 1)
    // A drop and a resume is the same connection: no second ask.
    host1.sessions[0].listener!.onConnection({ state: 'reconnecting', error: 'the stream dropped' })
    host1.sessions[0].listener!.onConnection({ state: 'open' })
    await tick(20)
    expect(connected).toEqual(['remote:host-1'])
  })

  it('Reconnect on a failed remote closes its agent windows to reopen (keep); the new connection asks for them again', async () => {
    const connected: string[] = []
    const host1 = fakeHost('host-1', 47391, 'FP-HOST-1')
    const t = await boot({ hosts: [host1], hooks: { runtimeConnected: (id: string) => { connected.push(id) } } })
    await t.sync()
    const failed = t.handle.runtimes.get('remote:host-1')!
    await failed.ready
    t.handle.windows.open({ id: WINDOW, send: () => {}, focused: () => false }, 'remote:host-1')
    host1.daemon.routes.set('GET /files/agent', () => ({ status: 401, body: { error: 'Unauthorized' } }))
    await failed.ctx.runningAgentAt('/srv/agents/agent-1.adf').catch(() => null)
    await until(() => failed.connection.state.state === 'failed')
    host1.daemon.routes.delete('GET /files/agent')
    // The window answers the stash request at once.
    t.handle.windows.stashed(WINDOW)
    failed.reconnect()
    t.handle.windows.stashed(WINDOW)
    await until(() => t.handle.runtimes.get('remote:host-1') !== failed)
    await t.handle.runtimes.get('remote:host-1')!.ready
    expect(t.keptWindows).toEqual([WINDOW])
    await until(() => connected.length === 2)
    expect(connected).toEqual(['remote:host-1', 'remote:host-1'])
  })

  it('the remote slot of studio-backend.json is a runtime: it connects with its own token, untagged calls stay This computer\'s', async () => {
    const office = fakeHost('office', 47393, 'FP-OFFICE')
    const t = await boot({ hosts: [], save: [], slot: office })
    t.handle.runtimes.sync({}, { name: 'office', url: office.url })
    const slot = t.handle.runtimes.get('remote')!
    expect(await slot.ready).toBe(true)
    expect(t.handle.runtimes.runtimes().map((r) => [r.id, r.name()])).toEqual([['local', 'This computer'], ['remote', 'office']])
    expect(office.daemon.requests.find((r) => r.path === '/agents')?.auth).toBe(`Bearer ${TOKEN}-office`)
    expect(t.local.requests.some((r) => r.auth === `Bearer ${TOKEN}-office`)).toBe(false)
  })

  it('a remote\'s recent files go to runtimeRecentFiles under its id, never to recentFiles', async () => {
    const host1 = fakeHost('host-1', 47391, 'FP-HOST-1')
    const t = await boot({ hosts: [host1] })
    await t.sync()
    const rt = t.handle.runtimes.get('remote:host-1')!
    await rt.ready
    rt.ctx.recordRecentFile(REMOTE_FILE_2)
    expect(t.handle.clientSettings.get('runtimeRecentFiles')).toEqual({ 'remote:host-1': [REMOTE_FILE_2] })
    expect(t.handle.clientSettings.get('recentFiles')).toBeUndefined()
    rt.ctx.renameRecentFile!(REMOTE_FILE_2, '/srv/agents/claimed/agent-2.adf')
    expect(t.handle.clientSettings.get('runtimeRecentFiles')).toEqual({ 'remote:host-1': ['/srv/agents/claimed/agent-2.adf'] })
    // This computer's context keeps recentFiles, with no rename hook.
    expect(t.handle.runtimes.primary.ctx.renameRecentFile).toBeUndefined()
  })
})
