/**
 * WebSocket Connection Manager
 *
 * Manages all WebSocket connections (inbound + outbound) for all agents in the runtime.
 * This is runtime state — nothing persisted to SQLite.
 *
 * Responsibilities:
 * - Outbound connections: connect, authenticate, keepalive, reconnect
 * - Inbound connections: accept upgrade, authenticate, wire to lambda
 * - Frame dispatch: hot-path (lambda) and cold-path (ingress pipeline)
 * - Connection registry: track all connections by agent
 */

import WebSocket from 'ws'
import { randomBytes } from 'crypto'
import { nanoid } from 'nanoid'
import type {
  WsConnectionConfig,
  WsLambdaEvent,
  WsConnectionInfo,
  AlfMessage,
  ServingApiRoute
} from '../../shared/types/adf-v02.types'
import type { AdfWorkspace } from '../adf/adf-workspace'
import type { CodeSandboxService } from '../runtime/code-sandbox'
import type { AdfCallHandler } from '../runtime/adf-call-handler'
import {
  signEd25519,
  verifyEd25519,
  didToPublicKey,
  rawPublicKeyToSpki
} from '../crypto/identity-crypto'
import { withSource } from '../runtime/execution-context'
import { emitUmbilicalEvent } from '../runtime/emit-umbilical'
import { withAuthorization } from '../runtime/authorization-context'
import { loadLambdaSource } from '../runtime/ts-transpiler'

// =============================================================================
// Delegate Interface
// =============================================================================

export interface WsManagerDelegate {
  getAgentDid(agentFilePath: string): string | null
  getPrivateKey(agentFilePath: string): Buffer | null
  getPublicKey(did: string): Buffer | null
  processIngressMessage(
    agentFilePath: string,
    message: AlfMessage,
    /** Transport-verified identity — stamped into meta by the ingress path, never read from the wire. */
    transport?: { identityVerified?: boolean; remoteDid?: string }
  ): Promise<{ messageId?: string; error?: string }>
  getCodeSandbox(agentFilePath: string): CodeSandboxService | null
  getAdfCallHandler(agentFilePath: string): AdfCallHandler | null
  getWorkspace(agentFilePath: string): AdfWorkspace | null
  getToolConfig(agentFilePath: string): { enabledTools: string[]; hilTools: string[] } | null
  getAllowUnsigned(agentFilePath: string): boolean
}

// =============================================================================
// Internal Types
// =============================================================================

interface ManagedConnection {
  id: string
  agentFilePath: string
  /**
   * Agent id captured at connect time. Used to attribute umbilical lifecycle
   * events (ws.opened/ws.closed) to the owning agent. Captured up front because
   * the live `getWorkspace()` lookup returns null once the agent is torn down
   * (mesh disable / agent stop), and the `close` event commonly fires *during*
   * that teardown — re-deriving it then yields undefined and the event silently
   * misses the per-agent tap bus.
   */
  agentId?: string
  socket: WebSocket
  direction: 'inbound' | 'outbound'
  remoteDid?: string
  authenticated: boolean
  configId?: string
  lambdaRef?: string
  keepaliveTimer?: ReturnType<typeof setInterval>
  keepaliveIntervalMs: number
  pongReceived: boolean
  /**
   * Armed on every keepalive tick right after `ping()`; fires if no pong lands
   * within PONG_TIMEOUT_MS. Tracked (rather than fire-and-forget) so
   * `clearTimers` can cancel it — an untracked timer keeps the event loop alive
   * and can close a connection that has already been torn down and re-created.
   */
  pongTimer?: ReturnType<typeof setTimeout>
  /** Guards the CONNECTING phase; cleared on `open`. See connectOutbound. */
  connectTimer?: ReturnType<typeof setTimeout>
  reconnectAttempts: number
  connectedAt: number
  lastMessageAt: number
  closed: boolean
  identityVerified: boolean
  authTimeout?: ReturnType<typeof setTimeout>
  highWaterMarkBytes: number
  urlParams?: Record<string, string>
  headers?: Record<string, string>
}

const DEFAULT_HIGH_WATER_MARK_BYTES = 1048576 // 1 MiB

interface AgentWsState {
  configs: WsConnectionConfig[]
}

/**
 * Per-(agentFilePath, config.id) reconnect bookkeeping. Held at manager level
 * rather than on ManagedConnection because a reconnect timer outlives the
 * connection that triggered it — the old connection object is already gone from
 * the registry by the time the timer fires.
 */
interface ReconnectState {
  timer: ReturnType<typeof setTimeout>
  attempt: number
}

export interface WsRawBindingHandle {
  connectionId: string
  agentFilePath: string
  direction: 'inbound' | 'outbound'
  remoteDid?: string
  write(data: Buffer | Uint8Array | string): Promise<void>
  close(code?: number, reason?: string): void
  detach(): void
  /**
   * Stop/restart delivery of inbound frames. `ws` forwards this to the net
   * socket it wraps, so once paused the kernel receive window closes and the
   * peer feels real backpressure. A noop while CONNECTING or CLOSED.
   */
  pause(): void
  resume(): void
}

export interface WsRawBindingCallbacks {
  onData(data: Buffer): void | Promise<void>
  onClose(reason: string): void | Promise<void>
  onError(error: Error): void | Promise<void>
}

// Auth message types
interface AuthMessage {
  type: 'auth'
  did: string
  nonce: string
  signature: string
  timestamp: number
}

interface AuthResultMessage {
  type: 'auth_result'
  success: boolean
  server_did?: string
  nonce?: string
  signature?: string
  error?: string
}

const AUTH_TIMEOUT_MS = 30_000
const DEFAULT_KEEPALIVE_MS = 30_000
const DEFAULT_RECONNECT_DELAY_MS = 5_000
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000
const PONG_TIMEOUT_MS = 10_000
const MAX_RECONNECT_ATTEMPTS = 5
/**
 * TTL for the transpiled-lambda cache. The workspace file-change callback is a
 * single sink already owned by the assembled runtime (see
 * AdfWorkspace.setOnFileChangeCallback), so hooking it here would clobber that
 * owner; a short TTL bounds staleness after an edit without that coupling.
 */
const LAMBDA_SOURCE_TTL_MS = 5_000

// =============================================================================
// WsConnectionManager
// =============================================================================

export class WsConnectionManager {
  private connections = new Map<string, ManagedConnection>()
  private agentConnections = new Map<string, Set<string>>()
  private agentState = new Map<string, AgentWsState>()
  private streamBoundConnections = new Set<string>()
  /** key = reconnectKey(agentFilePath, configId) → at most one pending timer. */
  private reconnectStates = new Map<string, ReconnectState>()
  /** key = `${agentFilePath}\u0000${lambdaFilePath}` → transpiled source + expiry. */
  private lambdaSourceCache = new Map<string, { code: string; expiresAt: number }>()
  private delegate: WsManagerDelegate

  constructor(delegate: WsManagerDelegate) {
    this.delegate = delegate
  }

  private log(agentFilePath: string, level: string, event: string, target: string | null, message: string, data?: unknown): void {
    try {
      const workspace = this.delegate.getWorkspace(agentFilePath)
      if (workspace) {
        workspace.insertLog(level, 'websocket', event, target, message, data)
      }
    } catch (err) {
      console.error(`[WS] Failed to write log:`, err)
    }
  }

  // ===========================================================================
  // Agent Lifecycle
  // ===========================================================================

