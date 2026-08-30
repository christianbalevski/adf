import type { AgentConfig, LoopTokenUsage, McpServerState, McpInstalledPackage, McpInstallProgress, McpToolInfo } from './adf-v02.types'
import type { AdapterRegistration, AdapterState, AdapterInstallProgress, AdapterStatusEvent, AdapterCredentialFileInfo } from './channel-adapter.types'
import type { ProviderType } from '../constants/adf-defaults'
import type { ComputeAppSettings } from './compute.types'
import type { ProtectionDenial } from './tool.types'

export interface AgentExecutionEvent {
  type:
    | 'state_changed'
    | 'text_delta'
    | 'text_delta_batch'
    | 'thinking_delta'
    | 'thinking_delta_batch'
    | 'tool_call_start'
    | 'tool_call_result'
    | 'turn_complete'
    | 'error'
    | 'autosaved'
    | 'document_updated'
    | 'chat_updated'
    | 'inter_agent_message'
    | 'tool_approval_request'
    | 'tool_approval_resolved'
    | 'ask_request'
    | 'ask_response'
    | 'suspend_request'
    | 'trigger_message'
    | 'file_updated'
    | 'context_injected'
    | 'response_metadata'
  payload: unknown
  timestamp: number
  /**
   * Which loop produced this event. Absent means the implicit host loop
   * (`'main'`) — every pre-loops emitter keeps working unchanged.
   *
   * The renderer routes every event by `loop ?? 'main'` into that loop's store
   * slice, so a side loop's `chat_updated` (post-compaction replacement) can
   * never truncate main's view (IMPL-5 / RT-F17).
   */
  loop?: string
}

export interface FileOperationResult {
  success: boolean
  filePath?: string
  error?: string
  agentWasRunning?: boolean
  needsPassword?: boolean
  ownerMismatch?: boolean
  fileOwnerDid?: string
  /** Rename accepted but the file is in use by a running agent — the physical
   *  rename happens when the agent stops. */
  renameDeferred?: boolean
}

export interface AgentStatusResult {
  running: boolean
  state: string
}

export interface ProviderConfig {
  id: string                              // 'anthropic' or 'custom:xxxxx'
  type: ProviderType                       // which AI SDK factory to use
  name: string                            // "Anthropic", "LM Studio", etc.
  baseUrl: string                         // '' for Anthropic, URL for custom
  apiKey: string                          // required for Anthropic, optional for others
  defaultModel?: string
  params?: { key: string; value: string }[]
  requestDelayMs?: number                 // delay (ms) before each LLM request
  /** Where credentials are stored: 'app' (app-wide settings) or 'agent' (per-ADF identity) */
  credentialStorage?: 'app' | 'agent'
}

export interface McpServerRegistration {
  id: string
  name: string
  type?: 'npm' | 'uvx' | 'pip' | 'custom' | 'http'  // missing = 'npm' for backward compat
  npmPackage?: string            // required for npm, unused for custom
  pypiPackage?: string           // required for uvx/pip, unused for npm/custom
  command?: string               // for custom servers (e.g. "node", "python")
  args?: string[]
  url?: string                    // for Streamable HTTP servers
  /** Remote HTTP endpoint uses interactive OAuth (browser sign-in) instead of a static bearer/header token. */
  oauth?: boolean
  headers?: { key: string; value: string }[]
  headerEnv?: { key: string; value: string }[] // header name -> env var name
  bearerTokenEnvVar?: string
  env?: { key: string; value: string }[]
  repo?: string                  // optional docs/repo URL
  /** Whether the npm package is managed (installed by us in ~/.adf-studio/mcp-servers/) */
  managed?: boolean
  /** Resolved version after install */
  version?: string
  /** Where credentials are stored: 'app' (app-wide settings) or 'agent' (per-ADF identity) */
  credentialStorage?: 'app' | 'agent'
  /** Per-server tool call timeout in seconds (default: 60) */
  toolCallTimeout?: number
  /**
   * Where the server runs when agents attach it. Settings-added stdio servers
   * default to 'host' (user-initiated install = the trust decision; no Podman
   * required). 'shared' = shared compute container (requires Podman).
   * Absent = legacy registration: containerized default at routing time.
   * Meaningless for type 'http' (remote).
   */
  runLocation?: 'host' | 'shared'
  /**
   * Whether agents may attach (via mcp_install) this server themselves.
   * Absent = suggested default: true for container/http,
   * false for host (a host server attachable by any autonomous agent is the
   * bigger grant, so turning it on is a conscious act).
   */
  agentVisible?: boolean
  /** Human-readable description (pre-filled from the curated registry). */
  description?: string
  /** Interactive auth preflight (OAuth etc.) declared for this server. */
  auth?: boolean
  /** Extra args for the auth preflight (e.g. ["auth"]). */
  authArgs?: string[]
  /** Fixed OAuth callback port to forward during containerized auth. */
  authPort?: number
  /** File-shaped credentials the server reads/writes (declaration only — content never lives in settings). */
  credentialFiles?: { path: string; required?: boolean; writeBack?: boolean }[]
  /** Epoch ms of the last successful Settings connect test; absent = "Not verified". */
  lastVerifiedAt?: number
}

