/**
 * Which addresses other computers may reach this runtime on, for every
 * listener that goes beyond loopback: the mesh server's LAN mode and
 * remote access (docs/design/remote-access.md §3.3, §3.3.1). Private LAN
 * addresses on a network the OS (Windows) or the owner (macOS, Linux:
 * `privateNetworks` in remote-access.json) marks private, and Tailscale
 * addresses. Never a public network, never a public address.
 *
 * - `LanReach`: the current addresses with their network, the Tailscale
 *   state, and why a category could not be read. Interfaces are read on
 *   every call (cheap); network categories and Tailscale at most every 60 s
 *   or when the interfaces change (they run a command).
 * - `LanListeners`: one http.Server per address on the server's port, next
 *   to its loopback listener, handing requests and WebSocket upgrades to
 *   the same Fastify instance. No wildcard bind.
 *
 * Electron-free; Studio main (embedded mesh, the Networking status line)
 * and the daemon (its mesh) use the same rule.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import type { Duplex } from 'node:stream'
import { addressCandidates, lanInterfaceNames, type AddressCandidate } from '../daemon/remote-access/addresses'
import { loadRemoteAccessConfig } from '../daemon/remote-access/config'
import { readNetworkCategories, type NetworkCategories } from '../daemon/remote-access/network-category'
import { TailscaleClient, type TailscaleSelf } from '../daemon/remote-access/tailscale'

const SLOW_REFRESH_MS = 60_000

export interface LanReachSnapshot {
  /** Every candidate address with its network; `refusal` set on a public network. */
  addresses: AddressCandidate[]
  /** The addresses a listener may use now. */
  listenable: string[]
  tailscale: TailscaleSelf['state']
  /** Why the network category could not be read (everything is then public); null when fine. */
  problem: string | null
}

export interface LanReachOptions {
  /** Where remote-access.json lives (macOS, Linux: the networks the owner marked private); null: none trusted. */
  settingsDir: string | null
  interfaces?: () => NodeJS.Dict<NetworkInterfaceInfo[]>
  categories?: (ifaces: readonly string[]) => Promise<NetworkCategories>
  tailscale?: () => Promise<TailscaleSelf>
  now?: () => number
}

export class LanReach {
  private categories: NetworkCategories = { categories: new Map(), current: [], problem: null }
  private categoriesKey = ''
  private tailscaleSelf: TailscaleSelf = { state: 'absent', ips: [], dnsName: null }
  private slowAt = 0
  private readonly tailscaleClient = new TailscaleClient()

  constructor(private readonly opts: LanReachOptions) {}

  async snapshot(opts: { force?: boolean } = {}): Promise<LanReachSnapshot> {
    const now = (this.opts.now ?? Date.now)()
    const interfaces = (this.opts.interfaces ?? networkInterfaces)()
    const slowDue = opts.force || now - this.slowAt >= SLOW_REFRESH_MS
    if (slowDue) {
      this.tailscaleSelf = await (this.opts.tailscale ?? (() => this.tailscaleClient.self()))().catch(() => ({ state: 'absent' as const, ips: [], dnsName: null }))
    }
    const tailscaleIps = new Set(this.tailscaleSelf.ips.map((ip) => ip.toLowerCase()))
    const lanIfaces = lanInterfaceNames(interfaces, tailscaleIps)
    const key = [...lanIfaces].sort().join('|')
    if (slowDue || key !== this.categoriesKey) {
      this.categories = await (this.opts.categories ?? ((ifaces) => {
        const trusted = this.opts.settingsDir ? loadRemoteAccessConfig(this.opts.settingsDir).config.privateNetworks : []
        return readNetworkCategories(ifaces, trusted)
      }))(lanIfaces)
      this.categoriesKey = key
      this.slowAt = now
    }
    const addresses = addressCandidates({ interfaces, tailscaleIps, categories: this.categories.categories })
    return {
      addresses,
      listenable: addresses.filter((a) => a.refusal === null).map((a) => a.address),
      tailscale: this.tailscaleSelf.state,
      problem: this.categories.problem,
    }
  }
}

export interface LanListenersOptions {
  port: number
  handler: (req: IncomingMessage, res: ServerResponse) => void
  /** WebSocket upgrades (the mesh's /ws): handed to the main server's 'upgrade' listeners. */
  upgrade?: (req: IncomingMessage, socket: Duplex, head: Buffer) => void
  log?: (line: string) => void
}

/** One http.Server per address, same port, same handler. */
export class LanListeners {
  private readonly listeners = new Map<string, { server: Server; sockets: Set<Socket> }>()

  constructor(private readonly opts: LanListenersOptions) {}

  addresses(): string[] {
    return [...this.listeners.keys()]
  }

  /** Listen on exactly `wanted`; a failed bind is returned per address and retried at the next sync. */
  async sync(wanted: readonly string[]): Promise<Map<string, string>> {
    const problems = new Map<string, string>()
    const want = new Set(wanted)
    for (const address of [...this.listeners.keys()]) if (!want.has(address)) await this.close(address)
    for (const address of want) {
      if (this.listeners.has(address)) continue
      try {
        await this.open(address)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code
        problems.set(address, `could not listen on ${address}:${this.opts.port} (${code ?? (err instanceof Error ? err.message : String(err))})`)
      }
    }
    return problems
  }

  private open(address: string): Promise<void> {
    const sockets = new Set<Socket>()
    const server = createServer(this.opts.handler)
    if (this.opts.upgrade) server.on('upgrade', this.opts.upgrade)
    server.on('connection', (socket: Socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
    })
    return new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen({ host: address, port: this.opts.port }, () => {
        server.removeListener('error', reject)
        server.on('error', (err) => this.opts.log?.(`listener ${address}:${this.opts.port} failed: ${err.message}`))
        this.listeners.set(address, { server, sockets })
        this.opts.log?.(`listening on ${address.includes(':') ? `[${address}]` : address}:${this.opts.port}`)
        resolve()
      })
    })
  }

  private async close(address: string): Promise<void> {
    const listener = this.listeners.get(address)
    if (!listener) return
    this.listeners.delete(address)
    const closed = new Promise<void>((resolve) => listener.server.close(() => resolve()))
    for (const socket of listener.sockets) socket.destroy()
    listener.server.closeAllConnections?.()
    await closed
    this.opts.log?.(`stopped listening on ${address}:${this.opts.port}`)
  }

  async closeAll(): Promise<void> {
    for (const address of [...this.listeners.keys()]) await this.close(address)
  }
}
