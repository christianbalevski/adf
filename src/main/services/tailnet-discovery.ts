import { execFile } from 'child_process'

/**
 * Peer discovery beyond the broadcast domain. mDNS is multicast and multicast
 * does not traverse WireGuard, so a friend's runtime on your tailnet can
 * never *announce* to you — but it's perfectly reachable. Two extra sources
 * feed the same peer table the map and message routing already read:
 *
 *  - Tailnet sweep: read the machine's own view of the tailnet from the
 *    local Tailscale daemon (`tailscale status --json` — no keys, no admin
 *    API), then probe each online peer's address for an ADF runtime via
 *    `GET /mesh/ping`.
 *  - Manual peers: a Settings list of host:port entries — the universal
 *    fallback for static IPs, port-forwards, or tailnets without the CLI.
 *
 * Probes are cheap (one small GET), deduped per sweep, and refused addresses
 * back off for 5 minutes. Sweeps run every 45s while started, plus an
 * `ensureFresh()` hook the peer-list IPC calls so a freshly added manual
 * peer appears within seconds, not a full cycle.
 */

const SWEEP_INTERVAL_MS = 45_000
const FRESH_WINDOW_MS = 30_000
const PROBE_TIMEOUT_MS = 2_500
const REFUSAL_BACKOFF_MS = 5 * 60_000
/** Consecutive missed sweeps before an external peer is expired. */
const MISS_LIMIT = 2

const TAILSCALE_CANDIDATES =
  process.platform === 'win32'
    ? ['tailscale', 'C:\\Program Files\\Tailscale\\tailscale.exe']
    : [
        'tailscale',
        '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
        '/opt/homebrew/bin/tailscale',
        '/usr/local/bin/tailscale'
      ]

export interface ExternalPeer {
  runtime_id: string
  runtime_did?: string
  proto?: string
  host: string
  port: number
  url: string
  source: 'tailnet' | 'manual'
}

interface ProbeTarget {
  host: string
  addr: string
  port: number
  source: 'tailnet' | 'manual'
}

function execOut(bin: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout)
    })
  })
}

const wrap6 = (addr: string): string => (addr.includes(':') ? `[${addr}]` : addr)

/** "host", "host:port", "http://host:port" → probe target pieces */
export function parseManualPeer(raw: string, defaultPort: number): { addr: string; port: number } | null {
  let s = raw.trim()
  if (!s) return null
  s = s.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  // [v6]:port
  const v6 = s.match(/^\[([^\]]+)\](?::(\d+))?$/)
  if (v6) return { addr: v6[1], port: v6[2] ? parseInt(v6[2], 10) : defaultPort }
  const lastColon = s.lastIndexOf(':')
  // A bare IPv6 literal has 2+ colons and no brackets — treat whole as addr
  if (lastColon > -1 && s.indexOf(':') === lastColon) {
    const port = parseInt(s.slice(lastColon + 1), 10)
    if (Number.isFinite(port)) return { addr: s.slice(0, lastColon), port }
  }
  return { addr: s, port: defaultPort }
}

export class TailnetDiscovery {
  private timer: NodeJS.Timeout | null = null
  private sweeping = false
  private lastSweepAt = 0
  private refusedUntil = new Map<string, number>()
  /** runtime_id → miss counter for expiry */
  private misses = new Map<string, number>()
  private tailscaleBin: string | null | undefined

