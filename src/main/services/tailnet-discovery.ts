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
/**
 * Backoff for probes that failed without a confident "no": timeouts and
 * unreachable errors are usually the LINK's fault (weak hotspot, mid-roam),
 * not proof the peer runs no runtime. Shorter than the sweep interval, so
 * the next sweep retries — a hotspot hiccup costs one cycle, not 5 minutes.
 * A clean ECONNREFUSED (host up, nothing listening) keeps the long backoff.
 */
const TRANSIENT_BACKOFF_MS = 30_000
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
  private tailscaleRecheckAt = 0

  constructor(
    private opts: {
      getPorts: () => number[]
      /** Tailnet sweep enabled (manual peers are always probed) */
      isTailnetEnabled: () => boolean
      getManualPeers: () => string[]
      /** Current route for a runtime, if any — used to decide takeover. */
      getExistingRoute: (runtimeId: string) => { url: string; source?: string } | undefined
      /** `force` = replace even an mDNS-sourced route (it was probed dead). */
      onPeer: (peer: ExternalPeer, opts: { force: boolean }) => void
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

  /** Immediate re-probe (manual refresh button) — no staleness gate, awaited
   *  so the caller can return post-sweep results. */
  sweepNow(): Promise<void> {
    return this.sweep()
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
          const { body: res, transient } = await this.probe(t.addr, t.port)
          if (!res?.runtime_id) {
            this.refusedUntil.set(key, now + (transient ? TRANSIENT_BACKOFF_MS : REFUSAL_BACKOFF_MS))
            return
          }
          this.refusedUntil.delete(key)
          seen.add(res.runtime_id)
          this.misses.set(res.runtime_id, 0)
          const url = `http://${wrap6(t.addr)}:${t.port}`

          // An mDNS route to the same runtime normally wins (same broadcast
          // domain beats overlay). But mDNS entries are only ever removed by
          // goodbye packets — after a network move the dead LAN entry lingers
          // forever. Probe it: still answering → leave it; dead → take over.
          let force = false
          const existing = this.opts.getExistingRoute(res.runtime_id)
          if (existing && (existing.source ?? 'mdns') === 'mdns' && existing.url !== url) {
            const alive = await this.isRouteAlive(existing.url, res.runtime_id)
            if (alive) return
            force = true
            console.log(`[tailnet] mDNS route ${existing.url} dead — overlay route ${url} takes over`)
          }

          this.opts.onPeer({
            runtime_id: res.runtime_id,
            runtime_did: res.runtime_did,
            proto: res.proto,
            host: t.host,
            port: t.port,
            url,
            source: t.source
          }, { force })
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

  /**
   * Is an existing route's URL still answering as the expected runtime?
   * Shares the refusal-backoff map so a dead LAN URL costs one 2.5s timeout
   * per 5 minutes, not per sweep.
   */
  private async isRouteAlive(url: string, expectedRuntimeId: string): Promise<boolean> {
    let addr: string, port: number
    try {
      const parsed = new URL(url)
      addr = parsed.hostname
      port = parsed.port ? parseInt(parsed.port, 10) : 80
    } catch {
      return false
    }
    const key = `${addr}:${port}`
    const now = Date.now()
    const backoff = this.refusedUntil.get(key)
    if (backoff && backoff > now) return false
    const { body: res, transient } = await this.probe(addr, port)
    if (res?.runtime_id === expectedRuntimeId) {
      this.refusedUntil.delete(key)
      return true
    }
    this.refusedUntil.set(key, now + (transient ? TRANSIENT_BACKOFF_MS : REFUSAL_BACKOFF_MS))
    return false
  }

  /** `transient: true` = failure that doesn't prove absence (timeout, unreachable). */
  private async probe(
    addr: string,
    port: number
  ): Promise<{ body: { runtime_id?: string; runtime_did?: string; proto?: string } | null; transient: boolean }> {
    try {
      const res = await fetch(`http://${wrap6(addr)}:${port}/mesh/ping`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
      })
      if (!res.ok) return { body: null, transient: false }
      const body = (await res.json()) as { runtime_id?: string; runtime_did?: string; proto?: string }
      return { body: typeof body?.runtime_id === 'string' && body.runtime_id.length > 0 ? body : null, transient: false }
    } catch (err) {
      const cause = (err as Error & { cause?: unknown }).cause as
        | { code?: string; errors?: { code?: string }[] }
        | undefined
      const code = cause?.code ?? cause?.errors?.find((e) => e.code)?.code
      return { body: null, transient: code !== 'ECONNREFUSED' }
    }
  }

  private async findTailscale(): Promise<string | null> {
    // A found binary is cached forever; a miss is retried every 5 minutes —
    // the CLI may appear later (Tailscale installed/launched after the app).
    if (typeof this.tailscaleBin === 'string') return this.tailscaleBin
    if (this.tailscaleBin === null && Date.now() < this.tailscaleRecheckAt) return null
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
    this.tailscaleRecheckAt = Date.now() + REFUSAL_BACKOFF_MS
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
