/**
 * Which networks this computer is on, and whether the user allowed each
 * (docs/design/remote-access.md §3.3.1, owner decision 2026-10-18 b: never
 * listen without the user's consent, given once per network, the same on
 * every OS). Remote access and the mesh's LAN mode use this one module.
 *
 * - LAN network: identified by its default gateway's MAC address and the
 *   subnet, plus the Wi-Fi name where it is readable without a permission
 *   prompt. A MAC missing for a moment keeps the last one (re-review 1).
 * - Tailnet: identified by the tailnet's name.
 * - A changed network on an interface closes its listeners at once
 *   (`beforeChange`), before anything else is read.
 */

import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import type { NetworkInterfaceInfo } from 'node:os'
import type { AllowedNetwork, NetworkView } from '../../../shared/types/remote-access.types'
import { addressCandidates, NOT_ALLOWED_SENTENCE, type AddressCandidate } from './addresses'

/**
 * The gateway identity (`<gateway IP>|<gateway MAC>`) read now, merged with
 * the last one (re-review 1): a MAC that is missing for a moment (ARP aging,
 * a stale table) or a gateway not read at all is unknown, not a change, so
 * the last identity stays. Only a known gateway IP that differs, or a known
 * MAC that differs, is another network.
 */
export function mergeGatewayIdentity(previous: string | undefined, read: string): string {
  const [ip = '', mac = ''] = read.split('|')
  const [prevIp = '', prevMac = ''] = (previous ?? '').split('|')
  if (!ip) return previous ?? ''
  if (ip !== prevIp) return `${ip}|${mac}`
  if (!mac) return `${ip}|${prevMac}`
  return `${ip}|${mac}`
}

/** `192.168.1.20/24` → `192.168.1.0/24`; IPv6: the /64 prefix. Null without a usable cidr. */
export function subnetOf(info: Pick<NetworkInterfaceInfo, 'address' | 'netmask' | 'cidr'>): string | null {
  if (isIP(info.address) === 4) {
    const mask = (info.netmask ?? '').split('.').map(Number)
    const parts = info.address.split('.').map(Number)
    if (mask.length !== 4 || mask.some(n => !Number.isInteger(n))) return null
    const bits = mask.reduce((n, m) => n + (m >>> 0).toString(2).split('').filter(b => b === '1').length, 0)
    return `${parts.map((p, i) => p & mask[i]).join('.')}/${bits}`
  }
  const groups = info.address.toLowerCase().split('::')[0].split(':').slice(0, 4)
  return groups.length ? `${groups.join(':')}::/64` : null
}

const hash = (text: string) => createHash('sha256').update(text, 'utf-8').digest('hex').slice(0, 16)

export function lanNetworkId(gatewayMac: string, subnet: string, ssid: string | null): string {
  return `lan-${hash(`${gatewayMac.toLowerCase()}|${subnet}|${ssid ?? ''}`)}`
}

export function tailnetNetworkId(tailnet: string): string {
  return `tailnet-${hash(tailnet.toLowerCase())}`
}

/** A network id as routes take it. */
export const NETWORK_ID = /^(lan|tailnet)-[0-9a-f]{16}$/

export interface NetworkWatcherDeps {
  /** Per LAN interface, `<gateway IP>|<gateway MAC>` ('' unknown). Cheap: read every check. */
  readGateways: (ifaces: readonly string[], interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>) => Promise<Map<string, string>>
  /** Per LAN interface, the Wi-Fi name where readable without a prompt. */
  readWifiNames?: (ifaces: readonly string[]) => Promise<Map<string, string>>
  /** Windows' category per interface (shown only). Slow: read at most every `slowCheckMs`. */
  readOsCategories?: (ifaces: readonly string[]) => Promise<Map<string, 'private' | 'public'>>
  slowCheckMs: number
  now?: () => number
}

export interface NetworkReading {
  /** Candidate addresses, each with its network id and, when that network is not allowed, a refusal. */
  candidates: AddressCandidate[]
  networks: NetworkView[]
}

export class NetworkWatcher {
  private keys = new Map<string, string>()
  private gatewayIds = new Map<string, string>()
  private osCategories = new Map<string, 'private' | 'public'>()
  private osAt = 0

