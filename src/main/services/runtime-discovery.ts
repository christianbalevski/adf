/**
 * The daemon's one discovery service (docs/design/remote-access.md §5.1):
 * one mDNS announcement and browser (mdns-service.ts), one tailnet sweep,
 * one cache, one event stream (`peers_changed`). It feeds the mesh peer list
 * (`getDiscoveredRuntimes`, decorated for Settings → Networking and the
 * fleet map: directory cards, /ping metadata, trust verification), Studio's
 * Discovered list and `adf pair` (`peers()`, GET /network/peers). Remote
 * access announces through `remoteAnnouncer()`, in the same record.
 *
 * It runs while the mesh is LAN-bound on an allowed network, while remote
 * access is on (on an allowed network), or for a minute after a client
 * asked for the peers. It announces only from an address of an allowed
 * network.
 *
 * Electron-free and dependency-injected. The daemon uses it
 * (daemon/index.ts, `GET /network/mesh/discovered-runtimes`). Studio's
 * embedded backend still runs its own copy of the same logic in
 * ipc/index.ts (startMdnsIfEligible, stopMdnsAndCleanup,
 * getDiscoveredRuntimes); the behaviour here is that copy's, so the two can
 * converge on this module by a later E1 extraction.
 *
 * One difference is structural: Studio re-evaluates discovery from the
 * handlers that start and stop its mesh server. This module cannot hook the
 * daemon's server controls, so it polls the server state (cheap property
 * reads) instead; a start, stop or rebind is picked up within one poll.
 */
import { createHash } from 'crypto'
import { isIP } from 'net'
import { networkInterfaces } from 'os'
import { MdnsService, type DiscoveredRuntime, type MdnsAnnouncement } from './mdns-service'
import type { Announcement, Announcer } from '../daemon/remote-access/announcer'
import type { NetworkPeer } from '../../shared/types/remote-access.types'
import { DirectoryFetchCache } from './directory-fetch-cache'
import { TailnetDiscovery } from './tailnet-discovery'
import { verifyAttestation } from './attestation.service'
import { verifyCardSignature } from './mesh-server'
import { getOrCreateRuntimeId } from '../utils/runtime-id'
import type { AlfAgentCard, AlfAttestation } from '../../shared/types/adf-v02.types'
import type { MeshEvent } from '../../shared/types/ipc.types'

/** The mesh manager surface discovery needs. */
export interface DiscoveryMesh {
  isEnabled(): boolean
  hasAgentOfTier(tier: 'directory' | 'localhost' | 'lan' | 'public' | 'off'): boolean
  setMdnsService(service: MdnsService | null): void
  setDirectoryFetchCache(cache: DirectoryFetchCache | null): void
  emitRuntimeDiscovered(peer: DiscoveredRuntime): void
  emitRuntimeExpired(peer: DiscoveredRuntime): void
  on(event: 'mesh_event', listener: (event: MeshEvent) => void): unknown
  off(event: 'mesh_event', listener: (event: MeshEvent) => void): unknown
}

/** The mesh server surface discovery needs. */
export interface DiscoveryMeshServer {
  isRunning(): boolean
  getHost(): string
  getPort(): number
  /** LAN mode listens on a private network or the tailnet now (lan-reach.ts); absent: the host decides. */
  isLanReachable?(): boolean
  /** The LAN addresses it listens on (allowed networks only); the mesh announces from one of them. */
  getLanAddresses?(): string[]
}

/** The TailnetDiscovery surface discovery drives (a fake in tests). */
export type DiscoveryTailnet = Pick<TailnetDiscovery, 'start' | 'stop' | 'ensureFresh' | 'sweepNow'>

export interface RuntimeDiscoveryOptions {
  settings: { get(key: string): unknown; set(key: string, value: unknown): void }
  meshServer: DiscoveryMeshServer
  mesh: DiscoveryMesh
  /** The runtime DID this host signs with (mDNS TXT `runtime_did`). */
  getRuntimeDid: () => string | undefined
  /** The owner DID on record, to mark peers owned by the same person. */
  getOwnerDid: () => string | undefined
  createMdns?: () => MdnsService
  createTailnet?: (opts: ConstructorParameters<typeof TailnetDiscovery>[0]) => DiscoveryTailnet
  directoryCache?: DirectoryFetchCache
  /** /ping fetch for peer metadata. Defaults to global fetch. */
  fetchFn?: typeof fetch
  /** Server-state poll. Default 2 s; the network check runs every fifth poll, as Studio's 10 s watch. */
  pollIntervalMs?: number
  /** The ADF daemon's port: the tailnet sweep asks it for /remote/hello. */
  daemonPort?: number
  /** How long a peers() call keeps discovery running without the mesh or remote access. Default 60 s. */
  demandMs?: number
}

