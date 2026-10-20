/**
 * Multi-runtime phase 3 in Studio main (docs/design/multi-runtime.md §3.1,
 * §3.4, §6.6, §7.4, §7.5):
 *
 * - the runtime order is kept in studio-backend.json (`runtimeOrder`),
 *   written only when it changes and never while no remote is saved (M11);
 * - the remote slot of studio-backend.json is a runtime of the set;
 * - Reconnect closes a runtime's agent windows and keeps them saved; they
 *   reopen once it connects; Remove drops them;
 * - Help names each runtime that is down, Reconnect acts on it;
 * - Open Recent lists each remote's files under its name
 *   (`runtimeRecentFiles`), never on this computer's disk.
 *
 * No network, no keychain: fake runtimes and a temporary folder.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('./daemon-mode-electron')).electronStub.module)

import { electronStub } from './daemon-mode-electron'
import { RuntimeManager, runtimeOrder, SLOT_RUNTIME } from '../../src/main/backend/daemon-mode/runtime-manager'
import type { RuntimeConnection } from '../../src/main/backend/daemon-mode/runtime-connection'
import { AGENT_WINDOWS_KEY, AgentWindows, type AgentWindowHandle, type SavedAgentCheck, type SavedAgentWindow } from '../../src/main/backend/agent-windows'
import { buildApplicationMenu, daemonHelpTemplate, initApplicationMenu, recordRuntimeRecentFile, renameRuntimeRecentFile, type MenuRuntime } from '../../src/main/menu'
import { createBackendSettingsStore, normalizeBackendConfig, resolveBootBackend, type SecretCodec } from '../../src/main/backend/backend-config'
import { runtimeSlot } from '../../src/main/backend/connections'
import type { SavedRemote } from '../../src/main/cli/remotes'

const ID_1 = '6f1c2a4e-1b3d-4c5e-8f70-9a1b2c3d4e5f'
const ID_2 = '0d9e8f7a-6b5c-4d3e-9f21-0a9b8c7d6e5f'
const quiet = { log: () => {}, warn: () => {}, error: () => {} }
const codec: SecretCodec = { available: () => true, encrypt: (p) => `safe:${p}`, decrypt: (s) => s.slice(5) }

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'adf-mr3-'))
  dirs.push(dir)
  return dir
}

const remote = (pairedAt: string, fingerprint = `FP-${pairedAt}`): SavedRemote => ({ url: `https://${fingerprint.toLowerCase()}.example:7385`, fingerprint, deviceId: 'd', label: 'l', pairedAt })

/** A runtime as the manager sees it: an id, a name, its agent windows, a shutdown. */
function fakeRuntime(id: string, name: string, windows: number[] = []): RuntimeConnection & { ended: boolean } {
  const rt = {
    id, kind: id === 'local' ? 'local' : 'remote', primary: id === 'local', ended: false,
    name: () => name,
    windows: { ids: () => windows, views: () => [], ctx: () => null, open: () => {}, close: async () => {} },
    session: { filePath: null },
    shutdown: async () => { rt.ended = true },
  }
  return rt as unknown as RuntimeConnection & { ended: boolean }
}

