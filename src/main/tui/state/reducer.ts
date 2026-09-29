// Pure reducer for the TUI state tree. Side effects (fetches, SSE) live in
// store.tsx; this file only turns actions into the next state.

import type { ConnectionInfo } from '../api/sse'
import {
  MAIN_LOOP,
  type AgentConfig,
  type AgentStatus,
  type AgentSummary,
  type AskEntry,
  type AuthDiagnostics,
  type DaemonEventFrame,
  type ExecutorState,
  type IdentityStatus,
  type LoopEntry,
  type LoopInfo,
  type TaskEntry,
  type TrackedAgentsList,
  type UmbilicalEvent,
} from '../api/types'
import { buildTracked, pruneLoaded, reconcileSelection } from './tracked'
import {
  applyEventToItems,
  emptyTranscript,
  finalizeStreaming,
  historyToItems,
  localId,
  mergeHistory,
  prependHistory,
  summarizeEvent,
} from './transcript'
import {
  transcriptKey,
  type AgentEntry,
  type FocusZone,
  type Overlay,
  type Toast,
  type Transcript,
  type TranscriptItem,
  type TranscriptKey,
  type TuiState,
  type WebState,
} from './types'

export const MAX_ACTIVITY = 500
/** The live event tail (Inspect / Runtime Events) keeps this many; older ones drop off. */
export const MAX_LAST_EVENTS = 5000

export type TuiAction =
  | { type: 'connection'; info: ConnectionInfo }
  | { type: 'daemon/reachable'; reachable: boolean }
  | { type: 'agents/loaded'; agents: AgentSummary[] }
  | { type: 'agent/status'; agentId: string; status: AgentStatus }
  | { type: 'agent/config'; agentId: string; config: AgentConfig }
  | { type: 'agent/error'; agentId: string; error: string | undefined }
  | { type: 'agent/removed'; agentId: string }
  | { type: 'loops/loaded'; agentId: string; loops: LoopInfo[] }
  | { type: 'loops/error'; agentId: string; error: string }
  | { type: 'hil/loaded'; agentId: string; tasks: TaskEntry[]; asks: AskEntry[] }
  | { type: 'select/agent'; agentId: string | null }
  | { type: 'select/loop'; agentId: string; loop: string }
  | { type: 'view/set'; view: string }
  | { type: 'focus/set'; focus: FocusZone }
  | { type: 'overlay/push'; overlay: Overlay }
  | { type: 'overlay/pop'; id?: string }
  | { type: 'toast/add'; toast: Toast }
  | { type: 'toast/dismiss'; id: string }
  | { type: 'transcript/loading'; key: TranscriptKey }
  | { type: 'transcript/history'; key: TranscriptKey; entries: LoopEntry[]; total: number; offset: number; mode: 'replace' | 'prepend' }
  | { type: 'transcript/error'; key: TranscriptKey; error: string }
  | { type: 'transcript/append'; key: TranscriptKey; item: TranscriptItem }
  | { type: 'transcript/update'; key: TranscriptKey; id: string; patch: Partial<TranscriptItem> }
  | { type: 'transcript/reset'; key: TranscriptKey }
  /** The loop's turn is over (interrupted, stopped): close streaming items, clear `live`. */
  | { type: 'transcript/idle'; key: TranscriptKey }
  | { type: 'event'; frame: DaemonEventFrame }
  /** Frames that arrived together (one SSE read): one state change, one render. */
  | { type: 'events'; frames: DaemonEventFrame[] }
  | { type: 'viewState/set'; view: string; value: unknown }
  | { type: 'daemon/switch'; url: string }
  | { type: 'identity/set'; identity: IdentityStatus | null }
  | { type: 'auth/set'; auth: AuthDiagnostics | null }
  | { type: 'web/set'; web: WebState | null }
  | { type: 'tracked/loaded'; list: TrackedAgentsList }
  | { type: 'tracked/error'; error: string }
  /** A load / start error for a tracked file (undefined clears it). */
  | { type: 'tracked/file-error'; filePath: string; error: string | undefined }
  /** Work in progress on a tracked file (`loading`, `starting`; undefined = done). */
  | { type: 'tracked/busy'; filePath: string; busy: string | undefined }

