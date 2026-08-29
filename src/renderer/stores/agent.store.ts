import { create } from 'zustand'
import { nanoid } from 'nanoid'
import type { AgentConfig } from '../../shared/types/adf-v02.types'
import type { ContentBlock } from '../../shared/types/provider.types'
import type { ApprovalMeta } from '../../shared/types/ipc.types'

/** A tool call awaiting HIL approval, with why + whether "Always approve" is allowed. */
export type PendingApprovalInfo = { requestId: string } & Partial<ApprovalMeta>

/**
 * Display states shown in the UI. Executor states are mapped to these in useAgent.ts.
 * Extends the core AgentState with 'error' for display purposes.
 */
export type AgentState = import('../../shared/types/adf-v02.types').AgentState | 'error'

/** Token usage of the last REAL (post-call) LLM response. `input` is the full
 *  context sent (providers normalize cache read/write into it); cache/reasoning
 *  and cost fields are the breakdown for the status-bar tooltip. Pre-flight
 *  estimates live in `tokenEstimate` so they never clobber this breakdown. */
export interface TokenUsage {
  input: number
  output: number
  cache_read?: number
  cache_write?: number
  reasoning?: number
  cost_usd?: number
}

export interface AgentLogEntry {
  id: string
  type: 'text' | 'user' | 'tool_call' | 'tool_result' | 'error' | 'system' | 'thinking' | 'inter_agent' | 'trigger' | 'compaction' | 'context'
  content: string
  timestamp: number
  metadata?: Record<string, unknown>
}

/** The implicit host loop. Every stream field without an explicit loop is this one. */
export const MAIN_LOOP = 'main'

export interface QueuedMessage {
  id: string
  text: string
  content?: ContentBlock[]
  imagePreviewUrls?: string[]
}

/**
 * Everything that belongs to ONE loop's stream.
 *
 * `main`'s slice IS the store root — every pre-existing consumer reads
 * `s.log` / `s.pendingApprovals` / … and keeps seeing main and only main.
 * Side loops live in `sideLoops[name]`, so a side loop's `chat_updated`
 * (compaction) or delta merge can never splice into or truncate main's view
 * (IMPL-5 / RT-F17).
 */
export interface LoopSlice {
  /** Display state. For `main` this is the agent-level state (§6.3). */
  state: AgentState
  log: AgentLogEntry[]
  /** Monotonically increasing counter bumped on every log mutation. Subscribe to
   *  this instead of `log` when you only need to know *something* changed (e.g.
   *  for scroll-to-bottom or virtualiser re-measure). Avoids creating a new array
   *  reference on every streaming delta. */
  logVersion: number
  /** Loop rows in the DB older than the loaded window (0 = fully loaded). */
  earlierCount: number
  /** Maps logEntryId -> pending approval info for tool calls awaiting HIL approval */
  pendingApprovals: Map<string, PendingApprovalInfo>
  /** Maps logEntryId -> { requestId, question } for ask tool calls */
  pendingAsks: Map<string, { requestId: string; question: string }>
  /** Pending suspend request (logEntryId if shown in loop) */
  pendingSuspend: string | null
  /** Client-side message queue for autonomous mode */
  messageQueue: QueuedMessage[]
}

function emptySlice(): LoopSlice {
  return {
    state: 'idle',
    log: [],
    logVersion: 0,
    earlierCount: 0,
    pendingApprovals: new Map(),
    pendingAsks: new Map(),
    pendingSuspend: null,
    messageQueue: []
  }
}

/** Stable reference for "a side loop that has never emitted anything" so
 *  selectors don't churn referentially on every render. */
const EMPTY_SLICE: LoopSlice = emptySlice()

/** `undefined`/`'main'` both mean the host loop. */
function isMainLoop(loop?: string): boolean {
  return !loop || loop === MAIN_LOOP
}

interface AgentStoreState extends LoopSlice {
  starting: boolean
  sessionId: string | null
  /** Streams for non-main loops, keyed by loop name. Never contains `main`. */
  sideLoops: Record<string, LoopSlice>
  config: AgentConfig | null
  statusText: string
  tokenUsage: TokenUsage
  /** Live pre-flight estimate of the next request's size (null when the last
   *  real call is current). Already includes overhead + messages, so it stands
   *  alone — never add it on top of `tokenUsage`. */
  tokenEstimate: number | null

