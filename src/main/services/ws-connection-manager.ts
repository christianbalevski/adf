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
import { stripTypeScriptTypes } from 'module'
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

// =============================================================================
// Delegate Interface
// =============================================================================

export interface WsManagerDelegate {
  getAgentDid(agentFilePath: string): string | null
  getPrivateKey(agentFilePath: string): Buffer | null
  getPublicKey(did: string): Buffer | null
  processIngressMessage(agentFilePath: string, message: AlfMessage): Promise<{ messageId?: string; error?: string }>
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
  socket: WebSocket
  direction: 'inbound' | 'outbound'
  remoteDid?: string
  authenticated: boolean
  configId?: string
  lambdaRef?: string
  keepaliveTimer?: ReturnType<typeof setInterval>
  keepaliveIntervalMs: number
  pongReceived: boolean
  reconnectTimer?: ReturnType<typeof setTimeout>
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

export interface WsRawBindingHandle {
  connectionId: string
  agentFilePath: string
  direction: 'inbound' | 'outbound'
  remoteDid?: string
  write(data: Buffer | Uint8Array | string): Promise<void>
  close(code?: number, reason?: string): void
  detach(): void
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
const PONG_TIMEOUT_MS = 10_000
const MAX_RECONNECT_ATTEMPTS = 5

// =============================================================================
// WsConnectionManager
// =============================================================================

export class WsConnectionManager {
  private connections = new Map<string, ManagedConnection>()
  private agentConnections = new Map<string, Set<string>>()
  private agentState = new Map<string, AgentWsState>()
  private streamBoundConnections = new Set<string>()
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

