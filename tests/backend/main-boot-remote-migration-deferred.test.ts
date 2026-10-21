/**
 * An older Studio's remote mode (docs/design/multi-runtime.md §7.3 to §7.5)
 * at a launch that cannot read cli-remotes.json: src/main/index.ts with
 * Electron and the services stubbed, connected to a fake daemon on this
 * computer.
 *
 * R2B-2: studio-backend.json waits for a launch that can read the saved
 * connections, but the client keys are migrated now (they need only
 * `remote.name`), so This computer never shows or writes the remote's fleet
 * keys as its own, and the quit keeps the remote's agent window. Settings →
 * Connections says the migration is pending.
 * R2B-7: the notice that the saved connections could not be read goes once
 * the file is fixed. R2B-8: a malformed entry is named there, until fixed.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('./main-boot-harness')).h.electron)
vi.mock('../../src/main/ipc/index', async () => {
  const { h } = await import('./main-boot-harness')
  h.calls.push('load ipc/index')
  return {}
})
vi.mock('../../src/main/services/podman.service', async () => {
  const { h } = await import('./main-boot-harness')
  return { PodmanService: class { constructor() { h.calls.push('new PodmanService') } } }
})
vi.mock('../../src/main/ipc/orbital-cache', () => ({ registerOrbitalCacheHandlers: () => {} }))
vi.mock('../../src/main/backend/edit-recovery', () => ({ registerEditRecoveryHandlers: () => {} }))
vi.mock('../../src/main/utils/main-log-file', () => ({ installMainLogFile: () => null }))
vi.mock('../../src/main/utils/stall-monitor', () => ({ startStallMonitor: () => null, stopStallMonitor: () => {} }))
vi.mock('../../src/main/utils/scratch-dir', () => ({ purgeStaleProcessDirs: () => {} }))
vi.mock('../../src/main/services/app-updater.service', async () => {
  const { h } = await import('./main-boot-harness')
  return { initAppUpdater: () => { h.calls.push('initAppUpdater') } }
})
vi.mock('../../src/main/services/spellcheck-dictionaries.service', () => ({ initSpellcheckDictionaries: () => {} }))
vi.mock('../../src/main/runtime/sandbox-host', () => ({ shutdownSandboxHosts: () => {} }))

// This computer's daemon, faked; never the real 127.0.0.1:7385. The remotes never connect.
const fake = vi.hoisted(() => ({ base: 'http://127.0.0.1:47394' }))
vi.mock('../../src/main/backend/daemon-mode/connectors', () => ({
  localDaemonConnector: () => Object.assign(async () => ({
    baseUrl: fake.base, logFile: null, description: 'the fake daemon', source: { token: () => 'a'.repeat(43) },
    daemon: { version: '9.9.9', clientApiVersion: 1, settingsPath: 'C:/x/adf-settings.json', dataDir: 'C:/x', runtimeId: null, pid: 4242, startedBy: 'studio', localProof: { available: true, problem: null } },
    how: 'spawned' as const,
  }), { logFile: null }),
  remoteDaemonConnector: () => Object.assign(() => new Promise(() => {}), { logFile: null }),
}))
vi.mock('../../src/main/backend/daemon-mode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/backend/daemon-mode')>()
  const { createFakeClientSession, createFakeDaemon } = await import('./daemon-mode-fakes')
  const daemon = createFakeDaemon(fake.base)
  daemon.routes.set('GET /agents', () => [])
  daemon.routes.set('GET /approvals', () => ({ pending: [], history: [] }))
  daemon.routes.set('GET /remote-access', () => ({ enabled: false, devices: [] }))
  const session = createFakeClientSession()
  session.quit = async (stopDaemon: boolean) => ({ sessionId: 's-1', ended: true, stopping: stopDaemon, reason: 'test', otherSessions: 0 })
  return {
    ...actual,
    registerDaemonModeHandlers: (deps: Parameters<typeof actual.registerDaemonModeHandlers>[0]) =>
      actual.registerDaemonModeHandlers({ ...deps, fetch: daemon.fetch, createSession: () => session, leases: { registerClient: async () => {} } }),
  }
})
vi.mock('../../src/main/backend/daemon-process', async (importOriginal) => {
  // The first-launch probe of the daemon port: never the real 127.0.0.1:7385.
  const actual = await importOriginal<typeof import('../../src/main/backend/daemon-process')>()
  class Controller extends actual.DaemonProcessController {
    async detect() { return { state: 'absent' as const } }
  }
  return { ...actual, DaemonProcessController: Controller }
})

import { IPC } from '../../src/shared/constants/ipc-channels'
import { bootMain, fireReadyToShow, h, invokeMain, quitMain } from './main-boot-harness'

h.state.userData = mkdtempSync(join(tmpdir(), 'adf-main-boot-'))
process.env.ADF_USER_DATA_DIR = h.state.userData
process.env.ADF_KEYCHAIN = '0'
delete process.env.ADF_STUDIO_BACKEND
delete process.env.ADF_INSTANCE
const AGENT_2 = '0d9e8f7a-6b5c-4d3e-9f21-0a9b8c7d6e5f'
const HOST_1 = { url: 'http://100.101.102.103:7385', fingerprint: 'ABCD-EFGH', deviceId: 'd1', label: 'l', pairedAt: '2026-10-18T10:00:00Z', hostName: 'host-1' }
const BACKEND = JSON.stringify({ v: 1, mode: 'remote', keepDaemonRunning: false, remote: { url: null, token: null, allowInsecureHttp: false, name: 'host-1' } })
const backendPath = join(h.state.userData, 'studio-backend.json')
const remotesPath = join(h.state.userData, 'cli-remotes.json')
const clientPath = join(h.state.userData, 'studio-client-settings.json')
writeFileSync(backendPath, BACKEND)
writeFileSync(remotesPath, '{"v": 1, "remotes": {"host-1": ')
writeFileSync(clientPath, JSON.stringify({
  theme: 'dark', uiFontSystemDefaultApplied: true, uiFont: 'system',
  remoteRecentFiles: ['/srv/agents/agent-2.adf'],
  fleetGroups: { '/srv/agents': ['/srv/agents/agent-2.adf'] },
  agentWindows: { runtime: 'remote:host-1', windows: [{ agentId: AGENT_2, filePath: '/srv/agents/agent-2.adf' }] },
}))
let restore = () => {}
afterAll(() => restore())

const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
const notices = async (): Promise<string[]> => ((await invokeMain(IPC.BACKEND_SETTINGS_GET)) as { active: { notices: string[] } }).active.notices
async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what}: ${JSON.stringify(await notices())}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

it('the client keys migrate now, studio-backend.json at a later launch; the notices follow the file', { timeout: 30_000 }, async () => {
  restore = await bootMain()
  await fireReadyToShow()
  expect(readFileSync(backendPath, 'utf-8')).toBe(BACKEND)
  expect(readJson(clientPath)).toMatchObject({
    remoteModeMigrated: true,
    runtimeRecentFiles: { 'remote:host-1': ['/srv/agents/agent-2.adf'] },
    runtimeFleet: { 'remote:host-1': { fleetGroups: { '/srv/agents': ['/srv/agents/agent-2.adf'] } } },
    agentWindows: { runtime: 'local', windows: [{ agentId: AGENT_2, filePath: '/srv/agents/agent-2.adf', runtimeId: 'remote:host-1' }] },
  })
  expect(readJson(clientPath)).not.toHaveProperty('fleetGroups')
  const pending = (await notices()).filter((n) => /still says remote/.test(n))
  expect(pending).toHaveLength(1)
  expect((await notices()).some((n) => n.startsWith('Saved connections could not be read'))).toBe(true)

  // Fixed while Studio runs: that notice goes; the migration still waits for the next launch.
  writeFileSync(remotesPath, JSON.stringify({ v: 1, default: null, remotes: { 'host-1': HOST_1 } }))
  await until(async () => !(await notices()).some((n) => n.startsWith('Saved connections could not be read')), 'the unreadable notice goes')
  expect((await notices()).filter((n) => /still says remote/.test(n))).toEqual(pending)

  // One malformed entry is named, until it is fixed.
  writeFileSync(remotesPath, JSON.stringify({ v: 1, default: null, remotes: { 'host-1': HOST_1, 'agent-3': { url: 'http://100.64.0.3:7385' } } }))
  await until(async () => (await notices()).some((n) => n.includes('"agent-3"')), 'the malformed entry is named')
  writeFileSync(remotesPath, JSON.stringify({ v: 1, default: null, remotes: { 'host-1': HOST_1 } }))
  await until(async () => !(await notices()).some((n) => n.includes('"agent-3"')), 'the malformed notice goes')

  await quitMain()
  await new Promise((r) => setTimeout(r, 200))
  expect((readJson(clientPath).agentWindows as { windows: unknown[] }).windows).toEqual([{ agentId: AGENT_2, filePath: '/srv/agents/agent-2.adf', runtimeId: 'remote:host-1' }])
  // Saved since (the runtime order, once host-1 could be read), and still in remote mode.
  expect(readJson(backendPath)).toMatchObject({ mode: 'remote', remote: { name: 'host-1' } })
})
