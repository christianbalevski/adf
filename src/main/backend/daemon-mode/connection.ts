import type { DaemonClient } from '../../../shared/daemon-client'
import type { DaemonVersionInfo } from '../../daemon/routes/meta-routes'
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
  /** Local mode: the daemon's GET /version at attach (pid, version, who started it, local proof). */
  daemon?: DaemonVersionInfo
  /** Local mode: how Studio got it (Settings → Backend shows it). */
  how?: 'attached' | 'spawned'
}

/**
 * Finds or starts the daemon. `logFile` is known before the connector runs
 * (local mode: the controller's log path), so a failed start can still offer
 * "Open daemon log".
 */
export type DaemonConnector = ((progress: (text: string) => void) => Promise<DaemonEndpoint>) & {
  logFile?: string | null
  /**
   * Local mode: find or start the daemon again after the one Studio used
   * exited (daemon-process.ts `ensure`: attach, or spawn one). Same port and
   * token file, so the client and its stream keep their URL.
   */
  revive?: (progress: (text: string) => void) => Promise<DaemonEndpoint>
  /**
   * Local mode: whoever answers on the port is the daemon the pid file names
   * (daemon-process.ts verifyListener, no token sent); resolves its pid,
   * rejects with the reason. Asked again after every dropped connection
   * before the token goes out (DaemonConnection).
   */
  verifyListener?: () => Promise<number>
}

/** Local mode: the daemon's process is gone (not a dropped connection). */
export interface DaemonExit {
  pid: number
  /** What its log says ended it ("signal SIGTERM", "Failed to start: …"); null when the log has no shutdown line. */
  cause: string | null
  /** GET /version `startedBy` of the daemon that exited. */
  startedBy: string | null
  /** Studio starts it again by itself (a daemon Studio started, once per window). */
  respawning: boolean
  /** Why Studio does not start it again by itself, or why that failed. */
  detail?: string
}

/** "The ADF daemon (pid N) exited (cause); agents are stopped." */
export function daemonExitSentence(exit: Pick<DaemonExit, 'pid' | 'cause'>): string {
  return `The ADF daemon (pid ${exit.pid}) exited${exit.cause ? ` (${exit.cause})` : ''}; agents are stopped.`
}

