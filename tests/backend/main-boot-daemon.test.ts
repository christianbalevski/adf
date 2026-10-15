/**
 * Studio's boot in daemon mode (`local`), Electron and the services stubbed,
 * against a daemon that never answers: the embedded IPC layer
 * (ipc/index.ts) is never loaded, so no PodmanService is constructed and
 * none of its module-load side effects run (the uvx manifest repair writes a
 * file the daemon owns); Studio main writes no daemon-owned file.
 */
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
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
  h.calls.push('load podman.service')
  return { PodmanService: class { constructor() { h.calls.push('new PodmanService') } } }
})
vi.mock('../../src/main/services/uvx-package-resolver', async () => {
  const { h } = await import('./main-boot-harness')
  h.calls.push('load uvx-package-resolver')
  return {}
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

import { bootMain, h } from './main-boot-harness'

h.state.userData = mkdtempSync(join(tmpdir(), 'adf-main-boot-'))
process.env.ADF_USER_DATA_DIR = h.state.userData
delete process.env.ADF_STUDIO_BACKEND
delete process.env.ADF_INSTANCE
writeFileSync(join(h.state.userData, 'studio-backend.json'), JSON.stringify({ v: 1, mode: 'local' }))
let restore = () => {}
afterAll(() => restore())

it('daemon mode: never loads the embedded IPC layer, constructs no PodmanService, writes no daemon-owned file', async () => {
  restore = await bootMain()
  expect(h.calls).not.toContain('load ipc/index')
  expect(h.calls).not.toContain('load podman.service')
  expect(h.calls).not.toContain('new PodmanService')
  expect(h.calls).not.toContain('load uvx-package-resolver')
  expect(h.calls).toContain('protocol.handle(adf-file)')
  expect(h.calls).toContain('new BrowserWindow')
  // Only Studio's own files: studio-backend.json, studio-client-settings.json (and the test setup's lease dir).
  const files = readdirSync(h.state.userData).filter((f) => !/^studio-(backend|client-settings)\.json$/.test(f) && f !== 'agent-leases')
  expect(files).toEqual([])
  expect(existsSync(join(h.state.userData, 'adf-settings.json'))).toBe(false)
})
