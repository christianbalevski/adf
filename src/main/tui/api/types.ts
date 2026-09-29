// Wire types for the daemon HTTP API (docs/daemon/http-api.md).
//
// Type-only imports from src/main are deliberate: they keep the TUI in lockstep
// with the daemon's real return types, and they are erased at runtime, so the
// TUI never loads the runtime (Electron, SQLite) into its own process.

import type {
  RuntimeAgentLoopInfo,
  RuntimeAgentLoopPage,
  RuntimeAgentStatus,
  RuntimeAgentSummary,
  RuntimeAgentUsage,
  RuntimeAgentFileContent,
  RuntimeAgentAdaptersDiagnostics,
  RuntimeAgentMcpDiagnostics,
  RuntimeAgentTriggersDiagnostics,
  RuntimeLoopCreateInput,
  RuntimeLoopCreateResult,
  RuntimeLoopDeleteResult,
  RuntimeLoopPatch,
  RuntimeLoopUpdateResult,
  RuntimeReviewInfo,
  RuntimeTimerMutationOptions,
  RuntimeAgentRef,
  RuntimeAutostartReport,
  RuntimeService,
} from '../../runtime/runtime-service'
import type {
  DaemonAdapterDiagnostics,
  DaemonAuthDiagnostics,
  DaemonMcpDiagnostics,
  DaemonNetworkDiagnostics,
  DaemonProviderDiagnostics,
  DaemonRuntimeSettingsDiagnostics,
  DaemonUsageDiagnostics,
} from '../../daemon/http-api'
import type {
  AdfLogEntry,
  AgentConfig,
  AgentState as DisplayState,
  DisplayEntry,
  FileProtectionLevel,
  InboxMessage,
  InboxStatus,
  LoopConfig,
  LoopEntry,
  MetaProtectionLevel,
  OutboxMessage,
  OutboxStatus,
  TaskEntry,
  TaskStatus,
  Timer,
} from '../../../shared/types/adf-v02.types'
import type { ContentBlock } from '../../../shared/types/provider.types'
import type { WsConnectionInfo } from '../../../shared/types/adf-v02.types'
import type { UmbilicalEventEnvelope } from '../../../shared/types/umbilical-events'
import type { AdfEvent, AdfEventDispatch, AdfBatchDispatch } from '../../../shared/types/adf-event.types'
import type { DaemonIdentityStatus, DaemonIdentityErrorCode } from '../../daemon/daemon-identity'
import type { AgentCreateErrorCode, CreateAgentInput, CreateAgentResult } from '../../daemon/daemon-agent-factory'
import type { AgentTemplateSummary } from '../../../shared/types/ipc.types'
import type { AdapterInstanceConfig as SharedAdapterInstanceConfig } from '../../../shared/types/channel-adapter.types'
import type { publicProvider } from '../../daemon/provider-routes'

export type {
  AdfLogEntry,
  AgentConfig,
  ContentBlock,
  DisplayEntry,
  DisplayState,
  FileProtectionLevel,
  InboxMessage,
  InboxStatus,
  LoopConfig,
  LoopEntry,
  MetaProtectionLevel,
  OutboxMessage,
  OutboxStatus,
  TaskEntry,
  TaskStatus,
  Timer,
  AdfEvent,
  AdfEventDispatch,
  AdfBatchDispatch,
}

/** The implicit host loop. Every loop-aware call defaults to it. */
export const MAIN_LOOP = 'main'

// --- agents -----------------------------------------------------------------

export type AgentSummary = RuntimeAgentSummary
export type AgentRef = RuntimeAgentRef
export type AgentStatus = RuntimeAgentStatus
/** Executor state as reported by `runtimeState` and `agent.state.changed`. */
export type ExecutorState =
  | 'idle' | 'thinking' | 'tool_use' | 'awaiting_approval' | 'awaiting_ask'
  | 'suspended' | 'error' | 'stopped'
  | DisplayState

export interface StartAgentResult {
  success: true
  loaded: boolean
  startupTriggered: boolean
  agent: AgentStatus | undefined
}

export interface SuccessResult {
  success: boolean
}

