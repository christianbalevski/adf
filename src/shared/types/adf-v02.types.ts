/**
 * ADF v0.2 Type Definitions
 *
 * Tables: adf_meta, adf_config, adf_loop, adf_inbox, adf_outbox, adf_timers, adf_files, adf_identity, adf_audit
 * Tools: fs_*, msg_*, sys_*, db_*, loop_compact, loop_clear, msg_delete
 * Code execution methods: model_invoke, sys_lambda, task_resolve, loop_inject
 */

import type { ContentBlock, ReasoningConfig } from './provider.types'
import type { AdaptersConfig } from './channel-adapter.types'

// =============================================================================
// Agent Configuration
// =============================================================================

export const AGENT_STATES = ['active', 'idle', 'hibernate', 'suspended', 'off'] as const
export type AgentState = (typeof AGENT_STATES)[number]

/**
 * Path segments reserved for the agent's protocol mailboxes, served directly
 * under `/agents/:handle/` (e.g. `/agents/:handle/inbox`). Agent-served content — `serving.api`
 * routes, `public/` files — cannot claim these top-level segments; the schema
 * rejects colliding routes and the mesh server refuses to serve them. WS routes
 * are deliberately NOT reserved: they are agent-authored lambdas that live at the
 * agent's own chosen path, matched like any other route.
 */
export const RESERVED_AGENT_PATH_SEGMENTS = ['inbox', 'card', 'health'] as const
export type ReservedAgentPathSegment = (typeof RESERVED_AGENT_PATH_SEGMENTS)[number]


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
  /**
   * on_file_change only: opt in to changes made by this agent or one of its
   * lambdas. Defaults to false so a trigger cannot accidentally wake itself
   * forever by writing one of its watched files.
   */
  include_self?: boolean
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
  /**
   * Cognition stream this target wakes. Absent → 'main' (the membrane-facing
   * loop), which keeps every pre-loops config routing exactly as before. No
   * `'*'` broadcast — a target names one loop or none.
   */
  loop?: string
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
  /** @deprecated Use `reasoning.max_tokens` instead. Migrated forward on config load. */
  thinking_budget?: number | null
  /** Provider-agnostic reasoning ("thinking") config, normalized per provider. */
  reasoning?: ReasoningConfig
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
   * New agents default to 1 (every agent has identity keys per D1); files
   * created before the flip keep their stored level.
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
  /**
   * Allow sys_fetch/ws_connect to reach private/LAN/CGNAT addresses. Default
   * false: the runtime blocks private ranges (incl. DNS-resolved and redirect
   * targets) to prevent SSRF via prompt injection. Loopback is allowed by
   * default — except the local daemon control API, which is never fetchable —
   * and link-local/cloud-metadata addresses are always blocked regardless.
   * Set true only when an agent must call LAN services.
   */
  allow_local_fetch?: boolean
}

