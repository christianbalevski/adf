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
  icon?: string
  state: AgentState
  status?: string
  participating: boolean
  canReceive?: boolean
  sendMode?: 'proactive' | 'respond_only' | 'listen_only'
  visibility?: 'directory' | 'localhost' | 'lan' | 'off'
  apiRouteCount?: number
  publicEnabled?: boolean
  sharedCount?: number
}

export interface MeshStatusResult {
  running: boolean
  agents: MeshAgentStatus[]
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

export interface AgentConfigSummary {
  name: string
  description: string
  ownerDid: string | null
  computeTier: 'shared' | 'isolated' | 'host'
  autostart: boolean
  tools: { name: string; enabled: boolean; notable: boolean }[]
  mcpServers: { name: string; npmPackage?: string; pypiPackage?: string; hostRequested?: boolean }[]
  triggers: { type: string; enabled: boolean; targetCount: number }[]
  codeExecution: boolean
  messaging: { mode: string; channels: string[] }
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