  registerAgent(agentFilePath: string, configs: WsConnectionConfig[]): void {
    this.agentState.set(agentFilePath, { configs })
    if (!this.agentConnections.has(agentFilePath)) {
      this.agentConnections.set(agentFilePath, new Set())
    }

    // Skip outbound connections if agent already has active connections (e.g. foreground→background transition)
    const existing = this.agentConnections.get(agentFilePath)
    if (existing && existing.size > 0) return

    for (const config of configs) {
      if (config.enabled) {
        this.connectOutbound(agentFilePath, config).catch(err => {
          console.error(`[WS] Failed to connect outbound ${config.id} for ${agentFilePath}:`, err)
        })
      }
    }
  }

  /**
   * Add or replace a runtime WS connection config for an already-registered
   * agent, so a later `ws_connect { id }` (and reconnect-by-id) can resolve it.
   * No-op when the agent is not registered.
   */
  upsertConfig(agentFilePath: string, config: WsConnectionConfig): void {
    const state = this.agentState.get(agentFilePath)
    if (!state) return
    const idx = state.configs.findIndex(c => c.id === config.id)
    if (idx >= 0) state.configs[idx] = config
    else state.configs.push(config)
  }

  unregisterAgent(agentFilePath: string): void {
    // Cancel pending reconnects first — otherwise a timer that fires between
    // the closes below and the agentState delete would re-open a connection.
    this.clearAllReconnectStates(agentFilePath)

    const connIds = this.agentConnections.get(agentFilePath)
    if (connIds) {
      for (const connId of connIds) {
        this.closeConnection(connId, 1001, 'Going Away')
      }
    }
    this.agentConnections.delete(agentFilePath)
    this.agentState.delete(agentFilePath)

    // Drop cached lambda sources owned by this agent
    const prefix = `${agentFilePath}\u0000`
    for (const key of this.lambdaSourceCache.keys()) {
      if (key.startsWith(prefix)) this.lambdaSourceCache.delete(key)
    }

    // Destroy warm sandbox
    const sandbox = this.delegate.getCodeSandbox(agentFilePath)
    if (sandbox) {
      sandbox.destroy(`${agentFilePath}:ws`)
    }
  }

  // ===========================================================================
  // Outbound Connections
  // ===========================================================================

  async connectOutbound(
    agentFilePath: string,
    configOrId: string | WsConnectionConfig,
    inheritedAttempts?: number
  ): Promise<{ connection_id?: string; error?: string }> {
    let config: WsConnectionConfig
    if (typeof configOrId === 'string') {
      const state = this.agentState.get(agentFilePath)
      const found = state?.configs.find(c => c.id === configOrId)
      if (!found) return { error: `No WS connection config with id "${configOrId}"` }
      config = found
    } else {
      config = configOrId
    }

    const connectionId = nanoid(10)

    return new Promise<{ connection_id?: string; error?: string }>((resolve) => {
      let resolved = false

      const socket = new WebSocket(config.url)
      const conn: ManagedConnection = {
        id: connectionId,
        agentFilePath,
        agentId: this.delegate.getWorkspace(agentFilePath)?.getAgentConfig().id,
        socket,
        direction: 'outbound',
        authenticated: false,
        configId: config.id,
        lambdaRef: config.lambda,
        keepaliveIntervalMs: config.keepalive_interval_ms ?? DEFAULT_KEEPALIVE_MS,
        pongReceived: true,
        reconnectAttempts: inheritedAttempts ?? 0,
        connectedAt: 0,
        lastMessageAt: 0,
        closed: false,
        identityVerified: false,
        highWaterMarkBytes: config.high_water_mark_bytes ?? DEFAULT_HIGH_WATER_MARK_BYTES
      }

      this.connections.set(connectionId, conn)
      this.addAgentConnection(agentFilePath, connectionId)

      // A socket wedged in CONNECTING (SYN blackhole, TLS stall, unresponsive
      // proxy) emits neither 'open' nor 'close', so without this the returned
      // promise never settles and the entry leaks in `connections`.
      const connectTimeoutMs = config.connect_timeout_ms ?? DEFAULT_CONNECT_TIMEOUT_MS
      conn.connectTimer = setTimeout(() => {
        conn.connectTimer = undefined
        if (conn.closed || socket.readyState !== WebSocket.CONNECTING) return

        conn.closed = true
        this.clearTimers(conn)
        this.log(agentFilePath, 'warn', 'ws_connect', config.id,
          `Outbound ${connectionId} connect timeout after ${connectTimeoutMs}ms (${config.url})`)

        // terminate + removeAllListeners: skip the close handshake (the peer is
        // not answering) and make sure the 'close'/'error' handlers below cannot
        // fire into already-removed state or schedule a second reconnect.
        try { socket.terminate() } catch { /* best-effort */ }
        try { socket.removeAllListeners() } catch { /* best-effort */ }
        this.removeConnection(connectionId)

        if (!resolved) { resolved = true; resolve({ error: `Connect timeout after ${connectTimeoutMs}ms` }) }

        if (config.auto_reconnect !== false) {
          this.scheduleReconnect(agentFilePath, config, conn.reconnectAttempts)
        }
      }, connectTimeoutMs)

      socket.on('open', async () => {
        if (conn.connectTimer) { clearTimeout(conn.connectTimer); conn.connectTimer = undefined }
        conn.connectedAt = Date.now()

        const authMode = config.auth ?? 'auto'
        const privateKey = this.delegate.getPrivateKey(agentFilePath)

        // 'required' -> always auth (fail if no key)
        // 'none' -> never auth
        // 'auto' -> auth if privateKey is available (regardless of allow_unsigned)
        const shouldAuth = authMode === 'required'
          || (authMode === 'auto' && privateKey != null)

        if (shouldAuth) {
          if (!privateKey) {
            this.log(agentFilePath, 'error', 'ws_auth', config.id,
              `Auth required but no private key for outbound ${connectionId}`)
            if (!resolved) { resolved = true; resolve({ error: 'Auth required but no private key' }) }
            this.closeConnection(connectionId, 4001, 'No private key')
            return
          }
          try {
            await this.runClientAuth(conn, config.did)
            conn.reconnectAttempts = 0
            this.log(agentFilePath, 'info', 'ws_auth', config.id, `Authenticated outbound ${connectionId} → ${conn.remoteDid ?? config.url}`)
          } catch (err) {
            this.log(agentFilePath, 'error', 'ws_auth', config.id, `Auth failed for outbound ${connectionId}: ${err}`)
            if (!resolved) { resolved = true; resolve({ error: `Auth failed: ${err}` }) }
            this.closeConnection(connectionId, 4001, 'Auth failed')
            return
          }
        } else {
          conn.authenticated = true
          conn.reconnectAttempts = 0
        }

        // Connected (and authenticated, if required) — retire the reconnect
        // ladder for this config so the next failure starts at attempt 1.
        this.clearReconnectState(agentFilePath, config.id)

        this.startKeepalive(conn)
        this.log(agentFilePath, 'info', 'ws_connect', config.id, `Outbound ${connectionId} connected to ${config.url}`, { remote_did: conn.remoteDid })
        this.dispatchToLambda(conn, { type: 'open', connection_id: connectionId, remote_did: conn.remoteDid, timestamp: Date.now() })

        if (!resolved) { resolved = true; resolve({ connection_id: connectionId }) }
      })

      socket.on('message', (data: Buffer | string, isBinary?: boolean) => {
        conn.lastMessageAt = Date.now()

        // Auth messages are handled in runClientAuth/runServerAuth
        if (!conn.authenticated) {
          // Auth in progress — messages handled by auth flow
          return
        }
        if (this.streamBoundConnections.has(conn.id)) return

        const binary = isBinary === true || (typeof data !== 'string' && isBinary !== false)
        // Note: the `ws` library passes Buffer for both text and binary by default.
        // isBinary (WS v8+) disambiguates. When absent, fall back to Buffer-means-binary heuristic.

        if (binary) {
          if (conn.lambdaRef) {
            const bytes = typeof data === 'string' ? Buffer.from(data) : data
            this.dispatchToLambda(conn, {
              type: 'message',
              connection_id: connectionId,
              remote_did: conn.remoteDid,
              data: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
              binary: true,
              timestamp: Date.now()
            })
          } else {
            const size = typeof data === 'string' ? data.length : data.byteLength
            this.log(conn.agentFilePath, 'warn', 'ws_binary_drop', conn.configId ?? null,
              `Dropping binary frame on cold-path connection ${connectionId} (${size} bytes)`)
          }
          return
        }

        const text = typeof data === 'string' ? data : data.toString('utf-8')

        if (conn.lambdaRef) {
          // Hot path
          this.dispatchToLambda(conn, {
            type: 'message',
            connection_id: connectionId,
            remote_did: conn.remoteDid,
            data: text,
            binary: false,
            timestamp: Date.now()
          })
        } else {
          // Cold path — parse as ALF message
          this.handleColdPathMessage(conn, text)
        }
      })

      socket.on('close', (code: number, reason: Buffer) => {
        const reasonStr = reason.toString('utf-8')
        conn.closed = true
        this.clearTimers(conn)

        const durationMs = conn.connectedAt ? Date.now() - conn.connectedAt : 0
        this.log(agentFilePath, code === 1000 || code === 1001 ? 'info' : 'warn', 'ws_close', config.id,
          `Outbound ${connectionId} closed (${code}: ${reasonStr || 'no reason'}, up ${durationMs}ms)`)

        this.dispatchToLambda(conn, {
          type: 'close',
          connection_id: connectionId,
          remote_did: conn.remoteDid,
          code,
          reason: reasonStr,
          timestamp: Date.now()
        })

        this.removeConnection(connectionId)

        if (!resolved) { resolved = true; resolve({ error: `Connection closed: ${code} ${reasonStr}` }) }

        // Schedule reconnect for unexpected close
        if (code !== 1000 && code !== 1001 && config.auto_reconnect !== false) {
          this.scheduleReconnect(agentFilePath, config, conn.reconnectAttempts)
        }
      })

      socket.on('error', (err: Error) => {
        this.log(agentFilePath, 'error', 'ws_error', config.id, `Outbound ${connectionId} error: ${err.message}`)

        this.dispatchToLambda(conn, {
          type: 'error',
          connection_id: connectionId,
          remote_did: conn.remoteDid,
          error: err.message,
          timestamp: Date.now()
        })

        if (!resolved) { resolved = true; resolve({ error: err.message }) }
      })

      socket.on('pong', () => this.handlePong(conn))
    })
  }

