import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
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
import { processAgentLeases } from '../src/main/runtime/agent-lease'
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

function setup(initial: Record<string, unknown> = {}, opts: { runtime?: RuntimeService; rawFileBodyLimit?: number } = {}) {
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

  it('calls RuntimeService.rekeyAgentPath after a move when the runtime has it (W1-A)', async () => {
    const root = tempDir('adf-files-')
    const a = seedAgent(root, 'agent-1')
    const settings = memorySettings({ trackedDirectories: [root] })
    const runtime = new RuntimeService({ settings: settings.store, providerFactory: () => new MockLLMProvider() })
    // TODO(W1-A): stub until RuntimeService.rekeyAgentPath lands; then assert on the real re-key.
    const rekeyAgentPath = vi.fn(async () => {})
    Object.assign(runtime, { rekeyAgentPath })
    const { server } = setup({ trackedDirectories: [root] }, { runtime })
    await server.inject({ method: 'POST', url: '/files/rename', payload: { path: a.filePath, newName: 'agent-2' } })
    expect(rekeyAgentPath).toHaveBeenCalledWith(a.filePath, join(root, 'agent-2.adf'))
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
    const saved = await server.inject({ method: 'POST', url: '/files/save-as', payload: { path: a.filePath, destPath: dest, mode: 'export' } })
    expect(saved.json()).toMatchObject({ success: true, filePath: dest })
    expect(existsSync(dest)).toBe(true)
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
