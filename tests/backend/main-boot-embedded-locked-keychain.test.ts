/** A locked keychain on an already-embedded launch: Continue is asked only once. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
vi.mock('../../src/main/utils/main-log-file', () => ({ installMainLogFile: () => null, flushMainLogSync: () => {} }))
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
process.env.ADF_KEYCHAIN = '0'
delete process.env.ADF_STUDIO_BACKEND
delete process.env.ADF_INSTANCE
writeFileSync(join(h.state.userData, 'studio-backend.json'), JSON.stringify({ v: 1, mode: 'embedded' }))
let restore = () => {}
afterAll(() => { restore(); rmSync(h.state.userData, { recursive: true, force: true }) })

const settingsPath = join(h.state.userData, 'adf-settings.json')
const settingsText = JSON.stringify({ secretStoragePolicy: 'keyring', ownerMnemonic: 'safe:Y2lwaGVy' })
writeFileSync(settingsPath, settingsText)
h.electron.safeStorage.isEncryptionAvailable = () => false
const shown = h.electron.dialog.showMessageBox
h.electron.dialog.showMessageBox = async (...args: unknown[]) => {
  await shown(...args)
  const options = (args.length > 1 ? args[1] : args[0]) as { buttons: string[] }
  const response = options.buttons.indexOf('Continue Without Keychain')
  if (response < 0) throw new Error(`Unexpected boot question: ${options.buttons.join(', ')}`)
  return { response }
}

it('embedded launch asks once and continues without changing the locked secrets', async () => {
  restore = await bootMain()
  expect(h.calls.filter((c) => c.startsWith('dialog.showMessageBox('))).toHaveLength(1)
  expect(h.calls).toContain('registerAllIpcHandlers(openFile,showMainWindow)')
  expect(h.calls).toContain('initAppUpdater')
  expect(h.calls).not.toContain('app.quit')
  expect(readFileSync(settingsPath, 'utf-8')).toBe(settingsText)
})