export function initialState(daemonUrl: string, activeView = 'fleet'): TuiState {
  return {
    daemonUrl,
    connection: { state: 'idle', attempt: 0 },
    daemonReachable: null,
    identity: null,
    auth: null,
    web: null,
    tracked: null,
    agents: {},
    agentOrder: [],
    selectedAgentId: null,
    selectedLoop: {},
    transcripts: {},
    activeView,
    // Launching into Chat starts in the composer.
    focus: activeView === 'chat' ? 'input' : 'main',
    overlays: [],
    toasts: [],
    activity: [],
    lastEvents: [],
    viewState: {},
  }
}

function newAgent(summary: AgentSummary): AgentEntry {
  return {
    summary,
    pendingTasks: [],
    pendingAsks: [],
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    unreadInbox: 0,
  }
}

function patchAgent(state: TuiState, agentId: string, patch: (agent: AgentEntry) => AgentEntry): TuiState {
  const agent = state.agents[agentId]
  if (!agent) return state
  const next = patch(agent)
  return next === agent ? state : { ...state, agents: { ...state.agents, [agentId]: next } }
}

function patchTranscript(state: TuiState, key: TranscriptKey, patch: (t: Transcript) => Transcript): TuiState {
  const current = state.transcripts[key] ?? emptyTranscript()
  const next = patch(current)
  return next === current ? state : { ...state, transcripts: { ...state.transcripts, [key]: next } }
}

const RUNNING_STATES = new Set(['thinking', 'tool_use', 'awaiting_approval', 'awaiting_ask'])

export function isBusyState(state: string | undefined): boolean {
  return !!state && RUNNING_STATES.has(state)
}

