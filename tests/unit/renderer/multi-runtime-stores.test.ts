/**
 * Multi-runtime phase 2 in the renderer (docs/design/multi-runtime.md §5):
 * the runtime set, per-runtime store slices, agent keys, and the same agent
 * id or path on two runtimes kept apart. With This computer only, every
 * store, key and call is the one before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionsView, RuntimeView } from '../../../src/shared/types/connection.types'
import type { NotificationsSnapshot, PendingNotification } from '../../../src/shared/types/ipc.types'

const HOST_1 = 'remote:host-1'
const HOST_2 = 'remote:host-2'
const AGENT_1 = '/agents/agent-1.adf'
const AGENT_2 = '/agents/agent-2.adf'
const ID_1 = '0b7c6f1e-2d4a-4c55-9a0e-3f1c2b7a9e11'
const ID_2 = '5d2e8a90-7b13-4f6e-8c21-9e4d0a6b3c77'

const LOCAL: RuntimeView = { id: 'local', kind: 'local', name: 'host-0 (Local)', url: null, state: 'connected' }
const REMOTE: RuntimeView = { id: HOST_1, kind: 'remote', name: 'host-1', url: 'https://host-1.example:7386', state: 'connected' }

function view(runtimes?: RuntimeView[]): ConnectionsView {
  return {
    current: { id: 'local', kind: 'local', name: 'host-0 (Local)', url: null, state: 'connected' },
    next: null,
    rows: [],
    discovery: null,
    ...(runtimes ? { runtimes } : {}),
  }
}

/** A fresh renderer page: module state and the window it sees. */
async function load(adfApi: Record<string, unknown> = {}) {
  vi.resetModules()
  vi.stubGlobal('window', { location: { search: '' }, adfApi: { platform: 'win32', ...adfApi } })
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
  return {
    runtimes: await import('../../../src/renderer/stores/runtimes.store'),
    connection: await import('../../../src/renderer/stores/connection.store'),
    tracked: await import('../../../src/renderer/stores/tracked-dirs.store'),
    background: await import('../../../src/renderer/stores/background-agents.store'),
    mesh: await import('../../../src/renderer/stores/mesh.store'),
    queue: await import('../../../src/renderer/stores/message-queue.store'),
    windows: await import('../../../src/renderer/stores/open-agent-windows.store'),
    ref: await import('../../../src/shared/types/agent-ref'),
  }
}

beforeEach(() => { vi.unstubAllGlobals() })
afterEach(() => { vi.unstubAllGlobals() })

describe('the runtime set', () => {
  it('with no list from main is the one runtime this window uses; multi-runtime only with more than one', async () => {
    const { runtimes, connection } = await load()
    expect(runtimes.useRuntimesStore.getState().runtimes).toEqual([])
    connection.useConnectionStore.getState().setView(view())
    expect(runtimes.useRuntimesStore.getState().runtimes).toEqual([LOCAL])
    expect(runtimes.multiRuntime(runtimes.useRuntimesStore.getState().runtimes)).toBe(false)
    connection.useConnectionStore.getState().setView(view([LOCAL, REMOTE]))
    expect(runtimes.useRuntimesStore.getState().runtimes.map((r) => r.id)).toEqual(['local', HOST_1])
    expect(runtimes.multiRuntime(runtimes.useRuntimesStore.getState().runtimes)).toBe(true)
  })

  it('keeps its array when a push leaves the set as it was', async () => {
    const { runtimes, connection } = await load()
    connection.useConnectionStore.getState().setView(view([LOCAL, REMOTE]))
    const before = runtimes.useRuntimesStore.getState().runtimes
    connection.useConnectionStore.getState().setView(view([LOCAL, REMOTE]))
    expect(runtimes.useRuntimesStore.getState().runtimes).toBe(before)
  })

  it('names runtimes only while there is more than one; a down runtime says its state', async () => {
    const { runtimes } = await load()
    expect(runtimes.runtimeLabel(HOST_1, [LOCAL])).toBeNull()
    expect(runtimes.runtimeLabel(undefined, [LOCAL])).toBeNull()
    expect(runtimes.runtimeLabel(undefined, [LOCAL, REMOTE])).toBe('host-0 (Local)')
    expect(runtimes.runtimeLabel(HOST_1, [LOCAL, REMOTE])).toBe('host-1')
    const down: RuntimeView = { ...REMOTE, state: 'retrying' }
    expect(runtimes.runtimeHeader(down)).toBe('host-1 · Not connected, retrying')
    expect(runtimes.runtimeHeader(LOCAL)).toBe('host-0 (Local)')
    expect(runtimes.runtimeDown(HOST_1, [LOCAL, down])).toBe(true)
    expect(runtimes.runtimeDown(undefined, [LOCAL, down])).toBe(false)
  })
})

