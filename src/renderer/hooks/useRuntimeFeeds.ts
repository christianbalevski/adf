import { useEffect, useRef } from 'react'
import { useRuntimesStore } from '../stores/runtimes.store'
import { useTrackedDirsStore } from '../stores/tracked-dirs.store'
import { useBackgroundAgentsStore, selectBackgroundAgents } from '../stores/background-agents.store'
import { useMeshStore, selectMeshSlice } from '../stores/mesh.store'
import { useAppStore } from '../stores/app.store'
import { reportFailure, agentNameOf, useFailureNoticesStore } from '../stores/failure-notices.store'
import { useFleetStore } from '../stores/fleet.store'
import { forgetRuntimeFleet } from '../components/mesh/runtime-fleet'
import { trackedDirsActions } from './useTrackedDirs'
import { openingFilePaths, useAdfFile } from './useAdfFile'
import { apiFor, openAgentKey } from '../utils/runtime-api'
import { isAgentWindow } from '../utils/window-kind'
import { stashUnsavedEditors } from '../utils/edit-recovery'
import { useDocumentStore } from '../stores/document.store'
import { useMessageQueueStore } from '../stores/message-queue.store'
import { useAgentStore } from '../stores/agent.store'
import { useEditorTabsStore } from '../stores/editor-tabs.store'
import { foldAgentStatuses } from '../utils/background-agent-statuses'
import { deliverSettledBackgroundQueues } from '../utils/queued-delivery'
import { agentKey, parseAgentKey } from '../../shared/types/agent-ref'
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
  /** Its name as last listed: a runtime that left the set is named by it. */
  name: string
  unsubscribe: Array<() => void>
}

const feeds = new Map<RuntimeId, Feed>()

/** Opens an agent in the main window (useAdfFile's openFile): the open agent of a runtime that connected again. */
export type ReopenAgent = (filePath: string, runtimeId: RuntimeId) => Promise<unknown>

/** A notice the user sees (bottom right, until dismissed). */
function notice(text: string): void {
  console.log(`[Runtimes] ${text}`)
  useFailureNoticesStore.getState().push(text)
}

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
      // As on This computer (useBackgroundAgentEvents): an agent being opened moved to the foreground,
      // it did not stop; its re-attach clears the mark.
      case 'agent_stopped':
        if (k !== openAgentKey() && !openingFilePaths.has(k)) app.removeStartingFilePath(k)
        app.removeStoppingFilePath(k)
        break
    }
  }
  // A turn that ended sends what was queued for it, on its runtime (queues are keyed by agent key);
  // the agent being opened is its re-attach's.
  const keyed = agents.map((a) => ({ ...a, filePath: key(a.filePath) }))
  const keyedEvents = events.map((e) => ({ ...e, payload: { ...e.payload, filePath: key(e.payload.filePath) } })) as RendererBackgroundAgentEvent[]
  deliverSettledBackgroundQueues(keyed, keyedEvents, (fp) => openingFilePaths.has(fp))
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

/** The main window shows Home: the open agent's view goes. */
function closeOpenAgent(): void {
  useDocumentStore.getState().reset()
  useAgentStore.getState().reset()
  useAppStore.getState().resetAgentReview()
  useEditorTabsStore.getState().reset()
}

/**
 * A runtime left the set: what the main window kept per agent of it goes
 * (queues, drafts, starting and stopping marks, the fleet selection), so an
 * agent added again under the same name starts clean. Answers how many
 * queued messages were discarded.
 */
function dropAgentState(id: RuntimeId): number {
  const of = (key: string): boolean => parseAgentKey(key).runtimeId === id
  const queues = useMessageQueueStore.getState().queues
  let discarded = 0
  for (const [k, loops] of Object.entries(queues)) if (of(k)) for (const list of Object.values(loops)) discarded += list.length
  if (Object.keys(queues).some(of)) useMessageQueueStore.setState({ queues: Object.fromEntries(Object.entries(queues).filter(([k]) => !of(k))) })
  const drafts = useDocumentStore.getState().draftInputs
  if (Object.keys(drafts).some(of)) useDocumentStore.setState({ draftInputs: Object.fromEntries(Object.entries(drafts).filter(([k]) => !of(k))) })
  const app = useAppStore.getState()
  if ([...app.startingFilePaths].some(of) || [...app.stoppingFilePaths].some(of)) {
    useAppStore.setState({
      startingFilePaths: new Set([...app.startingFilePaths].filter((k) => !of(k))),
      stoppingFilePaths: new Set([...app.stoppingFilePaths].filter((k) => !of(k))),
    })
  }
  const fleet = useFleetStore.getState()
  const groups = Object.entries(fleet.controlGroups)
  if (fleet.selection.some(of) || fleet.family.some(of) || Object.keys(fleet.starting).some(of) || groups.some(([, paths]) => paths.some(of))) {
    useFleetStore.setState({
      selection: fleet.selection.filter((k) => !of(k)),
      family: fleet.family.filter((k) => !of(k)),
      starting: Object.fromEntries(Object.entries(fleet.starting).filter(([k]) => !of(k))),
      controlGroups: Object.fromEntries(groups.map(([digit, paths]) => [digit, paths.filter((k) => !of(k))])),
    })
  }
  return discarded
}

