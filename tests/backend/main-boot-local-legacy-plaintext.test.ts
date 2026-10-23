/**
 * A Local install whose settings file still holds Studio's own secrets as
 * plain text from an earlier keyring-less start, booted through the real
 * src/main/index.ts (Electron and the daemon faked; ADF_USER_DATA_DIR is the
 * settings folder Studio and its Local daemon share). The secret-storage
 * question comes first, before the boot handover, the first-launch and
 * remote-mode migrations and the daemon connection; nothing changes before
 * the answer. The harness answers the first button, Encrypt with Keychain:
 * every secret is encrypted in place, the owner and runtime identity and
 * every other key stay, and Settings → Identity shows Studio's own copies.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it, vi } from 'vitest'
import { IPC } from '../../src/shared/constants/ipc-channels'

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
vi.mock('../../src/main/utils/main-log-file', () => ({ installMainLogFile: () => null, flushMainLogSync: () => {} }))
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

import { bootMain, fireReadyToShow, h, invokeMain, quitMain } from './main-boot-harness'

h.state.userData = mkdtempSync(join(tmpdir(), 'adf-main-boot-'))
process.env.ADF_USER_DATA_DIR = h.state.userData
process.env.ADF_KEYCHAIN = '0'
delete process.env.ADF_STUDIO_BACKEND
delete process.env.ADF_INSTANCE
writeFileSync(join(h.state.userData, 'studio-backend.json'), JSON.stringify({ v: 1, mode: 'local', keepDaemonRunning: false, remote: { url: null, token: null, allowInsecureHttp: false } }))
const PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank yellow'
const LEGACY = {
  ownerDid: 'did:key:zLegacyOwner',
  runtimeDid: 'did:key:zLegacyRuntime',
  runtimeEncPublicKey: 'cHVibGlj',
  ownerMnemonic: PHRASE,
  runtimePrivateKey: 'cnVudGltZS1zaWduaW5n',
  runtimeEncPrivateKey: 'cnVudGltZS1lbmM=',
  ownerAlias: 'me',
}
const settingsPath = join(h.state.userData, 'adf-settings.json')
writeFileSync(settingsPath, JSON.stringify(LEGACY, null, 2))
let restore = () => {}
afterAll(() => restore())

it('Local mode: plain-text secrets are asked about first, then encrypted in place with the identity kept', async () => {
  restore = await bootMain()
  await fireReadyToShow()
  await new Promise((r) => setTimeout(r, 200))

  const dialogs = h.calls.filter((c) => c.startsWith('dialog.'))
  // (The harness window's loadURL returns no promise, so the boot window is not its parent here; the real run is.)
  expect(dialogs[0]).toMatch(/^dialog\.showMessageBox\((window|no parent): 3 ADF Studio secrets are stored unencrypted\)$/)
  // Asked before any backend handler, store or the daemon connection.
  const asked = h.calls.indexOf(dialogs[0])
  for (const later of ['ipcMain.handle(adf:backend:settings-get)', 'ipcMain.handle(adf:studio:secret-storage:get)']) {
    expect(h.calls.indexOf(later), later).toBeGreaterThan(asked)
  }

  const after = JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>
  expect(after.secretStoragePolicy).toBe('keyring')
  // The harness safeStorage "encrypts" to the bytes themselves: each value is the same secret, now `safe:`.
  for (const key of ['ownerMnemonic', 'runtimePrivateKey', 'runtimeEncPrivateKey'] as const) {
    expect(after[key]).toBe('safe:' + Buffer.from(LEGACY[key]).toString('base64'))
  }
  for (const key of ['ownerDid', 'runtimeDid', 'runtimeEncPublicKey', 'ownerAlias'] as const) expect(after[key]).toBe(LEGACY[key])

  // Settings → Identity → Secret storage in Local mode: Studio's own copies, not hidden behind the daemon.
  expect(await invokeMain(IPC.STUDIO_SECRET_STORAGE_GET)).toEqual({ policy: 'keyring', keyringAvailable: true, plaintextSecrets: 0, writesBlocked: false, storedSecrets: 3, scope: 'studio-copies' })

  await quitMain()
})