  /** Pong landed — mark alive and disarm the pending pong-timeout timer. */
  private handlePong(conn: ManagedConnection): void {
    conn.pongReceived = true
    if (conn.pongTimer) { clearTimeout(conn.pongTimer); conn.pongTimer = undefined }
  }

  // ===========================================================================
  // Inbound Connections
  // ===========================================================================

  handleInboundUpgrade(
    agentFilePath: string,
    socket: WebSocket,
    route: ServingApiRoute,
    requestMeta?: { url_params?: Record<string, string>; headers?: Record<string, string> }
  ): void {
    const connectionId = nanoid(10)
    const conn: ManagedConnection = {
      id: connectionId,
      agentFilePath,
      agentId: this.delegate.getWorkspace(agentFilePath)?.getAgentConfig().id,
      socket,
      direction: 'inbound',
      authenticated: false,
      lambdaRef: route.lambda,
      keepaliveIntervalMs: DEFAULT_KEEPALIVE_MS,
      pongReceived: true,
      reconnectAttempts: 0,
      connectedAt: Date.now(),
      lastMessageAt: 0,
      closed: false,
      identityVerified: false,
      highWaterMarkBytes: route.high_water_mark_bytes ?? DEFAULT_HIGH_WATER_MARK_BYTES,
      urlParams: requestMeta?.url_params,
      headers: requestMeta?.headers
    }

    this.connections.set(connectionId, conn)
    this.addAgentConnection(agentFilePath, connectionId)

    // The pre-auth 'message' listener, tracked here so the close handler and the
    // auth-timeout path (both declared/armed below) can detach it. Without this
    // it was only removed on the success path and leaked on every socket that
    // connected but never authenticated.
    let pendingAuthHandler: ((data: Buffer | string) => void) | null = null
    const detachAuthHandler = (): void => {
      if (!pendingAuthHandler) return
      socket.removeListener('message', pendingAuthHandler)
      pendingAuthHandler = null
    }

    // Register close/error/pong handlers immediately so they're active during auth
    socket.on('close', (code: number, reason: Buffer) => {
      const reasonStr = reason.toString('utf-8')
      conn.closed = true
      this.clearTimers(conn)
      detachAuthHandler()

      const durationMs = conn.connectedAt ? Date.now() - conn.connectedAt : 0
      this.log(agentFilePath, code === 1000 || code === 1001 ? 'info' : 'warn', 'ws_close', null,
        `Inbound ${conn.id} closed (${code}: ${reasonStr || 'no reason'}, up ${durationMs}ms)`)

      this.dispatchToLambda(conn, {
        type: 'close',
        connection_id: conn.id,
        remote_did: conn.remoteDid,
        code,
        reason: reasonStr,
        timestamp: Date.now()
      })

      this.removeConnection(conn.id)
    })

    socket.on('error', (err: Error) => {
      this.log(agentFilePath, 'error', 'ws_error', null, `Inbound ${conn.id} error: ${err.message}`)

      this.dispatchToLambda(conn, {
        type: 'error',
        connection_id: conn.id,
        remote_did: conn.remoteDid,
        error: err.message,
        timestamp: Date.now()
      })
    })

    socket.on('pong', () => this.handlePong(conn))

    const allowUnsigned = this.delegate.getAllowUnsigned(agentFilePath)
    if (!allowUnsigned) {
      // Set auth timeout
      conn.authTimeout = setTimeout(() => {
        detachAuthHandler()
        if (!conn.authenticated && !conn.closed) {
          this.log(agentFilePath, 'warn', 'ws_auth', null, `Inbound ${connectionId} auth timeout after ${AUTH_TIMEOUT_MS}ms`)
          this.closeConnection(connectionId, 4001, 'Auth timeout')
        }
      }, AUTH_TIMEOUT_MS)

      // Wait for client auth message, buffering non-auth messages for replay
      const MAX_PENDING_MESSAGES = 100
      const pendingMessages: string[] = []

      const authHandler = (data: Buffer | string) => {
        const text = typeof data === 'string' ? data : data.toString('utf-8')
        try {
          const msg = JSON.parse(text)
          if (msg.type === 'auth') {
            this.handleServerAuth(conn, msg as AuthMessage, () => {
              detachAuthHandler()
              this.wireInboundEvents(conn)
              // Replay buffered messages (per-message try/catch so one bad message doesn't kill the rest)
              for (const pending of pendingMessages) {
                try {
                  socket.emit('message', Buffer.from(pending))
                } catch (err) {
                  this.log(conn.agentFilePath, 'warn', 'ws_replay', null,
                    `Failed to replay buffered message for ${conn.id}: ${err}`)
                }
              }
              pendingMessages.length = 0
            })
            return
          }
        } catch { /* not JSON */ }
        // Non-auth message during auth — buffer for replay (capped to prevent DoS)
        if (pendingMessages.length < MAX_PENDING_MESSAGES) {
          pendingMessages.push(text)
        } else {
          this.log(agentFilePath, 'warn', 'ws_auth', null,
            `Dropped message during auth for ${conn.id}: buffer full (${MAX_PENDING_MESSAGES})`)
        }
      }
      pendingAuthHandler = authHandler
      socket.on('message', authHandler)
    } else {
      conn.authenticated = true
      conn.remoteDid = 'anonymous'
      this.wireInboundEvents(conn, true)
    }
  }

