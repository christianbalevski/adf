import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { Readable } from 'node:stream'
import { request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { AdfDatabase } from '../src/main/adf/adf-database'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'

vi.mock('electron', () => {
  const dir = join(tmpdir(), `adf-daemon-file-routes-${process.pid}`)
  return {
    app: {
      getPath: () => dir,
      on: () => {},
      getName: () => 'adf-daemon-file-routes-test',
      getVersion: () => '0.0.0-test',
    },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (s: string) => Buffer.from(s, 'utf-8'),
      decryptString: (b: Buffer) => b.toString('utf-8'),
    },
    shell: { openExternal: async () => {} },
    ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {}, removeAllListeners: () => {} },
    BrowserWindow: class {},
    dialog: {},
  }
})

import Database from 'better-sqlite3'
import { createDaemonHttpApi } from '../src/main/daemon/http-api'
import { clearPeekCache } from '../src/main/daemon/tracked-dirs'
import { TrackedDirWatcher, type TrackedDirsPush, type FileRenamedPush } from '../src/main/daemon/dir-watcher'
import { AgentFileOps } from '../src/main/daemon/file-ops'
import { AdfWorkspace } from '../src/main/adf/adf-workspace'
import { RuntimeService } from '../src/main/runtime/runtime-service'
import { createHeadlessAgent, MockLLMProvider } from '../src/main/runtime/headless'
import { AgentLeaseRegistry, processAgentLeases } from '../src/main/runtime/agent-lease'
import { MeshManager } from '../src/main/runtime/mesh-manager'
import { setWorkspaceIdentityHooks } from '../src/main/runtime/identity-provisioner'

const MIB = 1024 * 1024
const servers: Array<{ close: () => Promise<unknown> }> = []
const runtimes: RuntimeService[] = []
const links: string[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()))
  for (const runtime of runtimes.splice(0)) {
    for (const agent of runtime.listAgents()) await runtime.unloadAgent(agent.id, { mode: 'immediate' })
  }
  // Junction safety: links are unlinked themselves, never followed by a recursive delete.
  for (const link of links.splice(0)) {
    try { unlinkSync(link) } catch { /* gone */ }
    expect(existsSync(link)).toBe(false)
  }
  setWorkspaceIdentityHooks({ ensureIdentity: () => {}, unlockEnvelopes: () => {} })
  clearPeekCache()
})

function tempDir(prefix: string): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), prefix)))
}

/** An agent file on disk; returns its id. */
function seedAgent(dir: string, name: string, opts: { autostart?: boolean } = {}): { id: string; filePath: string } {
  const filePath = join(dir, `${name}.adf`)
  const created = createHeadlessAgent({
    filePath,
    name,
    provider: new MockLLMProvider(),
    createOptions: { handle: name, autostart: opts.autostart ?? false, start_in_state: 'hibernate' },
  })
  const id = created.workspace.getAgentConfig().id
  created.dispose()
  return { id, filePath }
}

function memorySettings(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial }
  return {
    data,
    store: {
      get: (key: string) => data[key],
      set: (key: string, value: unknown) => { data[key] = value },
      getAll: () => ({ ...data }),
      update: (values: Record<string, unknown>) => { Object.assign(data, values) },
    },
  }
}

function setup(initial: Record<string, unknown> = {}, opts: { runtime?: RuntimeService; rawFileBodyLimit?: number; identity?: unknown } = {}) {
  const settings = memorySettings(initial)
  const runtime = opts.runtime ?? new RuntimeService({
    settings: settings.store,
    providerFactory: () => new MockLLMProvider({ tokensPerResponse: 40 }),
  })
  runtimes.push(runtime)
  const changes: string[][] = []
  const watcher = new TrackedDirWatcher({ runtime, settings: settings.store, onTrackedDirectoriesChanged: dirs => changes.push(dirs), watch: false, debounceMs: 5 })
  const pushes: TrackedDirsPush[] = []
  const renames: FileRenamedPush[] = []
  watcher.on('tracked_dirs', p => pushes.push(p))
  watcher.on('file_renamed', p => renames.push(p))
  const server = createDaemonHttpApi(runtime, {
    settingsStore: settings.store,
    ...(opts.identity ? { identity: opts.identity as never } : {}),
    onTrackedDirectoriesChanged: dirs => changes.push(dirs),
    routes: { trackedDirWatcher: watcher, ...(opts.rawFileBodyLimit ? { rawFileBodyLimit: opts.rawFileBodyLimit } : {}) },
  })
  servers.push(server)
  return { runtime, server, settings, changes, pushes, renames, watcher }
}

const q = (p: string) => encodeURIComponent(p)
const tick = (ms = 30) => new Promise(r => setTimeout(r, ms))

