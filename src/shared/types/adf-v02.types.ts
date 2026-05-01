/**
 * ADF v0.2 Type Definitions
 *
 * Tables: adf_meta, adf_config, adf_loop, adf_inbox, adf_outbox, adf_timers, adf_files, adf_identity, adf_audit
 * Tools: fs_*, msg_*, sys_*, db_*, loop_compact, loop_clear, msg_delete
 * Code execution methods: model_invoke, sys_lambda, task_resolve, loop_inject
 */

import type { ContentBlock } from './provider.types'
import type { AdaptersConfig } from './channel-adapter.types'

// =============================================================================
// Agent Configuration
// =============================================================================

export const AGENT_STATES = ['active', 'idle', 'hibernate', 'suspended', 'off'] as const
export type AgentState = (typeof AGENT_STATES)[number]


export const MESSAGING_MODES = ['proactive', 'respond_only', 'listen_only'] as const
export type MessagingMode = (typeof MESSAGING_MODES)[number]

/** @deprecated v1 trigger scopes — use TRIGGER_SCOPES_V3 */
export const TRIGGER_SCOPES = ['document', 'agent'] as const
/** @deprecated v1 trigger scope — use TriggerScopeV3 */
export type TriggerScope = (typeof TRIGGER_SCOPES)[number]

// v3 scopes and types
export const TRIGGER_SCOPES_V3 = ['system', 'agent'] as const
export type TriggerScopeV3 = (typeof TRIGGER_SCOPES_V3)[number]

export const TRIGGER_TYPES_V3 = [
  'on_startup', 'on_inbox', 'on_outbox', 'on_file_change', 'on_chat',
  'on_timer', 'on_tool_call', 'on_task_create', 'on_task_complete', 'on_logs',
  'on_llm_call'
] as const
export type TriggerTypeV3 = (typeof TRIGGER_TYPES_V3)[number]

// Flat filter — fields validated per trigger type at runtime/schema level
export interface TriggerFilter {
  source?: string | string[] // on_inbox string; on_llm_call string[]
  sender?: string          // on_inbox
  to?: string              // on_outbox
  watch?: string           // on_file_change (required)
  tools?: string[]         // on_tool_call (required), on_task_complete
  status?: string          // on_task_complete
  level?: string[]         // on_logs: filter by level(s), e.g. ['warn', 'error']
  origin?: string[]        // on_logs: filter by origin(s), e.g. ['lambda', 'sys_code']
  event?: string[]         // on_logs: filter by event name(s)
  provider?: string[]      // on_llm_call: provider display names/ids
}

export interface TriggerTarget {
  scope: TriggerScopeV3
  lambda?: string          // system scope only: "path/file.ts:functionName"
  command?: string         // system scope only: shell command string (alternative to lambda)
  warm?: boolean           // system scope only
  filter?: TriggerFilter
  debounce_ms?: number     // mutually exclusive timing
  interval_ms?: number
  batch_ms?: number
  batch_count?: number     // fire batch early when N events accumulate (requires batch_ms)
  locked?: boolean         // owner lock — prevents agent from modifying or removing this target
}

export interface TriggerConfig {
  enabled: boolean
  targets: TriggerTarget[]
  locked?: boolean         // owner lock — prevents agent from modifying this trigger config
}

export interface TriggersConfigV3 {
  on_startup?: TriggerConfig
  on_inbox?: TriggerConfig
  on_outbox?: TriggerConfig
  on_file_change?: TriggerConfig
  on_chat?: TriggerConfig
  on_timer?: TriggerConfig
  on_tool_call?: TriggerConfig
  on_task_create?: TriggerConfig
  on_task_complete?: TriggerConfig
  on_logs?: TriggerConfig
  on_llm_call?: TriggerConfig
}

/** States the agent can set via sys_set_state (excludes active, suspended — runtime-managed) */
export const SETTABLE_STATES = ['idle', 'hibernate', 'off'] as const
export type SettableState = (typeof SETTABLE_STATES)[number]

/** States valid for sys_update_config state field */
export const UPDATABLE_STATES = ['active', 'idle', 'hibernate', 'off'] as const
export type UpdatableState = (typeof UPDATABLE_STATES)[number]

export interface ModelConfig {
  provider: string
  model_id: string
  temperature?: number | null
  max_tokens?: number | null
  top_p?: number | null
  thinking_budget?: number | null
  /** @deprecated Use multimodal.image instead. Kept for backward compatibility. */
  vision?: boolean
  /** Per-modality toggles for multimodal content blocks sent to the LLM. */
  multimodal?: {
    image?: boolean
    audio?: boolean
    video?: boolean
  }
  /** @deprecated Moved to ContextConfig. Kept for migration compatibility. */
  compact_threshold?: number | null
  /** @deprecated Moved to ContextConfig. Kept for migration compatibility. */
  max_loop_messages?: number | null
  params?: { key: string; value: string }[]
  provider_params?: Record<string, unknown>
}

