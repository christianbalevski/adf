/**
 * Local mode, the daemon's process exits under a connected Studio (W5-D2):
 * the drop is told apart from a lost connection by the daemon's pid, the
 * status line and the dialog or notice say "exited", the cause comes from
 * the daemon log's tail, and Reconnect runs the connector's revive
 * (controller.ensure) instead of re-dialing the stream. A daemon Studio
 * started is started again once, by itself; one the CLI started never is.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('./daemon-mode-electron')).electronStub.module)

import { electronStub, helpLabels } from './daemon-mode-electron'
import { createFakeClientSession, createFakeDaemon } from './daemon-mode-fakes'
import { registerDaemonModeHandlers } from '../../src/main/backend/daemon-mode'
import { readDaemonExitCause } from '../../src/main/backend/daemon-mode/daemon-exit'
import { DaemonConnection, type DaemonEndpoint } from '../../src/main/backend/daemon-mode/connection'
import type { DaemonVersionInfo } from '../../src/main/daemon/routes/meta-routes'

const BASE = 'http://127.0.0.1:47391'
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

const info = (pid: number, startedBy: DaemonVersionInfo['startedBy']): DaemonVersionInfo => ({
  version: '0.8.0', clientApiVersion: 1, settingsPath: 'C:/x/adf-settings.json', dataDir: 'C:/x', runtimeId: null, pid, startedBy,
  localProof: { available: false, problem: 'test' },
})

function boot(startedBy: DaemonVersionInfo['startedBy'], opts: { reviveFails?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'adf-daemon-mode-exit-'))
  dirs.push(dir)
  const logFile = join(dir, 'adf-daemon.log')
  const daemon = createFakeDaemon(BASE)
  daemon.routes.set('GET /agents', () => [])
  daemon.routes.set('GET /approvals', () => ({ pending: [], history: [] }))
  const session = createFakeClientSession()
  const dead = new Set<number>()
  let pid = 1001
  const revives: number[] = []
  const endpoint = (): DaemonEndpoint => ({ baseUrl: BASE, logFile, description: `the fake daemon pid ${pid}`, source: { token: () => 't' }, daemon: info(pid, startedBy), how: 'spawned' })
  const connect = Object.assign(async () => endpoint(), {
    logFile,
    revive: async () => {
      revives.push(pid)
      if (opts.reviveFails) throw new Error('The ADF daemon exited during startup (code 1).')
      pid += 1
      return { ...endpoint(), daemon: info(pid, 'studio') }
    },
  })
  const logs: string[] = []
  const handle = registerDaemonModeHandlers({
    mode: 'local',
    userDataDir: dir,
    connect,
    leases: { registerClient: async () => {} },
    ipcMain: { handle: () => {}, on: () => {} } as never,
    fetch: daemon.fetch,
    createSession: () => session,
    processAlive: (p) => !dead.has(p),
    respawnDelayMs: 0,
    log: { log: (m: string) => { logs.push(m) }, warn: (m: string) => { logs.push(m) }, error: (m: string) => { logs.push(m) } },
  })
  /** The daemon process dies: its pid is gone and the stream drops. */
  const kill = () => {
    dead.add(pid)
    session.listener!.onConnection({ state: 'reconnecting', error: 'fetch failed' })
  }
  return { handle, session, logFile, revives, logs, kill, pid: () => pid }
}

const dialogs = () => electronStub.calls.filter((c) => c.api === 'dialog.showMessageBox').map((c) => c.args[0] as { title?: string; message: string; detail: string; buttons: string[] })
const notices = () => electronStub.calls.filter((c) => c.api === 'Notification.show').map((c) => (c.args[0] as { body: string }).body)

