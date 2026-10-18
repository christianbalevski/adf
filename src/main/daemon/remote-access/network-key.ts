/**
 * Which networks this computer is on, and whether the user allowed each
 * (docs/design/remote-access.md §3.3.1, owner decision 2026-10-18 b: never
 * listen without the user's consent, given once per network, the same on
 * every OS). Remote access and the mesh's LAN mode use this one module.
 *
 * - LAN network: identified by its default gateway's MAC address and the
 *   subnet, plus the Wi-Fi name where it is readable without a permission
 *   prompt. The MAC is never carried from a previous check (final check):
 *   every check probes ARP first (readGatewayIdentities); a gateway that
 *   gives no MAC after the probe leaves the network unidentified, and an
 *   unidentified network never matches consent.
 * - Tailnet: identified by the tailnet's name.
 * - A changed network on an interface closes its listeners at once
 *   (`beforeChange`), before anything else is read.
 */

import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import type { NetworkInterfaceInfo } from 'node:os'
import type { AllowedNetwork, NetworkView } from '../../../shared/types/remote-access.types'
import { addressCandidates, NOT_ALLOWED_SENTENCE, type AddressCandidate } from './addresses'


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

/** The label of a network that cannot be identified (no gateway MAC on this link yet). */
export const UNIDENTIFIED_NETWORK = 'Unidentified network'

/** A network id as routes take it. */
export const NETWORK_ID = /^(lan|tailnet)-[0-9a-f]{16}$/

export interface NetworkWatcherDeps {
  /** Per LAN interface, `<gateway IP>|<gateway MAC>` ('' unknown), read after an ARP probe. Read every check; never merged with an earlier read. */
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
      const info = (input.interfaces[iface] ?? []).find(i => !i.internal && isIP(i.address) === 4) ?? (input.interfaces[iface] ?? []).find(i => !i.internal)
      const subnet = info ? subnetOf(info) : null
      const addresses = candidates.filter(c => c.iface === iface).map(c => c.address).join(',')
      // Fail closed (final check): only this check's MAC, read after the probe, identifies the network.
      // A switch between two checks, or sleep and wake, cannot be seen, so nothing is carried over.
      const mac = (gateways.get(iface) ?? '').split('|')[1] ?? ''
      const id = mac && subnet ? lanNetworkId(mac, subnet, ssids.get(iface) ?? null) : null
      ids.set(iface, id)
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
          label: !c.networkId ? UNIDENTIFIED_NETWORK : c.kind === 'tailnet' ? `Tailnet ${input.tailnet}` : `${ssid ?? c.iface}${subnet ? ` (${subnet})` : ''}`,
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
