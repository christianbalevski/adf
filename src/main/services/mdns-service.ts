import { EventEmitter } from 'events'
import { hostname, networkInterfaces, type NetworkInterfaceInfo } from 'os'
import { Bonjour, type Service } from 'bonjour-service'

/**
 * Discovered remote ADF runtime, as seen through mDNS browsing.
 */
export interface DiscoveredRuntime {
  runtime_id: string
  runtime_did?: string
  proto: string
  directory_path: string
  /** Host as advertised in SRV (e.g. "host-b.local" or a literal IP). */
  host: string
  port: number
  /** Ready-to-use base URL (IPv6 bracketed). Append `/mesh/directory` etc. */
  url: string
  first_seen: number
  last_seen: number
}

export interface MdnsStartOptions {
  announce: boolean
  browse: boolean
  port: number
  runtimeId: string
  runtimeDid?: string
}

const SERVICE_TYPE = 'adf-runtime'
const PROTO_VERSION = 'alf/0.2'
const DIRECTORY_PATH = '/mesh/directory'
const GOODBYE_FLUSH_MS = 100

/**
 * Thin wrapper around `bonjour-service` that announces this runtime and
 * browses for peers.
 *
 * - Announcement is gated externally (caller passes `announce: true` only when
 *   at least one LAN-tier agent is configured).
 * - Browsing is gated on LAN binding (caller passes `browse: true` when the
 *   mesh server is bound to `0.0.0.0`).
 * - Self-skip is TXT-based (`runtime_id`) to avoid startup races where the
 *   browser would otherwise hear the local runtime's own announcement.
 * - `stop()` unpublishes, waits ~100ms for UDP goodbye packets to leave the
 *   socket, then destroys. Skipping the flush drops the goodbyes on aggressive
 *   shutdown and leaves peers with ghost entries for the full 120s TTL.
 * - Any library-init failure is logged once and emits `'unavailable'`; the
 *   runtime continues. mDNS is an optimization, not a requirement.
 */
export class MdnsService extends EventEmitter {
  private bonjour: Bonjour | null = null
  private published: Service | null = null
  private discovered = new Map<string, DiscoveredRuntime>()
  private selfRuntimeId: string | null = null

  /** True iff we've successfully published our own service record. */
  isAnnouncing(): boolean { return this.published !== null }

  async start(opts: MdnsStartOptions): Promise<void> {
    const iface = pickMdnsInterface()
    try {
      // bonjour-service's type decl doesn't include `interface`/`bind`, but it
      // forwards unknown opts straight to multicast-dns which accepts them.
      //
      // Passing `interface` scopes multicast join+setMulticastInterface to the
      // chosen NIC (avoids Windows' Hyper-V/VMware/Tailscale swallowing
      // multicast). But multicast-dns by default *also* binds the UDP socket
      // to that address, which on macOS silently drops inbound multicast —
      // the socket only sees unicast to its own IP. Explicit `bind: '0.0.0.0'`
      // keeps reception on all local addresses while outbound + membership
      // remain pinned to the picked interface.
      const bonjourOpts = iface
        ? { interface: iface, bind: '0.0.0.0' } as Record<string, unknown>
        : undefined
      this.bonjour = new Bonjour(bonjourOpts as never)
    } catch (err) {
      this.emitUnavailable(err)
      return
    }
    console.log(`[mdns] using interface=${iface ?? '<default/all>'} (bind=${iface ? '0.0.0.0' : '<default>'})`)

    this.selfRuntimeId = opts.runtimeId

    if (opts.announce) {
      try {
        const host = ensureLocalSuffix(hostname())
        const txt: Record<string, string> = {
          runtime_id: opts.runtimeId,
          proto: PROTO_VERSION,
          directory: DIRECTORY_PATH
        }
        if (opts.runtimeDid) txt.runtime_did = opts.runtimeDid
        this.published = this.bonjour.publish({
          name: `adf-${opts.runtimeId}`,
          type: SERVICE_TYPE,
          protocol: 'tcp',
          port: opts.port,
          host,
          txt
        })
        console.log(`[mdns] announcing _${SERVICE_TYPE}._tcp as ${host}:${opts.port} (runtime_id=${opts.runtimeId})`)
      } catch (err) {
        console.error('[mdns] publish failed:', err)
      }
    }

    if (opts.browse) {
      try {
        const browser = this.bonjour.find({ type: SERVICE_TYPE, protocol: 'tcp' })
        browser.on('up', (service: Service) => this.onServiceUp(service))
        browser.on('down', (service: Service) => this.onServiceDown(service))
        console.log(`[mdns] browsing for _${SERVICE_TYPE}._tcp peers`)
      } catch (err) {
        console.error('[mdns] browse failed:', err)
      }
    }
  }

  async stop(): Promise<void> {
    const b = this.bonjour
    if (!b) return
    this.bonjour = null

    try {
      await new Promise<void>((resolve) => {
        try {
          b.unpublishAll(() => resolve())
        } catch {
          resolve()
        }
      })
    } catch { /* best-effort */ }

    // UDP goodbye packets are fire-and-forget — give the socket time to flush
    // before destroying, otherwise peers keep the ghost entry for ~120s.
    await new Promise<void>((resolve) => setTimeout(resolve, GOODBYE_FLUSH_MS))

    try {
      b.destroy()
    } catch { /* best-effort */ }

    this.published = null
    this.discovered.clear()
  }

  getDiscoveredRuntimes(): DiscoveredRuntime[] {
    return [...this.discovered.values()]
  }

  // --- Internal ---