describe('daemon file routes: path → id, delete, rename, clone', () => {
  it('resolves a path to an agent id, loaded or not, and refuses non-.adf and relative paths', async () => {
    const root = tempDir('adf-files-')
    const a = seedAgent(root, 'agent-1')
    const { server, runtime } = setup({ trackedDirectories: [root] })
    await server.ready()

    const closed = (await server.inject({ method: 'GET', url: `/files/agent?path=${q(a.filePath)}` })).json()
    expect(closed).toMatchObject({ filePath: a.filePath, agentId: a.id, name: 'agent-1', loaded: false, tracked: true })

    await runtime.loadAgent(a.filePath, { enforceReviewGate: false })
    const loaded = (await server.inject({ method: 'GET', url: `/files/agent?path=${q(a.filePath)}` })).json()
    expect(loaded).toMatchObject({ agentId: a.id, loaded: true })

    expect((await server.inject({ method: 'GET', url: `/files/agent?path=${q('relative/agent-1.adf')}` })).statusCode).toBe(400)
    writeFileSync(join(root, 'notes.txt'), 'x')
    expect((await server.inject({ method: 'GET', url: `/files/agent?path=${q(join(root, 'notes.txt'))}` })).json().code).toBe('not_an_adf')
    expect((await server.inject({ method: 'GET', url: `/files/agent?path=${q(join(root, 'missing.adf'))}` })).statusCode).toBe(404)
  })

  it('deletes a stopped agent file with its sidecars, and stops a running agent first (as Studio does)', async () => {
    const root = tempDir('adf-files-')
    const a = seedAgent(root, 'agent-1')
    const b = seedAgent(root, 'agent-2')
    const { server, runtime } = setup({ trackedDirectories: [root] })
    writeFileSync(`${a.filePath}-wal`, '')

    const first = await server.inject({ method: 'DELETE', url: `/files?path=${q(a.filePath)}` })
    expect(first.statusCode).toBe(200)
    expect(first.json()).toMatchObject({ success: true, stopped: false })
    expect(existsSync(a.filePath)).toBe(false)
    expect(existsSync(`${a.filePath}-wal`)).toBe(false)

    await runtime.loadAgent(b.filePath, { enforceReviewGate: false })
    const unloaded: Array<string | null> = []
    runtime.on('agent-unloaded', e => unloaded.push(e.filePath))
    const second = await server.inject({ method: 'DELETE', url: `/files?path=${q(b.filePath)}` })
    expect(second.json()).toMatchObject({ success: true, stopped: true, agentId: b.id })
    expect(unloaded).toEqual([b.filePath])
    expect(runtime.listAgents()).toEqual([])
    expect(existsSync(b.filePath)).toBe(false)
    // Its lease went with it.
    expect(await processAgentLeases().isHeld(b.filePath)).toBe(false)

    // Already gone: still success, as in Studio.
    expect((await server.inject({ method: 'DELETE', url: `/files?path=${q(b.filePath)}` })).json()).toMatchObject({ success: true, stopped: false })
  })

  it('renames a stopped agent file and its config name, and pushes file_renamed', async () => {
    const root = tempDir('adf-files-')
    const a = seedAgent(root, 'agent-1')
    seedAgent(root, 'agent-2')
    const { server, renames, pushes } = setup({ trackedDirectories: [root] })
    await server.ready()

    expect((await server.inject({ method: 'POST', url: '/files/rename', payload: { path: a.filePath, newName: 'a/b' } })).json().code).toBe('invalid_name')
    expect((await server.inject({ method: 'POST', url: '/files/rename', payload: { path: a.filePath, newName: 'agent-2' } })).json().code).toBe('name_taken')

    const res = await server.inject({ method: 'POST', url: '/files/rename', payload: { path: a.filePath, newName: 'agent-3' } })
    expect(res.statusCode).toBe(200)
    const newPath = join(root, 'agent-3.adf')
    expect(res.json()).toEqual({ success: true, filePath: newPath, renameDeferred: false, agentId: a.id })
    expect(existsSync(a.filePath)).toBe(false)
    const ws = AdfWorkspace.open(newPath)
    try { expect(ws.getAgentConfig().name).toBe('agent-3') } finally { ws.close() }
    expect(renames).toEqual([{ oldPath: a.filePath, newPath }])
    await tick()
    expect(pushes).toContainEqual({ dirPath: root })
  })

  it('renames a running agent without stopping it: same agent, lease and file until it stops, then the file moves', async () => {
    const root = tempDir('adf-files-')
    const a = seedAgent(root, 'agent-1')
    const { server, runtime, renames } = setup({ trackedDirectories: [root] })
    await server.ready()
    const ref = await runtime.loadAgent(a.filePath, { enforceReviewGate: false })
    const unloaded: Array<string | null> = []
    runtime.on('agent-unloaded', e => unloaded.push(e.filePath))

    const res = await server.inject({ method: 'POST', url: '/files/rename', payload: { path: a.filePath, newName: 'agent-9' } })
    expect(res.json()).toEqual({ success: true, filePath: a.filePath, renameDeferred: true, agentId: ref.id })
    // Still running under the same id and file; the lease stays where it was; nothing unloaded
    // (the daemon unregisters mesh agents only on unload, so its mesh registration stays too).
    expect(runtime.listAgents()).toEqual([expect.objectContaining({ id: ref.id, filePath: a.filePath, name: 'agent-9' })])
    expect(runtime.getAgentConfig(ref.id).config.name).toBe('agent-9')
    expect(await processAgentLeases().isHeld(a.filePath)).toBe(true)
    expect(unloaded).toEqual([])
    expect(existsSync(a.filePath)).toBe(true)
    expect(renames).toEqual([])
    // The tree shows the waiting name.
    const tree = (await server.inject({ method: 'GET', url: `/tracked-dirs/tree?path=${q(root)}` })).json()
    expect(tree.files).toEqual([expect.objectContaining({ filePath: a.filePath, pendingName: 'agent-9', agentId: ref.id })])

    await runtime.unloadAgent(ref.id)
    const newPath = join(root, 'agent-9.adf')
    for (let i = 0; i < 50 && !existsSync(newPath); i++) await tick(20)
    expect(existsSync(newPath)).toBe(true)
    expect(existsSync(a.filePath)).toBe(false)
    expect(renames).toEqual([{ oldPath: a.filePath, newPath }])
  })

  it('re-keys moves through RuntimeService.rekeyAgentPath, and its path events feed file_renamed and the watcher', async () => {
    const root = tempDir('adf-files-')
    const a = seedAgent(root, 'agent-1')
    const { server, runtime, renames, watcher } = setup({ trackedDirectories: [root] })
    const rekey = vi.spyOn(runtime, 'rekeyAgentPath')
    await server.inject({ method: 'POST', url: '/files/rename', payload: { path: a.filePath, newName: 'agent-2' } })
    const moved = join(root, 'agent-2.adf')
    expect(rekey).toHaveBeenCalledWith(a.filePath, moved)
    // A loaded agent's file moved by its runtime: same push, and no autostart of the new path.
    const elsewhere = join(root, 'agent-3.adf')
    runtime.emit('agent-path-changed', { agentId: a.id, oldFilePath: moved, filePath: elsewhere })
    expect(renames.at(-1)).toEqual({ oldPath: moved, newPath: elsewhere })
    expect((watcher as unknown as { isExpected(p: string): boolean }).isExpected(elsewhere)).toBe(true)
  })

  it('clones before the owner identity exists, as Studio does: no identity keys, a warning in the answer (review fix)', async () => {
    const root = tempDir('adf-files-')
    const a = seedAgent(root, 'agent-1')
    const notReady = { isReady: () => false, status: () => ({ status: 'none', message: 'No owner identity yet.' }), service: undefined }
    const { server } = setup({ trackedDirectories: [root] }, { identity: notReady })
    await server.ready()
    // Without an owner the identity hooks mint plain keys, as Studio's owner service does.
    setWorkspaceIdentityHooks({ ensureIdentity: ws => { ws.generateIdentityKeys(null) }, unlockEnvelopes: () => {} })
    const res = await server.inject({ method: 'POST', url: '/files/clone', payload: { path: a.filePath, selectedTables: ['adf_config', 'adf_meta'] } })
    expect(res.statusCode).toBe(201)
    expect(res.json().warnings).toContain("The owner identity is not set up yet, so the clone's identity is not sealed to an owner. No owner identity yet.")
    expect(existsSync(res.json().filePath)).toBe(true)
  })

  it('clones with selected tables and clone-fixup: new id, fresh identity, reviewed, folder tracked and pushed', async () => {
    const root = tempDir('adf-files-')
    const elsewhere = tempDir('adf-files-other-')
    const a = seedAgent(elsewhere, 'agent-1')
    const { server, settings, changes, pushes } = setup({ trackedDirectories: [root] })
    await server.ready()
    // The daemon's identity hooks mint keys; a fake stands in for the owner identity here.
    setWorkspaceIdentityHooks({ ensureIdentity: ws => { ws.generateIdentityKeys(null) }, unlockEnvelopes: () => {} })

    const tables = (await server.inject({ method: 'GET', url: `/files/agent/tables?path=${q(a.filePath)}` })).json()
    expect(tables.loaded).toBe(false)
    const names = (tables.tables as Array<{ name: string; row_count: number }>).map(t => t.name)
    expect(names).toContain('adf_config')
    expect(tables.tables.every((t: { row_count: unknown }) => typeof t.row_count === 'number')).toBe(true)
    // No FTS shadow tables (e.g. <fts>_data, <fts>_idx).
    expect(names.filter(n => /_(data|idx|docsize|config|content)$/.test(n) && names.includes(n.replace(/_(data|idx|docsize|config|content)$/, '')))).toEqual([])

    const res = await server.inject({ method: 'POST', url: '/files/clone', payload: { path: a.filePath, selectedTables: ['adf_config', 'adf_meta', 'adf_files'] } })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body).toMatchObject({ success: true, name: 'agent-1_clone', identity: 'fresh' })
    expect(body.agentId).not.toBe(a.id)
    expect(existsSync(body.filePath)).toBe(true)
    expect(Object.keys(settings.data.reviewedAgents as Record<string, unknown>)).toContain(body.agentId)
    // The clone's folder was untracked: tracked now, the mesh told, and pushed.
    expect(settings.data.trackedDirectories).toEqual([root, elsewhere])
    expect(changes.at(-1)).toEqual([root, elsewhere])
    expect(pushes).toContainEqual({ dirPath: elsewhere })
  })
})