export function tuiReducer(state: TuiState, action: TuiAction): TuiState {
  switch (action.type) {
    case 'connection':
      return { ...state, connection: action.info, daemonReachable: action.info.state === 'open' ? true : state.daemonReachable }
    case 'daemon/switch':
      // A different daemon: its agents, transcripts and event cursor are not
      // ours. Shell state (view, focus, overlays, toasts, view state) stays.
      return {
        ...initialState(action.url, state.activeView),
        focus: state.focus,
        overlays: state.overlays,
        toasts: state.toasts,
        viewState: state.viewState,
      }
    case 'identity/set':
      return { ...state, identity: action.identity }
    case 'auth/set':
      return { ...state, auth: action.auth }
    case 'web/set':
      return { ...state, web: action.web }
    case 'daemon/reachable':
      return state.daemonReachable === action.reachable ? state : { ...state, daemonReachable: action.reachable }
    case 'agents/loaded': {
      const agents: Record<string, AgentEntry> = {}
      for (const summary of action.agents) {
        const existing = state.agents[summary.id]
        agents[summary.id] = existing ? { ...existing, summary } : newAgent(summary)
      }
      const agentOrder = action.agents.map(agent => agent.id)
      const previous = Object.fromEntries(Object.entries(state.agents).map(([id, a]) => [id, a.summary]))
      const tracked = state.tracked ? pruneLoaded(state.tracked, action.agents) : null
      const next = { ...state, agents, agentOrder, tracked }
      return { ...next, selectedAgentId: reconcileSelection(next, previous) }
    }
    case 'tracked/loaded': {
      const summaries = state.agentOrder.map(id => state.agents[id]?.summary).filter(Boolean)
      const next = { ...state, tracked: buildTracked(action.list, summaries, state.tracked) }
      return { ...next, selectedAgentId: reconcileSelection(next, {}, true) }
    }
    case 'tracked/error':
      return state.tracked ? { ...state, tracked: { ...state.tracked, error: action.error } } : state
    case 'tracked/file-error': {
      const tracked = state.tracked
      if (!tracked) return state
      const errors = { ...tracked.errors }
      if (action.error === undefined) delete errors[action.filePath]
      else errors[action.filePath] = action.error
      return { ...state, tracked: { ...tracked, errors } }
    }
    case 'tracked/busy': {
      const tracked = state.tracked
      if (!tracked) return state
      const busy = { ...tracked.busy }
      if (action.busy === undefined) delete busy[action.filePath]
      else busy[action.filePath] = action.busy
      return { ...state, tracked: { ...tracked, busy } }
    }
    case 'agent/status':
      return patchAgent(state, action.agentId, agent => ({
        ...agent,
        status: action.status,
        executorState: action.status.runtimeState as ExecutorState,
        error: undefined,
      }))
    case 'agent/config':
      return patchAgent(state, action.agentId, agent => ({ ...agent, config: action.config }))
    case 'agent/error':
      return patchAgent(state, action.agentId, agent => ({ ...agent, error: action.error }))
    case 'agent/removed': {
      if (!state.agents[action.agentId]) return state
      const agents = { ...state.agents }
      delete agents[action.agentId]
      const agentOrder = state.agentOrder.filter(id => id !== action.agentId)
      return {
        ...state,
        agents,
        agentOrder,
        selectedAgentId: state.selectedAgentId === action.agentId ? agentOrder[0] ?? state.tracked?.stopped[0]?.key ?? null : state.selectedAgentId,
      }
    }
    case 'loops/loaded': {
      const next = patchAgent(state, action.agentId, agent => {
        const previous = new Map((agent.loops ?? []).map(loop => [loop.info.name, loop]))
        return {
          ...agent,
          loopsError: undefined,
          loops: action.loops.map(info => ({ info, executorState: previous.get(info.name)?.executorState })),
        }
      })
      // A selected loop that no longer exists falls back to main.
      const selected = next.selectedLoop[action.agentId]
      if (selected && !action.loops.some(loop => loop.name === selected)) {
        const selectedLoop = { ...next.selectedLoop }
        delete selectedLoop[action.agentId]
        return { ...next, selectedLoop }
      }
      return next
    }
    case 'loops/error':
      return patchAgent(state, action.agentId, agent => ({ ...agent, loopsError: action.error }))
    case 'hil/loaded':
      return patchAgent(state, action.agentId, agent => ({
        ...agent,
        pendingTasks: action.tasks.filter(task => task.status === 'pending_approval'),
        pendingAsks: action.asks,
      }))
    case 'select/agent':
      return state.selectedAgentId === action.agentId ? state : { ...state, selectedAgentId: action.agentId }
    case 'select/loop': {
      const selectedLoop = { ...state.selectedLoop }
      if (action.loop === MAIN_LOOP) delete selectedLoop[action.agentId]
      else selectedLoop[action.agentId] = action.loop
      return { ...state, selectedLoop }
    }
    case 'view/set':
      return state.activeView === action.view ? state : { ...state, activeView: action.view }
    case 'focus/set':
      return state.focus === action.focus ? state : { ...state, focus: action.focus }
    case 'overlay/push':
      return { ...state, overlays: [...state.overlays.filter(o => o.id !== action.overlay.id), action.overlay] }
    case 'overlay/pop': {
      if (state.overlays.length === 0) return state
      const overlays = action.id ? state.overlays.filter(o => o.id !== action.id) : state.overlays.slice(0, -1)
      return { ...state, overlays }
    }
    case 'toast/add':
      return { ...state, toasts: [...state.toasts.slice(-4), action.toast] }
    case 'toast/dismiss':
      return { ...state, toasts: state.toasts.filter(t => t.id !== action.id) }
    case 'transcript/loading':
      return patchTranscript(state, action.key, t => ({ ...t, loading: true, error: undefined }))
    case 'transcript/history':
      return patchTranscript(state, action.key, t => {
        const page = historyToItems(action.entries)
        if (action.mode === 'prepend') {
          return { ...t, loading: false, loaded: true, total: action.total, oldestOffset: action.offset, items: prependHistory(t.items, page) }
        }
        // A refresh re-reads the newest page; keep older pages already scrolled into.
        const firstSeq = action.entries[0]?.seq
        const older = firstSeq === undefined ? [] : t.items.filter(item => !item.local && item.seq !== undefined && item.seq < firstSeq)
        const oldestOffset = older.length > 0 ? Math.min(t.oldestOffset, action.offset) : action.offset
        // `live` is re-derived from the next delta; a stale flag would pin the
        // loop to "running" after a turn ended without turn.completed.
        return {
          ...t,
          loading: false,
          loaded: true,
          error: undefined,
          total: action.total,
          oldestOffset,
          live: false,
          items: [...older, ...mergeHistory(t.items, page)],
        }
      })
    case 'transcript/error':
      return patchTranscript(state, action.key, t => ({ ...t, loading: false, error: action.error }))
    case 'transcript/append':
      return patchTranscript(state, action.key, t => ({ ...t, items: [...t.items, action.item] }))
    case 'transcript/update':
      return patchTranscript(state, action.key, t => {
        const index = t.items.findIndex(item => item.id === action.id)
        if (index < 0) return t
        const items = t.items.slice()
        items[index] = { ...items[index], ...action.patch } as TranscriptItem
        return { ...t, items }
      })
    case 'transcript/reset':
      return patchTranscript(state, action.key, () => ({ ...emptyTranscript(), loaded: true }))
    case 'transcript/idle':
      return patchTranscript(state, action.key, endLive)
    case 'event':
      return applyEvent(state, action.frame.event)
    case 'events':
      return action.frames.reduce((next, frame) => applyEvent(next, frame.event), state)
    case 'viewState/set':
      return { ...state, viewState: { ...state.viewState, [action.view]: action.value } }
    default:
      return state
  }
}

