import { create } from 'zustand'
import { nanoid } from 'nanoid'
import type { AgentConfig } from '../../shared/types/adf-v02.types'
import type { ContentBlock } from '../../shared/types/provider.types'

/**
 * Display states shown in the UI. Executor states are mapped to these in useAgent.ts.
 * Extends the core AgentState with 'error' for display purposes.
 */
export type AgentState = import('../../shared/types/adf-v02.types').AgentState | 'error'

export interface AgentLogEntry {
  id: string
  type: 'text' | 'user' | 'tool_call' | 'tool_result' | 'error' | 'system' | 'thinking' | 'inter_agent' | 'trigger' | 'compaction' | 'context'
  content: string
  timestamp: number
  metadata?: Record<string, unknown>
}

interface AgentStoreState {
  state: AgentState
  starting: boolean
  sessionId: string | null
  log: AgentLogEntry[]
  /** Monotonically increasing counter bumped on every log mutation. Subscribe to
   *  this instead of `log` when you only need to know *something* changed (e.g.
   *  for scroll-to-bottom or virtualiser re-measure). Avoids creating a new array
   *  reference on every streaming delta. */
  logVersion: number
  config: AgentConfig | null
  statusText: string
  tokenUsage: { input: number; output: number }
  /** Maps logEntryId -> requestId for tool calls awaiting HIL approval */
  pendingApprovals: Map<string, string>
  /** Maps logEntryId -> { requestId, question } for ask tool calls */
  pendingAsks: Map<string, { requestId: string; question: string }>
  /** Pending suspend request (logEntryId if shown in loop) */
  pendingSuspend: string | null
  /** Client-side message queue for autonomous mode */
  messageQueue: { id: string; text: string; content?: ContentBlock[]; imagePreviewUrls?: string[] }[]

  setState: (state: AgentState) => void
  setStarting: (starting: boolean) => void
  setSessionId: (id: string | null) => void
  addLogEntry: (entry: AgentLogEntry) => void
  /** Mutate the last log entry in place and bump logVersion. No array copy. */
  updateLastEntry: (mutator: (entry: AgentLogEntry) => void) => void
  /** Mutate a log entry at a specific index and bump logVersion. */
  updateEntryAt: (index: number, mutator: (entry: AgentLogEntry) => void) => void
  setLog: (log: AgentLogEntry[]) => void
  clearLog: () => void
  setConfig: (config: AgentConfig | null) => void
  setStatusText: (text: string) => void
  setTokenUsage: (input: number, output: number) => void
  addPendingApproval: (logEntryId: string, requestId: string) => void
  removePendingApproval: (logEntryId: string) => void
  addPendingAsk: (logEntryId: string, requestId: string, question: string) => void
  removePendingAsk: (logEntryId: string) => void
  setPendingSuspend: (logEntryId: string | null) => void
  addToQueue: (text: string, content?: ContentBlock[], imagePreviewUrls?: string[]) => void
  removeFromQueue: (id: string) => void
  clearQueue: () => void
  reset: () => void
}

export const useAgentStore = create<AgentStoreState>((set, get) => ({
  state: 'off',
  starting: false,
  sessionId: null,
  log: [],
  logVersion: 0,
  config: null,
  statusText: '',
  tokenUsage: { input: 0, output: 0 },
  pendingApprovals: new Map(),
  pendingAsks: new Map(),
  pendingSuspend: null,
  messageQueue: [],

  setState: (state) => set({ state }),
  setStarting: (starting) => set({ starting }),
  setSessionId: (sessionId) => set({ sessionId }),
  addLogEntry: (entry) => {
    const s = get()
    const newLog = [...s.log, entry]
    set({ log: newLog, logVersion: s.logVersion + 1 })
  },
  updateLastEntry: (mutator) => {
    const s = get()
    const last = s.log[s.log.length - 1]
    if (last) {
      // Create a shallow copy so memo'd LogEntryRow sees a new reference
      const updated = { ...last }
      mutator(updated)
      s.log[s.log.length - 1] = updated
      set({ logVersion: s.logVersion + 1 })
    }
  },
  updateEntryAt: (index, mutator) => {
    const s = get()
    const entry = s.log[index]
    if (entry) {
      const updated = { ...entry }
      mutator(updated)
      s.log[index] = updated
      set({ logVersion: s.logVersion + 1 })
    }
  },
  setLog: (log) => set((s) => ({ log, logVersion: s.logVersion + 1 })),
  clearLog: () => set((s) => ({ log: [], logVersion: s.logVersion + 1 })),
  setConfig: (config) => set({ config }),
  setStatusText: (text) => set({ statusText: text }),
  setTokenUsage: (input, output) =>
    set({ tokenUsage: { input, output } }),
  addPendingApproval: (logEntryId, requestId) => {
    const s = get()
    const next = new Map(s.pendingApprovals)
    next.set(logEntryId, requestId)
    set({ pendingApprovals: next })
  },
  removePendingApproval: (logEntryId) => {
    const s = get()
    const next = new Map(s.pendingApprovals)
    next.delete(logEntryId)
    set({ pendingApprovals: next })
  },
  addPendingAsk: (logEntryId, requestId, question) => {
    const s = get()
    const next = new Map(s.pendingAsks)
    next.set(logEntryId, { requestId, question })
    set({ pendingAsks: next })
  },
  removePendingAsk: (logEntryId) => {
    const s = get()
    const next = new Map(s.pendingAsks)
    next.delete(logEntryId)
    set({ pendingAsks: next })
  },
  setPendingSuspend: (logEntryId) => set({ pendingSuspend: logEntryId }),
  addToQueue: (text, content, imagePreviewUrls) => set((s) => ({ messageQueue: [...s.messageQueue, { id: nanoid(), text, content, imagePreviewUrls }] })),
  removeFromQueue: (id) => set((s) => ({ messageQueue: s.messageQueue.filter(m => m.id !== id) })),
  clearQueue: () => set({ messageQueue: [] }),
  reset: () =>
    set({
      state: 'off',
      starting: false,
      sessionId: null,
      log: [],
      logVersion: 0,
      config: null,
      statusText: '',
      tokenUsage: { input: 0, output: 0 },
      pendingApprovals: new Map(),
      pendingAsks: new Map(),
      pendingSuspend: null,
      messageQueue: []
    })
}))
