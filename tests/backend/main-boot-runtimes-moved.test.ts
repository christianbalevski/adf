/**
 * A saved connection renamed while Studio runs (`adf pair --as lab`, then
 * `adf remotes forget host-1`: same fingerprint, another name) is a move,
 * not a Remove (docs/design/multi-runtime.md §17 item 10): src/main/index.ts
 * with Electron and the services stubbed sends the windows RUNTIMES_MOVED
 * before the runtime set without the old id, and the per-runtime keys
 * (`runtimeRecentFiles`, `runtimeFleet`) are re-keyed to the new id, not dropped.
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
import { IPC } from '../../src/shared/constants/ipc-channels'
import type { ConnectionsView } from '../../src/shared/types/connection.types'

h.state.userData = mkdtempSync(join(tmpdir(), 'adf-main-boot-'))
process.env.ADF_USER_DATA_DIR = h.state.userData
process.env.ADF_KEYCHAIN = '0'
delete process.env.ADF_STUDIO_BACKEND
delete process.env.ADF_INSTANCE
const HOST_1 = { url: 'http://100.101.102.103:7385', fingerprint: 'ABCD-EFGH', deviceId: 'd1', label: 'l', pairedAt: '2026-10-18T10:00:00Z', hostName: 'host-1' }
const remotesPath = join(h.state.userData, 'cli-remotes.json')
writeFileSync(join(h.state.userData, 'studio-backend.json'), JSON.stringify({ v: 1, mode: 'local', keepDaemonRunning: false, remote: { url: null, token: null, allowInsecureHttp: false }, runtimeOrder: ['remote:host-1'] }))
writeFileSync(remotesPath, JSON.stringify({ v: 1, default: null, remotes: { 'host-1': HOST_1 } }))
const clientPath = join(h.state.userData, 'studio-client-settings.json')
const RECENT = ['/srv/agents/agent-1.adf']
const AGENT_1 = '6f1c2a4e-1b3d-4c5e-8f70-9a1b2c3d4e5f'
const FLEET = { fleetGroups: { '/srv/agents': ['/srv/agents/agent-1.adf'] } }
writeFileSync(clientPath, JSON.stringify({
  theme: 'dark', uiFontSystemDefaultApplied: true, uiFont: 'system',
  runtimeRecentFiles: { 'remote:host-1': RECENT },
  runtimeFleet: { 'remote:host-1': FLEET },
  runtimeFingerprints: { 'remote:host-1': 'ABCD-EFGH' },
  // R3B-1: an agent window of host-1 still to reopen (host-1 never connects here).
  agentWindows: { runtime: 'local', windows: [{ agentId: AGENT_1, filePath: '/srv/agents/agent-1.adf', runtimeId: 'remote:host-1', fingerprint: 'ABCD-EFGH' }] },
}))
let restore = () => {}
afterAll(() => restore())

const client = () => JSON.parse(readFileSync(clientPath, 'utf-8')) as Record<string, unknown>
async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what}: ${JSON.stringify(h.state.sent.map((s) => s.channel))} ${readFileSync(clientPath, 'utf-8')}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}
const ids = (view: unknown) => ((view as ConnectionsView).runtimes ?? []).map((r) => r.id)

it('a rename sends the moves, then the runtime set, and re-keys the keys of the old id', { timeout: 20_000 }, async () => {
  restore = await bootMain()
  expect(h.state.windows.length).toBeGreaterThan(0)
  await until(() => client().runtimeRecentFiles !== undefined, 'the client settings are read')
  expect(client().runtimeRecentFiles).toEqual({ 'remote:host-1': RECENT })
  const from = h.state.sent.length

  // While Studio runs, the same computer is saved as lab and host-1 is forgotten.
  writeFileSync(remotesPath, JSON.stringify({ v: 1, default: null, remotes: { lab: { ...HOST_1, deviceId: 'd2' } } }))
  await until(() => h.state.sent.slice(from).some((s) => s.channel === IPC.CONNECTION_CHANGED && ids(s.payload).includes('remote:lab')), 'the runtime set lists lab')

  const pushes = h.state.sent.slice(from).filter((s) => s.channel === IPC.RUNTIMES_MOVED || s.channel === IPC.CONNECTION_CHANGED)
  // Every window: moves first, then the set; none of the set's pushes comes before the moves.
  const moved = pushes.findIndex((s) => s.channel === IPC.RUNTIMES_MOVED)
  const set = pushes.findIndex((s) => s.channel === IPC.CONNECTION_CHANGED && !ids(s.payload).includes('remote:host-1'))
  expect(moved).toBeGreaterThanOrEqual(0)
  expect(pushes[moved].payload).toEqual({ moves: { 'remote:host-1': 'remote:lab' }, replaced: [] })
  expect(pushes.slice(0, moved).filter((s) => s.channel === IPC.CONNECTION_CHANGED)).toEqual([])
  expect(set).toBeGreaterThan(moved)
  expect(ids(pushes[set].payload)).toContain('remote:lab')

  // The keys follow the move under its new id; nothing is dropped.
  await until(() => 'remote:lab' in ((client().runtimeRecentFiles ?? {}) as object), 'the keys move to lab')
  expect(client()).toMatchObject({
    runtimeRecentFiles: { 'remote:lab': RECENT },
    runtimeFleet: { 'remote:lab': FLEET },
  })
  expect(Object.keys(client().runtimeRecentFiles as object)).toEqual(['remote:lab'])
  expect(Object.keys(client().runtimeFleet as object)).toEqual(['remote:lab'])

  // R3B-1: the saved agent window follows too, to reopen once lab connects.
  await until(() => JSON.stringify(client().agentWindows).includes('remote:lab'), 'the agent window moves to lab')
  expect(client().agentWindows).toEqual({ runtime: 'local', windows: [{ agentId: AGENT_1, filePath: '/srv/agents/agent-1.adf', runtimeId: 'remote:lab', fingerprint: 'ABCD-EFGH' }] })
})
