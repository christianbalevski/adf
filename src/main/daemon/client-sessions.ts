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
//   epoch, gets `stream.gap` too.
// - A session expires CLIENT_SESSION_EXPIRY_MS after its stream disconnects
//   (or after creation, if it never connects). Expiry releases its documents
//   through the ClientDocumentHost and tells onSessionEnded listeners. An
//   expired `exitDaemonWhenClosed` session stops the daemon when no other
//   session exists and Studio started this daemon run (§8.3); the decision and
//   its reason are logged either way.
//
// tool_call_result: the focused agent's frames carry the full payload, as
// embedded IPC does (the executor already caps tool output). Other agents'
// results carry `result: { isError }` and `resultSize` instead of the content,
// and the frame says `stripped: 'tool_result'`: that is all
// BACKGROUND_AGENT_EVENT_BATCH reads (ipc/background-event-batch.ts
// stripForRenderer), and it keeps a busy fleet from filling the rings with
// tool output no client shows.

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
import { safeJsonStringify, sseControl, sseFrame } from './sse-wire'

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
 * made it (origin dedup, beginOrigin), as embedded Studio never echoes its
 * own edits to its window. Every other session gets them.
 */
const ECHO_EXECUTOR_TYPES: ReadonlySet<string> = new Set(['file_updated', 'document_updated'])

// --- Frames -------------------------------------------------------------------

export interface ClientExecutorFrame {
  kind: 'executor'
  cursor: number
  agentId: string
  filePath: string | null
  /** `event.loop`, copied for routing; absent = main. */
  loop?: string
  event: AgentExecutionEvent
  /** Set when the payload was reduced for a session not focused on this agent (see the file header). */
  stripped?: 'tool_result'
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
  /** INBOX_UPDATED: mesh delivery, adapter inbound, DELETE /agents/:id/inbox (empty). */
  inbox: { inbox: { version: 1; messages: InboxMessage[] } }
  /** WORKSPACE_DATA_CHANGED, coalesced per agent and scope (250 ms, as Studio). */
  workspace_data: { scope: WorkspaceDataScope }
  /** APPROVALS_CHANGED: the hub's full snapshot (not a delta; the hub coalesces). */
  approvals: NotificationsSnapshot
  /** MESH_EVENT, including the `station:<adapter>` message_routed pulse on adapter inbound. */
  mesh: MeshEvent
  /** AGENT_EVENT `inter_agent_message` payload, for the client to synthesize on its focused agent. */
  inter_agent_message: { fromAgent: string; toAgent: string; channel?: string; content: string; direction: 'incoming' }
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
  'sandbox_install', 'mcp_status', 'adapter_status', 'compute_phase', 'browser_session',
]

