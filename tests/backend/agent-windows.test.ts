/**
 * Agent windows' list and rules (docs/design/agent-windows.md §7, §8): one
 * window per agent, the saved list (never wiped by a quit, a restore that
 * did not run, or macOS closing them with the main window), restore.
 */
import { describe, expect, it } from 'vitest'
import {
  AGENT_WINDOWS_KEY, AgentWindows, agentWindowName, checkSavedAgent, parseSavedAgentWindows, titleStripVisible,
  type AgentWindowHandle, type SavedAgentCheck, type SavedAgentWindow, type WindowBounds,
} from '../../src/main/backend/agent-windows'

const AGENT_1 = '6f1c2a4e-1b3d-4c5e-8f70-9a1b2c3d4e5f'
const AGENT_2 = '0d9e8f7a-6b5c-4d3e-9f21-0a9b8c7d6e5f'
const FILE_1 = '/agents/agent-1.adf'
const FILE_2 = '/agents/agent-2.adf'
const BOUNDS: WindowBounds = { x: 10, y: 20, width: 900, height: 700 }

interface FakeWindow extends AgentWindowHandle {
  focused: number
  closed: boolean
  events: { closed(): void; moved(): void }
  request: { filePath: string; agentId: string | null; name: string; bounds?: WindowBounds; restored: boolean }
}

function setup(opts: { runtime?: string | null; saved?: unknown; check?: (entry: SavedAgentWindow) => Promise<SavedAgentCheck> } = {}) {
  const state = { runtime: opts.runtime === undefined ? 'local' : opts.runtime }
  const store = new Map<string, unknown>(opts.saved === undefined ? [] : [[AGENT_WINDOWS_KEY, opts.saved]])
  const windows: FakeWindow[] = []
  /** What each window's session has open (renames move it). */
  const sessions = new Map<number, { filePath: string; agentId: string | null }>()
  let nextId = 10
  const manager = new AgentWindows({
    create: (request, events) => {
      const id = nextId++
      const w: FakeWindow = {
        id, focused: 0, closed: false, events, request,
        focus() { w.focused++ },
        isMinimized: () => false,
        restore() {},
        isDestroyed: () => w.closed,
        getBounds: () => request.bounds ?? BOUNDS,
        close() { w.closed = true; events.closed() },
      }
      windows.push(w)
      return w
    },
    current: (id) => sessions.get(id) ?? null,
    samePath: (a, b) => a === b,
    settings: { get: (key) => store.get(key), set: (key, value) => { store.set(key, value) } },
    runtime: () => state.runtime,
    check: opts.check ?? (async () => 'open'),
    log: { log: () => {}, warn: () => {} },
  })
  const saved = () => (store.get(AGENT_WINDOWS_KEY) as { runtime: string; windows: SavedAgentWindow[] } | undefined)
  return { manager, windows, sessions, store, state, saved, savedIds: () => saved()?.windows.map((w) => w.agentId) }
}

const savedList = (...ids: Array<[string, string]>) => ({ runtime: 'local', windows: ids.map(([agentId, filePath]) => ({ agentId, filePath })) })

