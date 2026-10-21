/**
 * The Open Recent and Mesh view keys of a remote runtime (`runtimeRecentFiles`,
 * `runtimeFleet`, docs/design/multi-runtime.md §7.4, §17) follow its
 * fingerprint, at launch and while Studio runs (R2B-4), and the
 * `remoteModeMigrated` mark of an older remote mode's migration never sticks
 * (R2B-6).
 *
 * The rule: when Studio sees a name gone (at launch, or when cli-remotes.json
 * changes) and another saved name holds the fingerprint that name had, the
 * keys move there, unless that name has its own; otherwise they go. A name
 * that now holds another fingerprint is another computer: its keys go.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('./daemon-mode-electron')).electronStub.module)

import { resolveBootBackend } from '../../src/main/backend/backend-config'
import { CLIENT_SETTINGS_FILE } from '../../src/main/backend/daemon-mode/settings'
import {
  forgetGoneRuntimeKeys, launchRuntimeKeyChanges, migrateRemoteModeClientKeys, migrateRemoteModeInstall, RUNTIME_FINGERPRINTS_KEY, savedConnectionChanges,
} from '../../src/main/backend/runtime-migration'
import type { SavedRemote } from '../../src/main/cli/remotes'

const quiet = { log: () => {}, warn: () => {} }
const FP = 'ABCD-EFGH'
const HOST_1: SavedRemote = { url: 'http://100.101.102.103:7385', fingerprint: FP, deviceId: 'd1', label: 'l', pairedAt: '2026-10-18T10:00:00Z', hostName: 'host-1' }
const LAB: SavedRemote = { ...HOST_1, url: 'https://host-1.tailnet.ts.net', deviceId: 'd2' }
const OTHER: SavedRemote = { ...HOST_1, fingerprint: 'WXYZ-2345', deviceId: 'd3' }
const AGENT_2 = '0d9e8f7a-6b5c-4d3e-9f21-0a9b8c7d6e5f'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function setup(remotes: Record<string, SavedRemote>, values: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), 'adf-runtime-keys-'))
  dirs.push(dir)
  const env: NodeJS.ProcessEnv = { ADF_DAEMON_SETTINGS: join(dir, 'adf-settings.json') }
  const save = (r: Record<string, SavedRemote>) => writeFileSync(join(dir, 'cli-remotes.json'), JSON.stringify({ v: 1, default: null, remotes: r }))
  save(remotes)
  const data: Record<string, unknown> = { ...values }
  let writes = 0
  const store = {
    get: (key: string) => data[key],
    patch: (patch: Record<string, unknown>) => {
      writes++
      for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete data[k]; else data[k] = v }
    },
  }
  return { dir, env, save, data, store, writes: () => writes }
}

describe('keys follow the fingerprint (R2B-4)', () => {
  it('while Studio runs: adf pair --as lab, then adf remotes forget host-1: the keys move to lab', async () => {
    const s = setup({ 'host-1': HOST_1 }, { runtimeRecentFiles: { 'remote:host-1': ['/srv/a.adf'] }, runtimeFleet: { 'remote:host-1': { fleetGroups: { '/srv': ['/srv/a.adf'] } } } })
    let before: Record<string, SavedRemote> = { 'host-1': HOST_1 }
    const change = async (after: Record<string, SavedRemote>) => {
      s.save(after)
      await forgetGoneRuntimeKeys(s.store, s.env, () => false, savedConnectionChanges(before, after), quiet)
      before = after
    }
    await change({ 'host-1': HOST_1, lab: LAB })
    expect(s.data.runtimeRecentFiles).toEqual({ 'remote:host-1': ['/srv/a.adf'] })
    await change({ lab: LAB })
    expect(s.data.runtimeRecentFiles).toEqual({ 'remote:lab': ['/srv/a.adf'] })
    expect(s.data.runtimeFleet).toEqual({ 'remote:lab': { fleetGroups: { '/srv': ['/srv/a.adf'] } } })
  })

  it('a name saved before the other went is a move target too', () => {
    expect(savedConnectionChanges({ 'host-1': HOST_1, lab: LAB }, { lab: LAB }).moves).toEqual(new Map([['remote:host-1', 'remote:lab']]))
  })

  it('while Studio runs: forget first, then pair as lab: the keys go at the forget; lab starts with none', async () => {
    const s = setup({ 'host-1': HOST_1 }, { runtimeRecentFiles: { 'remote:host-1': ['/srv/a.adf'] } })
    s.save({})
    await forgetGoneRuntimeKeys(s.store, s.env, () => false, savedConnectionChanges({ 'host-1': HOST_1 }, {}), quiet)
    expect(s.data.runtimeRecentFiles).toEqual({})
    s.save({ lab: LAB })
    await forgetGoneRuntimeKeys(s.store, s.env, () => false, savedConnectionChanges({}, { lab: LAB }), quiet)
    expect(s.data.runtimeRecentFiles).toEqual({})
  })

  it('at launch: the fingerprint each name had is kept with its keys, so a name gone while Studio was closed hands them on', async () => {
    const s = setup({ 'host-1': HOST_1 }, { runtimeRecentFiles: { 'remote:host-1': ['/srv/a.adf'] } })
    // Studio records the fingerprint of each runtime that has keys.
    await forgetGoneRuntimeKeys(s.store, s.env, () => false, {}, quiet)
    expect(s.data[RUNTIME_FINGERPRINTS_KEY]).toEqual({ 'remote:host-1': FP })

    // Closed: adf pair --as lab, adf remotes forget host-1. The next launch:
    s.save({ lab: LAB })
    const changes = launchRuntimeKeyChanges(s.data[RUNTIME_FINGERPRINTS_KEY], undefined, { lab: LAB }, { inSet: false, fingerprint: null })
    await forgetGoneRuntimeKeys(s.store, s.env, () => false, changes, quiet)
    expect(s.data.runtimeRecentFiles).toEqual({ 'remote:lab': ['/srv/a.adf'] })
    expect(s.data[RUNTIME_FINGERPRINTS_KEY]).toEqual({ 'remote:lab': FP })
  })

  it('at launch: a name that now holds another computer loses its keys', async () => {
    const s = setup({ 'host-1': OTHER }, { runtimeRecentFiles: { 'remote:host-1': ['/srv/a.adf'] }, [RUNTIME_FINGERPRINTS_KEY]: { 'remote:host-1': FP } })
    const changes = launchRuntimeKeyChanges(s.data[RUNTIME_FINGERPRINTS_KEY], undefined, { 'host-1': OTHER }, { inSet: false, fingerprint: null })
    expect(changes.replaced).toEqual(new Set(['remote:host-1']))
    await forgetGoneRuntimeKeys(s.store, s.env, () => false, changes, quiet)
    expect(s.data.runtimeRecentFiles).toEqual({})
  })

  it('at launch, as relinkSavedAgentWindows: an agent window\'s fingerprint moves the keys of its old id too', () => {
    const windows = { runtime: 'local', windows: [{ agentId: AGENT_2, filePath: '/srv/a.adf', runtimeId: 'remote:old-name', fingerprint: FP }] }
    expect(launchRuntimeKeyChanges(undefined, windows, { lab: LAB }, { inSet: false, fingerprint: null }).moves).toEqual(new Map([['remote:old-name', 'remote:lab']]))
  })

  it('an install with no remote keys gets no record (its file keeps its bytes)', async () => {
    const s = setup({ 'host-1': HOST_1 }, { theme: 'dark' })
    await forgetGoneRuntimeKeys(s.store, s.env, () => false, {}, quiet)
    expect(s.writes()).toBe(0)
  })
})

describe('the remoteModeMigrated mark (R2B-6)', () => {
  const legacy = { remote: { url: null, token: null, allowInsecureHttp: false, name: 'host-1' } }
  const runtime = { id: 'remote:host-1', name: 'host-1', fingerprint: FP, inSet: true }

  it('gates the fleet keys only: recent files and an agent windows list of remote mode still move', () => {
    const data: Record<string, unknown> = {
      remoteModeMigrated: true,
      fleetGroups: { 'C:/agents': ['C:/agents/agent-1.adf'] },
      remoteRecentFiles: ['/srv/x.adf'],
      agentWindows: { runtime: 'remote:host-1', windows: [{ agentId: AGENT_2, filePath: '/srv/x.adf' }] },
    }
    migrateRemoteModeClientKeys(data, legacy, runtime, { 'host-1': HOST_1 })
    expect(data).toEqual({
      remoteModeMigrated: true,
      fleetGroups: { 'C:/agents': ['C:/agents/agent-1.adf'] },
      runtimeRecentFiles: { 'remote:host-1': ['/srv/x.adf'] },
      agentWindows: { runtime: 'local', windows: [{ agentId: AGENT_2, filePath: '/srv/x.adf', runtimeId: 'remote:host-1', fingerprint: FP }] },
    })
  })

  it('a launch that reads mode local unmarks the client file; then a downgrade, remote use and upgrade migrate again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-runtime-keys-'))
    dirs.push(dir)
    const client = join(dir, CLIENT_SETTINGS_FILE)
    const backend = join(dir, 'studio-backend.json')
    // Stuck: studio-backend.json says local, the client file is still marked.
    writeFileSync(backend, JSON.stringify({ v: 1, mode: 'local', keepDaemonRunning: false, remote: { url: null, token: null, allowInsecureHttp: false } }))
    writeFileSync(client, JSON.stringify({ theme: 'dark', remoteModeMigrated: true }))
    expect(await migrateRemoteModeInstall(resolveBootBackend(backend, {}, quiet), dir, { 'host-1': HOST_1 }, quiet)).toBeNull()
    expect(JSON.parse(readFileSync(client, 'utf-8'))).toEqual({ theme: 'dark' })

    // An older Studio in remote mode on host-1 writes its fleet keys plainly.
    writeFileSync(backend, JSON.stringify({ v: 1, mode: 'remote', keepDaemonRunning: false, remote: { url: null, token: null, allowInsecureHttp: false, name: 'host-1' } }))
    writeFileSync(client, JSON.stringify({ theme: 'dark', fleetGroups: { '/srv': ['/srv/x.adf'] } }))
    expect(await migrateRemoteModeInstall(resolveBootBackend(backend, {}, quiet), dir, { 'host-1': HOST_1 }, quiet)).toMatchObject({ written: true })
    expect(JSON.parse(readFileSync(client, 'utf-8'))).toEqual({ theme: 'dark', runtimeFleet: { 'remote:host-1': { fleetGroups: { '/srv': ['/srv/x.adf'] } } } })
  })

  it('a local file without the mark is not written (M11)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-runtime-keys-'))
    dirs.push(dir)
    const backend = join(dir, 'studio-backend.json')
    writeFileSync(backend, JSON.stringify({ v: 1, mode: 'local', keepDaemonRunning: false, remote: { url: null, token: null, allowInsecureHttp: false } }))
    const bytes = JSON.stringify({ theme: 'dark', fleetGroups: {} })
    writeFileSync(join(dir, CLIENT_SETTINGS_FILE), bytes)
    expect(await migrateRemoteModeInstall(resolveBootBackend(backend, {}, quiet), dir, {}, quiet)).toBeNull()
    expect(readFileSync(join(dir, CLIENT_SETTINGS_FILE), 'utf-8')).toBe(bytes)
  })
})