  setState: (state: AgentState, loop?: string) => void
  setStarting: (starting: boolean) => void
  setSessionId: (id: string | null) => void
  addLogEntry: (entry: AgentLogEntry, loop?: string) => void
  /** Mutate the last log entry in place and bump logVersion. No array copy. */
  updateLastEntry: (mutator: (entry: AgentLogEntry) => void, loop?: string) => void
  /** Mutate a log entry at a specific index and bump logVersion. */
  updateEntryAt: (index: number, mutator: (entry: AgentLogEntry) => void, loop?: string) => void
  setLog: (log: AgentLogEntry[], earlierCount?: number, loop?: string) => void
  /** Prepend older loop entries loaded via keyset pagination. */
  prependLog: (entries: AgentLogEntry[], earlierCount: number, loop?: string) => void
  setEarlierCount: (earlierCount: number, loop?: string) => void
  clearLog: (loop?: string) => void
  /** Drop a side loop's slice entirely (loop disabled/deleted). No-op for main. */
  dropLoop: (loop: string) => void
  setConfig: (config: AgentConfig | null) => void
  setStatusText: (text: string) => void
  setTokenUsage: (usage: TokenUsage) => void
  setTokenEstimate: (estimate: number | null) => void
  addPendingApproval: (logEntryId: string, requestId: string, meta?: Partial<ApprovalMeta>, loop?: string) => void
  removePendingApproval: (logEntryId: string, loop?: string) => void
  /** Stamp the human's decision on a renderer-synthesized (outOfBand) approval
   *  entry. Those entries never receive a tool_result — the gated call runs
   *  inside the shell/code that raised it and reports its output there — so
   *  without a stamp they render as "running…" forever. No-op for entries that
   *  belong to a real tool call (their paired result is the terminal state). */
  markApprovalOutcome: (logEntryId: string, approved: boolean, loop?: string) => void
  addPendingAsk: (logEntryId: string, requestId: string, question: string, loop?: string) => void
  removePendingAsk: (logEntryId: string, loop?: string) => void
  setPendingSuspend: (logEntryId: string | null, loop?: string) => void
  addToQueue: (text: string, content?: ContentBlock[], imagePreviewUrls?: string[], loop?: string) => void
  removeFromQueue: (id: string, loop?: string) => void
  clearQueue: (loop?: string) => void
  reset: () => void
}

/**
 * Read one loop's stream out of the store. `main` resolves to the store root,
 * so `selectLoopSlice(s)` is exactly today's behaviour.
 */
export function selectLoopSlice(s: AgentStoreState, loop?: string): LoopSlice {
  if (isMainLoop(loop)) return s
  return s.sideLoops[loop!] ?? EMPTY_SLICE
}