/**
 * Result of the Settings "Connect" test (MCP_REGISTRATION_TEST) — the shared
 * pipeline behind the Add-Server modal's Connect button and the status
 * dashboard's Reconnect.
 */
export interface McpRegistrationTestResult {
  success: boolean
  error?: string
  tools: McpToolInfo[]
  /** Where the test actually ran (see deriveRegistrationTestPlan). */
  location: 'host' | 'shared container' | 'remote http'
  /** Whether the interactive auth preflight ran as part of the test. */
  authRan: boolean
  /** Whether an interactive OAuth sign-in ran during this test. */
  oauthRan?: boolean
  notes: string[]
  /** Last stderr lines from the launch attempt (failures only). */
  stderrTail?: string[]
  /** Version the server reported in the MCP initialize handshake (serverInfo.version). */
  serverVersion?: string
}

export interface AppSettings {
  providers?: ProviderConfig[]
  /** Provider id (matches ProviderConfig.id) applied to new agents whose model.provider is unspecified. */
  defaultProviderId?: string
  theme?: 'light' | 'dark' | 'system'
  globalSystemPrompt?: string
  trackedDirectories?: string[]
  /** Destination folder for accepted/claimed agents. Empty = built-in default (Documents/adf-agents). */
  agentsFolder?: string
  meshEnabled?: boolean
  meshLan?: boolean
  meshPort?: number
  tailnetDiscovery?: boolean
  meshManualPeers?: string[]
  maxDirectoryScanDepth?: number
  autoCompactThreshold?: number
  /** Global ceiling on concurrent sandbox workers (code execution). Decides how
   *  much of the machine the app claims; unset means CPU-derived default. */
  sandboxMaxWorkers?: number
  mcpServers?: McpServerRegistration[]
  adapters?: AdapterRegistration[]
  compute?: ComputeAppSettings
}

export interface TrackedDirEntry {
  filePath: string
  fileName: string
  /** Agent display name from the file's config (may differ from fileName
   *  while a rename is deferred because the agent is running). */
  agentName?: string
  canReceive?: boolean
  sendMode?: 'proactive' | 'respond_only' | 'listen_only'
  autonomous?: boolean
  isDirectory?: boolean
  children?: TrackedDirEntry[]
}

// --- Agent state (shared between background agents and mesh) ---

export type AgentState = import('./adf-v02.types').AgentState | 'error' | 'not_participating'

// --- Mesh types ---

export interface MeshAgentStatus {
  filePath: string
  handle: string
  did?: string
  /** Local runtime handle (config.id) — lineage fallback for pre-DID files, never an identity */
  agentId?: string
  /** Raw parent reference from adf_parent_did (a DID, or config.id for legacy files) */
  parentDid?: string
  /** Prior DIDs from adf_did_history, oldest first */
  didHistory?: string[]
  icon?: string
  state: AgentState
  status?: string
  /** Model id from config (vitals display) */
  model?: string
  /** Tracked directory this agent belongs to — fleet map terrain grouping */
  trackedDirRoot?: string
  /** ISO creation time (adf_created_at) — append-order placement key */
  createdAt?: string
  /** Public page URL when serving.public is enabled — the tile's antenna badge */
  servedUrl?: string
  /** Next enabled timer fire (ms epoch) — the timer-horizon hover line */
  nextWakeAt?: number
  /** Short label for that timer (payload excerpt) */
  nextWakeLabel?: string
  /** Schedule of that timer — lets the UI say once/interval/cron */
  nextWakeSchedule?: import('./adf-v02.types').TimerSchedule
  /** 'agent' wakes the LLM loop; 'system' runs a lambda */
  nextWakeScope?: 'agent' | 'system'
  /** Active WebSocket connections — standing boundary links on the map */
  wsConnections?: number
  participating: boolean
  canReceive?: boolean
  sendMode?: 'proactive' | 'respond_only' | 'listen_only'
  visibility?: 'directory' | 'localhost' | 'lan' | 'public' | 'off'
  apiRouteCount?: number
  publicEnabled?: boolean
  sharedCount?: number
}