  constructor(
    private opts: {
      getPorts: () => number[]
      /** Tailnet sweep enabled (manual peers are always probed) */
      isTailnetEnabled: () => boolean
      getManualPeers: () => string[]
      onPeer: (peer: ExternalPeer) => void
      onExpire: (runtimeId: string) => void
    }
  ) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS)
    void this.sweep()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Cheap staleness hook for hot paths (the 5s peer-list poll). */
  ensureFresh(): void {
    if (!this.timer) return
    if (Date.now() - this.lastSweepAt > FRESH_WINDOW_MS) void this.sweep()
  }

  private async sweep(): Promise<void> {
    if (this.sweeping) return
    this.sweeping = true
    this.lastSweepAt = Date.now()
    try {
      const ports = this.opts.getPorts()
      const defaultPort = ports[0] ?? 7295
      const targets = new Map<string, ProbeTarget>()

      for (const raw of this.opts.getManualPeers()) {
        const parsed = parseManualPeer(raw, defaultPort)
        if (!parsed) continue
        targets.set(`${parsed.addr}:${parsed.port}`, {
          host: parsed.addr,
          addr: parsed.addr,
          port: parsed.port,
          source: 'manual'
        })
      }

      if (this.opts.isTailnetEnabled()) {
        for (const peer of await this.tailnetPeers()) {
          for (const port of ports) {
            const key = `${peer.address}:${port}`
            if (!targets.has(key)) {
              targets.set(key, { host: peer.hostname || peer.address, addr: peer.address, port, source: 'tailnet' })
            }
          }
        }
      }

      const now = Date.now()
      const seen = new Set<string>()
      await Promise.all(
        [...targets.values()].map(async (t) => {
          const key = `${t.addr}:${t.port}`
          const backoff = this.refusedUntil.get(key)
          if (backoff && backoff > now) return
          const res = await this.probe(t.addr, t.port)
          if (!res?.runtime_id) {
            this.refusedUntil.set(key, now + REFUSAL_BACKOFF_MS)
            return
          }
          this.refusedUntil.delete(key)
          seen.add(res.runtime_id)
          this.misses.set(res.runtime_id, 0)
          this.opts.onPeer({
            runtime_id: res.runtime_id,
            runtime_did: res.runtime_did,
            proto: res.proto,
            host: t.host,
            port: t.port,
            url: `http://${wrap6(t.addr)}:${t.port}`,
            source: t.source
          })
        })
      )

      // Expire peers we've stopped seeing — two consecutive quiet sweeps so a
      // single slow probe doesn't blink a healthy peer off the map
      for (const [runtimeId, count] of this.misses) {
        if (seen.has(runtimeId)) continue
        const next = count + 1
        if (next >= MISS_LIMIT) {
          this.misses.delete(runtimeId)
          this.opts.onExpire(runtimeId)
        } else {
          this.misses.set(runtimeId, next)
        }
      }
    } catch (err) {
      console.error('[tailnet] sweep failed:', err)
    } finally {
      this.sweeping = false
    }
  }

  private async probe(addr: string, port: number): Promise<{ runtime_id?: string; runtime_did?: string; proto?: string } | null> {
    try {
      const res = await fetch(`http://${wrap6(addr)}:${port}/mesh/ping`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
      })
      if (!res.ok) return null
      const body = (await res.json()) as { runtime_id?: string; runtime_did?: string; proto?: string }
      return typeof body?.runtime_id === 'string' && body.runtime_id.length > 0 ? body : null
    } catch {
      return null
    }
  }

  private async findTailscale(): Promise<string | null> {
    if (this.tailscaleBin !== undefined) return this.tailscaleBin
    for (const candidate of TAILSCALE_CANDIDATES) {
      try {
        await execOut(candidate, ['version'], 3_000)
        this.tailscaleBin = candidate
        console.log(`[tailnet] tailscale CLI found: ${candidate}`)
        return candidate
      } catch {
        /* try next */
      }
    }
    this.tailscaleBin = null
    return null
  }

  private async tailnetPeers(): Promise<{ address: string; hostname: string }[]> {
    const bin = await this.findTailscale()
    if (!bin) return []
    try {
      const out = await execOut(bin, ['status', '--json'], 5_000)
      const status = JSON.parse(out) as {
        Peer?: Record<string, { TailscaleIPs?: string[]; HostName?: string; DNSName?: string; Online?: boolean }>
      }
      const peers = Object.values(status.Peer ?? {})
      return peers
        .filter((p) => p.Online !== false)
        .map((p) => ({
          // Prefer the IPv4 (100.x) — shorter URLs, and classifyRemote's
          // CGNAT branch keys on it
          address: (p.TailscaleIPs ?? []).find((ip) => ip.includes('.')) ?? p.TailscaleIPs?.[0] ?? '',
          hostname: (p.HostName || p.DNSName || '').replace(/\.$/, '')
        }))
        .filter((p) => p.address.length > 0)
    } catch (err) {
      console.log('[tailnet] status read failed (daemon down?):', err instanceof Error ? err.message : err)
      return []
    }
  }
}