export interface ToolDeclaration {
  name: string
  enabled: boolean
  /** Whether this enabled tool is exposed to the LLM loop's active tool schema. */
  visible: boolean
  /** Only authorized code can call this tool. When enabled+restricted, LLM loop calls get HIL. */
  restricted?: boolean
  /** Hash of last reviewed MCP tool schema/description. Used to detect changed remote tools. */
  mcp_tool_hash?: string
  /** Discovery status for MCP tools whose definition changed outside the agent config. */
  mcp_tool_status?: 'new' | 'changed' | 'removed'
  locked?: boolean         // owner lock — prevents agent from modifying this tool entry
}

/** @deprecated v1 scoped trigger config — use TriggerConfig */
export interface ScopedTriggerConfig {
  enabled: boolean
  debounce_ms?: number
  interval_ms?: number
  batch_ms?: number
}

/** @deprecated v1 trigger types — use TRIGGER_TYPES_V3 */
export const TRIGGER_TYPES = ['on_document_edit', 'on_manual_invoke', 'on_message_received', 'on_timer'] as const
/** @deprecated v1 trigger type — use TriggerTypeV3 */
export type TriggerType = (typeof TRIGGER_TYPES)[number]

/** @deprecated v1 scope triggers — use TriggersConfigV3 */
export type ScopeTriggers = Record<TriggerType, ScopedTriggerConfig>

/** @deprecated v1 triggers config — use TriggersConfigV3 */
export interface TriggersConfig {
  document: ScopeTriggers
  agent: ScopeTriggers
}

/** Reference to a middleware lambda in the agent's file store */
export interface MiddlewareRef {
  lambda: string  // "path/file.ts:functionName"
}

export const TABLE_PROTECTION_LEVELS = ['none', 'append_only', 'authorized'] as const
export type TableProtectionLevel = (typeof TABLE_PROTECTION_LEVELS)[number]

export interface SecurityConfig {
  /** Accept messages without signatures. Default true (Level 0). */
  allow_unsigned: boolean
  /**
   * Security level controlling egress middleware behavior.
   * 0 = open (no signing/encryption), 1 = signed, 2 = signed+encrypted, 3 = advanced (custom middleware).
   * Default: 0
   */
  level?: 0 | 1 | 2 | 3
  /** Require incoming messages to have valid message signature. */
  require_signature?: boolean
  /** Require incoming messages to have valid payload signature. */
  require_payload_signature?: boolean
  /** Custom middleware for messaging pipelines */
  middleware?: {
    inbox?: MiddlewareRef[]
    outbox?: MiddlewareRef[]
  }
  /** Custom middleware for sys_fetch requests */
  fetch_middleware?: MiddlewareRef[]
  /** Whether middleware lambdas must be from authorized files. Default: true */
  require_middleware_authorization?: boolean
  /** Per-table protections for local_* tables. Unlisted tables default to none. */
  table_protections?: Record<string, TableProtectionLevel>
}

export interface LimitsConfig {
  execution_timeout_ms: number
  max_loop_rows: number
  max_daily_budget_usd: number | null
  max_file_read_tokens: number
  max_file_write_bytes: number
  /** Max tokens a single tool result may contain before being truncated. Default 16000. */
  max_tool_result_tokens: number
  /** Max characters shown when an oversized tool result is replaced with a preview. Default 5000. */
  max_tool_result_preview_chars: number
  max_active_turns: number | null
  /** Max image size (bytes) for multimodal image inlining. Default 5 MB. */
  max_image_size_bytes?: number
  /** Max audio size (bytes) for multimodal audio inlining. Default 10 MB. */
  max_audio_size_bytes?: number
  /** Max video size (bytes) for multimodal video inlining. Default 20 MB. */
  max_video_size_bytes?: number
  /** How long (ms) to wait for the human to respond to a suspend prompt before auto-shutting down. Default 1_200_000 (20 min). */
  suspend_timeout_ms?: number
  /** Periodic nudge for hibernating agents. Default: enabled, 24h interval. */
  hibernate_nudge?: {
    enabled: boolean
    interval_ms: number
  }
}

export type Visibility = 'directory' | 'localhost' | 'lan' | 'off'

export const VISIBILITY_VALUES = ['off', 'directory', 'localhost', 'lan'] as const satisfies readonly Visibility[]

export interface MessagingConfig {
  /** Whether the agent participates in the mesh and can receive messages. */
  receive: boolean
  mode: MessagingMode
  /**
   * Declared reachability tier. Gates inbox acceptance and directory inclusion.
   * - 'directory': only agents on the same runtime in ancestor directories
   * - 'localhost': any agent on the same machine
   * - 'lan':      any agent on the local network
   * - 'off':      unreachable from every scope
   * Tiers are nested: lan ⊃ localhost ⊃ directory. Does not gate outbound sends.
   */
  visibility?: Visibility
  inbox_mode?: boolean
  allow_list?: string[]
  block_list?: string[]
  /** ALF network identifier. Default: 'devnet' */
  network?: string
}

