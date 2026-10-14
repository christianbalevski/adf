// Client sessions and the client event stream (design daemon-backend.md D5).
//
// A client that needs exact UI parity (Studio in daemon mode, later the
// terminal app's richer chat view) opens a session and reads one SSE stream of
// domain frames:
//
//   executor  a raw executor event, as AGENT_EVENT carries it in embedded
//             Studio. Text and thinking deltas only for the session's focused
//             agent; every other executor event for every agent.
//   host      a RuntimeService lifecycle event (agent_starting … agent_stopped,
//             agent_state_changed, agent_loops_changed, trigger_error,
//             startup_failed).
//   push      a typed topic for every other Studio push channel (inbox,
//             approvals, mesh, config_changed, install progress, …), see
//             ClientPushPayloads.
//
// Delivery:
//
// - One ring per session (4096 frames, and a character budget), one cursor
//   space per session. A frame is serialized once and shared by every session
//   that takes it.
// - Frames are appended in emission order; one stream per session carries
//   them all, so frames of one agent arrive in executor order.
// - Back-pressure: the stream writes until the socket refuses (`write` returns
//   false), then waits for `drain`. Frames keep landing in the ring meanwhile;
//   memory per session is the ring plus at most one write chunk in the socket.
//   A frame evicted before it was written is never skipped silently: the
//   writer sends `stream.gap` (reason `evicted`, with the count) before the
//   next frame it has. A resume with an evicted cursor, or another session's
//   epoch, gets `stream.gap` too. One frame over MAX_FRAME_CHARS is not kept:
//   the session that would get it sees `stream.gap` reason `oversized`.
// - A session expires CLIENT_SESSION_EXPIRY_MS after its stream disconnects
//   (or after creation, if it never connects). Expiry releases its documents
//   through the ClientDocumentHost and tells onSessionEnded listeners. An
//   expired `exitDaemonWhenClosed` session stops a Studio-started daemon when
//   no other session is open; otherwise the shutdown waits for the last
//   session to end, and the others get `daemon_orphan_hold` (§8.3). Every
//   decision is logged with its reason.
//
// Payload size (embedded parity): the session focused on an agent gets its
// full payloads, as embedded IPC sends the open file's AGENT_EVENT. Every
// other session gets what BACKGROUND_AGENT_EVENT_BATCH carries: the
// background whitelist in full (UNFOCUSED_FULL_TYPES), `tool_call_result`
// without its content (`resultSize`, `stripped: 'tool_result'`), and any
// other event as a stub (short scalars plus `size`, `stripped: 'stub'`);
// `inbox` and `inter_agent_message` pushes as counts and without content.
// Clients fetch details on demand, so one agent's large write never fills
// another session's ring.

import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { AgentConfig, InboxMessage, McpServerStatus } from '../../shared/types/adf-v02.types'
import type { AdapterStatus } from '../../shared/types/channel-adapter.types'
import type { BrowserSessionEvent, ContainerPhaseEvent } from '../../shared/types/compute.types'
import type { AgentExecutionEvent, MeshEvent, NotificationsSnapshot } from '../../shared/types/ipc.types'
import type { UmbilicalEvent } from '../runtime/umbilical-bus'
import type { WorkspaceDataScope } from '../adf/adf-workspace'
import { subscribeAgentRuntimeSignals } from '../runtime/agent-runtime-signals'
import type {
  RuntimeAgentEvent,
  RuntimeAgentFileRenamedEvent,
  RuntimeAgentLoadedEvent,
  RuntimeAgentPathChangedEvent,
  RuntimeAgentUnloadedEvent,
  RuntimeLifecycleEvent,
  RuntimeLifecycleEventType,
  RuntimeService,
} from '../runtime/runtime-service'
import type { TrackedDirWatcher, WatcherAutostartNotice } from './dir-watcher'
import { safeJsonStringify, sseControl, sseFrame, trySafeJsonStringify } from './sse-wire'

export const CLIENT_RING_FRAMES = 4096
/** Ring budget in serialized characters (about bytes for JSON). The newest frame always stays. */
export const CLIENT_RING_CHARS = 32 * 1024 * 1024
export const CLIENT_SESSION_EXPIRY_MS = 60_000
/** Socket writes are cut at about this size, so a slow client holds at most one chunk beyond the socket's own buffer. */
const WRITE_CHUNK_CHARS = 64 * 1024
const HEARTBEAT_MS = 30_000
/** The same rename announced by two producers (RuntimeService and the W1-E file routes) within this window is sent once. */
const RENAME_DEDUPE_MS = 500

/** Executor event types that go only to the session focused on the emitting agent. */
export const DELTA_EVENT_TYPES: ReadonlySet<string> = new Set([
  'text_delta', 'text_delta_batch', 'thinking_delta', 'thinking_delta_batch',
])

/**
 * Executor events that echo a write: not sent to the session whose request
 * made it (origin dedup: runAsClientWrite stamps the request's own writes),
 * as embedded Studio never echoes its own edits to its window. Every other
 * session gets them.
 */
const ECHO_EXECUTOR_TYPES: ReadonlySet<string> = new Set(['file_updated', 'document_updated'])

/**
 * Executor events a session not focused on the agent gets in full: what the
 * background mapping forwards (background-event-mapping.ts FORWARDED_TYPES,
 * `state_changed`, `adf_file_created`). `tool_call_result` is stripped
 * (stripForRenderer). Every other event type reaches it as a stub: its
 * short scalar fields plus `size`, frame field `stripped: 'stub'`.
 */
const UNFOCUSED_FULL_TYPES: ReadonlySet<string> = new Set([
  'state_changed', 'ask_request', 'tool_approval_request', 'response_metadata', 'error', 'turn_complete', 'adf_file_created',
])

/**
 * `tool_call_start` reaches unfocused sessions too (the mesh graph shows the
 * call's arguments and draws the `msg_send` pulse from `input`), with each
 * top-level input field cut to this many characters; a cut input says
 * `inputTruncated: true` and the frame `stripped: 'tool_input'`.
 */
const TOOL_INPUT_CHARS = 2048

/** One frame larger than this (serialized characters) is not stored: the session gets `stream.gap` reason `oversized`. */
export const MAX_FRAME_CHARS = 4 * 1024 * 1024

/** Strings up to this length survive in a stub. */
const STUB_STRING_CHARS = 200

/**
 * The client session whose write is running now, set only for the
 * synchronous part of that request's route handler (runAsClientWrite). A
 * config, document or file write the handler performs raises its change
 * event synchronously, inside that window, and the event is stamped with the
 * session. Work the request queues (a turn on process.nextTick, a timer, a
 * startup turn after POST /start) runs after the window closed: its events
 * reach every session, the requester included. No async context is used, so
 * nothing queued inherits the tag.
 */
let syncWriteOrigin: string | null = null

/** Run `fn` (synchronously) as client session `sessionId`'s write: echo frames raised inside skip that session. */
export function runAsClientWrite<T>(sessionId: string, fn: () => T): T {
  const previous = syncWriteOrigin
  syncWriteOrigin = sessionId
  try {
    return fn()
  } finally {
    syncWriteOrigin = previous
  }
}

/** The session whose write is running synchronously now; null otherwise. */
function currentOriginSession(): string | null {
  return syncWriteOrigin
}

// --- Frames -------------------------------------------------------------------

export interface ClientExecutorFrame {
  kind: 'executor'
  cursor: number
  agentId: string
  filePath: string | null
  /** `event.loop`, copied for routing; absent = main. */
  loop?: string
  event: AgentExecutionEvent
  /**
   * Set when the payload was reduced for a session not focused on this agent:
   * `tool_result` (result content dropped, `resultSize` added),
   * `tool_input` (`tool_call_start` with each input field cut to 2048
   * characters, `inputTruncated: true`) or `stub` (only short scalar
   * fields, plus `size`; fetch details on demand).
   */
  stripped?: 'tool_result' | 'tool_input' | 'stub'
  /** The payload could not be serialized: `event.payload` is `{unserializable: reason}`. */
  unserializable?: true
}

