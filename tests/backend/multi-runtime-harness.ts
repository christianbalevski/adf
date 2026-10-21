/**
 * The runtime-set harness of the multi-runtime tests: Studio in local mode
 * on a fake local daemon, with saved connections (fake remote hosts, the
 * real remote connector) in a temporary settings folder with the user-only
 * token file (ADF_KEYCHAIN=0, ADF_SECRET_STORE=file): the real keychain is
 * never opened. No network: every daemon is a fake fetch.
 *
 * The importing test file mocks `electron` (daemon-mode-electron.ts) and
 * calls `cleanup` after each test.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect } from 'vitest'
import { createFakeClientSession, createFakeDaemon, type FakeClientSession, type FakeDaemon } from './daemon-mode-fakes'
import { registerDaemonModeHandlers, type DaemonModeHandle } from '../../src/main/backend/daemon-mode'
import { remoteDaemonConnector } from '../../src/main/backend/daemon-mode/remote/connector'
import { defaultBackendConfig, type SecretCodec } from '../../src/main/backend/backend-config'
import { loadRemotesAsync } from '../../src/main/cli/remotes'
import { remotesEnv, saveConnection } from '../../src/main/backend/connections'
import { SUPPORTED_CLIENT_API_VERSION } from '../../src/shared/daemon-client'
import type { PendingNotification } from '../../src/shared/types/ipc.types'
import { deviceToken, helloResponse } from '../helpers/hello-proof'

export const LOCAL_BASE = 'http://127.0.0.1:47380'
export const TOKEN = 'a'.repeat(43)
/** The device token host `name` issued to this Studio (a real `adfd_` token: its hello proves it holds it). */
export const tokenOf = (name: string): string => deviceToken(name)
export const AGENT_1 = '6f1c2a4e-1b3d-4c5e-8f70-9a1b2c3d4e5f'
export const AGENT_2 = '0d9e8f7a-6b5c-4d3e-9f21-0a9b8c7d6e5f'
export const FILE_1 = join(tmpdir(), 'agents', 'agent-1.adf')
export const REMOTE_FILE_2 = '/srv/agents/agent-2.adf'
export const WINDOW = 7
export const codec: SecretCodec = { available: () => true, encrypt: (p) => `safe:${p}`, decrypt: (s) => s.slice(5) }

export const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms))
export async function until(check: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await tick()
  }
}

export function pending(id: string, filePath: string, agentName: string, requestedAt = 1): PendingNotification {
  return { id, kind: 'approval', requestId: id, filePath, agentName, loop: 'main', toolName: 'fs_write', preview: '', requestedAt }
}

/** A remote computer: its daemon routes, its pairing hello and whether it answers at all. */
export interface FakeHost {
  name: string
  url: string
  fingerprint: string
  daemon: FakeDaemon
  reachable: boolean
  /** The fingerprint /remote/hello shows (another computer at the address: another one). */
  shows: string
  sessions: FakeClientSession[]
  sleeps: number[]
  /** Requests to a path wait for its promise first (a request in flight; /remote/hello: a pin check in flight). */
  gates: Map<string, Promise<unknown>>
  fetch: typeof fetch
}

export function fakeHost(name: string, port: number, fingerprint: string): FakeHost {
  const url = `http://127.0.0.1:${port}`
  const daemon = createFakeDaemon(url)
  daemon.routes.set('GET /health', () => ({ ok: true }))
  daemon.routes.set('GET /version', () => ({ version: '0.9.0', clientApiVersion: SUPPORTED_CLIENT_API_VERSION, pid: port, startedBy: 'cli' }))
  daemon.routes.set('GET /agents', () => [])
  daemon.routes.set('GET /approvals', () => ({ pending: [], history: [] }))
  const host: FakeHost = {
    name, url, fingerprint, daemon, reachable: true, shows: fingerprint, sessions: [], sleeps: [], gates: new Map(),
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url).pathname
      const gate = host.gates.get(path)
      if (gate) await gate
      if (!host.reachable) throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) })
      // The authenticated hello (remote-access.md §5.2.1): another computer at the address (`shows` another
      // fingerprint) holds no record of this Studio's token.
      if (path === '/remote/hello') return helloResponse(new URL(String(input instanceof Request ? input.url : input)), { name, fingerprint: host.shows, tokens: host.shows === host.fingerprint ? [tokenOf(name)] : [] })
      return daemon.fetch(input, init)
    }) as typeof fetch,
  }
  return host
}

export const dirs: string[] = []
export const handles: DaemonModeHandle[] = []
/** Every booted Studio shut down and every folder removed: each test file's afterEach. */
export async function cleanup(): Promise<void> {
  for (const h of handles.splice(0)) await h.shutdown().catch(() => {})
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
}

/** `sleepScale`: each backoff sleep of a remote connector lasts that many times its delay (default 1). */
export async function boot(opts: { hosts: FakeHost[]; save?: FakeHost[]; hooks?: Record<string, unknown>; slot?: FakeHost; sleepScale?: number }) {
  const dir = mkdtempSync(join(tmpdir(), 'adf-multi-runtime-'))
  dirs.push(dir)
  // The user-only token file in the test's own folder: the OS keychain is never opened.
  const env = { ...remotesEnv(dir), ADF_KEYCHAIN: '0', ADF_SECRET_STORE: 'file' }
  delete (env as Record<string, string | undefined>).ADF_TEST_KEYCHAIN_FILE
  let pairedAt = 0
  const save = async (host: FakeHost) => {
    await saveConnection(env, { url: host.url, token: tokenOf(host.name), fingerprint: host.fingerprint, hostName: host.name, deviceId: `device-${host.name}`, label: 'Studio' }, { confirmFile: async () => true, now: new Date(Date.UTC(2026, 9, 20, 12, 0, pairedAt++)) })
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
        return remoteDaemonConnector(config, codec, { env, fetch: host.fetch, retry: { initialMs: 2, maxMs: 8 }, sleep: async (ms) => { host.sleeps.push(ms); await tick(ms * (opts.sleepScale ?? 1)) } })
      } } : {}),
      connectorFor: (name) => {
        const host = hostOf(name)
        const config = { ...defaultBackendConfig(), mode: 'remote' as const, remote: { url: null, token: null, allowInsecureHttp: false, name } }
        // The real connector of a saved connection; its backoff is this runtime's own.
        return remoteDaemonConnector(config, codec, { env, fetch: host.fetch, retry: { initialMs: 2, maxMs: 8 }, sleep: async (ms) => { host.sleeps.push(ms); await tick(ms * (opts.sleepScale ?? 1)) } })
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