export interface LimitsConfig {
  execution_timeout_ms: number
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

/**
 * Automatic recovery from transient provider errors (rate limits, overload,
 * network failures). The provider layer already retries short blips; this
 * governs the executor-level backoff that re-runs the failed turn after
 * longer outages instead of dropping the dispatch.
 */
export interface RecoveryConfig {
  /** Retry the failed turn automatically after a transient provider error. Default true. */
  auto_retry: boolean
  /** Consecutive failed attempts per work item before giving up. Default 5. */
  max_attempts: number
  /** First retry delay (ms); doubles each attempt, with ±20% jitter. Default 15_000. */
  base_delay_ms: number
  /** Backoff ceiling (ms). Default 300_000 (5 min). */
  max_delay_ms: number
}

export const RECOVERY_DEFAULTS: RecoveryConfig = {
  auto_retry: true,
  max_attempts: 5,
  base_delay_ms: 15_000,
  max_delay_ms: 300_000
}

export type Visibility = 'directory' | 'localhost' | 'lan' | 'public' | 'off'

export const VISIBILITY_VALUES = ['off', 'directory', 'localhost', 'lan', 'public'] as const satisfies readonly Visibility[]

export interface MessagingConfig {
  /** Whether the agent participates in the mesh and can receive messages. */
  receive: boolean
  mode: MessagingMode
  /**
   * Declared reachability tier. Gates inbox acceptance and directory inclusion.
   * - 'directory': only agents on the same runtime in ancestor directories
   * - 'localhost': any agent on the same machine
   * - 'lan':      any agent on the local network
   * - 'public':   any agent reachable over the public internet
   * - 'off':      unreachable from every scope
   * Tiers are nested: public ⊃ lan ⊃ localhost ⊃ directory. Does not gate outbound sends.
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
  /** Read envelope state without exposing identity values or key material. Default true. */
  identity_status: boolean
  get_identity: boolean
  /** Allow code to store values in the agent's identity keystore. Default true. */
  set_identity: boolean
  /** Allow code to emit custom.* umbilical events via adf.emit_event. Default true. */
  emit_event: boolean
  /** Allow code to list this agent's attestations. Default true. */
  attestation_list: boolean
  /** Allow code to store peer-issued attestations about this agent. Default true. */
  attestation_add: boolean
  /** Allow code to sign attestations about other DIDs with this agent's key. Default true, but restricted to authorized code by default (restricted_methods). */
  attestation_issue: boolean
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
  identity_status: true,
  get_identity: true,
  set_identity: true,
  emit_event: true,
  attestation_list: true,
  attestation_add: true,
  attestation_issue: true,
  network: false,
  // Signing certs about other agents is a deliberate trust act — authorized
  // code only, unless the owner overrides restricted_methods explicitly.
  restricted_methods: ['attestation_issue']
}

// =============================================================================
// Compute Environment
// =============================================================================

export interface ComputePackages {
  /** @deprecated npm packages belong to code_execution.packages, not containers. */
  npm?: string[]
  /** Python packages installed into an ADF-managed dedicated container. */
  pip?: string[]
}

export interface ComputeConfig {
  /** Enable container-isolated compute environment for this agent's MCP servers. */
  enabled: boolean
  /** Packages to pre-install in the compute environment on start. */
  packages?: ComputePackages
  /** @deprecated Legacy single external target ID. Migrated at runtime. */
  target?: string
  /** Target IDs this agent may select with compute_exec. Built-ins use shared, isolated, and host. */
  allowed_targets?: string[]
  /** Target ID used when compute_exec.target is omitted. Must be in allowed_targets. */
  default_target?: string
  /** Allow the agent to install/run MCP servers on the host machine. Default false. */
  host_access?: boolean
  /** Visible browser display in the isolated container (Xvfb + noVNC viewer tab).
   *  Default true. Disable to skip the display stack and browser watcher —
   *  automation then runs headless-only with no viewer. */
  browser?: boolean
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

/**
 * A file-shaped credential the MCP server reads/writes in its runtime
 * filesystem (OAuth client keys, token stores). Content lives ONLY in the
 * agent identity keystore (`mcp:<pkg|name>:file:<path>`, credentials
 * envelope) — never in agent config. Materialized before every spawn;
 * captured back after a successful auth preflight.
 * NOTE: distinct from McpCredentialFileInfo (ipc.types.ts), which describes
 * an .adf FILE holding credentials for a server.
 */
export interface McpCredentialFileSchema {
  /** Absolute path or ~-relative path in the server's runtime filesystem. */
  path: string
  /** Connect fails plainly when neither keystore nor runtime FS has it. Default false. */
  required?: boolean
  /** Capture into the keystore after a successful auth preflight. Default true. */
  write_back?: boolean
}

export interface McpServerConfig {
  name: string
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  url?: string
  /** Remote HTTP endpoint uses interactive OAuth (browser sign-in) instead of a static bearer/header token. */
  oauth?: boolean
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
  /** File-shaped credentials to materialize from / capture into the identity keystore. */
  credential_files?: McpCredentialFileSchema[]
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
  /**
   * Runtime-only marker set by `deriveLoopConfig` to bind a loop executor to
   * its stream. Present exclusively on DERIVED side-loop configs, which are
   * built in memory and never written back — a stored `.adf` never carries it.
   */
  loop_name?: string
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
  audit?: AuditConfig
  dynamic_instructions?: DynamicInstructionsConfig
}

export const START_IN_STATES = ['active', 'idle', 'hibernate'] as const
export type StartInState = (typeof START_IN_STATES)[number]

/**
 * Recursive partial for template overrides: plain objects recurse, arrays stay
 * whole (they replace on merge), everything else is optional as-is.
 */
export type DeepPartial<T> = T extends (infer U)[]
  ? U[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T

/** Config keys a template never carries: they come from the file and its lifecycle. */
export type AgentTemplateExcludedKey = 'id' | 'metadata' | 'adf_version' | 'name' | 'description' | 'state'

/** Seed content for the files a new agent starts with. Empty/absent = code default. */
export interface AgentTemplateFiles {
  readme?: string
  mind?: string
}

/**
 * Studio's "Agent template" (settings.agentTemplate): what a user may pre-set
 * for agents they create from the app. Any config section except the excluded
 * keys, plus seed `files`. Holds ONLY overrides; an empty object means the
 * code defaults (DEFAULT_AGENT_CONFIG). Applied by AdfDatabase.create via
 * mergeAgentTemplate (src/shared/utils/agent-template.ts). Arrays (e.g.
 * `tools`) are whole lists that replace the default, not patches.
 */
export type AgentTemplate = DeepPartial<Omit<AgentConfig, AgentTemplateExcludedKey>> & {
  files?: AgentTemplateFiles
}

/**
 * Options for creating a new agent. `name` is required; everything else
 * overrides the AGENT_DEFAULTS when provided.
 */
export interface CreateAgentOptions {
  name: string
  /**
   * User's "Agent template" from Studio settings, merged over the code
   * defaults BEFORE the explicit fields below are applied. Its `files` seed
   * README.md / mind.md in place of the code defaults when non-empty. Set only by
   * user-initiated creation from Studio (FILE_CREATE and fleet-map founding).
   * Agent-spawned children (sys_create_adf) and the headless harness never
   * pass it: the template is the owner's preference for agents they make
   * themselves, not an inherited trait of the whole fleet.
   */
  template?: AgentTemplate
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
  type: 'anthropic' | 'openai' | 'openai-compatible' | 'openrouter'
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
  on_card?: boolean        // include this route in the agent card's api_routes (default off)
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
  connect_timeout_ms?: number        // default: 15000 — abort a socket stuck in CONNECTING
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
  /** Required to opt into `*` or bare `prefix.*` event_types (schema-enforced). */
  allow_wildcard?: boolean
  /** Token-bucket ceiling; overruns are dropped and counted as frames_dropped. */
  max_rate_per_sec?: number
  /** Suppress events whose `source` equals this value. */
  exclude_source?: string
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
  /**
   * Per-direction ceiling on queued-but-unwritten bytes (default 4 MiB). Once
   * exceeded the source is paused; it resumes at half this value. Sources that
   * cannot be paused (umbilical) drop frames instead.
   */
  queue_high_water_bytes?: number
  /** How long termination waits for in-flight writes to flush (default 1000). */
  drain_timeout_ms?: number
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
  /** Frames discarded because an unpausable source outran its sink, or was rate-limited. */
  frames_dropped?: number
  /** Declarative bindings only: failed materialization attempts so far. */
  attempts?: number
  /** Declarative bindings only: message from the most recent failed attempt. */
  last_error?: string
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
  /** Publish owner/operator attestations on the agent card. Default off — an
   *  unpublished agent is unlinkable to its owner by card inspection. */
  publish_attestations?: boolean
}

// =============================================================================
// Loops (facets)
// =============================================================================

/**
 * A named cognition stream inside this agent, sharing its file, identity,
 * credentials and substrate. `main` is implicit and never appears here — this
 * array holds SIDE loops only (reflector, consolidator, critic).
 *
 * A loop inherits the whole agent and overrides a small delta; it never gets
 * its own identity, credentials or channels. See docs/design/agent-loops-mvp.md.
 */
export interface LoopConfig {
  /** Unique within the array; `main` is reserved for the implicit host loop. */
  name: string
  /** Becomes the derived config's `instructions`. */
  goal: string
  enabled: boolean
  /**
   * Run a first turn on the goal without waiting to be addressed — at create
   * (via `loop_manage`) and again every time the agent starts, mirroring the
   * agent-level `autostart`. Main sends the kickoff through the ordinary
   * `loop_send` path with `wake: true`, so it is an audited stream row like
   * any other interior message. Absent = false: the loop only runs when a
   * trigger, timer or `loop_send` targets it. Ignored while `enabled: false`.
   */
  autostart?: boolean
  /** Inherits the parent's model when absent. */
  model?: ModelConfig
  /**
   * Token count at which this loop's executor auto-compacts its own history.
   * Absent (or null) inherits the host's `context.compact_threshold`.
   *
   * Exists for the `model` override above: a loop thinking with a different
   * model has a different context window, so the host's trigger point can be
   * far too late (or pointlessly early) for it. Same bounds as the host field.
   */
  compact_threshold?: number | null
  /**
   * Absolute allow-list, intersected with the host's enabled tools at derive
   * time. There is no per-loop visibility concept, and nothing is implicit:
   * `loop_send`/`loop_list` are granted only when they appear here (and the
   * host has them enabled), exactly like every other tool. Empty/absent = a
   * mute loop that only thinks. New loops are seeded with
   * `DEFAULT_NEW_LOOP_TOOLS`.
   */
  tools?: string[]
}

/**
 * What a newly created loop gets when nobody said otherwise — the Loops card
 * pre-ticks these, and `loop_manage create` uses them when `tools` is omitted.
 *
 * A suggestion, not a floor: an explicit list wins, including an empty one, so
 * a deliberately mute loop is expressible.
 */
export const DEFAULT_NEW_LOOP_TOOLS = ['loop_send', 'loop_list'] as const

/**
 * Never grantable to a side loop, at any layer.
 *
 * `sys_update_config` would let a loop rewrite the very config that attenuates
 * it; `loop_manage` is main-only (no nested loops); `sys_create_adf` mints a
 * whole new agent. Enforced twice: rejected by the Zod schema when it appears
 * in `LoopConfig.tools`, and subtracted again by `deriveLoopConfig` — which
 * additionally drops every tool the host marked `restricted`, because a HIL
 * approval can never be routed to a side-loop executor (MVP).
 */
export const LOOP_PROHIBITED_TOOLS = ['sys_update_config', 'loop_manage', 'sys_create_adf'] as const

/**
 * Read-time backfill for `AgentConfig.loops`.
 *
 * Deliberately non-persisting: unlike the tool backfill in
 * `AdfDatabase.getConfig()`, an absent `loops` is simply read as `[]` rather
 * than written back, so every pre-loops `.adf` round-trips byte-identical.
 */
export function resolveAgentLoops(config: Pick<AgentConfig, 'loops'>): LoopConfig[] {
  return config.loops ?? []
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
  /**
   * Escape hatch: the system prompt is `instructions` alone. Suppresses EVERY
   * runtime-injected prompt layer — the base prompt, every tool-prompt
   * section (skills, serving, database, ...), the identity and multimodal
   * blocks, and the autonomous suffix. It governs the static system prompt
   * ONLY: per-turn dynamic instructions are gated solely by the four
   * `context.dynamic_instructions` checkboxes (schema v30 ticked them all off
   * for agents that were already bare, since bare used to imply that).
   * `{{path}}` placeholders inside `instructions` still resolve: the owner put
   * them there deliberately, and they are the agent's own text, not ours.
   * Tool schemas are unaffected — they travel with the API request, not the
   * prompt. Supersedes `include_base_prompt` when true.
   */
  bare_prompt?: boolean
  context: ContextConfig
  tools: ToolDeclaration[]
  triggers: TriggersConfigV3
  security: SecurityConfig
  limits: LimitsConfig
  recovery?: RecoveryConfig
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
  umbilical?: UmbilicalConfig
  stream_bind?: StreamBindConfig
  stream_bindings?: StreamBindingDeclaration[]
  providers?: AdfProviderConfig[]
  /** Side loops only; `main` is implicit. Absent = none (see resolveAgentLoops). */
  loops?: LoopConfig[]
  metadata: MetadataConfig
}

/** Umbilical emission options. Opt-in only — defaults are all off. */
export interface UmbilicalConfig {
  /**
   * Emit `turn.delta` for every flushed streaming batch. High volume; off by
   * default. Taps that only need finished output should use `turn.completed`.
   */
  stream_deltas?: boolean
  /** Opt-in in-memory replay window for reconnecting observers. */
  log?: UmbilicalLogConfig
}

/**
 * Umbilical replay window settings.
 *
 * The window is an IN-MEMORY, per-agent ring the runtime fills at publish time.
 * Nothing is persisted: it exists so a reconnecting observer can tail from its
 * last `seq` instead of guessing, and a client that has fallen off the back
 * re-snapshots. Verifiable durable history is a separate, deferred design —
 * see docs/design/sealed-epochs.md. Guide: docs/guides/umbilical.md § Replay
 * window.
 */
export interface UmbilicalLogConfig {
  /** Off unless explicitly true. */
  enabled?: boolean
  /** Ring capacity; oldest events are evicted beyond this. Default 2000. */
  max_events?: number
  /**
   * Event types to skip, ADDITIVE to the always-excluded high-volume pair
   * `turn.delta` and `binding.flow_summary`.
   */
  exclude_types?: string[]
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
  /** USD cost of the call that produced this entry (provider-exact or table estimate). */
  cost_usd?: number
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
  api_routes?: { method: string; path: string }[]
  public: boolean
  shared: string[]
  attestations?: AlfAttestation[]
  policies?: AlfPolicy[]
}

export interface AlfAttestation {
  issuer: string          // DID of the attesting party
  subject: string         // DID the attestation is about — signed, so a cert can't be replayed onto another identity
  role: string            // 'owner' | 'operator' | 'runtime' | 'certifier' | etc.
  issued_at: string       // ISO 8601
  expires_at?: string     // ISO 8601
  scope?: string          // what the attestation covers
  signature: string       // ed25519:<base64> over canonical JSON of all fields except signature
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
  /**
   * Cognition stream this timer's agent-scope wake dispatches to. Absent →
   * 'main', so every pre-loops timer keeps firing exactly where it did. A
   * timer whose loop no longer exists is dropped and logged, never re-pointed
   * at main — an orphan running with main's authority is an escalation.
   */
  loop?: string
  /** Completed (one-shot fired, or recurring hit its end condition). Kept as
   *  history instead of deleted; never fires again. */
  expired?: boolean
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
  /**
   * Approval metadata for a HIL task, as stored JSON. Present on
   * pending_approval tasks so on_task_create lambdas, the tasks panel, and
   * post-restart reads can see WHAT is being approved — not just tool+args.
   * Shape: { reason: 'restricted' | 'protection', protection?: ProtectionDenial }
   * (protection carries kind/target/level and a plain-English description).
   */
  approval_meta?: TaskApprovalMeta
}

/** Durable approval metadata persisted on a HIL task's adf_tasks row. */
export interface TaskApprovalMeta {
  reason: 'restricted' | 'protection'
  protection?: {
    kind: string
    target: string
    level: string
    description?: string
  }
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
  // Code-path capability: callable as adf.chat_info from sandbox code without
  // occupying a slot in the LLM tool schema. Flip visible to expose it.
  { name: 'chat_info', enabled: true, visible: false },
  { name: 'sys_code', enabled: true, visible: true },
  { name: 'sys_lambda', enabled: true, visible: true },
  // Timers default on: the base prompt treats them as core behavior
  // (Initiate, Reflection, the hot path) — shipping them disabled forced a
  // fresh agent through the escalation ladder just to follow its own charter.
  { name: 'sys_set_timer', enabled: true, visible: true },
  { name: 'sys_list_timers', enabled: true, visible: true },
  { name: 'sys_delete_timer', enabled: true, visible: true },
  { name: 'sys_get_config', enabled: true, visible: true },
  { name: 'sys_update_config', enabled: true, visible: true, restricted: true },
  { name: 'sys_create_adf', enabled: false, visible: false, restricted: true },
  { name: 'db_query', enabled: true, visible: true },
  { name: 'db_execute', enabled: false, visible: false },
  { name: 'loop_compact', enabled: false, visible: false },
  { name: 'loop_clear', enabled: false, visible: false },
  // Inter-loop signalling. Ordinary, visible, owner-toggled tools like any
  // other (no-secrets): the config declares them, the Tools UI shows them, and
  // an owner may turn them off. On by default and registered into main's
  // registry whenever enabled — like ws_connections/stream_bindings, they are
  // simply present and return sensibly when there is nothing to act on
  // (loop_list shows just `main`; loop_send errors on any target). No
  // gate on loop count: that special-cased two tools for a byte-identical
  // prompt that default-on loop_manage already voids.
  { name: 'loop_send', enabled: true, visible: true },
  { name: 'loop_list', enabled: true, visible: true },
  // Main-only: creates/updates/tears down this agent's own inner loops.
  // On and ungated by default, because a loop is a strict ATTENUATION of
  // authority main already holds: deriveLoopConfig intersects the loop's
  // allow-list with the host's enabled tools, drops every `restricted` name,
  // and clamps code_execution — so loop_manage cannot expand the agent's
  // capability surface, only subdivide it. Creating a loop is therefore not an
  // escalation, and an approval gate would buy no authority the agent did not
  // already have. Still main-only (LOOP_PROHIBITED_TOOLS keeps it off every
  // loop) and still the owner's to re-gate with `restricted: true`. It honours
  // `locked_fields` (a locked `loops` path refuses) and delete archives the
  // stream and preserves locked timers, so it is recoverable.
  { name: 'loop_manage', enabled: true, visible: true },
  { name: 'msg_delete', enabled: false, visible: false },
  { name: 'say', enabled: true, visible: true },
  { name: 'ask', enabled: true, visible: true },
  { name: 'sys_set_state', enabled: true, visible: true },
  { name: 'sys_get_meta', enabled: true, visible: true },
  { name: 'sys_set_meta', enabled: true, visible: true },
  { name: 'sys_delete_meta', enabled: true, visible: true },
  { name: 'sys_fetch', enabled: true, visible: true },
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
  // Loop audit is on by default: compaction is the one routine operation that
  // destroys history irreversibly, and an agent that reflects on its own past
  // (see the self-observation skill) needs that record to exist before it
  // thinks to ask for it. The snapshots are brotli-compressed, so the cost is
  // small relative to losing the transcript outright.
  loop: true,
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
      // No interval_ms → fires immediately on each inbox event (no throttle).
      targets: [{ scope: 'agent' }]
    },
    on_outbox: { enabled: false, targets: [] },
    on_file_change: {
      enabled: true,
      targets: [{ scope: 'agent', filter: { watch: 'README.*' }, debounce_ms: 2000 }]
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
    on_task_complete: { enabled: true, targets: [{ scope: 'agent' }] },
    on_logs: { enabled: false, targets: [] },
    on_llm_call: { enabled: false, targets: [] },
    on_startup: { enabled: false, targets: [] }
  } as TriggersConfigV3,
  security: {
    allow_unsigned: true,
    // Signed by default: D1 guarantees every agent has keys, so the old
    // "signing would reject keyless agents" reason for level 0 is gone.
    // Unsigned inbound is still accepted (allow_unsigned) for mixed fleets.
    level: 1
  } as SecurityConfig,
  limits: {
    execution_timeout_ms: 60000,
    max_file_read_tokens: 30000,
    max_file_write_bytes: 5000000,
    max_tool_result_tokens: 16000,
    max_tool_result_preview_chars: 5000,
    max_active_turns: null,
    max_image_size_bytes: 5_242_880,
    max_audio_size_bytes: 10_485_760,
    max_video_size_bytes: 20_971_520
  } as LimitsConfig,
  recovery: { ...RECOVERY_DEFAULTS },
  messaging: {
    receive: true,
    mode: 'proactive' as MessagingMode,
    visibility: 'localhost' as Visibility,
    inbox_mode: true
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
  // A new agent starts with only its main loop; inner loops are added deliberately.
  loops: [] as LoopConfig[],
  stream_bind: {} as StreamBindConfig,
  stream_bindings: [] as StreamBindingDeclaration[],
  providers: [] as AdfProviderConfig[],
  // Dangerous capability toggles (security.allow_local_fetch, stream_bind) are
  // NOT locked here — they are locked in CODE via DEFAULT_LOCKED_PATHS in
  // sys-update-config.tool.ts, uniformly for every agent (existing and new),
  // so the protection can't be lost via per-agent data (no migration risk) or
  // an owner editing this default's locked_fields on a new agent expecting an
  // unlock. Keeping them here too would be redundant and misleading. This
  // array stays available for agent- or template-specific locks unrelated to
  // that fixed set.
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

/**
 * Seed content for mind.md — the always-injected index over the agent's
 * mind/ wiki pages. Kept deliberately small: every line here is loaded on
 * every turn. See docs/guides/agent-memory.md for the full pattern.
 */
export const DEFAULT_MIND_CONTENT = `# Mind

My index, loaded every turn. Keep it small; details live in pages under \`mind/\`.

## Always

<!-- One line per rule: what my principal wants and why. Corrections and preferences go here, since only this section loads every turn. Also who my principal is and my current focus. -->

## Pages

<!-- One line per page: - [title](adf-file://mind/slug.md) — one-line hook -->
`

/**
 * Seed content for mind/log.md — the append-only history of mind changes.
 * Newest entries first; pages are superseded in place, the log remembers.
 * Seeded by AdfDatabase.create() and backfilled by the v28 migration.
 */
export const DEFAULT_MIND_LOG_CONTENT = `# Mind Log

<!-- Newest first: prepend new entries at the top; never rewrite or delete existing entries. Entry format: ## [YYYY-MM-DD] ingest|update|lint | title -->
`

/**
 * Seed content for soul.md — the agent's voice and identity file, injected into
 * the system prompt via the `{{soul.md}}` placeholder. Owned and rewritten by
 * the agent itself; this default is a starting voice, not a fixed personality.
 */
export const DEFAULT_SOUL_CONTENT = `# Soul

This is the default voice, shared by every new agent. Keep it and I sound like all of them. The soul-creation skill in the first-party catalog has ten starting voices and a process for adopting or building one.

## Voice

- I answer first. Reasons come after, if they're needed.
- Short sentences. Short replies to humans.
- If my principal is wrong or about to waste hours, I say so and propose the fix.
- "I don't know" is an acceptable answer. When I break something I say what broke, what I changed, and what's still unknown.

## Taboos

- No "Great question", "I'd be happy to", or opening apologies.
- No summaries that restate what was just said.
- No offers tacked onto the end of a reply.

## Exemplars

- "Done. The cron runs at 8am Monday; first run is tomorrow."
- "No, that won't work. The API caps at 100 rows. I'll page through it instead, about 20 minutes."
- "I broke the deploy at 14:10 and rolled it back at 14:12. A missing env var. Fixed."

## Origin

<!-- Where I came from, who I work for, what I'm becoming. Fill in as it happens. -->
`
