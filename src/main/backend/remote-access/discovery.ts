import { randomBytes } from 'node:crypto'
import { MdnsService } from '../../services/mdns-service'
import { TailnetDiscovery } from '../../services/tailnet-discovery'
import { DEFAULT_DAEMON_PORT } from '../../cli/daemon-url'
import { checkRemoteDaemonUrl } from '../../../shared/utils/remote-backend-url'
import type { NetworkPeer } from '../../../shared/types/remote-access.types'
import type { RemoteDiscoveryEntry, RemoteDiscoveryUpdate } from '../../../shared/types/remote-access-ipc.types'

/**
 * Settings → Backend → Remote computer, "Discovered"
 * (docs/design/remote-access.md §5.1, §9.1): the ADF computers with remote
 * access on, read from the one discovery feed of this computer, the same
 * feed the mesh peer list reads:
 *
 * - local mode: the ADF daemon's (GET /network/peers, re-read on its
 *   `peers_changed` push);
 * - embedded mode: Studio's own mesh mDNS service while it runs, else
 *   InProcessPeerFeed;
 * - remote mode: InProcessPeerFeed (the remote daemon's network is not
 *   this computer's).
 *
 * Runs only while the section is open (start/stop). Nothing here sees or
 * sends a token.
 */

const POLL_MS = 5_000

/** One discovery feed: the entries with both capabilities, and its `peers_changed` stream. */
export interface PeerFeed {
  /** The peers now; `waitMs` lets a browser that just started hear answers. */
  peers(opts?: { waitMs?: number }): Promise<NetworkPeer[]>
  /** `peers_changed`. */
  subscribe(listener: () => void): () => void
  /** Why the feed is limited (mDNS not available), or null. */
  problem(): string | null
  /** The Discovered list closed: an in-process feed may stop its browser. */
  release?(): void
}

export interface DiscoveryDeps {
  onUpdate: (update: RemoteDiscoveryUpdate) => void
  /** The saved remote computer's fingerprint ("Already paired"). */
  pairedFingerprint: () => string | null
  /** This computer's own daemon fingerprint, left out of the list. */
  ownFingerprint?: () => string | null
  /** This computer's discovery feed now; null while it cannot be read (no daemon yet). */
  feed: () => PeerFeed | null
  pollMs?: number
  log?: Pick<Console, 'log' | 'warn'>
}

/** `http://host:port` with an IPv6 literal bracketed. */
export function hostUrl(address: string, port: number): string {
  return `http://${address.includes(':') ? `[${address}]` : address}:${port}`
}

export class RemoteDiscovery {
  private peers: NetworkPeer[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private running = false
  private feed: PeerFeed | null = null
  private unsubscribe: (() => void) | null = null
  private generation = 0
  private readonly log: Pick<Console, 'log' | 'warn'>

  constructor(private readonly deps: DiscoveryDeps) {
    this.log = deps.log ?? console
  }

  get isRunning(): boolean {
    return this.running
  }

  start(): void {
    if (this.running) {
      this.emit()
      return
    }
    this.running = true
    this.generation++
    this.peers = []
    this.log.log('[Remote access] Looking for ADF computers (the discovery feed: this network and the tailnet)')
    this.emit()
    void this.read(this.generation, 2_000)
    this.timer = setInterval(() => void this.read(this.generation, 0), this.deps.pollMs ?? POLL_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (!this.running) return
    this.running = false
    this.generation++
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.unsubscribe?.()
    this.unsubscribe = null
    this.feed?.release?.()
    this.feed = null
    this.peers = []
    this.log.log('[Remote access] Stopped looking for ADF computers')
  }

  /** The list: tailnet before LAN, then by name. */
  entries(): RemoteDiscoveryEntry[] {
    const paired = this.deps.pairedFingerprint()
    const own = this.deps.ownFingerprint?.() ?? null
    const out: RemoteDiscoveryEntry[] = []
    for (const peer of this.peers) {
      const remote = peer.remote
      if (!remote || remote.fingerprint === own) continue
      let address: string
      try { address = new URL(remote.url).hostname.replace(/^\[|\]$/g, '') } catch { continue }
      const kind = checkRemoteDaemonUrl(remote.url).kind
      out.push({
        fingerprint: remote.fingerprint,
        name: peer.name,
        url: remote.url,
        address,
        kind: remote.kind,
        encrypted: kind === 'tailnet' || kind === 'https',
        pairingOpen: remote.pairingOpen,
        alreadyPaired: paired === remote.fingerprint,
        clash: remote.clash ?? null,
      })
    }
    return out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'tailnet' ? -1 : 1))
  }

  /** Re-read the feed (its `peers_changed`), or re-send the list (the saved remote changed: "Already paired"). */
  refresh(): void {
    if (this.running) void this.read(this.generation, 0)
  }