describe('readDaemonExitCause', () => {
  it('reads the last run\'s shutdown line; a run with none is a kill or a hard crash (null)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-daemon-exit-log-'))
    dirs.push(dir)
    const file = join(dir, 'adf-daemon.log')
    writeFileSync(file, '[ADF Daemon] Version 1 (pid 1, started by studio)\n[ADF Daemon] Received SIGTERM — shutting down...\n[ADF Daemon] Version 1 (pid 2, started by studio)\n[Runtime] working\n')
    expect(await readDaemonExitCause(file)).toBeNull()
    writeFileSync(file, '[ADF Daemon] Version 1 (pid 2, started by studio)\n[ADF Daemon] Received SIGTERM — shutting down...\n[ADF Daemon] Shutdown exceeded 20000ms budget — forcing exit\n')
    expect(await readDaemonExitCause(file)).toEqual({ text: 'signal SIGTERM; forced exit after 20s', deliberate: false })
    writeFileSync(file, '[ADF Daemon] Version 1 (pid 3, started by cli)\n[ADF Daemon] Stop requested over HTTP — shutting down...\n')
    expect(await readDaemonExitCause(file)).toEqual({ text: 'stopped with adf daemon stop', deliberate: true })
    writeFileSync(file, '[ADF Daemon] Version 1 (pid 4, started by cli)\n[ADF Daemon] Failed to start: port 7385 on 127.0.0.1 is already in use — an ADF daemon is likely running.\n')
    expect(await readDaemonExitCause(file)).toEqual({ text: 'code 1: Failed to start: port 7385 on 127.0.0.1 is already in use', deliberate: false })
    expect(await readDaemonExitCause(join(dir, 'missing.log'))).toBeNull()
    expect(await readDaemonExitCause(null)).toBeNull()
  })
})

describe('local mode: the daemon process exited', () => {
  it('a daemon Studio started: one notice, started again by itself (controller.ensure), re-held, then a notice with the result', async () => {
    electronStub.calls.length = 0
    const { handle, session, revives, logFile, kill, logs } = boot('studio')
    expect(await handle.ready).toBe(true)
    writeFileSync(logFile, '[ADF Daemon] Version 0.8.0 (pid 1001, started by studio)\n')
    kill()
    await vi.waitFor(() => expect(revives).toEqual([1001]))
    expect(notices()).toContain('The ADF daemon (pid 1001) exited; agents are stopped. Studio is starting it again.')
    expect(logs.some((l) => l.includes('Its log has no shutdown line: it was killed or crashed.'))).toBe(true)
    // The stream is re-dialed on the new daemon (a new session there re-holds and re-focuses: client-stream.ts).
    await vi.waitFor(() => expect(session.reconnects).toBe(1))
    session.listener!.onConnection({ state: 'open' })
    await vi.waitFor(() => expect(notices()).toContain('Studio started the ADF daemon again (pid 1002).'))
    expect(dialogs()).toEqual([])
    expect(notices()).not.toContain('Reconnected to the ADF daemon.')
    expect(handle.status()).toMatchObject({ connection: 'connected', pid: 1002 })
    await handle.shutdown()
  })

  it('a second exit within the window is not restarted by itself: the dialog appears again (within the cooldown) and offers the start', async () => {
    electronStub.calls.length = 0
    electronStub.dialogResponse = 99 // dismiss
    const { handle, session, revives, kill } = boot('studio')
    expect(await handle.ready).toBe(true)
    kill()
    await vi.waitFor(() => expect(session.reconnects).toBe(1))
    session.listener!.onConnection({ state: 'open' })
    await vi.waitFor(() => expect(notices().some((n) => n.startsWith('Studio started the ADF daemon again'))).toBe(true))
    kill()
    await vi.waitFor(() => expect(dialogs()).toHaveLength(1))
    expect(dialogs()[0]).toMatchObject({ title: 'ADF daemon exited', message: 'The ADF daemon (pid 1002) exited; agents are stopped.', buttons: ['Start the ADF Daemon', 'Open Daemon Log', 'Dismiss'] })
    expect(dialogs()[0].detail).toMatch(/Studio already started it again 1 min ago/)
    expect(revives).toEqual([1001])
    expect(helpLabels(electronStub)).toContain('ADF daemon: exited (pid 1002); agents are stopped')
    await handle.shutdown()
  })

  it('a daemon the CLI started is never started by Studio on its own; Start the ADF Daemon (and Reconnect) does it', async () => {
    electronStub.calls.length = 0
    electronStub.dialogResponse = 0 // "Start the ADF Daemon"
    const { handle, session, revives, kill, logFile } = boot('cli')
    expect(await handle.ready).toBe(true)
    writeFileSync(logFile, '[ADF Daemon] Version 0.8.0 (pid 1001, started by cli)\n[ADF Daemon] Received SIGBREAK — shutting down...\n')
    kill()
    await vi.waitFor(() => expect(dialogs()).toHaveLength(1))
    expect(dialogs()[0].message).toBe('The ADF daemon (pid 1001) exited (signal SIGBREAK); agents are stopped.')
    expect(dialogs()[0].detail).toMatch(/started by cli, not by Studio, so Studio does not start it again by itself/)
    expect(notices().filter((n) => n.includes('Studio is starting it again'))).toEqual([])
    // The dialog's button: the connector's revive, not a stream re-dial alone.
    await vi.waitFor(() => expect(revives).toEqual([1001]))
    await vi.waitFor(() => expect(session.reconnects).toBe(1))
    session.listener!.onConnection({ state: 'open' })
    await vi.waitFor(() => expect(notices()).toContain('Studio started the ADF daemon again (pid 1002).'))
    await handle.shutdown()
  })

  it('a failed start is shown in the exit dialog; a live pid is a lost connection, not an exit', async () => {
    electronStub.calls.length = 0
    electronStub.dialogResponse = 99
    const { handle, session, revives, kill } = boot('studio', { reviveFails: true })
    expect(await handle.ready).toBe(true)
    kill()
    await vi.waitFor(() => expect(dialogs()).toHaveLength(1))
    expect(revives).toEqual([1001])
    expect(dialogs()[0].detail).toMatch(/^Starting it again failed: The ADF daemon exited during startup \(code 1\)\./)
    expect(session.reconnects).toBe(0)
    await handle.shutdown()

    electronStub.calls.length = 0
    const live = boot('studio')
    expect(await live.handle.ready).toBe(true)
    live.session.listener!.onConnection({ state: 'reconnecting', error: 'idle timeout' })
    await new Promise((r) => setTimeout(r, 1_800))
    expect(live.handle.connection.state).toMatchObject({ state: 'disconnected' })
    expect((live.handle.connection.state as { exited?: unknown }).exited).toBeUndefined()
    expect(live.revives).toEqual([])
    await live.handle.shutdown()
  })
})

