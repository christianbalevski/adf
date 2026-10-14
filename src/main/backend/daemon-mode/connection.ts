import type { DaemonClient } from '../../../shared/daemon-client'
import { BackendNotConnectedError } from './errors'
import { createStudioDaemonClient, type StudioTokenSource } from './credentials'

/**
 * Where Studio's daemon is and how to authenticate to it. A connector finds
 * or starts the daemon (local mode: daemon-process.ts; remote mode: the URL
 * and token from studio-backend.json) and resolves with one of these.
 */
export interface DaemonEndpoint {
  baseUrl: string
  source: StudioTokenSource
  /** Local mode: the daemon's log file ("Open daemon log"). Null when it is on another machine. */
  logFile: string | null
  /** One line for the log: which daemon Studio uses and how it got it. Never contains the token. */
  description: string
}

export type DaemonConnector = (progress: (text: string) => void) => Promise<DaemonEndpoint>

export type ConnectionState =
  | { state: 'connecting'; progress?: string }
  /** Requests and the event stream reach the daemon. */
  | { state: 'connected' }
  /** The event stream dropped; the stream reconnects with backoff. */
  | { state: 'disconnected'; since: number; error?: string }
  /** The connector failed: no daemon to talk to this session. */
  | { state: 'failed'; message: string }

type Log = Pick<Console, 'log' | 'warn' | 'error'>

/**
 * Studio main's one connection to its daemon. Handlers call `client()`,
 * which waits for the connector and then always returns the client: a
 * request to an unreachable daemon fails with the client's own "Cannot reach
 * daemon" error. Only a failed connector rejects, with its reason.
 *
 * The connected/disconnected state follows the client event stream (the
 * stream is the one long-lived connection, so it notices first).
 */
export class DaemonConnection {
  private endpoint: DaemonEndpoint | null = null
  private daemonClient: DaemonClient | null = null
  private status: ConnectionState = { state: 'connecting' }
  private readonly listeners = new Set<(state: ConnectionState) => void>()
  private readonly ready: Promise<DaemonClient>

  constructor(connector: DaemonConnector, private readonly log: Log = console, fetchImpl?: typeof fetch) {
    this.ready = (async () => {
      try {
        const endpoint = await connector((progress) => {
          this.log.log(`[Backend] ${progress}`)
          this.set({ state: 'connecting', progress })
        })
        this.endpoint = endpoint
        this.daemonClient = createStudioDaemonClient({ baseUrl: endpoint.baseUrl, source: endpoint.source, fetch: fetchImpl })
        this.log.log(`[Backend] Using ${endpoint.description}`)
        return this.daemonClient
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        this.log.error(`[Backend] No ADF daemon for this session: ${message}`)
        this.set({ state: 'failed', message })
        throw new BackendNotConnectedError(`Studio is not connected to an ADF daemon: ${message}`)
      }
    })()
    // Handlers see the rejection through client(); this one only marks it handled.
    this.ready.catch(() => {})
  }

  /** The daemon client, once the connector resolved. */
  client(): Promise<DaemonClient> {
    return this.ready
  }

  /** The client if the connector has resolved, else null (synchronous callers: menus, protocol). */
  get current(): DaemonClient | null {
    return this.daemonClient
  }

  get state(): ConnectionState {
    return this.status
  }

  get logFile(): string | null {
    return this.endpoint?.logFile ?? null
  }

  get baseUrl(): string | null {
    return this.endpoint?.baseUrl ?? null
  }

  onState(listener: (state: ConnectionState) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Driven by the client event stream. */
  markConnected(): void {
    if (this.status.state === 'failed') return
    if (this.status.state !== 'connected') this.set({ state: 'connected' })
  }

  markDisconnected(error?: string): void {
    if (this.status.state === 'failed' || this.status.state === 'disconnected') return
    this.set({ state: 'disconnected', since: Date.now(), ...(error ? { error } : {}) })
  }

  private set(state: ConnectionState): void {
    this.status = state
    for (const listener of this.listeners) {
      try { listener(state) } catch (err) { this.log.warn('[Backend] Connection state listener failed:', err) }
    }
  }
}