describe('one window per agent', () => {
  it('opening an agent that has a window focuses it', () => {
    const { manager, windows } = setup()
    expect(manager.open({ filePath: FILE_1, agentId: AGENT_1 })).toEqual({ id: 10, created: true })
    expect(manager.open({ filePath: FILE_1, agentId: AGENT_1 })).toEqual({ id: 10, created: false })
    // By path when the caller has no id; by id when the file has moved.
    expect(manager.open({ filePath: FILE_1 })).toEqual({ id: 10, created: false })
    expect(manager.open({ filePath: '/elsewhere/agent-1.adf', agentId: AGENT_1 })).toEqual({ id: 10, created: false })
    expect(windows).toHaveLength(1)
    expect(windows[0].focused).toBe(3)
    expect(windows[0].request).toMatchObject({ name: 'agent-1', restored: false })
    expect(manager.open({ filePath: FILE_2, agentId: AGENT_2 })).toEqual({ id: 11, created: true })
  })

  it('follows the file the window\'s session has open (a rename)', () => {
    const { manager, sessions } = setup()
    manager.open({ filePath: FILE_1 })
    sessions.set(10, { filePath: '/agents/renamed.adf', agentId: AGENT_1 })
    expect(manager.open({ filePath: '/agents/renamed.adf' }).created).toBe(false)
    expect(manager.list()).toEqual([{ agentId: AGENT_1, filePath: '/agents/renamed.adf', bounds: BOUNDS }])
  })

  it('a closed window is gone: the agent opens a new one', () => {
    const { manager, windows } = setup()
    manager.open({ filePath: FILE_1, agentId: AGENT_1 })
    windows[0].close()
    expect(manager.has(10)).toBe(false)
    expect(manager.open({ filePath: FILE_1, agentId: AGENT_1 })).toEqual({ id: 11, created: true })
  })

  it('names a window after its file, either separator', () => {
    expect(agentWindowName('C:\\agents\\agent-2.adf')).toBe('agent-2')
    expect(agentWindowName('/agents/agent-1.adf')).toBe('agent-1')
  })
})

describe('saved list', () => {
  it('is written on open and close, for the current runtime', () => {
    const { manager, windows, saved } = setup({ runtime: 'remote:rawl-hub' })
    manager.open({ filePath: FILE_1, agentId: AGENT_1, bounds: BOUNDS })
    manager.open({ filePath: FILE_2, agentId: AGENT_2 })
    expect(saved()).toEqual({ runtime: 'remote:rawl-hub', windows: [
      { agentId: AGENT_1, filePath: FILE_1, bounds: BOUNDS },
      { agentId: AGENT_2, filePath: FILE_2, bounds: BOUNDS },
    ] })
    windows[1].close()
    expect(saved()!.windows.map((w) => w.filePath)).toEqual([FILE_1])
  })

  it('quit: frozen as it is, so the windows the quit closes stay saved', () => {
    const { manager, windows, savedIds } = setup()
    manager.open({ filePath: FILE_1, agentId: AGENT_1 })
    manager.open({ filePath: FILE_2, agentId: AGENT_2 })
    manager.freeze()
    for (const w of windows) w.close()
    expect(savedIds()).toEqual([AGENT_1, AGENT_2])
  })

  it('macOS: the main window closes the agent windows; a quit after that keeps them saved', () => {
    const { manager, windows, savedIds } = setup()
    manager.open({ filePath: FILE_1, agentId: AGENT_1 })
    manager.open({ filePath: FILE_2, agentId: AGENT_2 })
    manager.closeAll()
    expect(windows.every((w) => w.closed)).toBe(true)
    expect(manager.list()).toEqual([])
    expect(savedIds()).toEqual([AGENT_1, AGENT_2])
    manager.freeze()
    expect(savedIds()).toEqual([AGENT_1, AGENT_2])
  })

  it('a quit before the restore ran (daemon slow or down) keeps the saved list', () => {
    const { manager, savedIds } = setup({ saved: savedList([AGENT_1, FILE_1], [AGENT_2, FILE_2]) })
    manager.freeze()
    expect(savedIds()).toEqual([AGENT_1, AGENT_2])
  })

  it('a window opened before the restore ran is added to the saved list, not written over it', () => {
    const { manager, savedIds } = setup({ saved: savedList([AGENT_1, FILE_1]) })
    manager.open({ filePath: FILE_2, agentId: AGENT_2 })
    expect(savedIds()).toEqual([AGENT_2, AGENT_1])
  })

  it('a window that never opened its agent is not saved; one that opened is', () => {
    const { manager, sessions, savedIds } = setup()
    manager.open({ filePath: FILE_1, agentId: AGENT_1 })
    manager.open({ filePath: FILE_2, agentId: AGENT_2 })
    sessions.set(11, { filePath: FILE_2, agentId: AGENT_2 })
    manager.openFailed(10)
    manager.openFailed(11)
    expect(savedIds()).toEqual([AGENT_2])
    // A retry that opens it brings it back.
    sessions.set(10, { filePath: FILE_1, agentId: AGENT_1 })
    manager.save()
    expect(savedIds()).toEqual([AGENT_1, AGENT_2])
  })

  it('is never written while the runtime is unknown (an unnamed remote before it connects)', () => {
    const { manager, store } = setup({ runtime: null, saved: savedList([AGENT_1, FILE_1]) })
    manager.open({ filePath: FILE_2, agentId: AGENT_2 })
    manager.freeze()
    expect(store.get(AGENT_WINDOWS_KEY)).toEqual(savedList([AGENT_1, FILE_1]))
    // Known once connected: the saved list is read then, and kept.
    const later = setup({ runtime: null, saved: savedList([AGENT_1, FILE_1]) })
    later.manager.open({ filePath: FILE_2, agentId: AGENT_2 })
    later.state.runtime = 'local'
    later.manager.save()
    expect(later.savedIds()).toEqual([AGENT_2, AGENT_1])
  })

  it('drops malformed entries and lists saved for another runtime', () => {
    const raw = { runtime: 'local', windows: [{ agentId: AGENT_1, filePath: FILE_1, bounds: { x: 1, y: 2, width: 0, height: 5 } }, { filePath: 3 }, null, { filePath: FILE_2 }] }
    expect(parseSavedAgentWindows(raw, 'local')).toEqual([{ agentId: AGENT_1, filePath: FILE_1 }, { agentId: null, filePath: FILE_2 }])
    expect(parseSavedAgentWindows(raw, 'remote:rawl-hub')).toEqual([])
    expect(parseSavedAgentWindows('nonsense', 'local')).toEqual([])
  })
})