function manager(opts: { initialOrder?: string[]; windowsOf?: Record<string, number[]> } = {}) {
  const created: string[] = []
  const orders: string[][] = []
  const closed: Array<[number, boolean]> = []
  const m = new RuntimeManager({
    primary: fakeRuntime('local', 'This computer'),
    closedWindows: new Set(),
    log: quiet,
    create: (id, name) => { created.push(`${id}=${name}`); return fakeRuntime(id, name, opts.windowsOf?.[id] ?? []) },
    closeWindow: (id, keep) => { closed.push([id, keep]) },
    ...(opts.initialOrder ? { initialOrder: opts.initialOrder } : {}),
    onOrder: (order) => { orders.push(order) },
  })
  return { m, created, orders, closed }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('runtimeOrder (§3.1)', () => {
  it('is saved only when it changes, never while no remote is saved', () => {
    const t = manager()
    t.m.sync({})
    expect(t.orders).toEqual([])
    t.m.sync({ 'host-1': remote('2026-10-20T12:00:01Z') })
    expect(t.orders).toEqual([['remote:host-1']])
    t.m.sync({ 'host-1': remote('2026-10-20T12:00:01Z') })
    expect(t.orders).toEqual([['remote:host-1']])
    t.m.sync({ 'host-1': remote('2026-10-20T12:00:01Z'), 'host-2': remote('2026-10-20T12:00:00Z') })
    // Added later: after host-1, whatever its pairedAt (the order added).
    expect(t.orders.at(-1)).toEqual(['remote:host-1', 'remote:host-2'])
  })

  it('the order saved at the last launch wins over pairedAt; an id no longer saved is dropped and the order saved again', () => {
    const t = manager({ initialOrder: ['remote:host-2', 'remote:gone', 'remote:host-1'] })
    t.m.sync({ 'host-1': remote('2026-10-20T12:00:00Z'), 'host-2': remote('2026-10-20T12:00:01Z') })
    expect(t.m.runtimes().map((r) => r.id)).toEqual(['local', 'remote:host-2', 'remote:host-1'])
    expect(t.orders).toEqual([['remote:host-2', 'remote:host-1']])
  })

  it('an order read at launch that is still right is not written again', () => {
    const t = manager({ initialOrder: ['remote:host-1'] })
    t.m.sync({ 'host-1': remote('2026-10-20T12:00:00Z') })
    expect(t.orders).toEqual([])
  })

  it('the remote slot counts: among those added together it comes first', () => {
    expect(runtimeOrder([], { b: { pairedAt: '2026-01-01' } }, { name: 'office', url: 'https://adf.example.com' })).toEqual(['remote', 'remote:b'])
    expect(runtimeOrder(['remote:b'], { b: { pairedAt: '2026-01-01' } }, { name: 'office', url: 'https://adf.example.com' })).toEqual(['remote:b', 'remote'])
  })
})

describe('the remote slot of studio-backend.json (§3.1)', () => {
  it('joins the set while it holds a URL; another address replaces its connection; no URL removes it', async () => {
    const t = manager({ windowsOf: { [SLOT_RUNTIME]: [41] } })
    t.m.sync({}, { name: 'office', url: 'https://adf.example.com' })
    expect(t.created).toEqual(['remote=office'])
    t.m.sync({}, { name: 'office', url: 'https://adf.example.com' })
    expect(t.created).toEqual(['remote=office'])
    t.m.sync({}, { name: 'office', url: 'https://adf2.example.com' })
    await tick()
    expect(t.created).toEqual(['remote=office', 'remote=office'])
    // Replaced: its window stays saved to reopen.
    expect(t.closed).toEqual([[41, true]])
    t.m.sync({}, null)
    await tick()
    expect(t.m.runtimes().map((r) => r.id)).toEqual(['local'])
    expect(t.closed.at(-1)).toEqual([41, false])
  })

  it('runtimeSlot: a URL makes a runtime, unless the computer it was paired with is a saved connection', () => {
    expect(runtimeSlot({ remote: { url: null, token: null, allowInsecureHttp: false } }, {})).toBeNull()
    const slot = { remote: { url: 'https://adf.example.com', token: 'safe:x', allowInsecureHttp: false, paired: { fingerprint: 'SLOT-1', name: 'office', deviceId: 'd', label: 'l' } } }
    expect(runtimeSlot(slot, {})).toEqual({ name: 'office', url: 'https://adf.example.com' })
    expect(runtimeSlot(slot, { office: remote('x', 'SLOT-1') })).toBeNull()
    expect(runtimeSlot({ remote: { url: 'https://adf.example.com', token: 'safe:x', allowInsecureHttp: false } }, {})).toEqual({ name: 'adf.example.com', url: 'https://adf.example.com' })
  })
})

describe('Reconnect and Remove close a runtime\'s agent windows (§3.3, §3.4)', () => {
  it('Reconnect keeps them saved (keep); Remove drops them', async () => {
    const t = manager({ windowsOf: { 'remote:host-1': [7, 8] } })
    t.m.sync({ 'host-1': remote('2026-10-20T12:00:00Z') })
    await t.m.replace('remote:host-1')
    expect(t.closed).toEqual([[7, true], [8, true]])
    expect(t.created).toEqual(['remote:host-1=host-1', 'remote:host-1=host-1'])
    t.m.sync({})
    await tick()
    expect(t.closed.slice(2)).toEqual([[7, false], [8, false]])
  })
})

interface FakeWindow extends AgentWindowHandle { closed: boolean; request: { filePath: string; runtimeId?: string } }

function windowsSetup(saved: unknown, check: (entry: SavedAgentWindow) => Promise<SavedAgentCheck> = async () => 'open') {
  const store = new Map<string, unknown>([[AGENT_WINDOWS_KEY, saved]])
  const created: FakeWindow[] = []
  let nextId = 10
  const windows = new AgentWindows({
    create: (request, events) => {
      const w: FakeWindow = {
        id: nextId++, closed: false, request,
        focus() {}, isMinimized: () => false, restore() {},
        isDestroyed: () => w.closed,
        getBounds: () => ({ x: 0, y: 0, width: 900, height: 700 }),
        close() { w.closed = true; events.closed() },
      }
      created.push(w)
      return w
    },
    current: () => null,
    samePath: (a, b) => a === b,
    settings: { get: (k) => store.get(k), set: (k, v) => { store.set(k, v) } },
    runtime: () => 'local',
    check,
    log: quiet,
  })
  const savedWindows = () => (store.get(AGENT_WINDOWS_KEY) as { windows: SavedAgentWindow[] }).windows
  return { windows, created, savedWindows }
}

describe('agent windows tied to (runtime, agent) (§7.5)', () => {
  const list = {
    runtime: 'local',
    windows: [
      { agentId: ID_1, filePath: '/agents/agent-1.adf' },
      { agentId: ID_2, filePath: '/srv/agents/agent-2.adf', runtimeId: 'remote:host-1', fingerprint: 'FP-1' },
    ],
  }

  it('restore(runtimeId) reopens only that runtime\'s windows, when it connects', async () => {
    const t = windowsSetup(list)
    expect(await t.windows.restore('remote:host-1')).toEqual({ opened: 1, skipped: 0 })
    expect(t.created.map((w) => [w.request.filePath, w.request.runtimeId])).toEqual([['/srv/agents/agent-2.adf', 'remote:host-1']])
    expect(await t.windows.restore('local')).toEqual({ opened: 1, skipped: 0 })
    expect(t.created.map((w) => w.request.filePath)).toEqual(['/srv/agents/agent-2.adf', '/agents/agent-1.adf'])
  })

  it('a restore asked for while another runs follows it', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const t = windowsSetup(list, async (entry) => { if (!entry.runtimeId) await gate; return 'open' })
    const all = t.windows.restore()
    const remoteOnly = t.windows.restore('remote:host-1')
    release()
    await all
    await remoteOnly
    // Each window opened once: the follower found the remote's window open already.
    expect(t.created.map((w) => w.request.filePath).sort()).toEqual(['/agents/agent-1.adf', '/srv/agents/agent-2.adf'])
  })

  it('close(keep) leaves the window saved; it reopens at the next restore of its runtime', async () => {
    const t = windowsSetup({ runtime: 'local', windows: [] })
    const { id } = t.windows.open({ filePath: '/srv/agents/agent-2.adf', agentId: ID_2, runtimeId: 'remote:host-1', fingerprint: 'FP-1' })
    t.windows.close(id, { keep: true })
    expect(t.created[0].closed).toBe(true)
    expect(t.savedWindows()).toEqual([{ agentId: ID_2, filePath: '/srv/agents/agent-2.adf', bounds: { x: 0, y: 0, width: 900, height: 700 }, runtimeId: 'remote:host-1', fingerprint: 'FP-1' }])
    expect(await t.windows.restore('remote:host-1')).toEqual({ opened: 1, skipped: 0 })
    expect(t.created).toHaveLength(2)
  })

  it('close without keep (Remove) drops the window from the saved list', () => {
    const t = windowsSetup({ runtime: 'local', windows: [] })
    const { id } = t.windows.open({ filePath: '/srv/agents/agent-2.adf', agentId: ID_2, runtimeId: 'remote:host-1' })
    t.windows.close(id)
    expect(t.savedWindows()).toEqual([])
  })
})