export interface ClientHostFrame {
  kind: 'host'
  cursor: number
  agentId: string | null
  filePath: string | null
  type: RuntimeLifecycleEventType
  /** RuntimeLifecycleEvent payload (always carries `filePath`). */
  payload: Record<string, unknown>
  timestamp: number
  unserializable?: true
}

/** Progress of an MCP, adapter or sandbox package install: Studio's *_INSTALL_PROGRESS payload. */
export interface ClientInstallProgress {
  package: string
  status: 'installing' | 'installed' | 'error'
  progress?: string
  error?: string
}

/**
 * Push topics and their payloads. Each payload is the IPC payload of the
 * Studio push channel named beside it, so the event bridge (W2-C) sends it
 * as is; `agentId` / `filePath` on the frame say which agent it concerns
 * (null for daemon-wide topics). Pushes that embedded Studio sends only for
 * the open file are sent for every agent; the client filters.
 */
export interface ClientPushPayloads {
  /** DOC_AGENT_CONFIG_CHANGED. Runtime-originated changes; a session's own PUT /agents/:id/config is not echoed to it (header X-ADF-Client-Session). */
  config_changed: { filePath: string | null; config: AgentConfig }
  /**
   * INBOX_UPDATED: mesh delivery, adapter inbound, DELETE /agents/:id/inbox
   * (empty). Sessions not focused on the agent get only the counts (frame
   * `stripped: 'stub'`).
   */
  inbox: { inbox: { version: 1; messages: InboxMessage[] } } | { counts: { unread: number; read: number; archived: number } }
  /** WORKSPACE_DATA_CHANGED, coalesced per agent and scope (250 ms, as Studio). */
  workspace_data: { scope: WorkspaceDataScope }
  /** APPROVALS_CHANGED: the hub's full snapshot (not a delta; the hub coalesces). */
  approvals: NotificationsSnapshot
  /** MESH_EVENT, including the `station:<adapter>` message_routed pulse on adapter inbound. */
  mesh: MeshEvent
  /**
   * AGENT_EVENT `inter_agent_message` payload (a message delivered to a
   * loaded agent), for the client to synthesize on its focused agent; the
   * mesh-graph pulse for the others. Sessions not focused on the recipient
   * get it without `content` (frame `stripped: 'stub'`, `size`).
   */
  inter_agent_message: { fromAgent: string; toAgent: string; channel?: string; content?: string; size?: number; direction: 'incoming' }
  /**
   * The Studio session that owned this daemon run expired (§8.3) while other
   * sessions are open: the daemon stays up while they are and stops when the
   * last one ends. `holding: false` once a new owning session cleared it.
   */
  daemon_orphan_hold: { holding: boolean; reason: string; sessions: number }
  /** TEMPLATES_CHANGED (no payload). */
  templates: Record<string, never>
  /** TRACKED_DIRS_CHANGED. */
  tracked_dirs: { dirPath: string }
  /** FILE_RENAMED. */
  file_renamed: { oldPath: string; newPath: string }
  /** A loaded agent's file moved (RuntimeService rekeyAgentPath); no Studio push of its own. */
  agent_path_changed: { oldFilePath: string; filePath: string }
  /** The tracked-folder watcher's autostart of a new file (every outcome, including leased_elsewhere); no Studio push of its own. */
  autostart: WatcherAutostartNotice
  /** The watcher's autostart queue was full: these new files were not started (logged by the watcher too). */
  autostart_overflow: { dropped: number; queueLimit: number }
  /** A file was created for the user (registry bring-home): Studio's notifyAdfFileCreated. */
  adf_file_created: { filePath: string }
  /** MCP_INSTALL_PROGRESS (npm and Python packages). */
  mcp_install: ClientInstallProgress
  /** ADAPTER_INSTALL_PROGRESS. */
  adapter_install: ClientInstallProgress
  /** SANDBOX_INSTALL_PROGRESS. */
  sandbox_install: ClientInstallProgress
  /** MCP_SERVER_STATUS_CHANGED. */
  mcp_status: { name: string; status: McpServerStatus; error?: string; toolCount?: number }
  /** ADAPTER_STATUS_CHANGED. */
  adapter_status: { type: string; status: AdapterStatus; error?: string }
  /** COMPUTE_CONTAINER_PHASE. */
  compute_phase: ContainerPhaseEvent
  /** COMPUTE_BROWSER_SESSION. */
  browser_session: BrowserSessionEvent
}

export type ClientPushTopic = keyof ClientPushPayloads

export const CLIENT_PUSH_TOPICS: readonly ClientPushTopic[] = [
  'config_changed', 'inbox', 'workspace_data', 'approvals', 'mesh', 'inter_agent_message', 'templates',
  'tracked_dirs', 'file_renamed', 'agent_path_changed', 'autostart', 'autostart_overflow', 'adf_file_created', 'mcp_install', 'adapter_install',
  'sandbox_install', 'mcp_status', 'adapter_status', 'compute_phase', 'browser_session', 'daemon_orphan_hold',
]

export type ClientPushFrame = {
  [T in ClientPushTopic]: {
    kind: 'push'
    cursor: number
    topic: T
    agentId: string | null
    filePath: string | null
    payload: ClientPushPayloads[T]
    stripped?: 'stub'
    unserializable?: true
  }
}[ClientPushTopic]

/**
 * An umbilical envelope, as GET /events carries it, for a session opened
 * with `umbilical: true` (the terminal app, whose state model is built on
 * them). `turn.delta` is never sent: the focused agent's deltas arrive as
 * executor frames whatever `umbilical.stream_deltas` says.
 */
export interface ClientUmbilicalFrame {
  kind: 'umbilical'
  cursor: number
  agentId: string | null
  event: UmbilicalEvent
  unserializable?: true
}

export type ClientFrame = ClientExecutorFrame | ClientHostFrame | ClientPushFrame | ClientUmbilicalFrame

/**
 * `stream.gap` data. `epoch_changed`: the cursor came from another session;
 * `evicted`: frames after it were dropped before they were written;
 * `oversized`: one frame was larger than MAX_FRAME_CHARS and was not kept.
 */
export interface ClientStreamGap {
  reason: 'evicted' | 'epoch_changed' | 'oversized'
  epoch: string
  /** The last cursor the client had. */
  requestedCursor: number | null
  oldestCursor: number | null
  latestCursor: number
  /** Frames lost (evicted, oversized). */
  dropped?: number
  /** Serialized size of the oversized frame. */
  size?: number
}

// --- Documents (W2-A) -----------------------------------------------------------

export interface ClientDocumentHoldRequest {
  filePath?: string
  agentId?: string
}

export interface ClientHeldDocument {
  agentId: string
  filePath: string | null
  [key: string]: unknown
}

/**
 * Open documents (D4, W2-A) behind POST/DELETE /client/sessions/:id/documents.
 * The holder is always the session id, never a request body. `hold` MUST be
 * idempotent per session and agent. When a session ends (DELETE or expiry)
 * the registry calls `releaseHolder` when the host has it, else `release`
 * for every document the session held.
 */
export interface ClientDocumentHost {
  hold(sessionId: string, request: ClientDocumentHoldRequest): Promise<ClientHeldDocument>
  release(sessionId: string, agentId: string): Promise<void> | void
  releaseHolder?(sessionId: string): Promise<unknown> | void
}

export type ClientSessionEndReason = 'ended' | 'expired' | 'shutdown'

export interface ClientSessionEnded {
  sessionId: string
  client: string
  reason: ClientSessionEndReason
  /** Agent ids of the documents it held (already released). */
  documents: string[]
}

/** A refusal with an HTTP status and a stable code. */
export class ClientSessionError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message)
    this.name = 'ClientSessionError'
  }
}

// --- Stream sink ----------------------------------------------------------------