export type ConnectionState =
  | { state: 'connecting'; progress?: string }
  /** Requests and the event stream reach the daemon. */
  | { state: 'connected' }
  /** The event stream dropped; the stream reconnects with backoff. `exited`: local mode, the daemon's process is gone. */
  | { state: 'disconnected'; since: number; error?: string; exited?: DaemonExit }
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

  private readonly connectorLogFile: string | null
  private readonly connector: DaemonConnector
  /**
   * Local mode: the listener on the port was verified since the last drop.
   * Until then requests carry no token and no local proof (a 401 at worst):
   * whatever binds the port after the daemon died never gets them.
   */
  private listenerVerified = true
  private verifying: Promise<void> | null = null
  private readonly verifiedListeners = new Set<(pid: number) => void>()

  constructor(connector: DaemonConnector, private readonly log: Log = console, fetchImpl?: typeof fetch) {
    this.connector = connector
    this.connectorLogFile = connector.logFile ?? null
    this.ready = (async () => {
      try {
        const endpoint = await connector((progress) => {
          this.log.log(`[Backend] ${progress}`)
          this.set({ state: 'connecting', progress })
        })
        this.endpoint = endpoint
        // The token source of the current endpoint: a revived daemon's (revive) replaces it under the same client.
        const source = endpoint.source
        this.daemonClient = createStudioDaemonClient({
          baseUrl: endpoint.baseUrl,
          source: {
            token: () => this.listenerVerified ? (this.endpoint ?? endpoint).source.token() : undefined,
            ...(source.refresh ? { refresh: () => this.listenerVerified && ((this.endpoint ?? endpoint).source.refresh?.() ?? false) } : {}),
            ...(source.localProof ? { localProof: (path: string) => this.listenerVerified ? (this.endpoint ?? endpoint).source.localProof?.(path) ?? {} : {} } : {}),
          },
          fetch: fetchImpl,
        })
        this.log.log(`[Backend] Using ${endpoint.description}`)
        return this.daemonClient
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (err instanceof Error && err.name === 'SwitchToEmbeddedError') {
          // The user chose embedded for this session (§8.2): Studio is restarting, no failure dialog.
          this.log.log(`[Backend] ${message}`)
          this.set({ state: 'connecting', progress: 'Restarting Studio in embedded mode…' })
          throw new BackendNotConnectedError(message)
        }
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
    return this.endpoint ? this.endpoint.logFile : this.connectorLogFile
  }

  get baseUrl(): string | null {
    return this.endpoint?.baseUrl ?? null
  }

  /** The endpoint once the connector resolved (local mode: the daemon's version info). */
  get endpointInfo(): DaemonEndpoint | null {
    return this.endpoint
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

  /** No session can be used with this daemon (client API version): the connection fails, visibly. */
  markFailed(message: string): void {
    if (this.status.state === 'failed') return
    this.log.error(`[Backend] No usable ADF daemon for this session: ${message}`)
    this.set({ state: 'failed', message })
  }

  markDisconnected(error?: string): void {
    if (this.status.state === 'failed' || this.status.state === 'disconnected') return
    if (this.connector.verifyListener && this.endpoint) {
      // The daemon may be gone and another program on its port: no token until the pid file names the listener again.
      this.listenerVerified = false
      void this.verifyListenerLoop()
    }
    this.set({ state: 'disconnected', since: Date.now(), ...(error ? { error } : {}) })
  }

  /** Local mode: whether requests carry the token now (the listener was verified since the last drop). */
  get tokenAllowed(): boolean {
    return this.listenerVerified
  }

  /** Called with the daemon's pid each time the listener is verified after a drop (the stream then re-dials at once). */
  onListenerVerified(listener: (pid: number) => void): () => void {
    this.verifiedListeners.add(listener)
    return () => { this.verifiedListeners.delete(listener) }
  }

  /** Ask verifyListener until it passes, while the connection is down (every second; a refusal is logged once per reason). */
  private verifyListenerLoop(): Promise<void> {
    this.verifying ??= (async () => {
      let lastRefusal: string | null = null
      while (!this.listenerVerified && this.status.state !== 'failed') {
        try {
          const pid = await this.connector.verifyListener!()
          if ((this.status as ConnectionState).state === 'failed') break
          this.listenerVerified = true
          this.log.log(`[Backend] The ADF daemon on ${this.baseUrl} is pid ${pid}, as its pid file says; sending the token again`)
          for (const listener of this.verifiedListeners) {
            try { listener(pid) } catch (err) { this.log.warn('[Backend] Listener-verified callback failed:', err) }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          if (message !== lastRefusal && !message.startsWith('Nothing answers')) this.log.warn(`[Backend] Not sending the daemon token: ${message}`)
          lastRefusal = message
          await new Promise<void>((r) => { const t = setTimeout(r, 1_000); t.unref?.() })
        }
      }
    })().finally(() => { this.verifying = null })
    return this.verifying
  }

  /** Local mode: the daemon's process is gone. Shown as such (status line, dialog or notice) until a daemon answers again. */
  markExited(exit: DaemonExit): void {
    if (this.status.state === 'failed') return
    const since = this.status.state === 'disconnected' ? this.status.since : Date.now()
    const error = this.status.state === 'disconnected' ? this.status.error : undefined
    this.set({ state: 'disconnected', since, ...(error ? { error } : {}), exited: exit })
  }

  /** Whether the connector can find or start the daemon again (local mode). */
  get canRevive(): boolean {
    return !!this.connector.revive && !!this.endpoint
  }

  /**
   * Local mode: run the connector's `revive` (attach, or spawn a daemon) after
   * the daemon exited. The client keeps its URL (same port); the endpoint's
   * token source and version info are the new daemon's. The stream
   * reconnects on its own (or on the caller's reconnect).
   */
  async revive(progress: (text: string) => void = () => {}): Promise<DaemonEndpoint> {
    if (!this.connector.revive || !this.endpoint) throw new Error('This connection cannot start the ADF daemon again')
    const endpoint = await this.connector.revive((text) => {
      this.log.log(`[Backend] ${text}`)
      progress(text)
    })
    if (endpoint.baseUrl !== this.endpoint.baseUrl) {
      throw new Error(`The ADF daemon started again on ${endpoint.baseUrl}, not ${this.endpoint.baseUrl}; restart Studio to use it`)
    }
    this.endpoint = endpoint
    // The revive's controller.ensure verified the listener before it sent the token.
    this.listenerVerified = true
    this.log.log(`[Backend] Using ${endpoint.description}`)
    return endpoint
  }

  private set(state: ConnectionState): void {
    this.status = state
    for (const listener of this.listeners) {
      try { listener(state) } catch (err) { this.log.warn('[Backend] Connection state listener failed:', err) }
    }
  }
}