export interface AuditConfig {
  loop: boolean
  inbox: boolean
  outbox: boolean
  files: boolean
}

export interface CodeExecutionPackage {
  name: string
  version: string
}

export interface CodeExecutionConfig {
  model_invoke: boolean
  sys_lambda: boolean
  task_resolve: boolean
  loop_inject: boolean
  get_identity: boolean
  /** Allow code to store values in the agent's identity keystore. Default true. */
  set_identity: boolean
  /** Allow code to emit custom.* umbilical events via adf.emit_event. Default true. */
  emit_event: boolean
  /** Opt-in: sandbox gets real fetch/http/https. Default false. */
  network?: boolean
  /** npm packages available to this agent's sandbox. Managed by npm_install/npm_uninstall tools. */
  packages?: CodeExecutionPackage[]
  /** Code execution methods that can only be called from authorized code. */
  restricted_methods?: string[]
}

/** @deprecated Use CodeExecutionPackage instead. */
export interface SandboxPackageEntry {
  name: string
  version?: string
  enabled: boolean
}

/** @deprecated Packages moved to CodeExecutionConfig.packages. */
export interface SandboxConfig {
  packages?: SandboxPackageEntry[]
}

export const CODE_EXECUTION_DEFAULTS: CodeExecutionConfig = {
  model_invoke: true,
  sys_lambda: true,
  task_resolve: true,
  loop_inject: true,
  get_identity: true,
  set_identity: true,
  emit_event: true,
  network: false
}

// =============================================================================
// Compute Environment
// =============================================================================

export interface ComputePackages {
  npm?: string[]
  pip?: string[]
}

export interface ComputeConfig {
  /** Enable container-isolated compute environment for this agent's MCP servers. */
  enabled: boolean
  /** Packages to pre-install in the compute environment on start. */
  packages?: ComputePackages
  /** Allow the agent to install/run MCP servers on the host machine. Default false. */
  host_access?: boolean
}

export const COMPUTE_DEFAULTS: ComputeConfig = {
  enabled: false,
}

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const

export interface LoggingRule {
  origin: string       // glob pattern, e.g. "serving", "lambda*"
  min_level: LogLevel  // minimum level to keep for matching origins
}

export interface LoggingConfig {
  default_level: LogLevel   // global minimum level
  rules?: LoggingRule[]     // per-origin overrides (first match wins)
  max_rows?: number | null  // ring buffer size; null = unlimited; default 10000
}

export interface McpToolInfo {
  name: string
  description?: string
  input_schema: Record<string, unknown>
}

/**
 * Declares a single env var the MCP server needs, plus where its value lives.
 *
 * scope: 'agent' — stored in this agent's adf_identity under `mcp:{pkg|name}:{key}`.
 * scope: 'app'   — stored app-wide in settings.mcpServers[].env (shared across agents).
 *
 * Populated by: (a) the user when configuring a server, (b) auto-captured on the
 * first successful connect (snapshot of whichever keys were actually supplied).
 */
export interface McpEnvKeySchema {
  key: string
  scope: 'agent' | 'app'
  required?: boolean
  description?: string
  /** Stable credential reference for app-scoped values, e.g. mcp:<server-or-package>:<KEY>. */
  credential_ref?: string
}

export interface McpHeaderEnvSchema {
  header: string
  env: string
  required?: boolean
  credential_ref?: string
}

export interface McpServerConfig {
  name: string
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  url?: string
  headers?: Record<string, string>
  header_env?: McpHeaderEnvSchema[]
  bearer_token_env_var?: string
  env?: Record<string, string>
  env_keys?: string[]
  /** Structured env key declarations with scope. When present, takes precedence
   *  over env_keys. env_keys is retained as a legacy fallback for older configs. */
  env_schema?: McpEnvKeySchema[]
  npm_package?: string
  pypi_package?: string
  available_tools?: McpToolInfo[]
  /** Source descriptor: "npm:@scope/pkg" | "uvx:pkg@ver" | "pip:pkg" | "http:https://..." | "custom" */
  source?: string
  /** Per-server tool call timeout in milliseconds (overrides the global 60s default) */
  tool_call_timeout_ms?: number
  /** If true, all tools from this server are restricted — only authorized code can call freely, LLM calls get HIL. */
  restricted?: boolean
  /** @deprecated Use run_location instead. */
  host_requested?: boolean
  /** Where this server should run: 'host' (requires host_access), 'shared' (shared container),
   *  or undefined (default: isolated container when compute.enabled, shared otherwise). */
  run_location?: 'host' | 'shared'
}

export interface McpConfig {
  servers: McpServerConfig[]
}

// =============================================================================
// MCP Server Manager types
// =============================================================================

export const MCP_SERVER_STATUSES = ['stopped', 'connecting', 'connected', 'error', 'installing'] as const
export type McpServerStatus = (typeof MCP_SERVER_STATUSES)[number]

