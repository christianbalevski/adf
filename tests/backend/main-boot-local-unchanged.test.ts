/**
 * A local-only install (docs/design/multi-runtime.md §9.3, M11): a launch and
 * a quit of this version, src/main/index.ts with Electron and the services
 * stubbed, connected to a fake daemon on this computer, leave
 * studio-backend.json and studio-client-settings.json byte for byte as the
 * previous version wrote them, and show no dialog.
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

// This computer's daemon, faked: a connection, a route table and a client session; never the real 127.0.0.1:7385.
const fake = vi.hoisted(() => ({ base: 'http://127.0.0.1:47391', quits: [] as boolean[] }))
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
  // Remote access off: no device is connected, so the quit asks nothing.
  daemon.routes.set('GET /remote-access', () => ({ enabled: false, devices: [] }))
  // The saved agent window is not checked yet: it is carried to the next launch as it was.
  daemon.routes.set('GET /files/agent/config', () => ({ status: 503, body: { code: 'busy' } }))
  const session = createFakeClientSession()
  session.quit = async (stopDaemon: boolean) => {
    fake.quits.push(stopDaemon)
    return { sessionId: 's-1', ended: true, stopping: stopDaemon, reason: 'Studio started this daemon run and no other client session is open', otherSessions: 0 }
  }
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

import { bootMain, fireReadyToShow, h, quitMain } from './main-boot-harness'

h.state.userData = mkdtempSync(join(tmpdir(), 'adf-main-boot-'))
process.env.ADF_USER_DATA_DIR = h.state.userData
process.env.ADF_KEYCHAIN = '0'
delete process.env.ADF_STUDIO_BACKEND
delete process.env.ADF_INSTANCE
// As the previous version wrote them, on a local-only install with an agent window saved.
const BACKEND = JSON.stringify({ v: 1, mode: 'local', keepDaemonRunning: false, remote: { url: null, token: null, allowInsecureHttp: false } })
const CLIENT = JSON.stringify({
  theme: 'dark', uiFont: 'system', uiFontSystemDefaultApplied: true, recentFiles: ['C:/agents/agent-1.adf'],
  agentWindows: { runtime: 'local', windows: [{ agentId: '6f1c2a4e-1b3d-4c5e-8f70-9a1b2c3d4e5f', filePath: 'C:/agents/agent-1.adf', bounds: { x: 10, y: 20, width: 900, height: 700 } }] },
})
writeFileSync(join(h.state.userData, 'studio-backend.json'), BACKEND)
writeFileSync(join(h.state.userData, 'studio-client-settings.json'), CLIENT)
let restore = () => {}
afterAll(() => restore())

it('a local-only install: no file of its own is rewritten across a launch and a quit, no dialog (M11)', async () => {
  restore = await bootMain()
  await fireReadyToShow()
  // Writes are async: give any that would have started time to land.
  await new Promise((r) => setTimeout(r, 200))
  expect(readFileSync(join(h.state.userData, 'studio-backend.json'), 'utf-8')).toBe(BACKEND)
  expect(readFileSync(join(h.state.userData, 'studio-client-settings.json'), 'utf-8')).toBe(CLIENT)
  expect(h.calls.filter((c) => c.startsWith('dialog.'))).toEqual([])

  await quitMain()
  // The quit ended the session on the connected daemon (keepDaemonRunning off: it is asked to stop).
  expect(fake.quits).toEqual([true])
  await new Promise((r) => setTimeout(r, 200))
  expect(readFileSync(join(h.state.userData, 'studio-backend.json'), 'utf-8')).toBe(BACKEND)
  expect(readFileSync(join(h.state.userData, 'studio-client-settings.json'), 'utf-8')).toBe(CLIENT)
  expect(h.calls.filter((c) => c.startsWith('dialog.'))).toEqual([])
})
