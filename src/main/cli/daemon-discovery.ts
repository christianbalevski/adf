/**
 * Find ADF daemons that allow other computers to connect
 * (docs/design/remote-access.md §5.1, §5.2, §9.2): `_adf-daemon._tcp` on
 * the LAN (mDNS), and `GET /remote/hello` on each online tailnet peer
 * (multicast does not cross WireGuard). Entries merge by fingerprint; a
 * tailnet address wins over a LAN one (WireGuard encrypts it).
 */

import { Bonjour, type Service } from 'bonjour-service'
import type { RemoteHello } from '../../shared/types/remote-access.types'
import { DAEMON_SERVICE_TYPE } from '../daemon/remote-access/announcer'
import { defaultExec, type Exec } from '../daemon/remote-access/network-category'
import { TailscaleClient } from '../daemon/remote-access/tailscale'
import { DEFAULT_DAEMON_PORT } from './daemon-url'

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

/** GET <url>/remote/hello with a timeout; null when it is not an ADF daemon with remote access on. */
export async function fetchHello(url: string, fetchImpl: typeof fetch = fetch, timeoutMs = 2_500): Promise<RemoteHello | null> {
  try {
    const res = await fetchImpl(`${url.replace(/\/+$/, '')}/remote/hello`, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' })
    if (!res.ok) return null
    const body = await res.json() as Partial<RemoteHello>
    return body && body.v === 1 && typeof body.name === 'string' && typeof body.fingerprint === 'string' ? body as RemoteHello : null
  } catch {
    return null
  }
}

/** mDNS: browse `_adf-daemon._tcp` for `ms`. */
export async function browseMdns(ms: number): Promise<DiscoveredDaemon[]> {
  const found = new Map<string, DiscoveredDaemon>()
  let bonjour: Bonjour | null = null
  try {
    bonjour = new Bonjour()
    const browser = bonjour.find({ type: DAEMON_SERVICE_TYPE, protocol: 'tcp' })
    browser.on('up', (service: Service) => {
      const txt = (service.txt ?? {}) as Record<string, unknown>
      const fp = typeof txt.fp === 'string' ? txt.fp : null
      const v4 = (service.addresses ?? []).find(a => !a.includes(':'))
      const address = v4 ?? service.addresses?.[0] ?? service.host
      if (!fp || !address) return
      found.set(fp, {
        name: service.name,
        fingerprint: fp,
        url: `http://${hostPart(address)}:${service.port}`,
        kind: 'lan',
        pairingOpen: txt.pair === '1' || txt.pair === 1 || txt.pair === true,
      })
    })
    await new Promise(resolve => setTimeout(resolve, ms))
  } catch {
    // mDNS is best effort; tailnet peers and a typed address still work.
  } finally {
    try { bonjour?.destroy() } catch { /* gone */ }
  }
  return [...found.values()]
}

/** Tailnet: online peers of `tailscale status --json`, probed on the daemon port. */
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

export async function discoverDaemons(ms = 3_000): Promise<DiscoveredDaemon[]> {
  const [lan, tailnet] = await Promise.all([browseMdns(ms), probeTailnet()])
  return mergeDiscovered([lan, tailnet])
}
