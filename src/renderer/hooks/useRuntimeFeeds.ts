import { useEffect } from 'react'
import { useRuntimesStore } from '../stores/runtimes.store'
import { useTrackedDirsStore } from '../stores/tracked-dirs.store'
import { useBackgroundAgentsStore, selectBackgroundAgents } from '../stores/background-agents.store'
import { useMeshStore, selectMeshSlice } from '../stores/mesh.store'
import { useAppStore } from '../stores/app.store'
import { reportFailure } from '../stores/failure-notices.store'
import { trackedDirsActions } from './useTrackedDirs'
import { apiFor } from '../utils/runtime-api'
import { isAgentWindow } from '../utils/window-kind'
import { useDocumentStore } from '../stores/document.store'
import { useMessageQueueStore } from '../stores/message-queue.store'
import { foldAgentStatuses } from '../utils/background-agent-statuses'
import { deliverSettledBackgroundQueues } from '../utils/queued-delivery'
import { agentKey } from '../../shared/types/agent-ref'
import { LOCAL_RUNTIME, type RuntimeId } from '../../shared/runtime-tag'
import type { RuntimeView } from '../../shared/types/connection.types'
import type { MeshEvent, RendererBackgroundAgentEvent } from '../../shared/types/ipc.types'

/**
 * The main window's view of every runtime other than This computer
 * (docs/design/multi-runtime.md §5.3): its tracked folders, its running
 * agents and its mesh, each in that runtime's slice of the store. This
 * computer's slices are fed as before (useAutoRefresh,
 * useBackgroundAgentEvents, useMeshEvents), so with This computer only this
 * hook makes no call.
 *
 * A runtime is read when it connects and followed through its pushes. While
 * it is down its slices keep the last list (§3.6); when it leaves the set
 * they go.
 */

interface Feed {
  /** The state the feed last saw; a move to `connected` reads the runtime again. */
  state: RuntimeView['state'] | null
  unsubscribe: Array<() => void>
}

const feeds = new Map<RuntimeId, Feed>()

/** A batch of a runtime's background events: its list, its spinners (agent keys) and its queues. */
export function applyRuntimeBackgroundBatch(runtimeId: RuntimeId, events: RendererBackgroundAgentEvent[]): void {
  const store = useBackgroundAgentsStore.getState()
  const previous = selectBackgroundAgents(store, runtimeId)
  const agents = foldAgentStatuses(previous, events)
  if (agents !== previous) store.setAgents(agents, runtimeId)
  const app = useAppStore.getState()
  const key = (filePath: string) => agentKey({ runtimeId, filePath })
  for (const event of events) {
    const k = key(event.payload.filePath)
    switch (event.type) {
      case 'agent_starting': app.addStartingFilePath(k); break
      case 'agent_start_failed':
      case 'agent_started': app.removeStartingFilePath(k); break
      case 'agent_stopping': app.addStoppingFilePath(k); break
      case 'agent_stopped': app.removeStartingFilePath(k); app.removeStoppingFilePath(k); break
    }
  }
  // A turn that ended sends what was queued for it, on its runtime (queues are keyed by agent key).
  const keyed = agents.map((a) => ({ ...a, filePath: key(a.filePath) }))
  const keyedEvents = events.map((e) => ({ ...e, payload: { ...e.payload, filePath: key(e.payload.filePath) } })) as RendererBackgroundAgentEvent[]
  deliverSettledBackgroundQueues(keyed, keyedEvents, () => false)
}

/** One mesh event of a runtime, into its slice. */
export function applyRuntimeMeshEvent(runtimeId: RuntimeId, event: MeshEvent, refresh: () => void): void {
  const store = useMeshStore.getState()
  switch (event.type) {
    case 'agent_state_changed':
      if (event.payload.state) store.updateAgentState(event.payload.filePath, event.payload.state, runtimeId)
      break
    case 'agent_joined':
      refresh()
      break
    case 'agent_left':
      store.markAgentOffline(event.payload.filePath, runtimeId)
      refresh()
      break
  }
}

