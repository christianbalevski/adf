/**
 * W5-I: the first launch on the Local daemon default finds an older ADF
 * daemon on the port (a 0.7.x `adf` from npm: no GET /version). Studio
 * moves nothing, saves no default, runs Embedded for this session without
 * the boot autostart (that daemon runs those agents and holds no lease),
 * and says what to do over the main window once it is ready.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('./main-boot-harness')).h.electron)
vi.mock('../../src/main/ipc/index', async () => {
  const { h } = await import('./main-boot-harness')
  h.calls.push('load ipc/index')
  return {
    registerAllIpcHandlers: (hooks: Record<string, unknown>) => {
      h.calls.push(`registerAllIpcHandlers(${Object.keys(hooks).sort().join(',')})`)
      if (typeof hooks.skipBootAutostart === 'string') h.calls.push(`skipBootAutostart: ${hooks.skipBootAutostart}`)
    },
    cleanupAllProcesses: async () => {},
    fastSessionEndCleanup: async () => {},
    getCurrentWorkspace: () => null,
    readAppSetting: () => undefined,
    writeAppSetting: () => {},
    hostActions: {},
  }
})
vi.mock('../../src/main/backend/daemon-process', async (importOriginal) => {
  // The first-launch probe of the daemon port: never the real 127.0.0.1:7385.
  const actual = await importOriginal<typeof import('../../src/main/backend/daemon-process')>()
  class Controller extends actual.DaemonProcessController {
    async detect() {
      return { state: 'unidentified' as const, status: 404, message: 'A daemon is running on port 7385 but has no GET /version; it is an older ADF build.' }
    }
  }
  return { ...actual, DaemonProcessController: Controller }
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

import { bootMain, fireReadyToShow, h } from './main-boot-harness'

h.state.userData = mkdtempSync(join(tmpdir(), 'adf-main-boot-'))
process.env.ADF_USER_DATA_DIR = h.state.userData
process.env.ADF_KEYCHAIN = '0'
delete process.env.ADF_STUDIO_BACKEND
delete process.env.ADF_INSTANCE
const SETTINGS = JSON.stringify({ theme: 'dark', trackedDirectories: ['C:/agents'] })
writeFileSync(join(h.state.userData, 'adf-settings.json'), SETTINGS)
let restore = () => {}
afterAll(() => restore())

it('an older daemon on the port: Embedded for this session, nothing moved or saved, no boot autostart, the dialog over the window', async () => {
  restore = await bootMain()
  expect(h.calls).toContain('load ipc/index')
  expect(h.calls).toContain('registerAllIpcHandlers(openFile,showMainWindow,skipBootAutostart)')
  expect(h.calls.some((c) => c.startsWith('skipBootAutostart: an older ADF daemon'))).toBe(true)
  expect(existsSync(join(h.state.userData, 'studio-backend.json'))).toBe(false)
  expect(existsSync(join(h.state.userData, 'studio-handover.json'))).toBe(false)
  expect(existsSync(join(h.state.userData, 'studio-client-settings.json'))).toBe(false)
  expect(readFileSync(join(h.state.userData, 'adf-settings.json'), 'utf-8')).toBe(SETTINGS)
  expect(h.calls.filter((c) => c.startsWith('dialog.'))).toEqual([])
  await fireReadyToShow()
  expect(h.calls.filter((c) => c.startsWith('dialog.'))).toEqual([
    'dialog.showMessageBox(window: An ADF daemon that Studio cannot identify is running on port 7385 (A daemon is running on port 7385 but has no GET /version; it is an older ADF build.). If it is an older ADF daemon started by the npm CLI, it uses the same settings.)',
  ])
})
