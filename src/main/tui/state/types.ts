// The TUI's single state tree. Everything a view renders comes from here, so
// every view sees the same agents, loops, transcripts and connection state.

import type { ConnectionInfo } from '../api/sse'
import type {
  AgentConfig,
  AgentStatus,
  AgentSummary,
  AskEntry,
  AuthDiagnostics,
  ExecutorState,
  IdentityStatus,
  LoopInfo,
  TaskEntry,
  TaskListEntry,
  UmbilicalEvent,
} from '../api/types'
import type { TrackedState } from './tracked'

/** `${agentId}\u0000${loop}` — one transcript per (agent, loop). */
export type TranscriptKey = string

export function transcriptKey(agentId: string, loop: string): TranscriptKey {
  return `${agentId}\u0000${loop}`
}

export function parseTranscriptKey(key: TranscriptKey): { agentId: string; loop: string } {
  const at = key.indexOf('\u0000')
  return { agentId: key.slice(0, at), loop: key.slice(at + 1) }
}

// --- transcript ---------------------------------------------------------------

interface ItemBase {
  /** Stable React key. */
  id: string
  /** Epoch ms. History items use the row's created_at; live items the event time. */
  at: number
  /** True when built from a live event or an optimistic action, not from persisted history. */
  local?: boolean
  /** adf_loop row the item came from, when it came from history. */
  seq?: number
}

/** A user-role row: the owner, a trigger, or another loop (`[from loop:<name>]`). */
export interface UserItem extends ItemBase {
  kind: 'user'
  text: string
  /** Who spoke: the owner, a delivery from another loop, or runtime-injected context (triggers, timers). */
  origin: 'owner' | 'loop' | 'runtime'
  /** Sender loop for `origin: 'loop'`. */
  from?: string
  /** Sent by this TUI and not yet seen in persisted history. */
  pending?: boolean
  /** The daemon accepted it (202); still `pending` until history shows it. */
  accepted?: boolean
  /** The 202's turnId: the daemon stamps it as `turn_id` on the events of the turn that handles it. */
  turnId?: string
  /** A turn carrying `turnId` has started (it is no longer queued). */
  taken?: boolean
  /** That turn completed (not interrupted): the agent answered this message. */
  answered?: boolean
  /** Dropped undelivered by a stop/unload while it was queued (`chat.discarded`). */
  discarded?: boolean
}

export interface AssistantItem extends ItemBase {
  kind: 'assistant'
  text: string
  streaming: boolean
  model?: string
}

export interface ThinkingItem extends ItemBase {
  kind: 'thinking'
  text: string
  streaming: boolean
}

export interface ToolItem extends ItemBase {
  kind: 'tool'
  /** The model's tool_use id; pairs a call with its result. */
  toolUseId?: string
  name: string
  input: unknown
  status: 'running' | 'ok' | 'error'
  result?: string
  completedAt?: number
  /** Ran in the background (`_async: true`): the loop got a task reference, the real result arrives later. */
  async?: boolean
  /** The task reference an async call returned at once (`{"task_id":…,"status":"running"}`). */
  taskRef?: string
}

/** A visible runtime/state change (state transitions, compaction, clears, triggers, reconnects). */
export interface NoticeItem extends ItemBase {
  kind: 'notice'
  text: string
  level: 'info' | 'warn'
  /** The umbilical event type behind it, when there is one. */
  event?: string
}

/** A human-in-the-loop approval the agent is blocked on. */
export interface HilItem extends ItemBase {
  kind: 'hil'
  taskId: string
  tool: string
  input: unknown
  reason?: string
  status: 'pending' | 'approved' | 'denied'
  feedback?: string
}

/** The agent asked its human a question (the `ask` tool). */
export interface AskItem extends ItemBase {
  kind: 'ask'
  requestId: string
  question: string
  status: 'pending' | 'answered'
  /** Answer preview (the wire carries at most 200 chars). */
  answer?: string
}

export interface ErrorItem extends ItemBase {
  kind: 'error'
  text: string
}

/**
 * Runtime-injected context (`[Context: <category>]` rows: system prompt,
 * dynamic instructions, loop_inject) and compaction summaries. Shown collapsed
 * by default, never dropped.
 */
export interface ContextItem extends ItemBase {
  kind: 'context'
  category: string
  text: string
}

export type TranscriptItem =
  | UserItem
  | AssistantItem
  | ThinkingItem
  | ToolItem
  | NoticeItem
  | HilItem
  | AskItem
  | ErrorItem
  | ContextItem

export type TranscriptItemKind = TranscriptItem['kind']