  private onServiceUp(service: Service): void {
    const txt = (service.txt ?? {}) as Record<string, unknown>
    const runtimeId = typeof txt.runtime_id === 'string' ? txt.runtime_id : undefined
    if (!runtimeId) return
    if (runtimeId === this.selfRuntimeId) return // self-skip (race-safe via TXT)

    const runtimeDid = typeof txt.runtime_did === 'string' ? txt.runtime_did : undefined
    const proto = typeof txt.proto === 'string' ? txt.proto : PROTO_VERSION
    const directoryPath = typeof txt.directory === 'string' ? txt.directory : DIRECTORY_PATH
    const host = service.host || service.fqdn || ''
    const port = service.port

    if (!host || !port) return

    const now = Date.now()
    const existing = this.discovered.get(runtimeId)
    const entry: DiscoveredRuntime = {
      runtime_id: runtimeId,
      runtime_did: runtimeDid,
      proto,
      directory_path: directoryPath,
      host,
      port,
      url: buildBaseUrl(host, port),
      first_seen: existing?.first_seen ?? now,
      last_seen: now
    }
    this.discovered.set(runtimeId, entry)
    this.emit('discovered', entry)
  }

  private onServiceDown(service: Service): void {
    const txt = (service.txt ?? {}) as Record<string, unknown>
    const runtimeId = typeof txt.runtime_id === 'string' ? txt.runtime_id : undefined
    if (!runtimeId) return
    const entry = this.discovered.get(runtimeId)
    if (!entry) return
    this.discovered.delete(runtimeId)
    this.emit('expired', entry)
  }

  private emitUnavailable(err: unknown): void {
    const reason = err instanceof Error ? err.message : String(err)
    console.log(`[mdns] unavailable: ${reason}. LAN discovery disabled; direct-address messaging still works.`)
    this.emit('unavailable', { reason })
  }
}

/**
 * Interface names that are never useful for mDNS. Virtual adapters (Hyper-V
 * vEthernet, WSL, VMware, Docker, Tailscale) silently absorb multicast on
 * Windows specifically, producing the asymmetric "I can see them, they can't
 * see me" symptom. macOS tun / awdl / bridge / ipsec are likewise noise.
 */
const VIRTUAL_IFACE_RE = /^(lo\d*|gif\d*|stf\d*|awdl\d*|llw\d*|anpi\d*|ap\d+|bridge\d*|utun\d*|ipsec\d*|ppp\d*|tun\d*|tap\d*|veth|vmnet\d*|vboxnet\d*|docker\d*|br-|wg\d*|tailscale\d*|zt[a-z0-9]+)/i
const VIRTUAL_IFACE_WIN_RE = /(vEthernet|VMware|VirtualBox|Hyper-?V|WSL|Bluetooth|Loopback|Npcap|Pseudo-|Wintun|Tailscale|TAP-Windows|OpenVPN)/i

function isRFC1918(ipv4: string): boolean {
  const [o1, o2] = ipv4.split('.').map(Number)
  if (o1 === 10) return true
  if (o1 === 172 && o2 >= 16 && o2 <= 31) return true
  if (o1 === 192 && o2 === 168) return true
  return false
}

function isCGNAT(ipv4: string): boolean {
  const [o1, o2] = ipv4.split('.').map(Number)
  // 100.64.0.0/10 — Tailscale lives here.
  return o1 === 100 && o2 >= 64 && o2 <= 127
}

/**
 * Pick the local IPv4 address that mDNS should bind to.
 *
 * Default path: skip virtual/VPN adapters by name, prefer a physical-looking
 * interface (en0, eth0, Wi-Fi, Ethernet) with an RFC1918 address.
 *
 * Escape hatch: `ADF_MDNS_INTERFACE=<ipv4>` forces a specific address — use
 * when the heuristic picks the wrong one (multiple RFC1918 NICs, unusual
 * adapter naming, etc.).
 *
 * Returns `undefined` when no candidate is found; caller should fall back
 * to the bonjour-service default (all-interfaces).
 */
export function pickMdnsInterface(
  ifaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
  envOverride: string | undefined = process.env.ADF_MDNS_INTERFACE
): string | undefined {
  if (envOverride && envOverride.trim()) return envOverride.trim()

  const candidates: Array<{ name: string; address: string; score: number }> = []
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs) continue
    if (VIRTUAL_IFACE_RE.test(name) || VIRTUAL_IFACE_WIN_RE.test(name)) continue
    for (const a of addrs) {
      if (a.internal) continue
      if (a.family !== 'IPv4') continue
      if (isCGNAT(a.address)) continue
      if (!isRFC1918(a.address)) continue
      let score = 0
      if (/^en\d|^eth\d|^wl/i.test(name)) score += 10        // unix-style physical
      if (/^(Ethernet|Wi-?Fi)/i.test(name)) score += 10       // windows-style physical
      candidates.push({ name, address: a.address, score })
    }
  }
  if (candidates.length === 0) return undefined
  candidates.sort((a, b) => b.score - a.score)
  return candidates[0].address
}

/** Ensure the advertised hostname is mDNS-resolvable by peers. */
export function ensureLocalSuffix(host: string): string {
  if (!host) return 'adf-runtime.local'
  const lower = host.toLowerCase()
  if (lower.endsWith('.local') || lower.endsWith('.local.')) return host
  // IPv6 literal — bonjour would reject with a host argument anyway; keep raw.
  if (host.includes(':')) return host
  return `${host}.local`
}

/** Build a URL base; wrap bare IPv6 addresses in brackets. */
export function buildBaseUrl(host: string, port: number): string {
  const isIpv6 = host.includes(':') && !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  const hostPart = isIpv6 ? `[${host}]` : host
  return `http://${hostPart}:${port}`
}
