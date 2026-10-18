import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RuntimeDiscovery, type DiscoveryMesh, type DiscoveryTailnet } from '../../../src/main/services/runtime-discovery'
import { DirectoryFetchCache } from '../../../src/main/services/directory-fetch-cache'
import type { DiscoveredRuntime, MdnsAnnouncement, MdnsService, MdnsStartOptions } from '../../../src/main/services/mdns-service'
import type { NetworkPeer } from '../../../src/shared/types/remote-access.types'
import type { DirectoryEntry } from '../../../src/main/tools/built-in/agent-discover.tool'

// Everything network-facing is a fake: no bonjour socket, no tailscale exec,
// no HTTP. The module's job is the policy (when to announce, browse, stop) and
// the decoration of the peer list.

class FakeMdns extends EventEmitter {
  started: MdnsStartOptions[] = []
  stops = 0
  announcing = false
  /** When false, a requested announce does not take (publish failed). */
  publishWorks = true
  runtimes: DiscoveredRuntime[] = []
  feed: NetworkPeer[] = []
  updates: MdnsAnnouncement[] = []
  current: MdnsAnnouncement | null = null
  async start(opts: MdnsStartOptions): Promise<void> {
    this.started.push(opts)
    this.current = { announce: opts.announce, mesh: opts.mesh, remote: opts.remote }
    this.announcing = opts.announce && this.publishWorks
  }
  async updateAnnouncement(next: MdnsAnnouncement): Promise<void> {
    if (JSON.stringify(next) === JSON.stringify(this.current)) return
    this.updates.push(next)
    this.current = next
    this.announcing = next.announce && this.publishWorks
  }
  async stop(): Promise<void> { this.stops++; this.announcing = false }
  isAnnouncing(): boolean { return this.announcing }
  isAnnouncingRemote(): boolean { return this.announcing && !!this.current?.remote }
  upsertTailnetDaemon(): void {}
  expireTailnetDaemons(): void {}
  getDiscoveredRuntimes(): DiscoveredRuntime[] { return this.runtimes }
  getDiscovered(id: string): DiscoveredRuntime | undefined { return this.runtimes.find(p => p.runtime_id === id) }
  peers(): NetworkPeer[] { return this.feed }
  upsertExternalPeer(): void {}
  removeExternalPeer(): void {}
}

class FakeMesh extends EventEmitter implements DiscoveryMesh {
  enabled = true
  tiers = new Set<string>()
  mdns: unknown = 'unset'
  cache: unknown = null
  discovered: DiscoveredRuntime[] = []
  isEnabled(): boolean { return this.enabled }
  hasAgentOfTier(tier: string): boolean { return this.tiers.has(tier) }
  setMdnsService(service: MdnsService | null): void { this.mdns = service }
  setDirectoryFetchCache(cache: DirectoryFetchCache | null): void { this.cache = cache }
  emitRuntimeDiscovered(peer: DiscoveredRuntime): void { this.discovered.push(peer) }
  emitRuntimeExpired(): void {}
}

class FakeDirectoryCache extends DirectoryFetchCache {
  cards: DirectoryEntry[] | null = []
  invalidations: Array<string | undefined> = []
  override async fetch(): Promise<DirectoryEntry[] | null> { return this.cards }
  override invalidate(url?: string): void { this.invalidations.push(url) }
}

function setup(opts: { host?: string; running?: boolean; reachable?: boolean } = {}) {
  const server = { running: opts.running ?? true, host: opts.host ?? '0.0.0.0', port: 7295, reachable: opts.reachable ?? true, lan: ['192.168.1.20'] }
  const mesh = new FakeMesh()
  const services: FakeMdns[] = []
  const tailnets: Array<DiscoveryTailnet & { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; sweepNow: ReturnType<typeof vi.fn> }> = []
  const settingsMap = new Map<string, unknown>()
  const cache = new FakeDirectoryCache()
  const fetchFn = vi.fn(async () => new Response(JSON.stringify({ runtime_id: 'peer-1', runtime_alias: 'laptop' }), { status: 200 }))
  const discovery = new RuntimeDiscovery({
    settings: { get: k => settingsMap.get(k), set: (k, v) => { settingsMap.set(k, v) } },
    meshServer: { isRunning: () => server.running, getHost: () => server.host, getPort: () => server.port, isLanReachable: () => server.reachable, getLanAddresses: () => (server.reachable ? server.lan : []) },
    daemonPort: 7385,
    demandMs: 200,
    mesh,
    getRuntimeDid: () => 'did:key:runtime',
    getOwnerDid: () => 'did:key:owner',
    createMdns: () => {
      const svc = new FakeMdns()
      services.push(svc)
      return svc as unknown as MdnsService
    },
    createTailnet: () => {
      const t = { start: vi.fn(), stop: vi.fn(), ensureFresh: vi.fn(), sweepNow: vi.fn(async () => {}) }
      tailnets.push(t)
      return t
    },
    directoryCache: cache,
    fetchFn: fetchFn as unknown as typeof fetch,
    pollIntervalMs: 10,
  })
  return { discovery, server, mesh, services, tailnets, settingsMap, cache, fetchFn }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('Timed out waiting for predicate')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

const stops: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop()
})

