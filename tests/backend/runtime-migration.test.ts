/**
 * The upgrade of an older Studio's remote mode (docs/design/multi-runtime.md
 * §7.3 to §7.5, runtime-migration.ts): `mode: remote` becomes `mode: local`
 * with that connection in the runtime set and first in `runtimeOrder`; its
 * client keys and saved agent windows move to its runtime id; a file of a
 * local-only install, or of Inside Studio, is never touched.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('./daemon-mode-electron')).electronStub.module)
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

import { resolveBootBackend } from '../../src/main/backend/backend-config'
import { AGENT_WINDOWS_KEY, AgentWindows, parseSavedAgentWindows, type AgentWindowHandle, type SavedAgentWindow } from '../../src/main/backend/agent-windows'
import { CLIENT_SETTINGS_FILE } from '../../src/main/backend/daemon-mode/settings'
import {
  migrateRemoteMode, migrateRemoteModeClientFile, migrateRemoteModeClientKeys, migrateRemoteModeInstall, migrationNotice, relinkRuntimeKeys, relinkSavedAgentWindows,
  remoteModeRuntime, renamedRuntimes, savedConnectionChanges, savedConnectionNames,
} from '../../src/main/backend/runtime-migration'
import type { SavedRemote } from '../../src/main/cli/remotes'

const quiet = { log: () => {}, warn: () => {} }
const AGENT_1 = '6f1c2a4e-1b3d-4c5e-8f70-9a1b2c3d4e5f'
const AGENT_2 = '0d9e8f7a-6b5c-4d3e-9f21-0a9b8c7d6e5f'
const HOST_1: SavedRemote = { url: 'http://100.101.102.103:7385', fingerprint: 'ABCD-EFGH', deviceId: 'd1', label: 'l', pairedAt: '2026-10-18T10:00:00Z', hostName: 'host-1' }
const HOST_2: SavedRemote = { url: 'https://host-2.example.com', fingerprint: 'WXYZ-2345', deviceId: 'd2', label: 'l', pairedAt: '2026-10-19T10:00:00Z', hostName: 'host-2' }
const BOUNDS = { x: 10, y: 20, width: 900, height: 700 }

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function userData(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'adf-runtime-migration-'))
  dirs.push(dir)
  for (const [name, value] of Object.entries(files)) writeFileSync(join(dir, name), typeof value === 'string' ? value : JSON.stringify(value))
  return dir
}

const read = (dir: string, name: string) => JSON.parse(readFileSync(join(dir, name), 'utf-8')) as Record<string, unknown>

describe('studio-backend.json (§7.3)', () => {
  it('mode: remote with a saved connection: local, remote.name gone, that connection first in runtimeOrder; one notice', async () => {
    const dir = userData({ 'studio-backend.json': { v: 1, mode: 'remote', keepDaemonRunning: true, remote: { url: null, token: null, allowInsecureHttp: false, name: 'host-1' } } })
    const boot = resolveBootBackend(join(dir, 'studio-backend.json'), {}, quiet)
    expect(boot.mode).toBe('local')
    const migration = await migrateRemoteMode(boot, { 'host-2': HOST_2, 'host-1': HOST_1 }, quiet)
    expect(migration).toEqual({ runtime: { id: 'remote:host-1', name: 'host-1', fingerprint: 'ABCD-EFGH', inSet: true }, written: true, notice: 'host-1 is in Settings → Connections.' })
    // Fixed order (§12 item 5): the connection in use first, then the others in the order paired.
    expect(read(dir, 'studio-backend.json')).toEqual({ v: 1, mode: 'local', keepDaemonRunning: true, remote: { url: null, token: null, allowInsecureHttp: false }, runtimeOrder: ['remote:host-1', 'remote:host-2'] })
    expect(boot.config).toEqual(read(dir, 'studio-backend.json'))
    // The next launch reads an ordinary local file: nothing left to migrate.
    const next = resolveBootBackend(join(dir, 'studio-backend.json'), {}, quiet)
    expect(await migrateRemoteMode(next, { 'host-1': HOST_1 }, quiet)).toBeNull()
  })

  it('mode: remote on the remote slot: local; the slot is the runtime `remote`, named after its address', async () => {
    const dir = userData({ 'studio-backend.json': { v: 1, mode: 'remote', remote: { url: 'https://adf.example.com', token: 'safe:x', allowInsecureHttp: false } } })
    const boot = resolveBootBackend(join(dir, 'studio-backend.json'), {}, quiet)
    const migration = await migrateRemoteMode(boot, {}, quiet)
    expect(migration?.runtime).toEqual({ id: 'remote', name: 'adf.example.com', fingerprint: null, inSet: true })
    expect(read(dir, 'studio-backend.json')).toMatchObject({ mode: 'local', remote: { url: 'https://adf.example.com', token: 'safe:x' }, runtimeOrder: ['remote'] })
  })

  it('a saved connection no longer saved (adf remotes forget): local, This computer only, and the notice says so', async () => {
    const dir = userData({ 'studio-backend.json': { v: 1, mode: 'remote', remote: { url: null, token: null, allowInsecureHttp: false, name: 'gone' } } })
    const boot = resolveBootBackend(join(dir, 'studio-backend.json'), {}, quiet)
    const migration = await migrateRemoteMode(boot, {}, quiet)
    expect(migration?.notice).toBe('gone is no longer saved; add it again in Settings → Connections.')
    expect(read(dir, 'studio-backend.json')).toMatchObject({ mode: 'local', runtimeOrder: [] })
    expect(read(dir, 'studio-backend.json').remote).not.toHaveProperty('name')
  })

  it('a file that cannot be rewritten: this launch runs local anyway, Settings → Connections says so, the next launch retries', async () => {
    const dir = userData({ 'studio-backend.json': { v: 1, mode: 'remote', remote: { url: null, token: null, allowInsecureHttp: false, name: 'host-1' } } })
    const path = join(dir, 'studio-backend.json')
    const before = readFileSync(path)
    const boot = { ...resolveBootBackend(path, {}, quiet), writeBlocked: `${path} could not be read (EACCES).` }
    const migration = await migrateRemoteMode(boot, { 'host-1': HOST_1 }, quiet)
    expect(migration).toMatchObject({ written: false, notice: 'host-1 is in Settings → Connections.' })
    expect(boot.config.mode).toBe('local')
    expect(boot.notices?.join(' ')).toMatch(/still says remote/)
    expect(readFileSync(path).equals(before)).toBe(true)
  })

  it('local and Inside Studio files are never migrated, and keep their bytes (M11)', async () => {
    for (const mode of ['local', 'embedded']) {
      const raw = JSON.stringify({ v: 1, mode })
      const dir = userData({ 'studio-backend.json': raw })
      const boot = resolveBootBackend(join(dir, 'studio-backend.json'), {}, quiet)
      expect(await migrateRemoteMode(boot, { 'host-1': HOST_1 }, quiet)).toBeNull()
      expect(readFileSync(join(dir, 'studio-backend.json'), 'utf-8')).toBe(raw)
    }
  })

  it('the paired slot whose computer is also a saved connection: that saved connection is the runtime', () => {
    const config = { remote: { url: 'https://adf.example.com', token: 'safe:x', allowInsecureHttp: false, paired: { fingerprint: 'ABCD-EFGH', name: 'office', deviceId: 'd', label: 'l' } } }
    expect(remoteModeRuntime(config, { 'host-1': HOST_1 })).toEqual({ id: 'remote:host-1', name: 'host-1', fingerprint: 'ABCD-EFGH', inSet: true })
    expect(remoteModeRuntime({ remote: { url: null, token: null, allowInsecureHttp: false } }, {})).toBeNull()
    expect(migrationNotice(null)).toBeNull()
  })
})

describe('studio-client-settings.json (§7.4, §7.5)', () => {
  const legacy = { remote: { url: null, token: null, allowInsecureHttp: false, name: 'host-1' } }
  const runtime = { id: 'remote:host-1', name: 'host-1', fingerprint: 'ABCD-EFGH', inSet: true }

  it('remote mode\'s recent files, fleet keys and agent windows move to the runtime of that connection', async () => {
    const dir = userData({
      [CLIENT_SETTINGS_FILE]: {
        theme: 'dark',
        recentFiles: ['C:/agents/agent-1.adf'],
        remoteRecentFiles: ['/srv/agents/agent-2.adf'],
        fleetGroups: { '/srv/agents': ['/srv/agents/agent-2.adf'] },
        fleetStewards: { '/srv/agents': 'did:key:z6Mk-steward' },
        [AGENT_WINDOWS_KEY]: { runtime: 'remote:host-1', windows: [{ agentId: AGENT_2, filePath: '/srv/agents/agent-2.adf', bounds: BOUNDS }] },
      },
    })
    expect(await migrateRemoteModeClientFile(dir, legacy, runtime, { 'host-1': HOST_1 }, quiet)).toHaveLength(3)
    expect(read(dir, CLIENT_SETTINGS_FILE)).toEqual({
      theme: 'dark',
      // This computer's own Open Recent is unchanged.
      recentFiles: ['C:/agents/agent-1.adf'],
      runtimeRecentFiles: { 'remote:host-1': ['/srv/agents/agent-2.adf'] },
      runtimeFleet: { 'remote:host-1': { fleetGroups: { '/srv/agents': ['/srv/agents/agent-2.adf'] }, fleetStewards: { '/srv/agents': 'did:key:z6Mk-steward' } } },
      [AGENT_WINDOWS_KEY]: { runtime: 'local', windows: [{ agentId: AGENT_2, filePath: '/srv/agents/agent-2.adf', bounds: BOUNDS, runtimeId: 'remote:host-1', fingerprint: 'ABCD-EFGH' }] },
    })
  })

  it('agent windows saved for the slot by its URL become `remote`; a list for another URL or an unknown name is dropped', () => {
    const slot = { remote: { url: 'https://adf.example.com', token: 'safe:x', allowInsecureHttp: false } }
    const slotRuntime = { id: 'remote', name: 'adf.example.com', fingerprint: null, inSet: true }
    const byUrl: Record<string, unknown> = { [AGENT_WINDOWS_KEY]: { runtime: 'remote:https://adf.example.com', windows: [{ agentId: AGENT_2, filePath: '/srv/a.adf' }] } }
    migrateRemoteModeClientKeys(byUrl, slot, slotRuntime, {})
    expect(byUrl[AGENT_WINDOWS_KEY]).toEqual({ runtime: 'local', windows: [{ agentId: AGENT_2, filePath: '/srv/a.adf', runtimeId: 'remote' }] })
    const other: Record<string, unknown> = { [AGENT_WINDOWS_KEY]: { runtime: 'remote:https://elsewhere.example.com', windows: [{ agentId: AGENT_2, filePath: '/srv/a.adf' }] } }
    migrateRemoteModeClientKeys(other, slot, slotRuntime, {})
    expect(other[AGENT_WINDOWS_KEY]).toEqual({ runtime: 'local', windows: [] })
  })

  it('the migrated list reopens its windows on that runtime once it connects (§7.5)', async () => {
    const data: Record<string, unknown> = { [AGENT_WINDOWS_KEY]: { runtime: 'remote:host-1', windows: [{ agentId: AGENT_2, filePath: '/srv/agents/agent-2.adf', bounds: BOUNDS }] } }
    migrateRemoteModeClientKeys(data, legacy, runtime, { 'host-1': HOST_1 })
    const settings = new Map<string, unknown>([[AGENT_WINDOWS_KEY, data[AGENT_WINDOWS_KEY]]])
    const created: Array<{ filePath: string; agentId: string | null; runtimeId?: string; restored: boolean }> = []
    let id = 10
    const windows = new AgentWindows({
      create: (request) => {
        created.push(request)
        const handle: AgentWindowHandle = { id: id++, focus: () => {}, isMinimized: () => false, restore: () => {}, isDestroyed: () => false, getBounds: () => BOUNDS, close: () => {} }
        return handle
      },
      current: () => null,
      samePath: (a, b) => a === b,
      settings: { get: (k) => settings.get(k), set: (k, v) => { settings.set(k, v) } },
      runtime: () => 'local',
      check: async (entry: SavedAgentWindow) => (entry.runtimeId === 'remote:host-1' ? 'open' : 'gone'),
      log: quiet,
    })
    // This computer's restore at the main window's first show: nothing of its own to reopen.
    expect(await windows.restore('local')).toEqual({ opened: 0, skipped: 0 })
    expect(await windows.restore('remote:host-1')).toEqual({ opened: 1, skipped: 0 })
    expect(created).toEqual([expect.objectContaining({ filePath: '/srv/agents/agent-2.adf', agentId: AGENT_2, runtimeId: 'remote:host-1', restored: true, bounds: BOUNDS })])
    expect(parseSavedAgentWindows(settings.get(AGENT_WINDOWS_KEY), 'local')).toEqual([{ agentId: AGENT_2, filePath: '/srv/agents/agent-2.adf', bounds: BOUNDS, runtimeId: 'remote:host-1', fingerprint: 'ABCD-EFGH' }])
  })

  it('a client file without remote-mode keys is not written', async () => {
    const raw = JSON.stringify({ theme: 'dark', [AGENT_WINDOWS_KEY]: { runtime: 'local', windows: [{ agentId: AGENT_1, filePath: 'C:/agents/agent-1.adf' }] } })
    const dir = userData({ [CLIENT_SETTINGS_FILE]: raw })
    expect(await migrateRemoteModeClientFile(dir, legacy, runtime, { 'host-1': HOST_1 }, quiet)).toEqual([])
    expect(readFileSync(join(dir, CLIENT_SETTINGS_FILE), 'utf-8')).toBe(raw)
  })
})

describe('agent windows of a renamed connection (§7.5)', () => {
  it('an entry whose runtime is not in the set moves to the saved connection with its fingerprint; nothing else changes', () => {
    const list = { runtime: 'local', windows: [
      { agentId: AGENT_1, filePath: 'C:/agents/agent-1.adf' },
      { agentId: AGENT_2, filePath: '/srv/agents/agent-2.adf', runtimeId: 'remote:old-name', fingerprint: 'ABCD-EFGH' },
      { agentId: AGENT_2, filePath: '/srv/b.adf', runtimeId: 'remote:gone', fingerprint: 'NONE-2345' },
    ] }
    expect(relinkSavedAgentWindows(list, { 'host-1': HOST_1 }, false)).toEqual({ runtime: 'local', windows: [
      { agentId: AGENT_1, filePath: 'C:/agents/agent-1.adf' },
      { agentId: AGENT_2, filePath: '/srv/agents/agent-2.adf', runtimeId: 'remote:host-1', fingerprint: 'ABCD-EFGH' },
      { agentId: AGENT_2, filePath: '/srv/b.adf', runtimeId: 'remote:gone', fingerprint: 'NONE-2345' },
    ] })
    // A list of This computer only, or of runtimes in the set: null, never rewritten.
    expect(relinkSavedAgentWindows({ runtime: 'local', windows: [list.windows[0]] }, { 'host-1': HOST_1 }, false)).toBeNull()
    expect(relinkSavedAgentWindows({ runtime: 'local', windows: [{ ...list.windows[1], runtimeId: 'remote:host-1' }] }, { 'host-1': HOST_1 }, false)).toBeNull()
    expect(relinkSavedAgentWindows(undefined, {}, false)).toBeNull()
  })
})

describe('a migration that runs again (studio-backend.json still says remote)', () => {
  const legacy = { remote: { url: null, token: null, allowInsecureHttp: false, name: 'host-1' } }
  const runtime = { id: 'remote:host-1', name: 'host-1', fingerprint: 'ABCD-EFGH', inSet: true }
  const saved = { 'host-1': HOST_1 }

  it('leaves the fleet keys This computer wrote since the first run where they are', () => {
    const data: Record<string, unknown> = { fleetGroups: { '/srv/agents': ['/srv/agents/agent-2.adf'] }, remoteRecentFiles: ['/srv/agents/agent-2.adf'] }
    migrateRemoteModeClientKeys(data, legacy, runtime, saved)
    const fleet = structuredClone(data.runtimeFleet)
    // That launch ran This computer: its fleet map wrote its own groups and stewards.
    data.fleetGroups = { 'C:/agents': ['C:/agents/agent-1.adf'] }
    data.fleetStewards = { 'C:/agents': 'did:key:z6Mk-local' }
    migrateRemoteModeClientKeys(data, legacy, runtime, saved)
    expect(data.fleetGroups).toEqual({ 'C:/agents': ['C:/agents/agent-1.adf'] })
    expect(data.fleetStewards).toEqual({ 'C:/agents': 'did:key:z6Mk-local' })
    expect(data.runtimeFleet).toEqual(fleet)
  })

  it('a runtimeFleet entry already there: the plain keys stay This computer\'s', () => {
    const entry = { fleetGroups: { '/srv/agents': ['/srv/agents/agent-2.adf'] } }
    const data: Record<string, unknown> = { fleetStewards: { 'C:/agents': 'did:key:z6Mk-local' }, runtimeFleet: { 'remote:host-1': entry } }
    migrateRemoteModeClientKeys(data, legacy, runtime, saved)
    expect(data.fleetStewards).toEqual({ 'C:/agents': 'did:key:z6Mk-local' })
    expect(data.runtimeFleet).toEqual({ 'remote:host-1': entry })
  })

  it("a client file migrated before (marked): its fleet keys are This computer's and stay; remote mode's recent files still move (R2B-6)", () => {
    const data: Record<string, unknown> = { remoteModeMigrated: true, fleetGroups: { 'C:/agents': ['C:/agents/agent-1.adf'] }, remoteRecentFiles: ['/srv/x.adf'] }
    expect(migrateRemoteModeClientKeys(data, legacy, runtime, saved)).toEqual(['remoteRecentFiles → runtimeRecentFiles'])
    expect(data).toEqual({ remoteModeMigrated: true, fleetGroups: { 'C:/agents': ['C:/agents/agent-1.adf'] }, runtimeRecentFiles: { 'remote:host-1': ['/srv/x.adf'] } })
    expect(migrateRemoteModeClientKeys(data, legacy, runtime, saved)).toEqual([])
  })
})

describe('write order: the client keys first, then studio-backend.json', () => {
  const REMOTE = { v: 1, mode: 'remote', keepDaemonRunning: false, remote: { url: null, token: null, allowInsecureHttp: false, name: 'host-1' } }
  const CLIENT = {
    theme: 'dark',
    remoteRecentFiles: ['/srv/agents/agent-2.adf'],
    fleetGroups: { '/srv/agents': ['/srv/agents/agent-2.adf'] },
    [AGENT_WINDOWS_KEY]: { runtime: 'remote:host-1', windows: [{ agentId: AGENT_2, filePath: '/srv/agents/agent-2.adf' }] },
  }
  const MIGRATED_CLIENT = {
    theme: 'dark',
    runtimeRecentFiles: { 'remote:host-1': ['/srv/agents/agent-2.adf'] },
    runtimeFleet: { 'remote:host-1': { fleetGroups: { '/srv/agents': ['/srv/agents/agent-2.adf'] } } },
    [AGENT_WINDOWS_KEY]: { runtime: 'local', windows: [{ agentId: AGENT_2, filePath: '/srv/agents/agent-2.adf', runtimeId: 'remote:host-1', fingerprint: 'ABCD-EFGH' }] },
  }

  it('the client keys cannot be written: studio-backend.json still says remote, Connections says so, the next launch migrates both', async () => {
    const dir = userData({ 'studio-backend.json': REMOTE, [CLIENT_SETTINGS_FILE]: CLIENT })
    const clientPath = join(dir, CLIENT_SETTINGS_FILE)
    blockedWrites.add(resolve(clientPath))
    const boot = resolveBootBackend(join(dir, 'studio-backend.json'), {}, quiet)
    const migration = await migrateRemoteModeInstall(boot, dir, { 'host-1': HOST_1 }, quiet)
    blockedWrites.clear()
    expect(migration).toMatchObject({ written: false, notice: 'host-1 is in Settings → Connections.' })
    expect(boot.config.mode).toBe('local')
    expect(boot.notices?.join(' ')).toMatch(/still says remote/)
    expect(read(dir, 'studio-backend.json')).toEqual(REMOTE)
    expect(read(dir, CLIENT_SETTINGS_FILE)).toEqual(CLIENT)

    const next = resolveBootBackend(join(dir, 'studio-backend.json'), {}, quiet)
    expect(await migrateRemoteModeInstall(next, dir, { 'host-1': HOST_1 }, quiet)).toMatchObject({ written: true })
    expect(read(dir, 'studio-backend.json')).toMatchObject({ mode: 'local', runtimeOrder: ['remote:host-1'] })
    expect(read(dir, CLIENT_SETTINGS_FILE)).toEqual(MIGRATED_CLIENT)
  })

  it('studio-backend.json cannot be written after the client keys were: the next launch moves nothing of This computer\'s', async () => {
    const dir = userData({ 'studio-backend.json': REMOTE, [CLIENT_SETTINGS_FILE]: { theme: 'dark' } })
    const boot = { ...resolveBootBackend(join(dir, 'studio-backend.json'), {}, quiet), writeBlocked: 'studio-backend.json could not be read (EACCES).' }
    expect(await migrateRemoteModeInstall(boot, dir, { 'host-1': HOST_1 }, quiet)).toMatchObject({ written: false })
    // That launch ran This computer, whose fleet map wrote its own groups.
    const client = read(dir, CLIENT_SETTINGS_FILE)
    writeFileSync(join(dir, CLIENT_SETTINGS_FILE), JSON.stringify({ ...client, fleetGroups: { 'C:/agents': ['C:/agents/agent-1.adf'] } }))

    const next = resolveBootBackend(join(dir, 'studio-backend.json'), {}, quiet)
    expect(await migrateRemoteModeInstall(next, dir, { 'host-1': HOST_1 }, quiet)).toMatchObject({ written: true })
    expect(read(dir, 'studio-backend.json')).toMatchObject({ mode: 'local' })
    // The mark goes once studio-backend.json says local.
    expect(read(dir, CLIENT_SETTINGS_FILE)).toEqual({ theme: 'dark', fleetGroups: { 'C:/agents': ['C:/agents/agent-1.adf'] } })
  })

  it('a launch Inside Studio (ADF_STUDIO_BACKEND=embedded) leaves both files for the next launch', async () => {
    const dir = userData({ 'studio-backend.json': REMOTE, [CLIENT_SETTINGS_FILE]: CLIENT })
    const before = [readFileSync(join(dir, 'studio-backend.json'), 'utf-8'), readFileSync(join(dir, CLIENT_SETTINGS_FILE), 'utf-8')]
    const boot = resolveBootBackend(join(dir, 'studio-backend.json'), { ADF_STUDIO_BACKEND: 'embedded' }, quiet)
    expect(boot.mode).toBe('embedded')
    expect(await migrateRemoteModeInstall(boot, dir, { 'host-1': HOST_1 }, quiet)).toBeNull()
    expect([readFileSync(join(dir, 'studio-backend.json'), 'utf-8'), readFileSync(join(dir, CLIENT_SETTINGS_FILE), 'utf-8')]).toEqual(before)
  })
})

describe('the client keys of a runtime that went (§7.4)', () => {
  const RECENTS = { 'remote:host-1': ['/srv/a.adf'], 'remote:old-name': ['/srv/b.adf'], 'remote:gone': ['/srv/c.adf'], remote: ['/srv/d.adf'] }
  const FLEET = { 'remote:gone': { fleetGroups: { '/srv': ['/srv/c.adf'] } }, 'remote:old-name': { fleetStewards: { '/srv': 'did:key:z6Mk-steward' } } }

  it('a runtime not in the set loses its keys; one renamed (same fingerprint) takes them to its new id; nothing else changes', () => {
    const inSet = (id: string) => id === 'remote:host-1'
    expect(relinkRuntimeKeys({ runtimeRecentFiles: RECENTS, runtimeFleet: FLEET }, inSet, new Map([['remote:old-name', 'remote:host-1']]))).toEqual({
      // host-1 has its own recent files: they stay, the old name's go.
      runtimeRecentFiles: { 'remote:host-1': ['/srv/a.adf'] },
      runtimeFleet: { 'remote:host-1': { fleetStewards: { '/srv': 'did:key:z6Mk-steward' } } },
    })
    // Every id in the set, or no keys: null, never rewritten (a local-only file keeps its bytes).
    expect(relinkRuntimeKeys({ runtimeRecentFiles: { 'remote:host-1': ['/srv/a.adf'] } }, inSet)).toBeNull()
    expect(relinkRuntimeKeys({}, inSet)).toBeNull()
  })

  it('renamed at launch: an agent window of an id not in the set whose fingerprint is saved, and the slot whose pairing is now a saved connection', () => {
    const windows = { runtime: 'local', windows: [
      { agentId: AGENT_1, filePath: 'C:/agents/agent-1.adf' },
      { agentId: AGENT_2, filePath: '/srv/b.adf', runtimeId: 'remote:old-name', fingerprint: 'ABCD-EFGH' },
      { agentId: AGENT_2, filePath: '/srv/c.adf', runtimeId: 'remote:gone', fingerprint: 'NONE-2345' },
    ] }
    expect([...renamedRuntimes(windows, { 'host-1': HOST_1 }, { inSet: false, fingerprint: 'WXYZ-2345' })]).toEqual([['remote:old-name', 'remote:host-1']])
    expect([...renamedRuntimes(undefined, { 'host-2': HOST_2 }, { inSet: false, fingerprint: 'WXYZ-2345' })]).toEqual([['remote', 'remote:host-2']])
    expect([...renamedRuntimes(undefined, { 'host-2': HOST_2 }, { inSet: true, fingerprint: 'WXYZ-2345' })]).toEqual([])
  })

  it('while Studio runs: a name gone whose fingerprint is under another name moved; a name now another computer was replaced', () => {
    const before = { 'old-name': HOST_1, 'host-2': HOST_2 }
    const after = { 'host-1': HOST_1, 'host-2': { ...HOST_2, fingerprint: 'NEWW-2345' } }
    expect(savedConnectionChanges(before, after)).toEqual({ moves: new Map([['remote:old-name', 'remote:host-1']]), replaced: new Set(['remote:host-2']) })
    expect(savedConnectionChanges(before, before)).toEqual({ moves: new Map(), replaced: new Set() })
  })

  it('cli-remotes.json read strictly: missing is no connection; unreadable or not parsed is unknown, so nothing is forgotten', async () => {
    const dir = userData({})
    const env = { ADF_DAEMON_SETTINGS: join(dir, 'adf-settings.json') }
    expect(await savedConnectionNames(env)).toEqual(new Set())
    writeFileSync(join(dir, 'cli-remotes.json'), JSON.stringify({ v: 1, default: null, remotes: { 'host-1': HOST_1, broken: { url: 1 } } }))
    // A malformed entry is still a name: its keys are not forgotten.
    expect(await savedConnectionNames(env)).toEqual(new Set(['host-1', 'broken']))
    writeFileSync(join(dir, 'cli-remotes.json'), '{"v":1,"remotes":')
    expect(await savedConnectionNames(env)).toBeNull()
    writeFileSync(join(dir, 'cli-remotes.json'), JSON.stringify({ v: 2, remotes: {} }))
    expect(await savedConnectionNames(env)).toBeNull()
  })
})
