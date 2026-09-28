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
function seedAgent(dir: string, name: string): string {
  const created = createHeadlessAgent({
    filePath: join(dir, `${name}.adf`),
    name,
    provider: new MockLLMProvider(),
    createOptions: { handle: name, autostart: true },
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