  private wireInboundEvents(conn: ManagedConnection, allowUnsigned = false): void {
    this.startKeepalive(conn)
    this.log(conn.agentFilePath, 'info', 'ws_connect', null, `Inbound ${conn.id} connected`, { remote_did: conn.remoteDid })

    this.dispatchToLambda(conn, {
      type: 'open',
      connection_id: conn.id,
      remote_did: conn.remoteDid,
      url_params: conn.urlParams,
      headers: conn.headers,
      timestamp: Date.now()
    })

    // When allow_unsigned, intercept optional auth frame from client (one-shot)
    let authFrameHandled = !allowUnsigned

    conn.socket.on('message', (data: Buffer | string, isBinary?: boolean) => {
      if (conn.closed) return
      conn.lastMessageAt = Date.now()
      if (this.streamBoundConnections.has(conn.id)) return

      const binary = isBinary === true || (typeof data !== 'string' && isBinary !== false)

      if (binary) {
        // Binary auth frames are not a thing — skip the auth-frame inspection
        authFrameHandled = true
        const bytes = typeof data === 'string' ? Buffer.from(data) : data
        this.dispatchToLambda(conn, {
          type: 'message',
          connection_id: conn.id,
          remote_did: conn.remoteDid,
          data: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
          binary: true,
          timestamp: Date.now()
        })
        return
      }

      const text = typeof data === 'string' ? data : data.toString('utf-8')

      // One-shot: check if first message is an auth frame from the client
      if (!authFrameHandled) {
        authFrameHandled = true
        try {
          const msg = JSON.parse(text)
          if (msg.type === 'auth' && msg.did) {
            // Accept the claimed DID without verification, send auth_result success
            conn.remoteDid = msg.did
            const serverDid = this.delegate.getAgentDid(conn.agentFilePath)
            const result: AuthResultMessage = { type: 'auth_result', success: true, server_did: serverDid ?? undefined }
            try { conn.socket.send(JSON.stringify(result)) } catch { /* best-effort */ }
            this.log(conn.agentFilePath, 'info', 'ws_auth', null,
              `Inbound ${conn.id} accepted DID (unsigned)`, { remote_did: conn.remoteDid })
            return // Don't forward auth frame to lambda
          }
        } catch { /* not JSON — proceed as normal message */ }
      }

      // Inbound WS always has lambda (schema enforces this)
      this.dispatchToLambda(conn, {
        type: 'message',
        connection_id: conn.id,
        remote_did: conn.remoteDid,
        data: text,
        binary: false,
        timestamp: Date.now()
      })
    })
  }

  // ===========================================================================
  // Send / Disconnect / Query
  // ===========================================================================

  async send(connectionId: string, data: string | Uint8Array | Buffer): Promise<{ success: boolean; error?: string }> {
    const conn = this.connections.get(connectionId)
    if (!conn) return { success: false, error: 'Connection not found' }
    if (conn.closed || conn.socket.readyState !== WebSocket.OPEN) {
      return { success: false, error: 'Connection not open' }
    }

    // Normalize binary to Buffer so the ws library sends a binary frame.
    // Strings are always sent as text frames.
    const payload: string | Buffer = typeof data === 'string'
      ? data
      : (Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength))

    try {
      const bufferedBefore = (conn.socket as unknown as { bufferedAmount?: number }).bufferedAmount ?? 0
      // Send; the `ws` library buffers if the TCP write cannot drain immediately.
      conn.socket.send(payload)
      conn.lastMessageAt = Date.now()

      // Backpressure: if buffered bytes now exceed the high-water mark, await drain.
      const hwm = conn.highWaterMarkBytes
      const currentBuffered = bufferedBefore + (typeof payload === 'string' ? Buffer.byteLength(payload) : payload.byteLength)
      if (currentBuffered >= hwm) {
        const drain = await this.waitForDrain(conn)
        if (!drain.ok) {
          // The frame is still sitting in the socket's buffer with no evidence
          // it will ever go out. Reporting success here made mesh delivery mark
          // the message `delivered` and skip the HTTP fallback.
          this.log(conn.agentFilePath, 'warn', 'ws_send', conn.configId ?? null,
            `Send on ${conn.id} not confirmed: ${drain.error}`)
          return { success: false, error: drain.error }
        }
      }

      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  }

  disconnect(connectionId: string, code?: number, reason?: string): void {
    // A user ws_disconnect is a deliberate, permanent teardown: cancel any
    // pending reconnect for this connection's config first, so closeConnection
    // (which terminates a still-CONNECTING socket) cannot leave a reconnect
    // armed and nothing re-opens what the user just closed.
    const conn = this.connections.get(connectionId)
    if (conn?.configId) this.clearReconnectState(conn.agentFilePath, conn.configId)
    this.closeConnection(connectionId, code ?? 1000, reason)
  }

  /**
   * Close every live connection an agent holds for a configured connection id.
   * Returns the number closed. Also cancels any pending reconnect for that
   * config — a deliberate disconnect should stay disconnected.
   */
  disconnectByConfigId(agentFilePath: string, configId: string, code?: number, reason?: string): number {
    this.clearReconnectState(agentFilePath, configId)

    const connIds = this.agentConnections.get(agentFilePath)
    if (!connIds) return 0

    // Snapshot: closeConnection mutates the live set.
    const targets: string[] = []
    for (const connId of connIds) {
      const conn = this.connections.get(connId)
      if (conn && conn.configId === configId) targets.push(connId)
    }
    for (const connId of targets) {
      this.closeConnection(connId, code ?? 1000, reason)
    }
    return targets.length
  }