describe('per-runtime stores', () => {
  it('tracked folders: This computer stays at the top level; another runtime has its own slice', async () => {
    const { tracked } = await load()
    const s = () => tracked.useTrackedDirsStore.getState()
    s().setDirectories(['/agents'])
    s().setFilesForDir('/agents', [{ filePath: AGENT_1, fileName: 'agent-1.adf' }])
    s().setDirectories(['/agents'], HOST_1)
    s().setFilesForDir('/agents', [{ filePath: AGENT_1, fileName: 'agent-1.adf', agentName: 'agent-1' }], HOST_1)
    expect(s().directories).toEqual(['/agents'])
    expect(s().filesByDir['/agents'][0].agentName).toBeUndefined()
    expect(tracked.selectTrackedSlice(s(), HOST_1).filesByDir['/agents'][0].agentName).toBe('agent-1')
    expect(tracked.selectTrackedSlice(s(), 'local')).toBe(s())

    s().updateFileEntry(AGENT_1, { pendingName: 'agent-3' }, HOST_1)
    expect(tracked.selectTrackedSlice(s(), HOST_1).filesByDir['/agents'][0].pendingName).toBe('agent-3')
    expect(s().filesByDir['/agents'][0].pendingName).toBeUndefined()

    s().removeDir('/agents', HOST_1)
    expect(tracked.selectTrackedSlice(s(), HOST_1).directories).toEqual([])
    expect(s().directories).toEqual(['/agents'])

    s().dropRuntime(HOST_1)
    expect(s().byRuntime).toEqual({})
  })

  it('running agents and the mesh: one slice per runtime, This computer at the top level', async () => {
    const { background, mesh } = await load()
    background.useBackgroundAgentsStore.getState().setAgents([{ filePath: AGENT_1, handle: 'agent-1', state: 'idle', activeLoops: 0 }], HOST_1)
    expect(background.useBackgroundAgentsStore.getState().agents).toEqual([])
    expect(background.selectBackgroundAgents(background.useBackgroundAgentsStore.getState(), HOST_1).map((a) => a.filePath)).toEqual([AGENT_1])
    expect(background.selectBackgroundAgents(background.useBackgroundAgentsStore.getState(), HOST_2)).toEqual([])

    const m = () => mesh.useMeshStore.getState()
    m().setEnabled(true, HOST_1)
    m().upsertAgents([{ filePath: AGENT_1, handle: 'agent-1', state: 'idle' } as never], HOST_1)
    expect(m().enabled).toBe(false)
    expect(m().agents).toEqual([])
    expect(mesh.selectMeshSlice(m(), HOST_1)).toMatchObject({ enabled: true, agents: [{ filePath: AGENT_1, online: true }] })
    const before = m()
    m().updateAgentState(AGENT_1, 'idle', HOST_1)
    expect(m()).toBe(before)
    m().reset(HOST_1)
    expect(mesh.selectMeshSlice(m(), HOST_1)).toMatchObject({ enabled: false, agents: [] })
    m().dropRuntime(HOST_1)
    expect(m().byRuntime).toEqual({})
  })
})