describe('restore', () => {
  it('reopens the windows whose agent is there, behind the main window, with their bounds; drops the gone ones', async () => {
    const checked: string[] = []
    const { manager, windows, savedIds } = setup({
      saved: { runtime: 'local', windows: [{ agentId: AGENT_1, filePath: FILE_1, bounds: BOUNDS }, { agentId: AGENT_2, filePath: FILE_2 }] },
      check: async (entry) => { checked.push(entry.filePath); return entry.agentId === AGENT_1 ? 'open' : 'gone' },
    })
    expect(await manager.restore()).toEqual({ opened: 1, skipped: 1 })
    expect(checked).toEqual([FILE_1, FILE_2])
    expect(windows.map((w) => w.request)).toEqual([{ filePath: FILE_1, agentId: AGENT_1, name: 'agent-1', bounds: BOUNDS, restored: true }])
    expect(windows[0].focused).toBe(0)
    expect(savedIds()).toEqual([AGENT_1])
  })

  it('a check that fails for another reason keeps the window saved and skips it this time', async () => {
    let answer: SavedAgentCheck = 'unknown'
    const { manager, windows, savedIds } = setup({ saved: savedList([AGENT_1, FILE_1]), check: async () => answer })
    expect(await manager.restore()).toEqual({ opened: 0, skipped: 1 })
    expect(windows).toEqual([])
    expect(savedIds()).toEqual([AGENT_1])
    // A thrown check is the same.
    const thrown = setup({ saved: savedList([AGENT_1, FILE_1]), check: async () => { throw new Error('daemon away') } })
    expect(await thrown.manager.restore()).toEqual({ opened: 0, skipped: 1 })
    expect(thrown.savedIds()).toEqual([AGENT_1])
    // The next launch (here: the next restore) opens it.
    answer = 'open'
    expect(await manager.restore()).toEqual({ opened: 1, skipped: 0 })
    expect(windows).toHaveLength(1)
  })

  it('a reopened window whose open fails stays saved unless its agent is gone', async () => {
    let found: SavedAgentCheck = 'open'
    const { manager, savedIds } = setup({ saved: savedList([AGENT_1, FILE_1], [AGENT_2, FILE_2]), check: async () => found })
    await manager.restore()
    found = 'unknown'
    manager.openFailed(10)
    await new Promise((r) => setTimeout(r, 0))
    expect(savedIds()).toEqual([AGENT_1, AGENT_2])
    found = 'gone'
    manager.openFailed(11)
    await new Promise((r) => setTimeout(r, 0))
    expect(savedIds()).toEqual([AGENT_1])
  })

  it('closeAll during a restore stops it and keeps every window saved', async () => {
    let release!: (answer: SavedAgentCheck) => void
    const { manager, windows, savedIds } = setup({
      saved: savedList([AGENT_1, FILE_1], [AGENT_2, FILE_2]),
      check: (entry) => entry.agentId === AGENT_1 ? Promise.resolve('open') : new Promise((resolve) => { release = resolve }),
    })
    const running = manager.restore()
    await new Promise((r) => setTimeout(r, 0))
    expect(windows).toHaveLength(1)
    manager.closeAll()
    release('open')
    expect(await running).toEqual({ opened: 1, skipped: 0 })
    expect(windows).toHaveLength(1)
    expect(savedIds()).toEqual([AGENT_1, AGENT_2])
    // The main window opens again: a new restore reopens both.
    const second = manager.restore()
    await new Promise((r) => setTimeout(r, 0))
    release('open')
    expect(await second).toEqual({ opened: 2, skipped: 0 })
  })

  it('opens no agent twice, and nothing saved for another runtime', async () => {
    const one = setup({ saved: savedList([AGENT_1, FILE_1]) })
    one.manager.open({ filePath: FILE_1, agentId: AGENT_1 })
    expect(await one.manager.restore()).toEqual({ opened: 0, skipped: 0 })
    expect(one.windows).toHaveLength(1)

    const other = setup({ runtime: 'remote:rawl-hub', saved: savedList([AGENT_1, FILE_1]) })
    expect(await other.manager.restore()).toEqual({ opened: 0, skipped: 0 })
    expect(other.windows).toEqual([])
  })

  it('after a quit started, nothing reopens', async () => {
    const { manager, windows } = setup({ saved: savedList([AGENT_1, FILE_1]) })
    manager.freeze()
    expect(await manager.restore()).toEqual({ opened: 0, skipped: 0 })
    expect(windows).toEqual([])
  })
})