/** Where a session's SSE text goes: the hijacked HTTP response (a fake in tests). */
export interface ClientStreamSink {
  write(chunk: string): boolean
  once(event: 'drain', listener: () => void): unknown
  destroy(): void
  readonly destroyed?: boolean
}

export interface ClientSessionStats {
  frames: number
  chars: number
  oldestCursor: number | null
  latestCursor: number
  deliveredCursor: number | null
  connected: boolean
  paused: boolean
  /** Frames dropped before they were written, over the session's life. */
  dropped: number
  focus: string | null
  documents: string[]
}

interface RingEntry {
  cursor: number
  name: string
  /** Null: the frame was larger than MAX_FRAME_CHARS and was not kept (the writer sends a gap). */
  body: string | null
  /** Serialized size of an oversized frame. */
  size?: number
}

/** Fixed-capacity FIFO of frames with contiguous cursors. */
class FrameRing {
  private readonly slots: Array<RingEntry | undefined>
  private start = 0
  private count = 0
  chars = 0

  constructor(private readonly capacity: number, private readonly maxChars: number) {
    this.slots = new Array(capacity)
  }

  get size(): number {
    return this.count
  }

  get oldest(): number | null {
    return this.count === 0 ? null : this.slots[this.start]!.cursor
  }

  push(entry: RingEntry): void {
    if (this.count === this.capacity) this.shift()
    this.slots[(this.start + this.count) % this.capacity] = entry
    this.count++
    this.chars += entry.body?.length ?? 0
    while (this.chars > this.maxChars && this.count > 1) this.shift()
  }

  at(cursor: number): RingEntry | undefined {
    const oldest = this.oldest
    if (oldest === null || cursor < oldest || cursor >= oldest + this.count) return undefined
    return this.slots[(this.start + (cursor - oldest)) % this.capacity]
  }

  private shift(): void {
    const entry = this.slots[this.start]
    this.slots[this.start] = undefined
    this.start = (this.start + 1) % this.capacity
    this.count--
    if (entry) this.chars -= entry.body?.length ?? 0
  }
}

interface SessionConnection {
  sink: ClientStreamSink
  delivered: number
  paused: boolean
  heartbeat: ReturnType<typeof setInterval>
}

class ClientSession {
  readonly epoch = randomUUID()
  readonly createdAt = Date.now()
  focus: string | null = null
  readonly documents = new Map<string, ClientHeldDocument>()
  readonly ring: FrameRing
  nextCursor = 1
  connection: SessionConnection | null = null
  expiryTimer: ReturnType<typeof setTimeout> | null = null
  dropped = 0
  flushQueued = false
  /** Also carries umbilical frames (ClientUmbilicalFrame). */
  umbilical = false

  constructor(
    readonly id: string,
    readonly client: string,
    readonly version: string,
    readonly exitDaemonWhenClosed: boolean,
    ringFrames: number,
    ringChars: number,
  ) {
    this.ring = new FrameRing(ringFrames, ringChars)
  }

  get latest(): number {
    return this.nextCursor - 1
  }

  append(name: string, body: string | null, size?: number): void {
    this.ring.push({ cursor: this.nextCursor++, name, body, ...(size !== undefined ? { size } : {}) })
  }
}

export interface ClientSessionRegistryOptions {
  ringFrames?: number
  ringChars?: number
  /** Largest frame kept (serialized characters). Default MAX_FRAME_CHARS. */
  maxFrameChars?: number
  expiryMs?: number
  /** Who launched this daemon run (GET /version `startedBy`). The orphan rule only stops a daemon Studio started. */
  startedBy?: string
  /** The daemon's bounded graceful shutdown (POST /daemon/shutdown). */
  requestShutdown?: () => void
  /** Open documents (W2-A, runtimeDocumentHost). Absent: holding answers 405. */
  documents?: ClientDocumentHost | null
  /** An agent id, handle or name → the loaded agent's id; null when not loaded. */
  resolveAgentId?: (identifier: string) => string | null
  log?: (message: string) => void
}

/** A frame for every session, and optionally a reduced one for sessions not focused on its agent. */
interface FrameBodies {
  name: string
  full: () => string
  /** Absent: unfocused sessions get `full` too. Null from the function: they get nothing. */
  unfocused?: () => string | null
}

/**
 * Every client session of this daemon and the fan-out of frames into their
 * rings. Producers call publishExecutor / publishHost / publishPush (or are
 * wired with the wire* functions below); routes/client-routes.ts serves the
 * HTTP side.
 */
export class ClientSessionRegistry {
  private readonly sessions = new Map<string, ClientSession>()
  private readonly ringFrames: number
  private readonly ringChars: number
  private readonly maxFrameChars: number
  private readonly expiryMs: number
  private readonly log: (message: string) => void
  private readonly endedListeners = new Set<(ended: ClientSessionEnded) => void>()
  /** Loaded agents by path key, for producers that only know the path (mesh). */
  private readonly agentsByPath = new Map<string, string>()
  private readonly pathsByAgent = new Map<string, string>()
  private readonly recentRenames = new Map<string, number>()
  private documentHost: ClientDocumentHost | null
  /** §8.3: the owning Studio session expired while others were open; the daemon stops when the last one ends. */
  private orphanPending: string | null = null
  private disposed = false

  constructor(private readonly options: ClientSessionRegistryOptions = {}) {
    this.ringFrames = options.ringFrames ?? CLIENT_RING_FRAMES
    this.ringChars = options.ringChars ?? CLIENT_RING_CHARS
    this.maxFrameChars = options.maxFrameChars ?? MAX_FRAME_CHARS
    this.expiryMs = options.expiryMs ?? CLIENT_SESSION_EXPIRY_MS
    this.log = options.log ?? ((message) => console.log(`[ADF Daemon] ${message}`))
    this.documentHost = options.documents ?? null
  }

  // --- sessions ---------------------------------------------------------------