export interface MeshStatusResult {
  running: boolean
  agents: MeshAgentStatus[]
}

/**
 * One agent on the fleet map — a live mesh-registered agent, or an on-disk
 * .adf in a tracked directory that isn't running ("ghost"/building node).
 */
export interface FleetAgentStatus extends MeshAgentStatus {
  /** False for on-disk agents with no running executor */
  online: boolean
  /** When the current status line was first observed by the fleet poll
   *  (main-process memory — resets on app restart) */
  statusSince?: number
  /** Last API-reported context size in tokens — the tile gauge numerator */
  contextTokens?: number
  /** Auto-compact threshold in tokens — the tile gauge denominator */
  contextThreshold?: number
}

/**
 * Remote agent card as served by a peer runtime's /agents —
 * renderer-side subset of AlfAgentCard plus the trust decoration the main
 * process computes (card_verified / owner_attested). Signature and raw
 * attestations stay main-side; everything displayable flows through.
 */
export interface RemotePeerAgent {
  handle: string
  did?: string
  description?: string
  icon?: string
  visibility?: string
  /** Live status line, when the peer serves it alongside the card */
  status?: string
  /** Named endpoint map exactly as the card serves it */
  endpoints?: { inbox?: string; card?: string; health?: string; ws?: string }
  /** HTTP routes the agent serves over the mesh (e.g. /api/... pages) */
  api_routes?: { method: string; path: string }[]
  public?: boolean
  /** Workspace files the agent shares with peers */
  shared?: string[]
  policies?: { type: string; standard?: string; send?: string; receive?: string }[]
  /** ISO 8601 — when the card was signed */
  signed_at?: string
  card_verified?: boolean
  owner_attested?: boolean
  /** Issuer DID of the verified owner attestation */
  attested_owner_did?: string
}

export interface FleetStateResult {
  updated: string[]
  failed: { filePath: string; error: string }[]
}

/** Display states the owner can batch-set from the fleet map. */
export type FleetSettableState = 'hibernate' | 'idle'

export interface FleetStatusResult {
  running: boolean
  agents: FleetAgentStatus[]
}

/** Rolling token-burn sample for the resource bar. */
export interface FleetBurnEntry {
  /** Tokens consumed in the rolling window, normalized per minute (in + out) */
  tokensPerMin: number
  /** Input (↑ sent to the provider) share of tokensPerMin */
  inPerMin: number
  /** Output (↓ generated) share of tokensPerMin — the cost-heavy direction */
  outPerMin: number
  /** Total tokens attributed since app start */
  totalTokens: number
}

export interface FleetBurnResult {
  perAgent: Record<string, FleetBurnEntry>
  fleet: FleetBurnEntry
}

/** One {{path}}-injected file's share of the system prompt. */
export interface ContextBreakdownFileEntry { path: string; tokens: number }

/** Tool schema token cost for one source of tools. */
export interface ContextBreakdownToolGroup {
  /** 'built-in' or the MCP server name */
  source: string
  tokens: number
  tools: Array<{ name: string; tokens: number }>
}

/**
 * Per-request context token breakdown for a running executor. Expensive parts
 * (system prompt, tool schemas) are measured when the executor's caches
 * rebuild; message/dynamic figures are cheap estimates computed at read time.
 */
export interface ContextBreakdown {
  /** Assembled system prompt total (incl. injected files + autonomous section) */
  system_prompt_tokens: number
  /** Portion of system_prompt_tokens attributable to each {{path}} injected file (rendered form) */
  injected_files: ContextBreakdownFileEntry[]
  /** Tool schema payload as serialized JSON, grouped by source */
  tool_groups: ContextBreakdownToolGroup[]
  tools_total_tokens: number
  /** Last built dynamic instructions (0 if none) */
  dynamic_instructions_tokens: number
  /** Char-based estimate of current conversation messages */
  messages_tokens: number
  /** system_prompt + tools — the fixed per-request overhead */
  overhead_tokens: number
  /** epoch ms when computed */
  computed_at: number
}

