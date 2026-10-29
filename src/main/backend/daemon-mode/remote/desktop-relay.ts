/**
 * The Computer tab on a remote runtime: a loopback relay on this computer for
 * one agent container's desktop.
 *
 * The viewer only loads `http://127.0.0.1:<port>/` (will-attach-webview), and
 * the container's noVNC port is on the remote host's loopback. Each relay
 * listens on 127.0.0.1 and forwards noVNC's page, scripts and VNC stream to
 * the remote daemon's /compute/desktop/:container/ routes with this Studio's
 * device token, so the desktop never travels unauthenticated and the token
 * never reaches the page.
 *
 * A relay closes after it has had no connection for IDLE_MS; the next
 * Computer tab lookup opens a new one.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import WebSocket, { WebSocketServer } from 'ws'
import { pipeWebSockets } from '../../../services/ws-pipe'

/** The remote daemon, as the session-stamped client gives it. */
export interface RelayTarget {
  url(path: string): string
  headers(extra?: Record<string, string>): Record<string, string>
}

export const IDLE_MS = 10 * 60_000

interface Relay {
  server: Server
  port: number
  sockets: Set<Socket>
  idle: ReturnType<typeof setTimeout> | null
}

export class DesktopRelays {
  private readonly relays = new Map<string, Promise<Relay>>()

  constructor(
    private readonly target: () => Promise<RelayTarget>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** The loopback port that shows `container`'s desktop. */
  async portFor(container: string): Promise<number> {
    let relay = this.relays.get(container)
    if (!relay) {
      relay = this.open(container)
      this.relays.set(container, relay)
      relay.catch(() => this.relays.delete(container))
    }
    return (await relay).port
  }

  async closeAll(): Promise<void> {
    const all = [...this.relays.values()]
    this.relays.clear()
    await Promise.all(all.map(async (p) => {
      const relay = await p.catch(() => null)
      if (relay) await close(relay)
    }))
  }

  private async open(container: string): Promise<Relay> {
    const base = `/compute/desktop/${encodeURIComponent(container)}`
    const wss = new WebSocketServer({ noServer: true })
    const relay: Relay = { server: createServer(), port: 0, sockets: new Set(), idle: null }

    // Host prevents DNS rebinding; Origin prevents another page connecting
    // directly to the loopback address and using this relay's credentials.
    const ownHost = (req: IncomingMessage) => req.headers.host === `127.0.0.1:${relay.port}`
    const ownOrigin = (req: IncomingMessage) => req.headers.origin === `http://127.0.0.1:${relay.port}`

    relay.server.on('request', (req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        if (!ownHost(req)) return end(res, 403)
        if (req.method !== 'GET' && req.method !== 'HEAD') return end(res, 405)
        const path = pathOf(req.url)
        if (!path) return end(res, 400)
        const client = await this.target()
        const upstream = await this.fetchImpl(client.url(`${base}${path}`), { headers: client.headers({ Accept: '*/*' }), redirect: 'manual' })
        const type = upstream.headers.get('content-type')
        res.writeHead(upstream.status, { 'cache-control': 'no-store', ...(type ? { 'content-type': type } : {}) })
        res.end(req.method === 'HEAD' ? undefined : Buffer.from(await upstream.arrayBuffer()))
      })().catch(() => end(res, 502))
    })

    relay.server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
      if (!ownHost(req) || !ownOrigin(req) || pathOf(req.url) !== '/websockify') { socket.destroy(); return }
      wss.handleUpgrade(req, socket, head, (ws) => {
        void this.target().then((client) => {
          const url = client.url(`${base}/websockify`).replace(/^http/, 'ws')
          pipeWebSockets(ws, new WebSocket(url, ws.protocol ? [ws.protocol] : [], { headers: client.headers() }))
        }).catch(() => ws.terminate())
      })
    })

    relay.server.on('connection', (socket: Socket) => {
      relay.sockets.add(socket)
      if (relay.idle) { clearTimeout(relay.idle); relay.idle = null }
      socket.once('close', () => {
        relay.sockets.delete(socket)
        if (relay.sockets.size === 0) this.armIdle(container, relay)
      })
    })

    await new Promise<void>((resolve, reject) => {
      relay.server.once('error', reject)
      relay.server.listen({ host: '127.0.0.1', port: 0 }, () => {
        relay.server.removeListener('error', reject)
        resolve()
      })
    })
    relay.port = (relay.server.address() as AddressInfo).port
    relay.server.once('close', () => wss.close())
    this.armIdle(container, relay)
    return relay
  }

  private armIdle(container: string, relay: Relay): void {
    if (relay.idle) clearTimeout(relay.idle)
    relay.idle = setTimeout(() => {
      this.relays.delete(container)
      void close(relay)
    }, IDLE_MS)
    relay.idle.unref?.()
  }
}

/** The request path, or null for anything that is not a plain absolute path. */
function pathOf(url: string | undefined): string | null {
  if (!url || !url.startsWith('/')) return null
  const path = new URL(url, 'http://127.0.0.1').pathname
  return path.split('/').some((s) => s === '..' || s === '.') ? null : path
}

function end(res: ServerResponse, status: number): void {
  if (res.headersSent) { res.destroy(); return }
  res.writeHead(status).end()
}

function close(relay: Relay): Promise<void> {
  if (relay.idle) clearTimeout(relay.idle)
  for (const socket of relay.sockets) socket.destroy()
  return new Promise((resolve) => relay.server.close(() => resolve()))
}