describe('daemon file routes: snapshots, export, save-as, import', () => {
  it('exports a running agent as a consistent file that passes an integrity check', async () => {
    const root = tempDir('adf-files-')
    const a = seedAgent(root, 'agent-1')
    const { server, runtime } = setup({ trackedDirectories: [root] })
    const ref = await runtime.loadAgent(a.filePath, { enforceReviewGate: false })
    // Fresh writes sit in the WAL of the running agent.
    runtime.writeAgentFile(ref.id, 'notes/live.txt', { content: 'written while running' })
    // Proof: the main file alone (no -wal) does not have it yet.
    const mainOnly = join(tempDir('adf-mainonly-'), 'main.adf')
    copyFileSync(a.filePath, mainOnly)
    const before = new Database(mainOnly, { readonly: true })
    try {
      expect(before.prepare('SELECT 1 FROM adf_files WHERE path = ?').get('notes/live.txt')).toBeUndefined()
    } finally {
      before.close()
    }
    for (const side of ['-wal', '-shm']) { try { unlinkSync(mainOnly + side) } catch { /* none */ } }

    const res = await server.inject({ method: 'GET', url: `/agents/${ref.id}/export` })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('application/octet-stream')
    expect(res.headers['content-disposition']).toContain('agent-1.adf')
    const out = join(tempDir('adf-export-'), 'agent-1.adf')
    writeFileSync(out, res.rawPayload)
    const db = new Database(out, { readonly: true })
    try {
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok')
      const config = JSON.parse((db.prepare('SELECT config_json FROM adf_config WHERE id = 1').get() as { config_json: string }).config_json)
      expect(config.id).toBe(ref.id)
      const file = db.prepare('SELECT content FROM adf_files WHERE path = ?').get('notes/live.txt') as { content: Buffer } | undefined
      expect(file?.content.toString('utf-8')).toBe('written while running')
    } finally {
      db.close()
    }
    // A tracked file that is not loaded exports by id too; unknown ids are 404.
    await runtime.unloadAgent(ref.id)
    expect((await server.inject({ method: 'GET', url: `/agents/${a.id}/export` })).statusCode).toBe(200)
    expect((await server.inject({ method: 'GET', url: '/agents/no-such-agent/export' })).statusCode).toBe(404)
  })

  it('serves an identity-free share snapshot and writes a copy with save-as (never over the source)', async () => {
    const root = tempDir('adf-files-')
    const a = seedAgent(root, 'agent-1')
    const ws = AdfWorkspace.open(a.filePath)
    try { ws.generateIdentityKeys(null) } finally { ws.close() }
    const { server } = setup({ trackedDirectories: [root] })

    const res = await server.inject({ method: 'GET', url: `/files/snapshot?path=${q(a.filePath)}&mode=share` })
    expect(res.statusCode).toBe(200)
    const shared = join(tempDir('adf-share-'), 'agent-1.adf')
    writeFileSync(shared, res.rawPayload)
    const db = new Database(shared, { readonly: true })
    try {
      expect(db.prepare("SELECT COUNT(*) AS n FROM adf_identity WHERE purpose LIKE 'crypto:signing:%'").get()).toEqual({ n: 0 })
      expect(db.prepare("SELECT value FROM adf_meta WHERE key = 'adf_did'").get()).toBeUndefined()
    } finally {
      db.close()
    }

    const dest = join(tempDir('adf-saveas-'), 'copy.adf')
    expect((await server.inject({ method: 'POST', url: '/files/save-as', payload: { path: a.filePath, destPath: a.filePath } })).json().code).toBe('same_file')
    // A full copy on this host would be a twin of the agent (same id and DID): refused.
    expect((await server.inject({ method: 'POST', url: '/files/save-as', payload: { path: a.filePath, destPath: dest, mode: 'export' } })).json().code).toBe('export_not_supported')
    expect(existsSync(dest)).toBe(false)
    const saved = await server.inject({ method: 'POST', url: '/files/save-as', payload: { path: a.filePath, destPath: dest } })
    expect(saved.json()).toMatchObject({ success: true, filePath: dest })
    const copy = new Database(dest, { readonly: true })
    try {
      expect(copy.prepare("SELECT value FROM adf_meta WHERE key = 'adf_did'").get()).toBeUndefined()
      expect(copy.prepare("SELECT COUNT(*) AS n FROM adf_identity WHERE purpose LIKE 'crypto:signing:%'").get()).toEqual({ n: 0 })
    } finally {
      copy.close()
    }
    expect((await server.inject({ method: 'POST', url: '/files/save-as', payload: { path: a.filePath, destPath: dest } })).json().code).toBe('name_taken')
  })

  it('imports an uploaded .adf into a tracked folder only, unreviewed, with name rules', async () => {
    const root = tempDir('adf-files-')
    const source = seedAgent(tempDir('adf-src-'), 'agent-1')
    const bytes = readFileSync(source.filePath)
    const { server, pushes } = setup({ trackedDirectories: [root], agentsFolder: join(tempDir('adf-agents-'), 'adf-agents') })
    await server.ready()
    const upload = (url: string, payload: Buffer, type = 'application/octet-stream') =>
      server.inject({ method: 'POST', url, payload, headers: { 'content-type': type } })

    const ok = await upload(`/files/import?directory=${q(root)}&name=agent-1`, bytes)
    expect(ok.statusCode).toBe(201)
    expect(ok.json()).toMatchObject({ success: true, filePath: join(root, 'agent-1.adf'), agentId: source.id, reviewed: false, size: bytes.length })
    expect(readFileSync(join(root, 'agent-1.adf')).equals(bytes)).toBe(true)
    await tick()
    expect(pushes).toContainEqual({ dirPath: root })

    expect((await upload(`/files/import?directory=${q(root)}&name=agent-1`, bytes)).json().code).toBe('name_taken')
    expect((await upload(`/files/import?directory=${q(root)}&name=agent-1&unique=true`, bytes)).json().filePath).toBe(join(root, 'agent-1 (2).adf'))
    expect((await upload(`/files/import?directory=${q(root)}&name=..%2Fescape`, bytes)).json().code).toBe('invalid_name')
    expect((await upload(`/files/import?directory=${q(tempDir('adf-untracked-'))}&name=agent-1`, bytes)).json().code).toBe('outside_tracked')
    const notAdf = await upload(`/files/import?directory=${q(root)}&name=junk`, Buffer.from('not a database'))
    expect(notAdf.json().code).toBe('not_an_adf')
    expect(existsSync(join(root, 'junk.adf'))).toBe(false)
    expect((await server.inject({ method: 'POST', url: `/files/import?directory=${q(root)}&name=x`, payload: { a: 1 } })).statusCode).toBe(415)
  })

  it('never imports as reviewed: a reviewed id gets a fresh one, and the watcher does not autostart the upload', async () => {
    const root = tempDir('adf-files-')
    const source = seedAgent(tempDir('adf-src-'), 'agent-1', { autostart: true })
    const { server, settings, watcher, runtime } = setup({ trackedDirectories: [root], reviewedAgents: { [source.id]: 'accepted' } })
    await server.ready()
    const res = await server.inject({ method: 'POST', url: `/files/import?directory=${q(root)}&name=agent-1`, payload: readFileSync(source.filePath), headers: { 'content-type': 'application/octet-stream' } })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body).toMatchObject({ reviewed: false, idReassigned: { previousId: source.id, reason: 'reviewed', identityStripped: true } })
    expect(body.agentId).not.toBe(source.id)
    expect(Object.keys(settings.data.reviewedAgents as Record<string, unknown>)).toEqual([source.id])
    const ws = AdfWorkspace.open(body.filePath)
    try { expect(ws.getAgentConfig().id).toBe(body.agentId) } finally { ws.close() }
    expect((watcher as unknown as { isExpected(p: string): boolean }).isExpected(body.filePath)).toBe(true)
    expect(runtime.listAgents()).toEqual([])
  })
})