export interface McpServerLogEntry {
  timestamp: number
  stream: 'stdout' | 'stderr' | 'system'
  message: string
}

export interface McpServerState {
  name: string
  status: McpServerStatus
  error?: string
  connectedAt?: number
  restartCount: number
  toolCount: number
  logs: McpServerLogEntry[]
}

export interface McpInstalledPackage {
  /** Package name (npm or pypi) */
  package: string
  /** Installed version */
  version: string
  /** Resolved entry point command */
  command: string
  /** Path to installed directory */
  installPath: string
  /** Timestamp of installation */
  installedAt: number
  /** Package runtime — default 'npm' for backward compat */
  runtime?: 'npm' | 'uvx' | 'pip'
}

export interface McpInstallProgress {
  package: string
  status: 'installing' | 'installed' | 'error'
  progress?: string
  error?: string
}

export interface MetadataConfig {
  created_at: string
  updated_at: string
  author?: string
  tags?: string[]
  version?: string
}

export interface DynamicInstructionsConfig {
  /** Show inbox unread count and reply hints (default: true) */
  inbox_hints?: boolean
  /** Show context limit warning when approaching threshold (default: true) */
  context_warning?: boolean
  /** Remind agent it can call sys_set_state to go idle when done (default: true) */
  idle_reminder?: boolean
  /** Notify agent when mesh topology changes (agents join/leave) (default: true) */
  mesh_updates?: boolean
}

export interface ContextConfig {
  compact_threshold?: number | null
  max_loop_messages?: number | null
  audit?: AuditConfig
  dynamic_instructions?: DynamicInstructionsConfig
}

export const START_IN_STATES = ['active', 'idle', 'hibernate'] as const
export type StartInState = (typeof START_IN_STATES)[number]

/**
 * Options for creating a new agent. `name` is required; everything else
 * overrides the AGENT_DEFAULTS when provided.
 */
export interface CreateAgentOptions {
  name: string
  description?: string
  instructions?: string
  icon?: string
  handle?: string
  autonomous?: boolean
  autostart?: boolean
  start_in_state?: StartInState
  model?: Partial<ModelConfig>
  context?: Partial<ContextConfig>
  tools?: ToolDeclaration[]
  triggers?: Partial<TriggersConfigV3>
  security?: Partial<SecurityConfig>
  limits?: Partial<LimitsConfig>
  messaging?: Partial<MessagingConfig>
  audit?: AuditConfig
  code_execution?: Partial<CodeExecutionConfig>
  logging?: LoggingConfig
  mcp?: McpConfig
  adapters?: AdaptersConfig
  serving?: ServingConfig
  providers?: AdfProviderConfig[]
  ws_connections?: WsConnectionConfig[]
  umbilical_taps?: UmbilicalTapConfig[]
  stream_bind?: StreamBindConfig
  stream_bindings?: StreamBindingDeclaration[]
  locked_fields?: string[]
  card?: CardOverrides
  metadata?: Pick<MetadataConfig, 'author' | 'tags' | 'version'>
}

export interface AdfProviderConfig {
  id: string                    // 'anthropic' or 'custom:xxxxx'
  type: 'anthropic' | 'openai' | 'openai-compatible'
  name: string
  baseUrl: string
  defaultModel?: string
  params?: { key: string; value: string }[]
  requestDelayMs?: number
}

// =============================================================================
// Serving (HTTP)
// =============================================================================

export interface ServingApiRoute {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'WS'
  path: string
  lambda: string
  warm?: boolean
  cache_ttl_ms?: number
  /** Custom middleware executed before the route lambda */
  middleware?: MiddlewareRef[]
  locked?: boolean         // owner lock — prevents agent from modifying or removing this route
  high_water_mark_bytes?: number   // WS routes only — inbound backpressure threshold
}

export interface ServingPublicConfig {
  enabled: boolean
  index?: string
}

export interface ServingSharedConfig {
  enabled: boolean
  patterns?: string[]
}

export interface ServingConfig {
  shared?: ServingSharedConfig
  public?: ServingPublicConfig
  api?: ServingApiRoute[]
}

// =============================================================================
// WebSocket Connections
// =============================================================================

export interface WsConnectionConfig {
  id: string
  url: string                        // wss:// or ws:// target
  did?: string                       // expected remote DID (verified during auth)
  enabled: boolean
  lambda?: string                    // "path/file.ts:handler" — hot path
  auth?: 'auto' | 'required' | 'none' // default: 'auto' — auth if private key available
  auto_reconnect?: boolean           // default: true
  reconnect_delay_ms?: number        // default: 5000
  keepalive_interval_ms?: number     // default: 30000
  high_water_mark_bytes?: number     // default: 1048576 — ws_send awaits drain when bufferedAmount exceeds this
}

export type WsEventType = 'open' | 'message' | 'close' | 'error'