  create(input: { client: string; version: string; exitDaemonWhenClosed?: boolean; umbilical?: boolean }): { sessionId: string; epoch: string } {
    if (this.disposed) throw new ClientSessionError('The daemon is shutting down.', 503, 'unavailable')
    const session = new ClientSession(randomUUID(), input.client, input.version, input.exitDaemonWhenClosed === true, this.ringFrames, this.ringChars)
    session.umbilical = input.umbilical === true
    this.sessions.set(session.id, session)
    this.armExpiry(session)
    this.log(`Client session ${session.id} opened by ${input.client} ${input.version}${session.exitDaemonWhenClosed ? ' (stops the daemon when it expires)' : ''}`)
    if (session.exitDaemonWhenClosed && this.orphanPending) {
      // A new owner (Studio came back): its own expiry decides from now on.
      this.log(`The pending daemon shutdown is cleared: ${input.client} opened a session that owns this daemon run`)
      this.orphanPending = null
      this.publishPush('daemon_orphan_hold', { holding: false, reason: `${input.client} reconnected`, sessions: this.sessions.size })
    }
    return { sessionId: session.id, epoch: session.epoch }
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  get size(): number {
    return this.sessions.size
  }

  /** The agent a session follows, or undefined for an unknown session. */
  focusOf(sessionId: string): string | null | undefined {
    return this.sessions.get(sessionId)?.focus
  }

  /** End a session now (DELETE /client/sessions/:id): its documents are released; a pending orphan shutdown is re-checked. */
  async end(sessionId: string): Promise<void> {
    const session = this.require(sessionId)
    await this.finish(session, 'ended')
  }

  /**
   * Called with every ended session (DELETE, expiry, shutdown), after its
   * documents were released. The listener set is the session-expiry hook.
   */
  onSessionEnded(listener: (ended: ClientSessionEnded) => void): () => void {
    this.endedListeners.add(listener)
    return () => { this.endedListeners.delete(listener) }
  }

  /** W2-A's open-document host; replaces the default. */
  setDocumentHost(host: ClientDocumentHost | null): void {
    this.documentHost = host
  }

  setFocus(sessionId: string, identifier: string | null): string | null {
    const session = this.require(sessionId)
    const focus = identifier === null ? null : this.options.resolveAgentId?.(identifier) ?? identifier
    session.focus = focus
    return focus
  }

  async holdDocument(sessionId: string, request: ClientDocumentHoldRequest): Promise<ClientHeldDocument> {
    const session = this.require(sessionId)
    if (!this.documentHost) throw new ClientSessionError('Open documents are not available on this daemon.', 405, 'not_supported')
    const held = await this.documentHost.hold(session.id, request)
    // The session may have ended while the host opened the file.
    if (!this.sessions.has(session.id)) {
      await this.releaseQuietly(session.id, held.agentId)
      throw new ClientSessionError(`Client session ${session.id} ended while the document opened.`, 404, 'session_not_found')
    }
    session.documents.set(held.agentId, held)
    return held
  }

  async releaseDocument(sessionId: string, agentId: string): Promise<void> {
    const session = this.require(sessionId)
    if (!session.documents.has(agentId)) throw new ClientSessionError(`Client session ${sessionId} does not hold ${agentId}.`, 404, 'document_not_held')
    session.documents.delete(agentId)
    await this.documentHost?.release(session.id, agentId)
  }

  stats(sessionId: string): ClientSessionStats {
    const session = this.require(sessionId)
    return {
      frames: session.ring.size,
      chars: session.ring.chars,
      oldestCursor: session.ring.oldest,
      latestCursor: session.latest,
      deliveredCursor: session.connection?.delivered ?? null,
      connected: !!session.connection,
      paused: session.connection?.paused ?? false,
      dropped: session.dropped,
      focus: session.focus,
      documents: [...session.documents.keys()],
    }
  }

  /** Daemon shutdown: close every stream and drop every session. Documents are left to the runtime teardown. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const session of [...this.sessions.values()]) {
      this.closeConnection(session)
      if (session.expiryTimer) clearTimeout(session.expiryTimer)
      this.sessions.delete(session.id)
      this.notifyEnded(session, 'shutdown')
    }
  }

  // --- stream -----------------------------------------------------------------

  /**
   * Attach the session's one stream (a second attach replaces the first).
   * `since`: the last cursor the client has (absent: from the session's
   * start); `epoch`: the epoch it came from. A sink already closed is not
   * attached: the session's expiry clock runs as for any closed stream.
   */
  attach(sessionId: string, sink: ClientStreamSink, resume: { since?: number; epoch?: string } = {}): void {
    const session = this.require(sessionId)
    if (sink.destroyed) {
      this.log(`Client session ${session.id} (${session.client}): the stream closed before it was attached`)
      if (!session.connection) this.armExpiry(session)
      return
    }
    if (session.connection) {
      this.log(`Client session ${session.id}: a new stream replaces the open one`)
      this.closeConnection(session)
    }
    if (session.expiryTimer) {
      clearTimeout(session.expiryTimer)
      session.expiryTimer = null
    }
    const oldest = session.ring.oldest
    const latest = session.latest
    let chunk = sseControl('stream.hello', { epoch: session.epoch, oldestCursor: oldest, latestCursor: latest })
    let delivered = Math.min(resume.since ?? 0, latest)
    if (resume.epoch !== undefined && resume.epoch !== session.epoch) {
      chunk += sseControl('stream.gap', {
        reason: 'epoch_changed', epoch: session.epoch, requestedCursor: resume.since ?? null, oldestCursor: oldest, latestCursor: latest,
      } satisfies ClientStreamGap)
      delivered = (oldest ?? session.nextCursor) - 1
    }
    const connection: SessionConnection = {
      sink,
      delivered,
      paused: false,
      heartbeat: setInterval(() => {
        if (!connection.paused && !sink.destroyed) this.write(session, connection, `: heartbeat ${Date.now()}\n\n`)
      }, HEARTBEAT_MS),
    }
    connection.heartbeat.unref?.()
    session.connection = connection
    if (this.write(session, connection, chunk)) this.flush(session)
  }

  /** Close the session's stream; the session stays, and its client reconnects with `since=`. */
  disconnect(sessionId: string): void {
    const session = this.require(sessionId)
    if (!session.connection) return
    this.log(`Client session ${session.id} (${session.client}): stream closed by the daemon`)
    this.closeConnection(session)
    this.armExpiry(session)
  }

  /** The stream closed (client gone): the expiry clock starts. */
  detach(sessionId: string, sink: ClientStreamSink): void {
    const session = this.sessions.get(sessionId)
    if (!session || session.connection?.sink !== sink) return
    clearInterval(session.connection.heartbeat)
    session.connection = null
    this.armExpiry(session)
  }

  // --- publishing -------------------------------------------------------------

  /**
   * A raw executor event. Deltas only to sessions focused on the agent;
   * echoes of a session's own write (ECHO_EXECUTOR_TYPES under its write
   * source, or `origin`) not to that session; sessions not focused on the
   * agent get the background whitelist (UNFOCUSED_FULL_TYPES), a stripped
   * tool result, or a stub.
   */
  publishExecutor(event: RuntimeAgentEvent, origin?: string | null): void {
    if (this.sessions.size === 0) return
    const type = event.event.type
    const echoFrom = ECHO_EXECUTOR_TYPES.has(type) ? origin ?? currentOriginSession() : null
    const unfocused = DELTA_EVENT_TYPES.has(type)
      ? () => null
      : type === 'tool_call_result'
        ? () => frameJson(executorFrame(event, 'tool_result'), 'event')
        : type === 'tool_call_start'
          ? () => frameJson(executorFrame(event, 'tool_input'), 'event')
          : UNFOCUSED_FULL_TYPES.has(type)
            ? undefined
            : () => frameJson(executorFrame(event, 'stub'), 'event')
    this.fanOut(event.agentId, {
      name: 'executor',
      full: () => frameJson(executorFrame(event, null), 'event'),
      ...(unfocused ? { unfocused } : {}),
    }, echoFrom)
  }

  /**
   * An umbilical envelope, for the sessions that asked for them. `turn.delta`
   * (only with `umbilical.stream_deltas`) goes to the ones not focused on the
   * agent: the focused one streams that agent's executor deltas instead.
   */
  publishUmbilical(event: UmbilicalEvent): void {
    if (this.sessions.size === 0) return
    const delta = event.event_type === 'turn.delta'
    let body: string | undefined
    for (const session of this.sessions.values()) {
      if (!session.umbilical) continue
      if (delta && session.focus !== null && session.focus === event.agent_id) continue
      body ??= frameJson({ kind: 'umbilical', agentId: event.agent_id ?? null, event }, 'event')
      this.append(session, 'umbilical', body)
    }
  }

  publishHost(event: RuntimeLifecycleEvent): void {
    if (this.sessions.size === 0) return
    this.fanOut(event.agentId, {
      name: 'host',
      full: () => frameJson({ kind: 'host', agentId: event.agentId, filePath: event.filePath, type: event.type, payload: event.payload, timestamp: event.timestamp }, 'payload'),
    })
  }

  /**
   * A push topic. `opts.unfocused`: the payload for sessions not focused on
   * the agent (frame `stripped: 'stub'`). `config_changed` from a session's
   * own write is not sent to that session.
   */
  publishPush<T extends ClientPushTopic>(
    topic: T,
    payload: ClientPushPayloads[T],
    target: { agentId?: string | null; filePath?: string | null } = {},
    opts: { unfocused?: () => ClientPushPayloads[T] } = {},
  ): void {
    if (this.sessions.size === 0) return
    const agentId = target.agentId ?? (target.filePath ? this.agentIdForPath(target.filePath) : null)
    const filePath = target.filePath ?? null
    if (topic === 'file_renamed' && this.isRepeatedRename(payload as ClientPushPayloads['file_renamed'])) return
    const echoFrom = topic === 'config_changed' ? currentOriginSession() : null
    const stub = opts.unfocused
    this.fanOut(agentId, {
      name: 'push',
      full: () => frameJson({ kind: 'push', topic, agentId, filePath, payload }, 'payload'),
      ...(stub ? { unfocused: () => frameJson({ kind: 'push', topic, agentId, filePath, payload: stub(), stripped: 'stub' }, 'payload') } : {}),
    }, echoFrom)
  }

  // --- agent index ------------------------------------------------------------

  indexAgent(filePath: string | null, agentId: string): void {
    if (!filePath) return
    this.agentsByPath.set(pathKey(filePath), agentId)
    this.pathsByAgent.set(agentId, filePath)
  }

  unindexAgent(filePath: string | null, agentId: string): void {
    if (!filePath) return
    if (this.agentsByPath.get(pathKey(filePath)) === agentId) this.agentsByPath.delete(pathKey(filePath))
    if (this.pathsByAgent.get(agentId) === filePath) this.pathsByAgent.delete(agentId)
  }

  agentIdForPath(filePath: string): string | null {
    return this.agentsByPath.get(pathKey(filePath)) ?? null
  }

  /** The loaded agent's current file path (it follows renames). */
  pathForAgent(agentId: string): string | null {
    return this.pathsByAgent.get(agentId) ?? null
  }

  // --- internals --------------------------------------------------------------

  /** Serialize lazily, once per variant, and append to every session that takes the frame. */
  private fanOut(agentId: string | null, bodies: FrameBodies, skipSession: string | null = null): void {
    let full: string | undefined
    let unfocused: string | null | undefined
    for (const session of this.sessions.values()) {
      if (skipSession !== null && session.id === skipSession) continue
      const focused = agentId !== null && session.focus === agentId
      let body: string | null
      if (focused || !bodies.unfocused) body = full ??= bodies.full()
      else {
        if (unfocused === undefined) unfocused = bodies.unfocused()
        body = unfocused
      }
      if (body !== null) this.append(session, bodies.name, body)
    }
  }

  private require(sessionId: string): ClientSession {
    const session = this.sessions.get(sessionId)
    if (!session) throw new ClientSessionError(`No client session ${sessionId} (it ended or expired, or the daemon restarted).`, 404, 'session_not_found')
    return session
  }

  private append(session: ClientSession, name: string, body: string): void {
    if (body.length > this.maxFrameChars) {
      // Kept as a hole: this session's reader gets a visible gap, no other session is touched.
      this.log(`Client session ${session.id} (${session.client}): a ${name} frame of ${body.length} characters is over the ${this.maxFrameChars} limit; sending stream.gap`)
      session.append(name, null, body.length)
    } else {
      session.append(name, body)
    }
    if (session.connection && !session.connection.paused) this.queueFlush(session)
  }

  /** One flush per session per turn of the event loop: a burst becomes one socket write. */
  private queueFlush(session: ClientSession): void {
    if (session.flushQueued) return
    session.flushQueued = true
    setImmediate(() => {
      session.flushQueued = false
      this.flush(session)
    })
  }

  private flush(session: ClientSession): void {
    const connection = session.connection
    if (!connection || connection.paused || connection.sink.destroyed) return
    let chunk = ''
    while (connection.delivered < session.latest) {
      const next = connection.delivered + 1
      const entry = session.ring.at(next)
      if (!entry) {
        // Evicted before it was written: say so, then go on with what is left.
        const oldest = session.ring.oldest
        const resumeAt = oldest ?? session.nextCursor
        const dropped = resumeAt - next
        session.dropped += dropped
        this.log(`Client session ${session.id} (${session.client}): ${dropped} frame(s) dropped for a slow or absent reader; sending stream.gap`)
        chunk += sseControl('stream.gap', {
          reason: 'evicted', epoch: session.epoch, requestedCursor: connection.delivered, oldestCursor: oldest, latestCursor: session.latest, dropped,
        } satisfies ClientStreamGap)
        connection.delivered = resumeAt - 1
        continue
      }
      if (entry.body === null) {
        session.dropped += 1
        chunk += sseControl('stream.gap', {
          reason: 'oversized', epoch: session.epoch, requestedCursor: connection.delivered, oldestCursor: session.ring.oldest, latestCursor: session.latest, dropped: 1, ...(entry.size !== undefined ? { size: entry.size } : {}),
        } satisfies ClientStreamGap)
        connection.delivered = next
        continue
      }
      chunk += sseFrame(entry.cursor, entry.name, entry.body)
      connection.delivered = next
      if (chunk.length >= WRITE_CHUNK_CHARS) {
        if (!this.write(session, connection, chunk)) return
        chunk = ''
      }
    }
    if (chunk) this.write(session, connection, chunk)
  }

  /** False when the socket refused more: the stream pauses until `drain`. */
  private write(session: ClientSession, connection: SessionConnection, chunk: string): boolean {
    if (connection.sink.destroyed) return false
    let ok: boolean
    try {
      ok = connection.sink.write(chunk)
    } catch {
      return false
    }
    if (!ok && !connection.paused) {
      connection.paused = true
      connection.sink.once('drain', () => {
        if (session.connection !== connection) return
        connection.paused = false
        this.flush(session)
      })
    }
    return ok
  }

  private closeConnection(session: ClientSession): void {
    const connection = session.connection
    if (!connection) return
    clearInterval(connection.heartbeat)
    session.connection = null
    try { connection.sink.destroy() } catch { /* already gone */ }
  }

  private armExpiry(session: ClientSession): void {
    if (session.expiryTimer) clearTimeout(session.expiryTimer)
    session.expiryTimer = setTimeout(() => {
      session.expiryTimer = null
      if (this.sessions.get(session.id) !== session || session.connection) return
      void this.finish(session, 'expired')
    }, this.expiryMs)
    session.expiryTimer.unref?.()
  }

  private async finish(session: ClientSession, reason: ClientSessionEndReason): Promise<void> {
    if (this.sessions.get(session.id) !== session) return
    this.sessions.delete(session.id)
    if (session.expiryTimer) clearTimeout(session.expiryTimer)
    this.closeConnection(session)
    const documents = [...session.documents.keys()]
    session.documents.clear()
    if (this.documentHost?.releaseHolder) {
      try { await this.documentHost.releaseHolder(session.id) } catch (err) { console.error(`[ADF Daemon] Releasing the documents of client session ${session.id} failed:`, err) }
    } else {
      for (const agentId of documents) await this.releaseQuietly(session.id, agentId)
    }
    this.log(`Client session ${session.id} (${session.client}) ${reason === 'expired' ? `expired ${Math.round(this.expiryMs / 1000)} s after its stream closed` : 'ended'}${documents.length ? `; released ${documents.length} document(s)` : ''}`)
    this.notifyEnded(session, reason, documents)
    if (reason === 'expired' && session.exitDaemonWhenClosed) this.applyOrphanRule(session)
    else if (this.orphanPending) this.recheckOrphan(`${session.client} session ${session.id} ${reason}`)
  }

  /** §8.3: an expired exitDaemonWhenClosed session stops a Studio-started daemon when nobody else is connected. */
  private applyOrphanRule(session: ClientSession): void {
    const why = `client session ${session.id} (${session.client}) expired and asked to stop the daemon when closed`
    if (this.options.startedBy !== 'studio') {
      this.log(`Not stopping the daemon: ${why}, but this daemon run was started by ${this.options.startedBy ?? 'an unknown launcher'}, not Studio`)
      return
    }
    if (this.sessions.size > 0) {
      // Re-checked whenever another session ends (recheckOrphan).
      this.orphanPending = why
      const clients = [...this.sessions.values()].map(s => s.client).join(', ')
      this.log(`Not stopping the daemon yet: ${why}, but ${this.sessions.size} other client session(s) are open (${clients}); it stops when the last one ends`)
      this.publishPush('daemon_orphan_hold', {
        holding: true,
        reason: `${session.client} closed; the daemon it started keeps running while you are connected and stops when the last client disconnects`,
        sessions: this.sessions.size,
      })
      return
    }
    this.shutDown(why)
  }

  private recheckOrphan(trigger: string): void {
    if (!this.orphanPending || this.sessions.size > 0) return
    const why = `${this.orphanPending}; the last other client session ended (${trigger})`
    this.orphanPending = null
    this.shutDown(why)
  }

  private shutDown(why: string): void {
    if (!this.options.requestShutdown) {
      this.log(`Not stopping the daemon: ${why}, but shutdown is not available`)
      return
    }
    this.log(`Stopping the daemon: ${why}, and no other client session is open`)
    this.options.requestShutdown()
  }

  private notifyEnded(session: ClientSession, reason: ClientSessionEndReason, documents: string[] = []): void {
    const ended: ClientSessionEnded = { sessionId: session.id, client: session.client, reason, documents }
    for (const listener of [...this.endedListeners]) {
      try { listener(ended) } catch (err) { console.error('[ADF Daemon] A client session listener failed:', err) }
    }
  }

  private async releaseQuietly(sessionId: string, agentId: string): Promise<void> {
    try {
      await this.documentHost?.release(sessionId, agentId)
    } catch (err) {
      console.error(`[ADF Daemon] Releasing ${agentId} for client session ${sessionId} failed:`, err)
    }
  }

  private isRepeatedRename(payload: { oldPath: string; newPath: string }): boolean {
    const now = Date.now()
    for (const [key, at] of this.recentRenames) if (now - at > RENAME_DEDUPE_MS) this.recentRenames.delete(key)
    const key = `${pathKey(payload.oldPath)}\u0000${pathKey(payload.newPath)}`
    if (this.recentRenames.has(key)) return true
    this.recentRenames.set(key, now)
    return false
  }
}

let daemonRegistry: ClientSessionRegistry | null = null

/**
 * The daemon process's registry (daemon/index.ts), served by the /client/*
 * routes when DaemonRouteDeps.clientSessions is not given; the same pattern
 * as registerDaemonEventBus.
 */
export function registerDaemonClientSessions(registry: ClientSessionRegistry | null): void {
  daemonRegistry = registry
}

export function daemonClientSessions(): ClientSessionRegistry | null {
  return daemonRegistry
}

const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin'

/**
 * Lookup key of an agent path. No filesystem access (it runs per frame):
 * RuntimeService and the mesh hold canonical paths already, so resolving and
 * case-folding where the filesystem is case-insensitive is enough.
 */
function pathKey(filePath: string): string {
  const abs = resolve(filePath)
  return CASE_INSENSITIVE_FS ? abs.toLowerCase() : abs
}

function executorFrame(event: RuntimeAgentEvent, strip: 'tool_result' | 'tool_input' | 'stub' | null): Omit<ClientExecutorFrame, 'cursor'> {
  const loop = event.event.loop
  const base = { kind: 'executor' as const, agentId: event.agentId, filePath: event.filePath, ...(loop !== undefined ? { loop } : {}) }
  if (!strip) return { ...base, event: event.event }
  if (strip === 'tool_input') {
    const payload = (event.event.payload ?? {}) as Record<string, unknown>
    const cut = truncateInput(payload.input)
    if (!cut.truncated) return { ...base, event: event.event }
    return { ...base, stripped: 'tool_input', event: { ...event.event, payload: { ...payload, input: cut.value, inputTruncated: true } } }
  }
  if (strip === 'stub') return { ...base, stripped: 'stub', event: { ...event.event, payload: stubPayload(event.event.payload) } }
  const payload = (event.event.payload ?? {}) as Record<string, unknown> & { result?: { content?: unknown; isError?: unknown } }
  const content = payload.result?.content
  const { result: _result, ...rest } = payload
  return {
    ...base,
    stripped: 'tool_result',
    event: { ...event.event, payload: { ...rest, result: { isError: !!payload.result?.isError }, resultSize: typeof content === 'string' ? content.length : 0 } },
  }
}

/** A tool input with each top-level field cut to TOOL_INPUT_CHARS (a non-string field over it becomes its cut JSON). */
function truncateInput(input: unknown): { value: unknown; truncated: boolean } {
  const cutString = (text: string) => text.length > TOOL_INPUT_CHARS ? `${text.slice(0, TOOL_INPUT_CHARS)}…` : text
  if (typeof input === 'string') return { value: cutString(input), truncated: input.length > TOOL_INPUT_CHARS }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    const json = trySafeJsonStringify(input)
    if ('json' in json && json.json.length > TOOL_INPUT_CHARS) return { value: cutString(json.json), truncated: true }
    return { value: input, truncated: false }
  }
  let truncated = false
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === 'string') {
      out[key] = cutString(value)
      truncated ||= value.length > TOOL_INPUT_CHARS
    } else if (value && typeof value === 'object') {
      const json = trySafeJsonStringify(value)
      if ('json' in json && json.json.length > TOOL_INPUT_CHARS) {
        out[key] = cutString(json.json)
        truncated = true
      } else out[key] = value
    } else out[key] = value
  }
  return { value: truncated ? out : input, truncated }
}