describe('daemon file routes: raw internal files', () => {
  it('uploads 20 MiB as octet-stream and reads it back byte for byte', async () => {
    const root = tempDir('adf-files-')
    const a = seedAgent(root, 'agent-1')
    const { server, runtime } = setup({ trackedDirectories: [root] })
    const ref = await runtime.loadAgent(a.filePath, { enforceReviewGate: false })
    const payload = Buffer.alloc(20 * MIB)
    for (let i = 0; i < payload.length; i += 4096) payload.writeUInt32LE(i, i)

    const put = await server.inject({ method: 'PUT', url: `/agents/${ref.id}/files/raw?path=${q('data/blob.bin')}`, payload, headers: { 'content-type': 'application/octet-stream' } })
    expect(put.statusCode).toBe(200)
    expect(put.json()).toEqual({ agentId: ref.id, success: true, path: 'data/blob.bin', size: 20 * MIB })

    const meta = (await server.inject({ method: 'GET', url: `/agents/${ref.id}/files/meta?path=${q('data/blob.bin')}` })).json()
    expect(meta).toMatchObject({ agentId: ref.id, path: 'data/blob.bin', size: 20 * MIB, text: false })
    expect(meta).not.toHaveProperty('content')

    const get = await server.inject({ method: 'GET', url: `/agents/${ref.id}/files/raw?path=${q('data/blob.bin')}` })
    expect(get.statusCode).toBe(200)
    expect(get.rawPayload.equals(payload)).toBe(true)

    const capped = await server.inject({ method: 'GET', url: `/agents/${ref.id}/files/raw?path=${q('data/blob.bin')}&maxBytes=1024` })
    expect(capped.statusCode).toBe(413)
    expect(capped.json()).toMatchObject({ code: 'too_large', size: 20 * MIB, maxBytes: 1024 })

    // unique keeps the existing file and numbers the new one.
    const again = await server.inject({ method: 'PUT', url: `/agents/${ref.id}/files/raw?path=${q('data/blob.bin')}&unique=true`, payload: Buffer.from('other'), headers: { 'content-type': 'application/octet-stream' } })
    expect(again.json().path).not.toBe('data/blob.bin')
  }, 60_000)

  it('enforces its own body limit and content type, and 404s unknown agents and files', async () => {
    const root = tempDir('adf-files-')
    const a = seedAgent(root, 'agent-1')
    const { server, runtime } = setup({ trackedDirectories: [root] }, { rawFileBodyLimit: MIB })
    const ref = await runtime.loadAgent(a.filePath, { enforceReviewGate: false })
    const url = `/agents/${ref.id}/files/raw?path=big.bin`
    const over = await server.inject({ method: 'PUT', url, payload: Buffer.alloc(MIB + 1), headers: { 'content-type': 'application/octet-stream' } })
    expect(over.statusCode).toBe(413)
    expect(over.json().code).toBe('too_large')
    expect((await server.inject({ method: 'PUT', url, payload: { a: 1 } })).statusCode).toBe(415)
    // Octet-stream to a JSON route is refused, not parsed.
    expect((await server.inject({ method: 'PUT', url: `/agents/${ref.id}/document`, payload: Buffer.from('x'), headers: { 'content-type': 'application/octet-stream' } })).statusCode).toBe(415)
    expect((await server.inject({ method: 'GET', url: '/agents/agent-9/files/raw?path=a' })).statusCode).toBe(404)
    expect((await server.inject({ method: 'GET', url: `/agents/${ref.id}/files/raw?path=missing.bin` })).statusCode).toBe(404)
    expect((await server.inject({ method: 'GET', url: `/agents/${ref.id}/files/raw` })).statusCode).toBe(400)
  })

  it('caps a streamed body with no Content-Length and closes the connection', async () => {
    const root = tempDir('adf-files-')
    const a = seedAgent(root, 'agent-1')
    const { server, runtime } = setup({ trackedDirectories: [root] }, { rawFileBodyLimit: MIB })
    const ref = await runtime.loadAgent(a.filePath, { enforceReviewGate: false })
    let sent = 0
    const chunk = Buffer.alloc(64 * 1024, 1)
    const stream = new Readable({
      read() {
        // 4 MiB offered, 1 MiB allowed: the route stops reading past the cap.
        if (sent >= 4 * MIB) { this.push(null); return }
        sent += chunk.length
        this.push(chunk)
      },
    })
    const res = await server.inject({ method: 'PUT', url: `/agents/${ref.id}/files/raw?path=big.bin`, payload: stream, headers: { 'content-type': 'application/octet-stream' } })
    expect(res.statusCode).toBe(413)
    expect(res.json().code).toBe('too_large')
    expect(sent).toBeLessThan(4 * MIB)
    expect(runtime.getAgentFile(ref.id, 'big.bin')).toBeNull()
  })
})

describe('daemon file routes: /fs/browse', () => {
  it('lists folders and .adf files inside its roots only, with no traversal or link escape', async () => {
    const root = tempDir('adf-browse-')
    const outside = tempDir('adf-outside-')
    mkdirSync(join(root, 'sub'))
    seedAgent(root, 'agent-1')
    writeFileSync(join(root, 'secret.txt'), 'x')
    writeFileSync(join(root, '.hidden.adf'), 'x')
    seedAgent(outside, 'agent-2')
    const link = join(root, 'escape')
    symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    links.push(link)
    // The temp folders live under the home folder on Windows: confine the roots to the tracked folder.
    const previous = process.env.ADF_DAEMON_BROWSE_ROOTS
    process.env.ADF_DAEMON_BROWSE_ROOTS = ''
    onTestFinished(() => { if (previous === undefined) delete process.env.ADF_DAEMON_BROWSE_ROOTS; else process.env.ADF_DAEMON_BROWSE_ROOTS = previous })
    const { server } = setup({ trackedDirectories: [root] })

    const top = (await server.inject({ method: 'GET', url: '/fs/browse' })).json()
    expect(top.path).toBeNull()
    expect(top.roots).toEqual(expect.arrayContaining([{ path: root, kind: 'tracked' }]))
    expect(top.roots.some((r: { kind: string }) => r.kind === 'home')).toBe(false)

    const listing = (await server.inject({ method: 'GET', url: `/fs/browse?path=${q(root)}` })).json()
    expect(listing.path).toBe(root)
    expect(listing.entries).toEqual([
      { name: 'sub', path: join(root, 'sub'), kind: 'directory' },
      expect.objectContaining({ name: 'agent-1.adf', path: join(root, 'agent-1.adf'), kind: 'adf' }),
    ])
    // The link to a folder outside every root is not listed, and cannot be browsed into.
    expect((await server.inject({ method: 'GET', url: `/fs/browse?path=${q(link)}` })).json().code).toBe('outside_roots')
    expect((await server.inject({ method: 'GET', url: `/fs/browse?path=${q(outside)}` })).statusCode).toBe(403)
    expect((await server.inject({ method: 'GET', url: `/fs/browse?path=${q(join(root, '..', basename(outside)))}` })).statusCode).toBe(403)
    expect((await server.inject({ method: 'GET', url: `/fs/browse?path=${q('relative')}` })).statusCode).toBe(400)
    expect((await server.inject({ method: 'GET', url: `/fs/browse?path=${q(join(root, 'agent-1.adf'))}` })).json().code).toBe('not_a_directory')
    const hidden = (await server.inject({ method: 'GET', url: `/fs/browse?path=${q(root)}&showHidden=true` })).json()
    expect(hidden.entries.map((e: { name: string }) => e.name)).toContain('.hidden.adf')
    // A subfolder's parent is the root; the root's parent is not offered.
    expect((await server.inject({ method: 'GET', url: `/fs/browse?path=${q(join(root, 'sub'))}` })).json().parent).toBe(root)
    expect(listing.parent).toBeNull()
  })
})

