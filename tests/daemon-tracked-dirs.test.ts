import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  const dir = join(tmpdir(), `adf-daemon-tracked-dirs-${process.pid}`)
  return {
    app: {
      getPath: () => dir,
      on: () => {},
      getName: () => 'adf-daemon-tracked-dirs-test',
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

import { createDaemonHttpApi } from '../src/main/daemon/http-api'
import { RuntimeService } from '../src/main/runtime/runtime-service'
import { createHeadlessAgent, MockLLMProvider } from '../src/main/runtime/headless'

const servers: Array<{ close: () => Promise<unknown> }> = []
const runtimes: RuntimeService[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()))
  // unloadAgent, not shutdownAll: shutdownAll latches the process-wide RuntimeGate teardown.
  for (const runtime of runtimes.splice(0)) {
    for (const agent of runtime.listAgents()) await runtime.unloadAgent(agent.id, { mode: 'immediate' })
  }
})

/** An agent file on disk; returns its id. */
function seedAgent(dir: string, name: string, autostart = true): string {
  const created = createHeadlessAgent({
    filePath: join(dir, `${name}.adf`),
    name,
    provider: new MockLLMProvider(),
    createOptions: { handle: name, autostart },
  })
  const id = created.workspace.getAgentConfig().id
  created.dispose()
  return id
}

/** In-memory settings store — never the user's real settings file. */
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

function setup(initial: Record<string, unknown> = {}) {
  const settings = memorySettings(initial)
  const runtime = new RuntimeService({
    settings: settings.store,
    providerFactory: () => new MockLLMProvider({ tokensPerResponse: 40 }),
  })
  runtimes.push(runtime)
  const changes: string[][] = []
  const server = createDaemonHttpApi(runtime, { settingsStore: settings.store, onTrackedDirectoriesChanged: dirs => changes.push(dirs) })
  servers.push(server)
  return { runtime, server, settings, changes }
}

