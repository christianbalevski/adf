import { describe, expect, it, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'

// The vi.mock factory is hoisted — any module-scope references would TDZ.
// Keep all the mutable mock state on globalThis instead.
declare global {
  // eslint-disable-next-line no-var
  var __bonjourMocks: {
    publishMock: ReturnType<typeof vi.fn>
    findMock: ReturnType<typeof vi.fn>
    unpublishAllMock: ReturnType<typeof vi.fn>
    destroyMock: ReturnType<typeof vi.fn>
    ctorThrows: Error | null
  }
}

globalThis.__bonjourMocks = {
  publishMock: vi.fn(),
  findMock: vi.fn(),
  unpublishAllMock: vi.fn(),
  destroyMock: vi.fn(),
  ctorThrows: null
}

vi.mock('bonjour-service', () => {
  class MockBonjour {
    constructor() {
      if (globalThis.__bonjourMocks.ctorThrows) throw globalThis.__bonjourMocks.ctorThrows
    }
    publish(opts: unknown) { return globalThis.__bonjourMocks.publishMock(opts) }
    find(opts: unknown) { return globalThis.__bonjourMocks.findMock(opts) }
    unpublishAll(cb?: () => void) {
      globalThis.__bonjourMocks.unpublishAllMock()
      if (cb) cb()
    }
    destroy() { globalThis.__bonjourMocks.destroyMock() }
  }
  return { Bonjour: MockBonjour }
})

import { MdnsService, ensureLocalSuffix, buildBaseUrl, pickMdnsInterface } from '../../../src/main/services/mdns-service'
import { InProcessPeerFeed, RemoteDiscovery } from '../../../src/main/backend/remote-access/discovery'
import type { RemoteDiscoveryUpdate } from '../../../src/shared/types/remote-access-ipc.types'
import type { NetworkInterfaceInfo } from 'os'

const mocks = globalThis.__bonjourMocks

function makeBrowser() {
  const browser = new EventEmitter() as EventEmitter & { start: () => void; stop: () => void }
  browser.start = vi.fn()
  browser.stop = vi.fn()
  return browser
}

describe('ensureLocalSuffix', () => {
  it('appends .local when missing', () => {
    expect(ensureLocalSuffix('workstation')).toBe('workstation.local')
  })
  it('leaves hostnames that already end in .local alone', () => {
    expect(ensureLocalSuffix('host-b.local')).toBe('host-b.local')
    expect(ensureLocalSuffix('host-b.local.')).toBe('host-b.local.')
  })
  it('returns a fallback for empty hostnames', () => {
    expect(ensureLocalSuffix('')).toBe('adf-runtime.local')
  })
  it('leaves IPv6-looking hosts alone (bonjour wouldn\'t accept them anyway)', () => {
    expect(ensureLocalSuffix('fe80::1')).toBe('fe80::1')
  })
})

describe('pickMdnsInterface', () => {
  // Helper that turns a compact shape into what networkInterfaces() returns.
  function mk(entries: Array<{ name: string; address: string; internal?: boolean; family?: 'IPv4' | 'IPv6' }>): NodeJS.Dict<NetworkInterfaceInfo[]> {
    const out: NodeJS.Dict<NetworkInterfaceInfo[]> = {}
    for (const e of entries) {
      const info = {
        address: e.address,
        netmask: '255.255.255.0',
        family: e.family ?? 'IPv4',
        mac: '00:00:00:00:00:00',
        internal: e.internal ?? false,
        cidr: `${e.address}/24`
      } as NetworkInterfaceInfo
      ;(out[e.name] ??= []).push(info)
    }
    return out
  }

  it('honors ADF_MDNS_INTERFACE override verbatim', () => {
    const ifs = mk([{ name: 'en0', address: '192.168.1.10' }])
    expect(pickMdnsInterface(ifs, '10.9.8.7')).toBe('10.9.8.7')
  })

  it('treats whitespace-only override as unset', () => {
    const ifs = mk([{ name: 'en0', address: '192.168.1.10' }])
    expect(pickMdnsInterface(ifs, '   ')).toBe('192.168.1.10')
  })

  it('picks the physical LAN interface on macOS (en0) over utun/bridge/awdl', () => {
    const ifs = mk([
      { name: 'lo0', address: '127.0.0.1', internal: true },
      { name: 'utun8', address: '100.64.0.124' },
      { name: 'awdl0', address: '169.254.1.2' },
      { name: 'bridge0', address: '192.168.64.1' },
      { name: 'en0', address: '192.168.1.179' }
    ])
    expect(pickMdnsInterface(ifs, undefined)).toBe('192.168.1.179')
  })

  it('picks the physical NIC on Windows over Hyper-V vEthernet / WSL / Tailscale', () => {
    const ifs = mk([
      { name: 'vEthernet (WSL)', address: '172.28.0.1' },
      { name: 'vEthernet (Default Switch)', address: '172.27.0.1' },
      { name: 'Tailscale', address: '100.64.5.10' },
      { name: 'Ethernet', address: '192.168.1.50' }
    ])
    expect(pickMdnsInterface(ifs, undefined)).toBe('192.168.1.50')
  })

  it('prefers a Wi-Fi adapter over a random Docker bridge on Windows', () => {
    const ifs = mk([
      { name: 'vEthernet (WSL)', address: '172.28.0.1' },
      { name: 'Wi-Fi', address: '192.168.1.75' }
    ])
    expect(pickMdnsInterface(ifs, undefined)).toBe('192.168.1.75')
  })

  it('rejects Tailscale CGNAT (100.64.0.0/10) even without a name match', () => {
    const ifs = mk([{ name: 'mystery0', address: '100.64.0.124' }])
    expect(pickMdnsInterface(ifs, undefined)).toBeUndefined()
  })

  it('rejects non-RFC1918 public addresses', () => {
    const ifs = mk([{ name: 'en0', address: '17.1.2.3' }])
    expect(pickMdnsInterface(ifs, undefined)).toBeUndefined()
  })

  it('ignores IPv6-only interfaces', () => {
    const ifs = mk([{ name: 'en0', address: 'fe80::1', family: 'IPv6' }])
    expect(pickMdnsInterface(ifs, undefined)).toBeUndefined()
  })

  it('returns undefined when every interface is virtual/VPN', () => {
    const ifs = mk([
      { name: 'utun0', address: '10.99.99.1' },
      { name: 'docker0', address: '172.17.0.1' },
      { name: 'vEthernet (WSL)', address: '172.28.0.1' }
    ])
    expect(pickMdnsInterface(ifs, undefined)).toBeUndefined()
  })
})

describe('buildBaseUrl', () => {
  it('builds IPv4 URLs without brackets', () => {
    expect(buildBaseUrl('192.168.1.10', 7295)).toBe('http://192.168.1.10:7295')
  })
  it('wraps IPv6 literals in brackets', () => {
    expect(buildBaseUrl('fe80::1', 7295)).toBe('http://[fe80::1]:7295')
  })
  it('leaves .local hostnames untouched', () => {
    expect(buildBaseUrl('host-b.local', 7295)).toBe('http://host-b.local:7295')
  })
})

describe('MdnsService', () => {
  beforeEach(() => {
    mocks.publishMock.mockReset()
    mocks.findMock.mockReset()
    mocks.unpublishAllMock.mockReset()
    mocks.destroyMock.mockReset()
    mocks.ctorThrows = null
  })

  it('publishes when announce:true with the correct TXT record', async () => {
    mocks.findMock.mockReturnValue(makeBrowser())
    const svc = new MdnsService()
    await svc.start({
      announce: true,
      browse: true,
      port: 7295,
      runtimeId: 'runtime-a',
      runtimeDid: 'did:key:zExample'
    })

    expect(mocks.publishMock).toHaveBeenCalledTimes(1)
    const opts = mocks.publishMock.mock.calls[0][0] as Record<string, unknown>
    expect(opts.type).toBe('adf-runtime')
    expect(opts.protocol).toBe('tcp')
    expect(opts.port).toBe(7295)
    const txt = opts.txt as Record<string, string>
    expect(txt.runtime_id).toBe('runtime-a')
    expect(txt.runtime_did).toBe('did:key:zExample')
    expect(txt.proto).toBe('alf/0.2')
    expect(txt.directory).toBe('/agents')
    // Hostname ends with .local
    expect(String(opts.host)).toMatch(/\.local$/)
    await svc.stop()
  })

  it('skips publishing when announce:false but still browses', async () => {
    mocks.findMock.mockReturnValue(makeBrowser())
    const svc = new MdnsService()
    await svc.start({ announce: false, browse: true, port: 7295, runtimeId: 'runtime-a' })

    expect(mocks.publishMock).not.toHaveBeenCalled()
    // One browser for _adf-runtime._tcp, plus the legacy _adf-daemon._tcp one for a release.
    expect(mocks.findMock.mock.calls.map((c) => (c[0] as { type: string }).type)).toEqual(['adf-runtime', 'adf-daemon'])
    await svc.stop()
  })

  it('omits runtime_did from TXT when not provided', async () => {
    mocks.findMock.mockReturnValue(makeBrowser())
    const svc = new MdnsService()
    await svc.start({ announce: true, browse: false, port: 7295, runtimeId: 'runtime-a' })

    const txt = (mocks.publishMock.mock.calls[0][0] as Record<string, unknown>).txt as Record<string, string>
    expect(txt).not.toHaveProperty('runtime_did')
    await svc.stop()
  })

  it('skips self-announcements via runtime_id TXT filter', async () => {
    const browser = makeBrowser()
    mocks.findMock.mockReturnValue(browser)

    const svc = new MdnsService()
    await svc.start({ announce: false, browse: true, port: 7295, runtimeId: 'runtime-self' })

    const discovered: unknown[] = []
    svc.on('discovered', (peer) => discovered.push(peer))

    // Simulate the browser seeing our own announcement
    browser.emit('up', {
      txt: { runtime_id: 'runtime-self', proto: 'alf/0.2', directory: '/agents' },
      host: 'self.local',
      port: 7295
    })

    // And a different runtime
    browser.emit('up', {
      txt: { runtime_id: 'runtime-b', proto: 'alf/0.2', directory: '/agents' },
      host: 'host-b.local',
      port: 7295
    })

    expect(discovered).toHaveLength(1)
    expect((discovered[0] as { runtime_id: string }).runtime_id).toBe('runtime-b')
    await svc.stop()
  })

  it('emits expired when a service goes down', async () => {
    const browser = makeBrowser()
    mocks.findMock.mockReturnValue(browser)
    const svc = new MdnsService()
    await svc.start({ announce: false, browse: true, port: 7295, runtimeId: 'runtime-self' })

    const expired: unknown[] = []
    svc.on('expired', (peer) => expired.push(peer))

    browser.emit('up', {
      txt: { runtime_id: 'runtime-b', proto: 'alf/0.2', directory: '/agents' },
      host: 'host-b.local',
      port: 7295
    })
    browser.emit('down', {
      txt: { runtime_id: 'runtime-b' }
    })

    expect(expired).toHaveLength(1)
    expect((expired[0] as { runtime_id: string }).runtime_id).toBe('runtime-b')
    await svc.stop()
  })

  it('stop() calls unpublishAll then destroy (in order)', async () => {
    mocks.findMock.mockReturnValue(makeBrowser())
    const svc = new MdnsService()
    await svc.start({ announce: true, browse: true, port: 7295, runtimeId: 'runtime-a' })

    await svc.stop()

    expect(mocks.unpublishAllMock).toHaveBeenCalledTimes(1)
    expect(mocks.destroyMock).toHaveBeenCalledTimes(1)
    // unpublishAll before destroy
    expect(mocks.unpublishAllMock.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.destroyMock.mock.invocationCallOrder[0])
  })

  it('emits "unavailable" when Bonjour constructor throws and never throws itself', async () => {
    mocks.ctorThrows = new Error('port 5353 already in use')
    const svc = new MdnsService()
    const events: unknown[] = []
    svc.on('unavailable', (e) => events.push(e))

    await expect(svc.start({ announce: true, browse: true, port: 7295, runtimeId: 'runtime-a' })).resolves.toBeUndefined()

    expect(events).toHaveLength(1)
    expect((events[0] as { reason: string }).reason).toContain('5353')
    expect(mocks.publishMock).not.toHaveBeenCalled()
  })
})

describe('one discovery feed (remote-access.md §5.1)', () => {
  const remote = { name: 'agent-1-pc', port: 7385, fingerprint: 'ABCD-EFGH', pairingOpen: true, api: '2' }
  let browsers: Record<string, ReturnType<typeof makeBrowser>>
  beforeEach(() => {
    mocks.publishMock.mockReset()
    mocks.findMock.mockReset()
    mocks.unpublishAllMock.mockReset()
    mocks.destroyMock.mockReset()
    mocks.ctorThrows = null
    browsers = { 'adf-runtime': makeBrowser(), 'adf-daemon': makeBrowser() }
    mocks.findMock.mockImplementation((opts: { type: string }) => browsers[opts.type])
    mocks.publishMock.mockImplementation(() => ({ stop: (cb?: () => void) => cb?.() }))
  })

  it('one announcement carries both capabilities: the mesh and remote access; no secret or owner DID in TXT', async () => {
    const svc = new MdnsService()
    await svc.start({ announce: true, mesh: true, remote, browse: true, port: 7295, runtimeId: 'runtime-a', runtimeDid: 'did:key:zRuntime' })
    expect(mocks.publishMock).toHaveBeenCalledTimes(1)
    const opts = mocks.publishMock.mock.calls[0][0] as { type: string; port: number; txt: Record<string, string> }
    expect(opts.type).toBe('adf-runtime')
    expect(opts.port).toBe(7295)
    expect(opts.txt).toEqual({
      runtime_id: 'runtime-a', proto: 'alf/0.2', directory: '/agents', runtime_did: 'did:key:zRuntime',
      v: '1', fp: 'ABCD-EFGH', pair: '1', daemon_port: '7385', api: '2', name: 'agent-1-pc',
    })
    expect(Object.keys(opts.txt).some((k) => /owner|token|code|secret/i.test(k))).toBe(false)
    expect(svc.isAnnouncingRemote()).toBe(true)
    // The pairing window closes: the same record is re-published (no second service type), the browser stays.
    await svc.updateAnnouncement({ announce: true, mesh: true, remote: { ...remote, pairingOpen: false } })
    expect(mocks.publishMock).toHaveBeenCalledTimes(2)
    expect((mocks.publishMock.mock.calls[1][0] as { txt: Record<string, string> }).txt.pair).toBe('0')
    expect(mocks.findMock).toHaveBeenCalledTimes(2)
    // Remote access only (the mesh is not LAN-visible): only the remote-access fields, on the daemon's port.
    await svc.updateAnnouncement({ announce: true, mesh: false, remote })
    const third = mocks.publishMock.mock.calls[2][0] as { port: number; txt: Record<string, string> }
    expect(third.port).toBe(7385)
    expect(Object.keys(third.txt).sort()).toEqual(['daemon_port', 'fp', 'pair', 'v'])
    // Remote access off and the mesh not visible: nothing announced.
    await svc.updateAnnouncement({ announce: false })
    expect(svc.isAnnouncing()).toBe(false)
    expect(mocks.publishMock).toHaveBeenCalledTimes(3)
    expect(mocks.publishMock.mock.calls.every((c) => (c[0] as { type: string }).type === 'adf-runtime')).toBe(true)
    await svc.stop()
  })

  it('the client list and the mesh list come from the same feed', async () => {
    const svc = new MdnsService()
    await svc.start({ announce: false, browse: true, port: 7295, runtimeId: 'self' })
    const changes: number[] = []
    svc.on('peers_changed', () => changes.push(1))
    browsers['adf-runtime'].emit('up', {
      name: 'adf-peer-1', host: 'agent-1-pc.local', port: 7295, addresses: ['192.168.1.20'], referer: { address: '192.168.1.20' },
      txt: { runtime_id: 'peer-1', proto: 'alf/0.2', directory: '/agents', v: '1', fp: 'ABCD-EFGH', pair: '1', daemon_port: '7385', api: '2', name: 'agent-1-pc' },
    })
    expect(changes.length).toBeGreaterThan(0)
    // The mesh list.
    expect(svc.getDiscoveredRuntimes().map((r) => [r.runtime_id, r.url])).toEqual([['peer-1', 'http://192.168.1.20:7295']])
    // The feed: one entry, both capabilities.
    expect(svc.peers()).toEqual([{
      key: 'peer-1', name: 'agent-1-pc', source: 'mdns',
      mesh: { url: 'http://192.168.1.20:7295', port: 7295 },
      remote: { url: 'http://192.168.1.20:7385', port: 7385, fingerprint: 'ABCD-EFGH', pairingOpen: true, kind: 'lan' },
    }])
    // Studio's Discovered list reads the same service (embedded mode: the mesh's own).
    const updates: RemoteDiscoveryUpdate[] = []
    const discovery = new RemoteDiscovery({ feed: () => feed, onUpdate: (u) => updates.push(u), pairedFingerprint: () => null, log: { log: () => {}, warn: () => {} } })
    const feed = new InProcessPeerFeed({ mesh: () => svc })
    discovery.start()
    await vi.waitFor(() => expect(updates.at(-1)?.entries.length).toBe(1))
    expect(updates.at(-1)?.entries[0]).toMatchObject({ fingerprint: 'ABCD-EFGH', name: 'agent-1-pc', url: 'http://192.168.1.20:7385', kind: 'lan', pairingOpen: true })
    // The mesh browser was the only one: no second service was started for the list.
    expect(mocks.findMock).toHaveBeenCalledTimes(2)
    // Goodbye: gone from both lists.
    browsers['adf-runtime'].emit('down', { txt: { runtime_id: 'peer-1' } })
    expect(svc.getDiscoveredRuntimes()).toEqual([])
    discovery.refresh()
    await vi.waitFor(() => expect(updates.at(-1)?.entries).toEqual([]))
    discovery.stop()
    await svc.stop()
  })

  it('discovery review 2: a hidden mesh (remote access only) never carries the runtime id, DID or directory; its instance name is the alias or a per-network token', async () => {
    const hidden = new MdnsService()
    await hidden.start({ announce: true, mesh: false, remote: { ...remote, alias: null }, browse: false, port: 7295, runtimeId: 'runtime-secret', runtimeDid: 'did:key:zSecret' })
    const first = mocks.publishMock.mock.calls[0][0] as { name: string; port: number; txt: Record<string, string> }
    expect(first.txt).toEqual({ v: '1', fp: 'ABCD-EFGH', pair: '1', daemon_port: '7385' })
    expect(first.name).not.toContain('runtime-secret')
    expect(first.name).toMatch(/^adf-[0-9a-f]{12}$/)
    expect(JSON.stringify(first)).not.toMatch(/runtime-secret|zSecret|\/agents/)
    await hidden.stop()
    // Another network (a new service): another token, so nothing links the two.
    const again = new MdnsService()
    await again.start({ announce: true, mesh: false, remote: { ...remote, alias: null }, browse: false, port: 7295, runtimeId: 'runtime-secret' })
    expect((mocks.publishMock.mock.calls[1][0] as { name: string }).name).not.toBe(first.name)
    await again.stop()
    // The alias the user set is what people see anyway.
    const named = new MdnsService()
    await named.start({ announce: true, mesh: false, remote: { ...remote, alias: 'agent-1 desk' }, browse: false, port: 7295, runtimeId: 'runtime-secret' })
    expect((mocks.publishMock.mock.calls[2][0] as { name: string }).name).toBe('agent-1 desk')
    await named.stop()
  })

  it('a computer announcing remote access only is in the feed (by fingerprint) but not in the mesh list', async () => {
    const svc = new MdnsService()
    await svc.start({ announce: false, browse: true, port: 7295, runtimeId: 'self' })
    browsers['adf-runtime'].emit('up', {
      name: 'agent-2 laptop', host: 'host-2.local', port: 7385, addresses: ['192.168.1.30'], referer: { address: '192.168.1.30' },
      txt: { v: '1', fp: 'WXYZ-2345', pair: '0', daemon_port: '7385' },
    })
    expect(svc.getDiscoveredRuntimes()).toEqual([])
    expect(svc.peers()).toEqual([{ key: 'fp:WXYZ-2345', name: 'agent-2 laptop', source: 'mdns', mesh: null, remote: expect.objectContaining({ fingerprint: 'WXYZ-2345', url: 'http://192.168.1.30:7385' }) }])
    // A per-network token is not a name: the host name is shown instead.
    browsers['adf-runtime'].emit('up', {
      name: 'adf-0123456789ab', host: 'host-3.local', port: 7385, addresses: ['192.168.1.31'], referer: { address: '192.168.1.31' },
      txt: { v: '1', fp: 'QRST-2345', pair: '0', daemon_port: '7385' },
    })
    expect(svc.peers().find((p) => p.key === 'fp:QRST-2345')?.name).toBe('host-3')
    browsers['adf-runtime'].emit('down', { name: 'agent-2 laptop', txt: { v: '1', fp: 'WXYZ-2345' } })
    expect(svc.peers().map((p) => p.key)).toEqual(['fp:QRST-2345'])
    await svc.stop()
  })

  it('the legacy _adf-daemon._tcp is still discovered (one release), never announced', async () => {
    const svc = new MdnsService()
    await svc.start({ announce: true, mesh: true, remote, browse: true, port: 7295, runtimeId: 'self' })
    browsers['adf-daemon'].emit('up', {
      name: 'old-host', port: 7385, addresses: ['192.168.1.40', '172.20.0.1'], referer: { address: '192.168.1.40' },
      txt: { v: '1', fp: 'OLDH-2345', pair: '1', api: '1' },
    })
    expect(svc.peers()).toEqual([{ key: 'fp:OLDH-2345', name: 'old-host', source: 'mdns', mesh: null, remote: { url: 'http://192.168.1.40:7385', port: 7385, fingerprint: 'OLDH-2345', pairingOpen: true, kind: 'lan' } }])
    expect(svc.getDiscoveredRuntimes()).toEqual([])
    // Its own announcement on the legacy type is skipped by fingerprint.
    browsers['adf-daemon'].emit('up', { name: 'self', port: 7385, addresses: ['192.168.1.5'], txt: { v: '1', fp: 'ABCD-EFGH', pair: '0' } })
    expect(svc.peers().map((p) => p.key)).toEqual(['fp:OLDH-2345'])
    browsers['adf-daemon'].emit('down', { txt: { fp: 'OLDH-2345' } })
    expect(svc.peers()).toEqual([])
    expect(mocks.publishMock.mock.calls.map((c) => (c[0] as { type: string }).type)).toEqual(['adf-runtime'])
    await svc.stop()
  })

  it('the tailnet sweep feeds the same entries: a hello merges with the LAN sighting and wins', async () => {
    const svc = new MdnsService()
    await svc.start({ announce: false, browse: true, port: 7295, runtimeId: 'self' })
    browsers['adf-runtime'].emit('up', {
      name: 'adf-peer-1', host: 'agent-1-pc.local', port: 7295, addresses: ['192.168.1.20'], referer: { address: '192.168.1.20' },
      txt: { runtime_id: 'peer-1', v: '1', fp: 'ABCD-EFGH', pair: '0', daemon_port: '7385', api: '2', name: 'agent-1-pc' },
    })
    svc.upsertTailnetDaemon({ fingerprint: 'ABCD-EFGH', name: 'agent-1-pc', address: '100.101.102.103', port: 7385, pairingOpen: false })
    expect(svc.peers()).toEqual([expect.objectContaining({ key: 'peer-1', mesh: expect.objectContaining({ port: 7295 }), remote: expect.objectContaining({ url: 'http://100.101.102.103:7385', kind: 'tailnet' }) })])
    svc.expireTailnetDaemons(new Set())
    expect(svc.peers()[0].remote).toMatchObject({ url: 'http://192.168.1.20:7385', kind: 'lan' })
    await svc.stop()
  })
})
