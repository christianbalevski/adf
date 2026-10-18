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
import { DEFAULT_DAEMON_PORT, localProofHeaders } from './daemon-url'

export { fetchHello }

export interface DiscoveredDaemon {
  name: string
  fingerprint: string
  url: string
  kind: 'lan' | 'tailnet'
  pairingOpen: boolean
  /** One fingerprint at this many addresses (discovery review 3): each is listed; null/absent when not. */
  clash?: number | null
}

function hostPart(address: string): string {
  return address.includes(':') ? `[${address}]` : address
}

/** The remote-access half of the feed. */
export function daemonsOf(peers: NetworkPeer[]): DiscoveredDaemon[] {
  return peers.flatMap((p) => p.remote
    ? [{ name: p.name, fingerprint: p.remote.fingerprint, url: p.remote.url, kind: p.remote.kind, pairingOpen: p.remote.pairingOpen, clash: p.remote.clash ?? null }]
    : [])
}

/**
 * This process's own feed for `ms` (no daemon here): one mDNS browse, and the
 * tailnet hellos fed into the same service, so a LAN and a tailnet sighting
 * merge by the same rule as the daemon's (the LAN record lists the tailnet IP).
 */
export async function browseMdns(ms: number, createMdns: () => MdnsService = () => new MdnsService(), tailnet: () => Promise<DiscoveredDaemon[]> = async () => []): Promise<DiscoveredDaemon[]> {
  const service = createMdns()
  try {
    // Browse only: nothing is announced from here.
    await service.start({ announce: false, browse: true, port: 0, runtimeId: `cli-browse-${randomBytes(6).toString('hex')}` })
    const [found] = await Promise.all([tailnet().catch(() => []), new Promise(resolve => setTimeout(resolve, ms))])
    for (const d of found) {
      try {
        const url = new URL(d.url)
        service.upsertTailnetDaemon({ fingerprint: d.fingerprint, name: d.name, address: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port) || DEFAULT_DAEMON_PORT, pairingOpen: d.pairingOpen })
      } catch { /* not a URL */ }
    }
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

/**
 * The lists by fingerprint and address: the same address twice is one
 * entry; two addresses with one fingerprint are never merged on the
 * fingerprint alone (discovery re-check): both listed, flagged. A LAN and a
 * tailnet sighting of one host are merged before this, by the feed, only
 * when the host's LAN record lists that tailnet IP.
 */
export function mergeDiscovered(lists: DiscoveredDaemon[][]): DiscoveredDaemon[] {
  const byFp = new Map<string, Map<string, DiscoveredDaemon>>()
  for (const d of lists.flat()) {
    const urls = byFp.get(d.fingerprint) ?? new Map<string, DiscoveredDaemon>()
    const existing = urls.get(d.url)
    urls.set(d.url, existing ? { ...existing, pairingOpen: existing.pairingOpen || d.pairingOpen, clash: existing.clash ?? d.clash ?? null } : { ...d })
    byFp.set(d.fingerprint, urls)
  }
  const out: DiscoveredDaemon[] = []
  for (const urls of byFp.values()) {
    const all = [...urls.values()]
    if (all.length > 1 || all.some(d => (d.clash ?? 0) > 1)) {
      for (const d of all) out.push({ ...d, clash: Math.max(all.length, d.clash ?? 0) })
      continue
    }
    out.push({ ...all[0], clash: null })
  }
  return out.sort((a, b) => Number(b.pairingOpen) - Number(a.pairingOpen) || a.name.localeCompare(b.name) || a.url.localeCompare(b.url))
}

/** This computer's ADF daemon's feed, or null when none answers (GET /network/peers). */
export async function peersFromDaemon(daemon: { url: string; token: string }, ms: number, fetchImpl: typeof fetch = fetch, env: NodeJS.ProcessEnv = process.env): Promise<NetworkPeer[] | null> {
  try {
    const wait = Math.min(Math.max(ms, 0), 5_000)
    // A local-only route: this machine's proof goes with it (never to another host).
    const res = await fetchImpl(`${daemon.url.replace(/\/+$/, '')}/network/peers?wait=${wait}`, {
      headers: { Authorization: `Bearer ${daemon.token}`, Accept: 'application/json', ...localProofHeaders(daemon.url, '/network/peers', env) },
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
export async function discoverDaemons(ms = 3_000, opts: { localDaemon?: { url: string; token: string } | null; fetch?: typeof fetch; env?: NodeJS.ProcessEnv } = {}): Promise<DiscoveredDaemon[]> {
  if (opts.localDaemon) {
    const peers = await peersFromDaemon(opts.localDaemon, ms, opts.fetch, opts.env)
    if (peers) return mergeDiscovered([daemonsOf(peers)])
  }
  return mergeDiscovered([await browseMdns(ms, undefined, () => probeTailnet({ ...(opts.fetch ? { fetch: opts.fetch } : {}) }))])
}
