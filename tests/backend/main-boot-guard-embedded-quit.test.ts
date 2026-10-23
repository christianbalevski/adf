/**
 * A fresh launch the boot guard turns Inside Studio for one session (an older
 * daemon on the port), with no usable keychain, booted through the real
 * src/main/index.ts (Electron faked). The first question had nothing to ask
 * (Local, nothing stored); the second comes directly after the guard, before
 * the boot handover, the first-launch and remote-mode migrations and any
 * handler. Quit there runs none of them and writes nothing.
 */
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

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

// The guard decides Inside Studio for this session, as with an older daemon on the port.
vi.mock('../../src/main/backend/first-launch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/backend/first-launch')>()
  const { h } = await import('./main-boot-harness')
  return {
    ...actual,
    guardBoot: async (boot: { mode: string }) => { h.calls.push('guardBoot'); boot.mode = 'embedded'; return { skipHandover: false } },
    settleDefaultBackend: async (...args: Parameters<typeof actual.settleDefaultBackend>) => { h.calls.push('settleDefaultBackend'); return actual.settleDefaultBackend(...args) },
  }
})
vi.mock('../../src/main/backend/boot-handover', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/backend/boot-handover')>()
  const { h } = await import('./main-boot-harness')
  return { ...actual, runBootHandover: async (...args: Parameters<typeof actual.runBootHandover>) => { h.calls.push('runBootHandover'); return actual.runBootHandover(...args) } }
})

import { h } from './main-boot-harness'

h.state.userData = mkdtempSync(join(tmpdir(), 'adf-main-boot-guard-'))
process.env.ADF_USER_DATA_DIR = h.state.userData
process.env.ADF_KEYCHAIN = '0'
delete process.env.ADF_STUDIO_BACKEND
delete process.env.ADF_INSTANCE
// No usable keychain; the user answers Quit (the cancel button) at the question.
h.electron.safeStorage.isEncryptionAvailable = () => false
const shown = h.electron.dialog.showMessageBox
h.electron.dialog.showMessageBox = async (...args: unknown[]) => {
  await shown(...args)
  const opts = (args.length > 1 ? args[1] : args[0]) as { cancelId?: number }
  return { response: opts.cancelId ?? 0 }
}

it('Inside Studio after the guard: asked right after it; Quit runs no handover or migration and writes nothing', async () => {
  await import('../../src/main/index')
  const deadline = Date.now() + 5000
  while (!h.calls.includes('app.quit')) {
    if (Date.now() > deadline) throw new Error(`no quit: ${h.calls.join(' | ')}`)
    await new Promise((r) => setTimeout(r, 5))
  }
  await new Promise((r) => setTimeout(r, 50))

  const dialogs = h.calls.filter((c) => c.startsWith('dialog.'))
  expect(dialogs).toHaveLength(1)
  expect(dialogs[0]).toBe('dialog.showMessageBox(no parent: ADF Studio cannot use your system keychain)')
  expect(h.calls.indexOf('guardBoot')).toBeGreaterThan(-1)
  expect(h.calls.indexOf(dialogs[0])).toBeGreaterThan(h.calls.indexOf('guardBoot'))
  for (const never of ['runBootHandover', 'settleDefaultBackend']) expect(h.calls, never).not.toContain(never)
  // (adf:open-file:get-pending is registered at import, before app ready, in every launch.)
  expect(h.calls.slice(h.calls.indexOf('guardBoot')).some((c) => c.startsWith('ipcMain.handle('))).toBe(false)
  expect(h.calls.slice(h.calls.indexOf(dialogs[0]) + 1)).toEqual(['app.quit'])
  expect(existsSync(join(h.state.userData, 'adf-settings.json'))).toBe(false)
  expect(existsSync(join(h.state.userData, 'studio-backend.json'))).toBe(false)
  expect(readdirSync(h.state.userData).filter((n) => !n.startsWith('.'))).toEqual([])
})