  bindRawConnection(connectionId: string, callbacks: WsRawBindingCallbacks): { handle?: WsRawBindingHandle; error?: string } {
    const conn = this.connections.get(connectionId)
    if (!conn) return { error: 'Connection not found' }
    if (!conn.authenticated) return { error: 'Connection is not authenticated yet' }
    if (conn.closed || conn.socket.readyState !== WebSocket.OPEN) return { error: 'Connection not open' }
    if (this.streamBoundConnections.has(connectionId)) return { error: 'Connection is already stream-bound' }

    this.streamBoundConnections.add(connectionId)

    const messageHandler = (data: Buffer | string) => {
      const bytes = typeof data === 'string' ? Buffer.from(data, 'utf-8') : Buffer.from(data)
      void Promise.resolve(callbacks.onData(bytes)).catch((err) => {
        void Promise.resolve(callbacks.onError(err instanceof Error ? err : new Error(String(err))))
      })
    }
    const closeHandler = (code: number, reason: Buffer) => {
      this.streamBoundConnections.delete(connectionId)
      void Promise.resolve(callbacks.onClose(`${code}${reason.length > 0 ? `:${reason.toString('utf-8')}` : ''}`))
    }
    const errorHandler = (err: Error) => {
      void Promise.resolve(callbacks.onError(err))
    }

    conn.socket.on('message', messageHandler)
    conn.socket.on('close', closeHandler)
    conn.socket.on('error', errorHandler)

    let detached = false
    const detach = () => {
      if (detached) return
      detached = true
      this.streamBoundConnections.delete(connectionId)
      conn.socket.removeListener('message', messageHandler)
      conn.socket.removeListener('close', closeHandler)
      conn.socket.removeListener('error', errorHandler)
    }

    return {
      handle: {
        connectionId,
        agentFilePath: conn.agentFilePath,
        direction: conn.direction,
        remoteDid: conn.remoteDid,
        write: async (data) => {
          const result = await this.send(connectionId, data)
          if (!result.success) throw new Error(result.error ?? 'WebSocket send failed')
        },
        close: (code?: number, reason?: string) => this.disconnect(connectionId, code, reason),
        detach,
        pause: () => { try { conn.socket.pause() } catch { /* socket already gone */ } },
        resume: () => { try { conn.socket.resume() } catch { /* socket already gone */ } },
      }
    }
  }

  /**
   * Wait for the socket's buffered byte count to drop below its high-water mark.
   * The `ws` library does not emit a native drain event, so we poll bufferedAmount.
   *
   * Fails closed: if the buffer never drains (or the socket dies mid-wait) the
   * caller is told the send was NOT confirmed. Previously this returned as if
   * the frame had gone out, so `send()` reported success for bytes stuck in a
   * dead socket and mesh delivery recorded a message as delivered.
   */
  private async waitForDrain(conn: ManagedConnection): Promise<{ ok: boolean; error?: string }> {
    const hwm = conn.highWaterMarkBytes
    const maxWaitMs = 30_000
    const started = Date.now()
    // 10ms base interval; polls less frequently for larger backlogs.
    const pollMs = 10

    while (!conn.closed && conn.socket.readyState === WebSocket.OPEN) {
      const buffered = (conn.socket as unknown as { bufferedAmount?: number }).bufferedAmount ?? 0
      if (buffered < hwm) return { ok: true }
      if (Date.now() - started >= maxWaitMs) {
        return { ok: false, error: `Send buffer did not drain within ${maxWaitMs}ms (${buffered} bytes pending)` }
      }
      await new Promise<void>(resolve => setTimeout(resolve, pollMs))
    }

    return { ok: false, error: 'Connection closed before send buffer drained' }
  }

  getConnections(agentFilePath?: string, filter?: { direction?: 'inbound' | 'outbound' }): WsConnectionInfo[] {
    const results: WsConnectionInfo[] = []
    for (const conn of this.connections.values()) {
      if (agentFilePath && conn.agentFilePath !== agentFilePath) continue
      if (filter?.direction && conn.direction !== filter.direction) continue
      if (!conn.authenticated) continue

      results.push({
        connection_id: conn.id,
        remote_did: conn.remoteDid ?? '',
        direction: conn.direction,
        connected_at: conn.connectedAt,
        last_message_at: conn.lastMessageAt
      })
    }
    return results
  }

  findConnectionByDid(agentFilePath: string, remoteDid: string): string | null {
    const connIds = this.agentConnections.get(agentFilePath)
    if (!connIds) return null

    let best: ManagedConnection | null = null
    for (const connId of connIds) {
      const conn = this.connections.get(connId)
      if (!conn || conn.closed || !conn.authenticated) continue
      if (conn.remoteDid !== remoteDid) continue
      if (conn.socket.readyState !== WebSocket.OPEN) continue
      if (!best || conn.lastMessageAt > best.lastMessageAt) {
        best = conn
      }
    }
    return best?.id ?? null
  }

  stopAll(): void {
    this.streamBoundConnections.clear()
    for (const state of this.reconnectStates.values()) clearTimeout(state.timer)
    this.reconnectStates.clear()

    for (const conn of this.connections.values()) {
      this.clearTimers(conn)
      // Detach before closing: the registries are cleared below, so a 'close'
      // or 'error' callback firing afterwards would dispatch lambdas and log
      // against connection state that no longer exists.
      try { conn.socket.removeAllListeners() } catch { /* best-effort */ }
      if (!conn.closed) {
        if (conn.socket.readyState === WebSocket.OPEN) {
          try { conn.socket.close(1001, 'Shutting down') } catch { /* best-effort */ }
        } else if (conn.socket.readyState === WebSocket.CONNECTING) {
          // A CONNECTING socket must be terminated, not close()d — close()
          // aborts the handshake (code 1006) and leaks the OS socket; and its
          // connectTimer is about to be cleared below, so it would never
          // self-terminate. terminate() reaps it for good.
          try { conn.socket.terminate() } catch { /* best-effort */ }
        }
      }
      conn.closed = true
      try { conn.socket.removeAllListeners() } catch { /* best-effort */ }
    }
    this.connections.clear()
    this.agentConnections.clear()
    this.agentState.clear()
    this.lambdaSourceCache.clear()
  }

  // ===========================================================================
  // Auth Handshake
  // ===========================================================================

  /**
   * Client-side auth: send auth message, wait for auth_result.
   */
  private async runClientAuth(conn: ManagedConnection, expectedDid?: string): Promise<void> {
    const agentDid = this.delegate.getAgentDid(conn.agentFilePath)
    const privateKey = this.delegate.getPrivateKey(conn.agentFilePath)
    if (!agentDid || !privateKey) throw new Error('Agent DID or private key not available')

    const nonce = randomBytes(32).toString('hex')
    const timestamp = Date.now()
    const dataToSign = Buffer.from(`${agentDid}${nonce}${timestamp}`)
    const signature = signEd25519(dataToSign, privateKey)

    const authMsg: AuthMessage = {
      type: 'auth',
      did: agentDid,
      nonce,
      signature: `ed25519:${signature}`,
      timestamp
    }

    conn.socket.send(JSON.stringify(authMsg))

    // Wait for auth_result
    return new Promise<void>((resolve, reject) => {
      conn.authTimeout = setTimeout(() => {
        conn.authTimeout = undefined
        conn.socket.removeListener('message', handler)
        reject(new Error('Auth timeout'))
      }, AUTH_TIMEOUT_MS)

      const handler = (data: Buffer | string) => {
        try {
          const text = typeof data === 'string' ? data : data.toString('utf-8')
          const msg = JSON.parse(text)
          if (msg.type !== 'auth_result') return

          clearTimeout(conn.authTimeout)
          conn.authTimeout = undefined
          conn.socket.removeListener('message', handler)

          if (!msg.success) {
            reject(new Error(msg.error ?? 'Auth rejected'))
            return
          }

          // Verify server's signature
          if (msg.server_did && msg.signature && msg.nonce === nonce) {
            const rawPubKey = didToPublicKey(msg.server_did)
            if (!rawPubKey) { reject(new Error('Invalid server DID')); return }
            const spkiKey = rawPublicKeyToSpki(rawPubKey)
            const serverDataToSign = Buffer.from(`${msg.server_did}${nonce}${timestamp}`)
            const sigParts = (msg.signature as string).split(':')
            if (sigParts.length < 2 || sigParts[0] !== 'ed25519') { reject(new Error('Invalid server signature format')); return }
            const valid = verifyEd25519(serverDataToSign, sigParts.slice(1).join(':'), spkiKey)
            if (!valid) { reject(new Error('Invalid server signature')); return }

            if (expectedDid && msg.server_did !== expectedDid) {
              reject(new Error(`Server DID mismatch: expected ${expectedDid}, got ${msg.server_did}`))
              return
            }

            conn.remoteDid = msg.server_did
            conn.identityVerified = true
          }

          conn.authenticated = true
          resolve()
        } catch (err) {
          // Not valid JSON or unexpected shape — skip
        }
      }

      conn.socket.on('message', handler)
    })
  }