describe('daemon file routes: path-addressed agent operations', () => {
  it('reads and writes a closed agent file the way the /agents/:id routes do a loaded one', async () => {
    const root = tempDir('adf-files-')
    const a = seedAgent(root, 'agent-1')
    const { server, runtime } = setup({ trackedDirectories: [root], providers: [{ id: 'mock', type: 'openai-compatible', name: 'Mock', baseUrl: 'http://127.0.0.1:1/v1' }] })
    const p = q(a.filePath)

    expect((await server.inject({ method: 'PUT', url: `/files/agent/model?path=${p}`, payload: { provider: 'nope', model_id: 'm' } })).json().code).toBe('provider_unknown')
    const model = await server.inject({ method: 'PUT', url: `/files/agent/model?path=${p}`, payload: { provider: 'mock', model_id: 'mock-1' } })
    expect(model.json()).toMatchObject({ success: true, model: { provider: 'mock', model_id: 'mock-1' } })

    const attach = await server.inject({ method: 'POST', url: `/files/agent/mcp/servers?path=${p}`, payload: { server: { name: 'fs', transport: 'stdio', command: 'node' } } })
    expect(attach.json()).toMatchObject({ agentId: a.id, serverName: 'fs', alreadyAttached: false, loaded: false })
    const set = await server.inject({ method: 'PUT', url: `/files/agent/mcp/credentials?path=${p}`, payload: { npmPackage: 'fs', envKey: 'TOKEN', value: 'secret-1' } })
    expect(set.json()).toMatchObject({ success: true, loaded: false })
    const got = (await server.inject({ method: 'GET', url: `/files/agent/mcp/credentials?path=${p}&npmPackage=fs` })).json()
    expect(got.credentials.TOKEN).toMatchObject({ present: true, length: 8 })
    expect(JSON.stringify(got)).not.toContain('secret-1')

    await server.inject({ method: 'POST', url: `/files/agent/adapters?path=${p}`, payload: { adapterType: 'telegram', config: { enabled: false } } })
    await server.inject({ method: 'PUT', url: `/files/agent/adapters/credentials?path=${p}`, payload: { adapterType: 'telegram', envKey: 'BOT_TOKEN', value: 'tg' } })
    await server.inject({ method: 'POST', url: `/files/agent/providers?path=${p}`, payload: { provider: { id: 'custom:x', type: 'openai-compatible', name: 'X', baseUrl: 'http://127.0.0.1:1/v1' } } })
    await server.inject({ method: 'PUT', url: `/files/agent/providers/custom:x/credential?path=${p}`, payload: { value: 'k' } })
    expect((await server.inject({ method: 'GET', url: `/files/agent/providers/custom:x/credentials?path=${p}` })).json().credentials.apiKey).toMatchObject({ present: true })

    const ws = AdfWorkspace.open(a.filePath)
    try {
      const config = ws.getAgentConfig()
      expect(config.model).toMatchObject({ provider: 'mock', model_id: 'mock-1' })
      expect(config.mcp?.servers?.map(s => s.name)).toEqual(['fs'])
      expect(config.adapters?.telegram).toBeDefined()
      expect(config.providers?.map(x => x.id)).toEqual(['custom:x'])
    } finally {
      ws.close()
    }

    const detachMcp = await server.inject({ method: 'DELETE', url: `/files/agent/mcp/servers/fs?path=${p}` })
    expect(detachMcp.json()).toMatchObject({ deletedCredentials: 1 })
    expect((await server.inject({ method: 'DELETE', url: `/files/agent/adapters/telegram?path=${p}` })).json()).toMatchObject({ deletedCredentials: 1 })
    expect((await server.inject({ method: 'DELETE', url: `/files/agent/providers/custom:x?path=${p}` })).json()).toMatchObject({ deletedCredentials: 1 })

    // Loaded: the same routes go through the running agent; changing the model is refused, as in Studio.
    const ref = await runtime.loadAgent(a.filePath, { enforceReviewGate: false })
    expect((await server.inject({ method: 'PUT', url: `/files/agent/model?path=${p}`, payload: { provider: 'mock', model_id: 'mock-2' } })).json().code).toBe('agent_running')
    const live = await server.inject({ method: 'POST', url: `/files/agent/mcp/servers?path=${p}`, payload: { server: { name: 'fs2', transport: 'stdio', command: 'node' } } })
    expect(live.json()).toMatchObject({ agentId: ref.id, loaded: true })
    expect(runtime.getAgentConfig(ref.id).config.mcp?.servers?.map(s => s.name)).toContain('fs2')
    expect((await server.inject({ method: 'GET', url: `/files/agent/tables?path=${p}` })).json().loaded).toBe(true)
  })
})

describe('daemon file routes: agents folder and tracked pushes from other routes', () => {
  it('answers the agents folder without an owner identity; a folder in the OS temp dir is ignored', async () => {
    // Never created: resolving the folder does not touch the disk.
    const folder = join(homedir(), `adf-test-agents-folder-${process.pid}`)
    const { server } = setup({ agentsFolder: folder })
    expect((await server.inject({ method: 'GET', url: '/files/agents-folder' })).json()).toEqual({ path: folder, source: 'setting', exists: false })
    expect(existsSync(folder)).toBe(false)
    const temp = setup({ agentsFolder: join(tempDir('adf-agents-'), 'mine') })
    const fallback = (await temp.server.inject({ method: 'GET', url: '/files/agents-folder' })).json()
    expect(fallback.source).toBe('default')
    expect(basename(fallback.path)).toBe('adf-agents')
  })

  it('re-syncs after other writes: a folder tracked elsewhere is watched, pushed and told to the mesh', async () => {
    const root = tempDir('adf-files-')
    const added = tempDir('adf-files-added-')
    const { server, settings, pushes, changes, watcher } = setup({ trackedDirectories: [root] })
    await server.ready()
    expect(watcher.watchedRoots()).toEqual([root])
    // As POST /agents/create does when it tracks the new agent's folder.
    settings.data.trackedDirectories = [root, added]
    await server.inject({ method: 'POST', url: '/agents/autostart', payload: { trackedDirs: [] } })
    expect(watcher.watchedRoots()).toEqual([root, added])
    expect(pushes).toContainEqual({ dirPath: added })
    expect(changes.at(-1)).toEqual([root, added])
  })
})