export interface InterruptResult extends SuccessResult {
  /** False when nothing was running in that loop. */
  interrupted: boolean
  loop: string
}

export interface AcceptedTurn {
  accepted: true
  turnId: string
}

// --- loops ------------------------------------------------------------------

export type LoopStatus = 'idle' | 'running'
export type LoopInfo = RuntimeAgentLoopInfo
export type LoopPage = RuntimeAgentLoopPage
export type LoopCreateInput = RuntimeLoopCreateInput
export type LoopPatch = RuntimeLoopPatch
export type LoopCreateResult = RuntimeLoopCreateResult
export type LoopUpdateResult = RuntimeLoopUpdateResult
export type LoopDeleteResult = RuntimeLoopDeleteResult

export interface LoopListResult {
  agentId: string
  loops: LoopInfo[]
}

export interface ChatHistory {
  agentId: string
  loop: string
  chatHistory: {
    version: number
    uiLog: DisplayEntry[]
    llmMessages: unknown[]
    total: number
    earlierCount: number
  } | null
}

// --- resources --------------------------------------------------------------

export interface AgentConfigResult {
  agentId: string
  config: AgentConfig
}

/** GET /agents/:id/tools: one catalog entry (same shape sys_get_config gives the agent). */
export type AgentToolEntry = import('../../tools/built-in/sys-get-config.tool').ToolDiscoveryEntry

export interface AgentToolsResult {
  agentId: string
  tools: AgentToolEntry[]
}

export interface ContentResult {
  agentId: string
  content: string
}

export interface FileListEntry {
  path: string
  size: number
  mime_type?: string
  protection: FileProtectionLevel
  authorized: boolean
  created_at: string
  updated_at: string
}

export interface FileListResult {
  agentId: string
  files: FileListEntry[]
}

export type FileContent = RuntimeAgentFileContent

export interface FileWriteInput {
  content?: string
  contentBase64?: string
  mimeType?: string
  protection?: FileProtectionLevel
}

export interface InboxResult {
  agentId: string
  messages: InboxMessage[]
}

export interface OutboxResult {
  agentId: string
  messages: OutboxMessage[]
}

export interface TimerListResult {
  agentId: string
  timers: Timer[]
}

/** Timer create/update body. `loop` targets an inner loop (create only; absent = main). */
export type TimerInput = RuntimeTimerMutationOptions

export interface MetaEntry {
  key: string
  value: string
  protection: MetaProtectionLevel
}

export interface MetaResult {
  agentId: string
  entries: MetaEntry[]
}

export interface IdentityListResult {
  agentId: string
  identities: Array<{ purpose: string; encrypted: boolean; code_access: boolean }>
}

export interface LogsResult {
  agentId: string
  logs: AdfLogEntry[]
}

export interface TableListResult {
  agentId: string
  tables: Array<{ name: string; row_count: number }>
}

export interface TableQueryResult {
  agentId: string
  columns: string[]
  rows: Record<string, unknown>[]
}

export type AgentUsage = RuntimeAgentUsage

// --- HIL --------------------------------------------------------------------

/**
 * A task row as the daemon returns it. `pending_approval` rows also carry the
 * live "Always approve" affordance (Studio's Approve ▸ Always approve): false
 * for protection overrides, one-shot synthetic approvals, locked declarations
 * and rows no executor is waiting on — `alwaysApproveBlockedReason` says why.
 * The server re-checks on alwaysApproveTask; this only drives the UI.
 */
export type TaskListEntry = TaskEntry & {
  canAlwaysApprove?: boolean
  alwaysApproveBlockedReason?: string
}

export interface TaskListResult {
  agentId: string
  tasks: TaskListEntry[]
}

export interface TaskResult {
  agentId: string
  task: TaskListEntry
}

export type TaskAction = 'approve' | 'deny' | 'pending_approval'

export interface TaskResolveInput {
  action: TaskAction
  /** On deny: handed back to the agent as the owner's feedback (it reads it in the tool error). */
  reason?: string
  modifiedArgs?: Record<string, unknown>
}

export interface TaskResolveResult {
  agentId: string
  taskId: string
  resolution: unknown
  task: TaskListEntry | null
}