/**
 * Payload of the executor's 'response_metadata' agent event. Post-call it
 * carries the real usage of the completed LLM call; with `estimated: true`
 * it is the pre-flight size estimate of the request about to go out
 * (usage.input only — overhead + messages, no output yet).
 */
export interface ResponseMetadataPayload {
  model: string
  usage: LoopTokenUsage
  estimated?: boolean
}

/** Result of messaging a set of fleet agents from the command bar. */
export interface FleetMessageResult {
  delivered: string[]
  failed: { filePath: string; error: string }[]
}

/** Why a tool call is awaiting approval, and whether "Always approve" is available. */
export type ApprovalReason = 'restricted' | 'protection'

export interface ApprovalMeta {
  reason: ApprovalReason
  /** Present when reason === 'protection'. */
  protection?: ProtectionDenial
  /** False when the tool declaration is locked or the approval is protection-triggered. */
  canAlwaysApprove: boolean
  /** Human-readable reason shown as tooltip when canAlwaysApprove is false. */
  alwaysApproveBlockedReason?: string
}

/** Payload of the 'tool_approval_request' agent event. */
export interface ToolApprovalRequestPayload extends ApprovalMeta {
  requestId: string
  taskId?: string
  name: string
  input: unknown
}

/**
 * What a global-notification row is asking the human for. Both kinds block
 * their executor until answered; they differ only in how they are answered —
 * an approval is a yes/no (resolvable inline), an ask needs typed prose (so
 * the UI jumps you to the agent's chat instead).
 */
export type PendingNotificationKind = 'approval' | 'ask'

/**
 * One row of the global HIL notifications menu (title bar), and the single
 * source of truth for the fleet map's per-agent pending badge. Registered by
 * the executor that raised the request and pushed to every window as a full
 * snapshot — see src/main/runtime/approval-hub.ts.
 */
export interface PendingNotification {
  /**
   * Hub key: `${filePath}|${loop}|${requestId}`. NOT the executor's request id
   * — ask ids are a per-executor counter (`ask_1`), so they collide across
   * agents and across an agent's own inner loops.
   */
  id: string
  kind: PendingNotificationKind
  /** The executor-side id to resolve with (HIL task id, or `ask_N`). */
  requestId: string
  /** The .adf this request belongs to — the jump-to target. */
  filePath: string
  agentName: string
  /** 'main' for the host loop, otherwise the inner loop's name. */
  loop: string
  /** Approvals only. */
  toolName?: string
  /** One line: the tool's args summary, or the question. Truncated, redacted. */
  preview: string
  /** Asks only — the full question text. */
  question?: string
  /** Approvals only — raw tool input, for the fleet map's full-context modal. */
  input?: unknown
  /** Approvals only: 'restricted' tool gate vs 'protection' override. */
  reason?: ApprovalReason
  protection?: ProtectionDenial
  /** False when the tool declaration or the target is locked. */
  canAlwaysApprove?: boolean
  alwaysApproveBlockedReason?: string
  requestedAt: number
}

/** A pending HIL ask/approval, aggregated across all live executors for the fleet alert layer. */
export interface FleetPendingInteraction extends Partial<ApprovalMeta> {
  filePath: string
  handle: string
  type: 'ask' | 'approval'
  requestId: string
  question?: string
  toolName?: string
  input?: unknown
}

export type MeshEvent =
  | {
      type: 'agent_state_changed' | 'agent_joined' | 'agent_left' | 'message_routed'
      payload: { filePath: string; state?: AgentState; [key: string]: unknown }
      timestamp: number
    }
  | {
      type: 'lan_peer_discovered' | 'lan_peer_expired'
      payload: {
        runtime_id: string
        runtime_did?: string
        host: string
        port: number
        url: string
        directory_path: string
        [key: string]: unknown
      }
      timestamp: number
    }

export interface MessageBusLogEntry {
  timestamp: number
  messageId: string
  from: string
  to: string[]
  channel: string
  type: string
  content: string
  delivered: boolean
  deliveredTo: string[]
  error?: string
}

// --- Background agent types ---

export interface BackgroundAgentStatus {
  filePath: string
  handle: string
  state: AgentState
}