  /**
   * Server-side auth: verify client auth message, send auth_result.
   */
  private handleServerAuth(conn: ManagedConnection, authMsg: AuthMessage, onAuthenticated?: () => void): void {
    try {
      // Verify timestamp is within 30s
      if (Math.abs(Date.now() - authMsg.timestamp) > AUTH_TIMEOUT_MS) {
        this.log(conn.agentFilePath, 'warn', 'ws_auth', null, `Inbound ${conn.id} auth failed: timestamp out of range`, { client_did: authMsg.did })
        this.sendAuthResult(conn, false, 'Timestamp out of range')
        this.closeConnection(conn.id, 4001, 'Auth failed')
        return
      }

      // Verify client signature
      const rawPubKey = didToPublicKey(authMsg.did)
      if (!rawPubKey) {
        this.log(conn.agentFilePath, 'warn', 'ws_auth', null, `Inbound ${conn.id} auth failed: invalid client DID`, { client_did: authMsg.did })
        this.sendAuthResult(conn, false, 'Invalid client DID')
        this.closeConnection(conn.id, 4001, 'Auth failed')
        return
      }
      const spkiKey = rawPublicKeyToSpki(rawPubKey)
      const dataToVerify = Buffer.from(`${authMsg.did}${authMsg.nonce}${authMsg.timestamp}`)
      const sigParts = authMsg.signature.split(':')
      if (sigParts.length < 2 || sigParts[0] !== 'ed25519') {
        this.log(conn.agentFilePath, 'warn', 'ws_auth', null, `Inbound ${conn.id} auth failed: unsupported signature algorithm`, { client_did: authMsg.did })
        this.sendAuthResult(conn, false, 'Unsupported signature algorithm')
        this.closeConnection(conn.id, 4001, 'Auth failed')
        return
      }
      const valid = verifyEd25519(dataToVerify, sigParts.slice(1).join(':'), spkiKey)
      if (!valid) {
        this.log(conn.agentFilePath, 'warn', 'ws_auth', null, `Inbound ${conn.id} auth failed: invalid signature`, { client_did: authMsg.did })
        this.sendAuthResult(conn, false, 'Invalid signature')
        this.closeConnection(conn.id, 4001, 'Auth failed')
        return
      }

      conn.remoteDid = authMsg.did
      conn.identityVerified = true

      // Send auth_result with server signature
      const serverDid = this.delegate.getAgentDid(conn.agentFilePath)
      const privateKey = this.delegate.getPrivateKey(conn.agentFilePath)

      if (serverDid && privateKey) {
        const serverDataToSign = Buffer.from(`${serverDid}${authMsg.nonce}${authMsg.timestamp}`)
        const serverSig = signEd25519(serverDataToSign, privateKey)

        const result: AuthResultMessage = {
          type: 'auth_result',
          success: true,
          server_did: serverDid,
          nonce: authMsg.nonce,
          signature: `ed25519:${serverSig}`
        }
        conn.socket.send(JSON.stringify(result))
      } else {
        // No server identity — send success without mutual auth
        this.sendAuthResult(conn, true)
      }

      if (conn.authTimeout) {
        clearTimeout(conn.authTimeout)
        conn.authTimeout = undefined
      }
      conn.authenticated = true
      this.log(conn.agentFilePath, 'info', 'ws_auth', null, `Inbound ${conn.id} authenticated`, { remote_did: conn.remoteDid })
      if (onAuthenticated) onAuthenticated()
    } catch (err) {
      console.error(`[WS] Server auth error:`, err)
      this.log(conn.agentFilePath, 'error', 'ws_auth', null, `Inbound ${conn.id} auth error: ${err}`)
      this.sendAuthResult(conn, false, 'Internal error')
      this.closeConnection(conn.id, 4001, 'Auth failed')
    }
  }

  private sendAuthResult(conn: ManagedConnection, success: boolean, error?: string): void {
    try {
      const msg: AuthResultMessage = { type: 'auth_result', success, error }
      conn.socket.send(JSON.stringify(msg))
    } catch { /* socket may already be closed */ }
  }

  // ===========================================================================
  // Cold-Path Frame Handling
  // ===========================================================================

  private handleColdPathMessage(conn: ManagedConnection, text: string): void {
    let message: AlfMessage
    try {
      message = JSON.parse(text) as AlfMessage
    } catch {
      this.closeConnection(conn.id, 4003, 'Invalid JSON')
      return
    }

    // Basic ALF validation
    if (!message.from || !message.payload?.content) {
      this.closeConnection(conn.id, 4003, 'Invalid ALF message')
      return
    }

    // Reject forged from when identity is cryptographically verified
    if (conn.identityVerified && conn.remoteDid && message.from !== conn.remoteDid) {
      this.log(conn.agentFilePath, 'warn', 'ws_cold_path', null,
        `Rejected message: from=${message.from} does not match authenticated DID=${conn.remoteDid}`)
      this.closeConnection(conn.id, 4003, 'From field mismatch')
      return
    }

    // Identity verification is passed out-of-band, NOT stamped into message.meta
    // here: meta is covered by the message signature, so mutating it before the
    // ingress crypto tier would invalidate every signed frame. The ingress path
    // strips any wire-supplied stamp and re-stamps from these values.
    this.delegate.processIngressMessage(conn.agentFilePath, message, {
      identityVerified: conn.identityVerified,
      remoteDid: conn.remoteDid
    }).catch(err => {
      console.error(`[WS] Cold-path ingress error for ${conn.id}:`, err)
    })
  }

  // ===========================================================================
  // Lambda Dispatch
  // ===========================================================================