/** A discovered peer as `MESH_DISCOVERED_RUNTIMES` returns it. */
export interface DecoratedRuntime extends DiscoveredRuntime {
  /** Undefined = discovered but its directory is unreachable (not "0 agents"). */
  agent_count?: number
  agents?: Array<AlfAgentCard & { card_verified: boolean; owner_attested: boolean; attested_owner_did?: string }>
  runtime_alias?: string
  owner_alias?: string
  owner_did?: string
  owner_verified: boolean
  is_self_owned: boolean
}

interface RuntimeMeta {
  runtime_alias?: string
  owner_did?: string
  owner_alias?: string
  owner_delegation?: AlfAttestation
}

// Both on the DirectoryFetchCache clock: a peer's alias and identity do not
// move between 5 s polls, and a lapsed attestation reads verified for 30 s at most.
const RUNTIME_META_TTL_MS = 30_000
const VERIFY_MEMO_TTL_MS = 30_000
const VERIFY_MEMO_MAX = 512
const PING_TIMEOUT_MS = 4_000
const NETWORK_CHECK_EVERY = 5
const DEMAND_MS = 60_000
const PEERS_DEBOUNCE_MS = 250
const MAX_PEERS_WAIT_MS = 5_000

export class RuntimeDiscovery {
  private readonly opts: RuntimeDiscoveryOptions
  private readonly directoryCache: DirectoryFetchCache
  private readonly fetchFn: typeof fetch
  private mdns: MdnsService | null = null
  /** The mDNS library failed to start; retried only after a network change. */
  private mdnsUnavailable = false
  private tailnet: DiscoveryTailnet | null = null
  private running = false
  private rerunRequested = false
  private stopped = true
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private polls = 0
  private lastNetSignature: string | null = null
  /** Remote access's announcement while it is on, on an allowed network (remoteAnnouncer). */
  private remote: Announcement | null = null
  /** Discovery runs for clients asking for the peers until then. */
  private demandUntil = 0
  /** The address the running service announces from (undefined: the picked default). */
  private startedIface: string | undefined = undefined
  private readonly peersListeners = new Set<() => void>()
  private peersTimer: ReturnType<typeof setTimeout> | null = null
  private readonly runtimeMetaCache = new Map<string, { expiresAt: number; meta: RuntimeMeta | null }>()
  private readonly verifyMemo = new Map<string, { at: number; value: boolean }>()
  private readonly onMeshEvent = (event: MeshEvent): void => {
    // A newly joined agent may be the first LAN/public one, which flips the
    // announce gate from browse-only to announcing (Studio parity).
    if (event.type === 'agent_joined') void this.refresh()
  }

  constructor(opts: RuntimeDiscoveryOptions) {
    this.opts = opts
    this.directoryCache = opts.directoryCache ?? new DirectoryFetchCache()
    this.fetchFn = opts.fetchFn ?? fetch
  }

