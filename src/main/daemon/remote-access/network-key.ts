/**
 * Which network a LAN interface is on, for remote access and the mesh's LAN
 * mode (docs/design/remote-access.md §3.3.1, security review item 2): a
 * network category holds only for the interface's addresses and default
 * gateway (IP and MAC) at the read. One module, so the daemon's listeners
 * and the mesh follow the same rule (re-review 2).
 */

import type { NetworkInterfaceInfo } from 'node:os'
import { addressCandidates, lanInterfaceNames } from './addresses'
import type { NetworkCategories } from './network-category'

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

export interface NetworkCategoryTrackerDeps {
  /** The category of each LAN interface (a command: slow). */
  readCategories: (ifaces: readonly string[]) => Promise<NetworkCategories>
  /** Per LAN interface, `<gateway IP>|<gateway MAC>`, '' unknown (cheap: read every check). */
  readGateways: (ifaces: readonly string[], interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>) => Promise<Map<string, string>>
  /** A category read is reused this long while every interface's key stays the same. */
  slowCheckMs: number
  now?: () => number
}

const EMPTY: NetworkCategories = { categories: new Map(), current: [], problem: null }

/**
 * The categories of the LAN interfaces, valid only for each interface's key
 * (its LAN addresses and merged gateway identity) at the read. A changed key
 * re-reads at once, and `beforeReread` gets the changed interfaces first so
 * the caller closes their listeners until the new read says private: a
 * network is never assumed private across a change.
 */
export class NetworkCategoryTracker {
  private current: NetworkCategories = EMPTY
  private keys = new Map<string, string>()
  private gatewayIds = new Map<string, string>()
  private at = 0

  constructor(private readonly deps: NetworkCategoryTrackerDeps) {}

  get categories(): NetworkCategories {
    return this.current
  }

  /** The next refresh re-reads (the owner marked a network private). */
  invalidate(): void {
    this.at = 0
  }

  async refresh(input: {
    interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>
    tailscaleIps: ReadonlySet<string>
    force?: boolean
    /** The interfaces whose network changed, before the slow re-read: close their LAN listeners. */
    beforeReread?: (changed: string[]) => Promise<void>
  }): Promise<NetworkCategories> {
    const now = (this.deps.now ?? Date.now)()
    const lanIfaces = lanInterfaceNames(input.interfaces, input.tailscaleIps)
    const gateways = await this.deps.readGateways(lanIfaces, input.interfaces)
    const keys = new Map<string, string>()
    for (const c of addressCandidates({ interfaces: input.interfaces, tailscaleIps: input.tailscaleIps, categories: new Map() })) {
      if (c.kind === 'lan') keys.set(c.iface, [keys.get(c.iface), c.address].filter(Boolean).join(','))
    }
    for (const iface of lanIfaces) {
      // A MAC or gateway missing for a moment is unknown, not another network (re-review 1).
      const id = mergeGatewayIdentity(this.gatewayIds.get(iface), gateways.get(iface) ?? '')
      this.gatewayIds.set(iface, id)
      keys.set(iface, `${keys.get(iface) ?? ''}|${id}`)
    }
    const changed = lanIfaces.filter((iface) => this.keys.get(iface) !== keys.get(iface))
    if (input.force || changed.length > 0 || this.keys.size !== keys.size || now - this.at >= this.deps.slowCheckMs) {
      if (changed.length > 0) await input.beforeReread?.(changed)
      this.current = await this.deps.readCategories(lanIfaces)
      this.at = now
      this.keys = keys
    }
    return this.current
  }
}