  private emit(): void {
    const feed = this.feed
    this.deps.onUpdate({
      entries: this.entries(),
      browsing: !!feed && feed.problem() === null,
      problem: feed ? feed.problem() : this.running ? 'Studio is not connected to the ADF daemon yet.' : null,
    })
  }

  private async read(generation: number, waitMs: number): Promise<void> {
    const feed = this.deps.feed()
    if (feed !== this.feed) {
      this.unsubscribe?.()
      this.feed?.release?.()
      this.feed = feed
      this.unsubscribe = feed ? feed.subscribe(() => this.refresh()) : null
    }
    let peers: NetworkPeer[] = []
    try {
      peers = feed ? await feed.peers({ waitMs }) : []
    } catch (err) {
      this.log.warn(`[Remote access] Could not read the discovery feed: ${err instanceof Error ? err.message : String(err)}`)
      peers = this.peers
    }
    if (generation !== this.generation || !this.running) return
    this.peers = peers
    this.emit()
  }
}

/** The ADF daemon's feed (local mode): GET /network/peers, re-read on its `peers_changed` push. */
export class DaemonPeerFeed implements PeerFeed {
  private readonly listeners = new Set<() => void>()

  constructor(private readonly request: (path: string) => Promise<{ peers: NetworkPeer[] }>) {}

  async peers(opts: { waitMs?: number } = {}): Promise<NetworkPeer[]> {
    const wait = Math.min(Math.max(Math.round(opts.waitMs ?? 0), 0), 5_000)
    return (await this.request(`/network/peers${wait ? `?wait=${wait}` : ''}`)).peers ?? []
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  problem(): string | null {
    return null
  }

  /** The daemon pushed `peers_changed` (remote_access topic). */
  changed(): void {
    for (const listener of this.listeners) listener()
  }
}

/**
 * This process's feed when no ADF daemon serves one (embedded and remote
 * mode): the process's mesh mDNS service when it runs (one browser per
 * process), else its own browse-only service and tailnet hello sweep,
 * stopped when the list closes or the mesh's service appears.
 */
export class InProcessPeerFeed implements PeerFeed {
  private own: MdnsService | null = null
  private tailnet: TailnetDiscovery | null = null
  private unavailable: string | null = null
  private attached: MdnsService | null = null
  private readonly listeners = new Set<() => void>()
  private readonly onChange = (): void => { for (const listener of this.listeners) listener() }

  constructor(private readonly opts: {
    /** The process's mesh mDNS service, when it runs (embedded mode). */
    mesh?: () => MdnsService | null
    createMdns?: () => MdnsService
    daemonPort?: number
    log?: Pick<Console, 'log' | 'warn'>
  } = {}) {}

  async peers(opts: { waitMs?: number } = {}): Promise<NetworkPeer[]> {
    const mesh = this.opts.mesh?.() ?? null
    if (mesh) {
      if (this.own) await this.stopOwn()
      this.attach(mesh)
      return mesh.peers()
    }
    if (!this.own) await this.startOwn()
    this.attach(this.own)
    const wait = Math.min(Math.max(opts.waitMs ?? 0, 0), 5_000)
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    return this.own?.peers() ?? []
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  problem(): string | null {
    return this.unavailable
  }

  release(): void {
    void this.stopOwn()
    this.attach(null)
  }

  private attach(service: MdnsService | null): void {
    if (this.attached === service) return
    this.attached?.off('peers_changed', this.onChange)
    this.attached = service
    service?.on('peers_changed', this.onChange)
  }

  private async startOwn(): Promise<void> {
    const service = this.opts.createMdns?.() ?? new MdnsService()
    service.on('unavailable', ({ reason }: { reason: string }) => {
      this.unavailable = 'mDNS is not available here. Tailnet computers are still listed; or enter an address.'
      this.opts.log?.warn(`[Remote access] mDNS browse failed: ${reason}`)
    })
    // Browse only: nothing is announced from here.
    await service.start({ announce: false, browse: true, port: 0, runtimeId: `studio-browse-${randomBytes(6).toString('hex')}` })
    this.own = service
    const port = this.opts.daemonPort ?? DEFAULT_DAEMON_PORT
    this.tailnet = new TailnetDiscovery({
      getPorts: () => [],
      isTailnetEnabled: () => true,
      getManualPeers: () => [],
      getExistingRoute: () => undefined,
      onPeer: () => {},
      onExpire: () => {},
      getDaemonPort: () => port,
      onDaemon: (found) => service.upsertTailnetDaemon(found),
      onDaemonSweep: (seen) => service.expireTailnetDaemons(seen),
    })
    this.tailnet.start()
  }

  private async stopOwn(): Promise<void> {
    this.tailnet?.stop()
    this.tailnet = null
    const own = this.own
    this.own = null
    if (this.attached === own) this.attach(null)
    if (own) await own.stop().catch(() => {})
  }
}