  private async dispatchToLambda(conn: ManagedConnection, event: WsLambdaEvent): Promise<void> {
    // Emit ws lifecycle events independently of whether a lambda is configured.
    // Prefer the agent id captured at connect time — the live workspace lookup
    // returns null during teardown, which is exactly when `close` tends to fire.
    const agentId = conn.agentId
      ?? this.delegate.getWorkspace(conn.agentFilePath)?.getAgentConfig().id
      ?? undefined
    if (event.type === 'open') {
      emitUmbilicalEvent({
        event_type: 'ws.opened',
        agentId,
        source: `system:ws`,
        payload: {
          connection_id: conn.id,
          direction: conn.direction,
          remote_did: conn.remoteDid ?? null,
          url_params: conn.urlParams ?? null,
        }
      })
    } else if (event.type === 'close') {
      emitUmbilicalEvent({
        event_type: 'ws.closed',
        agentId,
        source: `system:ws`,
        payload: {
          connection_id: conn.id,
          direction: conn.direction,
          remote_did: conn.remoteDid ?? null,
          code: event.code ?? null,
          reason: event.reason ?? null,
          duration_ms: conn.connectedAt ? Date.now() - conn.connectedAt : null,
        }
      })
    }

    if (!conn.lambdaRef) {
      // Per-event, and on a cold-path connection it is the expected steady
      // state — 'debug' so it stays out of the default log stream.
      this.log(conn.agentFilePath, 'debug', 'ws_lambda', null,
        `Skipped ${event.type} dispatch on ${conn.direction} conn ${conn.id}: no lambda configured`)
      return
    }

    const lastColon = conn.lambdaRef.lastIndexOf(':')
    if (lastColon <= 0) {
      this.log(conn.agentFilePath, 'error', 'ws_lambda', conn.lambdaRef,
        `Invalid lambda ref format "${conn.lambdaRef}" for ${conn.id} (expected "file:fn")`)
      return
    }
    const filePath = conn.lambdaRef.slice(0, lastColon)
    const fnName = conn.lambdaRef.slice(lastColon + 1)

    const workspace = this.delegate.getWorkspace(conn.agentFilePath)
    const codeSandbox = this.delegate.getCodeSandbox(conn.agentFilePath)
    const callHandler = this.delegate.getAdfCallHandler(conn.agentFilePath)
    const toolConfig = this.delegate.getToolConfig(conn.agentFilePath)

    // Agent may have been unregistered
    if (!workspace || !codeSandbox || !callHandler || !toolConfig) {
      this.log(conn.agentFilePath, 'error', 'ws_lambda', null, `Lambda dispatch failed for ${conn.id}: agent unavailable`)
      this.closeConnection(conn.id, 1001, 'Agent unavailable')
      return
    }

    let code: string
    try {
      const loaded = await this.loadLambdaCode(conn.agentFilePath, workspace, filePath)
      if (loaded === null) {
        this.log(conn.agentFilePath, 'error', 'ws_lambda', conn.lambdaRef, `Lambda file not found: ${filePath}`)
        return
      }
      code = loaded
    } catch (err) {
      this.log(conn.agentFilePath, 'error', 'ws_lambda', conn.lambdaRef,
        `TypeScript transpile failed for ${filePath}: ${err}`)
      return
    }

    // Same wrapping pattern as mesh-server handleApiRoute.
    // Sandbox internally strips export/import keywords and wraps in async IIFE.
    const wrappedCode = code + '\n\n' +
      'if (typeof ' + fnName + ' === "function") {\n' +
      '  return await ' + fnName + '(' + JSON.stringify(event) + ');\n' +
      '} else {\n' +
      '  throw new Error("WS lambda function ' + fnName + ' not found in ' + filePath + '");\n' +
      '}'
    const sandboxId = `${conn.agentFilePath}:ws`
    // Bind authorization to the WS lambda's own source file — otherwise
    // handleCall falls back to the sticky isAuthorized field and the lambda
    // inherits whatever auth flag another entry point last left on the shared
    // handler, silently bypassing protection. (Same fix as tap-manager.)
    const fileAuthorized = workspace.isFileAuthorized(filePath)
    const onAdfCall = (method: string, args: unknown) =>
      withAuthorization(fileAuthorized, () => callHandler.handleCall(method, args))

    try {
      const wsConfig = workspace.getAgentConfig()
      const timeout = wsConfig.limits?.execution_timeout_ms

      const t0 = performance.now()
      emitUmbilicalEvent({
        event_type: 'lambda.started',
        agentId,
        source: `lambda:${filePath}:${fnName}`,
        payload: { lambda_path: filePath, function_name: fnName, kind: 'ws', connection_id: conn.id }
      })
      const result = await withSource(`lambda:${filePath}:${fnName}`, agentId, () =>
        codeSandbox.execute(sandboxId, wrappedCode, timeout, onAdfCall, toolConfig)
      )
      const durationMs = +(performance.now() - t0).toFixed(2)
      if (result.error) {
        emitUmbilicalEvent({
          event_type: 'lambda.failed',
          agentId,
          source: `lambda:${filePath}:${fnName}`,
          payload: { lambda_path: filePath, function_name: fnName, kind: 'ws', duration_ms: durationMs, error: result.error }
        })
        this.log(conn.agentFilePath, 'error', 'ws_lambda', conn.lambdaRef,
          `Lambda error for ${conn.id} (${event.type}): ${result.error}`, { stdout: result.stdout || undefined })
      } else {
        emitUmbilicalEvent({
          event_type: 'lambda.completed',
          agentId,
          source: `lambda:${filePath}:${fnName}`,
          payload: { lambda_path: filePath, function_name: fnName, kind: 'ws', duration_ms: durationMs }
        })
        // 'message' fires once per frame — at 'info' it drowns the log table on
        // any busy socket. Lifecycle dispatches (open/close/error) stay at
        // 'info'. Note `conn.direction` is the *connection's* direction (who
        // dialed whom); every event reaching dispatchToLambda is received-side,
        // so the wording keeps the two apart.
        const level = event.type === 'message' ? 'debug' : 'info'
        this.log(conn.agentFilePath, level, 'ws_lambda', conn.lambdaRef,
          `Handled ${event.type} on ${conn.direction} conn ${conn.id}`, { stdout: result.stdout || undefined })
      }
      // Do NOT destroy sandbox — warm by default
    } catch (err) {
      emitUmbilicalEvent({
        event_type: 'lambda.failed',
        agentId,
        source: `lambda:${filePath}:${fnName}`,
        payload: { lambda_path: filePath, function_name: fnName, kind: 'ws', error: String(err) }
      })
      this.log(conn.agentFilePath, 'error', 'ws_lambda', conn.lambdaRef,
        `Lambda dispatch failed for ${conn.id} (${event.type}): ${err}`)
    }
  }

  /**
   * Read + transpile a lambda file, memoized for LAMBDA_SOURCE_TTL_MS.
   *
   * The hot path runs this once per *frame*; without the cache a busy socket
   * re-read the file from SQLite and re-ran the TypeScript strip on every
   * message. `loadLambdaSource` (shared with tap-manager and mesh-server) adds
   * a content-hash transpile cache underneath, so a TTL miss on an unchanged
   * file costs only the read.
   *
   * Returns null when the file does not exist; throws on transpile failure.
   */
  private async loadLambdaCode(agentFilePath: string, workspace: AdfWorkspace, filePath: string): Promise<string | null> {
    const key = `${agentFilePath}\u0000${filePath}`
    const now = Date.now()
    const cached = this.lambdaSourceCache.get(key)
    if (cached && cached.expiresAt > now) return cached.code

    const code = await loadLambdaSource((p) => workspace.readFile(p), filePath)
    if (code === null) {
      this.lambdaSourceCache.delete(key)
      return null
    }
    this.lambdaSourceCache.set(key, { code, expiresAt: now + LAMBDA_SOURCE_TTL_MS })
    return code
  }

  // ===========================================================================
  // Keepalive
  // ===========================================================================