export interface BackgroundAgentEvent {
  type: 'agent_started' | 'agent_stopped' | 'agent_state_changed'
    | 'agent_starting' | 'agent_start_failed' | 'agent_stopping'
    | 'tool_call_start' | 'tool_call_result'
    | 'ask_request' | 'tool_approval_request'
    | 'response_metadata' | 'turn_complete' | 'error'
  payload: { filePath: string; state?: AgentState; [key: string]: unknown }
  timestamp: number
}

/**
 * `tool_call_result` payload as it reaches the renderer. The main process strips
 * the tool output before broadcasting (see `stripForRenderer`), so `result`
 * carries the error flag only — the content is gone, and this type says so.
 * Daemon/umbilical consumers keep the full `BackgroundAgentEvent`.
 */
export interface StrippedToolCallResultPayload {
  filePath: string
  name?: string
  id?: string
  result: { isError: boolean }
  /** Length of the discarded `result.content` string, 0 when non-string. */
  resultSize: number
}

/** A `BackgroundAgentEvent` after renderer stripping — the batch channel's element type. */
export type RendererBackgroundAgentEvent =
  | {
      type: Exclude<BackgroundAgentEvent['type'], 'tool_call_result'>
      payload: { filePath: string; state?: AgentState; [key: string]: unknown }
      timestamp: number
    }
  | {
      type: 'tool_call_result'
      payload: StrippedToolCallResultPayload
      timestamp: number
    }

export interface MeshDebugInfo {
  running: boolean
  busRegistrations: { name: string; channels: string[] }[]
  backgroundAgents: {
    filePath: string
    name: string
    state: AgentState
    onMessageReceived: boolean
    hasMessaging: boolean
    toolCount: number
  }[]
  foregroundAgents: {
    filePath: string
    name: string
    onMessageReceived: boolean
    hasMessaging: boolean
  }[]
  messageLog: MessageBusLogEntry[]
}

// --- MCP Server Manager ---

export { McpServerState, McpInstalledPackage, McpInstallProgress }

export interface McpServerStatusEvent {
  name: string
  status: import('./adf-v02.types').McpServerStatus
  error?: string
  toolCount?: number
}

/**
 * Result of MCP_REGISTRY_GET: the curated registry as currently known.
 *  - 'remote'  — live document fetched from GitHub raw (or its ETag-validated
 *                cached copy); fetchedAt = when the body was last transferred
 *  - 'cache'   — last successful fetch, served because the remote failed
 *  - 'bundled' — offline copy compiled into the app (no fetchedAt)
 */
export interface McpRegistryGetResult {
  entries: import('../constants/mcp-registry').McpRegistryEntry[]
  source: 'remote' | 'cache' | 'bundled'
  /** The document's own `updatedAt` stamp (date the registry content changed). */
  updatedAt?: string
  /** Epoch ms of the fetch that transferred this document, when remote/cache. */
  fetchedAt?: number
}

// --- Channel Adapter types (re-export for convenience) ---

export { AdapterRegistration, AdapterState, AdapterInstallProgress, AdapterStatusEvent, AdapterCredentialFileInfo }

// --- MCP Credential types ---

export interface McpCredentialFileInfo {
  filePath: string
  fileName: string
  /** Whether credentials for this MCP server exist in this ADF file */
  hasCredentials: boolean
  /** The keys that have values set */
  populatedKeys: string[]
}

// --- Provider Credential types ---

export interface ProviderCredentialFileInfo {
  filePath: string
  fileName: string
  /** Whether credentials for this provider exist in this ADF file */
  hasCredentials: boolean
  /** The keys that have values set (e.g. ['apiKey']) */
  populatedKeys: string[]
}

// --- Agent review (file open flow) ---

export type ReviewEnvelopeState = 'absent' | 'unlocked' | 'locked' | 'foreign'

/**
 * How this file's identity relates to the local owner, driving the review
 * dialog's claim step:
 *  - 'mine'       — owned by you, provisioned on this install
 *  - 'recognized' — owned by you, arrived from another install (envelopes
 *                   unlock via the owner-slot cascade)
 *  - 'foreign'    — owned by someone else; claim mints a fresh identity
 *  - 'unclaimed'  — no identity keys at all. NOT trustworthy: anyone can
 *                   strip a file's identity before sharing it, so this gets
 *                   the full review + claim treatment, never silent adoption
 */
