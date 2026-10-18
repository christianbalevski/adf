/**
 * Which addresses other computers may reach (docs/design/remote-access.md
 * §3.3): private LAN addresses on a private network, and Tailscale
 * addresses. Pure: the caller passes the interfaces, the Tailscale
 * addresses and the network categories it read.
 */

import { isIP } from 'node:net'
import type { NetworkInterfaceInfo } from 'node:os'
import { isCGNAT, isRFC1918, VIRTUAL_IFACE_RE, VIRTUAL_IFACE_WIN_RE } from '../../services/mdns-service'

export interface AddressCandidate {
  address: string
  family: 'IPv4' | 'IPv6'
  kind: 'lan' | 'tailnet'
  iface: string
  network: 'private' | 'public' | 'tailnet'
  /** Why it gets no listener even though it is a candidate (public network); null = listen. */
  refusal: string | null
}

export const PUBLIC_NETWORK_SENTENCE = 'Not reachable on this network (Public).'

export function isTailnetV6(address: string): boolean {
  return /^fd7a:115c:a1e0:/i.test(address)
}

export function isUlaV6(address: string): boolean {
  return /^f[cd][0-9a-f]{2}:/i.test(address)
}

export function isVirtualInterface(name: string): boolean {
  return VIRTUAL_IFACE_RE.test(name) || VIRTUAL_IFACE_WIN_RE.test(name)
}

export interface CandidateInputs {
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>
  /** `Self.TailscaleIPs` from `tailscale status --json`; empty without Tailscale. */
  tailscaleIps: ReadonlySet<string>
  /** Per interface name: private or public. Missing = public (unsure = not private, §3.3.1). */
  categories: ReadonlyMap<string, 'private' | 'public'>
  /** `remote-access.json` `addresses`: only these, still under every rule. */
  only?: readonly string[]
}

/**
 * Every address that may get a listener, with its network. Public-network
 * LAN addresses are returned with a refusal so the status can list them;
 * anything else (public IPs, link-local, carrier-grade NAT, virtual
 * adapters) is left out.
 */
export function addressCandidates(inputs: CandidateInputs): AddressCandidate[] {
  const out: AddressCandidate[] = []
  const seen = new Set<string>()
  const only = inputs.only ? new Set(inputs.only.map(a => a.toLowerCase())) : null
  for (const [iface, infos] of Object.entries(inputs.interfaces)) {
    for (const info of infos ?? []) {
      if (info.internal) continue
      const address = info.address.toLowerCase()
      const family: 'IPv4' | 'IPv6' = isIP(address) === 6 ? 'IPv6' : 'IPv4'
      if (family === 'IPv6' && address.startsWith('fe80')) continue
      if (seen.has(address) || (only && !only.has(address))) continue
      const tailnet = inputs.tailscaleIps.has(address)
      if (tailnet) {
        seen.add(address)
        out.push({ address, family, kind: 'tailnet', iface, network: 'tailnet', refusal: null })
        continue
      }
      // Carrier-grade NAT or Tailscale ranges Tailscale did not confirm: never bound.
      if (family === 'IPv4' && isCGNAT(address)) continue
      if (family === 'IPv6' && isTailnetV6(address)) continue
      if (isVirtualInterface(iface)) continue
      const lan = family === 'IPv4' ? isRFC1918(address) : isUlaV6(address)
      if (!lan) continue
      seen.add(address)
      const network = inputs.categories.get(iface) === 'private' ? 'private' : 'public'
      out.push({ address, family, kind: 'lan', iface, network, refusal: network === 'private' ? null : PUBLIC_NETWORK_SENTENCE })
    }
  }
  // Tailnet first, then IPv4 before IPv6, then by interface: a stable order for the status.
  return out.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'tailnet' ? -1 : 1)
    || (a.family === b.family ? 0 : a.family === 'IPv4' ? -1 : 1)
    || a.iface.localeCompare(b.iface)
    || a.address.localeCompare(b.address))
}

/** LAN interfaces (non-virtual, private address, not Tailscale): the ones a network category is needed for. */
export function lanInterfaceNames(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>, tailscaleIps: ReadonlySet<string>): string[] {
  const names = new Set<string>()
  for (const candidate of addressCandidates({ interfaces, tailscaleIps, categories: new Map() })) {
    if (candidate.kind === 'lan') names.add(candidate.iface)
  }
  return [...names]
}

/** URL host part: IPv6 in brackets. */
export function urlHost(address: string): string {
  return isIP(address) === 6 ? `[${address}]` : address
}