/** The loop an event belongs to: the envelope's `loop`, else main. */
export function eventLoop(event: UmbilicalEvent): string {
  return typeof event.loop === 'string' && event.loop ? event.loop : MAIN_LOOP
}

const TRANSCRIPT_EVENTS = new Set([
  'turn.delta', 'tool.started', 'tool.completed', 'tool.failed', 'turn.completed',
  'hil.requested', 'hil.resolved', 'ask.requested', 'ask.resolved', 'agent.error',
  'agent.state.changed', 'loop.compacted', 'loop.compaction_failed', 'loop.compaction_superseded',
  'loop.cleared', 'loop.recovered', 'suspend.requested', 'suspend.resolved',
  'provider.retry_scheduled', 'provider.retry_cancelled', 'llm.failed', 'error.recovery_suppressed',
  'chat.delivered', 'chat.discarded',
])

function applyEvent(state: TuiState, event: UmbilicalEvent): TuiState {
  const agentId = event.agent_id ?? null
  const loop = eventLoop(event)
  let next: TuiState = {
    ...state,
    activity: pushBounded(state.activity, {
      id: localId('a'),
      at: event.timestamp || Date.now(),
      agentId,
      loop,
      type: event.event_type,
      summary: summarizeEvent(event),
    }, MAX_ACTIVITY),
    lastEvents: pushBounded(state.lastEvents, event, MAX_LAST_EVENTS),
  }
  if (!agentId || !next.agents[agentId]) return next
  const p = event.payload ?? {}

  switch (event.event_type) {
    case 'agent.state.changed': {
      const executorState = typeof p.state === 'string' ? p.state as ExecutorState : undefined
      if (loop === MAIN_LOOP) {
        next = patchAgent(next, agentId, agent => ({ ...agent, executorState }))
      } else {
        next = patchLoop(next, agentId, loop, info => ({
          ...info,
          executorState,
          info: { ...info.info, status: isBusyState(executorState) ? 'running' : 'idle' },
        }))
      }
      break
    }
    case 'turn.completed':
      if (loop !== MAIN_LOOP) next = patchLoop(next, agentId, loop, l => ({ ...l, info: { ...l.info, status: 'idle' } }))
      break
    case 'llm.completed':
      next = patchAgent(next, agentId, agent => ({
        ...agent,
        lastModel: typeof p.model === 'string' ? p.model : agent.lastModel,
        tokens: {
          input: agent.tokens.input + num(p.input_tokens),
          output: agent.tokens.output + num(p.output_tokens),
          cacheRead: agent.tokens.cacheRead + num(p.cache_read_tokens),
          cacheWrite: agent.tokens.cacheWrite + num(p.cache_write_tokens),
        },
      }))
      break
    case 'hil.requested': {
      const taskId = typeof p.task_id === 'string' ? p.task_id : undefined
      if (taskId) {
        next = patchAgent(next, agentId, agent => agent.pendingTasks.some(t => t.id === taskId) ? agent : {
          ...agent,
          pendingTasks: [...agent.pendingTasks, {
            id: taskId,
            tool: typeof p.tool === 'string' ? p.tool : 'tool',
            args: JSON.stringify(p.input ?? {}),
            status: 'pending_approval',
            created_at: event.timestamp,
            origin: loop === MAIN_LOOP ? undefined : `loop:${loop}`,
            // "Always approve" is offered only when the daemon says so (never for protection overrides).
            ...(typeof p.can_always_approve === 'boolean' ? { canAlwaysApprove: p.can_always_approve } : {}),
            ...(typeof p.always_approve_blocked_reason === 'string' ? { alwaysApproveBlockedReason: p.always_approve_blocked_reason } : {}),
          }],
        })
      }
      break
    }
    case 'hil.resolved': {
      const taskId = typeof p.task_id === 'string' ? p.task_id : p.request_id
      next = patchAgent(next, agentId, agent => ({ ...agent, pendingTasks: agent.pendingTasks.filter(t => t.id !== taskId) }))
      break
    }
    // Ask ids are per executor (main and an inner loop can both hold ask_1),
    // so an ask is identified by (loop, requestId).
    case 'ask.requested': {
      const requestId = typeof p.request_id === 'string' ? p.request_id : undefined
      if (requestId) {
        next = patchAgent(next, agentId, agent => agent.pendingAsks.some(a => sameAsk(a, loop, requestId)) ? agent : {
          ...agent,
          pendingAsks: [...agent.pendingAsks, { requestId, question: typeof p.question === 'string' ? p.question : '', loop }],
        })
      }
      break
    }
    case 'ask.resolved':
      next = patchAgent(next, agentId, agent => ({ ...agent, pendingAsks: agent.pendingAsks.filter(a => !sameAsk(a, loop, p.request_id)) }))
      break
    case 'message.received':
      next = patchAgent(next, agentId, agent => ({ ...agent, unreadInbox: agent.unreadInbox + 1 }))
      break
  }

  if (TRANSCRIPT_EVENTS.has(event.event_type)) {
    const key = transcriptKey(agentId, loop)
    next = patchTranscript(next, key, t => {
      const items = applyEventToItems(t.items, event)
      if (event.event_type === 'agent.state.changed' && turnOver(p.state)) return endLive(items === t.items ? t : { ...t, items })
      const live = event.event_type === 'turn.completed' || event.event_type === 'agent.error'
        ? false
        : event.event_type === 'turn.delta' || event.event_type === 'tool.started' ? true : t.live
      return items === t.items && live === t.live ? t : { ...t, items, live }
    })
  }
  return next
}