export interface WsLambdaEvent {
  type: WsEventType
  connection_id: string
  remote_did?: string
  data?: string | Uint8Array                 // on 'message'; string for text frames, Uint8Array for binary
  binary?: boolean                           // true when data is Uint8Array
  url_params?: Record<string, string>        // on 'open' — parsed query string
  headers?: Record<string, string>           // on 'open' — upgrade request headers
  code?: number          // on 'close'
  reason?: string        // on 'close' / 'error'
  error?: string         // on 'error'
  timestamp: number
}

export interface WsConnectionInfo {
  connection_id: string
  remote_did: string
  direction: 'inbound' | 'outbound'
  connected_at: number
  last_message_at: number
}

// =============================================================================
// Stream Bindings
// =============================================================================

export interface UmbilicalFilter {
  event_types?: string[]
  when?: string
}

export type StreamBindEndpoint =
  | { kind: 'ws'; connection_id: string }
  | {
      kind: 'process'
      isolation: 'host' | 'container_shared' | 'container_isolated'
      image?: string
      command: string[]
      env?: Record<string, string>
      cwd?: string
    }
  | { kind: 'tcp'; host: string; port: number }
  | { kind: 'umbilical'; filter?: UmbilicalFilter }

export interface BindOptions {
  idle_timeout_ms?: number
  max_duration_ms?: number
  max_bytes?: number
  flow_summary_interval_ms?: number
  close_a_on_b_close?: boolean
  close_b_on_a_close?: boolean
}

export interface StreamBindingDeclaration {
  id: string
  a: StreamBindEndpoint
  b: Exclude<StreamBindEndpoint, { kind: 'umbilical' }>
  bidirectional?: boolean
  reconnect?: boolean
  options?: BindOptions
}

export interface StreamBindTcpAllowRule {
  host: string
  port?: number
  ports?: number[]
  min_port?: number
  max_port?: number
}

export interface StreamBindConfig {
  host_process_bind?: boolean
  container_shared_bind?: boolean
  container_isolated_bind?: boolean
  allow_tcp_bind?: boolean
  tcp_allowlist?: StreamBindTcpAllowRule[]
}

export type EndpointSummary =
  | { kind: 'ws'; connection_id: string; direction?: 'inbound' | 'outbound'; remote_did?: string }
  | { kind: 'process'; isolation: 'host' | 'container_shared' | 'container_isolated'; command: string[]; cwd?: string }
  | { kind: 'tcp'; host: string; port: number }
  | { kind: 'umbilical'; filter?: UmbilicalFilter }

export interface BindingSummary {
  binding_id: string
  a: EndpointSummary
  b: EndpointSummary
  bidirectional: boolean
  origin: 'imperative' | 'declarative'
  declaration_id?: string
  status: 'pending' | 'active' | 'draining'
  created_at: number
  bytes_a_to_b: number
  bytes_b_to_a: number
}

export interface HttpRequest {
  method: string
  path: string
  params: Record<string, string>
  query: Record<string, string>
  headers: Record<string, string>
  body: unknown
}

export interface HttpResponse {
  status: number
  headers?: Record<string, string>
  body: unknown
}

export interface CardOverrides {
  endpoints?: Partial<{ inbox: string; card: string; health: string; ws: string }>
  resolution?: AlfResolution
}

export interface AgentConfig {
  adf_version: '0.2'
  locked_fields?: string[]
  id: string
  name: string
  description: string
  icon?: string
  handle?: string
  /** @deprecated Use card.endpoints.inbox instead */
  reply_to?: string
  card?: CardOverrides
  state: AgentState
  start_in_state?: StartInState
  autonomous: boolean
  autostart?: boolean
  model: ModelConfig
  instructions: string
  include_base_prompt?: boolean
  context: ContextConfig
  tools: ToolDeclaration[]
  triggers: TriggersConfigV3
  security: SecurityConfig
  limits: LimitsConfig
  messaging: MessagingConfig
  audit?: AuditConfig
  code_execution?: CodeExecutionConfig
  /** @deprecated Packages moved to code_execution.packages. */
  sandbox?: SandboxConfig
  logging?: LoggingConfig
  mcp?: McpConfig
  compute?: ComputeConfig
  adapters?: AdaptersConfig
  serving?: ServingConfig
  ws_connections?: WsConnectionConfig[]
  umbilical_taps?: UmbilicalTapConfig[]
  stream_bind?: StreamBindConfig
  stream_bindings?: StreamBindingDeclaration[]
  providers?: AdfProviderConfig[]
  metadata: MetadataConfig
}

export interface UmbilicalTapConfig {
  name: string
  lambda: string
  filter: {
    event_types: string[]
    when?: string
    allow_wildcard: boolean
  }
  exclude_own_origin: boolean
  max_rate_per_sec: number
}

// =============================================================================
// Loop Table
// =============================================================================

export interface LoopTokenUsage {
  input?: number
  output?: number
  cache_read?: number
  cache_write?: number
  reasoning?: number
}

export interface LoopEntry {
  seq: number
  role: 'user' | 'assistant'
  content_json: ContentBlock[]
  model?: string
  tokens?: LoopTokenUsage
  created_at: number
}