export type ReviewIdentityScenario = 'mine' | 'recognized' | 'foreign' | 'unclaimed'

export interface ReviewIdentitySummary {
  agentDid: string | null
  /** Owner asserted by the file: verified owner attestation first, adf_owner_did meta fallback. */
  fileOwnerDid: string | null
  ownerIsYou: boolean
  scenario: ReviewIdentityScenario
  /** True for 'foreign' and 'unclaimed' — accepting must go through the claim step. */
  needsClaim: boolean
  /** Credentials envelope has a password slot (sender set a share password). */
  sharePasswordSet: boolean
  /** Credentials envelope exists but is not readable on this machine. */
  credentialsLocked: boolean
  /** Legacy whole-file password (aes-256-gcm rows) is set — claiming removes it. */
  filePasswordProtected: boolean
  /** Same-owner file whose envelopes can't unlock because the seed phrase is unavailable. */
  seedUnavailable: boolean
}

export interface AgentConfigSummary {
  name: string
  description: string
  identity: ReviewIdentitySummary
  computeTier: 'shared' | 'isolated' | 'host'
  autostart: boolean
  tools: { name: string; enabled: boolean; notable: boolean }[]
  mcpServers: { name: string; npmPackage?: string; pypiPackage?: string; transport?: 'stdio' | 'http'; runLocation?: 'host' | 'shared' }[]
  triggers: { type: string; enabled: boolean; targetCount: number }[]
  codeExecution: boolean
  messaging: { mode: string }
  network: {
    wsConnections: { url: string; did?: string; id: string }[]
    serving: { routeCount: number } | null
    adapters: string[]
  }
  security: {
    tableProtections: { table: string; protection: 'append_only' | 'authorized' }[]
  }
  /**
   * Whether this install can run the agent's configured model. Attached by
   * the Studio FILE_CHECK_REVIEW handler (probing needs app settings +
   * async credential tests); absent on daemon-built summaries.
   */
  provider?: {
    /** Provider id the agent's model config names. */
    configuredId: string
    /** Type of the matching embedded config.providers entry, when present. */
    configuredType?: string
    modelId: string
    /** 'missing' = no local provider matches by id or embedded type. */
    status: 'ok' | 'failed' | 'unconfigured' | 'missing'
    /** Local settings.providers id the probe ran against. */
    resolvedLocalId?: string
  }
}

// --- Token usage tracking ---

export interface TokenUsageData {
  [date: string]: {
    [provider: string]: {
      [model: string]: {
        input: number
        output: number
        // Additive extras — absent in files written before they existed
        cache_read?: number
        cache_write?: number
        reasoning?: number
        cost_usd?: number
      }
    }
  }
}

/**
 * Home dashboard data is split into independent slices so each tile can
 * render as its slice resolves. The renderer fires all four IPCs in
 * parallel and tracks per-slice loading state.
 */

/**
 * Slice 1 — instant counts derived from settings/services in memory.
 * Cheap to compute; should resolve in well under 50ms.
 */
export interface DashboardQuickStats {
  providers: { total: number }
  mcp: { configured: number }
  adapters: { configured: number; types: string[] }
  packages: { total: number }
  hostAccess: { enabledGlobally: boolean }
  tokens: {
    today: { input: number; output: number }
    allTime: { input: number; output: number }
    topModel: { provider: string; model: string; total: number } | null
  }
}

/**
 * Slice 2 — provider connection tests. May involve network round-trips
 * per provider; session-cached in main.
 */
export interface DashboardProviderTests {
  /** Tested successfully. */
  ok: number
  /** Tested but failed (timeout / 4xx / 5xx). */
  failed: number
  /** Missing credentials and therefore not tested. */
  unconfigured: number
}

/**
 * Slice 3 — podman container probe. Shells out to podman, so medium-latency.
 */
export interface DashboardContainers {
  total: number
  running: number
  /** True when podman is not installed/unavailable — lets the dashboard back off polling. */
  unavailable?: boolean
}

/**
 * Slice 4 — readonly peek across every tracked .adf file. Latency scales
 * with number of tracked files; the slowest slice at scale.
 */
export interface DashboardAgentStats {
  /** Total tracked .adf files (each file = one agent). */
  total: number
  /** Agents with `autostart === true`. */
  autostart: number
  /** Agents with `autonomous === true`. */
  autonomous: number
  /** Agents with `compute.host_access === true`. */
  hostAccessAgents: number
}