export interface Transcript {
  items: TranscriptItem[]
  /** History has been fetched at least once. */
  loaded: boolean
  loading: boolean
  /** Rows in the loop stream (from the last history fetch). */
  total: number
  /** Offset of the oldest loaded row; 0 = the whole stream is loaded. */
  oldestOffset: number
  error?: string
  /** A turn is streaming into this transcript right now. */
  live: boolean
}

// --- fleet --------------------------------------------------------------------

export interface LoopState {
  info: LoopInfo
  /** Live executor state from `agent.state.changed` stamped with this loop. */
  executorState?: ExecutorState
}

export interface TokenTally {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface AgentEntry {
  summary: AgentSummary
  status?: AgentStatus
  /** Main's live executor state (from status or `agent.state.changed` without a loop). */
  executorState?: ExecutorState
  /** Loops in daemon order: main first. Absent until fetched. */
  loops?: LoopState[]
  loopsError?: string
  config?: AgentConfig
  /** Pending approvals (tasks in pending_approval), with whether "always approve" is allowed. */
  pendingTasks: TaskListEntry[]
  pendingAsks: AskEntry[]
  /** Tokens seen on llm.completed since the TUI connected. */
  tokens: TokenTally
  /** Model of the last llm.completed, if any. */
  lastModel?: string
  unreadInbox: number
  error?: string
}

// --- shell --------------------------------------------------------------------

export type ToastLevel = 'info' | 'success' | 'warn' | 'error'

export interface Toast {
  id: string
  level: ToastLevel
  text: string
  at: number
  ttlMs: number
}

/**
 * Where keystrokes go. The shell owns the transitions (Tab / Esc / hotkeys).
 * `tabs` is the view tab bar in the header (Esc reaches it when the view and
 * the prompt have nothing left to cancel).
 */
export type FocusZone = 'sidebar' | 'main' | 'input' | 'tabs'

/** The daemon's mesh HTTP server: it serves every agent's website / API under `/agents/<handle>/`. */
export interface WebServerStatus {
  running: boolean
  /** The port it is bound to (or will bind to when started). */
  port: number
  /** Bind address: `127.0.0.1` (this machine) or `0.0.0.0` (the LAN too). */
  host: string
}

/** What the mesh reports about one agent (`GET /network/mesh` agents[]): what it serves, its status line. */
export interface MeshAgentInfo {
  handle?: string
  publicEnabled: boolean
  apiRoutes: number
  sharedCount: number
  /** The agent's own one-line status (adf_meta `status`), when it set one. */
  status?: string
}

export interface WebState {
  /** null: the daemon does not report its web server. */
  server: WebServerStatus | null
  /** IPv4 LAN addresses, read while the server binds beyond loopback. */
  lan: string[]
  /** By agent id; agents not on the mesh fall back to their config. */
  agents: Record<string, MeshAgentInfo>
  error?: string
  at: number
}

export interface Overlay {
  id: string
  /** Built-ins: 'palette' | 'help' | 'confirm'. Views may push their own kinds. */
  kind: string
  props?: Record<string, unknown>
}

export interface ActivityEntry {
  id: string
  at: number
  agentId: string | null
  loop: string
  type: string
  summary: string
}

export interface TuiState {
  daemonUrl: string
  connection: ConnectionInfo
  /** Last /health answer. */
  daemonReachable: boolean | null
  /**
   * The daemon's owner identity status (`GET /identity`); null until read, or
   * when the daemon has no identity routes. Never holds the seed phrase.
   */
  identity: IdentityStatus | null
  /** `GET /runtime/auth`: ChatGPT / Grok sign-in + provider registrations; null until read. */
  auth: AuthDiagnostics | null
  /** The mesh web server + what each agent serves (`GET /network/mesh`); null until read. */
  web: WebState | null
  /**
   * Agents in the daemon's tracked folders that are not loaded (GET
   * /tracked-dirs/agents/all), selectable under `file:<path>` keys; null until
   * read (or on a daemon without tracked folders).
   */
  tracked: TrackedState | null
  agents: Record<string, AgentEntry>
  /** Agent ids in display order. */
  agentOrder: string[]
  /** A loaded agent's id, or a not-loaded tracked agent's `file:<path>` key (`state/tracked.ts`). */
  selectedAgentId: string | null
  /** Selected loop per agent; absent = main. */
  selectedLoop: Record<string, string>
  transcripts: Record<TranscriptKey, Transcript>
  activeView: string
  focus: FocusZone
  overlays: Overlay[]
  toasts: Toast[]
  /** Recent umbilical events, newest last (bounded). */
  activity: ActivityEntry[]
  /** Last few raw events, for the inspect view. */
  lastEvents: UmbilicalEvent[]
  /** View-scoped scratch state, keyed by view id (views own their slice). */
  viewState: Record<string, unknown>
}