function helpTemplate(runtimes: MenuRuntime[], problem: string | null = null) {
  return daemonHelpTemplate({
    logFile: () => '/logs/adf-daemon.log',
    problem: () => problem,
    canReconnect: () => problem !== null,
    openLog: () => {},
    reconnect: () => {},
    runtimes: () => runtimes,
  }).map((i) => ({ label: i.label ?? `<${i.type}>`, enabled: i.enabled, submenu: Array.isArray(i.submenu) ? i.submenu.map((s) => s.label) : undefined, click: i.click }))
}

const menuRuntime = (id: string, name: string, problem: string | null, reconnect: () => void = () => {}): MenuRuntime => ({ id, name, primary: id === 'local', problem, canReconnect: problem !== null, reconnect })

describe('Help (§6.6)', () => {
  it('one runtime: the menu of before', () => {
    expect(helpTemplate([menuRuntime('local', 'This computer', null)], 'ADF daemon: not connected, retrying').map((i) => i.label))
      .toEqual(['<separator>', 'Open Daemon Log', 'ADF daemon: not connected, retrying', 'Reconnect to the ADF Daemon'])
  })

  it('names each runtime that is down; Reconnect acts on it', () => {
    let reconnected = ''
    const items = helpTemplate([
      menuRuntime('local', 'This computer', null),
      menuRuntime('remote:host-1', 'host-1', 'ADF daemon: not connected (https://host-1.example:7385), retrying', () => { reconnected = 'host-1' }),
    ])
    expect(items.map((i) => i.label)).toEqual(['<separator>', 'Open Daemon Log', 'host-1: not connected (https://host-1.example:7385), retrying', 'Reconnect'])
    expect(items[2].enabled).toBe(false)
    items[3].click?.({} as never, undefined, {} as never)
    expect(reconnected).toBe('host-1')
  })

  it('more than one down: Reconnect is a submenu of their names; none down: no status line', () => {
    const down = helpTemplate([
      menuRuntime('local', 'This computer', 'ADF daemon: not connected, retrying'),
      menuRuntime('remote:host-1', 'host-1', 'ADF daemon: connecting…'),
      menuRuntime('remote:host-2', 'host-2', null),
    ])
    expect(down.map((i) => i.label)).toEqual(['<separator>', 'Open Daemon Log', 'This computer: not connected, retrying', 'host-1: connecting…', 'Reconnect'])
    expect(down[4].submenu).toEqual(['This computer', 'host-1'])
    expect(helpTemplate([menuRuntime('local', 'This computer', null), menuRuntime('remote:host-1', 'host-1', null)]).map((i) => i.label)).toEqual(['<separator>', 'Open Daemon Log'])
  })
})

