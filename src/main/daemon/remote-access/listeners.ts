/**
 * Remote listeners (docs/design/remote-access.md §3.2): one `http.Server`
 * per eligible address, on the daemon's port, next to the loopback listener.
 * Each hands its requests to the daemon's one Fastify instance
 * (`fastify.routing`, the router entry `serverFactory` uses), so every hook,
 * guard and route is shared. Each accepted socket is tagged with the
 * address it came in on: the request guard refuses the install's own token
 * on such a socket (§4.4).
 *
 * Binding specific addresses on the daemon's port never collides with the
 * loopback bind, and no wildcard bind is ever made (it would also open the
 * public interfaces). Closing a listener destroys its sockets, hijacked SSE
 * responses included, which Fastify's own close does not see.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'

const REMOTE_SOCKET = Symbol.for('adf.remoteListenerAddress')

/** The listener address a socket arrived on, or null for the loopback listener. */
export function remoteListenerOf(socket: Socket | null | undefined): string | null {
  if (!socket) return null
  const value = (socket as unknown as Record<symbol, unknown>)[REMOTE_SOCKET]
  return typeof value === 'string' ? value : null
}

export type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void

interface Listener {
  server: Server
  sockets: Set<Socket>
}

export class RemoteListeners {
  private readonly listeners = new Map<string, Listener>()

  constructor(private readonly opts: {
    port: number
    handler: RequestHandler
    log?: (line: string) => void
    /** Test seam: the address actually bound for a candidate (default: itself). */
    bindAddress?: (address: string) => string
  }) {}

  /** Addresses listening now. */
  addresses(): string[] {
    return [...this.listeners.keys()]
  }

  /**
   * Listen on exactly `wanted`: open the new ones, close the vanished ones.
   * Returns a problem per address that failed to bind (retried at the next sync).
   */
  async sync(wanted: readonly string[], opts: { shouldOpen?: () => boolean } = {}): Promise<Map<string, string>> {
    const problems = new Map<string, string>()
    const want = new Set(wanted)
    const allowed = opts.shouldOpen ?? (() => true)
    for (const address of [...this.listeners.keys()]) {
      if (!want.has(address)) await this.close(address)
    }
    for (const address of want) {
      if (this.listeners.has(address)) continue
      // Asked again before each listener and after it opened: remote access may have been
      // turned off meanwhile (security review item 6); a listener opened too late closes at once.
      if (!allowed()) break
      try {
        await this.open(address)
        if (!allowed()) await this.close(address)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code
        problems.set(address, code === 'EADDRINUSE'
          ? `another program uses port ${this.opts.port} on ${address}`
          : `could not listen on ${address}:${this.opts.port} (${code ?? (err instanceof Error ? err.message : String(err))})`)
      }
    }
    return problems
  }

  private open(address: string): Promise<void> {
    const sockets = new Set<Socket>()
    const server = createServer(this.opts.handler)
    server.on('connection', (socket: Socket) => {
      ;(socket as unknown as Record<symbol, unknown>)[REMOTE_SOCKET] = address
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
    })
    return new Promise((resolve, reject) => {
      const onError = (err: Error) => {
        server.removeListener('listening', onListening)
        reject(err)
      }
      const onListening = () => {
        server.removeListener('error', onError)
        server.on('error', (err) => this.opts.log?.(`[remote-access] listener ${address}:${this.opts.port} failed: ${err.message}`))
        this.listeners.set(address, { server, sockets })
        this.opts.log?.(`[remote-access] listening on ${address.includes(':') ? `[${address}]` : address}:${this.opts.port}`)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen({ host: this.opts.bindAddress?.(address) ?? address, port: this.opts.port })
    })
  }

  private async close(address: string): Promise<void> {
    const listener = this.listeners.get(address)
    if (!listener) return
    this.listeners.delete(address)
    const closed = new Promise<void>(resolve => listener.server.close(() => resolve()))
    for (const socket of listener.sockets) socket.destroy()
    listener.server.closeAllConnections?.()
    await closed
    this.opts.log?.(`[remote-access] stopped listening on ${address}:${this.opts.port}`)
  }

  /** Close every listener and its connections. */
  async closeAll(): Promise<number> {
    let connections = 0
    for (const listener of this.listeners.values()) connections += listener.sockets.size
    for (const address of [...this.listeners.keys()]) await this.close(address)
    return connections
  }
}