// =============================================================================
// ALF Attachments
// =============================================================================

export interface AlfAttachment {
  filename: string
  content_type: string     // was media_type
  transfer: 'inline' | 'reference' | 'imported'
  data?: string          // base64 if inline
  url?: string           // if reference
  digest?: string        // "algorithm:hex" if reference
  size_bytes?: number
}

export interface StoredAttachment extends AlfAttachment {
  path?: string          // local file path after import
  skipped?: boolean
  reason?: string
}

/** @deprecated Use StoredAttachment */
export type Attachment = StoredAttachment

// =============================================================================
// ALF Message (was ALF Envelope)
// =============================================================================

export interface AlfMessage {
  version: string
  network: string
  id: string              // globally unique message ID
  timestamp: string       // ISO 8601
  from: string            // sender DID
  to: string              // recipient DID
  reply_to: string        // URL — sender's preferred reply endpoint
  meta?: {
    owner?: string        // DID of the owning entity
    owner_sig?: string    // owner's signature over the message
    card?: string         // URL to sender's agent card endpoint
    [key: string]: unknown
  }
  payload: AlfPayload
  signature?: string
  transit?: Record<string, unknown>
}

export interface AlfPayload {
  meta?: Record<string, unknown>
  sender_alias?: string
  recipient_alias?: string
  thread_id?: string
  parent_id?: string | null
  subject?: string
  content: string | Record<string, unknown>
  content_type?: string   // 'text/plain' | 'application/json' | etc.
  attachments?: AlfAttachment[]
  sent_at: string          // ISO 8601
  signature?: string
}

// =============================================================================
// ALF Agent Card
// =============================================================================

export type PolicyLevel = 'required' | 'optional' | 'none'

export interface AlfPolicy {
  type: string              // e.g. 'signing', 'owner_attestation', 'pow', 'encryption', 'fee'
  standard?: string         // protocol, algorithm, or method
  send?: PolicyLevel        // what I do on outbound messages
  receive?: PolicyLevel     // what I expect on inbound messages
  [key: string]: unknown    // type-specific parameters (e.g. difficulty for pow)
}

export interface AlfResolution {
  method: string            // resolution strategy: 'self' | 'chain' | 'registry' | 'dns'
  endpoint?: string         // URL for self/registry resolution
  network?: string          // blockchain network
  contract?: string         // smart contract address
  chain_id?: number         // chain identifier
  domain?: string           // DNS domain
  selector?: string         // DNS selector
}

export interface AlfAgentCard {
  // Identity fields — all optional. An agent with no configured keypair
  // produces a card without any of these four. Receivers discriminate.
  did?: string
  public_key?: string
  signed_at?: string        // ISO 8601 timestamp of when the card was signed
  signature?: string        // ed25519:<base64> — covers canonical JSON of all fields except signature

  handle: string
  description: string
  icon?: string
  resolution?: AlfResolution
  endpoints: { inbox: string; card: string; health: string; ws?: string }
  mesh_routes?: { method: string; path: string }[]
  public: boolean
  shared: string[]
  attestations?: AlfAttestation[]
  policies?: AlfPolicy[]
}

export interface AlfAttestation {
  issuer: string          // DID of the attesting party
  role: string            // 'owner' | 'operator' | 'certifier' | etc.
  issued_at: string       // ISO 8601
  expires_at?: string     // ISO 8601
  scope?: string          // what the attestation covers
  signature: string       // issuer's signature over the attestation
}

// =============================================================================
// Egress Context — separates message identity from transport delivery
// =============================================================================

export type TransportMethod = 'http' | 'ws' | 'local'

export interface EgressContext {
  message: AlfMessage
  transport: {
    address: string
    method: TransportMethod
    connection_id?: string    // WS connection ID for delivery
    headers?: Record<string, string>
  }
  agent: {
    did: string
  }
}

// =============================================================================
// Inbox
// =============================================================================

export type InboxStatus = 'unread' | 'read' | 'archived'

export interface InboxMessage {
  id: string
  from: string
  to?: string
  reply_to?: string
  network?: string
  thread_id?: string
  parent_id?: string
  subject?: string
  content: string
  content_type?: string      // payload.content_type
  attachments?: StoredAttachment[]
  meta?: Record<string, unknown>
  sender_alias?: string
  recipient_alias?: string
  message_id?: string        // ALF message ID (from AlfMessage.id)
  owner?: string             // meta.owner DID
  card?: string              // URL to sender's agent card endpoint
  return_path?: string       // transport-layer bounce address
  source?: string
  source_context?: Record<string, unknown>
  sent_at?: number
  received_at: number
  status: InboxStatus
  original_message?: string  // tombstoned original (was "envelope")
}

// =============================================================================
// Outbox
// =============================================================================

export type OutboxStatus = 'pending' | 'sent' | 'delivered' | 'failed'