/** A state the loop only reaches once its turn has ended (suspended is still mid-turn). */
function turnOver(value: unknown): boolean {
  return typeof value === 'string' && !RUNNING_STATES.has(value) && value !== 'suspended'
}

function endLive(t: Transcript): Transcript {
  const items = finalizeStreaming(t.items)
  return !t.live && items === t.items ? t : { ...t, live: false, items }
}

function sameAsk(ask: AskEntry, loop: string, requestId: unknown): boolean {
  return ask.requestId === requestId && (ask.loop ?? MAIN_LOOP) === loop
}

function patchLoop(
  state: TuiState,
  agentId: string,
  loop: string,
  patch: (loop: NonNullable<AgentEntry['loops']>[number]) => NonNullable<AgentEntry['loops']>[number],
): TuiState {
  return patchAgent(state, agentId, agent => {
    if (!agent.loops) return agent
    const index = agent.loops.findIndex(l => l.info.name === loop)
    if (index < 0) return agent
    const loops = agent.loops.slice()
    loops[index] = patch(loops[index])
    return { ...agent, loops }
  })
}

function pushBounded<T>(list: T[], item: T, max: number): T[] {
  const next = list.length >= max ? list.slice(list.length - max + 1) : list.slice()
  next.push(item)
  return next
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
