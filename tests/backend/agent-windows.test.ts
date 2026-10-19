/**
 * Agent windows' list and rules (docs/design/agent-windows.md §7, §8): one
 * window per agent, the saved list, quit and restore.
 */
import { describe, expect, it } from 'vitest'
import { AGENT_WINDOWS_KEY, AgentWindows, agentWindowName, parseSavedAgentWindows, type AgentWindowHandle, type SavedAgentWindow, type WindowBounds } from '../../src/main/backend/agent-windows'

const AGENT_1 = '6f1c2a4e-1b3d-4c5e-8f70-9a1b2c3d4e5f'
const AGENT_2 = '0d9e8f7a-6b5c-4d3e-9f21-0a9b8c7d6e5f'
const FILE_1 = '/agents/agent-1.adf'
const FILE_2 = '/agents/agent-2.adf'
const BOUNDS: WindowBounds = { x: 10, y: 20, width: 900, height: 700 }

interface FakeWindow extends AgentWindowHandle {
  focused: number
  closed: boolean
  events: { closed(): void; moved(): void }
  request: { filePath: string; agentId: string | null; name: string; bounds?: WindowBounds }
}

function setup(opts: { runtime?: string; saved?: unknown; exists?: (entry: SavedAgentWindow) => Promise<boolean> } = {}) {
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
    runtime: () => opts.runtime ?? 'local',
    exists: opts.exists ?? (async () => true),
    log: { log: () => {}, warn: () => {} },
  })
  return { manager, windows, sessions, store, saved: () => store.get(AGENT_WINDOWS_KEY) as { runtime: string; windows: SavedAgentWindow[] } | undefined }
}

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
    expect(windows[0].request.name).toBe('agent-1')
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
    const { manager, windows, saved } = setup()
    manager.open({ filePath: FILE_1, agentId: AGENT_1 })
    manager.open({ filePath: FILE_2, agentId: AGENT_2 })
    manager.freeze()
    for (const w of windows) w.close()
    expect(saved()!.windows.map((w) => w.agentId)).toEqual([AGENT_1, AGENT_2])
  })

  it('macOS main window closed: every agent window closes and stays saved', () => {
    const { manager, windows, saved } = setup()
    manager.open({ filePath: FILE_1, agentId: AGENT_1 })
    manager.open({ filePath: FILE_2, agentId: AGENT_2 })
    manager.closeAll()
    expect(windows.every((w) => w.closed)).toBe(true)
    expect(manager.list()).toEqual([])
    expect(saved()!.windows.map((w) => w.agentId)).toEqual([AGENT_1, AGENT_2])
  })

  it('drops malformed entries and lists saved for another runtime', () => {
    const raw = { runtime: 'local', windows: [{ agentId: AGENT_1, filePath: FILE_1, bounds: { x: 1, y: 2, width: 0, height: 5 } }, { filePath: 3 }, null, { filePath: FILE_2 }] }
    expect(parseSavedAgentWindows(raw, 'local')).toEqual([{ agentId: AGENT_1, filePath: FILE_1 }, { agentId: null, filePath: FILE_2 }])
    expect(parseSavedAgentWindows(raw, 'remote:rawl-hub')).toEqual([])
    expect(parseSavedAgentWindows('nonsense', 'local')).toEqual([])
  })
})

describe('restore', () => {
  it('reopens the saved windows whose agent still exists, with their bounds; drops the others', async () => {
    const checked: string[] = []
    const { manager, windows, saved } = setup({
      saved: { runtime: 'local', windows: [{ agentId: AGENT_1, filePath: FILE_1, bounds: BOUNDS }, { agentId: AGENT_2, filePath: FILE_2 }] },
      exists: async (entry) => { checked.push(entry.filePath); return entry.agentId === AGENT_1 },
    })
    expect(await manager.restore()).toEqual({ opened: 1, skipped: 1 })
    expect(checked).toEqual([FILE_1, FILE_2])
    expect(windows.map((w) => w.request)).toEqual([{ filePath: FILE_1, agentId: AGENT_1, name: 'agent-1', bounds: BOUNDS }])
    expect(saved()!.windows.map((w) => w.agentId)).toEqual([AGENT_1])
  })

  it('a failed check counts as missing', async () => {
    const { manager, windows } = setup({
      saved: { runtime: 'local', windows: [{ agentId: AGENT_1, filePath: FILE_1 }] },
      exists: async () => { throw new Error('daemon away') },
    })
    expect(await manager.restore()).toEqual({ opened: 0, skipped: 1 })
    expect(windows).toEqual([])
  })

  it('opens no agent twice, and nothing saved for another runtime', async () => {
    const one = setup({ saved: { runtime: 'local', windows: [{ agentId: AGENT_1, filePath: FILE_1 }] } })
    one.manager.open({ filePath: FILE_1, agentId: AGENT_1 })
    expect(await one.manager.restore()).toEqual({ opened: 0, skipped: 0 })
    expect(one.windows).toHaveLength(1)

    const other = setup({ runtime: 'remote:rawl-hub', saved: { runtime: 'local', windows: [{ agentId: AGENT_1, filePath: FILE_1 }] } })
    expect(await other.manager.restore()).toEqual({ opened: 0, skipped: 0 })
    expect(other.windows).toEqual([])
  })

  it('after a quit started, nothing reopens', async () => {
    const { manager, windows } = setup({ saved: { runtime: 'local', windows: [{ agentId: AGENT_1, filePath: FILE_1 }] } })
    manager.freeze()
    expect(await manager.restore()).toEqual({ opened: 0, skipped: 0 })
    expect(windows).toEqual([])
  })
})
