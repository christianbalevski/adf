import { randomBytes } from 'crypto'
import { EventEmitter } from 'events'
import { hostname, networkInterfaces, type NetworkInterfaceInfo } from 'os'
import { Bonjour, type Service } from 'bonjour-service'
import type { NetworkPeer } from '../../shared/types/remote-access.types'
import { peerName, txtWithinBounds } from './peer-text'

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
  /** Ready-to-use base URL (IPv6 bracketed). Append `/agents` etc. */
  url: string
  first_seen: number
  last_seen: number
  /** How this peer was found. mDNS entries win over overlay/manual routes. */
  source?: 'mdns' | 'tailnet' | 'manual'
}

/**
 * Remote access in the one announcement (docs/design/remote-access.md §5.1):
 * only while remote access is on and a LAN address of an allowed network
 * listens. Never a token, a code, an owner DID, a path or a user name.
 */
export interface RemoteAnnouncement {
  /** The computer name (the runtime alias, else the host name). */
  name: string
  /** The ADF daemon's port. */
  port: number
  fingerprint: string
  pairingOpen: boolean
  /** The daemon's client API version. */
  api: string
  /** The runtime alias, when the user set one: the instance name of a record without the mesh. */
  alias?: string | null
}

export interface MdnsAnnouncement {
  /** Publish `_adf-runtime._tcp`: the mesh is LAN-visible, or remote access is on (or both). */
  announce: boolean
  /** The mesh is visible to other computers (TXT `mesh=0` when not). Default true. */
  mesh?: boolean
  remote?: RemoteAnnouncement | null
}

export interface MdnsStartOptions extends MdnsAnnouncement {
  browse: boolean
  port: number
  runtimeId: string
  runtimeDid?: string
  /** The LAN address to announce from (an address of an allowed network). Default: pickMdnsInterface(). */
  iface?: string
}

/**
 * One sighting of a daemon with remote access on. Kept per source (an
 * announcement instance, a tailnet address), never merged into another:
 * one fingerprint at two addresses is shown twice and flagged (discovery
 * review 3).
 */
interface RemoteSighting {
  /** Cleaned and bounded at intake (peerName). */
  name: string
  address: string
  port: number
  pairingOpen: boolean
  kind: 'lan' | 'tailnet'
  /** The runtime announcing it (`_adf-runtime._tcp` with its mesh), linking it to that runtime's mesh entry. */
  runtimeId: string | null
}

const SERVICE_TYPE = 'adf-runtime'
/**
 * The remote-access-only announcement of this PR's intermediate commits.
 * Still browsed for one release so such a daemon is found; never announced.
 * TODO(remove after the next release): LEGACY_DAEMON_SERVICE_TYPE and its browser.
 */
export const LEGACY_DAEMON_SERVICE_TYPE = 'adf-daemon'
/** Fingerprint as the daemon shows it: `XXXX-XXXX`, RFC 4648 base32. */
const FINGERPRINT = /^[A-Z2-7]{4}-[A-Z2-7]{4}$/
export const PROTO_VERSION = 'alf/0.2'
const DIRECTORY_PATH = '/agents'
const GOODBYE_FLUSH_MS = 100