export interface OutboxMessage {
  id: string
  from: string
  to: string
  address?: string
  reply_to?: string
  network?: string
  thread_id?: string
  parent_id?: string
  subject?: string
  content: string
  content_type?: string      // payload.content_type
  attachments?: StoredAttachment[]
  meta?: Record<string, unknown>
  sender_alias?: string
  recipient_alias?: string
  message_id?: string        // ALF message ID
  owner?: string             // meta.owner DID
  card?: string              // URL to our agent card endpoint
  return_path?: string       // our reply_to URL
  status_code?: number
  created_at: number
  delivered_at?: number
  status: OutboxStatus
  original_message?: string  // tombstoned original (was "envelope")
}

// =============================================================================
// Timers
// =============================================================================

export interface TimerOnceSchedule {
  mode: 'once'
  at: number
}

export interface TimerIntervalSchedule {
  mode: 'interval'
  every_ms: number
  start_at?: number
  end_at?: number
  max_runs?: number
}

export interface TimerCronSchedule {
  mode: 'cron'
  cron: string
  end_at?: number
  max_runs?: number
}

export type TimerSchedule = TimerOnceSchedule | TimerIntervalSchedule | TimerCronSchedule

export interface Timer {
  id: number
  schedule: TimerSchedule
  next_wake_at: number
  payload?: string
  scope: TriggerScopeV3[]
  lambda?: string
  warm?: boolean
  run_count: number
  created_at: number
  last_fired_at?: number
  locked?: boolean
}

// =============================================================================
// Meta
// =============================================================================

export const META_PROTECTION_LEVELS = ['none', 'readonly', 'increment'] as const
export type MetaProtectionLevel = (typeof META_PROTECTION_LEVELS)[number]

// =============================================================================
// Files
// =============================================================================

export const FILE_PROTECTION_LEVELS = ['read_only', 'no_delete', 'none'] as const
export type FileProtectionLevel = (typeof FILE_PROTECTION_LEVELS)[number]

export interface FileEntry {
  path: string
  content: Buffer
  mime_type?: string
  size: number
  protection: FileProtectionLevel
  authorized: boolean
  created_at: string
  updated_at: string
}

// =============================================================================
// Tasks (async tool interception)
// =============================================================================

export const TASK_STATUSES = [
  'pending', 'pending_approval', 'running',
  'completed', 'failed', 'denied', 'cancelled'
] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

export interface TaskEntry {
  id: string
  tool: string
  args: string
  status: TaskStatus
  result?: string
  error?: string
  created_at: number
  completed_at?: number
  origin?: string
  requires_authorization?: boolean
  /** When true, the executor is synchronously waiting to execute this tool — task_resolve signals approval without executing */
  executor_managed?: boolean
}

// =============================================================================
// Logs
// =============================================================================

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface AdfLogEntry {
  id: number
  level: LogLevel
  origin: string | null
  event: string | null
  target: string | null
  message: string
  data: string | null
  created_at: number
}

// =============================================================================
// Display Entry (UI Reconstruction from Loop)
// =============================================================================

export type DisplayEntryType = 'user' | 'text' | 'tool_call' | 'tool_result' | 'thinking' | 'error' | 'trigger' | 'compaction' | 'context'

export interface DisplayEntry {
  id: string
  type: DisplayEntryType
  content: string
  timestamp: number
  metadata?: Record<string, unknown>
}

// =============================================================================
// Defaults
// =============================================================================

export const DEFAULT_TOOLS: ToolDeclaration[] = [
  { name: 'fs_read', enabled: true, visible: true },
  { name: 'fs_write', enabled: true, visible: true },
  { name: 'fs_list', enabled: true, visible: true },
  { name: 'fs_delete', enabled: false, visible: false },
  { name: 'msg_send', enabled: true, visible: true },
  { name: 'agent_discover', enabled: true, visible: true },
  { name: 'msg_list', enabled: true, visible: true },
  { name: 'msg_read', enabled: true, visible: true },
  { name: 'msg_update', enabled: true, visible: true },
  { name: 'sys_code', enabled: false, visible: false },
  { name: 'sys_lambda', enabled: false, visible: false },
  { name: 'sys_set_timer', enabled: false, visible: false },
  { name: 'sys_list_timers', enabled: false, visible: false },
  { name: 'sys_delete_timer', enabled: false, visible: false },
  { name: 'sys_get_config', enabled: true, visible: true },
  { name: 'sys_update_config', enabled: false, visible: false },
  { name: 'sys_create_adf', enabled: false, visible: false, restricted: true },
  { name: 'db_query', enabled: false, visible: false },
  { name: 'db_execute', enabled: false, visible: false },
  { name: 'loop_compact', enabled: false, visible: false },
  { name: 'loop_clear', enabled: false, visible: false },
  { name: 'msg_delete', enabled: false, visible: false },
  { name: 'say', enabled: true, visible: true },
  { name: 'ask', enabled: true, visible: true },
  { name: 'sys_set_state', enabled: true, visible: true },
  { name: 'sys_get_meta', enabled: true, visible: true },
  { name: 'sys_set_meta', enabled: true, visible: true },
  { name: 'sys_delete_meta', enabled: true, visible: true },
  { name: 'sys_fetch', enabled: false, visible: false },
  { name: 'adf_shell', enabled: false, visible: false },
  { name: 'ws_connect', enabled: false, visible: false },
  { name: 'ws_disconnect', enabled: false, visible: false },
  { name: 'ws_connections', enabled: false, visible: false },
  { name: 'ws_send', enabled: false, visible: false },
  { name: 'stream_bind', enabled: false, visible: false },
  { name: 'stream_unbind', enabled: false, visible: false },
  { name: 'stream_bindings', enabled: false, visible: false },
  { name: 'fs_transfer', enabled: false, visible: false },
  { name: 'compute_exec', enabled: false, visible: false, restricted: true },
  { name: 'mcp_install', enabled: false, visible: false },
  { name: 'mcp_restart', enabled: false, visible: false },
  { name: 'mcp_uninstall', enabled: false, visible: false },
]