function openRecent(): Array<{ label?: string; toolTip?: string; type?: string; submenu?: Array<{ label?: string; toolTip?: string }> }> {
  const last = [...electronStub.calls].reverse().find((c) => c.api === 'Menu.setApplicationMenu')
  const items = (last?.args[0] ?? []) as Array<{ label?: string; submenu?: Array<{ label?: string; submenu?: unknown }> }>
  return ((items.find((i) => i.label === 'File')?.submenu ?? []).find((i) => i.label === 'Open Recent')?.submenu ?? []) as never
}

describe('Open Recent per runtime (§6.6, §7.4)', () => {
  function menuWith(runtimes: MenuRuntime[]) {
    const store = new Map<string, unknown>()
    const opened: Array<[string, string]> = []
    initApplicationMenu({ get: (k) => store.get(k), set: (k, v) => { store.set(k, v) } }, {
      logFile: () => null, problem: () => null, canReconnect: () => false, openLog: () => {}, reconnect: () => {},
      runtimes: () => runtimes,
      openOnRuntime: (runtimeId, filePath) => { opened.push([runtimeId, filePath]) },
    })
    return { store, opened }
  }
  const set = [menuRuntime('local', 'This computer', null), menuRuntime('remote:host-1', 'host-1', null)]

  it('a remote\'s files go to runtimeRecentFiles under its id and show under its name; a click opens it on that runtime', () => {
    const { store, opened } = menuWith(set)
    recordRuntimeRecentFile('remote:host-1', '/srv/agents/agent-1.adf')
    recordRuntimeRecentFile('remote:host-1', '/srv/agents/agent-2.adf')
    expect(store.get('runtimeRecentFiles')).toEqual({ 'remote:host-1': ['/srv/agents/agent-2.adf', '/srv/agents/agent-1.adf'] })
    // Never This computer's list, nor the OS recent documents.
    expect(store.get('recentFiles')).toBeUndefined()
    expect(electronStub.calls.some((c) => c.api === 'app.addRecentDocument' && String(c.args[0]).includes('/srv/'))).toBe(false)
    const menu = openRecent()
    const group = menu.find((i) => i.label === 'host-1')!
    expect(group.submenu!.map((i) => i.toolTip)).toEqual(['/srv/agents/agent-2.adf', '/srv/agents/agent-1.adf'])
    ;(group.submenu![0] as { click: () => void }).click()
    expect(opened).toEqual([['remote:host-1', '/srv/agents/agent-2.adf']])
  })

  it('a moved file follows; with one runtime no remote list shows; Clear Menu clears the shown lists only', () => {
    const { store } = menuWith(set)
    store.set('runtimeRecentFiles', { 'remote:host-1': ['/srv/agents/agent-1.adf'], 'remote:gone': ['/x/agent-9.adf'] })
    renameRuntimeRecentFile('remote:host-1', '/srv/agents/agent-1.adf', '/srv/agents/claimed/agent-1.adf')
    expect((store.get('runtimeRecentFiles') as Record<string, string[]>)['remote:host-1']).toEqual(['/srv/agents/claimed/agent-1.adf'])
    const clear = openRecent().find((i) => i.label === 'Clear Menu') as { click: () => void }
    clear.click()
    expect(store.get('runtimeRecentFiles')).toEqual({ 'remote:gone': ['/x/agent-9.adf'] })

    menuWith([menuRuntime('local', 'This computer', null)])
    buildApplicationMenu()
    expect(openRecent().map((i) => i.label)).toEqual(['Clear Menu'])
  })
})

