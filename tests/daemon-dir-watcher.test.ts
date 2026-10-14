import { copyFileSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  const dir = join(tmpdir(), `adf-daemon-dir-watcher-${process.pid}`)
  return {
    app: { getPath: () => dir, on: () => {}, getName: () => 'adf-daemon-dir-watcher-test', getVersion: () => '0.0.0-test' },
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

import type { ChokidarOptions } from 'chokidar'
import { TrackedDirWatcher, type DirWatchHandle, type TrackedDirsPush, type WatcherAutostartNotice } from '../src/main/daemon/dir-watcher'
import { clearPeekCache, listFolderAgents } from '../src/main/daemon/tracked-dirs'
import { RuntimeService } from '../src/main/runtime/runtime-service'
import { createHeadlessAgent, MockLLMProvider } from '../src/main/runtime/headless'
import { AgentLeaseRegistry } from '../src/main/runtime/agent-lease'

const cleanups: Array<() => Promise<unknown> | unknown> = []

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) {
    try { await fn() } catch { /* best effort */ }
  }
  clearPeekCache()
})

function tempDir(prefix: string): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), prefix)))
}

function seedAgent(dir: string, name: string, autostart: boolean): { id: string; filePath: string } {
  const filePath = join(dir, `${name}.adf`)
  const created = createHeadlessAgent({
    filePath,
    name,
    provider: new MockLLMProvider(),
    createOptions: { handle: name, autostart, start_in_state: 'hibernate' },
  })
  const id = created.workspace.getAgentConfig().id
  created.dispose()
  return { id, filePath }
}

function memorySettings(initial: Record<string, unknown>) {
  const data: Record<string, unknown> = { ...initial }
  return { data, store: { get: (k: string) => data[k], set: (k: string, v: unknown) => { data[k] = v } } }
}

function runtimeFor(settings: { get(k: string): unknown }, agentLeases?: AgentLeaseRegistry): RuntimeService {
  const runtime = new RuntimeService({
    settings,
    providerFactory: () => new MockLLMProvider({ tokensPerResponse: 10 }),
    ...(agentLeases ? { agentLeases } : {}),
  })
  cleanups.push(async () => {
    for (const agent of runtime.listAgents()) await runtime.unloadAgent(agent.id, { mode: 'immediate' })
  })
  return runtime
}

/** A watcher factory whose events the test fires by hand. */
function fakeWatch() {
  const calls: Array<{ paths: string[]; options: ChokidarOptions }> = []
  let current: EventEmitter & { closed?: boolean } = new EventEmitter()
  const factory = (paths: string[], options: ChokidarOptions): DirWatchHandle => {
    calls.push({ paths, options })
    current = Object.assign(new EventEmitter(), { closed: false })
    const handle = current
    return {
      on: (event: string, listener: (...args: any[]) => void) => handle.on(event, listener),
      close: async () => { handle.closed = true },
    } as DirWatchHandle
  }
  return { factory, calls, fire: (event: 'add' | 'unlink', path: string) => current.emit(event, path) }
}