function load(runtime: RuntimeView): void {
  const id = runtime.id
  const api = apiFor(id)
  void trackedDirsActions(id).loadDirectories().catch((err: unknown) => reportFailure(`${runtime.name}: tracked folders not loaded`, err))
  void api.getBackgroundAgentStatus().then((result) => {
    useBackgroundAgentsStore.getState().setAgents(result.agents, id)
    for (const fp of result.starting ?? []) useAppStore.getState().addStartingFilePath(agentKey({ runtimeId: id, filePath: fp }))
  }).catch((err: unknown) => reportFailure(`${runtime.name}: running agents not loaded`, err))
  readMesh(id, runtime.name)
}

function readMesh(id: RuntimeId, name: string): void {
  const rev = selectMeshSlice(useMeshStore.getState(), id).enabledRev
  void apiFor(id).getMeshStatus().then((status) => {
    useMeshStore.getState().upsertAgents(status.agents ?? [], id)
    useMeshStore.getState().syncEnabled(status.running === true, rev, id)
  }).catch((err: unknown) => console.warn(`[Runtimes] ${name}: the mesh status was not read:`, err))
}

function subscribe(runtime: RuntimeView): Array<() => void> {
  const id = runtime.id
  const api = apiFor(id)
  const { onChanged } = trackedDirsActions(id)
  let meshTimer: ReturnType<typeof setTimeout> | null = null
  const refreshMesh = (): void => {
    if (meshTimer) clearTimeout(meshTimer)
    meshTimer = setTimeout(() => { meshTimer = null; readMesh(id, runtime.name) }, 250)
  }
  return [
    api.onTrackedDirsChanged(({ dirPath }) => {
      onChanged(dirPath).catch((err: unknown) => reportFailure(`${runtime.name}: ${dirPath} not rescanned`, err))
    }),
    api.onBackgroundAgentEvents((events) => applyRuntimeBackgroundBatch(id, events)),
    api.onMeshEvent((event) => applyRuntimeMeshEvent(id, event, refreshMesh)),
    // A rename on that runtime: the open agent's path and its queues follow it.
    api.onFileRenamed(({ oldPath, newPath }) => {
      const doc = useDocumentStore.getState()
      if (doc.runtimeId === id && doc.filePath === oldPath) doc.setFilePath(newPath)
      useMessageQueueStore.getState().rekey(agentKey({ runtimeId: id, filePath: oldPath }), agentKey({ runtimeId: id, filePath: newPath }))
    }),
    () => { if (meshTimer) clearTimeout(meshTimer) },
  ]
}

/** Follow the runtime set: start a feed for each runtime that joined, read it when it connects, end it when it leaves. */
export function syncRuntimeFeeds(runtimes: readonly RuntimeView[]): void {
  const others = runtimes.length > 1 ? runtimes.filter((r) => r.id !== LOCAL_RUNTIME) : []
  for (const [id, feed] of [...feeds]) {
    if (others.some((r) => r.id === id)) continue
    for (const off of feed.unsubscribe) off()
    feeds.delete(id)
    useTrackedDirsStore.getState().dropRuntime(id)
    useBackgroundAgentsStore.getState().dropRuntime(id)
    useMeshStore.getState().dropRuntime(id)
  }
  for (const runtime of others) {
    let feed = feeds.get(runtime.id)
    if (!feed) {
      feed = { state: null, unsubscribe: subscribe(runtime) }
      feeds.set(runtime.id, feed)
    }
    const was = feed.state
    feed.state = runtime.state
    if (runtime.state === 'connected' && was !== 'connected') load(runtime)
  }
}

/** Main window: feed the slices of every runtime other than This computer. */
export function useRuntimeFeeds(): void {
  useEffect(() => {
    // An agent window shows one agent of one runtime: its stores are that runtime's.
    if (isAgentWindow) return
    syncRuntimeFeeds(useRuntimesStore.getState().runtimes)
    const off = useRuntimesStore.subscribe((s, prev) => { if (s.runtimes !== prev.runtimes) syncRuntimeFeeds(s.runtimes) })
    return () => {
      off()
      syncRuntimeFeeds([])
    }
  }, [])
}
