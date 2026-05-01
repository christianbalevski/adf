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
    expect(txt.directory).toBe('/mesh/directory')
    // Hostname ends with .local
    expect(String(opts.host)).toMatch(/\.local$/)
    await svc.stop()
  })

  it('skips publishing when announce:false but still browses', async () => {
    mocks.findMock.mockReturnValue(makeBrowser())
    const svc = new MdnsService()
    await svc.start({ announce: false, browse: true, port: 7295, runtimeId: 'runtime-a' })

    expect(mocks.publishMock).not.toHaveBeenCalled()
    expect(mocks.findMock).toHaveBeenCalledTimes(1)
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
      txt: { runtime_id: 'runtime-self', proto: 'alf/0.2', directory: '/mesh/directory' },
      host: 'self.local',
      port: 7295
    })

    // And a different runtime
    browser.emit('up', {
      txt: { runtime_id: 'runtime-b', proto: 'alf/0.2', directory: '/mesh/directory' },
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
      txt: { runtime_id: 'runtime-b', proto: 'alf/0.2', directory: '/mesh/directory' },
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
