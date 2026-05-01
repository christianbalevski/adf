/**
 * Channel Adapter Types
 *
 * Bridges external messaging platforms into the ADF runtime.
 * Adapters normalize inbound platform messages into adf_inbox rows
 * and deliver outbound adf_outbox messages back through platform APIs.
 */

// =============================================================================
// Adapter Interface (implemented by adapter packages)
// =============================================================================

export type AdapterStatus = 'connected' | 'connecting' | 'disconnected' | 'error'

export interface Attachment {
  path: string
  filename: string
  mimeType: string
  size: number
  data?: Buffer
}

export interface InboundMessage {
  sender: string
  senderName?: string
  traceId?: string
  parentId?: string
  subject?: string
  messageId?: string
  returnPath?: string
  payload: string
  attachments?: Attachment[]
  sourceMeta?: Record<string, unknown>
  /** Raw original message from the platform before ADF normalization (e.g. full parsed email, Telegram update JSON) */
  originalMessage?: string
  sentAt?: number
}

export interface OutboundMessage {
  id: string
  recipientId: string
  recipientName?: string
  traceId?: string
  parentId?: string
  subject?: string
  payload: string
  attachments?: Attachment[]
  sourceMeta?: Record<string, unknown>
  /** Adapter-specific delivery hints from the agent (e.g. reply_all, cc, bcc). Kept separate from sourceMeta to avoid collisions with inbound source_context. */
  routingHints?: Record<string, unknown>
}

export interface DeliveryResult {
  success: boolean
  sourceMeta?: Record<string, unknown>
  error?: string
}

export interface AdapterContext {
  /** Write an inbound message to the agent's inbox */
  ingest(msg: InboundMessage): void
  /** Write an attachment to the agent's internal file store */
  writeAttachment(path: string, data: Buffer, mimeType?: string): void
  /** Get the adapter's configuration from the agent config */
  getConfig(): AdapterInstanceConfig
  /** Read a credential from the agent's identity keystore */
  getCredential(key: string): string | null
  /** Log a message to the adapter's ring buffer */
  log(level: 'info' | 'warn' | 'error', message: string): void
}

export interface ChannelAdapter {
  /** Start the adapter with the given context */
  start(ctx: AdapterContext): Promise<void>
  /** Stop the adapter and clean up resources */
  stop(): Promise<void>
  /** Send an outbound message through the platform */
  send(msg: OutboundMessage): Promise<DeliveryResult>
  /** Check if this adapter can deliver to the given recipient ID */
  canDeliver(id: string): boolean
  /** Get the current connection status */
  status(): AdapterStatus
}

/** Factory function exported by adapter npm packages */
export type CreateAdapterFn = () => ChannelAdapter

// =============================================================================
// App-Level Registration (stored in AppSettings)
// =============================================================================

export interface AdapterRegistration {
  id: string
  type: string
  npmPackage?: string
  managed?: boolean
  version?: string
  /** App-level credentials (not per-agent) */
  env?: { key: string; value: string }[]
  /** Where credentials are stored: app-wide settings or per-agent ADF identity */
  credentialStorage?: 'app' | 'agent'
}

// =============================================================================
// Per-Agent Configuration (stored in AgentConfig.adapters)
// =============================================================================

export interface AdapterPolicy {
  /** How to handle DMs: 'all' | 'allowlist' | 'none' */
  dm?: 'all' | 'allowlist' | 'none'
  /** How to handle group messages: 'all' | 'mention' | 'none' */
  groups?: 'all' | 'mention' | 'none'
  /** Sender IDs allowed when using 'allowlist' mode */
  allow_from?: string[]
}

export interface AdapterLimits {
  /** Max attachment size in bytes */
  max_attachment_size?: number
}

export interface AdapterInstanceConfig {
  enabled: boolean
  credential_key?: string
  config?: Record<string, unknown>
  policy?: AdapterPolicy
  limits?: AdapterLimits
}

/** Map of adapter type → per-agent config */
export type AdaptersConfig = Record<string, AdapterInstanceConfig>

// =============================================================================
// Adapter Log Entry (mirrors McpServerLogEntry pattern)
// =============================================================================

export interface AdapterLogEntry {
  timestamp: number
  level: 'info' | 'warn' | 'error' | 'system'
  message: string
}

// =============================================================================
// Adapter State (mirrors McpServerState pattern)
// =============================================================================

export interface AdapterState {
  type: string
  status: AdapterStatus
  error?: string
  connectedAt?: number
  restartCount: number
  logs: AdapterLogEntry[]
}

// =============================================================================
// Adapter Install Progress (mirrors McpInstallProgress)
// =============================================================================

export interface AdapterInstallProgress {
  package: string
  status: 'installing' | 'installed' | 'error'
  progress?: string
  error?: string
}

// =============================================================================
// Adapter Status Event (mirrors McpServerStatusEvent)
// =============================================================================

export interface AdapterStatusEvent {
  type: string
  status: AdapterStatus
  error?: string
}

// =============================================================================
// Adapter Credential File Info (mirrors McpCredentialFileInfo)
// =============================================================================

export interface AdapterCredentialFileInfo {
  filePath: string
  fileName: string
  hasCredentials: boolean
  populatedKeys: string[]
}