  private startKeepalive(conn: ManagedConnection): void {
    conn.keepaliveTimer = setInterval(() => {
      if (conn.closed || conn.socket.readyState !== WebSocket.OPEN) {
        this.clearTimers(conn)
        return
      }

      if (!conn.pongReceived) {
        // No pong to previous ping — connection is dead
        console.warn(`[WS] No pong received for ${conn.id}, closing`)
        this.closeConnection(conn.id, 1001, 'Ping timeout')
        return
      }

      conn.pongReceived = false
      try { conn.socket.ping() } catch { /* best-effort */ }

      // Schedule pong timeout check. Tracked on the connection so clearTimers
      // (close / shutdown) can cancel it; the pong handler disarms it too.
      if (conn.pongTimer) clearTimeout(conn.pongTimer)
      conn.pongTimer = setTimeout(() => {
        conn.pongTimer = undefined
        if (!conn.closed && !conn.pongReceived) {
          console.warn(`[WS] Pong timeout for ${conn.id}, closing`)
          this.closeConnection(conn.id, 1001, 'Pong timeout')
        }
      }, PONG_TIMEOUT_MS)
    }, conn.keepaliveIntervalMs)
  }

  // ===========================================================================
  // Reconnection
  // ===========================================================================

  private static reconnectKey(agentFilePath: string, configId: string): string {
    // \u0000 cannot appear in a path or a config id, so the join is unambiguous.
    return `${agentFilePath}\u0000${configId}`
  }

  /** Cancel and forget the pending reconnect (if any) for one config. */
  private clearReconnectState(agentFilePath: string, configId: string): void {
    const key = WsConnectionManager.reconnectKey(agentFilePath, configId)
    const state = this.reconnectStates.get(key)
    if (!state) return
    clearTimeout(state.timer)
    this.reconnectStates.delete(key)
  }

  /** Cancel every pending reconnect belonging to an agent. */
  private clearAllReconnectStates(agentFilePath: string): void {
    const prefix = `${agentFilePath}\u0000`
    for (const [key, state] of this.reconnectStates) {
      if (!key.startsWith(prefix)) continue
      clearTimeout(state.timer)
      this.reconnectStates.delete(key)
    }
  }

  /** Pending reconnect attempt number for a config, or 0 if none. Test seam. */
  getPendingReconnect(agentFilePath: string, configId: string): number {
    return this.reconnectStates.get(WsConnectionManager.reconnectKey(agentFilePath, configId))?.attempt ?? 0
  }

  /**
   * Arm the single reconnect timer for (agentFilePath, config.id).
   *
   * Two independent paths can ask for a reconnect after one failure — the
   * socket's `close` handler and the reconnect-failure recursion — so this
   * cancels and replaces any timer already pending for the same key. That, plus
   * clearing on successful connect / disconnect / unregister, is what keeps the
   * invariant of at most one pending timer per config.
   */
  private scheduleReconnect(agentFilePath: string, config: WsConnectionConfig, previousAttempts: number): void {
    if (config.auto_reconnect === false) return

    // Check agent is still registered
    if (!this.agentState.has(agentFilePath)) {
      this.clearReconnectState(agentFilePath, config.id)
      return
    }

    if (previousAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.error(`[WS] Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) for ${config.id}, giving up`)
      this.clearReconnectState(agentFilePath, config.id)
      return
    }

    const key = WsConnectionManager.reconnectKey(agentFilePath, config.id)
    const attempt = previousAttempts + 1

    const existing = this.reconnectStates.get(key)
    if (existing) {
      // A duplicate scheduler for the same failure — keep exactly one timer.
      if (existing.attempt >= attempt) return
      clearTimeout(existing.timer)
      this.reconnectStates.delete(key)
    }

    const baseDelay = config.reconnect_delay_ms ?? DEFAULT_RECONNECT_DELAY_MS
    const delay = baseDelay * attempt

    console.log(`[WS] Scheduling reconnect ${attempt}/${MAX_RECONNECT_ATTEMPTS} for ${config.id} in ${delay}ms`)

    // ALS context is absent here (the trigger is a socket callback), so the
    // agent id is resolved explicitly — same reason as the ws.opened/ws.closed
    // emits in dispatchToLambda.
    emitUmbilicalEvent({
      event_type: 'ws.reconnecting',
      agentId: this.delegate.getWorkspace(agentFilePath)?.getAgentConfig().id ?? undefined,
      source: `system:ws`,
      payload: {
        config_id: config.id,
        attempt,
        max_attempts: MAX_RECONNECT_ATTEMPTS,
        delay_ms: delay
      }
    })

    const timer = setTimeout(async () => {
      // The timer is firing — it is no longer pending.
      if (this.reconnectStates.get(key)?.timer === timer) this.reconnectStates.delete(key)

      // Check agent is still registered before reconnecting
      if (!this.agentState.has(agentFilePath)) return

      const result = await this.connectOutbound(agentFilePath, config, attempt)
      if (result.error) {
        console.warn(`[WS] Reconnect attempt ${attempt} failed for ${config.id}: ${result.error}`)
        // reconnectAttempts is tracked on the new connection; schedule next from here
        this.scheduleReconnect(agentFilePath, config, attempt)
      }
    }, delay)

    this.reconnectStates.set(key, { timer, attempt })
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  private addAgentConnection(agentFilePath: string, connectionId: string): void {
    let set = this.agentConnections.get(agentFilePath)
    if (!set) {
      set = new Set()
      this.agentConnections.set(agentFilePath, set)
    }
    set.add(connectionId)
  }

  private removeConnection(connectionId: string): void {
    const conn = this.connections.get(connectionId)
    if (conn) {
      const agentSet = this.agentConnections.get(conn.agentFilePath)
      if (agentSet) agentSet.delete(connectionId)
    }
    this.connections.delete(connectionId)
  }

  private closeConnection(connectionId: string, code?: number, reason?: string): void {
    const conn = this.connections.get(connectionId)
    if (!conn) return

    conn.closed = true
    this.clearTimers(conn)

    // Every caller of closeConnection is a deliberate, permanent teardown
    // (user disconnect, unregister, auth/protocol failure, ping timeout). The
    // CONNECTING-vs-OPEN disposition is centralized here so it can't be applied
    // inconsistently:
    //   - CONNECTING: terminate() + removeAllListeners, NOT close(). close() on
    //     a CONNECTING socket routes through the ws library's abortHandshake(),
    //     which leaves _closeCode at its 1006 default; the outbound 'close'
    //     handler's reconnect gate (`code !== 1000 && code !== 1001`) then PASSES
    //     and silently reconnects a socket we are deliberately killing (and the
    //     handshake/OS socket leaks). Removing listeners first means the aborted
    //     handshake's 'close' can never schedule that reconnect. Same discipline
    //     as the connect-timeout path.
    //   - OPEN: graceful close(code) so the peer sees the intended close code.
    if (conn.socket.readyState === WebSocket.CONNECTING) {
      try { conn.socket.terminate() } catch { /* best-effort */ }
      try { conn.socket.removeAllListeners() } catch { /* best-effort */ }
    } else if (conn.socket.readyState === WebSocket.OPEN) {
      try { conn.socket.close(code ?? 1000, reason) } catch { /* best-effort */ }
    }

    this.removeConnection(connectionId)
  }

  /**
   * Cancel every timer owned by a connection. Reconnect timers are deliberately
   * NOT here — they outlive the connection and live in `reconnectStates`.
   */
  private clearTimers(conn: ManagedConnection): void {
    if (conn.keepaliveTimer) { clearInterval(conn.keepaliveTimer); conn.keepaliveTimer = undefined }
    if (conn.pongTimer) { clearTimeout(conn.pongTimer); conn.pongTimer = undefined }
    if (conn.connectTimer) { clearTimeout(conn.connectTimer); conn.connectTimer = undefined }
    if (conn.authTimeout) { clearTimeout(conn.authTimeout); conn.authTimeout = undefined }
  }
}