  constructor(private readonly deps: NetworkWatcherDeps) {}

  /**
   * Identify the networks now and apply `allowed`. `beforeChange` gets the
   * interfaces whose network changed (another gateway, another subnet,
   * another Wi-Fi, other addresses) before anything else: close their
   * listeners at once.
   */
  async read(input: {
    interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>
    tailscaleIps: ReadonlySet<string>
    tailnet: string | null
    allowed: readonly AllowedNetwork[]
    only?: readonly string[]
    beforeChange?: (changed: string[]) => Promise<void>
  }): Promise<NetworkReading> {
    const now = (this.deps.now ?? Date.now)()
    const candidates = addressCandidates({ interfaces: input.interfaces, tailscaleIps: input.tailscaleIps, ...(input.only ? { only: input.only } : {}) })
    const lanIfaces = [...new Set(candidates.filter(c => c.kind === 'lan').map(c => c.iface))]
    const [gateways, ssids] = await Promise.all([
      this.deps.readGateways(lanIfaces, input.interfaces),
      this.deps.readWifiNames ? this.deps.readWifiNames(lanIfaces).catch(() => new Map<string, string>()) : Promise.resolve(new Map<string, string>()),
    ])
    const ids = new Map<string, string | null>()
    const keys = new Map<string, string>()
    for (const iface of lanIfaces) {
      const gateway = mergeGatewayIdentity(this.gatewayIds.get(iface), gateways.get(iface) ?? '')
      this.gatewayIds.set(iface, gateway)
      const mac = gateway.split('|')[1] ?? ''
      const info = (input.interfaces[iface] ?? []).find(i => !i.internal && isIP(i.address) === 4) ?? (input.interfaces[iface] ?? []).find(i => !i.internal)
      const subnet = info ? subnetOf(info) : null
      const id = mac && subnet ? lanNetworkId(mac, subnet, ssids.get(iface) ?? null) : null
      ids.set(iface, id)
      const addresses = candidates.filter(c => c.iface === iface).map(c => c.address).join(',')
      keys.set(iface, `${addresses}|${id ?? ''}`)
    }
    const changed = lanIfaces.filter(iface => this.keys.has(iface) && this.keys.get(iface) !== keys.get(iface))
    if (changed.length > 0) await input.beforeChange?.(changed)
    this.keys = keys
    if (this.deps.readOsCategories && (changed.length > 0 || now - this.osAt >= this.deps.slowCheckMs)) {
      this.osCategories = await this.deps.readOsCategories(lanIfaces).catch(() => new Map())
      this.osAt = now
    }
    const allowed = new Set(input.allowed.map(n => n.id))
    const tailnetId = input.tailnet ? tailnetNetworkId(input.tailnet) : null
    for (const c of candidates) {
      c.networkId = c.kind === 'tailnet' ? tailnetId : ids.get(c.iface) ?? null
      c.refusal = c.networkId && allowed.has(c.networkId) ? null : NOT_ALLOWED_SENTENCE
    }
    const networks: NetworkView[] = []
    const byId = new Map<string, NetworkView>()
    for (const c of candidates) {
      const key = c.networkId ?? `unidentified:${c.kind}:${c.iface}`
      let view = byId.get(key)
      if (!view) {
        const ssid = c.kind === 'lan' ? ssids.get(c.iface) ?? null : null
        const subnet = c.kind === 'lan' ? (() => { const i = (input.interfaces[c.iface] ?? []).find(x => x.address.toLowerCase() === c.address); return i ? subnetOf(i) : null })() : null
        view = {
          id: c.networkId,
          kind: c.kind,
          label: c.kind === 'tailnet' ? `Tailnet ${input.tailnet ?? '(unknown)'}` : `${ssid ?? c.iface}${subnet ? ` (${subnet})` : ''}`,
          allowed: !!c.networkId && allowed.has(c.networkId),
          osCategory: c.kind === 'tailnet' ? 'private' : this.osCategories.get(c.iface) ?? 'unknown',
          ifaces: [],
          addresses: [],
        }
        byId.set(key, view)
        networks.push(view)
      }
      if (!view.ifaces.includes(c.iface)) view.ifaces.push(c.iface)
      view.addresses.push(c.address)
    }
    return { candidates, networks }
  }
}
