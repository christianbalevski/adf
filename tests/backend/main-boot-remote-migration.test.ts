/**
 * The first launch of this version on an install an older Studio left in
 * remote mode (docs/design/multi-runtime.md §7.3 to §7.5),
 * src/main/index.ts with Electron and the services stubbed, against daemons
 * that never answer: Studio runs This computer, the connection it used joins
 * the runtime set, the files are migrated before any connector, and one
 * sentence over the main window says so. Agents autostart as on any launch
 * (§12 item 1): Studio starts no agent and holds none.
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
const AGENT_2 = '0d9e8f7a-6b5c-4d3e-9f21-0a9b8c7d6e5f'
writeFileSync(join(h.state.userData, 'studio-backend.json'), JSON.stringify({ v: 1, mode: 'remote', keepDaemonRunning: false, remote: { url: null, token: null, allowInsecureHttp: false, name: 'host-1' } }))
// cli-remotes.json next to Studio's settings file (remotesEnv): what `adf pair` and Studio's Add write.
writeFileSync(join(h.state.userData, 'cli-remotes.json'), JSON.stringify({ v: 1, default: null, remotes: { 'host-1': { url: 'http://100.101.102.103:7385', fingerprint: 'ABCD-EFGH', deviceId: 'd1', label: 'l', pairedAt: '2026-10-18T10:00:00Z', hostName: 'host-1' } } }))
writeFileSync(join(h.state.userData, 'studio-client-settings.json'), JSON.stringify({
  theme: 'dark', uiFontSystemDefaultApplied: true, uiFont: 'system',
  remoteRecentFiles: ['/srv/agents/agent-2.adf'],
  agentWindows: { runtime: 'remote:host-1', windows: [{ agentId: AGENT_2, filePath: '/srv/agents/agent-2.adf' }] },
}))
let restore = () => {}
afterAll(() => restore())

const readJson = (name: string) => JSON.parse(readFileSync(join(h.state.userData, name), 'utf-8')) as Record<string, unknown>

it('remote mode becomes This computer with that connection in the set; windows and recents move to it; one notice', async () => {
  restore = await bootMain()
  expect(h.calls).not.toContain('load ipc/index')
  expect(readJson('studio-backend.json')).toEqual({ v: 1, mode: 'local', keepDaemonRunning: false, remote: { url: null, token: null, allowInsecureHttp: false }, runtimeOrder: ['remote:host-1'] })
  expect(readJson('studio-client-settings.json')).toMatchObject({
    runtimeRecentFiles: { 'remote:host-1': ['/srv/agents/agent-2.adf'] },
    agentWindows: { runtime: 'local', windows: [{ agentId: AGENT_2, filePath: '/srv/agents/agent-2.adf', runtimeId: 'remote:host-1', fingerprint: 'ABCD-EFGH' }] },
  })
  expect(readJson('studio-client-settings.json')).not.toHaveProperty('remoteRecentFiles')
  // Nothing before the window; then one sentence over it.
  expect(h.calls.filter((c) => c.startsWith('dialog.'))).toEqual([])
  await fireReadyToShow()
  expect(h.calls.filter((c) => c.startsWith('dialog.'))).toEqual(['dialog.showMessageBox(window: host-1 is now listed alongside This computer.)'])
})
