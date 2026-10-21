/**
 * The migration of an older Studio's remote mode (docs/design/multi-runtime.md
 * §7.3 to §7.5) when studio-client-settings.json cannot be written,
 * src/main/index.ts with Electron and the services stubbed: the client keys
 * are written before studio-backend.json, so studio-backend.json still says
 * remote and the next launch migrates both. This launch runs This computer.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('./main-boot-harness')).h.electron)
// A write that fails (EACCES) on every platform: a read-only mode does not stop the atomic rename over a file on POSIX.
const blockedWrites = vi.hoisted(() => new Set<string>())
vi.mock('../../src/main/utils/atomic-json', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/utils/atomic-json')>()
  const { resolve } = await import('node:path')
  return {
    ...actual,
    writeJsonAtomicAsync: async (path: string, data: unknown) => {
      if (blockedWrites.has(resolve(path))) throw Object.assign(new Error(`EACCES: permission denied, open '${path}'`), { code: 'EACCES' })
      return actual.writeJsonAtomicAsync(path, data)
    },
  }
})
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
const BACKEND = JSON.stringify({ v: 1, mode: 'remote', keepDaemonRunning: false, remote: { url: null, token: null, allowInsecureHttp: false, name: 'host-1' } })
const CLIENT = JSON.stringify({
  theme: 'dark', uiFontSystemDefaultApplied: true, uiFont: 'system',
  remoteRecentFiles: ['/srv/agents/agent-2.adf'],
  fleetGroups: { '/srv/agents': ['/srv/agents/agent-2.adf'] },
  agentWindows: { runtime: 'remote:host-1', windows: [{ agentId: AGENT_2, filePath: '/srv/agents/agent-2.adf' }] },
})
writeFileSync(join(h.state.userData, 'studio-backend.json'), BACKEND)
writeFileSync(join(h.state.userData, 'cli-remotes.json'), JSON.stringify({ v: 1, default: null, remotes: { 'host-1': { url: 'http://100.101.102.103:7385', fingerprint: 'ABCD-EFGH', deviceId: 'd1', label: 'l', pairedAt: '2026-10-18T10:00:00Z', hostName: 'host-1' } } }))
const clientPath = join(h.state.userData, 'studio-client-settings.json')
writeFileSync(clientPath, CLIENT)
// Every write of it fails.
blockedWrites.add(resolve(clientPath))
let restore = () => {}
afterAll(() => { blockedWrites.clear(); restore() })

it('the client keys cannot be written: studio-backend.json still says remote, so the next launch migrates both', async () => {
  restore = await bootMain()
  expect(readFileSync(join(h.state.userData, 'studio-backend.json'), 'utf-8')).toBe(BACKEND)
  expect(readFileSync(clientPath, 'utf-8')).toBe(CLIENT)
})