describe('agent refs', () => {
  it('a key of This computer is its path, so local maps and saved keys keep their bytes', async () => {
    const { ref } = await load()
    expect(ref.agentKey({ filePath: AGENT_1 })).toBe(AGENT_1)
    expect(ref.agentKey({ runtimeId: 'local', filePath: AGENT_1 })).toBe(AGENT_1)
    expect(ref.agentKey({ runtimeId: HOST_1, filePath: AGENT_1 })).not.toBe(AGENT_1)
    expect(ref.parseAgentKey(ref.agentKey({ runtimeId: HOST_1, filePath: AGENT_1 }))).toEqual({ runtimeId: HOST_1, filePath: AGENT_1 })
    expect(ref.parseAgentKey(AGENT_1)).toEqual({ runtimeId: 'local', filePath: AGENT_1 })
  })

  it('the same agent id on two runtimes is two agents; on one runtime, the id wins over the path', async () => {
    const { ref } = await load()
    expect(ref.sameAgent({ runtimeId: HOST_1, agentId: ID_1, filePath: AGENT_1 }, { runtimeId: HOST_2, agentId: ID_1, filePath: AGENT_1 })).toBe(false)
    expect(ref.sameAgent({ agentId: ID_1, filePath: AGENT_1 }, { runtimeId: HOST_1, agentId: ID_1, filePath: AGENT_1 })).toBe(false)
    expect(ref.sameAgent({ runtimeId: HOST_1, agentId: ID_1, filePath: AGENT_1 }, { runtimeId: HOST_1, agentId: ID_1, filePath: AGENT_2 })).toBe(true)
    expect(ref.sameAgent({ runtimeId: HOST_1, agentId: ID_1, filePath: AGENT_1 }, { runtimeId: HOST_1, agentId: ID_2, filePath: AGENT_1 })).toBe(false)
    expect(ref.sameAgent({ runtimeId: HOST_1, agentId: null, filePath: AGENT_1 }, { runtimeId: HOST_1, agentId: ID_1, filePath: AGENT_1 })).toBe(true)
  })

  it('queues: equal paths on two runtimes are two queues; a remote path is not case-folded', async () => {
    const { queue, ref } = await load()
    const q = () => queue.useMessageQueueStore.getState()
    const remote = ref.agentKey({ runtimeId: HOST_1, filePath: 'C:/Agents/Agent-1.adf' })
    q().enqueue('C:/Agents/Agent-1.adf', 'main', { text: 'local' })
    q().enqueue(remote, 'main', { text: 'remote' })
    expect(queue.selectQueue(q(), 'c:\\agents\\agent-1.adf', 'main').map((m) => m.text)).toEqual(['local'])
    expect(queue.selectQueue(q(), remote, 'main').map((m) => m.text)).toEqual(['remote'])
    expect(queue.selectQueue(q(), ref.agentKey({ runtimeId: HOST_1, filePath: 'c:/agents/agent-1.adf' }), 'main')).toEqual([])
  })

  it('agent windows: a window of one runtime does not mark the same path or id on another', async () => {
    const { windows } = await load()
    const open = [{ filePath: AGENT_1, agentId: ID_1, runtimeId: HOST_1 }]
    expect(windows.isInAgentWindow(open, AGENT_1, ID_1)).toBe(false)
    expect(windows.isInAgentWindow(open, AGENT_1, ID_1, HOST_2)).toBe(false)
    expect(windows.isInAgentWindow(open, AGENT_1, null, HOST_1)).toBe(true)
    expect(windows.isInAgentWindow(open, AGENT_2, ID_1, HOST_1)).toBe(true)
    expect(windows.isInAgentWindow([{ filePath: AGENT_1, agentId: ID_1 }], AGENT_1, null)).toBe(true)
  })
})