/**
 * A payload reduced for a session not focused on its agent: the scalar
 * fields (strings up to STUB_STRING_CHARS), plus `size`, the serialized size
 * of the whole payload. The client fetches the rest on demand.
 */
export function stubPayload(payload: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
      if (typeof value === 'number' || typeof value === 'boolean' || value === null) out[key] = value
      else if (typeof value === 'string' && value.length <= STUB_STRING_CHARS) out[key] = value
    }
  }
  const json = trySafeJsonStringify(payload)
  out.size = 'json' in json ? json.json.length : 0
  return out
}

/**
 * A frame's JSON. When its payload cannot be serialized at all (a throwing
 * getter or toJSON), the envelope is kept and the payload becomes
 * `{unserializable: reason}`, with `unserializable: true` on the frame, so
 * the client sees that something happened.
 */
function frameJson(frame: Record<string, unknown>, payloadAt: 'event' | 'payload'): string {
  const whole = trySafeJsonStringify(frame)
  if ('json' in whole) return whole.json
  const inner = payloadAt === 'event' ? (frame.event as Record<string, unknown>).payload : frame.payload
  const reason = (() => { const r = trySafeJsonStringify(inner); return 'error' in r ? r.error : whole.error })()
  console.error(`[ADF Daemon] A ${String(frame.kind)} frame could not be serialized: ${reason}`)
  const replaced = payloadAt === 'event'
    ? { ...frame, event: { ...(frame.event as Record<string, unknown>), payload: { unserializable: reason } }, unserializable: true }
    : { ...frame, payload: { unserializable: reason }, unserializable: true }
  return safeJsonStringify(replaced)
}

