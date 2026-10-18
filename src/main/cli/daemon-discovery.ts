/**
 * Find ADF daemons with remote access on, for `adf pair`
 * (docs/design/remote-access.md §5.1, §5.2, §9.2). The one discovery feed:
 * this computer's ADF daemon's (GET /network/peers) when it runs, the same
 * feed its mesh and Studio read; else this process's own (one mDNS browse of
 * `_adf-runtime._tcp` and the legacy `_adf-daemon._tcp`, and one tailnet
 * hello sweep). Entries merge by fingerprint; a tailnet address wins over a
 * LAN one (WireGuard encrypts it).
 */

import { randomBytes } from 'node:crypto'
import type { NetworkPeer } from '../../shared/types/remote-access.types'
import { MdnsService } from '../services/mdns-service'
import { fetchHello } from '../services/remote-hello'
import { defaultExec, type Exec } from '../daemon/remote-access/network-category'
import { TailscaleClient } from '../daemon/remote-access/tailscale'
import { DEFAULT_DAEMON_PORT } from './daemon-url'

export { fetchHello }

export interface DiscoveredDaemon {
  name: string
  fingerprint: string
  url: string
  kind: 'lan' | 'tailnet'
  pairingOpen: boolean
}

function hostPart(address: string): string {
  return address.includes(':') ? `[${address}]` : address
}

/** The remote-access half of the feed. */
export function daemonsOf(peers: NetworkPeer[]): DiscoveredDaemon[] {
  return peers.flatMap((p) => p.remote
    ? [{ name: p.name, fingerprint: p.remote.fingerprint, url: p.remote.url, kind: p.remote.kind, pairingOpen: p.remote.pairingOpen }]
    : [])
}

/** This process's own mDNS browse for `ms` (no daemon here): the feed's LAN half. */
export async function browseMdns(ms: number, createMdns: () => MdnsService = () => new MdnsService()): Promise<DiscoveredDaemon[]> {
  const service = createMdns()
  try {
    // Browse only: nothing is announced from here.
    await service.start({ announce: false, browse: true, port: 0, runtimeId: `cli-browse-${randomBytes(6).toString('hex')}` })
    await new Promise(resolve => setTimeout(resolve, ms))
    return daemonsOf(service.peers())
  } catch {
    // mDNS is best effort; tailnet peers and a typed address still work.
    return []
  } finally {
    await service.stop().catch(() => {})
  }
}

/** Tailnet: online peers of `tailscale status --json`, probed on the daemon port (GET /remote/hello). */
export async function probeTailnet(opts: { exec?: Exec; fetch?: typeof fetch; port?: number } = {}): Promise<DiscoveredDaemon[]> {
  const exec = opts.exec ?? defaultExec
  const client = new TailscaleClient(exec)
  const self = await client.self()
  if (self.state !== 'running') return []
  let peers: Array<{ TailscaleIPs?: unknown; Online?: unknown }> = []
  try {
    const out = await exec(client.command ?? 'tailscale', ['status', '--json'])
    peers = Object.values((JSON.parse(out) as { Peer?: Record<string, { TailscaleIPs?: unknown; Online?: unknown }> }).Peer ?? {})
  } catch {
    return []
  }
  const port = opts.port ?? DEFAULT_DAEMON_PORT
  const probes = peers
    .filter(p => p.Online === true && Array.isArray(p.TailscaleIPs) && typeof p.TailscaleIPs[0] === 'string')
    .map(async (p) => {
      const ip = (p.TailscaleIPs as string[]).find(a => !a.includes(':')) ?? (p.TailscaleIPs as string[])[0]
      const url = `http://${hostPart(ip)}:${port}`
      const hello = await fetchHello(url, opts.fetch)
      const found: DiscoveredDaemon | null = hello ? { name: hello.name, fingerprint: hello.fingerprint, url, kind: 'tailnet', pairingOpen: hello.pairingOpen } : null
      return found
    })
  return (await Promise.all(probes)).filter((d): d is DiscoveredDaemon => d !== null)
}

/** Both sources, merged by fingerprint (tailnet first). */
export function mergeDiscovered(lists: DiscoveredDaemon[][]): DiscoveredDaemon[] {
  const byFp = new Map<string, DiscoveredDaemon>()
  for (const d of lists.flat()) {
    const existing = byFp.get(d.fingerprint)
    if (!existing || (existing.kind === 'lan' && d.kind === 'tailnet')) {
      byFp.set(d.fingerprint, { ...d, pairingOpen: d.pairingOpen || (existing?.pairingOpen ?? false) })
    } else if (d.pairingOpen) {
      existing.pairingOpen = true
    }
  }
  return [...byFp.values()].sort((a, b) => Number(b.pairingOpen) - Number(a.pairingOpen) || a.name.localeCompare(b.name))
}

/** This computer's ADF daemon's feed, or null when none answers (GET /network/peers). */
export async function peersFromDaemon(daemon: { url: string; token: string }, ms: number, fetchImpl: typeof fetch = fetch): Promise<NetworkPeer[] | null> {
  try {
    const wait = Math.min(Math.max(ms, 0), 5_000)
    const res = await fetchImpl(`${daemon.url.replace(/\/+$/, '')}/network/peers?wait=${wait}`, {
      headers: { Authorization: `Bearer ${daemon.token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(wait + 5_000),
    })
    if (!res.ok) return null
    const body = await res.json() as { peers?: unknown }
    return Array.isArray(body.peers) ? body.peers as NetworkPeer[] : null
  } catch {
    return null
  }
}

/**
 * The daemons `adf pair` offers: this computer's ADF daemon's feed when it
 * runs (one browser, one sweep per computer), else this process's own.
 */
export async function discoverDaemons(ms = 3_000, opts: { localDaemon?: { url: string; token: string } | null; fetch?: typeof fetch } = {}): Promise<DiscoveredDaemon[]> {
  if (opts.localDaemon) {
    const peers = await peersFromDaemon(opts.localDaemon, ms, opts.fetch)
    if (peers) return mergeDiscovered([daemonsOf(peers)])
  }
  const [lan, tailnet] = await Promise.all([browseMdns(ms), probeTailnet({ ...(opts.fetch ? { fetch: opts.fetch } : {}) })])
  return mergeDiscovered([lan, tailnet])
}
