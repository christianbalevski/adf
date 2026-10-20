/**
 * A local-only install (docs/design/multi-runtime.md §9.3, M11): a launch of
 * this version, src/main/index.ts with Electron and the services stubbed,
 * against a daemon that never answers, leaves studio-backend.json and
 * studio-client-settings.json byte for byte as the previous version wrote
 * them, and shows no dialog.
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

import { bootMain, fireReadyToShow, h } from './main-boot-harness'

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

it('a local-only install: no file of its own is rewritten, no dialog (M11)', async () => {
  restore = await bootMain()
  await fireReadyToShow()
  // Writes are async: give any that would have started time to land.
  await new Promise((r) => setTimeout(r, 200))
  expect(readFileSync(join(h.state.userData, 'studio-backend.json'), 'utf-8')).toBe(BACKEND)
  expect(readFileSync(join(h.state.userData, 'studio-client-settings.json'), 'utf-8')).toBe(CLIENT)
  expect(h.calls.filter((c) => c.startsWith('dialog.'))).toEqual([])
})