describe('accept-relocate (AgentFileOps.relocate)', () => {
  it('moves a reviewed file from an untracked place into the agents folder, tracks it and pushes file_renamed', async () => {
    const tracked = tempDir('adf-files-')
    const stranded = tempDir('adf-downloads-')
    const agentsFolder = join(tempDir('adf-home-'), 'adf-agents')
    const a = seedAgent(stranded, 'agent-1')
    const inTracked = seedAgent(tracked, 'agent-2')
    const settings = memorySettings({ trackedDirectories: [tracked] })
    const runtime = new RuntimeService({ settings: settings.store, providerFactory: () => new MockLLMProvider() })
    runtimes.push(runtime)
    const changes: string[][] = []
    const watcher = new TrackedDirWatcher({ runtime, settings: settings.store, watch: false, onTrackedDirectoriesChanged: d => changes.push(d) })
    watcher.start()
    const renames: FileRenamedPush[] = []
    watcher.on('file_renamed', p => renames.push(p))
    const files = new AgentFileOps({ runtime, settings: settings.store, events: watcher, agentsFolder: async () => agentsFolder })

    // Already under a tracked folder: stays where the owner put it.
    expect(await files.relocate(inTracked.filePath)).toEqual({})

    // Running: not moved; a temp-like folder is reported, never silently left.
    const ref = await runtime.loadAgent(a.filePath, { enforceReviewGate: false })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const busy = await files.relocate(a.filePath)
    warn.mockRestore()
    expect(busy.movedTo).toBeUndefined()
    expect(busy.moveError).toMatch(/temporary folder/)
    await runtime.unloadAgent(ref.id)

    const moved = await files.relocate(a.filePath)
    const dest = join(agentsFolder, 'agent-1.adf')
    expect(moved).toEqual({ movedTo: dest })
    expect(existsSync(a.filePath)).toBe(false)
    expect(existsSync(dest)).toBe(true)
    expect(settings.data.trackedDirectories).toEqual([tracked, dirname(dest)])
    expect(changes.at(-1)).toEqual([tracked, dirname(dest)])
    expect(renames).toEqual([{ oldPath: a.filePath, newPath: dest }])
    await watcher.close()
  })
})

