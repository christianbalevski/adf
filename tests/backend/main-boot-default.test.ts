/**
 * Studio's first boot of the release that made Local daemon the default
 * (W5-I), src/main/index.ts with Electron and the services stubbed, against
 * a daemon that never answers, on a 0.7.x-shaped user data folder (an
 * adf-settings.json, no studio-backend.json): it boots daemon mode, saves
 * the default, runs the handover and shows no dialog before the window. The
 * notice waits for the daemon connection (never made here) and stays
 * pending until shown.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
// Never the real keychain (this settings file holds no identity, so the handover does not open one anyway).
process.env.ADF_KEYCHAIN = '0'
delete process.env.ADF_STUDIO_BACKEND
delete process.env.ADF_INSTANCE
writeFileSync(join(h.state.userData, 'adf-settings.json'), JSON.stringify({ theme: 'dark', recentFiles: ['C:/agents/agent-1.adf'], trackedDirectories: ['C:/agents'] }))
let restore = () => {}
afterAll(() => restore())

const readJson = (name: string) => JSON.parse(readFileSync(join(h.state.userData, name), 'utf-8')) as Record<string, unknown>

it('0.7.x upgrade: daemon mode, the default saved, no dialog before the window, one notice over it', async () => {
  restore = await bootMain()
  expect(h.calls).not.toContain('load ipc/index')
  expect(h.calls).not.toContain('new PodmanService')
  expect(h.calls).toContain('new BrowserWindow')
  // Nothing asked before the window is ready.
  expect(h.calls.filter((c) => c.startsWith('dialog.'))).toEqual([])
  expect(readJson('studio-backend.json')).toMatchObject({ v: 1, mode: 'local' })
  expect(readJson('studio-client-settings.json')).toMatchObject({ theme: 'dark' })
  expect(readJson('adf-settings.json')).toEqual({ trackedDirectories: ['C:/agents'] })
  expect(readJson('studio-default-switch.pending.json')).toMatchObject({ record: { moved: ['Client settings'] } })

  // The window is ready, but the daemon has not connected: no notice yet, and it is not recorded as shown.
  await fireReadyToShow()
  expect(h.calls.filter((c) => c.startsWith('dialog.'))).toEqual([])
  expect(existsSync(join(h.state.userData, 'studio-default-switch.json'))).toBe(false)
  expect(existsSync(join(h.state.userData, 'studio-switch-resume.json'))).toBe(false)
})