/**
 * The main window's open agent is on `runtime`, which connected: when the
 * runtime no longer has it open (Reconnect replaced its connection, §3.4),
 * the agent is opened again, its unsaved editors kept as recovery copies
 * first, and the user is told. An open that fails shows Home, said.
 */
async function resyncOpenAgent(runtime: RuntimeView, reopen: ReopenAgent | null): Promise<void> {
  const { filePath, runtimeId } = useDocumentStore.getState()
  if (!filePath || runtimeId !== runtime.id) return
  let held: string | null = null
  try {
    held = (await apiFor(runtime.id).getCurrentFile())?.filePath ?? null
  } catch (err) {
    console.warn(`[Runtimes] ${runtime.name}: its open file was not read:`, err)
  }
  const now = useDocumentStore.getState()
  // Still open there, or the user has moved on meanwhile.
  if (held === filePath || now.filePath !== filePath || now.runtimeId !== runtime.id) return
  console.log(`[Runtimes] ${runtime.id} connected without ${filePath} open: opening it again`)
  const agent = useAgentStore.getState().config?.name || agentNameOf(filePath)
  const kept = await stashUnsavedEditors().catch(() => 0)
  const keptText = kept > 0 ? '; unsaved changes kept for recovery' : ''
  let opened = false
  if (reopen) {
    const result = await reopen(filePath, runtime.id).catch((err: unknown) => ({ success: false, error: err }))
    const after = useDocumentStore.getState()
    opened = (result as { success?: boolean } | undefined)?.success === true && after.filePath === filePath && after.runtimeId === runtime.id
  }
  if (opened) {
    notice(`${runtime.name} reconnected; ${agent} reopened${keptText}.`)
    return
  }
  const after = useDocumentStore.getState()
  if (after.filePath === filePath && after.runtimeId === runtime.id) closeOpenAgent()
  notice(`${runtime.name} reconnected; ${agent} closed${keptText}.`)
}

/**
 * Follow the runtime set: start a feed for each runtime that joined, read it
 * when it connects, end it when it leaves. `reopen` opens the open agent of a
 * runtime that connected without it (useAdfFile's openFile).
 */
export function syncRuntimeFeeds(runtimes: readonly RuntimeView[], reopen: ReopenAgent | null = null): void {
  const others = runtimes.length > 1 ? runtimes.filter((r) => r.id !== LOCAL_RUNTIME) : []
  for (const [id, feed] of [...feeds]) {
    if (others.some((r) => r.id === id)) continue
    for (const off of feed.unsubscribe) off()
    feeds.delete(id)
    useTrackedDirsStore.getState().dropRuntime(id)
    useBackgroundAgentsStore.getState().dropRuntime(id)
    useMeshStore.getState().dropRuntime(id)
    // The page is going (unmount): nothing was removed.
    if (runtimes.length === 0) continue
    const said: string[] = []
    // The open agent was on it (Remove, multi-runtime.md §3.3): the main window shows Home, its
    // unsaved editors kept as recovery copies first; main already closed its file there.
    const doc = useDocumentStore.getState()
    let kept: Promise<number> = Promise.resolve(0)
    if (doc.runtimeId === id && doc.filePath) {
      console.log(`[Runtimes] ${id} left the set: closing its open agent ${doc.filePath}`)
      said.push(`${useAgentStore.getState().config?.name || agentNameOf(doc.filePath)} closed`)
      // It reads every editor before its first await: the reset below loses nothing.
      kept = stashUnsavedEditors()
      closeOpenAgent()
    }
    const discarded = dropAgentState(id)
    // Main deleted its saved fleet entry: the copy a later fleet save writes from goes too.
    forgetRuntimeFleet(id)
    if (discarded > 0) said.push(`${discarded} queued message${discarded === 1 ? '' : 's'} discarded`)
    void kept.catch(() => 0).then((n) => {
      if (n > 0) said.push('unsaved changes kept for recovery')
      if (said.length > 0) notice(`${feed.name} removed; ${said.join('; ')}.`)
    })
  }
  for (const runtime of others) {
    let feed = feeds.get(runtime.id)
    if (!feed) {
      feed = { state: null, name: runtime.name, unsubscribe: subscribe(runtime) }
      feeds.set(runtime.id, feed)
    }
    feed.name = runtime.name
    const was = feed.state
    feed.state = runtime.state
    if (runtime.state === 'connected' && was !== 'connected') {
      load(runtime)
      void resyncOpenAgent(runtime, reopen)
    }
  }
}

/** Main window: feed the slices of every runtime other than This computer. */
export function useRuntimeFeeds(): void {
  const { openFile } = useAdfFile()
  const opener = useRef(openFile)
  opener.current = openFile
  useEffect(() => {
    // An agent window shows one agent of one runtime: its stores are that runtime's.
    if (isAgentWindow) return
    const reopen: ReopenAgent = (filePath, runtimeId) => opener.current(filePath, runtimeId)
    syncRuntimeFeeds(useRuntimesStore.getState().runtimes, reopen)
    const off = useRuntimesStore.subscribe((s, prev) => { if (s.runtimes !== prev.runtimes) syncRuntimeFeeds(s.runtimes, reopen) })
    return () => {
      off()
      syncRuntimeFeeds([])
    }
  }, [])
}
