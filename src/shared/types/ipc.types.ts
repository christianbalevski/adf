import type { AgentConfig, McpServerState, McpInstalledPackage, McpInstallProgress } from './adf-v02.types'
import type { AdapterRegistration, AdapterState, AdapterInstallProgress, AdapterStatusEvent, AdapterCredentialFileInfo } from './channel-adapter.types'
import type { ProviderType } from '../constants/adf-defaults'

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
    | 'mind_updated'
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
}

export interface FileOperationResult {
  success: boolean
  filePath?: string
  error?: string
  agentWasRunning?: boolean
  needsPassword?: boolean
  ownerMismatch?: boolean
  fileOwnerDid?: string
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
}

export interface AppSettings {
  providers?: ProviderConfig[]
  /** Provider id (matches ProviderConfig.id) applied to new agents whose model.provider is unspecified. */
  defaultProviderId?: string
  theme?: 'light' | 'dark' | 'system'
  globalSystemPrompt?: string
  trackedDirectories?: string[]
  meshEnabled?: boolean
  meshLan?: boolean
  meshPort?: number
  maxDirectoryScanDepth?: number
  autoCompactThreshold?: number
  mcpServers?: McpServerRegistration[]
  adapters?: AdapterRegistration[]
}

export interface TrackedDirEntry {
  filePath: string
  fileName: string
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
  /** Owner-imposed hold: turn finishes, then triggers queue until resumed */
  held?: boolean
}

export interface FleetHoldResult {
  updated: string[]
  failed: { filePath: string; error: string }[]
}

export interface FleetStatusResult {
  running: boolean
  agents: FleetAgentStatus[]
}

/** Rolling token-burn sample for the resource bar. */
export interface FleetBurnEntry {
  /** Tokens consumed in the rolling window, normalized per minute */
  tokensPerMin: number
  /** Total tokens attributed since app start */
  totalTokens: number
}

export interface FleetBurnResult {
  perAgent: Record<string, FleetBurnEntry>
  fleet: FleetBurnEntry
}

/** Result of messaging a set of fleet agents from the command bar. */
export interface FleetMessageResult {
  delivered: string[]
  failed: { filePath: string; error: string }[]
}

/** A pending HIL ask/approval, aggregated across all live executors for the fleet alert layer. */
export interface FleetPendingInteraction {
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
    | 'tool_call_start' | 'tool_call_result'
    | 'ask_request' | 'tool_approval_request'
  payload: { filePath: string; state?: AgentState; [key: string]: unknown }
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
  mcpServers: { name: string; npmPackage?: string; pypiPackage?: string; hostRequested?: boolean }[]
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
}

// --- Token usage tracking ---

export interface TokenUsageData {
  [date: string]: {
    [provider: string]: {
      [model: string]: {
        input: number
        output: number
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