describe('restore checks and bounds', () => {
  const entry = { agentId: AGENT_1, filePath: FILE_1 }
  const refused = (status: number, code?: string) => Object.assign(new Error(`HTTP ${status}`), { status, body: code ? { code } : null })

  it('gone only when the file is missing, not an agent, or holds another agent', async () => {
    expect(await checkSavedAgent(entry, async () => ({ agentId: AGENT_1 }))).toBe('open')
    expect(await checkSavedAgent({ ...entry, agentId: null }, async () => ({ agentId: AGENT_2 }))).toBe('open')
    expect(await checkSavedAgent(entry, async () => ({ agentId: AGENT_2 }))).toBe('gone')
    expect(await checkSavedAgent(entry, async () => { throw refused(404, 'not_found') })).toBe('gone')
    expect(await checkSavedAgent(entry, async () => { throw refused(400, 'not_an_adf') })).toBe('gone')
  })

  it('any other failure is unknown', async () => {
    expect(await checkSavedAgent(entry, async () => { throw refused(500, 'internal_error') })).toBe('unknown')
    expect(await checkSavedAgent(entry, async () => { throw refused(404) })).toBe('unknown')
    expect(await checkSavedAgent(entry, async () => { throw new Error('connect ECONNREFUSED') })).toBe('unknown')
  })

  it('saved bounds count only with 100 px of the title strip on a display', () => {
    const screen = [{ x: 0, y: 0, width: 1920, height: 1040 }]
    expect(titleStripVisible({ x: 100, y: 100, width: 900, height: 700 }, screen)).toBe(true)
    expect(titleStripVisible({ x: 1850, y: 100, width: 900, height: 700 }, screen)).toBe(false)
    expect(titleStripVisible({ x: 1800, y: 100, width: 900, height: 700 }, screen)).toBe(true)
    expect(titleStripVisible({ x: 100, y: -30, width: 900, height: 700 }, screen)).toBe(false)
    expect(titleStripVisible({ x: 100, y: 1030, width: 900, height: 700 }, screen)).toBe(false)
    // A second display to the left.
    expect(titleStripVisible({ x: -1500, y: 100, width: 900, height: 700 }, [...screen, { x: -1920, y: 0, width: 1920, height: 1080 }])).toBe(true)
  })
})