describe('daemon file routes: path safety', () => {
  const win = process.platform === 'win32'

  it.runIf(win)('refuses device paths, alternate data streams, reserved names and UNC paths outside the tracked folders', async () => {
    const root = tempDir('adf-files-')
    const a = seedAgent(root, 'agent-1')
    writeFileSync(join(root, 'victim.txt'), 'keep me')
    const { server } = setup({ trackedDirectories: [root] })
    const del = async (p: string) => (await server.inject({ method: 'DELETE', url: `/files?path=${q(p)}` })).json()
    const BS = '\\'
    expect((await del(`${BS}${BS}?${BS}${a.filePath}`)).code).toBe('bad_path')
    expect((await del(`${BS}${BS}.${BS}${a.filePath}`)).code).toBe('bad_path')
    expect((await del(`${join(root, 'victim.txt')}:evil.adf`)).code).toBe('bad_path')
    expect((await del(join(root, 'NUL.adf'))).code).toBe('bad_path')
    expect((await del(join(root, 'con.agent.adf'))).code).toBe('bad_path')
    const unc = `${BS}${BS}localhost${BS}${a.filePath[0]}$${a.filePath.slice(2)}`
    expect((await del(unc)).code).toBe('unc_not_allowed')
    expect(existsSync(a.filePath)).toBe(true)
    expect(readFileSync(join(root, 'victim.txt'), 'utf-8')).toBe('keep me')
  })

  it.runIf(win)('checks .adf on the canonical path: an 8.3 short name cannot reach a .adfx file', async () => {
    const root = tempDir('adf-files-')
    const precious = join(root, 'precious.adfx')
    writeFileSync(precious, 'precious')
    let short = ''
    try {
      short = execFileSync('cmd', ['/d', '/s', '/c', `"for %I in ("${precious}") do @echo %~sI"`], { encoding: 'utf-8', windowsHide: true, windowsVerbatimArguments: true }).trim()
    } catch { /* no cmd */ }
    if (!short.toLowerCase().endsWith('.adf')) return // 8.3 names are off on this volume
    expect(short).not.toBe(precious)
    const { server } = setup({ trackedDirectories: [root] })
    const res = (await server.inject({ method: 'DELETE', url: `/files?path=${q(short)}` })).json()
    expect(res.code).toBe('not_an_adf')
    expect(existsSync(precious)).toBe(true)
  })

  it('refuses a link named .adf to another file, and destructive ops through links', async () => {
    const root = tempDir('adf-files-')
    const outside = tempDir('adf-outside-')
    const target = seedAgent(outside, 'agent-2')
    const victim = join(root, 'victim.txt')
    writeFileSync(victim, 'keep me')
    const { server } = setup({ trackedDirectories: [root] })

    const evil = join(root, 'evil.adf')
    let fileLinks = true
    try { symlinkSync(victim, evil, 'file'); links.push(evil) } catch { fileLinks = false } // needs Developer Mode on Windows
    if (fileLinks) {
      expect((await server.inject({ method: 'DELETE', url: `/files?path=${q(evil)}` })).json().code).toBe('not_an_adf')
      expect((await server.inject({ method: 'GET', url: `/files/snapshot?path=${q(evil)}&mode=export` })).json().code).toBe('not_an_adf')
      expect(readFileSync(victim, 'utf-8')).toBe('keep me')
    }

    // A folder link (a junction on Windows) to a real agent: reading is fine, deleting or renaming through it is not.
    const dirLink = join(root, 'linked')
    symlinkSync(outside, dirLink, win ? 'junction' : 'dir')
    links.push(dirLink)
    const through = join(dirLink, 'agent-2.adf')
    expect((await server.inject({ method: 'GET', url: `/files/agent?path=${q(through)}` })).json().filePath).toBe(target.filePath)
    expect((await server.inject({ method: 'DELETE', url: `/files?path=${q(through)}` })).json().code).toBe('path_not_canonical')
    expect((await server.inject({ method: 'POST', url: '/files/rename', payload: { path: through, newName: 'x' } })).json().code).toBe('path_not_canonical')
    expect(existsSync(target.filePath)).toBe(true)
  })

  it('renames by case only', async () => {
    const root = tempDir('adf-files-')
    const a = seedAgent(root, 'agent-1')
    const { server } = setup({ trackedDirectories: [root] })
    const res = await server.inject({ method: 'POST', url: '/files/rename', payload: { path: a.filePath, newName: 'Agent-1' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().filePath).toBe(join(root, 'Agent-1.adf'))
  })
})

describe('daemon file routes: leases and read-only reads', () => {
  it('refuses to write, move or delete a file another runtime runs (409 agent_leased); reads still work, read-only', async () => {
    const root = tempDir('adf-files-')
    const a = seedAgent(root, 'agent-1')
    const b = seedAgent(root, 'agent-2')
    const other = new AgentLeaseRegistry({ dir: processAgentLeases().dir, kind: 'studio-embedded', settingsPath: join(root, 'other-settings.json') })
    expect((await other.acquire(a.filePath, { agentId: a.id })).ok).toBe(true)
    try {
      const { server } = setup({ trackedDirectories: [root], providers: [{ id: 'mock', type: 'openai-compatible', name: 'Mock', baseUrl: 'http://127.0.0.1:1/v1' }] })
      const p = q(a.filePath)
      const code = async (method: 'DELETE' | 'POST' | 'PUT', url: string, payload?: object) =>
        (await server.inject({ method, url, ...(payload ? { payload } : {}) })).json().code
      expect(await code('DELETE', `/files?path=${p}`)).toBe('agent_leased')
      expect(await code('POST', '/files/rename', { path: a.filePath, newName: 'agent-3' })).toBe('agent_leased')
      expect(await code('PUT', `/files/agent/model?path=${p}`, { provider: 'mock', model_id: 'm' })).toBe('agent_leased')
      expect(await code('POST', `/files/agent/mcp/servers?path=${p}`, { server: { name: 'fs', transport: 'stdio', command: 'node' } })).toBe('agent_leased')
      expect(await code('POST', '/files/save-as', { path: b.filePath, destPath: a.filePath, overwrite: true })).toBe('agent_leased')
      const msg = (await server.inject({ method: 'DELETE', url: `/files?path=${p}` })).json().error
      expect(msg).toMatch(/agent-1 is already running in another ADF Studio/)
      expect(existsSync(a.filePath)).toBe(true)

      // Reads open the file read-only: nothing written.
      const mtime = statSync(a.filePath).mtimeMs
      expect((await server.inject({ method: 'GET', url: `/files/agent/tables?path=${p}` })).statusCode).toBe(200)
      expect((await server.inject({ method: 'GET', url: `/files/agent/mcp/credentials?path=${p}&npmPackage=fs` })).statusCode).toBe(200)
      expect(statSync(a.filePath).mtimeMs).toBe(mtime)
    } finally {
      await other.close()
    }
  })

  it('deletes credentials by exact prefix: LIKE wildcards and case never reach other servers', async () => {
    const root = tempDir('adf-files-')
    const a = seedAgent(root, 'agent-1')
    const { server, runtime } = setup({ trackedDirectories: [root] })
    const p = q(a.filePath)
    const put = (npmPackage: string) => server.inject({ method: 'PUT', url: `/files/agent/mcp/credentials?path=${p}`, payload: { npmPackage, envKey: 'KEY', value: 'v' } })
    for (const pkg of ['a_b', 'aXb', 'A_B', 'a%b']) await put(pkg)
    const detached = (await server.inject({ method: 'DELETE', url: `/files/agent/mcp/servers/a_b?path=${p}` })).json()
    expect(detached.deletedCredentials).toBe(1)
    const left = async (pkg: string) => Object.keys((await server.inject({ method: 'GET', url: `/files/agent/mcp/credentials?path=${p}&npmPackage=${encodeURIComponent(pkg)}` })).json().credentials)
    expect(await left('aXb')).toEqual(['KEY'])
    expect(await left('A_B')).toEqual(['KEY'])
    expect(await left('a_b')).toEqual([])

    // Same through a running agent.
    await runtime.loadAgent(a.filePath, { enforceReviewGate: false })
    const live = (await server.inject({ method: 'DELETE', url: `/files/agent/mcp/servers/a%25b?path=${p}` })).json()
    expect(live).toMatchObject({ loaded: true, deletedCredentials: 1 })
    expect(await left('aXb')).toEqual(['KEY'])
  })
})

describe('daemon file routes: rename keeps the mesh registration', () => {
  it('a running agent renamed stays registered with the mesh until it stops', async () => {
    const root = tempDir('adf-files-')
    const a = seedAgent(root, 'agent-1')
    const { server, runtime } = setup({ trackedDirectories: [root] })
    // The daemon's own wiring (daemon/index.ts): register on load, unregister on unload.
    const mesh = new MeshManager([root])
    mesh.enableMesh()
    runtime.on('agent-loaded', e => {
      if (!e.filePath) return
      mesh.registerServableAgent(e.filePath, e.ref.config, e.agent.registry, e.agent.workspace, e.agent.session,
        e.agent.executor, e.agent.adfCallHandler ?? null, e.agent.codeSandboxService as never, e.agent.triggerEvaluator)
    })
    runtime.on('agent-unloaded', e => { if (e.filePath) mesh.unregisterAgent(e.filePath) })
    try {
      const ref = await runtime.loadAgent(a.filePath, { enforceReviewGate: false })
      const registered = () => mesh.getAgentStatuses().map(s => (s as { filePath?: string }).filePath)
      expect(registered()).toContain(a.filePath)
      const res = await server.inject({ method: 'POST', url: '/files/rename', payload: { path: a.filePath, newName: 'agent-9' } })
      expect(res.json().renameDeferred).toBe(true)
      expect(registered()).toContain(a.filePath)
      await runtime.unloadAgent(ref.id)
      expect(registered()).not.toContain(a.filePath)
    } finally {
      mesh.disableMesh()
    }
  })
})

describe('daemon file routes: re-review fixes', () => {
  it('a client still sending an oversized upload receives the 413 JSON over a real socket', async () => {
    const root = tempDir('adf-files-')
    const a = seedAgent(root, 'agent-1')
    const { server, runtime } = setup({ trackedDirectories: [root] }, { rawFileBodyLimit: MIB })
    const ref = await runtime.loadAgent(a.filePath, { enforceReviewGate: false })
    await server.listen({ port: 0, host: '127.0.0.1' })
    const { port } = server.server.address() as AddressInfo
    const result = await new Promise<{ status: number; body: string }>((resolveResult, reject) => {
      const req = httpRequest({
        host: '127.0.0.1', port, method: 'PUT', path: `/agents/${ref.id}/files/raw?path=big.bin`,
        headers: { 'content-type': 'application/octet-stream', 'transfer-encoding': 'chunked' },
      }, (res) => {
        let body = ''
        res.setEncoding('utf-8')
        res.on('data', (c: string) => { body += c })
        res.on('end', () => resolveResult({ status: res.statusCode ?? 0, body }))
        res.on('error', reject)
      })
      req.on('error', reject)
      const chunk = Buffer.alloc(64 * 1024, 7)
      let sent = 0
      let answered = false
      req.once('response', () => { answered = true; req.end() })
      const pump = () => {
        while (!answered && sent < 6 * MIB) {
          sent += chunk.length
          if (!req.write(chunk)) { req.once('drain', pump); return }
        }
        if (!answered) req.end()
      }
      pump()
    })
    expect(result.status).toBe(413)
    expect(JSON.parse(result.body)).toMatchObject({ code: 'too_large' })
  })

  it('an upload whose id or DID is known here gets a fresh id and no identity: reviewed, loaded, or in a tracked folder', async () => {
    const root = tempDir('adf-files-')
    const other = tempDir('adf-files-other-')
    const reviewed = seedAgent(tempDir('adf-src-'), 'agent-1')
    const loadedSrc = seedAgent(tempDir('adf-src-'), 'agent-2')
    const trackedOne = seedAgent(other, 'agent-3')
    const fresh = seedAgent(tempDir('adf-src-'), 'agent-4')
    for (const f of [reviewed, loadedSrc, trackedOne, fresh]) {
      const ws = AdfWorkspace.open(f.filePath)
      try { ws.generateIdentityKeys(null) } finally { ws.close() }
    }
    const didOf = (file: string) => { const ws = AdfWorkspace.open(file); try { return ws.getDid() } finally { ws.close() } }
    const { server, runtime } = setup({ trackedDirectories: [root, other], reviewedAgents: { [reviewed.id]: 'accepted' } })
    await runtime.loadAgent(loadedSrc.filePath, { enforceReviewGate: false }) // loaded, never reviewed
    const upload = async (file: string, name: string) => (await server.inject({
      method: 'POST', url: `/files/import?directory=${q(root)}&name=${name}`, payload: readFileSync(file), headers: { 'content-type': 'application/octet-stream' },
    })).json()

    for (const [src, name, reason] of [[reviewed, 'up-1', 'reviewed'], [loadedSrc, 'up-2', 'loaded'], [trackedOne, 'up-3', 'tracked']] as const) {
      const body = await upload(src.filePath, name)
      expect(body.idReassigned).toEqual({ previousId: src.id, reason, identityStripped: true })
      expect(body.agentId).not.toBe(src.id)
      expect(didOf(body.filePath)).toBeNull()
    }
    // Nothing known: the agent arrives as it is (id and DID kept), still unreviewed.
    const kept = await upload(fresh.filePath, 'up-4')
    expect(kept).toMatchObject({ agentId: fresh.id, reviewed: false })
    expect(kept.idReassigned).toBeUndefined()
    expect(didOf(kept.filePath)).toBe(didOf(fresh.filePath))
    // Loading by the source's id still finds the source, not the upload.
    expect(runtime.listAgents().map(x => x.filePath)).toEqual([loadedSrc.filePath])
  })

  it('refuses reserved device names on rename on every OS', async () => {
    const root = tempDir('adf-files-')
    const a = seedAgent(root, 'agent-1')
    const { server } = setup({ trackedDirectories: [root] })
    for (const name of ['CON', 'nul', 'com1', 'Lpt9.backup']) {
      expect((await server.inject({ method: 'POST', url: '/files/rename', payload: { path: a.filePath, newName: name } })).json().code).toBe('invalid_name')
    }
    expect(existsSync(a.filePath)).toBe(true)
  })

  it('applies a pending rename when the agent unloads after the server closed (daemon shutdown order; RuntimeService renames)', async () => {
    const root = tempDir('adf-files-')
    const a = seedAgent(root, 'agent-1')
    const { server, runtime } = setup({ trackedDirectories: [root] })
    const ref = await runtime.loadAgent(a.filePath, { enforceReviewGate: false })
    expect((await server.inject({ method: 'POST', url: '/files/rename', payload: { path: a.filePath, newName: 'agent-7' } })).json().renameDeferred).toBe(true)
    await server.close()
    await runtime.unloadAgent(ref.id, { mode: 'immediate' })
    const renamed = join(root, 'agent-7.adf')
    for (let i = 0; i < 50 && !existsSync(renamed); i++) await tick(20)
    expect(existsSync(renamed)).toBe(true)
  })

  it('the /agents/:id detach routes delete credentials by exact prefix too (shared AdfDatabase helper)', async () => {
    const root = tempDir('adf-files-')
    const a = seedAgent(root, 'agent-1')
    const { server, runtime } = setup({ trackedDirectories: [root] })
    const ref = await runtime.loadAgent(a.filePath, { enforceReviewGate: false })
    for (const pkg of ['a_b', 'aXb', 'A_B']) runtime.setAgentMcpCredential(ref.id, pkg, 'KEY', 'v')
    const res = (await server.inject({ method: 'DELETE', url: `/agents/${ref.id}/mcp/servers/a_b` })).json()
    expect(res.deletedCredentials).toBe(1)
    expect(Object.keys(runtime.getAgentMcpCredentials(ref.id, 'aXb').credentials)).toEqual(['KEY'])
    expect(Object.keys(runtime.getAgentMcpCredentials(ref.id, 'A_B').credentials)).toEqual(['KEY'])
    const ws = runtime.listLiveAgents()[0].workspace
    expect(ws.listIdentityPurposes('mcp:a')).toEqual(expect.arrayContaining(['mcp:aXb:KEY']))
    expect(ws.listIdentityPurposes('mcp:a%')).toEqual([])
    expect(AdfDatabase.peekIdentityPurposes(a.filePath, 'mcp:A_')).toEqual(['mcp:A_B:KEY'])
  })

  it('daemon/index.ts wires the watcher into the routes and closes it at shutdown', () => {
    const source = readFileSync(join(__dirname, '../src/main/daemon/index.ts'), 'utf-8')
    expect(source).toMatch(/const trackedDirWatcher = new TrackedDirWatcher\(\{\s*runtime,\s*settings,\s*onTrackedDirectoriesChanged: \(dirs\) => meshManager\.setTrackedDirectories\(dirs\),/)
    expect(source).toMatch(/routes: \{[^}]*\}\), trackedDirWatcher \}/)
    expect(source).toMatch(/onShutdown: \[\s*\(\) => trackedDirWatcher\.close\(\),/)
  })
})

describe('daemon file routes: delete with a pending rename', () => {
  it('deleting a running agent with a deferred rename deletes the file, not a renamed copy', async () => {
    const root = tempDir('adf-files-')
    const a = seedAgent(root, 'agent-1')
    const { server, runtime } = setup({ trackedDirectories: [root] })
    await runtime.loadAgent(a.filePath, { enforceReviewGate: false })
    expect((await server.inject({ method: 'POST', url: '/files/rename', payload: { path: a.filePath, newName: 'agent-5' } })).json().renameDeferred).toBe(true)
    expect((await server.inject({ method: 'DELETE', url: `/files?path=${q(a.filePath)}` })).json()).toMatchObject({ success: true, stopped: true })
    await tick(50)
    expect(existsSync(a.filePath)).toBe(false)
    expect(existsSync(join(root, 'agent-5.adf'))).toBe(false)
  })
})

describe('daemon file routes: final-check fixes', () => {
  it('a case-only rename of a running agent is applied when it stops', async () => {
    const root = tempDir('adf-files-')
    const a = seedAgent(root, 'agent-1')
    const { server, runtime, renames } = setup({ trackedDirectories: [root] })
    const ref = await runtime.loadAgent(a.filePath, { enforceReviewGate: false })
    expect((await server.inject({ method: 'POST', url: '/files/rename', payload: { path: a.filePath, newName: 'Agent-1' } })).json().renameDeferred).toBe(true)
    await runtime.unloadAgent(ref.id)
    const newPath = join(root, 'Agent-1.adf')
    for (let i = 0; i < 50 && renames.length === 0; i++) await tick(20)
    expect(readdirSync(root).filter(n => n.endsWith('.adf'))).toEqual(['Agent-1.adf'])
    expect(renames).toEqual([{ oldPath: a.filePath, newPath }])
    const ws = AdfWorkspace.open(newPath)
    try { expect(ws.getAgentConfig().name).toBe('Agent-1') } finally { ws.close() }
  })

  it.runIf(process.platform !== 'win32')('DELETE drops a pending rename even when the file name is not a valid new name (":" on POSIX)', async () => {
    const root = tempDir('adf-files-')
    const a = seedAgent(root, 'agent:1')
    const { server, runtime } = setup({ trackedDirectories: [root] })
    await runtime.loadAgent(a.filePath, { enforceReviewGate: false })
    expect((await server.inject({ method: 'POST', url: '/files/rename', payload: { path: a.filePath, newName: 'agent-2' } })).json().renameDeferred).toBe(true)
    expect((await server.inject({ method: 'DELETE', url: `/files?path=${q(a.filePath)}` })).json()).toMatchObject({ success: true, stopped: true })
    await tick(50)
    expect(readdirSync(root).filter(n => n.endsWith('.adf'))).toEqual([])
  })

  it('cancelPendingRename drops the pending name without validating it', async () => {
    const root = tempDir('adf-files-')
    const a = seedAgent(root, 'agent-1')
    const { runtime } = setup({ trackedDirectories: [root] })
    await runtime.loadAgent(a.filePath, { enforceReviewGate: false })
    expect(runtime.syncAgentFileToName(a.filePath, 'agent-3')).toEqual({ deferred: true })
    expect(runtime.cancelPendingRename(a.filePath)).toBe('agent-3')
    expect(runtime.getPendingRename(a.filePath)).toBeUndefined()
  })
})
