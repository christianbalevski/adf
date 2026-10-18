/**
 * Which addresses other computers may reach this runtime on, for every
 * listener that goes beyond loopback: the mesh server's LAN mode and
 * remote access (docs/design/remote-access.md §3.3, §3.3.1). Private LAN
 * addresses and Tailscale addresses, and only on a network the user allowed
 * (owner decision 2026-10-18 b: `allowedNetworks` in remote-access.json, one
 * list for both). Never without consent, never a public address.
 *
 * - `LanReach`: the current addresses with their network and whether it is
 *   allowed, and the networks. Interfaces, gateways and the allowed list are
 *   read on every call (cheap); Tailscale at most every 60 s.
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
import type { AllowedNetwork, NetworkView } from '../../shared/types/remote-access.types'
import type { AddressCandidate } from '../daemon/remote-access/addresses'
import { readAllowedNetworks } from '../daemon/remote-access/config'
import { readGatewayIdentities, readOsCategories, readWifiNames } from '../daemon/remote-access/network-category'
import { NetworkWatcher } from '../daemon/remote-access/network-key'
import { TailscaleClient, tailnetNameOf, type TailscaleSelf } from '../daemon/remote-access/tailscale'

const SLOW_REFRESH_MS = 60_000

export interface LanReachSnapshot {
  /** Every candidate address with its network; `refusal` set when that network is not allowed. */
  addresses: AddressCandidate[]
  /** The addresses a listener may use now. */
  listenable: string[]
  /** The networks this computer is on now. */
  networks: NetworkView[]
  tailscale: TailscaleSelf['state']
}

export interface LanReachOptions {
  /** Where remote-access.json lives (`allowedNetworks`); null: no network allowed. */
  settingsDir: string | null
  interfaces?: () => NodeJS.Dict<NetworkInterfaceInfo[]>
  /** The allowed networks. Default: read from remote-access.json on every call. */
  allowed?: () => Promise<AllowedNetwork[]>
  /** Per LAN interface, `<gateway IP>|<gateway MAC>` ('' unknown). Default: readGatewayIdentities. */
  gateways?: (ifaces: readonly string[], interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>) => Promise<Map<string, string>>
  wifiNames?: (ifaces: readonly string[]) => Promise<Map<string, string>>
  osCategories?: (ifaces: readonly string[]) => Promise<Map<string, 'private' | 'public'>>
  tailscale?: () => Promise<TailscaleSelf>
  now?: () => number
}

export class LanReach {
  private tailscaleSelf: TailscaleSelf = { state: 'absent', ips: [], dnsName: null }
  private tailscaleAt = 0
  private readonly tailscaleClient = new TailscaleClient()
  /** The daemon's rule (network-key.ts): the same network identity and the same consent list. */
  private readonly watcher: NetworkWatcher

  constructor(private readonly opts: LanReachOptions) {
    this.watcher = new NetworkWatcher({
      readGateways: this.opts.gateways ?? ((ifaces, interfaces) => readGatewayIdentities(ifaces, interfaces)),
      readWifiNames: this.opts.wifiNames ?? ((ifaces) => readWifiNames(ifaces)),
      readOsCategories: this.opts.osCategories ?? ((ifaces) => readOsCategories(ifaces)),
      slowCheckMs: SLOW_REFRESH_MS,
      ...(this.opts.now ? { now: this.opts.now } : {}),
    })
  }

  /**
   * The addresses now. `onNetworkChanged` gets the LAN interfaces whose
   * network changed, before anything else: close their listeners.
   */
  async snapshot(opts: { force?: boolean; onNetworkChanged?: (ifaces: string[]) => Promise<void> } = {}): Promise<LanReachSnapshot> {
    const now = (this.opts.now ?? Date.now)()
    const interfaces = (this.opts.interfaces ?? networkInterfaces)()
    if (opts.force || this.tailscaleAt === 0 || now - this.tailscaleAt >= SLOW_REFRESH_MS) {
      this.tailscaleSelf = await (this.opts.tailscale ?? (() => this.tailscaleClient.self()))().catch(() => ({ state: 'absent' as const, ips: [], dnsName: null }))
      this.tailscaleAt = now
    }
    const allowed = await (this.opts.allowed ?? (() => readAllowedNetworks(this.opts.settingsDir)))()
    const reading = await this.watcher.read({
      interfaces,
      tailscaleIps: new Set(this.tailscaleSelf.ips.map((ip) => ip.toLowerCase())),
      tailnet: tailnetNameOf(this.tailscaleSelf),
      allowed,
      ...(opts.onNetworkChanged ? { beforeChange: opts.onNetworkChanged } : {}),
    })
    return {
      addresses: reading.candidates,
      listenable: reading.candidates.filter((a) => a.refusal === null).map((a) => a.address),
      networks: reading.networks,
      tailscale: this.tailscaleSelf.state,
    }
  }
}

export interface LanListenersOptions {
  port: number
  handler: (req: IncomingMessage, res: ServerResponse) => void
  /** Test seam: the address actually bound for a candidate (tests map a private address to a loopback one). */
  bindAddress?: (address: string) => string
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
      server.listen({ host: this.opts.bindAddress?.(address) ?? address, port: this.opts.port }, () => {
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