function watcherFor(runtime: RuntimeService, settings: { get(k: string): unknown; set?(k: string, v: unknown): void }, extra: Partial<ConstructorParameters<typeof TrackedDirWatcher>[0]> = {}) {
  const watcher = new TrackedDirWatcher({ runtime, settings, debounceMs: 20, ...extra })
  cleanups.push(() => watcher.close())
  const pushes: TrackedDirsPush[] = []
  const notices: WatcherAutostartNotice[] = []
  watcher.on('tracked_dirs', p => pushes.push(p))
  watcher.on('autostart', n => notices.push(n))
  return { watcher, pushes, notices }
}

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('tracked-dir watcher', () => {
  it('watches the tracked roots to the scan depth, skipping dot folders, node_modules and non-.adf files', async () => {
    const root = tempDir('adf-watch-')
    const settings = memorySettings({ trackedDirectories: [root], maxDirectoryScanDepth: 3 })
    const fake = fakeWatch()
    const { watcher } = watcherFor(runtimeFor(settings.store), settings.store, { watchFactory: fake.factory })
    watcher.start()
    await wait(10)
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0].paths).toEqual([root])
    expect(fake.calls[0].options).toMatchObject({ ignoreInitial: true, depth: 3 })
    const ignored = fake.calls[0].options.ignored as (p: string, s?: { isFile(): boolean }) => boolean
    const file = { isFile: () => true }
    const dir = { isFile: () => false }
    expect(ignored(join(root, '.git'), dir)).toBe(true)
    expect(ignored(join(root, 'node_modules'), dir)).toBe(true)
    expect(ignored(join(root, 'notes.txt'), file)).toBe(true)
    expect(ignored(join(root, 'sub'), dir)).toBe(false)
    expect(ignored(join(root, 'agent-1.adf'), file)).toBe(false)
    // Same set again: no re-watch.
    watcher.sync()
    await wait(10)
    expect(fake.calls).toHaveLength(1)
  })

  it('autostarts a new reviewed autostart file only (never a stopped sibling), and coalesces pushes per root', async () => {
    const root = tempDir('adf-watch-')
    const sibling = seedAgent(root, 'agent-2', true)
    const settings = memorySettings({ trackedDirectories: [root], reviewedAgents: [] })
    const runtime = runtimeFor(settings.store)
    const fake = fakeWatch()
    const { watcher, pushes, notices } = watcherFor(runtime, settings.store, { watchFactory: fake.factory })
    watcher.start()
    await wait(10)

    const fresh = seedAgent(root, 'agent-1', true)
    const unreviewed = seedAgent(root, 'agent-3', true)
    settings.data.reviewedAgents = [fresh.id, sibling.id]
    fake.fire('add', fresh.filePath)
    fake.fire('add', unreviewed.filePath)
    fake.fire('add', join(root, 'notes.txt')) // not an agent file: ignored
    for (let i = 0; i < 50; i++) fake.fire('unlink', join(root, `gone-${i}.adf`))
    await watcher.whenIdle()
    await wait(60)

    expect(runtime.listAgents().map(a => a.id)).toEqual([fresh.id])
    expect(notices).toEqual(expect.arrayContaining([
      expect.objectContaining({ outcome: 'started', agentId: fresh.id, source: 'watcher' }),
      expect.objectContaining({ outcome: 'skipped', reason: 'unreviewed', agentId: unreviewed.id }),
    ]))
    // Many events, one push per root per window (plus at most one for the outcomes).
    expect(pushes.length).toBeGreaterThanOrEqual(1)
    expect(pushes.length).toBeLessThanOrEqual(2)
    expect(pushes.every(p => p.dirPath === root)).toBe(true)
  })

  it('never autostarts a file another runtime holds the lease for, and says who holds it', async () => {
    const root = tempDir('adf-watch-')
    const leaseDir = tempDir('adf-watch-leases-')
    const a = seedAgent(root, 'agent-1', true)
    const settings = memorySettings({ trackedDirectories: [root], reviewedAgents: [a.id] })
    const mine = new AgentLeaseRegistry({ dir: leaseDir, kind: 'daemon', settingsPath: join(leaseDir, 'a.json') })
    const other = new AgentLeaseRegistry({ dir: leaseDir, kind: 'studio-embedded', settingsPath: join(leaseDir, 'b.json') })
    cleanups.push(() => mine.close(), () => other.close())
    expect((await other.acquire(a.filePath, { agentId: a.id })).ok).toBe(true)

    const runtime = runtimeFor(settings.store, mine)
    const fake = fakeWatch()
    const { watcher, notices } = watcherFor(runtime, settings.store, { watchFactory: fake.factory })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    cleanups.push(() => warn.mockRestore())
    watcher.start()
    await wait(10)
    fake.fire('add', a.filePath)
    await watcher.whenIdle()

    expect(runtime.listAgents()).toEqual([])
    expect(notices).toEqual([expect.objectContaining({ outcome: 'skipped', reason: 'leased_elsewhere', agentId: a.id })])
    expect(notices[0].outcome === 'skipped' && notices[0].message).toMatch(/agent-1/)
    expect(warn.mock.calls.some(args => String(args[0]).includes('Not autostarted'))).toBe(true)
    // The fleet listing carries the sentence.
    const listed = listFolderAgents(runtime, settings.store, root).agents.find(x => x.filePath === a.filePath)
    expect(listed?.error).toMatch(/agent-1/)
  })

  it('caps the autostart queue in a burst and announces what it skipped', async () => {
    const root = tempDir('adf-watch-')
    const settings = memorySettings({ trackedDirectories: [root] })
    const runtime = runtimeFor(settings.store)
    const fake = fakeWatch()
    const { watcher } = watcherFor(runtime, settings.store, { watchFactory: fake.factory, autostartQueueLimit: 2, autostartConcurrency: 1 })
    const overflow: Array<{ dropped: number }> = []
    watcher.on('autostart_overflow', e => overflow.push(e))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    cleanups.push(() => warn.mockRestore())
    watcher.start()
    await wait(10)
    for (let i = 0; i < 6; i++) fake.fire('add', join(root, `missing-${i}.adf`))
    await watcher.whenIdle()
    // One running + two queued; three dropped.
    expect(overflow).toEqual([{ dropped: 3, queueLimit: 2 }])
  })

  it('follows the tracked list: a newly tracked root is watched, pushed and told to the daemon', async () => {
    const root = tempDir('adf-watch-')
    const added = tempDir('adf-watch-added-')
    const settings = memorySettings({ trackedDirectories: [root] })
    const changes: string[][] = []
    const fake = fakeWatch()
    const { watcher, pushes } = watcherFor(runtimeFor(settings.store), settings.store, { watchFactory: fake.factory, onTrackedDirectoriesChanged: d => changes.push(d) })
    watcher.start()
    await wait(10)
    expect(changes).toEqual([]) // boot: nothing announced
    settings.data.trackedDirectories = [root, added]
    watcher.sync()
    await wait(10)
    expect(changes).toEqual([[root, added]])
    expect(pushes).toEqual([{ dirPath: added }])
    expect(fake.calls.at(-1)?.paths).toEqual([root, added])
  })

  it('autostarts a file copied into a tracked folder (real chokidar)', async () => {
    const root = tempDir('adf-watch-real-')
    mkdirSync(join(root, 'sub'))
    const source = seedAgent(tempDir('adf-watch-src-'), 'agent-1', true)
    const settings = memorySettings({ trackedDirectories: [root], reviewedAgents: [source.id] })
    const runtime = runtimeFor(settings.store)
    const { watcher, pushes } = watcherFor(runtime, settings.store, { stabilityMs: 150 })
    watcher.start()
    await wait(800) // chokidar's initial scan
    copyFileSync(source.filePath, join(root, 'sub', 'agent-1.adf'))
    for (let i = 0; i < 100 && runtime.listAgents().length === 0; i++) await wait(100)
    expect(runtime.listAgents().map(a => a.id)).toEqual([source.id])
    expect(pushes).toContainEqual({ dirPath: root })
  }, 20_000)
})