describe('studio-backend.json runtimeOrder (§3.1, M11)', () => {
  it('normalize keeps runtime ids only, once each', () => {
    const { config } = normalizeBackendConfig({ v: 1, mode: 'local', runtimeOrder: ['remote:host-1', 'local', 7, 'remote:', 'remote', 'remote:host-1', 'remote:host-2'] })
    expect(config.runtimeOrder).toEqual(['remote:host-1', 'remote', 'remote:host-2'])
    expect(normalizeBackendConfig({ v: 1, mode: 'local' }).config.runtimeOrder).toBeUndefined()
  })

  it('setRuntimeOrder writes only a change; a local-only file keeps its bytes', async () => {
    const dir = tempDir()
    const path = join(dir, 'studio-backend.json')
    const bytes = JSON.stringify({ v: 1, mode: 'local', keepDaemonRunning: false, remote: { url: null, token: null, allowInsecureHttp: false } })
    writeFileSync(path, bytes)
    const store = createBackendSettingsStore({ boot: resolveBootBackend(path, {}, quiet), codec, log: quiet })
    expect(await store.setRuntimeOrder([])).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe(bytes)
    expect(await store.setRuntimeOrder(['remote:host-1'])).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf8')).runtimeOrder).toEqual(['remote:host-1'])
    expect(await store.setRuntimeOrder(['remote:host-1'])).toBe(false)
    expect(await store.setRuntimeOrder([])).toBe(true)
    expect(JSON.parse(readFileSync(path, 'utf8')).runtimeOrder).toEqual([])
    // Other saves keep it.
    await store.set({ keepDaemonRunning: true })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ keepDaemonRunning: true, runtimeOrder: [] })
    expect(existsSync(path)).toBe(true)
  })
})
