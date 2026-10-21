/**
 * R3B-1 (docs/design/multi-runtime.md §20): a runtime that moves (a saved
 * connection renamed, `adf pair <host> --as work && adf remotes forget lab`,
 * or the remote slot cleared for its twin) keeps its agent windows: they
 * close as for Reconnect, stay saved under the new id, and reopen once the
 * new id connects. A Remove still drops them.
 *
 * No network, no keychain: fake runtimes and an in-memory settings map.
 */
import { describe, expect, it } from 'vitest'
import { RuntimeManager, SLOT_RUNTIME } from '../../src/main/backend/daemon-mode/runtime-manager'
import type { RuntimeConnection } from '../../src/main/backend/daemon-mode/runtime-connection'
import { AGENT_WINDOWS_KEY, AgentWindows, type AgentWindowHandle, type SavedAgentWindow } from '../../src/main/backend/agent-windows'
import type { SavedRemote } from '../../src/main/cli/remotes'

const AGENT_1 = '6f1c2a4e-1b3d-4c5e-8f70-9a1b2c3d4e5f'
const FILE = '/srv/agents/agent-1.adf'
const FP = 'ABCD-EFGH'
const quiet = { log: () => {}, warn: () => {}, error: () => {} }
const tick = () => new Promise((r) => setTimeout(r, 0))
const remote = (fingerprint = FP): SavedRemote => ({ url: 'https://host-1.example:7385', fingerprint, deviceId: 'd', label: 'l', pairedAt: '2026-10-20T12:00:00Z' })

interface FakeWindow extends AgentWindowHandle { closed: boolean; request: { filePath: string; runtimeId?: string } }

/** AgentWindows on fakes, and a RuntimeManager whose runtimes' windows are the open AgentWindows of that runtime. */
function setup() {
  const store = new Map<string, unknown>()
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
    check: async () => 'open',
    log: quiet,
  })
  const open = (runtimeId: string) => created.filter((w) => !w.closed && w.request.runtimeId === runtimeId).map((w) => w.id)
  const fake = (id: string, name: string): RuntimeConnection => ({
    id, kind: id === 'local' ? 'local' : 'remote', primary: id === 'local',
    name: () => name,
    windows: { ids: () => open(id), views: () => [], ctx: () => null, open: () => {}, close: async () => {} },
    session: { filePath: null },
    shutdown: async () => {},
  }) as unknown as RuntimeConnection
  const moved: Array<[string, string]> = []
  const m = new RuntimeManager({
    primary: fake('local', 'host-0 (Local)'),
    closedWindows: new Set(),
    log: quiet,
    create: (id, name) => fake(id, name),
    closeWindow: (id, keep) => windows.close(id, { keep }),
    onMoved: (from, to) => { moved.push([from, to]); windows.moveRuntime(from, to) },
  })
  const saved = () => ((store.get(AGENT_WINDOWS_KEY) as { windows: SavedAgentWindow[] } | undefined)?.windows ?? [])
  return { m, windows, created, saved, moved, open }
}

describe('a runtime that moves keeps its agent windows (R3B-1)', () => {
  it('a rename: the window closes, stays saved under the new id, and reopens there once it connects', async () => {
    const t = setup()
    t.m.sync({ lab: remote() })
    t.windows.open({ filePath: FILE, agentId: AGENT_1, runtimeId: 'remote:lab', fingerprint: FP })
    expect(t.open('remote:lab')).toHaveLength(1)

    // adf pair <host> --as work && adf remotes forget lab: one change, lab moved to work.
    t.m.sync({ work: remote() }, null, { moves: new Map([['remote:lab', 'remote:work']]) })
    await tick()
    expect(t.open('remote:lab')).toEqual([])
    expect(t.moved).toEqual([['remote:lab', 'remote:work']])
    expect(t.saved()).toEqual([{ agentId: AGENT_1, filePath: FILE, bounds: { x: 0, y: 0, width: 900, height: 700 }, runtimeId: 'remote:work', fingerprint: FP }])

    // work connects: the window reopens on it.
    expect(await t.windows.restore('remote:work')).toEqual({ opened: 1, skipped: 0 })
    expect(t.open('remote:work')).toHaveLength(1)
    expect(t.created.at(-1)!.request).toMatchObject({ filePath: FILE, runtimeId: 'remote:work' })
  })

  it('two changes (adf pair, then adf remotes forget): the move is the second one', async () => {
    const t = setup()
    t.m.sync({ lab: remote() })
    t.windows.open({ filePath: FILE, agentId: AGENT_1, runtimeId: 'remote:lab', fingerprint: FP })
    t.m.sync({ lab: remote(), work: remote() }, null, { moves: new Map() })
    expect(t.open('remote:lab')).toHaveLength(1)
    t.m.sync({ work: remote() }, null, { moves: new Map([['remote:lab', 'remote:work']]) })
    await tick()
    expect(t.saved().map((w) => w.runtimeId)).toEqual(['remote:work'])
  })

  it('the slot cleared for its twin: the move is told first, the slot leaves the set later', async () => {
    const t = setup()
    t.m.sync({}, { name: 'office', url: 'https://office.example:7385' })
    t.windows.open({ filePath: FILE, agentId: AGENT_1, runtimeId: SLOT_RUNTIME })
    t.m.sync({ office: remote() }, { name: 'office', url: 'https://office.example:7385' }, { moves: new Map([[SLOT_RUNTIME, 'remote:office']]) })
    expect(t.open(SLOT_RUNTIME)).toHaveLength(1)
    // clearTwinSlot wrote studio-backend.json: the slot goes.
    t.m.sync({ office: remote() }, null)
    await tick()
    expect(t.moved).toEqual([[SLOT_RUNTIME, 'remote:office']])
    expect(t.saved().map((w) => w.runtimeId)).toEqual(['remote:office'])
  })

  it('a Remove still drops them', async () => {
    const t = setup()
    t.m.sync({ lab: remote() })
    t.windows.open({ filePath: FILE, agentId: AGENT_1, runtimeId: 'remote:lab', fingerprint: FP })
    t.m.sync({}, null, { moves: new Map() })
    await tick()
    expect(t.moved).toEqual([])
    expect(t.saved()).toEqual([])
  })

  it('a move whose target has the same agent saved already keeps one entry', async () => {
    const t = setup()
    t.m.sync({ lab: remote(), work: remote() })
    t.windows.open({ filePath: FILE, agentId: AGENT_1, runtimeId: 'remote:lab', fingerprint: FP })
    t.windows.open({ filePath: FILE, agentId: AGENT_1, runtimeId: 'remote:work', fingerprint: FP })
    t.m.sync({ work: remote() }, null, { moves: new Map([['remote:lab', 'remote:work']]) })
    await tick()
    expect(t.saved().map((w) => w.runtimeId)).toEqual(['remote:work'])
  })
})
