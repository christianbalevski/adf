/**
 * The Open Recent and Mesh view keys of each runtime other than This
 * computer (`runtimeRecentFiles`, `runtimeFleet`, docs/design/multi-runtime.md
 * §7.4), src/main/index.ts with Electron and the services stubbed: at launch
 * the keys of a connection no longer saved go, and those of one saved again
 * under another name (same fingerprint) move to it; while Studio runs, a
 * connection forgotten (`adf remotes forget`) loses its keys, so a computer
 * saved later under that name does not get them.
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


import { bootMain, h } from './main-boot-harness'

h.state.userData = mkdtempSync(join(tmpdir(), 'adf-main-boot-'))
process.env.ADF_USER_DATA_DIR = h.state.userData
process.env.ADF_KEYCHAIN = '0'
delete process.env.ADF_STUDIO_BACKEND
delete process.env.ADF_INSTANCE
const AGENT_2 = '0d9e8f7a-6b5c-4d3e-9f21-0a9b8c7d6e5f'
const HOST_1 = { url: 'http://100.101.102.103:7385', fingerprint: 'ABCD-EFGH', deviceId: 'd1', label: 'l', pairedAt: '2026-10-18T10:00:00Z', hostName: 'host-1' }
const remotesPath = join(h.state.userData, 'cli-remotes.json')
writeFileSync(join(h.state.userData, 'studio-backend.json'), JSON.stringify({ v: 1, mode: 'local', keepDaemonRunning: false, remote: { url: null, token: null, allowInsecureHttp: false }, runtimeOrder: ['remote:host-1'] }))
writeFileSync(remotesPath, JSON.stringify({ v: 1, default: null, remotes: { 'host-1': HOST_1 } }))
const clientPath = join(h.state.userData, 'studio-client-settings.json')
writeFileSync(clientPath, JSON.stringify({
  theme: 'dark', uiFontSystemDefaultApplied: true, uiFont: 'system',
  // host-1 was saved as old-name when these were written; agent-3-pc was forgotten while Studio was closed.
  runtimeRecentFiles: { 'remote:old-name': ['/srv/agents/agent-2.adf'], 'remote:agent-3-pc': ['/home/agents/agent-3.adf'] },
  runtimeFleet: { 'remote:agent-3-pc': { fleetGroups: { '/home/agents': ['/home/agents/agent-3.adf'] } } },
  agentWindows: { runtime: 'local', windows: [{ agentId: AGENT_2, filePath: '/srv/agents/agent-2.adf', runtimeId: 'remote:old-name', fingerprint: 'ABCD-EFGH' }] },
}))
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

it('at launch: a connection no longer saved loses its keys, a renamed one keeps them under its new name; then adf remotes forget', { timeout: 20_000 }, async () => {
  restore = await bootMain()
  await until(() => !('remote:agent-3-pc' in ((client().runtimeRecentFiles ?? {}) as object)), 'the keys of agent-3-pc go at launch')
  expect(client()).toMatchObject({
    runtimeRecentFiles: { 'remote:host-1': ['/srv/agents/agent-2.adf'] },
    runtimeFleet: {},
    agentWindows: { runtime: 'local', windows: [{ agentId: AGENT_2, filePath: '/srv/agents/agent-2.adf', runtimeId: 'remote:host-1', fingerprint: 'ABCD-EFGH' }] },
  })
  expect(client().runtimeRecentFiles).toEqual({ 'remote:host-1': ['/srv/agents/agent-2.adf'] })

  // While Studio runs, adf remotes forget host-1.
  writeFileSync(remotesPath, JSON.stringify({ v: 1, default: null, remotes: {} }))
  await until(() => Object.keys((client().runtimeRecentFiles ?? {}) as object).length === 0, 'the keys of host-1 go once it is forgotten')
})