describe('approvals across runtimes', () => {
  const pending = (id: string, runtimeId?: string): PendingNotification => ({
    id, kind: 'approval', filePath: AGENT_1, agentName: 'agent-1', loop: 'main', requestId: id, toolName: 'fs_write', preview: 'a.md', requestedAt: 1,
    ...(runtimeId ? { runtimeId } : {}),
  } as PendingNotification)

  it('equal ids on two runtimes are two arrivals; the open agent of one runtime silences only its own', async () => {
    vi.resetModules()
    vi.stubGlobal('window', { location: { search: '' }, adfApi: { platform: 'linux' } })
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
    const { arrivalsToAnnounce } = await import('../../../src/renderer/hooks/useApprovals')
    const snapshot: NotificationsSnapshot = { pending: [pending('n1'), pending('n1', HOST_1)], history: [] }
    const seen = new Set<string>()
    expect(arrivalsToAnnounce(snapshot, seen, null).map((n) => n.runtimeId ?? 'local')).toEqual(['local', HOST_1])
    expect(arrivalsToAnnounce(snapshot, seen, null)).toEqual([])
    expect(arrivalsToAnnounce(snapshot, new Set(), AGENT_1).map((n) => n.runtimeId)).toEqual([HOST_1])
  })

  it('a map badge carries the hub id, which fetches the input, apart from the executor request id', async () => {
    vi.resetModules()
    vi.stubGlobal('window', { location: { search: '' }, adfApi: { platform: 'linux' } })
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
    const { toPendingInteractions } = await import('../../../src/renderer/hooks/useApprovals')
    const { agentKey } = await import('../../../src/shared/types/agent-ref')
    const { approvalHub, notificationKey } = await import('../../../src/main/runtime/approval-hub')
    const id = notificationKey(AGENT_1, 'main', 'task-1')
    approvalHub.register({
      id, kind: 'approval', requestId: 'task-1', filePath: AGENT_1, agentName: 'agent-1', loop: 'main',
      toolName: 'sys_update_config', preview: '', input: { path: 'model', value: 'x' }, requestedAt: 1, resolve: () => {},
    } as Parameters<typeof approvalHub.register>[0])
    try {
      // The snapshot a remote runtime pushes: no input, its runtimeId added by the aggregator.
      const [row] = approvalHub.snapshot()
      const badge = toPendingInteractions([{ ...row, runtimeId: HOST_1 }])[agentKey({ runtimeId: HOST_1, filePath: AGENT_1 })]
      expect(badge).toMatchObject({ type: 'approval', requestId: 'task-1', approvalId: id })
      expect(badge?.type === 'approval' ? badge.input : 'x').toBeUndefined()
      expect(approvalHub.getApprovalInput(AGENT_1, badge?.type === 'approval' ? badge.approvalId ?? '' : '')).toEqual({ path: 'model', value: 'x' })
      expect(approvalHub.getApprovalInput(AGENT_1, 'task-1')).toBeUndefined()
    } finally {
      approvalHub.unregister(id)
    }
  })

  it('a toast is keyed by runtime and id, and goes when its own request is answered', async () => {
    await load()
    const { useApprovalsStore } = await import('../../../src/renderer/stores/approvals.store')
    const { noticeKey } = await import('../../../src/shared/runtime-tag')
    const s = () => useApprovalsStore.getState()
    s().pushToast({ id: noticeKey(undefined, 'n1'), kind: 'approval', agentName: 'agent-1', loop: 'main', detail: 'fs_write', filePath: AGENT_1 })
    s().pushToast({ id: noticeKey(HOST_1, 'n1'), runtimeId: HOST_1, kind: 'approval', agentName: 'agent-1', loop: 'main', detail: 'fs_write', filePath: AGENT_1 })
    expect(s().toasts).toHaveLength(2)
    s().setSnapshot({ pending: [pending('n1', HOST_1)], history: [] })
    expect(s().toasts.map((t) => t.runtimeId)).toEqual([HOST_1])
  })

  it('an answer goes to its request\'s runtime; This computer\'s through window.adfApi itself', async () => {
    const bound = { resolvePendingApproval: vi.fn() }
    const runtime = vi.fn(() => bound)
    await load()
    // The bridge is the page's global adfApi (approvals.store).
    const api = { platform: 'win32', runtimeId: 'local', runtime }
    vi.stubGlobal('adfApi', api)
    const { approvalsBridge } = await import('../../../src/renderer/stores/approvals.store')
    expect(approvalsBridge()).toBe(api)
    expect(approvalsBridge('local')).toBe(api)
    expect(runtime).not.toHaveBeenCalled()
    expect(approvalsBridge(HOST_1)).toBe(bound)
    expect(runtime).toHaveBeenCalledWith(HOST_1)
  })
})

describe('apiFor', () => {
  it('is window.adfApi for This computer, the bound surface for another runtime', async () => {
    const bound = { openFile: vi.fn() }
    const runtime = vi.fn(() => bound)
    await load({ runtimeId: 'local', runtime })
    const { apiFor } = await import('../../../src/renderer/utils/runtime-api')
    const api = (globalThis as { window: { adfApi: unknown } }).window.adfApi
    expect(apiFor()).toBe(api)
    expect(apiFor('local')).toBe(api)
    expect(runtime).not.toHaveBeenCalled()
    expect(apiFor(HOST_1)).toBe(bound)
  })
})
