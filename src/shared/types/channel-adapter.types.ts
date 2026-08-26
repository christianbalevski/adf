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
  /** Descriptive message metadata stored in the inbox `meta` column (e.g. `meta.group` chat context). Unlike sourceMeta, never echoed onto outbound replies. */
  meta?: Record<string, unknown>
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
  /** MIME type of payload when it isn't plain text (e.g. application/vnd.adf.form+json). Adapters that recognize the type render it natively; others treat payload as text. */
  contentType?: string
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
  /**
   * Write an inbound message to the agent's inbox.
   * Returns the new inbox row id, or null when the message was skipped as a
   * duplicate (same source + messageId already ingested). Hosts that predate
   * dedup may return undefined.
   */
  ingest(msg: InboundMessage): string | null | undefined
  /** Write an attachment to the agent's internal file store */
  writeAttachment(path: string, data: Buffer, mimeType?: string): void
  /** Get the adapter's configuration from the agent config */
  getConfig(): AdapterInstanceConfig
  /** Read a credential from the agent's identity keystore */
  getCredential(key: string): string | null
  /** Log a message to the adapter's ring buffer */
  log(level: 'info' | 'warn' | 'error', message: string): void
  /** Per-agent, per-adapter writable directory for adapter state (e.g. WhatsApp auth keys). Optional — older hosts may not provide it. */
  getDataDir?(): string
  /**
   * Begin an offline catch-up drain. Messages ingested until endCatchUp() are
   * written to the inbox immediately (fully visible) but their trigger
   * notifications are held, so a slow backfill wakes the agent once at the
   * end instead of per message. Calls nest; the outermost endCatchUp flushes.
   * Optional — older hosts may not provide it; adapters must call via `?.`
   * and treat absence as "no deferral".
   */
  beginCatchUp?(): void
  /**
   * End an offline catch-up drain: emits the held inbound notifications in
   * one tight pass and returns what happened. Always call in a finally block
   * paired with beginCatchUp().
   */
  endCatchUp?(): { ingested: number; deduped: number }
}

/**
 * Offline catch-up settings, read from AdapterInstanceConfig.config.catch_up.
 * Bounds how much backlog an adapter pulls after being offline, so a long gap
 * cannot flood the agent's inbox. Caps are applied plainly: the adapter logs
 * what was skipped rather than silently truncating.
 */
export interface CatchUpConfig {
  /** Pull missed messages on connect (default true) */
  enabled?: boolean
  /** Ignore messages older than this many hours (default 24) */
  max_age_hours?: number
  /** Max messages to backfill per conversation/channel (default 200) */
  max_messages?: number
}

export const CATCH_UP_DEFAULTS: Required<CatchUpConfig> = {
  enabled: true,
  max_age_hours: 24,
  max_messages: 200
}

/** Resolve the effective catch-up config from an adapter's free-form config blob. */
export function resolveCatchUpConfig(config?: Record<string, unknown>): Required<CatchUpConfig> {
  const raw = (config?.catch_up ?? {}) as CatchUpConfig
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : CATCH_UP_DEFAULTS.enabled,
    max_age_hours: typeof raw.max_age_hours === 'number' && raw.max_age_hours > 0
      ? raw.max_age_hours : CATCH_UP_DEFAULTS.max_age_hours,
    max_messages: typeof raw.max_messages === 'number' && raw.max_messages > 0
      ? raw.max_messages : CATCH_UP_DEFAULTS.max_messages
  }
}

/** A participant in a chat/channel as reported by a platform */
export interface ChatParticipant {
  id: string
  name?: string
  role?: string
}

/**
 * Descriptive group-chat context. Attached by adapters to inbound rows as
 * `meta.group` (see src/main/adapters/group-meta.ts for the convention and
 * the buildGroupMeta helper), and extended by ChatInfo for live lookups.
 */
export interface GroupMeta {
  platform: string
  chat_id: string
  chat_type?: string
  title?: string
  description?: string
  participants: ChatParticipant[]
  /** True total when known — may exceed participants.length */
  participant_count?: number
  participants_truncated: boolean
  /** What the participants list represents: 'all' members, 'admins' only, one 'page', or message 'mentions' */
  participants_scope?: 'all' | 'admins' | 'mentions' | 'page'
}

/** Snapshot of a chat/channel's metadata fetched live from the platform */
export interface ChatInfo extends GroupMeta {
  fetched_at: number
}

export type ChatInfoResult =
  | { supported: true; info: ChatInfo }
  | { supported: false; reason: string }

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
  /** Optional read-only chat metadata lookup (title, roster, counts). Adapters without live query surfaces omit it. */
  getChatInfo?(chatId: string, opts?: { limit?: number }): Promise<ChatInfoResult>
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