/** Inbox counts by status: what a session not focused on the agent gets instead of the messages. */
function inboxCounts(messages: Array<{ status?: unknown }>): { unread: number; read: number; archived: number } {
  const counts = { unread: 0, read: 0, archived: 0 }
  for (const message of messages) {
    if (message.status === 'read') counts.read++
    else if (message.status === 'archived') counts.archived++
    else counts.unread++
  }
  return counts
}

/** The `inbox` push for an agent: the messages to sessions focused on it, the counts to the others. */
function publishInbox(sessions: ClientSessionRegistry, messages: InboxMessage[], target: { agentId?: string | null; filePath?: string | null }): void {
  sessions.publishPush('inbox', { inbox: { version: 1, messages } }, target, { unfocused: () => ({ counts: inboxCounts(messages) }) })
}

// --- Documents (W2-A) --------------------------------------------------------------

/** The RuntimeService calls a session's documents go through (W2-A, design D4). */
type DocumentRuntime = Pick<RuntimeService, 'openDocument' | 'releaseDocument' | 'releaseDocumentHolder' | 'getAgentOrDocument'>

/**
 * Open documents behind the session routes: hold = `openDocument(path,
 * {holder: sessionId})`, release = `releaseDocument`, session end =
 * `releaseDocumentHolder(sessionId)`. The holder is the session id only.
 */