describe('local mode: the token after a dropped connection (W5-D1 pid check, every reconnect)', () => {
  it('sends no token or local proof until the listener on the port is the daemon its pid file names again', async () => {
    const seen: Array<{ path: string; auth: string | null; proof: string | null }> = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      seen.push({ path: new URL(String(url)).pathname, auth: headers.Authorization ?? null, proof: headers['X-ADF-Local-Proof'] ?? null })
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    let verdict: () => Promise<number> = async () => 1001
    let verifications = 0
    const connector = Object.assign(async () => ({
      baseUrl: BASE, logFile: null, description: 'fake',
      source: { token: () => 't', localProof: () => ({ 'X-ADF-Local-Proof': 'p' }) },
    }), { verifyListener: () => { verifications++; return verdict() } })
    const connection = new DaemonConnection(connector, { log: () => {}, warn: () => {}, error: () => {} }, fetchImpl)
    const client = await connection.client()
    connection.markConnected()
    await client.request('POST', '/identity/import')
    expect(seen.at(-1)).toEqual({ path: '/identity/import', auth: 'Bearer t', proof: 'p' })

    // Another program took the port: refused, so nothing carries the token.
    verdict = async () => { throw new Error('The program answering on the port is pid 4321, but the daemon pid file names pid 1001') }
    const verified: number[] = []
    connection.onListenerVerified((pid) => { verified.push(pid) })
    connection.markDisconnected('stream ended')
    expect(connection.tokenAllowed).toBe(false)
    await client.request('POST', '/identity/import').catch(() => {})
    expect(seen.at(-1)).toEqual({ path: '/identity/import', auth: null, proof: null })
    await vi.waitFor(() => expect(verifications).toBeGreaterThanOrEqual(1))

    // The daemon the pid file names answers again: the token goes out, and the stream is told to re-dial.
    verdict = async () => 1002
    await vi.waitFor(() => expect(verified).toEqual([1002]), { timeout: 3_000 })
    expect(connection.tokenAllowed).toBe(true)
    await client.request('POST', '/identity/import')
    expect(seen.at(-1)).toEqual({ path: '/identity/import', auth: 'Bearer t', proof: 'p' })
  })
})
