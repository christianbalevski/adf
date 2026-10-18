/**
 * Studio's embedded boot (src/main/index.ts with studio-backend.json saying
 * `mode: embedded`; no file means Local daemon since 2026-10-16),
 * Electron and the services stubbed: what boot does and in which order.
 * Characterization written before the embedded IPC layer became a lazy
 * import; the lazy import must leave it unchanged.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('./main-boot-harness')).h.electron)
vi.mock('../../src/main/ipc/index', async () => {
  const { h } = await import('./main-boot-harness')
  h.calls.push('load ipc/index')
  return {
    registerAllIpcHandlers: (hooks: object) => { h.calls.push(`registerAllIpcHandlers(${Object.keys(hooks).sort().join(',')})`) },
    cleanupAllProcesses: async () => {},
    fastSessionEndCleanup: async () => {},
    getCurrentWorkspace: () => null,
    readAppSetting: () => undefined,
    writeAppSetting: () => {},
    // W4-A: the backend switch's view of the embedded backend (resume after a switch, the switch dialog).
    hostActions: {},
  }
})
vi.mock('../../src/main/ipc/orbital-cache', async () => {
  const { h } = await import('./main-boot-harness')
  return { registerOrbitalCacheHandlers: () => { h.calls.push('registerOrbitalCacheHandlers') } }
})
vi.mock('../../src/main/backend/edit-recovery', async () => {
  const { h } = await import('./main-boot-harness')
  return { registerEditRecoveryHandlers: () => { h.calls.push('registerEditRecoveryHandlers') } }
})
vi.mock('../../src/main/utils/main-log-file', () => ({ installMainLogFile: () => null }))
vi.mock('../../src/main/utils/stall-monitor', () => ({ startStallMonitor: () => null, stopStallMonitor: () => {} }))
vi.mock('../../src/main/utils/scratch-dir', () => ({ purgeStaleProcessDirs: () => {} }))
vi.mock('../../src/main/services/app-updater.service', async () => {
  const { h } = await import('./main-boot-harness')
  return { initAppUpdater: () => { h.calls.push('initAppUpdater') } }
})
vi.mock('../../src/main/services/spellcheck-dictionaries.service', async () => {
  const { h } = await import('./main-boot-harness')
  return { initSpellcheckDictionaries: () => { h.calls.push('initSpellcheckDictionaries') } }
})
vi.mock('../../src/main/runtime/sandbox-host', () => ({ shutdownSandboxHosts: () => {} }))

import { bootMain, h } from './main-boot-harness'

h.state.userData = mkdtempSync(join(tmpdir(), 'adf-main-boot-'))
process.env.ADF_USER_DATA_DIR = h.state.userData
delete process.env.ADF_STUDIO_BACKEND
delete process.env.ADF_INSTANCE
writeFileSync(join(h.state.userData, 'studio-backend.json'), JSON.stringify({ v: 1, mode: 'embedded' }))
let restore = () => {}
afterAll(() => restore())

it('embedded: the same boot, in the same order (characterization)', async () => {
  restore = await bootMain()
  expect(h.calls.filter((c) => c !== 'load ipc/index')).toEqual([
    'protocol.registerSchemesAsPrivileged',
    'app.setAppUserModelId(com.adf.app)',
    'crashReporter.start',
    'ipcMain.handle(adf:open-file:get-pending)',
    'registerAllIpcHandlers(openFile,showMainWindow)',
    'ipcMain.handle(adf:backend:settings-get)',
    'ipcMain.handle(adf:backend:settings-set)',
    // W4-B: Settings → Backend's remote check and restart; the picker channels answer "daemon mode only".
    'ipcMain.handle(adf:backend:remote-check)',
    'ipcMain.handle(adf:backend:restart-studio)',
    'ipcMain.handle(adf:remote:picker-respond)',
    'ipcMain.handle(adf:remote:fs-browse)',
    'ipcMain.handle(adf:remote:fs-mkdir)',
    // remote-access.md §9.1: registered in every mode; the host channels answer "unavailable" here, discovery and pairing work.
    'ipcMain.handle(adf:remote-access:get)',
    'ipcMain.handle(adf:remote-access:set)',
    'ipcMain.handle(adf:remote-access:device-add)',
    'ipcMain.handle(adf:remote-access:device-remove)',
    'ipcMain.handle(adf:remote-access:pairing-open)',
    'ipcMain.handle(adf:remote-access:pairing-close)',
    'ipcMain.handle(adf:remote-access:tailscale-serve)',
    'ipcMain.handle(adf:network:status)',
    'ipcMain.handle(adf:network:notices)',
    'ipcMain.handle(adf:network:notice-dismiss)',
    'ipcMain.handle(adf:network:allow)',
    'ipcMain.handle(adf:network:forget)',
    'ipcMain.handle(adf:remote-discovery:start)',
    'ipcMain.handle(adf:remote-discovery:stop)',
    'ipcMain.handle(adf:remote-pair:start)',
    'ipcMain.handle(adf:remote-pair:submit-code)',
    'ipcMain.handle(adf:remote-pair:cancel)',
    'ipcMain.handle(adf:connection:list)',
    'ipcMain.handle(adf:connection:use)',
    'ipcMain.handle(adf:connection:add)',
    'ipcMain.handle(adf:connection:remove)',
    'registerOrbitalCacheHandlers',
    // W3-F (919b9a7c): the recovery channels, local in both modes.
    'registerEditRecoveryHandlers',
    'ipcMain.handle(adf:app:get-fullscreen)',
    'ipcMain.handle(adf:app:set-fullscreen)',
    'protocol.handle(adf-file)',
    'initSpellcheckDictionaries',
    'new BrowserWindow',
    'session.onHeadersReceived',
    'window.loadFile',
    'initAppUpdater',
  ])
  // The embedded IPC layer is loaded once, before its handlers register.
  expect(h.calls.filter((c) => c === 'load ipc/index')).toHaveLength(1)
  expect(h.calls.indexOf('load ipc/index')).toBeLessThan(h.calls.indexOf('registerAllIpcHandlers(openFile,showMainWindow)'))
})