/**
 * The one mDNS endpoint of a process (docs/design/remote-access.md §5.1):
 * one Bonjour instance, one `_adf-runtime._tcp` announcement carrying the
 * mesh and, while remote access is on, its fields, and one browser (plus
 * the legacy `_adf-daemon._tcp` one for a release). One cache feeds the
 * mesh peer list (`getDiscoveredRuntimes`), Studio's Discovered list and
 * `adf pair` (`peers()`); every change emits `peers_changed`.
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
  /** Remote-access sightings: fingerprint → source (`mdns:<instance>`, `legacy:<instance>`, `tailnet:<address>`) → sighting. */
  private remotes = new Map<string, Map<string, RemoteSighting>>()
  private selfRuntimeId: string | null = null
  private selfFingerprint: string | null = null
  private base: { port: number; runtimeId: string; runtimeDid?: string } | null = null
  private announced: string | null = null
  private announcedRemote = false
  /**
   * The instance name of a record without the mesh when no alias is set: random
   * per service, so per network (a network change restarts the service). Nothing
   * in such a record links it to this runtime on another network.
   */
  private readonly hiddenToken = randomBytes(6).toString('hex')

  /** True iff we've successfully published our own service record. */
  isAnnouncing(): boolean { return this.published !== null }

  /** True while the published record carries remote access. */
  isAnnouncingRemote(): boolean { return this.published !== null && this.announcedRemote }

  async start(opts: MdnsStartOptions): Promise<void> {
    const iface = opts.iface ?? pickMdnsInterface()
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
    this.base = { port: opts.port, runtimeId: opts.runtimeId, ...(opts.runtimeDid ? { runtimeDid: opts.runtimeDid } : {}) }

    await this.updateAnnouncement(opts)

    if (opts.browse) {
      try {
        const browser = this.bonjour.find({ type: SERVICE_TYPE, protocol: 'tcp' })
        browser.on('up', (service: Service) => this.onServiceUp(service))
        browser.on('down', (service: Service) => this.onServiceDown(service))
        // TODO(remove after the next release): daemons built from this PR's intermediate commits.
        const legacy = this.bonjour.find({ type: LEGACY_DAEMON_SERVICE_TYPE, protocol: 'tcp' })
        legacy.on('up', (service: Service) => this.onLegacyDaemonUp(service))
        legacy.on('down', (service: Service) => this.onLegacyDaemonDown(service))
        console.log(`[mdns] browsing for _${SERVICE_TYPE}._tcp peers (and legacy _${LEGACY_DAEMON_SERVICE_TYPE}._tcp)`)
      } catch (err) {
        console.error('[mdns] browse failed:', err)
      }
    }
  }

  /**
   * Publish, change or withdraw the one announcement without touching the
   * browser. bonjour-service cannot change a published TXT record, so a
   * change (pairing window opened, remote access on) re-publishes.
   */
  async updateAnnouncement(next: MdnsAnnouncement): Promise<void> {
    const bonjour = this.bonjour
    const base = this.base
    if (!bonjour || !base) return
    const mesh = next.mesh ?? true
    const remote = next.announce ? next.remote ?? null : null
    const key = next.announce ? JSON.stringify({ mesh, remote }) : null
    // Unchanged: nothing to do (a publish that did not take is not retried until something changes).
    if (key === this.announced) return
    if (this.published) {
      const old = this.published
      this.published = null
      await new Promise<void>((resolve) => {
        try { (old as unknown as { stop?: (cb: () => void) => void }).stop?.(() => resolve()) ?? resolve() } catch { resolve() }
        setTimeout(resolve, GOODBYE_FLUSH_MS)
      })
    }
    this.announced = key
    this.announcedRemote = false
    this.selfFingerprint = remote?.fingerprint ?? this.selfFingerprint
    if (!next.announce) return
    try {
      const host = ensureLocalSuffix(hostname())
      // The mesh hidden (discovery review 2): only the remote-access fields, and an instance name that
      // is not the runtime id, so a hidden runtime's id and DID cannot be followed from network to network.
      const hidden = !mesh && !!remote
      const txt: Record<string, string> = hidden ? {} : {
        runtime_id: base.runtimeId,
        proto: PROTO_VERSION,
        directory: DIRECTORY_PATH
      }
      if (!hidden && base.runtimeDid) txt.runtime_did = base.runtimeDid
      if (remote) {
        txt.v = '1'
        txt.fp = remote.fingerprint
        txt.pair = remote.pairingOpen ? '1' : '0'
        txt.daemon_port = String(remote.port)
        if (!hidden) {
          txt.api = remote.api
          txt.name = remote.name
        }
      }
      this.published = bonjour.publish({
        name: hidden ? remote!.alias || `adf-${this.hiddenToken}` : `adf-${base.runtimeId}`,
        type: SERVICE_TYPE,
        protocol: 'tcp',
        // A mesh that is not LAN-visible has nothing to reach on its port: the daemon's then.
        port: hidden ? remote!.port : base.port,
        host,
        txt,
        // The name is runtime_id-unique, so the only record that can hold
        // it is our OWN stale announcement from before a restart — probing
        // sees that ghost within its TTL and throws "Service name is
        // already in use on the network" (async, from multicast-dns'
        // onresponse, so no try/catch reaches it). Skip the probe.
        probe: false
      })
      this.announcedRemote = !!remote
      console.log(`[mdns] announcing _${SERVICE_TYPE}._tcp as ${host}:${base.port} (runtime_id=${base.runtimeId}${mesh ? '' : ', mesh not visible'}${remote ? `, remote access fp ${remote.fingerprint} on ${remote.port}, pairing ${remote.pairingOpen ? 'open' : 'closed'}` : ''})`)
    } catch (err) {
      console.error('[mdns] publish failed:', err)
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
    this.announced = null
    this.announcedRemote = false
    this.discovered.clear()
    this.remotes.clear()
  }

  /**
   * The feed: every ADF computer found, with both capabilities. The mesh
   * list is the entries with a mesh; Studio's Discovered list and
   * `adf pair` are the entries with remote access.
   */
  peers(): NetworkPeer[] {
    const out: NetworkPeer[] = []
    const byRuntime = new Map<string, { name: string; remote: NonNullable<NetworkPeer['remote']> }>()
    for (const [fp, sightings] of this.remotes) {
      const list = [...sightings.values()]
      if (list.length === 0) continue
      const lan = list.filter((s) => s.kind === 'lan')
      const tailnet = list.filter((s) => s.kind === 'tailnet')
      // One computer is seen at most once on the LAN and once on the tailnet; more is a clash.
      if (lan.length > 1 || tailnet.length > 1) {
        for (const s of list) {
          out.push({
            key: `fp:${fp}@${s.address}`,
            name: s.name,
            source: s.kind === 'tailnet' ? 'tailnet' : 'mdns',
            mesh: null,
            remote: { url: buildBaseUrl(s.address, s.port), port: s.port, fingerprint: fp, pairingOpen: s.pairingOpen, kind: s.kind, clash: list.length },
          })
        }
        continue
      }
      // The tailnet address wins (encrypted); the LAN one is the same computer.
      const best = tailnet[0] ?? lan[0]
      const remote: NonNullable<NetworkPeer['remote']> = { url: buildBaseUrl(best.address, best.port), port: best.port, fingerprint: fp, pairingOpen: list.some((s) => s.pairingOpen), kind: best.kind, clash: null }
      const runtimeId = list.find((s) => s.runtimeId)?.runtimeId ?? null
      const name = lan[0]?.name ?? best.name
      if (runtimeId && this.discovered.has(runtimeId)) byRuntime.set(runtimeId, { name, remote })
      else out.push({ key: runtimeId ?? `fp:${fp}`, name, source: tailnet[0] && !lan[0] ? 'tailnet' : 'mdns', mesh: null, remote })
    }
    for (const runtime of this.discovered.values()) {
      const linked = byRuntime.get(runtime.runtime_id)
      out.push({
        key: runtime.runtime_id,
        name: linked?.name ?? runtime.host.replace(/\.local\.?$/, ''),
        source: runtime.source ?? 'mdns',
        mesh: { url: runtime.url, port: runtime.port },
        remote: linked?.remote ?? null,
      })
    }
    return out.sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key))
  }

  /** The tailnet sweep found an ADF daemon with remote access on (GET /remote/hello, already bounded and checked). */
  upsertTailnetDaemon(found: { fingerprint: string; name: string; address: string; port: number; pairingOpen: boolean }): void {
    if (!FINGERPRINT.test(found.fingerprint) || found.fingerprint === this.selfFingerprint) return
    const name = peerName(found.name) ?? found.fingerprint
    if (this.setSighting(found.fingerprint, `tailnet:${found.address}`, { name, address: found.address, port: found.port, pairingOpen: found.pairingOpen, kind: 'tailnet', runtimeId: null })) {
      this.emit('peers_changed')
    }
  }

  /** After a tailnet sweep: sightings it no longer found (`<fingerprint>@<address>`) go. */
  expireTailnetDaemons(seen: ReadonlySet<string>): void {
    let changed = false
    for (const [fp, sightings] of this.remotes) {
      for (const [source, s] of sightings) {
        if (s.kind !== 'tailnet' || seen.has(`${fp}@${s.address}`)) continue
        sightings.delete(source)
        changed = true
      }
      if (sightings.size === 0) this.remotes.delete(fp)
    }
    if (changed) this.emit('peers_changed')
  }

  /** Store a sighting; true when something changed. */
  private setSighting(fp: string, source: string, sighting: RemoteSighting): boolean {
    const sightings = this.remotes.get(fp) ?? new Map<string, RemoteSighting>()
    const before = JSON.stringify(sightings.get(source) ?? null)
    sightings.set(source, sighting)
    this.remotes.set(fp, sightings)
    return before !== JSON.stringify(sighting)
  }

  /** Drop sightings that match; true when something went. */
  private dropSightings(match: (fp: string, source: string, s: RemoteSighting) => boolean): boolean {
    let changed = false
    for (const [fp, sightings] of this.remotes) {
      for (const [source, s] of sightings) {
        if (!match(fp, source, s)) continue
        sightings.delete(source)
        changed = true
      }
      if (sightings.size === 0) this.remotes.delete(fp)
    }
    return changed
  }

  getDiscoveredRuntimes(): DiscoveredRuntime[] {
    return [...this.discovered.values()]
  }

  getDiscovered(runtimeId: string): DiscoveredRuntime | undefined {
    return this.discovered.get(runtimeId)
  }

  /**
   * Insert/refresh a peer found outside mDNS (tailnet sweep, manual list).
   * mDNS entries win by default — a same-broadcast-domain route beats an
   * overlay route to the same runtime — so an external upsert never clobbers
   * one. `force` overrides that: the browser only ever removes an entry on an
   * explicit goodbye packet, so after a network move a dead LAN entry would
   * shadow a working overlay route forever. The tailnet sweep passes `force`
   * once it has probed the mDNS route and found it dead.
   */
  upsertExternalPeer(entry: {
    runtime_id: string
    runtime_did?: string
    proto?: string
    host: string
    port: number
    url: string
    source: 'tailnet' | 'manual'
  }, opts?: { force?: boolean }): void {
    if (entry.runtime_id === this.selfRuntimeId) return
    const now = Date.now()
    const existing = this.discovered.get(entry.runtime_id)
    if (existing && (existing.source ?? 'mdns') === 'mdns' && !opts?.force) {
      return // direct LAN route already known
    }
    const next: DiscoveredRuntime = {
      runtime_id: entry.runtime_id,
      runtime_did: entry.runtime_did ?? existing?.runtime_did,
      proto: entry.proto ?? PROTO_VERSION,
      directory_path: DIRECTORY_PATH,
      host: entry.host,
      port: entry.port,
      url: entry.url,
      first_seen: existing?.first_seen ?? now,
      last_seen: now,
      source: entry.source
    }
    const isNew = !existing || existing.url !== next.url
    this.discovered.set(entry.runtime_id, next)
    if (isNew) {
      this.emit('discovered', next)
      this.emit('peers_changed')
    }
  }

  /** Remove an externally-sourced peer (never touches mDNS entries). */
  removeExternalPeer(runtimeId: string): void {
    const entry = this.discovered.get(runtimeId)
    if (!entry || (entry.source ?? 'mdns') === 'mdns') return
    this.discovered.delete(runtimeId)
    this.emit('expired', entry)
    this.emit('peers_changed')
  }

  // --- Internal ---

  private onServiceUp(service: Service): void {
    const txt = (service.txt ?? {}) as Record<string, unknown>
    const runtimeId = typeof txt.runtime_id === 'string' ? txt.runtime_id : undefined
    // Untrusted input (discovery review 3): a record over 4 KB, or with a value over 255 bytes, is dropped.
    if (!txtWithinBounds(txt)) return
    // A record without the mesh carries remote access only (no runtime id): by fingerprint.
    if (!runtimeId) { this.onRemoteOnlyUp(service, txt); return }
    if (runtimeId === this.selfRuntimeId) return // self-skip (race-safe via TXT)

    const runtimeDid = typeof txt.runtime_did === 'string' ? txt.runtime_did : undefined
    const proto = typeof txt.proto === 'string' ? txt.proto : PROTO_VERSION
    const directoryPath = typeof txt.directory === 'string' ? txt.directory : DIRECTORY_PATH
    const host = service.host || service.fqdn || ''
    const port = service.port

    if (!host || !port) return

    // Reach the peer at the address its announcement actually CAME FROM, not
    // the advertised hostname. Advertised names can be unresolvable off-host
    // (a Tailscale MagicDNS machine announces "name.<tailnet>.ts.net.local" —
    // a multi-label .local most resolvers won't touch), and the A-record set
    // includes every interface (WSL/Hyper-V NAT addresses that time out from
    // the LAN). The packet's source IP is on this broadcast domain by
    // definition — and directory fetches to it leave from OUR matching LAN
    // address, so the peer's scope filter classifies us 'lan', not 'public'.
    const referer = (service as unknown as { referer?: { address?: string } }).referer
    const isPrivateV4 = (ip: string): boolean =>
      /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)
    const addresses = (service.addresses ?? []) as string[]
    const reachHost = referer?.address ?? addresses.find(isPrivateV4) ?? host

    // Remote access in the same announcement (§5.1).
    const fp = txtString(txt, 'fp')
    const daemonPort = Number(txtString(txt, 'daemon_port'))
    const source = `mdns:${service.name}`
    if (fp && FINGERPRINT.test(fp) && txtString(txt, 'v') === '1' && Number.isInteger(daemonPort) && daemonPort > 0 && daemonPort < 65536) {
      const name = peerName(txtString(txt, 'name')) ?? peerName(host.replace(/\.local\.?$/, '')) ?? fp
      this.dropSightings((f, src) => src === source && f !== fp)
      this.setSighting(fp, source, { name, address: reachHost, port: daemonPort, pairingOpen: txtString(txt, 'pair') === '1', kind: 'lan', runtimeId })
    } else {
      // Remote access went off on that runtime.
      this.dropSightings((_f, src, s) => src === source || s.runtimeId === runtimeId)
    }

    const now = Date.now()
    const existing = this.discovered.get(runtimeId)
    // TXT mesh=0: its mesh is not visible to other computers (only remote access is announced).
    if (txtString(txt, 'mesh') === '0') {
      if (existing) {
        this.discovered.delete(runtimeId)
        this.emit('expired', existing)
      }
      this.emit('peers_changed')
      return
    }
    const entry: DiscoveredRuntime = {
      runtime_id: runtimeId,
      runtime_did: runtimeDid,
      proto,
      directory_path: directoryPath,
      host,
      port,
      url: buildBaseUrl(reachHost, port),
      first_seen: existing?.first_seen ?? now,
      last_seen: now
    }
    this.discovered.set(runtimeId, entry)
    this.emit('discovered', entry)
    this.emit('peers_changed')
  }

  /** TODO(remove after the next release): `_adf-daemon._tcp` of this PR's intermediate commits. */
  private onLegacyDaemonUp(service: Service): void {
    const txt = (service.txt ?? {}) as Record<string, unknown>
    if (!txtWithinBounds(txt)) return
    const fp = txtString(txt, 'fp')
    if (!fp || !FINGERPRINT.test(fp) || txtString(txt, 'v') !== '1' || !service.port) return
    if (fp === this.selfFingerprint) return
    const address = sourceAddress(service)
    if (!address) return
    const name = peerName(service.name) ?? fp
    this.setSighting(fp, `legacy:${service.name}`, { name, address, port: service.port, pairingOpen: txtString(txt, 'pair') === '1', kind: 'lan', runtimeId: null })
    this.emit('peers_changed')
  }

  private onLegacyDaemonDown(service: Service): void {
    const fp = txtString((service.txt ?? {}) as Record<string, unknown>, 'fp')
    const changed = this.dropSightings((f, src) => service.name ? src === `legacy:${service.name}` : f === fp && src.startsWith('legacy:'))
    if (changed) this.emit('peers_changed')
  }

  /** A record with remote access only (the mesh hidden): no runtime id, keyed by fingerprint. */
  private onRemoteOnlyUp(service: Service, txt: Record<string, unknown>): void {
    const fp = txtString(txt, 'fp')
    const daemonPort = Number(txtString(txt, 'daemon_port'))
    if (!fp || !FINGERPRINT.test(fp) || txtString(txt, 'v') !== '1' || !Number.isInteger(daemonPort) || daemonPort <= 0 || daemonPort >= 65536) return
    if (fp === this.selfFingerprint) return
    const address = sourceAddress(service)
    if (!address) return
    // The alias, or (a per-network token is not a name) the host name.
    const host = (service.host || '').replace(/\.local\.?$/, '')
    const name = (/^adf-[0-9a-f]{12}$/.test(service.name ?? '') ? null : peerName(service.name)) ?? peerName(host) ?? fp
    const source = `mdns:${service.name}`
    this.dropSightings((f, src) => src === source && f !== fp)
    this.setSighting(fp, source, { name, address, port: daemonPort, pairingOpen: txtString(txt, 'pair') === '1', kind: 'lan', runtimeId: null })
    this.emit('peers_changed')
  }

  private onServiceDown(service: Service): void {
    const txt = (service.txt ?? {}) as Record<string, unknown>
    const runtimeId = typeof txt.runtime_id === 'string' ? txt.runtime_id : undefined
    const fp = txtString(txt, 'fp')
    // This announcement's sightings go (by instance; without one, by runtime or fingerprint).
    this.dropSightings((f, src, s) => (service.name ? src === `mdns:${service.name}` : false)
      || (!!runtimeId && s.runtimeId === runtimeId)
      || (!service.name && !runtimeId && f === fp && src.startsWith('mdns:')))
    const entry = runtimeId ? this.discovered.get(runtimeId) : undefined
    if (runtimeId && entry) {
      this.discovered.delete(runtimeId)
      this.emit('expired', entry)
    }
    this.emit('peers_changed')
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
export const VIRTUAL_IFACE_RE = /^(lo\d*|gif\d*|stf\d*|awdl\d*|llw\d*|anpi\d*|ap\d+|bridge\d*|utun\d*|ipsec\d*|ppp\d*|tun\d*|tap\d*|veth|vmnet\d*|vboxnet\d*|docker\d*|br-|wg\d*|tailscale\d*|zt[a-z0-9]+)/i
export const VIRTUAL_IFACE_WIN_RE = /(vEthernet|VMware|VirtualBox|Hyper-?V|WSL|Bluetooth|Loopback|Npcap|Pseudo-|Wintun|Tailscale|TAP-Windows|OpenVPN)/i

export function isRFC1918(ipv4: string): boolean {
  const [o1, o2] = ipv4.split('.').map(Number)
  if (o1 === 10) return true
  if (o1 === 172 && o2 >= 16 && o2 <= 31) return true
  if (o1 === 192 && o2 === 168) return true
  return false
}

export function isCGNAT(ipv4: string): boolean {
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

function txtString(txt: Record<string, unknown>, key: string): string | null {
  const value = txt[key]
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8')
  return null
}

/** The address an announcement came from (preferred), else a private IPv4 of it, else its first. */
function sourceAddress(service: Service): string | null {
  const referer = (service as unknown as { referer?: { address?: string } }).referer?.address
  const addresses = ((service.addresses ?? []) as unknown[]).filter((a): a is string => typeof a === 'string' && a.length <= 64)
  const address = referer ?? addresses.find((ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)) ?? addresses[0]
  return address && address.length <= 64 ? address : null
}

/** Build a URL base; wrap bare IPv6 addresses in brackets. */
export function buildBaseUrl(host: string, port: number): string {
  const isIpv6 = host.includes(':') && !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  const hostPart = isIpv6 ? `[${host}]` : host
  return `http://${hostPart}:${port}`
}