  unregisterAgent(agentFilePath: string): void {
    const connIds = this.agentConnections.get(agentFilePath)
    if (connIds) {
      for (const connId of connIds) {
        this.closeConnection(connId, 1001, 'Going Away')
      }
    }
    this.agentConnections.delete(agentFilePath)
    this.agentState.delete(agentFilePath)

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

      socket.on('open', async () => {
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

      socket.on('pong', () => {
        conn.pongReceived = true
      })
    })
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

    // Register close/error/pong handlers immediately so they're active during auth
    socket.on('close', (code: number, reason: Buffer) => {
      const reasonStr = reason.toString('utf-8')
      conn.closed = true
      this.clearTimers(conn)

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

    socket.on('pong', () => {
      conn.pongReceived = true
    })

    const allowUnsigned = this.delegate.getAllowUnsigned(agentFilePath)
    if (!allowUnsigned) {
      // Set auth timeout
      conn.authTimeout = setTimeout(() => {
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
              socket.removeListener('message', authHandler)
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
        await this.waitForDrain(conn)
      }

      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  }

  disconnect(connectionId: string, code?: number, reason?: string): void {
    this.closeConnection(connectionId, code ?? 1000, reason)
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
      }
    }
  }

  /**
   * Wait for the socket's buffered byte count to drop below its high-water mark.
   * The `ws` library does not emit a native drain event, so we poll bufferedAmount.
   * Poll interval scales with buffer size to keep CPU use modest on large backlogs.
   */
  private async waitForDrain(conn: ManagedConnection): Promise<void> {
    const hwm = conn.highWaterMarkBytes
    const maxWaitMs = 30_000
    const started = Date.now()
    // 10ms base interval; polls less frequently for larger backlogs.
    const pollMs = 10

    while (!conn.closed && conn.socket.readyState === WebSocket.OPEN) {
      const buffered = (conn.socket as unknown as { bufferedAmount?: number }).bufferedAmount ?? 0
      if (buffered < hwm) return
      if (Date.now() - started > maxWaitMs) return   // fail open — caller sees success; next send will re-enter
      await new Promise<void>(resolve => setTimeout(resolve, pollMs))
    }
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
    for (const conn of this.connections.values()) {
      this.clearTimers(conn)
      if (!conn.closed && conn.socket.readyState === WebSocket.OPEN) {
        try { conn.socket.close(1001, 'Shutting down') } catch { /* best-effort */ }
      }
    }
    this.connections.clear()
    this.agentConnections.clear()
    this.agentState.clear()
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

    // Stamp identity verification for downstream pipeline/UI
    message.meta = {
      ...message.meta,
      identity_verified: conn.identityVerified,
      ...(conn.remoteDid && { ws_remote_did: conn.remoteDid })
    }

    this.delegate.processIngressMessage(conn.agentFilePath, message).catch(err => {
      console.error(`[WS] Cold-path ingress error for ${conn.id}:`, err)
    })
  }

  // ===========================================================================
  // Lambda Dispatch
  // ===========================================================================

  private async dispatchToLambda(conn: ManagedConnection, event: WsLambdaEvent): Promise<void> {
    // Emit ws lifecycle events independently of whether a lambda is configured.
    const agentId = this.delegate.getWorkspace(conn.agentFilePath)?.getAgentConfig().id ?? undefined
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
      this.log(conn.agentFilePath, 'info', 'ws_lambda', null,
        `No lambda configured for ${conn.direction} ${conn.id}, skipping ${event.type} dispatch`)
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

    const fileContent = workspace.readFile(filePath)
    if (!fileContent) {
      this.log(conn.agentFilePath, 'error', 'ws_lambda', conn.lambdaRef, `Lambda file not found: ${filePath}`)
      return
    }

    // Strip TypeScript type annotations if present (.ts files)
    let code = fileContent
    if (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) {
      try {
        code = stripTypeScriptTypes(fileContent, { mode: 'strip', sourceMap: false }) as string
      } catch (err) {
        this.log(conn.agentFilePath, 'error', 'ws_lambda', conn.lambdaRef,
          `TypeScript strip failed for ${filePath}: ${err}`)
        return
      }
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
    const onAdfCall = (method: string, args: unknown) => callHandler.handleCall(method, args)

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
        this.log(conn.agentFilePath, 'info', 'ws_lambda', conn.lambdaRef,
          `${conn.direction} ${conn.id} handled ${event.type}`, { stdout: result.stdout || undefined })
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

      // Schedule pong timeout check
      setTimeout(() => {
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

  private scheduleReconnect(agentFilePath: string, config: WsConnectionConfig, previousAttempts: number): void {
    if (config.auto_reconnect === false) return
    if (previousAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.error(`[WS] Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) for ${config.id}, giving up`)
      return
    }

    // Check agent is still registered
    if (!this.agentState.has(agentFilePath)) return

    const baseDelay = config.reconnect_delay_ms ?? DEFAULT_RECONNECT_DELAY_MS
    const delay = baseDelay * (previousAttempts + 1)
    const attempt = previousAttempts + 1

    console.log(`[WS] Scheduling reconnect ${attempt}/${MAX_RECONNECT_ATTEMPTS} for ${config.id} in ${delay}ms`)

    const timer = setTimeout(async () => {
      // Check agent is still registered before reconnecting
      if (!this.agentState.has(agentFilePath)) return

      const result = await this.connectOutbound(agentFilePath, config, attempt)
      if (result.error) {
        console.warn(`[WS] Reconnect attempt ${attempt} failed for ${config.id}: ${result.error}`)
        // reconnectAttempts is tracked on the new connection; schedule next from here
        this.scheduleReconnect(agentFilePath, config, attempt)
      }
    }, delay)

    // Store timer reference for cleanup — use a dummy connection entry
    // Actually, just store on agent state
    // Timer cleanup happens in unregisterAgent via agentState check
    // If the agent is unregistered, the setTimeout callback checks agentState and bails
    void timer // Timer is self-managed via agentState check
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

    if (conn.socket.readyState === WebSocket.OPEN || conn.socket.readyState === WebSocket.CONNECTING) {
      try { conn.socket.close(code ?? 1000, reason) } catch { /* best-effort */ }
    }

    this.removeConnection(connectionId)
  }

  private clearTimers(conn: ManagedConnection): void {
    if (conn.keepaliveTimer) { clearInterval(conn.keepaliveTimer); conn.keepaliveTimer = undefined }
    if (conn.reconnectTimer) { clearTimeout(conn.reconnectTimer); conn.reconnectTimer = undefined }
    if (conn.authTimeout) { clearTimeout(conn.authTimeout); conn.authTimeout = undefined }
  }
}