describe('RuntimeDiscovery', () => {
  it('stays off while the mesh server is loopback-only', async () => {
    const { discovery, services } = setup({ host: '127.0.0.1' })
    stops.push(() => discovery.stop())
    discovery.start()
    await discovery.refresh()
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(services).toHaveLength(0)
    expect(await discovery.getDiscoveredRuntimes()).toEqual([])
  })

  it('browses without announcing when no agent is LAN-visible, and starts the tailnet sweep', async () => {
    const { discovery, services, tailnets, mesh, settingsMap } = setup()
    stops.push(() => discovery.stop())
    discovery.start()
    await waitFor(() => services.length === 1)
    expect(services[0].started[0]).toMatchObject({ announce: false, browse: true, port: 7295, runtimeDid: 'did:key:runtime' })
    expect(services[0].started[0].runtimeId).toBe(settingsMap.get('runtimeId'))
    expect(mesh.mdns).toBe(services[0])
    expect(tailnets).toHaveLength(1)
    expect(tailnets[0].start).toHaveBeenCalledTimes(1)
  })

  it('upgrades to announcing when a LAN-visible agent joins', async () => {
    const { discovery, services, mesh } = setup()
    stops.push(() => discovery.stop())
    discovery.start()
    await waitFor(() => services.length === 1)

    mesh.tiers.add('lan')
    mesh.emit('mesh_event', { type: 'agent_joined', payload: {}, timestamp: Date.now() })
    // The one record is re-published from an allowed LAN address; the announcing address changed, so the service restarts once.
    await waitFor(() => services.length === 2)
    expect(services[0].stops).toBe(1)
    expect(services[1].started[0]).toMatchObject({ announce: true, mesh: true, remote: null, iface: '192.168.1.20' })
  })

  it('does not restart every poll when an announce does not take', async () => {
    const { discovery, services, mesh } = setup()
    stops.push(() => discovery.stop())
    mesh.tiers.add('public')
    const created: FakeMdns[] = services
    discovery.start()
    await waitFor(() => created.length === 1)
    created[0].publishWorks = false
    created[0].announcing = false
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(created).toHaveLength(1)
  })

  it('stops mDNS and the sweep when the mesh server stops or the mesh is disabled', async () => {
    const { discovery, services, tailnets, mesh, server } = setup()
    stops.push(() => discovery.stop())
    discovery.start()
    await waitFor(() => services.length === 1)

    server.running = false
    await waitFor(() => services[0].stops === 1)
    expect(tailnets[0].stop).toHaveBeenCalled()
    expect(mesh.mdns).toBeNull()

    server.running = true
    await waitFor(() => services.length === 2)
    mesh.enabled = false
    await waitFor(() => services[1].stops === 1)
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(services).toHaveLength(2)
  })

  it('decorates peers with directory cards, ping metadata and trust flags', async () => {
    const { discovery, services, cache, tailnets, fetchFn } = setup()
    stops.push(() => discovery.stop())
    discovery.start()
    await waitFor(() => services.length === 1)
    services[0].runtimes = [{
      runtime_id: 'peer-1', runtime_did: 'did:key:peer', proto: 'alf/0.2', directory_path: '/agents',
      host: '10.0.0.2', port: 7295, url: 'http://10.0.0.2:7295', first_seen: 1, last_seen: 2,
    }]
    cache.cards = [{ handle: 'agent-2', name: 'agent-2' } as unknown as DirectoryEntry]

    const peers = await discovery.getDiscoveredRuntimes()
    expect(peers).toHaveLength(1)
    expect(peers[0]).toMatchObject({
      runtime_id: 'peer-1',
      agent_count: 1,
      runtime_alias: 'laptop',
      owner_verified: false,
      is_self_owned: false,
    })
    expect(peers[0].agents?.[0]).toMatchObject({ handle: 'agent-2', card_verified: false, owner_attested: false })
    expect(tailnets[0].ensureFresh).toHaveBeenCalled()

    // Cached /ping on the next poll; `force` re-probes and drops caches.
    await discovery.getDiscoveredRuntimes()
    expect(fetchFn).toHaveBeenCalledTimes(1)
    await discovery.getDiscoveredRuntimes({ force: true })
    expect(tailnets[0].sweepNow).toHaveBeenCalledTimes(1)
    expect(cache.invalidations).toContain(undefined)
    expect(fetchFn).toHaveBeenCalledTimes(2)

    // Unreachable directory: count undefined, not 0.
    cache.cards = null
    const unreachable = await discovery.getDiscoveredRuntimes()
    expect(unreachable[0].agent_count).toBeUndefined()
  })

  it('stop() sends the service down and nothing restarts it', async () => {
    const { discovery, services } = setup()
    discovery.start()
    await waitFor(() => services.length === 1)
    await discovery.stop()
    expect(services[0].stops).toBe(1)
    expect(discovery.isActive()).toBe(false)
    await discovery.refresh()
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(services).toHaveLength(1)
  })
})