export const useAgentStore = create<AgentStoreState>((set, get) => {
  /**
   * Apply a patch to one loop's slice. `main` patches the store root (identical
   * to the pre-loops behaviour); anything else patches `sideLoops[loop]` and
   * leaves main's fields untouched.
   */
  const patchSlice = (loop: string | undefined, patch: (slice: LoopSlice) => Partial<LoopSlice>): void => {
    const s = get()
    if (isMainLoop(loop)) {
      set(patch(s) as Partial<AgentStoreState>)
      return
    }
    const name = loop!
    const current = s.sideLoops[name] ?? emptySlice()
    set({ sideLoops: { ...s.sideLoops, [name]: { ...current, ...patch(current) } } })
  }

  return {
    state: 'off',
    starting: false,
    sessionId: null,
    log: [],
    logVersion: 0,
    earlierCount: 0,
    sideLoops: {},
    config: null,
    statusText: '',
    tokenUsage: { input: 0, output: 0 },
    tokenEstimate: null,
    pendingApprovals: new Map(),
    pendingAsks: new Map(),
    pendingSuspend: null,
    messageQueue: [],

    setState: (state, loop) => patchSlice(loop, () => ({ state })),
    setStarting: (starting) => set({ starting }),
    setSessionId: (sessionId) => set({ sessionId }),
    addLogEntry: (entry, loop) => patchSlice(loop, (s) => ({
      log: [...s.log, entry],
      logVersion: s.logVersion + 1
    })),
    updateLastEntry: (mutator, loop) => patchSlice(loop, (s) => {
      const last = s.log[s.log.length - 1]
      if (!last) return {}
      // Create a shallow copy so memo'd LogEntryRow sees a new reference
      const updated = { ...last }
      mutator(updated)
      s.log[s.log.length - 1] = updated
      return { logVersion: s.logVersion + 1 }
    }),
    updateEntryAt: (index, mutator, loop) => patchSlice(loop, (s) => {
      const entry = s.log[index]
      if (!entry) return {}
      const updated = { ...entry }
      mutator(updated)
      s.log[index] = updated
      return { logVersion: s.logVersion + 1 }
    }),
    setLog: (log, earlierCount, loop) => patchSlice(loop, (s) => ({
      log,
      logVersion: s.logVersion + 1,
      ...(earlierCount !== undefined ? { earlierCount } : {})
    })),
    prependLog: (entries, earlierCount, loop) => patchSlice(loop, (s) => ({
      log: [...entries, ...s.log],
      logVersion: s.logVersion + 1,
      earlierCount
    })),
    setEarlierCount: (earlierCount, loop) => patchSlice(loop, () => ({ earlierCount })),
    clearLog: (loop) => patchSlice(loop, (s) => ({ log: [], logVersion: s.logVersion + 1, earlierCount: 0 })),
    dropLoop: (loop) => {
      if (isMainLoop(loop)) return
      const s = get()
      if (!(loop in s.sideLoops)) return
      const next = { ...s.sideLoops }
      delete next[loop]
      set({ sideLoops: next })
    },
    setConfig: (config) => set({ config }),
    setStatusText: (text) => set({ statusText: text }),
    setTokenUsage: (usage) => set({ tokenUsage: usage }),
    setTokenEstimate: (estimate) => set({ tokenEstimate: estimate }),
    addPendingApproval: (logEntryId, requestId, meta, loop) => patchSlice(loop, (s) => {
      const next = new Map(s.pendingApprovals)
      next.set(logEntryId, { ...meta, requestId })
      return { pendingApprovals: next }
    }),
    removePendingApproval: (logEntryId, loop) => patchSlice(loop, (s) => {
      const next = new Map(s.pendingApprovals)
      next.delete(logEntryId)
      return { pendingApprovals: next }
    }),
    markApprovalOutcome: (logEntryId, approved, loop) => patchSlice(loop, (s) => {
      const index = s.log.findIndex((e) => e.id === logEntryId)
      const entry = s.log[index]
      if (!entry || entry.metadata?.outOfBand !== true) return {}
      s.log[index] = {
        ...entry,
        metadata: { ...entry.metadata, overrideOutcome: approved ? 'approved' : 'denied' }
      }
      return { logVersion: s.logVersion + 1 }
    }),
    addPendingAsk: (logEntryId, requestId, question, loop) => patchSlice(loop, (s) => {
      const next = new Map(s.pendingAsks)
      next.set(logEntryId, { requestId, question })
      return { pendingAsks: next }
    }),
    removePendingAsk: (logEntryId, loop) => patchSlice(loop, (s) => {
      const next = new Map(s.pendingAsks)
      next.delete(logEntryId)
      return { pendingAsks: next }
    }),
    setPendingSuspend: (logEntryId, loop) => patchSlice(loop, () => ({ pendingSuspend: logEntryId })),
    addToQueue: (text, content, imagePreviewUrls, loop) => patchSlice(loop, (s) => ({
      messageQueue: [...s.messageQueue, { id: nanoid(), text, content, imagePreviewUrls }]
    })),
    removeFromQueue: (id, loop) => patchSlice(loop, (s) => ({
      messageQueue: s.messageQueue.filter((m) => m.id !== id)
    })),
    clearQueue: (loop) => patchSlice(loop, () => ({ messageQueue: [] })),
    reset: () =>
      set({
        ...emptySlice(),
        state: 'off',
        starting: false,
        sessionId: null,
        sideLoops: {},
        config: null,
        statusText: '',
        tokenUsage: { input: 0, output: 0 },
        tokenEstimate: null
      })
  }
})

// Dev-only handle for verification — inject synthetic log entries / pending
// approvals to exercise the loop UI (e.g. HIL approve/reject controls) without
// a live provider. Mirrors the mesh-store exposure in useMeshGraph.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__agentStore = useAgentStore
}
