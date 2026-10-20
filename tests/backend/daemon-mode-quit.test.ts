/**
 * Studio's quit in daemon mode (design §8.3, tracker W4-A): keepDaemonRunning
 * off asks the daemon to stop (it decides: started by Studio, no other
 * client), on only ends the session, remote never stops anything; the value
 * is read at quit. After a handover the daemon is asked to reload its
 * credential stores; Settings → Connections gets the daemon line.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('./daemon-mode-electron')).electronStub.module)

import { createFakeClientSession, createFakeDaemon } from './daemon-mode-fakes'
import { registerDaemonModeHandlers } from '../../src/main/backend/daemon-mode'
import type { ClientQuitAnswer } from '../../src/main/backend/daemon-mode/client-stream'
import type { DaemonVersionInfo } from '../../src/main/daemon/routes/meta-routes'
import { localProofPath } from '../../src/main/daemon/local-access'

const BASE = 'http://127.0.0.1:47385'
const TOKEN = 'a'.repeat(43)
const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

const versionInfo = (over: Partial<DaemonVersionInfo> = {}): DaemonVersionInfo => ({
  version: '0.8.0', clientApiVersion: 1, settingsPath: 'C:/x/adf-settings.json', dataDir: 'C:/x', runtimeId: null, pid: 4242, startedBy: 'studio',
  localProof: { available: false, problem: 'the local proof file could not be written or protected: icacls failed' }, ...over,
})

async function boot(opts: { mode?: 'local' | 'remote'; keep?: boolean | (() => boolean); reloadCredentials?: boolean; answer?: ClientQuitAnswer; pending?: unknown[]; onRemoteAccessEvent?: (payload: unknown) => void; proof?: string }) {
  const dir = mkdtempSync(join(tmpdir(), 'adf-daemon-mode-quit-'))
  dirs.push(dir)
  if (opts.proof) writeFileSync(localProofPath(dir, 47385), opts.proof)
  const daemon = createFakeDaemon(BASE)
  daemon.routes.set('GET /agents', () => [])
  daemon.routes.set('GET /approvals', () => ({ pending: opts.pending ?? [], history: [] }))
  daemon.routes.set('POST /client/reload-credentials', () => ({ runtime: { state: 'adopted' }, unlocked: [], stillLocked: [], sessions: ['chatgpt'], recovered: 0 }))
  const session = createFakeClientSession()
  const quits: boolean[] = []
  session.quit = async (stopDaemon: boolean) => {
    quits.push(stopDaemon)
    return opts.answer ?? { sessionId: 's-1', ended: true, stopping: stopDaemon, reason: stopDaemon ? 'Studio started this daemon run and no other client session is open' : 'the client asked to leave the daemon running (keepDaemonRunning on)', otherSessions: 0 }
  }
  const logs: string[] = []
  const log = { log: (m: string) => { logs.push(m) }, warn: (m: string) => { logs.push(m) }, error: (m: string) => { logs.push(m) } }
  const handle = registerDaemonModeHandlers({
    mode: opts.mode ?? 'local',
    userDataDir: dir,
    connect: Object.assign(async () => ({
      baseUrl: BASE, logFile: join(dir, 'adf-daemon.log'), description: 'the fake daemon', source: { token: () => TOKEN },
      daemon: versionInfo(), how: 'spawned' as const,
    }), { logFile: join(dir, 'adf-daemon.log') }),
    leases: { registerClient: async () => {} },
    ipcMain: { handle: () => {}, on: () => {} } as never,
    fetch: daemon.fetch,
    createSession: () => session,
    keepDaemonRunning: opts.keep,
    reloadCredentials: opts.reloadCredentials,
    onRemoteAccessEvent: opts.onRemoteAccessEvent,
    log,
  })
  expect(await handle.ready).toBe(true)
  return { handle, session, quits, logs, daemon }
}

describe('daemon-mode quit (§8.3)', () => {
  it('keepDaemonRunning off: asks the daemon to stop, and logs its decision', async () => {
    const { handle, quits, logs, session } = await boot({ keep: false })
    await handle.shutdown()
    expect(quits).toEqual([true])
    expect(session.ended).toBe(false)
    expect(logs).toContain('[Backend] Quit: client session ended; the ADF daemon is stopping: Studio started this daemon run and no other client session is open')
  })

  it('keepDaemonRunning on: ends the session only', async () => {
    const { handle, quits, logs } = await boot({ keep: true })
    await handle.shutdown()
    expect(quits).toEqual([false])
    expect(logs.some((l) => l.includes('the ADF daemon keeps running'))).toBe(true)
  })

  it('reads keepDaemonRunning at quit, not at launch', async () => {
    let keep = true
    const { handle, quits } = await boot({ keep: () => keep })
    keep = false
    await handle.shutdown()
    expect(quits).toEqual([true])
  })

  it('a daemon that keeps running for another client is reported as such', async () => {
    const { handle, logs } = await boot({ keep: false, answer: { sessionId: 's-1', ended: true, stopping: false, reason: '1 other client session(s) are still open', otherSessions: 1 } })
    await handle.shutdown()
    expect(logs).toContain('[Backend] Quit: client session ended; the ADF daemon keeps running: 1 other client session(s) are still open')
  })

  it('remote mode never asks a daemon to stop', async () => {
    const { handle, quits, session } = await boot({ mode: 'remote', keep: false })
    await handle.shutdown()
    expect(quits).toEqual([])
    expect(session.ended).toBe(true)
  })

  it('keepDaemonRunning changed in Settings: the session follows it, for the crash path', async () => {
    const { handle, daemon, session } = await boot({ keep: false })
    ;(session as { sessionId: string | null }).sessionId = 's-1'
    daemon.routes.set('PUT /client/sessions/s-1/exit-when-closed', () => ({ sessionId: 's-1', exitDaemonWhenClosed: false }))
    await handle.setKeepDaemonRunning(true)
    expect(daemon.requests.find((r) => r.method === 'PUT')).toMatchObject({ path: '/client/sessions/s-1/exit-when-closed', body: { exitDaemonWhenClosed: false } })
  })
})

describe('after a handover, and Settings → Connections', () => {
  it('asks the daemon to reload the moved credentials once connected', async () => {
    const { daemon, logs } = await boot({ keep: false, reloadCredentials: true })
    await vi.waitFor(() => expect(daemon.requests.some((r) => r.method === 'POST' && r.path === '/client/reload-credentials')).toBe(true))
    await vi.waitFor(() => expect(logs.some((l) => l.includes('reloaded the moved credentials: runtime identity adopted'))).toBe(true))
  })

  it('does not ask without a handover', async () => {
    const { daemon, handle } = await boot({ keep: false })
    await handle.ready
    expect(daemon.requests.some((r) => r.path === '/client/reload-credentials')).toBe(false)
  })

  it('status(): the daemon line with pid, version, who started it and the local proof state', async () => {
    const { handle } = await boot({ keep: false })
    expect(handle.status()).toMatchObject({
      connection: 'connected', url: BASE, pid: 4242, version: '0.8.0', startedBy: 'studio', how: 'spawned',
      localProof: { available: false, problem: expect.stringContaining('icacls') },
    })
  })

  it('status(): after `adf daemon restart` the row names the new daemon and who started it, not "started by this Studio" (DMN-14)', async () => {
    const { handle, session, daemon, logs } = await boot({ keep: false })
    expect(handle.status()).toMatchObject({ pid: 4242, startedBy: 'studio', how: 'spawned' })
    // The CLI restarted the daemon: the stream reattaches on a new epoch, and /version names another process.
    daemon.routes.set('GET /version', () => versionInfo({ pid: 5151, startedBy: 'cli' }))
    await session.listener!.onReattached?.({ epochChanged: true })
    await vi.waitFor(() => expect(handle.status()).toMatchObject({ pid: 5151, startedBy: 'cli', how: 'attached' }))
    expect(logs).toContain('[Backend] The ADF daemon is now pid 5151, version 0.8.0, started by cli (was pid 4242)')
    // The same process again (a plain reconnect): the launch's answer holds.
    daemon.routes.set('GET /version', () => versionInfo())
    await session.listener!.onReattached?.({ epochChanged: false })
    await vi.waitFor(() => expect(handle.status()).toMatchObject({ pid: 4242, startedBy: 'studio', how: 'spawned' }))
  })
})

describe('daemon mode and remote access (remote-access.md)', () => {
  it('Keep running in the quit question: this quit leaves the daemon running although keep-running is off', async () => {
    const { handle, quits, logs } = await boot({ keep: false })
    await handle.shutdown({ keepDaemonRunning: true })
    expect(quits).toEqual([false])
    expect(logs).toContain('[Backend] Quit: the ADF daemon keeps running for the computers connected to it (this quit only)')
  })

  it('client(): the management routes get the master token and the local proof; other routes no proof', async () => {
    const proof = 'p'.repeat(43)
    const { handle, daemon } = await boot({ keep: false, proof })
    daemon.routes.set('GET /remote-access', () => ({ enabled: false }))
    const client = await handle.client()
    await client.request('GET', '/remote-access', { query: { refresh: '1' } })
    const req = daemon.requests.find((r) => r.path === '/remote-access')!
    expect(req.auth).toBe(`Bearer ${TOKEN}`)
    expect(req.headers['x-adf-local-proof']).toBe(proof)
    expect(daemon.requests.find((r) => r.path === '/agents')?.headers['x-adf-local-proof']).toBeUndefined()
  })

  it('the remote_access push reaches Studio main (the host panel re-reads the status)', async () => {
    const events: unknown[] = []
    const { session } = await boot({ keep: false, onRemoteAccessEvent: (p) => events.push(p) })
    session.listener!.onFrame({ kind: 'push', topic: 'remote_access', payload: { type: 'device_added', deviceId: 'd1', label: 'agent-2 laptop' } } as never)
    expect(events).toEqual([{ type: 'device_added', deviceId: 'd1', label: 'agent-2 laptop' }])
  })
})
