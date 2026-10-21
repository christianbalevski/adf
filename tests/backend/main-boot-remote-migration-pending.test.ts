/**
 * The migration of an older Studio's remote mode (docs/design/multi-runtime.md
 * §7.3 to §7.5) when studio-client-settings.json cannot be written once, at
 * the launch's migration, and then can: src/main/index.ts with Electron and
 * the services stubbed, connected to a fake daemon on this computer.
 *
 * R2B-1: a later write of studio-backend.json in that launch (here the
 * runtime order, as a connection is added) keeps it in remote mode, so the
 * next launch still migrates it and the notice stays true.
 * R2B-2: the client keys are migrated in memory: the client file gets them
 * (marked) on its next write, and the quit keeps the remote's agent window.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('./main-boot-harness')).h.electron)
// The next write of a path here fails (EACCES), on every platform; the one after it works.
const failOnce = vi.hoisted(() => new Set<string>())
vi.mock('../../src/main/utils/atomic-json', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/utils/atomic-json')>()
  const { resolve } = await import('node:path')
  return {
    ...actual,
    writeJsonAtomicAsync: async (path: string, data: unknown) => {
      if (failOnce.delete(resolve(path))) throw Object.assign(new Error(`EACCES: permission denied, open '${path}'`), { code: 'EACCES' })
      return actual.writeJsonAtomicAsync(path, data)
    },
  }
})
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
const fake = vi.hoisted(() => ({ base: 'http://127.0.0.1:47393' }))
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

import { resolveBootBackend } from '../../src/main/backend/backend-config'
import { migrateRemoteModeInstall } from '../../src/main/backend/runtime-migration'
import { bootMain, fireReadyToShow, h, quitMain } from './main-boot-harness'

h.state.userData = mkdtempSync(join(tmpdir(), 'adf-main-boot-'))
process.env.ADF_USER_DATA_DIR = h.state.userData
process.env.ADF_KEYCHAIN = '0'
delete process.env.ADF_STUDIO_BACKEND
delete process.env.ADF_INSTANCE
const AGENT_2 = '0d9e8f7a-6b5c-4d3e-9f21-0a9b8c7d6e5f'
const HOST_1 = { url: 'http://100.101.102.103:7385', fingerprint: 'ABCD-EFGH', deviceId: 'd1', label: 'l', pairedAt: '2026-10-18T10:00:00Z', hostName: 'host-1' }
const HOST_2 = { url: 'https://host-2.example.com', fingerprint: 'WXYZ-2345', deviceId: 'd2', label: 'l', pairedAt: '2026-10-19T10:00:00Z', hostName: 'host-2' }
const BACKEND = JSON.stringify({ v: 1, mode: 'remote', keepDaemonRunning: false, remote: { url: null, token: null, allowInsecureHttp: false, name: 'host-1' } })
const backendPath = join(h.state.userData, 'studio-backend.json')
const remotesPath = join(h.state.userData, 'cli-remotes.json')
const clientPath = join(h.state.userData, 'studio-client-settings.json')
writeFileSync(backendPath, BACKEND)
writeFileSync(remotesPath, JSON.stringify({ v: 1, default: null, remotes: { 'host-1': HOST_1 } }))
writeFileSync(clientPath, JSON.stringify({
  theme: 'dark', uiFontSystemDefaultApplied: true, uiFont: 'system',
  remoteRecentFiles: ['/srv/agents/agent-2.adf'],
  fleetGroups: { '/srv/agents': ['/srv/agents/agent-2.adf'] },
  agentWindows: { runtime: 'remote:host-1', windows: [{ agentId: AGENT_2, filePath: '/srv/agents/agent-2.adf' }] },
}))
failOnce.add(resolve(clientPath))
let restore = () => {}
afterAll(() => { failOnce.clear(); restore() })

const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what}: ${readFileSync(backendPath, 'utf-8')} | ${readFileSync(clientPath, 'utf-8')}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

const MIGRATED_WINDOW = { agentId: AGENT_2, filePath: '/srv/agents/agent-2.adf', runtimeId: 'remote:host-1', fingerprint: 'ABCD-EFGH' }

it('a later write of studio-backend.json keeps remote mode; the client keys land on the next client write; the quit keeps the window; the next launch migrates', { timeout: 30_000 }, async () => {
  restore = await bootMain()
  await fireReadyToShow()
  expect(readFileSync(backendPath, 'utf-8')).toBe(BACKEND)
  // The client keys, migrated in memory, are written once the file can be (marked: the next launch moves no fleet key).
  await until(() => readJson(clientPath).remoteModeMigrated === true, 'the client file gets the migrated keys')
  expect(readJson(clientPath)).toMatchObject({
    runtimeRecentFiles: { 'remote:host-1': ['/srv/agents/agent-2.adf'] },
    runtimeFleet: { 'remote:host-1': { fleetGroups: { '/srv/agents': ['/srv/agents/agent-2.adf'] } } },
    agentWindows: { runtime: 'local', windows: [MIGRATED_WINDOW] },
  })
  expect(readJson(clientPath)).not.toHaveProperty('fleetGroups')

  // adf pair host-2 while Studio runs: the runtime order is saved.
  writeFileSync(remotesPath, JSON.stringify({ v: 1, default: null, remotes: { 'host-1': HOST_1, 'host-2': HOST_2 } }))
  await until(() => JSON.stringify(readJson(backendPath).runtimeOrder ?? []).includes('remote:host-2'), 'the runtime order is saved')
  expect(readJson(backendPath)).toMatchObject({ mode: 'remote', remote: { name: 'host-1' }, runtimeOrder: ['remote:host-1', 'remote:host-2'] })

  await quitMain()
  await new Promise((r) => setTimeout(r, 200))
  expect((readJson(clientPath).agentWindows as { windows: unknown[] }).windows).toEqual([MIGRATED_WINDOW])
  expect(readJson(backendPath)).toMatchObject({ mode: 'remote', remote: { name: 'host-1' } })

  // The next launch migrates studio-backend.json, and moves nothing again.
  const next = resolveBootBackend(backendPath, {}, { log: () => {}, warn: () => {} })
  const saved = { 'host-1': HOST_1, 'host-2': HOST_2 }
  expect(await migrateRemoteModeInstall(next, h.state.userData, saved, { log: () => {}, warn: () => {} })).toMatchObject({ written: true })
  expect(readJson(backendPath)).toMatchObject({ mode: 'local', runtimeOrder: ['remote:host-1', 'remote:host-2'] })
  expect(readJson(backendPath).remote).not.toHaveProperty('name')
  expect(readJson(clientPath)).not.toHaveProperty('remoteModeMigrated')
  expect(readJson(clientPath)).toMatchObject({ runtimeFleet: { 'remote:host-1': { fleetGroups: { '/srv/agents': ['/srv/agents/agent-2.adf'] } } }, agentWindows: { runtime: 'local', windows: [MIGRATED_WINDOW] } })
})