export type ClientPushFrame = {
  [T in ClientPushTopic]: {
    kind: 'push'
    cursor: number
    topic: T
    agentId: string | null
    filePath: string | null
    payload: ClientPushPayloads[T]
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
}

export type ClientFrame = ClientExecutorFrame | ClientHostFrame | ClientPushFrame | ClientUmbilicalFrame

/** `stream.gap` data. `epoch_changed`: the cursor came from another session; `evicted`: frames after it were dropped. */
export interface ClientStreamGap {
  reason: 'evicted' | 'epoch_changed'
  epoch: string
  /** The last cursor the client had. */
  requestedCursor: number | null
  oldestCursor: number | null
  latestCursor: number
  /** Frames lost (evicted only). */
  dropped?: number
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
 * `hold` MUST be idempotent per session and agent. The registry calls
 * `release` for every held document when a session ends (DELETE or expiry).
 */
export interface ClientDocumentHost {
  hold(sessionId: string, request: ClientDocumentHoldRequest): Promise<ClientHeldDocument>
  release(sessionId: string, agentId: string): Promise<void> | void
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
  body: string
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
    this.chars += entry.body.length
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
    if (entry) this.chars -= entry.body.length
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

  append(name: string, body: string): void {
    this.ring.push({ cursor: this.nextCursor++, name, body })
  }
}

export interface ClientSessionRegistryOptions {
  ringFrames?: number
  ringChars?: number
  expiryMs?: number
  /** Who launched this daemon run (GET /version `startedBy`). The orphan rule only stops a daemon Studio started. */
  startedBy?: string
  /** The daemon's bounded graceful shutdown (POST /daemon/shutdown). */
  requestShutdown?: () => void
  /** Open documents (W2-A). Default: only loaded agents can be held (loadedAgentDocumentHost). */
  documents?: ClientDocumentHost | null
  /** An agent id, handle or name → the loaded agent's id; null when not loaded. */
  resolveAgentId?: (identifier: string) => string | null
  log?: (message: string) => void
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
  private readonly expiryMs: number
  private readonly log: (message: string) => void
  private readonly endedListeners = new Set<(ended: ClientSessionEnded) => void>()
  /** agentId → sessions with a config write in flight (origin dedup of config_changed). */
  private readonly origins = new Map<string, Map<string, number>>()
  /** Loaded agents by path key, for producers that only know the path (mesh). */
  private readonly agentsByPath = new Map<string, string>()
  private readonly pathsByAgent = new Map<string, string>()
  private readonly recentRenames = new Map<string, number>()
  private documentHost: ClientDocumentHost | null
  private disposed = false

  constructor(private readonly options: ClientSessionRegistryOptions = {}) {
    this.ringFrames = options.ringFrames ?? CLIENT_RING_FRAMES
    this.ringChars = options.ringChars ?? CLIENT_RING_CHARS
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
    return { sessionId: session.id, epoch: session.epoch }
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  get size(): number {
    return this.sessions.size
  }

  /** End a session now (DELETE /client/sessions/:id): its documents are released; the orphan rule does not apply. */
  async end(sessionId: string): Promise<void> {
    const session = this.require(sessionId)
    await this.finish(session, 'ended')
  }

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
   * start); `epoch`: the epoch it came from.
   */
  attach(sessionId: string, sink: ClientStreamSink, resume: { since?: number; epoch?: string } = {}): void {
    const session = this.require(sessionId)
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

  publishExecutor(event: RuntimeAgentEvent): void {
    if (this.sessions.size === 0) return
    const type = event.event.type
    const isDelta = DELTA_EVENT_TYPES.has(type)
    const isResult = type === 'tool_call_result'
    // The writer's own edit is not echoed back to it (Studio skips its own file and document writes).
    const skip = ECHO_EXECUTOR_TYPES.has(type) ? this.origins.get(event.agentId) : undefined
    let full: string | undefined
    let stripped: string | undefined
    for (const session of this.sessions.values()) {
      const focused = session.focus !== null && session.focus === event.agentId
      if (isDelta && !focused) continue
      if (skip?.has(session.id)) continue
      const body = isResult && !focused
        ? stripped ??= safeJsonStringify(executorFrame(event, true))
        : full ??= safeJsonStringify(executorFrame(event, false))
      this.append(session, 'executor', body)
    }
  }

  /** An umbilical envelope, for the sessions that asked for them; never `turn.delta`. */
  publishUmbilical(event: UmbilicalEvent): void {
    if (this.sessions.size === 0 || event.event_type === 'turn.delta') return
    let body: string | undefined
    for (const session of this.sessions.values()) {
      if (!session.umbilical) continue
      body ??= safeJsonStringify({ kind: 'umbilical', agentId: event.agent_id ?? null, event })
      this.append(session, 'umbilical', body)
    }
  }

  publishHost(event: RuntimeLifecycleEvent): void {
    if (this.sessions.size === 0) return
    const body = safeJsonStringify({
      kind: 'host', agentId: event.agentId, filePath: event.filePath, type: event.type, payload: event.payload, timestamp: event.timestamp,
    })
    for (const session of this.sessions.values()) this.append(session, 'host', body)
  }

  publishPush<T extends ClientPushTopic>(
    topic: T,
    payload: ClientPushPayloads[T],
    target: { agentId?: string | null; filePath?: string | null } = {},
  ): void {
    if (this.sessions.size === 0) return
    const agentId = target.agentId ?? (target.filePath ? this.agentIdForPath(target.filePath) : null)
    const filePath = target.filePath ?? null
    if (topic === 'file_renamed' && this.isRepeatedRename(payload as ClientPushPayloads['file_renamed'])) return
    // A session's own config write is not echoed back to it (Studio's notifyHost: false).
    const skip = topic === 'config_changed' && agentId ? this.origins.get(agentId) : undefined
    let body: string | undefined
    for (const session of this.sessions.values()) {
      if (skip?.has(session.id)) continue
      body ??= safeJsonStringify({ kind: 'push', topic, agentId, filePath, payload })
      this.append(session, 'push', body)
    }
  }

  // --- origin dedup -----------------------------------------------------------

  /**
   * A session's write for `agentId` is in flight: config_changed, file_updated
   * and document_updated raised meanwhile skip that session. Returns the end
   * of the write.
   */
  beginOrigin(sessionId: string, agentId: string): () => void {
    let bySession = this.origins.get(agentId)
    if (!bySession) this.origins.set(agentId, bySession = new Map())
    bySession.set(sessionId, (bySession.get(sessionId) ?? 0) + 1)
    let done = false
    return () => {
      if (done) return
      done = true
      const current = this.origins.get(agentId)
      const count = (current?.get(sessionId) ?? 1) - 1
      if (count > 0) current!.set(sessionId, count)
      else current?.delete(sessionId)
      if (current?.size === 0) this.origins.delete(agentId)
    }
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

  private require(sessionId: string): ClientSession {
    const session = this.sessions.get(sessionId)
    if (!session) throw new ClientSessionError(`No client session ${sessionId} (it ended or expired, or the daemon restarted).`, 404, 'session_not_found')
    return session
  }

  private append(session: ClientSession, name: string, body: string): void {
    session.append(name, body)
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
    for (const [agentId, bySession] of this.origins) {
      bySession.delete(session.id)
      if (bySession.size === 0) this.origins.delete(agentId)
    }
    const documents = [...session.documents.keys()]
    session.documents.clear()
    for (const agentId of documents) await this.releaseQuietly(session.id, agentId)
    this.log(`Client session ${session.id} (${session.client}) ${reason === 'expired' ? `expired ${Math.round(this.expiryMs / 1000)} s after its stream closed` : 'ended'}${documents.length ? `; released ${documents.length} document(s)` : ''}`)
    this.notifyEnded(session, reason, documents)
    if (reason === 'expired' && session.exitDaemonWhenClosed) this.applyOrphanRule(session)
  }

  /** §8.3: an expired exitDaemonWhenClosed session stops a Studio-started daemon when nobody else is connected. */
  private applyOrphanRule(session: ClientSession): void {
    const why = `client session ${session.id} (${session.client}) expired and asked to stop the daemon when closed`
    if (this.sessions.size > 0) {
      this.log(`Not stopping the daemon: ${why}, but ${this.sessions.size} other client session(s) are open`)
      return
    }
    if (this.options.startedBy !== 'studio') {
      this.log(`Not stopping the daemon: ${why}, but this daemon run was started by ${this.options.startedBy ?? 'an unknown launcher'}, not Studio`)
      return
    }
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

function executorFrame(event: RuntimeAgentEvent, strip: boolean): Omit<ClientExecutorFrame, 'cursor'> {
  const loop = event.event.loop
  const base = { kind: 'executor' as const, agentId: event.agentId, filePath: event.filePath, ...(loop !== undefined ? { loop } : {}) }
  if (!strip) return { ...base, event: event.event }
  const payload = (event.event.payload ?? {}) as Record<string, unknown> & { result?: { content?: unknown; isError?: unknown } }
  const content = payload.result?.content
  const { result: _result, ...rest } = payload
  return {
    ...base,
    stripped: 'tool_result',
    event: { ...event.event, payload: { ...rest, result: { isError: !!payload.result?.isError }, resultSize: typeof content === 'string' ? content.length : 0 } },
  }
}

// --- Default document host --------------------------------------------------------

/**
 * Until open documents exist (W2-A), a session can hold only an agent that
 * is loaded (running); holding it pins nothing.
 */
export function loadedAgentDocumentHost(runtime: Pick<RuntimeService, 'listAgents'>): ClientDocumentHost {
  return {
    async hold(_sessionId, request) {
      const agents = runtime.listAgents()
      const match = request.agentId
        ? agents.find((agent) => agent.id === request.agentId)
        : request.filePath
          ? agents.find((agent) => agent.filePath && pathKey(agent.filePath) === pathKey(request.filePath!))
          : undefined
      if (!request.agentId && !request.filePath) throw new ClientSessionError('filePath or agentId is required', 400, 'bad_request')
      if (!match) {
        throw new ClientSessionError(`${request.filePath ?? request.agentId} is not running; this daemon can hold only running agents until open documents are available.`, 409, 'document_unavailable')
      }
      return { agentId: match.id, filePath: match.filePath, running: true }
    },
    release() {},
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
      const path = filePath()
      try {
        const messages = [...agent.workspace.getInbox('unread'), ...agent.workspace.getInbox('read'), ...agent.workspace.getInbox('archived')]
        sessions.publishPush('inbox', { inbox: { version: 1, messages } }, target())
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
    sessions.publishPush('inbox', { inbox: { version: 1, messages: data.inbox } }, { filePath: data.filePath })
  }
  const onIncoming = (data: { filePath: string; fromAgent: string; toAgent: string; channel?: string; content: string }) => {
    sessions.publishPush('inter_agent_message', {
      fromAgent: data.fromAgent, toAgent: data.toAgent, channel: data.channel, content: data.content, direction: 'incoming',
    }, { filePath: data.filePath })
  }
  mesh.on('mesh_event', onMeshEvent)
  mesh.on('inbox_updated', onInbox)
  mesh.on('foreground_incoming', onIncoming)
  mesh.setConfigPersistedListener?.((filePath, config) => sessions.publishPush('config_changed', { filePath, config }, { filePath }))
  return () => {
    mesh.off('mesh_event', onMeshEvent)
    mesh.off('inbox_updated', onInbox)
    mesh.off('foreground_incoming', onIncoming)
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