describe('daemon tracked folders API', () => {
  it('tracks a folder now: persists, notifies the live daemon, autostarts reviewed agents and reports the rest', async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'adf-tracked-')))
    const reviewedId = seedAgent(root, 'agent-1')
    mkdirSync(join(root, 'sub'))
    const unreviewedId = seedAgent(join(root, 'sub'), 'agent-2')
    writeFileSync(join(root, 'not-a-dir.txt'), 'x')

    const { runtime, server, settings, changes } = setup({ reviewedAgents: [reviewedId] })

    expect((await server.inject({ method: 'GET', url: '/tracked-dirs' })).json()).toEqual({ maxDepth: 5, directories: [] })

    const bad = async (path: unknown) => (await server.inject({ method: 'POST', url: '/tracked-dirs', payload: { path } })).statusCode
    expect(await bad(undefined)).toBe(400)
    expect(await bad('relative/dir')).toBe(400)
    expect(await bad(join(root, 'missing'))).toBe(400)
    expect(await bad(join(root, 'not-a-dir.txt'))).toBe(400)
    expect(changes).toEqual([])

    const tracked = await server.inject({ method: 'POST', url: '/tracked-dirs', payload: { path: root } })
    expect(tracked.statusCode).toBe(201)
    const body = tracked.json()
    expect(body.directories).toEqual([root])
    expect(body.absorbed).toEqual([])
    expect(body.entry).toEqual({ path: root, exists: true, agentCount: 2, loadedCount: 1 })
    expect(body.autostart.started).toEqual([expect.objectContaining({ agentId: reviewedId })])
    expect(body.needsReview).toEqual([expect.objectContaining({ agentId: unreviewedId, reason: 'unreviewed' })])
    expect(settings.data.trackedDirectories).toEqual([root])
    expect(changes).toEqual([[root]])
    expect(runtime.listAgents().map(a => a.id)).toEqual([reviewedId])

    // Same folder under another spelling, or a folder already covered → 409.
    const again = await server.inject({ method: 'POST', url: '/tracked-dirs', payload: { path: `${process.platform === 'win32' ? root.toUpperCase() : root}${sep}` } })
    expect(again.statusCode).toBe(409)
    expect(again.json().coveredBy).toBe(root)
    const covered = await server.inject({ method: 'POST', url: '/tracked-dirs', payload: { path: join(root, 'sub') } })
    expect(covered.statusCode).toBe(409)

    const listed = (await server.inject({ method: 'GET', url: '/tracked-dirs' })).json()
    expect(listed.directories).toEqual([{ path: root, exists: true, agentCount: 2, loadedCount: 1 }])
  })

  it('reports every agent in the folder and where it stands, with load errors (POST result + GET /tracked-dirs/agents)', async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'adf-tracked-agents-')))
    const readyId = seedAgent(root, 'agent-1')
    seedAgent(root, 'agent-2') // autostart, never reviewed
    const manualId = seedAgent(root, 'agent-3', false) // reviewed, not autostart
    const failingId = seedAgent(root, 'agent-4') // reviewed, its provider fails to build
    writeFileSync(join(root, 'broken.adf'), 'not a sqlite file')

    const settings = memorySettings({ reviewedAgents: [readyId, manualId, failingId] })
    const runtime = new RuntimeService({
      settings: settings.store,
      providerFactory: (config: { name?: string }) => {
        if (config.name === 'agent-4') throw new Error('Provider "anthropic" not found. Configure it in Settings → Providers.')
        return new MockLLMProvider({ tokensPerResponse: 40 })
      },
    })
    runtimes.push(runtime)
    const server = createDaemonHttpApi(runtime, { settingsStore: settings.store })
    servers.push(server)

    const res = await server.inject({ method: 'POST', url: '/tracked-dirs', payload: { path: root } })
    expect(res.statusCode).toBe(201)
    const byName = (list: Array<{ name: string }>) => Object.fromEntries(list.map(a => [a.name, a]))
    const tracked = byName(res.json().agents)
    expect(tracked['agent-1']).toEqual(expect.objectContaining({ status: 'loaded', agentId: readyId, autostart: true, reviewed: true }))
    expect(tracked['agent-2']).toEqual(expect.objectContaining({ status: 'needs_review', autostart: true, reviewed: false }))
    expect(tracked['agent-3']).toEqual(expect.objectContaining({ status: 'not_autostart', autostart: false, reviewed: true }))
    expect(tracked['agent-4']).toEqual(expect.objectContaining({ status: 'stopped', error: expect.stringContaining('Provider "anthropic" not found') }))
    expect(tracked.broken).toEqual(expect.objectContaining({ status: 'unreadable', error: expect.any(String) }))

    // The same list on demand (load errors are only known to the pass that hit them).
    const listed = await server.inject({ method: 'GET', url: `/tracked-dirs/agents?path=${encodeURIComponent(root + sep)}` })
    expect(listed.statusCode).toBe(200)
    expect(listed.json().path).toBe(root)
    const now = byName(listed.json().agents)
    expect(Object.keys(now).sort()).toEqual(['agent-1', 'agent-2', 'agent-3', 'agent-4', 'broken'])
    expect(now['agent-2'].status).toBe('needs_review')
    expect(now['agent-4']).toEqual(expect.objectContaining({ status: 'stopped' }))
    expect(now['agent-4'].error).toBeUndefined()

    // Review + accept, then load: it lists as loaded.
    expect((await server.inject({ method: 'POST', url: '/agents/review/accept', payload: { filePath: join(root, 'agent-2.adf') } })).statusCode).toBe(200)
    expect((await server.inject({ method: 'POST', url: '/agents/load', payload: { filePath: join(root, 'agent-2.adf'), requireReview: true } })).statusCode).toBe(200)
    const after = byName((await server.inject({ method: 'GET', url: `/tracked-dirs/agents?path=${encodeURIComponent(root)}` })).json().agents)
    expect(after['agent-2']).toEqual(expect.objectContaining({ status: 'loaded', reviewed: true }))

    expect((await server.inject({ method: 'GET', url: '/tracked-dirs/agents' })).statusCode).toBe(400)
    expect((await server.inject({ method: 'GET', url: `/tracked-dirs/agents?path=${encodeURIComponent(join(root, 'nope'))}` })).statusCode).toBe(404)
  })

  it('a new parent absorbs tracked subfolders', async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'adf-tracked-parent-')))
    const sub = join(root, 'team')
    mkdirSync(sub)
    const { server, settings } = setup({ trackedDirectories: [sub] })
    const res = await server.inject({ method: 'POST', url: '/tracked-dirs', payload: { path: root } })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toEqual(expect.objectContaining({ absorbed: [sub], directories: [root] }))
    expect(settings.data.trackedDirectories).toEqual([root])
  })

  it('untracks without touching files; unload=true also unloads the folder\'s agents', async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'adf-untrack-')))
    const id = seedAgent(root, 'agent-1')
    const gone = join(tmpdir(), `adf-untrack-missing-${process.pid}`)
    const { runtime, server, settings, changes } = setup({ reviewedAgents: [id], trackedDirectories: [gone] })

    // A folder that no longer exists still lists (exists:false) and untracks by its stored string.
    expect((await server.inject({ method: 'GET', url: '/tracked-dirs' })).json().directories)
      .toEqual([{ path: gone, exists: false, agentCount: 0, loadedCount: 0 }])
    expect((await server.inject({ method: 'DELETE', url: `/tracked-dirs?path=${encodeURIComponent(gone)}` })).json())
      .toEqual({ removed: gone, directories: [], unloaded: [] })

    await server.inject({ method: 'POST', url: '/tracked-dirs', payload: { path: root } })
    expect(runtime.listAgents()).toHaveLength(1)

    const kept = await server.inject({ method: 'DELETE', url: `/tracked-dirs?path=${encodeURIComponent(root)}` })
    expect(kept.statusCode).toBe(200)
    expect(kept.json()).toEqual({ removed: root, directories: [], unloaded: [] })
    expect(runtime.listAgents()).toHaveLength(1)

    await server.inject({ method: 'POST', url: '/tracked-dirs', payload: { path: root } })
    const unloaded = await server.inject({ method: 'DELETE', url: `/tracked-dirs?path=${encodeURIComponent(root + sep)}&unload=true` })
    expect(unloaded.statusCode).toBe(200)
    expect(unloaded.json()).toEqual({ removed: root, directories: [], unloaded: [expect.objectContaining({ agentId: id, name: 'agent-1' })] })
    expect(runtime.listAgents()).toHaveLength(0)
    expect(settings.data.trackedDirectories).toEqual([])
    expect(changes.at(-1)).toEqual([])
    expect(realpathSync.native(join(root, 'agent-1.adf'))).toBeTruthy()

    expect((await server.inject({ method: 'DELETE', url: `/tracked-dirs?path=${encodeURIComponent(root)}` })).statusCode).toBe(404)
    expect((await server.inject({ method: 'DELETE', url: '/tracked-dirs' })).statusCode).toBe(400)
    expect((await server.inject({ method: 'DELETE', url: `/tracked-dirs?path=${encodeURIComponent(root)}&unload=yes` })).statusCode).toBe(400)
  })

  it('answers 503 without a settings store and 405 for a read-only one', async () => {
    const runtime = new RuntimeService({ enforceReviewGate: false })
    runtimes.push(runtime)
    const none = createDaemonHttpApi(runtime)
    servers.push(none)
    expect((await none.inject({ method: 'GET', url: '/tracked-dirs' })).statusCode).toBe(503)
    const readOnly = createDaemonHttpApi(runtime, { settingsStore: { get: () => undefined } })
    servers.push(readOnly)
    expect((await readOnly.inject({ method: 'POST', url: '/tracked-dirs', payload: { path: tmpdir() } })).statusCode).toBe(405)
  })
})
