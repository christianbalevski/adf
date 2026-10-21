/**
 * R3B-2 (docs/design/multi-runtime.md §20 item 2): a saved connection's
 * per-runtime keys written during a session (a Mesh view save through
 * SETTINGS_SET, Open Recent) record its fingerprint as they are written:
 * src/main/index.ts with Electron and the services stubbed, no daemon.
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
vi.mock('../../src/main/backend/daemon-mode/connectors', () => ({
  localDaemonConnector: () => Object.assign(() => new Promise(() => {}), { logFile: null }),
  remoteDaemonConnector: () => Object.assign(() => new Promise(() => {}), { logFile: null }),
}))

vi.mock('../../src/main/backend/daemon-process', async (importOriginal) => {
  // The first-launch probe of the daemon port: never the real 127.0.0.1:7385.
  const actual = await importOriginal<typeof import('../../src/main/backend/daemon-process')>()
  class Controller extends actual.DaemonProcessController {
    async detect() { return { state: 'absent' as const } }
  }
  return { ...actual, DaemonProcessController: Controller }
})


import { bootMain, h, invokeMain } from './main-boot-harness'
import { IPC } from '../../src/shared/constants/ipc-channels'
import { recordRuntimeRecentFile } from '../../src/main/menu'

h.state.userData = mkdtempSync(join(tmpdir(), 'adf-main-boot-'))
process.env.ADF_USER_DATA_DIR = h.state.userData
process.env.ADF_KEYCHAIN = '0'
delete process.env.ADF_STUDIO_BACKEND
delete process.env.ADF_INSTANCE
const HOST_1 = { url: 'http://100.101.102.103:7385', fingerprint: 'ABCD-EFGH', deviceId: 'd1', label: 'l', pairedAt: '2026-10-18T10:00:00Z', hostName: 'host-1' }
const LAB = { ...HOST_1, url: 'https://lab.example:7385', fingerprint: 'WXYZ-2345', deviceId: 'd2', hostName: 'lab' }
writeFileSync(join(h.state.userData, 'studio-backend.json'), JSON.stringify({ v: 1, mode: 'local', keepDaemonRunning: false, remote: { url: null, token: null, allowInsecureHttp: false }, runtimeOrder: ['remote:host-1', 'remote:lab'] }))
writeFileSync(join(h.state.userData, 'cli-remotes.json'), JSON.stringify({ v: 1, default: null, remotes: { 'host-1': HOST_1, lab: LAB } }))
const clientPath = join(h.state.userData, 'studio-client-settings.json')
writeFileSync(clientPath, JSON.stringify({ theme: 'dark', uiFontSystemDefaultApplied: true, uiFont: 'system' }))
let restore = () => {}
afterAll(() => restore())

const client = () => JSON.parse(readFileSync(clientPath, 'utf-8')) as Record<string, unknown>
async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what}: ${readFileSync(clientPath, 'utf-8')}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

it('a Mesh view save and an Open Recent entry of a saved connection record its fingerprint as they are written', { timeout: 20_000 }, async () => {
  restore = await bootMain()
  // The launch's record step had nothing to record.
  await new Promise((r) => setTimeout(r, 200))
  expect(client().runtimeFingerprints).toBeUndefined()

  expect(await invokeMain(IPC.SETTINGS_SET, { runtimeFleet: { 'remote:host-1': { fleetGroups: { '/srv/agents': ['/srv/agents/agent-1.adf'] } } } })).toEqual({ success: true })
  await until(() => client().runtimeFingerprints !== undefined, 'the fleet save records host-1')
  expect(client().runtimeFingerprints).toEqual({ 'remote:host-1': 'ABCD-EFGH' })

  recordRuntimeRecentFile('remote:lab', '/home/agents/agent-2.adf')
  await until(() => 'remote:lab' in ((client().runtimeFingerprints ?? {}) as object), 'Open Recent records lab')
  expect(client().runtimeFingerprints).toEqual({ 'remote:host-1': 'ABCD-EFGH', 'remote:lab': 'WXYZ-2345' })
})