export function runtimeDocumentHost(runtime: DocumentRuntime): ClientDocumentHost {
  return {
    async hold(sessionId, request) {
      const filePath = request.filePath ?? (request.agentId ? runtime.getAgentOrDocument(request.agentId)?.filePath ?? null : null)
      if (!filePath) {
        throw new ClientSessionError(request.agentId ? `Unknown agent "${request.agentId}"; hold it by its filePath` : 'filePath or agentId is required', request.agentId ? 404 : 400, request.agentId ? 'not_found' : 'bad_request')
      }
      const info = await runDocumentCall(() => runtime.openDocument(filePath, { holder: sessionId }))
      return { ...info }
    },
    async release(sessionId, agentId) {
      await runDocumentCall(() => runtime.releaseDocument(agentId, sessionId))
    },
    async releaseHolder(sessionId) {
      return runtime.releaseDocumentHolder(sessionId)
    },
  }
}

/** RuntimeService's refusals (RuntimeLoopError) as ClientSessionError, with their status and code. */
async function runDocumentCall<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (err) {
    const e = err as { statusCode?: unknown; code?: unknown; message?: unknown }
    if (typeof e?.statusCode === 'number') {
      throw new ClientSessionError(String(e.message), e.statusCode, typeof e.code === 'string' ? e.code : 'conflict')
    }
    throw err
  }
}

/**
 * Open documents for the registry: the runtime document host, and W2-A's
 * holder sweep asking the registry whether a holder is a live session, so a
 * live session's documents are never swept. Returns the unwire function.
 */
export function wireDocumentsToClientSessions(
  sessions: ClientSessionRegistry,
  runtime: DocumentRuntime & Pick<RuntimeService, 'setDocumentHolderCheck'>,
): () => void {
  sessions.setDocumentHost(runtimeDocumentHost(runtime))
  runtime.setDocumentHolderCheck((holder) => sessions.has(holder))
  return () => {
    runtime.setDocumentHolderCheck(null)
    sessions.setDocumentHost(null)
  }
}

// --- Producers ------------------------------------------------------------------

type Listener = (...args: any[]) => void

interface Emitter {
  on(event: string, listener: Listener): unknown
  off(event: string, listener: Listener): unknown
}

interface ManagerLike extends Emitter {
  getServerState?(name: string): { toolCount?: number } | null
}

/**
 * RuntimeService → executor, host and file frames, plus the per-agent
 * producers of a loaded agent (MCP and adapter status, adapter inbound,
 * workspace data, runtime config changes). Returns the unwire function.
 */
export function wireRuntimeToClientSessions(
  sessions: ClientSessionRegistry,
  runtime: Pick<RuntimeService, 'listAgents'> & Emitter,
): () => void {
  const attached = new Map<string, () => void>()
  for (const agent of runtime.listAgents()) sessions.indexAgent(agent.filePath, agent.id)

  const onEvent = (event: RuntimeAgentEvent) => sessions.publishExecutor(event)
  const onLifecycle = (event: RuntimeLifecycleEvent) => sessions.publishHost(event)
  const onRenamed = (event: RuntimeAgentFileRenamedEvent) => {
    sessions.publishPush('file_renamed', { oldPath: event.oldFilePath, newPath: event.filePath }, { agentId: event.agentId, filePath: event.filePath })
  }
  const onPathChanged = (event: RuntimeAgentPathChangedEvent) => {
    sessions.unindexAgent(event.oldFilePath, event.agentId)
    sessions.indexAgent(event.filePath, event.agentId)
    sessions.publishPush('agent_path_changed', { oldFilePath: event.oldFilePath, filePath: event.filePath }, { agentId: event.agentId, filePath: event.filePath })
    // The watcher announces the same move (W1-E); the registry sends it once.
    sessions.publishPush('file_renamed', { oldPath: event.oldFilePath, newPath: event.filePath }, { agentId: event.agentId, filePath: event.filePath })
  }
  const onLoaded = (event: RuntimeAgentLoadedEvent) => {
    sessions.indexAgent(event.filePath, event.agentId)
    attached.get(event.agentId)?.()
    attached.set(event.agentId, attachLoadedAgent(sessions, event))
  }
  const onUnloaded = (event: RuntimeAgentUnloadedEvent) => {
    sessions.unindexAgent(event.filePath, event.agentId)
    attached.get(event.agentId)?.()
    attached.delete(event.agentId)
  }

  runtime.on('agent-event', onEvent)
  runtime.on('agent-lifecycle', onLifecycle)
  runtime.on('agent-file-renamed', onRenamed)
  runtime.on('agent-path-changed', onPathChanged)
  runtime.on('agent-loaded', onLoaded)
  runtime.on('agent-unloaded', onUnloaded)
  return () => {
    runtime.off('agent-event', onEvent)
    runtime.off('agent-lifecycle', onLifecycle)
    runtime.off('agent-file-renamed', onRenamed)
    runtime.off('agent-path-changed', onPathChanged)
    runtime.off('agent-loaded', onLoaded)
    runtime.off('agent-unloaded', onUnloaded)
    for (const detach of attached.values()) detach()
    attached.clear()
  }
}

/** The parts of a loaded agent the per-agent producers read. */
interface LoadedAgentParts {
  workspace: {
    getInbox(status?: 'unread' | 'read' | 'archived'): InboxMessage[]
    setOnDataChangeCallback(callback: ((scope: WorkspaceDataScope) => void) | null): void
  }
  mcpManager?: ManagerLike | null
  adapterManager?: Emitter | null
}

function attachLoadedAgent(sessions: ClientSessionRegistry, event: RuntimeAgentLoadedEvent): () => void {
  const agentId = event.agentId
  const agent = event.agent as unknown as LoadedAgentParts
  const filePath = () => sessions.pathForAgent(agentId) ?? event.filePath
  const target = () => ({ agentId, filePath: filePath() })
  const undo: Array<() => void> = []

  const mcp = agent.mcpManager
  if (mcp) {
    const onStatus = (name: string, status: McpServerStatus, error?: string) => {
      sessions.publishPush('mcp_status', { name, status, error, toolCount: mcp.getServerState?.(name)?.toolCount }, target())
    }
    mcp.on('status-changed', onStatus)
    undo.push(() => mcp.off('status-changed', onStatus))
  }

  const adapters = agent.adapterManager
  if (adapters) {
    const onStatus = (type: string, status: AdapterStatus, error?: string) => {
      sessions.publishPush('adapter_status', { type, status, error }, target())
    }
    // The assembler's own listener (registered at assembly, before this one)
    // has written the message to the inbox by now.
    const onInbound = (type: string) => {
      // Nobody listens: skip the three inbox queries.
      if (sessions.size === 0) return
      const path = filePath()
      try {
        const messages = [...agent.workspace.getInbox('unread'), ...agent.workspace.getInbox('read'), ...agent.workspace.getInbox('archived')]
        publishInbox(sessions, messages, target())
      } catch (err) {
        console.error(`[ADF Daemon] Inbox read for the client stream failed (${path ?? agentId}):`, err)
      }
      if (path) {
        sessions.publishPush('mesh', { type: 'message_routed', payload: { filePath: `station:${type}`, toFilePaths: [path] }, timestamp: Date.now() }, target())
      }
    }
    adapters.on('status-changed', onStatus)
    adapters.on('inbound', onInbound)
    undo.push(() => {
      adapters.off('status-changed', onStatus)
      adapters.off('inbound', onInbound)
    })
  }

  undo.push(watchWorkspaceData(sessions, agent.workspace, target))
  undo.push(subscribeAgentRuntimeSignals(agent.workspace, {
    onConfigChanged: (config) => sessions.publishPush('config_changed', { filePath: filePath(), config }, target()),
  }))

  return () => { for (const fn of undo) fn() }
}