export const AUDIT_DEFAULTS: AuditConfig = {
  loop: false,
  inbox: false,
  outbox: false,
  files: false
}

export const DYNAMIC_INSTRUCTIONS_DEFAULTS: DynamicInstructionsConfig = {
  inbox_hints: true,
  context_warning: true,
  idle_reminder: true,
  mesh_updates: true
}

export const LOGGING_DEFAULTS: LoggingConfig = {
  default_level: 'info',
  rules: [],
  max_rows: 10000
}

export const MCP_DEFAULTS: McpConfig = {
  servers: []
}

export const SERVING_DEFAULTS: ServingConfig = {
  shared: { enabled: false, patterns: [] },
  public: { enabled: false },
  api: []
}

export const CARD_DEFAULTS: CardOverrides = {
  endpoints: {}
}

export const AGENT_DEFAULTS = {
  adf_version: '0.2' as const,
  state: 'active' as AgentState,
  autonomous: false,
  autostart: false,
  model: {
    provider: '',
    model_id: '',
    temperature: 0.7,
    max_tokens: 4096,
    vision: false
  },
  context: {
    audit: { ...AUDIT_DEFAULTS },
    dynamic_instructions: { ...DYNAMIC_INSTRUCTIONS_DEFAULTS }
  } as ContextConfig,
  triggers: {
    on_inbox: {
      enabled: true,
      targets: [{ scope: 'agent', interval_ms: 30000 }]
    },
    on_outbox: { enabled: false, targets: [] },
    on_file_change: {
      enabled: true,
      targets: [{ scope: 'agent', filter: { watch: 'document.*' }, debounce_ms: 2000 }]
    },
    on_chat: {
      enabled: true,
      targets: [{ scope: 'agent' }]
    },
    on_timer: {
      enabled: true,
      targets: [{ scope: 'system' }, { scope: 'agent' }]
    },
    on_tool_call: { enabled: false, targets: [] },
    on_task_create: { enabled: false, targets: [] },
    on_task_complete: { enabled: false, targets: [] },
    on_logs: { enabled: false, targets: [] },
    on_llm_call: { enabled: false, targets: [] },
    on_startup: { enabled: false, targets: [] }
  } as TriggersConfigV3,
  security: {
    allow_unsigned: true
  } as SecurityConfig,
  limits: {
    execution_timeout_ms: 5000,
    max_loop_rows: 500,
    max_daily_budget_usd: null,
    max_file_read_tokens: 30000,
    max_file_write_bytes: 5000000,
    max_tool_result_tokens: 16000,
    max_tool_result_preview_chars: 5000,
    max_active_turns: null,
    max_image_size_bytes: 5_242_880,
    max_audio_size_bytes: 10_485_760,
    max_video_size_bytes: 20_971_520
  } as LimitsConfig,
  messaging: {
    receive: false,
    mode: 'respond_only' as MessagingMode,
    visibility: 'localhost' as Visibility
  },
  audit: { ...AUDIT_DEFAULTS },
  code_execution: { ...CODE_EXECUTION_DEFAULTS },
  compute: { ...COMPUTE_DEFAULTS },
  logging: { ...LOGGING_DEFAULTS },
  mcp: { ...MCP_DEFAULTS },
  adapters: {} as AdaptersConfig,
  serving: {
    shared: { enabled: false, patterns: [] },
    public: { enabled: false },
    api: []
  } as ServingConfig,
  ws_connections: [] as WsConnectionConfig[],
  stream_bind: {} as StreamBindConfig,
  stream_bindings: [] as StreamBindingDeclaration[],
  providers: [] as AdfProviderConfig[],
  locked_fields: [] as string[],
  card: { endpoints: {} } as CardOverrides
}

export function getDefaultDocumentContent(name: string): string {
  const now = new Date().toISOString().split('T')[0]
  return `# ${name}

Created: ${now}
Status: New agent, self-configuring.
`
}

export const DEFAULT_MIND_CONTENT = ''