/** POST /agents/:id/tasks/:taskId/always-approve — tool un-restricted on the host config, request approved. */
export interface TaskAlwaysApproveResult {
  agentId: string
  taskId: string
  /** Loop whose executor held the request ('main' or an inner loop). */
  loop: string
  /** Tool whose declaration was un-restricted (taken from the pending request, not the client). */
  tool: string
  resolution: unknown
  task: TaskListEntry | null
}

/** POST /agents/:id/tasks/approve-all — gated approvals only; protection overrides are skipped. */
export interface TaskApproveAllResult {
  agentId: string
  /** Echoed when the call was scoped to one loop. */
  loop?: string
  approved: number
  skippedProtection: number
}

// --- tracked agent folders ------------------------------------------------

export type {
  FolderAgent,
  FolderAgentStatus,
  FolderAgentsList,
  TrackedAgentsList,
  TrackedDirEntry,
  TrackedDirsList,
  TrackDirResult,
  UntrackDirResult,
} from '../../daemon/tracked-dirs'

export interface AskEntry {
  requestId: string
  question: string
  /** The loop waiting on the answer (daemons before loop-aware asks omit it = main). */
  loop?: string
}

export interface AskListResult {
  agentId: string
  asks: AskEntry[]
}

export type AutostartReport = RuntimeAutostartReport

export interface CompactResult {
  agentId: string
  loop: string
  success: true
}

export interface AskAnswerResult {
  agentId: string
  requestId: string
  loop?: string
  answered: boolean
}

export interface SuspendResult {
  agentId: string
  resume: boolean
  resolved: boolean
}

// --- subscription sign-in (ChatGPT, Grok) -------------------------------------

export type SubscriptionProvider = 'chatgpt' | 'grok'

/** `GET /auth/<provider>/status` (also `chatgpt` / `grok` in `GET /runtime/auth`). */
export interface SubscriptionAuthStatus {
  authenticated: boolean
  email?: string
  /** Epoch ms the current token expires (refreshed by the daemon). */
  expiresAt?: number
  flowPending?: boolean
  flowError?: string
}

// --- owner identity + agent creation (docs/daemon/http-api.md "Owner Identity") --

/** `GET /identity`: none | locked | restore-needed | ready, plus storage and backup flags. Never carries the phrase. */
export type IdentityStatus = DaemonIdentityStatus
export type IdentityState = DaemonIdentityStatus['status']
/** `code` of an identity or agent-create error body (`{ error, code }`), plus `loopback_only`. */
export type IdentityErrorCode = DaemonIdentityErrorCode | AgentCreateErrorCode | 'loopback_only'

/** `POST /identity/create`. The ONLY response that carries the phrase: show it once, keep it nowhere. */
export interface IdentityCreateResult {
  mnemonic: string
  words: string[]
  identity: IdentityStatus
}

export interface IdentityResult {
  identity: IdentityStatus
}

export type AgentTemplate = AgentTemplateSummary

export interface TemplateListResult {
  templates: AgentTemplate[]
  defaultId: string
  folder: string
  defaultDirectory: string
}

export type AgentCreateInput = CreateAgentInput
export type AgentCreateResult = CreateAgentResult

// --- providers added through the daemon (POST /runtime/providers) ------------

export type PublicProvider = ReturnType<typeof publicProvider>
export type AdapterInstanceConfig = SharedAdapterInstanceConfig
export type { McpServerConfig } from '../../../shared/types/adf-v02.types'
export type McpRestartResult = Awaited<ReturnType<RuntimeService['restartAgentMcpServer']>>

export interface AddProviderInput {
  type: 'anthropic' | 'openai' | 'openrouter' | 'openai-compatible'
  name?: string
  baseUrl?: string
  defaultModel?: string
  preset?: string
  /** Sent once; stored in the daemon secret store, never returned. */
  apiKey?: string
}

export interface AddProviderResult {
  provider: PublicProvider
  defaultProviderId: string | null
}

// --- runtime diagnostics ----------------------------------------------------