describe('RuntimeDiscovery: the one discovery service (remote-access.md §5.1)', () => {
  const announcement = (pair: '0' | '1' = '0') => ({ name: 'agent-1-pc', port: 7385, iface: '192.168.1.20', txt: { v: '1', fp: 'ABCD-EFGH', pair, api: '2' } })

  it('remote access joins the one announcement; it runs for remote access alone; off stops it', async () => {
    const { discovery, services, tailnets } = setup({ host: '127.0.0.1' })
    stops.push(() => discovery.stop())
    discovery.start()
    await discovery.refresh()
    expect(services).toHaveLength(0)
    const announcer = discovery.remoteAnnouncer()
    await announcer.announce(announcement())
    expect(services).toHaveLength(1)
    expect(services[0].started[0]).toMatchObject({
      announce: true, mesh: false, browse: true, port: 7295, iface: '192.168.1.20',
      remote: { name: 'agent-1-pc', port: 7385, fingerprint: 'ABCD-EFGH', pairingOpen: false, api: '2' },
    })
    expect(announcer.announcing).toBe(true)
    // The pairing window opens: the same record is re-published, no new service.
    await announcer.announce(announcement('1'))
    expect(services).toHaveLength(1)
    expect(services[0].updates.at(-1)).toMatchObject({ announce: true, remote: { pairingOpen: true } })
    // The tailnet sweep asks the daemon port too.
    expect(tailnets).toHaveLength(1)
    await announcer.stop()
    expect(services[0].stops).toBe(1)
    expect(announcer.announcing).toBe(false)
  })

  it('nothing is announced on a network that is not allowed: the mesh is not LAN-reachable and remote access does not announce', async () => {
    const { discovery, services, mesh } = setup({ reachable: false })
    stops.push(() => discovery.stop())
    mesh.tiers.add('lan')
    discovery.start()
    await discovery.refresh()
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(services).toHaveLength(0)
    // A client asks for the peers: browse only, nothing announced.
    await discovery.peers()
    expect(services).toHaveLength(1)
    expect(services[0].started[0]).toMatchObject({ announce: false, browse: true })
    expect(services[0].started[0].iface).toBeUndefined()
    // The demand lapses: discovery stops.
    await waitFor(() => services[0].stops === 1, 2000)
  })

  it('the mesh list and the feed are one service: peers() and getDiscoveredRuntimes() read the same instance; peers_changed is one stream', async () => {
    const { discovery, services, mesh } = setup()
    stops.push(() => discovery.stop())
    discovery.start()
    await waitFor(() => services.length === 1)
    const changed: number[] = []
    discovery.onPeersChanged(() => changed.push(1))
    services[0].feed = [{ key: 'peer-1', name: 'agent-1-pc', source: 'mdns', mesh: { url: 'http://10.0.0.2:7295', port: 7295 }, remote: { url: 'http://10.0.0.2:7385', port: 7385, fingerprint: 'ABCD-EFGH', pairingOpen: false, kind: 'lan' } }]
    services[0].runtimes = [{ runtime_id: 'peer-1', proto: 'alf/0.2', directory_path: '/agents', host: '10.0.0.2', port: 7295, url: 'http://10.0.0.2:7295', first_seen: 1, last_seen: 2 }]
    expect(mesh.mdns).toBe(services[0])
    expect(await discovery.peers()).toEqual(services[0].feed)
    expect((await discovery.getDiscoveredRuntimes()).map((r) => r.runtime_id)).toEqual(['peer-1'])
    services[0].emit('peers_changed')
    services[0].emit('peers_changed')
    await waitFor(() => changed.length === 1)
  })
})