const workspaceWatchers = new WeakMap<object, symbol>()

/**
 * WORKSPACE_DATA_CHANGED for one workspace, coalesced per scope over 250 ms
 * as Studio does. The workspace has one data-change slot: the latest watcher
 * owns it, and an older watcher's detach leaves a newer one in place (an open
 * document taking over a stopped agent's workspace, W2-A).
 */
export function watchWorkspaceData(
  sessions: ClientSessionRegistry,
  workspace: Pick<LoadedAgentParts['workspace'], 'setOnDataChangeCallback'>,
  target: () => { agentId: string; filePath: string | null },
): () => void {
  const token = Symbol('client-stream')
  workspaceWatchers.set(workspace, token)
  const pending = new Map<string, ReturnType<typeof setTimeout>>()
  workspace.setOnDataChangeCallback((scope) => {
    if (pending.has(scope)) return
    const timer = setTimeout(() => {
      pending.delete(scope)
      sessions.publishPush('workspace_data', { scope }, target())
    }, 250)
    timer.unref?.()
    pending.set(scope, timer)
  })
  return () => {
    for (const timer of pending.values()) clearTimeout(timer)
    pending.clear()
    if (workspaceWatchers.get(workspace) !== token) return
    workspaceWatchers.delete(workspace)
    try { workspace.setOnDataChangeCallback(null) } catch { /* closed */ }
  }
}

/** The mesh's pushes: MESH_EVENT, mesh inbox deliveries, inter-agent messages and mesh-persisted config defaults. */
export function wireMeshToClientSessions(
  sessions: ClientSessionRegistry,
  mesh: Emitter & { setConfigPersistedListener?(listener: ((filePath: string, config: AgentConfig) => void) | null): void },
): () => void {
  const onMeshEvent = (event: MeshEvent) => {
    const filePath = typeof event.payload?.filePath === 'string' && !event.payload.filePath.startsWith('station:') ? event.payload.filePath : null
    sessions.publishPush('mesh', event, { filePath })
  }
  const onInbox = (data: { filePath: string; inbox: InboxMessage[] }) => {
    publishInbox(sessions, data.inbox, { filePath: data.filePath })
  }
  // Every delivery to a registered agent (mesh-manager `agent_incoming`):
  // the full message to sessions focused on the recipient, a stub to the rest.
  const onIncoming = (data: { filePath: string; fromAgent: string; toAgent: string; channel?: string; content: string }) => {
    const base = { fromAgent: data.fromAgent, toAgent: data.toAgent, ...(data.channel ? { channel: data.channel } : {}), direction: 'incoming' as const }
    sessions.publishPush('inter_agent_message', { ...base, content: data.content }, { filePath: data.filePath }, {
      unfocused: () => ({ ...base, size: data.content.length }),
    })
  }
  mesh.on('mesh_event', onMeshEvent)
  mesh.on('inbox_updated', onInbox)
  mesh.on('agent_incoming', onIncoming)
  mesh.setConfigPersistedListener?.((filePath, config) => sessions.publishPush('config_changed', { filePath, config }, { filePath }))
  return () => {
    mesh.off('mesh_event', onMeshEvent)
    mesh.off('inbox_updated', onInbox)
    mesh.off('agent_incoming', onIncoming)
    mesh.setConfigPersistedListener?.(null)
  }
}

/** COMPUTE_CONTAINER_PHASE and COMPUTE_BROWSER_SESSION from the compute service. */
export function wireComputeToClientSessions(sessions: ClientSessionRegistry, compute: Emitter): () => void {
  const onPhase = (event: ContainerPhaseEvent) => sessions.publishPush('compute_phase', event, { agentId: event.agentId ?? null })
  const onBrowser = (event: BrowserSessionEvent) => sessions.publishPush('browser_session', event, { agentId: event.agentId, filePath: event.agentFilePath })
  compute.on('container-phase', onPhase)
  compute.on('browser-session', onBrowser)
  return () => {
    compute.off('container-phase', onPhase)
    compute.off('browser-session', onBrowser)
  }
}

/** Umbilical envelopes for sessions opened with `umbilical: true` (the daemon's GET /events bus). */
export function wireEventBusToClientSessions(
  sessions: ClientSessionRegistry,
  bus: { subscribe(listener: (envelope: { event: UmbilicalEvent }) => void): () => void },
): () => void {
  return bus.subscribe((envelope) => sessions.publishUmbilical(envelope.event))
}

/** APPROVALS_CHANGED: every hub snapshot, as Studio sends it to every window. */
export function wireApprovalsToClientSessions(
  sessions: ClientSessionRegistry,
  hub: { subscribe(listener: (snapshot: NotificationsSnapshot) => void): () => void },
): () => void {
  return hub.subscribe((snapshot) => sessions.publishPush('approvals', snapshot))
}

/**
 * The tracked-folder watcher's pushes (W1-E, dir-watcher.ts), which also
 * carries the file routes' and RuntimeService's renames: `tracked_dirs`,
 * `file_renamed`, `autostart`, `autostart_overflow`. A rename that
 * wireRuntimeToClientSessions announced too is sent once.
 */
export function wireTrackedDirWatcherToClientSessions(
  sessions: ClientSessionRegistry,
  watcher: Pick<TrackedDirWatcher, 'on' | 'off'>,
): () => void {
  const onTracked = (push: { dirPath: string }) => sessions.publishPush('tracked_dirs', { dirPath: push.dirPath })
  const onRenamed = (push: { oldPath: string; newPath: string }) => {
    const agentId = sessions.agentIdForPath(push.newPath) ?? sessions.agentIdForPath(push.oldPath)
    sessions.publishPush('file_renamed', { oldPath: push.oldPath, newPath: push.newPath }, { agentId, filePath: push.newPath })
  }
  const onAutostart = (notice: WatcherAutostartNotice) => {
    sessions.publishPush('autostart', notice, { agentId: 'agentId' in notice ? notice.agentId ?? null : null, filePath: notice.filePath })
  }
  const onOverflow = (notice: { dropped: number; queueLimit: number }) => sessions.publishPush('autostart_overflow', notice)
  watcher.on('tracked_dirs', onTracked)
  watcher.on('file_renamed', onRenamed)
  watcher.on('autostart', onAutostart)
  watcher.on('autostart_overflow', onOverflow)
  return () => {
    watcher.off('tracked_dirs', onTracked)
    watcher.off('file_renamed', onRenamed)
    watcher.off('autostart', onAutostart)
    watcher.off('autostart_overflow', onOverflow)
  }
}

// --- Install progress --------------------------------------------------------------

type InstallTopic = 'mcp_install' | 'adapter_install' | 'sandbox_install'

/**
 * A package service whose `install` also reports progress on the client
 * stream, as Studio's install handlers do: `installing` per progress line,
 * then `installed` or `error`. `progressArg` is the index of the install
 * call's progress callback (1 for npm and adapters, 2 for Python and
 * sandbox packages). Every other member is the service's own.
 */
export function withInstallProgress<S extends { install(...args: any[]): Promise<unknown> }>(
  service: S,
  topic: InstallTopic,
  progressArg: number,
  sessions: ClientSessionRegistry,
): S {
  const install = async (...args: unknown[]): Promise<unknown> => {
    const pkg = String(args[0])
    const own = args[progressArg] as ((message: string) => void) | undefined
    const callArgs = [...args]
    while (callArgs.length <= progressArg) callArgs.push(undefined)
    callArgs[progressArg] = (message: string) => {
      sessions.publishPush(topic, { package: pkg, status: 'installing', progress: message })
      own?.(message)
    }
    try {
      const result = await service.install(...callArgs)
      sessions.publishPush(topic, { package: pkg, status: 'installed' })
      return result
    } catch (error) {
      sessions.publishPush(topic, { package: pkg, status: 'error', error: String(error) })
      throw error
    }
  }
  return new Proxy(service, {
    get(target, prop, receiver) {
      if (prop === 'install') return install
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