export type ProviderDiagnostics = DaemonProviderDiagnostics
export type AuthDiagnostics = DaemonAuthDiagnostics
export type RuntimeSettingsDiagnostics = DaemonRuntimeSettingsDiagnostics
export type McpDiagnostics = DaemonMcpDiagnostics
export type AdapterDiagnostics = DaemonAdapterDiagnostics
export type NetworkDiagnostics = DaemonNetworkDiagnostics
export type UsageDiagnostics = DaemonUsageDiagnostics
export type AgentAdaptersDiagnostics = RuntimeAgentAdaptersDiagnostics
export type AgentMcpDiagnostics = RuntimeAgentMcpDiagnostics
export type AgentTriggersDiagnostics = RuntimeAgentTriggersDiagnostics
export type ReviewInfo = RuntimeReviewInfo

export interface RuntimeOverview {
  daemon: { uptime: number; pid: number; version?: string | null; node?: string; platform?: string }
  settings: RuntimeSettingsDiagnostics
  providers: ProviderDiagnostics
  auth: AuthDiagnostics
  mcp: McpDiagnostics
  adapters: AdapterDiagnostics
  network: NetworkDiagnostics
  compute: Record<string, unknown> | null
  agents: Array<{ id: string; handle?: string; name: string; filePath: string | null; status: AgentStatus | undefined }>
}

export interface AgentWsDiagnostics {
  agentId: string
  configured: unknown[]
  active: WsConnectionInfo[]
  recentLogs?: AdfLogEntry[]
}

export interface AgentRuntimeDiagnostics {
  agentId: string
  status: AgentStatus | undefined
  adapters: AgentAdaptersDiagnostics
  mcp: AgentMcpDiagnostics
  triggers: AgentTriggersDiagnostics
  ws: { configured: unknown[]; active: WsConnectionInfo[] }
}

export interface SettingsResult {
  filePath: string | null
  settings: Record<string, unknown> | null
}

export interface ModelsResult {
  provider?: string
  models: unknown[]
  [key: string]: unknown
}

export interface UmbilicalReplayResult {
  agentId: string
  events: Array<{ seq: number; event_type: string; timestamp: number; source: string; payload: unknown; truncated: boolean }>
  last_seq: number | null
  log_enabled: boolean
  oldest_seq?: number
}

// --- events -----------------------------------------------------------------

/** The canonical umbilical envelope (docs/guides/umbilical-events.md). */
export type UmbilicalEvent = UmbilicalEventEnvelope<Record<string, unknown>>

/** One SSE frame from `GET /events`: a resume cursor around the envelope. */
export interface DaemonEventFrame {
  cursor: number
  event: UmbilicalEvent
}

/** Error thrown by every client call on a non-2xx answer or a transport failure. */
export class DaemonError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly body: unknown = null,
  ) {
    super(message)
    this.name = 'DaemonError'
  }

  /** True when the daemon could not be reached at all (vs. answered with an error). */
  get unreachable(): boolean {
    return this.status === null
  }
}

/** 409 `credentials_locked`: the agent's credentials envelope is locked here (saving needs unlock or an explicit replace). */
export function isCredentialsLocked(err: unknown): boolean {
  if (!(err instanceof DaemonError) || err.status !== 409) return false
  const body = err.body as { code?: unknown } | null
  return !!body && typeof body === 'object' && body.code === 'credentials_locked'
}

/** One stored credential as the daemon describes it: never its value. */
export interface CredentialMeta {
  purpose: string
  present: boolean
  storage: 'sealed' | 'plain' | 'password' | null
  sealed: boolean
  /** Stored but unreadable in the daemon right now (identity not unlocked). */
  locked: boolean
  length: number | null
  code_access: boolean
}

/** GET …/adapters/credentials and …/mcp/credentials: keyed by env key. */
export interface CredentialMetaResult {
  agentId: string
  credentials: Record<string, CredentialMeta>
}

export interface CredentialWriteOptions {
  /** Owner override: discard a locked sealed value (or store while locked). */
  replace?: boolean
}

// --- context usage (/context) -------------------------------------------------

/** GET /agents/:id/context: one loop's context breakdown, categories and compact threshold. */
export type AgentContextResult = import('../../daemon/context-routes').AgentContextResult
export type ContextCategory = import('../../../shared/utils/context-breakdown').ContextCategory