  /** Begin watching. Idempotent. */
  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.opts.mesh.on('mesh_event', this.onMeshEvent)
    const interval = this.opts.pollIntervalMs ?? 2_000
    this.pollTimer = setInterval(() => this.poll(), interval)
    // Never keep the process alive, never resurrect discovery mid-shutdown.
    this.pollTimer.unref?.()
    void this.refresh()
  }

  /** Stop watching and stop mDNS (goodbye packets), before the mesh server goes down. */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
    this.opts.mesh.off('mesh_event', this.onMeshEvent)
    await this.stopMdns()
  }

  /** True while an mDNS service is up (announcing or browse-only). */
  isActive(): boolean {
    return this.mdns !== null
  }

  /**
   * The feed (Studio's Discovered list, `adf pair`, GET /network/peers):
   * every ADF computer found, both capabilities. Keeps discovery running
   * for a minute; `waitMs` (at most 5 s) lets a fresh browse hear answers.
   */
  async peers(opts: { waitMs?: number } = {}): Promise<NetworkPeer[]> {
    if (this.stopped) return []
    this.demandUntil = Date.now() + (this.opts.demandMs ?? DEMAND_MS)
    if (!this.mdns) await this.refresh()
    else this.tailnet?.ensureFresh()
    const wait = Math.min(Math.max(opts.waitMs ?? 0, 0), MAX_PEERS_WAIT_MS)
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    return this.mdns?.peers() ?? []
  }

  /** `peers_changed`: the feed changed (debounced). */
  onPeersChanged(listener: () => void): () => void {
    this.peersListeners.add(listener)
    return () => { this.peersListeners.delete(listener) }
  }

  private notifyPeers(): void {
    if (this.peersTimer) return
    this.peersTimer = setTimeout(() => {
      this.peersTimer = null
      for (const listener of this.peersListeners) {
        try { listener() } catch { /* a listener's problem */ }
      }
    }, PEERS_DEBOUNCE_MS)
    this.peersTimer.unref?.()
  }

  /**
   * Remote access announces through this (RemoteAccessService's announcer):
   * its fields join the one `_adf-runtime._tcp` record. It calls announce only
   * while remote access is on and a LAN address of an allowed network listens.
   */
  remoteAnnouncer(): Announcer {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const discovery = this
    return {
      async announce(a: Announcement): Promise<void> {
        discovery.remote = a
        await discovery.refresh()
      },
      async stop(): Promise<void> {
        if (!discovery.remote) return
        discovery.remote = null
        await discovery.refresh()
      },
      get announcing(): boolean {
        return !!discovery.remote && (discovery.mdns?.isAnnouncingRemote() ?? false)
      },
      get problem(): string | null {
        return discovery.remote && discovery.mdnsUnavailable ? 'mDNS is not available on this computer; other computers find it by address or on the tailnet.' : null
      },
    }
  }

  /** What discovery should do now. */
  private desired(): { run: boolean; announcement: MdnsAnnouncement; iface: string | undefined } {
    const { meshServer, mesh } = this.opts
    const meshUp = mesh.isEnabled() && meshServer.isRunning() && meshServer.getHost() === '0.0.0.0' && (meshServer.isLanReachable?.() ?? true)
    // LAN-visible spans 'lan' and 'public': a public agent is reachable from
    // the internet, which subsumes the LAN, so it announces over mDNS too.
    const meshVisible = meshUp && (mesh.hasAgentOfTier('lan') || mesh.hasAgentOfTier('public'))
    const remote = this.remote
    const announce = meshVisible || !!remote
    // Consent: announce only from an address of an allowed network (remote access's listener, else the mesh's).
    const iface = announce ? remote?.iface ?? meshServer.getLanAddresses?.().find((a) => isIP(a) === 4) : undefined
    return {
      run: meshUp || !!remote || Date.now() < this.demandUntil,
      announcement: {
        announce,
        mesh: meshVisible,
        remote: remote ? { name: remote.name, alias: remote.alias ?? null, port: remote.port, fingerprint: remote.txt.fp, pairingOpen: remote.txt.pair === '1', api: remote.txt.api } : null,
      },
      iface,
    }
  }

  /**
   * Start mDNS if the host is eligible: mesh server running and bound to
   * 0.0.0.0; announce only with at least one LAN- or public-tier agent. A
   * browse-only service upgrades to announcing when such an agent appears.
   * Single-flight with one trailing re-run, as Studio's startMdnsIfEligible.
   */
  async refresh(): Promise<void> {
    if (this.stopped) return
    if (this.running) { this.rerunRequested = true; return }
    this.running = true
    try {
      do {
        this.rerunRequested = false
        await this.refreshOnce()
      } while (this.rerunRequested && !this.stopped)
    } finally {
      this.running = false
    }
  }

  /**
   * The decorated peer list. `force` (the refresh button) awaits a full
   * tailnet re-probe and drops the caches first; otherwise the 5 s poll only
   * nudges a stale sweep.
   */
  async getDiscoveredRuntimes(args?: { force?: boolean }): Promise<DecoratedRuntime[]> {
    const mdns = this.mdns
    if (!mdns) return []
    if (args?.force) {
      try { await this.tailnet?.sweepNow() } catch { /* results below reflect whatever we have */ }
      this.directoryCache.invalidate()
      this.runtimeMetaCache.clear()
    } else {
      this.tailnet?.ensureFresh()
    }
    const ourOwnerDid = this.opts.getOwnerDid()
    return Promise.all(mdns.getDiscoveredRuntimes().map(async (peer) => {
      const [cards, meta] = await Promise.all([
        this.directoryCache.fetch(peer.url),
        this.fetchRuntimeMeta(peer.url),
      ])
      // Owner identity is opt-in on the peer; when shared it ships a
      // delegation so the owner→runtime link is VERIFIED, not taken on trust.
      let ownerVerified = false
      let isSelf = false
      if (meta?.owner_did && meta.owner_delegation && peer.runtime_did) {
        const del = meta.owner_delegation
        const runtimeDid = peer.runtime_did
        ownerVerified =
          del.role === 'runtime' &&
          del.issuer === meta.owner_did &&
          del.subject === runtimeDid &&
          this.memoVerify(['att', del, runtimeDid], () => verifyAttestation(del, { expectedSubject: runtimeDid }))
        isSelf = ownerVerified && !!ourOwnerDid && meta.owner_did === ourOwnerDid
      }
      // The same trust judgment agent_discover applies to remote cards.
      const decorated = (cards as AlfAgentCard[] | null)?.map((card) => {
        const cardVerified = !!card.did && !!card.signature &&
          this.memoVerify(['card', card], () => verifyCardSignature(card))
        const ownerAtt = cardVerified
          ? (card.attestations ?? []).find((a) => a.role === 'owner' &&
              this.memoVerify(['att', a, card.did], () => verifyAttestation(a, { expectedSubject: card.did })))
          : undefined
        return {
          ...card,
          card_verified: cardVerified,
          owner_attested: !!ownerAtt,
          ...(ownerAtt ? { attested_owner_did: ownerAtt.issuer } : {}),
        }
      })
      return {
        ...peer,
        agent_count: decorated ? decorated.length : undefined,
        agents: decorated ?? undefined,
        runtime_alias: meta?.runtime_alias,
        owner_alias: meta?.owner_alias,
        owner_did: meta?.owner_did,
        owner_verified: ownerVerified,
        is_self_owned: isSelf,
      }
    }))
  }

  private async refreshOnce(): Promise<void> {
    const { meshServer, mesh, settings } = this.opts
    // Nothing needs discovery: the mesh is not LAN-bound on an allowed network, remote access is off, no client asks.
    const desired = this.desired()
    if (!desired.run) {
      if (this.mdns) await this.stopMdns()
      return
    }

    mesh.setDirectoryFetchCache(this.directoryCache)
    if (this.mdns) {
      if (this.startedIface === desired.iface) {
        mesh.setMdnsService(this.mdns)
        // One record: a LAN-visible agent, remote access on or off, the pairing window: re-published, browser untouched.
        // A publish that did not take is not retried until something changes.
        await this.mdns.updateAnnouncement(desired.announcement)
        return
      }
      console.log('[Discovery] The announcing address changed — restarting mDNS')
      await this.stopMdns()
    }

    const runtimeId = getOrCreateRuntimeId(settings)
    const service = this.opts.createMdns?.() ?? new MdnsService()
    service.on('discovered', (peer: DiscoveredRuntime) => {
      mesh.emitRuntimeDiscovered(peer)
      // Eager directory prefetch so agent counts show on discovery.
      void this.directoryCache.fetch(peer.url)
    })
    service.on('expired', (peer: DiscoveredRuntime) => {
      mesh.emitRuntimeExpired(peer)
      this.directoryCache.invalidate(peer.url)
    })
    service.on('unavailable', ({ reason }: { reason: string }) => {
      this.mdnsUnavailable = true
      console.log(`[Discovery] mDNS unavailable: ${reason}`)
    })
    service.on('peers_changed', () => this.notifyPeers())
    await service.start({
      ...desired.announcement,
      browse: true,
      port: meshServer.getPort(),
      runtimeId,
      runtimeDid: this.opts.getRuntimeDid(),
      ...(desired.iface ? { iface: desired.iface } : {}),
    })
    if (this.stopped) {
      // stop() ran while start() was in flight: never leave a service behind.
      await service.stop().catch(() => {})
      return
    }
    this.mdns = service
    this.startedIface = desired.iface
    mesh.setMdnsService(service)
    this.notifyPeers()
    console.log(`[Discovery] mDNS ${desired.announcement.announce ? `announcing (${[desired.announcement.mesh ? 'mesh' : '', desired.announcement.remote ? 'remote access' : ''].filter(Boolean).join(', ')}) and browsing` : 'browsing'} on port ${meshServer.getPort()}`)

    // Beyond the broadcast domain: the tailnet sweep and manual peers feed
    // the same table.
    if (!this.tailnet) {
      const tailnetOpts: ConstructorParameters<typeof TailnetDiscovery>[0] = {
        getPorts: () => {
          const own = meshServer.getPort()
          return own === 7295 ? [7295] : [own, 7295]
        },
        isTailnetEnabled: () => settings.get('tailnetDiscovery') !== false,
        getManualPeers: () => (settings.get('meshManualPeers') as string[] | undefined) ?? [],
        getExistingRoute: (id) => this.mdns?.getDiscovered(id),
        onPeer: (peer, peerOpts) => this.mdns?.upsertExternalPeer(peer, peerOpts),
        onExpire: (id) => this.mdns?.removeExternalPeer(id),
        // The same sweep asks each peer's daemon port for /remote/hello (remote access).
        getDaemonPort: () => this.opts.daemonPort ?? null,
        onDaemon: (found) => this.mdns?.upsertTailnetDaemon(found),
        onDaemonSweep: (seen) => this.mdns?.expireTailnetDaemons(seen),
      }
      const tailnet = this.opts.createTailnet?.(tailnetOpts) ?? new TailnetDiscovery(tailnetOpts)
      tailnet.start()
      this.tailnet = tailnet
    }
    this.lastNetSignature = networkSignature()
  }

  private async stopMdns(): Promise<void> {
    this.tailnet?.stop()
    this.tailnet = null
    const service = this.mdns
    this.mdns = null
    this.startedIface = undefined
    this.opts.mesh.setMdnsService(null)
    if (service) this.notifyPeers()
    this.directoryCache.invalidate()
    if (service) {
      try { await service.stop() } catch (err) { console.error('[Discovery] mDNS stop failed:', err) }
    }
  }

  private poll(): void {
    if (this.stopped || this.running) return
    const eligible = this.desired().run
    if (this.mdns && !eligible) {
      console.log('[Discovery] Mesh not LAN-bound on an allowed network, remote access off, no client asking — stopping mDNS')
      void this.stopMdns()
      return
    }
    if (!eligible) return
    this.polls += 1
    // The mDNS socket's multicast membership is pinned to the interface it
    // started on and dies silently on a network move (Wi-Fi roam, VPN up).
    if (this.mdns && this.polls % NETWORK_CHECK_EVERY === 0) {
      const signature = networkSignature()
      if (signature !== this.lastNetSignature) {
        console.log(`[Discovery] Network change (${signature || 'no IPv4 addresses'}) — restarting peer discovery`)
        this.mdnsUnavailable = false
        void this.stopMdns().then(() => this.refresh())
        return
      }
    }
    if (this.mdnsUnavailable) return
    // Cheap when nothing changed: the announcement is compared before anything is re-published.
    void this.refresh()
  }

  private async fetchRuntimeMeta(baseUrl: string): Promise<RuntimeMeta | null> {
    const now = Date.now()
    const cached = this.runtimeMetaCache.get(baseUrl)
    if (cached && cached.expiresAt > now) return cached.meta
    let meta: RuntimeMeta | null = null
    try {
      const res = await this.fetchFn(`${baseUrl.replace(/\/+$/, '')}/ping`, { signal: AbortSignal.timeout(PING_TIMEOUT_MS) })
      if (res.ok) meta = (await res.json()) as RuntimeMeta
    } catch {
      meta = null
    }
    this.runtimeMetaCache.set(baseUrl, { expiresAt: now + RUNTIME_META_TTL_MS, meta })
    return meta
  }

  /**
   * Ed25519 verification memoized on a digest of exactly what is checked, so
   * any change to the signed content or signature is verified afresh.
   */
  private memoVerify(subject: unknown, compute: () => boolean): boolean {
    let key: string
    try {
      key = createHash('sha256').update(JSON.stringify(subject) ?? '').digest('base64')
    } catch {
      return compute()
    }
    const now = Date.now()
    const hit = this.verifyMemo.get(key)
    if (hit && now - hit.at < VERIFY_MEMO_TTL_MS) return hit.value
    const value = compute()
    if (this.verifyMemo.size >= VERIFY_MEMO_MAX) {
      const oldest = this.verifyMemo.keys().next().value
      if (oldest !== undefined) this.verifyMemo.delete(oldest)
    }
    this.verifyMemo.set(key, { at: now, value })
    return value
  }
}

function networkSignature(): string {
  return Object.entries(networkInterfaces())
    .flatMap(([name, addrs]) =>
      (addrs ?? [])
        .filter((a) => !a.internal && a.family === 'IPv4')
        .map((a) => `${name}=${a.address}`))
    .sort()
    .join(',')
}
