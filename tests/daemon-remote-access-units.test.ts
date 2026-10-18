/**
 * Remote access building blocks (docs/design/remote-access.md): the address
 * filter and the network identity and consent (§3.3, §3.3.1), the device
 * token store (§4.2-§4.3), the pairing window's limits (§5.3-§5.5), the
 * Tailscale and firewall parsers, and the request guard's token matrix (§4.4).
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NetworkInterfaceInfo } from 'node:os'
import { afterAll, describe, expect, it } from 'vitest'
import { addressCandidates, NOT_ALLOWED_SENTENCE } from '../src/main/daemon/remote-access/addresses'
import {
  parseDarwinArp, parseDarwinDefaultRoutes, parseLinuxArp, parseLinuxRoutes,
  parseWindowsArp, parseWindowsProfiles, parseWindowsRoutes, readGatewayIdentities, readOsCategories, readWifiNames,
} from '../src/main/daemon/remote-access/network-category'
import { lanNetworkId, mergeGatewayIdentity, NetworkWatcher, subnetOf, tailnetNetworkId } from '../src/main/daemon/remote-access/network-key'
import { DeviceStore, DEVICES_FILENAME, parseDeviceToken } from '../src/main/daemon/remote-access/device-store'
import { cleanDisplayName, fingerprintOf, loadRemoteAccessConfig, newDaemonId, saveRemoteAccessConfig, defaultRemoteAccessConfig } from '../src/main/daemon/remote-access/config'
import { PairingError, PairingManager, PAIRING_MAX_WRONG, PAIRING_MAX_WRONG_TOTAL } from '../src/main/daemon/remote-access/pairing'
import { BoundedMap, SOURCE_TRACKING_CAP } from '../src/main/daemon/remote-access/bounded-map'
import { parseServeStatus, parseTailscaleStatus } from '../src/main/daemon/remote-access/tailscale'
import { probeFirewall } from '../src/main/daemon/remote-access/firewall'
import { DaemonRequestGuard, isUnauthenticatedRoute, type DeviceTokenAuthority } from '../src/main/daemon/request-guard'
import { isDeviceRefusedRoute, isLocalOnlyRoute } from '../src/main/daemon/local-access'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'adf-remote-units-'))
  dirs.push(dir)
  return dir
}
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

function nic(address: string, extra: Partial<NetworkInterfaceInfo> = {}): NetworkInterfaceInfo {
  const family = address.includes(':') ? 'IPv6' : 'IPv4'
  return { address, family, internal: false, netmask: '', mac: '00:00:00:00:00:00', cidr: null, ...(family === 'IPv6' ? { scopeid: 0 } : {}), ...extra } as NetworkInterfaceInfo
}

describe('address candidates (§3.3) and what the OS tells about a network (§3.3.1)', () => {
  const interfaces = {
    lo: [nic('127.0.0.1', { internal: true })],
    'Wi-Fi': [nic('192.168.1.20'), nic('fe80::1'), nic('2001:db8::5'), nic('fd12:3456::7')],
    Ethernet: [nic('10.0.0.4')],
    eth2: [nic('fd99::2')],
    'vEthernet (WSL)': [nic('172.20.0.1')],
    docker0: [nic('172.17.0.1')],
    Tailscale: [nic('100.101.102.103'), nic('fd7a:115c:a1e0::1')],
    wwan0: [nic('100.70.1.2')],
    eth9: [nic('203.0.113.4')],
  }

  it('keeps private LAN and confirmed Tailscale addresses; drops public, link-local, global IPv6, CGNAT and virtual adapters', () => {
    const out = addressCandidates({ interfaces, tailscaleIps: new Set(['100.101.102.103', 'fd7a:115c:a1e0::1']) })
    // Wi-Fi's ULA is left out: the interface has a private IPv4 address; eth2 has only ULA.
    expect(out.map(c => `${c.address}/${c.kind}`)).toEqual([
      '100.101.102.103/tailnet',
      'fd7a:115c:a1e0::1/tailnet',
      '10.0.0.4/lan',
      '192.168.1.20/lan',
      'fd99::2/lan',
    ])
    // Unconfirmed 100.64/10 (carrier-grade NAT) and Tailscale IPv6 are never candidates.
    expect(addressCandidates({ interfaces, tailscaleIps: new Set() }).find(c => c.address.startsWith('100.') || c.address.startsWith('fd7a'))).toBeUndefined()
  })

  it('an `addresses` override still obeys every rule', () => {
    const out = addressCandidates({ interfaces, tailscaleIps: new Set(), only: ['10.0.0.4', '203.0.113.4'] })
    expect(out.map(c => c.address)).toEqual(['10.0.0.4'])
  })

  it('Windows: NetConnectionProfile categories, numbers (PS 5.1) or names; Public wins on a duplicate alias', () => {
    const profiles = parseWindowsProfiles(JSON.stringify([
      { InterfaceAlias: 'Wi-Fi', NetworkCategory: 1 },
      { InterfaceAlias: 'Ethernet', NetworkCategory: 'DomainAuthenticated' },
      { InterfaceAlias: 'Hotel', NetworkCategory: 0 },
      { InterfaceAlias: 'Dup', NetworkCategory: 0 },
      { InterfaceAlias: 'Dup', NetworkCategory: 1 },
    ]))
    expect(Object.fromEntries(profiles)).toEqual({ 'Wi-Fi': 'private', Ethernet: 'private', Hotel: 'public', Dup: 'public' })
    expect(Object.fromEntries(parseWindowsProfiles('{"InterfaceAlias":"Wi-Fi","NetworkCategory":"Public"}'))).toEqual({ 'Wi-Fi': 'public' })
  })

  it('the OS category is read on Windows only, shown only; a failed query is unknown', async () => {
    const exec = async () => JSON.stringify([{ InterfaceAlias: 'Wi-Fi', NetworkCategory: 1 }])
    expect(Object.fromEntries(await readOsCategories(['Wi-Fi'], { platform: 'win32', exec }))).toEqual({ 'Wi-Fi': 'private' })
    expect((await readOsCategories(['Wi-Fi'], { platform: 'win32', exec: async () => { throw new Error('powershell missing') } })).size).toBe(0)
    expect((await readOsCategories(['en0'], { platform: 'darwin', exec })).size).toBe(0)
  })

  it('the Wi-Fi name only where no permission prompt is needed: Linux iwgetid, macOS ipconfig getsummary (unless redacted); never on Windows', async () => {
    const calls: string[] = []
    const exec = async (file: string, args: string[]) => { calls.push(`${file} ${args.join(' ')}`); if (args[0] === 'eth0') throw new Error('not wireless'); return 'Home WiFi\n' }
    expect(Object.fromEntries(await readWifiNames(['wlan0', 'eth0'], { platform: 'linux', exec }))).toEqual({ wlan0: 'Home WiFi' })
    expect(calls).toEqual(['iwgetid wlan0 -r', 'iwgetid eth0 -r'])
    // Windows: the WLAN API needs location access (24H2 may prompt), so it is never called.
    expect((await readWifiNames(['Wi-Fi'], { platform: 'win32', exec })).size).toBe(0)
    expect(calls.length).toBe(2)
    // macOS: `ipconfig getsummary <iface>` never prompts; macOS 14.4+ redacts the name without location access.
    const summary = (ssid: string) => `<dictionary> {\n  BSSID : <redacted>\n  InterfaceType : WiFi\n  SSID : ${ssid}\n  Security : WPA2_PSK\n}\n`
    const mac = async (file: string, args: string[]) => {
      calls.push(`${file} ${args.join(' ')}`)
      if (args[1] === 'en1') return summary('<redacted>')
      if (args[1] === 'en2') return '<dictionary> {\n  InterfaceType : Ethernet\n}\n'
      return summary('Home WiFi')
    }
    expect(Object.fromEntries(await readWifiNames(['en0', 'en1', 'en2'], { platform: 'darwin', exec: mac }))).toEqual({ en0: 'Home WiFi' })
    expect(calls.slice(2)).toEqual(['ipconfig getsummary en0', 'ipconfig getsummary en1', 'ipconfig getsummary en2'])
  })

  it('macOS and Linux gateway parsers: netstat/arp, /proc/net/route (little-endian) and /proc/net/arp', () => {
    const netstat = 'Routing tables\n\nInternet:\nDestination        Gateway            Flags        Netif Expire\ndefault            192.168.1.1        UGScg          en0\ndefault            link#14            UCSIg        utun3\n'
    const arp = '? (192.168.1.1) at a4:2b:b0:1:2:3 on en0 ifscope [ethernet]\n? (192.168.1.9) at (incomplete) on en0 ifscope [ethernet]\n'
    expect(Object.fromEntries(parseDarwinDefaultRoutes(netstat))).toEqual({ en0: '192.168.1.1' })
    expect(parseDarwinArp(arp).get('en0|192.168.1.1')).toBe('a4:2b:b0:01:02:03')
    const route = 'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\nwlan0\t00000000\t0101A8C0\t0003\t0\t0\t600\t00000000\t0\t0\t0\neth1\t0001A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0\n'
    const linuxArp = 'IP address       HW type     Flags       HW address            Mask     Device\n192.168.1.1      0x1         0x2         a4:2b:b0:01:02:03     *        wlan0\n'
    expect(Object.fromEntries(parseLinuxRoutes(route))).toEqual({ wlan0: '192.168.1.1' })
    expect(parseLinuxArp(linuxArp).get('wlan0|192.168.1.1')).toBe('a4:2b:b0:01:02:03')
  })

  it('gateway identities per interface (security review item 2): Windows route + arp, Linux /proc; failures = unknown', async () => {
    const route = '===========================================================================\r\nActive Routes:\r\nNetwork Destination        Netmask          Gateway       Interface  Metric\r\n          0.0.0.0          0.0.0.0      192.168.1.1    192.168.1.23     35\r\n'
    const arp = '\r\nInterface: 192.168.1.23 --- 0x7\r\n  Internet Address      Physical Address      Type\r\n  192.168.1.1           a4-2b-b0-01-02-03     dynamic\r\n'
    expect(Object.fromEntries(parseWindowsRoutes(route))).toEqual({ '192.168.1.23': '192.168.1.1' })
    expect(parseWindowsArp(arp).get('192.168.1.23|192.168.1.1')).toBe('a4:2b:b0:01:02:03')
    const interfaces = { 'Wi-Fi': [nic('192.168.1.23')], Ethernet: [nic('10.0.0.4')] }
    const win = await readGatewayIdentities(['Wi-Fi', 'Ethernet'], interfaces, { platform: 'win32', exec: async (file) => (file === 'route' ? route : arp) })
    expect(Object.fromEntries(win)).toEqual({ 'Wi-Fi': '192.168.1.1|a4:2b:b0:01:02:03', Ethernet: '' })
    const linuxRoute = 'Iface\tDestination\tGateway\nwlan0\t00000000\t0101A8C0\t0003\n'
    const linuxArp = 'IP address       HW type     Flags       HW address            Mask     Device\n192.168.1.1      0x1         0x2         a4:2b:b0:01:02:03     *        wlan0\n'
    expect(Object.fromEntries(await readGatewayIdentities(['wlan0'], {}, { platform: 'linux', readText: async (p) => (p.endsWith('route') ? linuxRoute : linuxArp) })))
      .toEqual({ wlan0: '192.168.1.1|a4:2b:b0:01:02:03' })
    expect(Object.fromEntries(await readGatewayIdentities(['wlan0'], {}, { platform: 'linux', readText: async () => { throw new Error('no /proc') } }))).toEqual({ wlan0: '' })
  })
})

describe('network identity and consent (owner decision 2026-10-18 b)', () => {
  const wifi = (address: string) => ({ 'Wi-Fi': [nic(address, { netmask: '255.255.255.0', cidr: `${address}/24` })] })
  const watcher = (gateways: () => string, extra: { ssid?: string; os?: 'private' | 'public' } = {}) => new NetworkWatcher({
    readGateways: async (ifaces) => new Map(ifaces.map(i => [i, gateways()])),
    readWifiNames: async (ifaces) => new Map(extra.ssid ? ifaces.map(i => [i, extra.ssid!]) : []),
    readOsCategories: async (ifaces) => new Map(extra.os ? ifaces.map(i => [i, extra.os!]) : []),
    slowCheckMs: 60_000,
  })
  const HOME = lanNetworkId('a4:2b:b0:01:02:03', '192.168.1.0/24', null)
  const allowedHome = [{ id: HOME, kind: 'lan' as const, label: 'Wi-Fi (192.168.1.0/24)', addedAt: '2026-10-18T00:00:00Z' }]

  it('a LAN is its gateway MAC + subnet (+ Wi-Fi name where readable); the tailnet is its name', () => {
    expect(subnetOf({ address: '192.168.1.20', netmask: '255.255.255.0', cidr: null })).toBe('192.168.1.0/24')
    expect(subnetOf({ address: '10.1.2.3', netmask: '255.255.0.0', cidr: null })).toBe('10.1.0.0/16')
    expect(subnetOf({ address: 'fd12:3456:789a:1::5', netmask: 'ffff:ffff:ffff:ffff::', cidr: null })).toBe('fd12:3456:789a:1::/64')
    expect(HOME).toMatch(/^lan-[0-9a-f]{16}$/)
    // Same router, another subnet; another router, same subnet; another Wi-Fi name: each another network.
    expect(lanNetworkId('a4:2b:b0:01:02:03', '192.168.2.0/24', null)).not.toBe(HOME)
    expect(lanNetworkId('de:ad:be:ef:00:01', '192.168.1.0/24', null)).not.toBe(HOME)
    expect(lanNetworkId('a4:2b:b0:01:02:03', '192.168.1.0/24', 'Cafe')).not.toBe(HOME)
    expect(lanNetworkId('A4:2B:B0:01:02:03', '192.168.1.0/24', null)).toBe(HOME)
    expect(tailnetNetworkId('tail1234.ts.net')).toMatch(/^tailnet-[0-9a-f]{16}$/)
    expect(tailnetNetworkId('Tail1234.ts.net')).toBe(tailnetNetworkId('tail1234.ts.net'))
    expect(parseTailscaleStatus(JSON.stringify({ BackendState: 'Running', CurrentTailnet: { Name: 'agent-1@example.com', MagicDNSSuffix: 'tail1234.ts.net' }, Self: { TailscaleIPs: ['100.1.1.1'], DNSName: 'h.tail1234.ts.net.' } })).tailnet).toBe('agent-1@example.com')
    expect(parseTailscaleStatus(JSON.stringify({ BackendState: 'Running', MagicDNSSuffix: 'tail1234.ts.net.', Self: { TailscaleIPs: ['100.1.1.1'] } })).tailnet).toBe('tail1234.ts.net')
  })

  it('the shared change key: an unknown MAC keeps the previous identity; a known other MAC or gateway does not', () => {
    expect(mergeGatewayIdentity('192.168.1.1|aa', '192.168.1.1|')).toBe('192.168.1.1|aa')
    expect(mergeGatewayIdentity('192.168.1.1|aa', '')).toBe('192.168.1.1|aa')
    expect(mergeGatewayIdentity('192.168.1.1|aa', '192.168.1.1|bb')).toBe('192.168.1.1|bb')
    expect(mergeGatewayIdentity('192.168.1.1|aa', '10.0.0.1|')).toBe('10.0.0.1|')
  })

  it('first visit: nothing allowed, nothing listens, whatever the OS says (Windows Private too)', async () => {
    const read = await watcher(() => '192.168.1.1|a4:2b:b0:01:02:03', { os: 'private' }).read({ interfaces: wifi('192.168.1.20'), tailscaleIps: new Set(), tailnet: null, allowed: [] })
    expect(read.candidates).toEqual([expect.objectContaining({ address: '192.168.1.20', networkId: HOME, refusal: NOT_ALLOWED_SENTENCE })])
    expect(read.networks).toEqual([{ id: HOME, kind: 'lan', label: 'Wi-Fi (192.168.1.0/24)', allowed: false, osCategory: 'private', ifaces: ['Wi-Fi'], addresses: ['192.168.1.20'] }])
  })

  it('an allowed network listens; a gateway without a MAC yet cannot be identified, so it cannot be allowed', async () => {
    const allowed = await watcher(() => '192.168.1.1|a4:2b:b0:01:02:03').read({ interfaces: wifi('192.168.1.20'), tailscaleIps: new Set(), tailnet: null, allowed: allowedHome })
    expect(allowed.candidates[0].refusal).toBeNull()
    expect(allowed.networks[0]).toMatchObject({ allowed: true, osCategory: 'unknown' })
    const unknown = await watcher(() => '192.168.1.1|').read({ interfaces: wifi('192.168.1.20'), tailscaleIps: new Set(), tailnet: null, allowed: allowedHome })
    expect(unknown.candidates[0]).toMatchObject({ networkId: null, refusal: NOT_ALLOWED_SENTENCE })
    expect(unknown.networks[0]).toMatchObject({ id: null, allowed: false })
  })

  it('a changed network on an interface is reported before anything else is read; a missing MAC is no change', async () => {
    let gateway = '192.168.1.1|a4:2b:b0:01:02:03'
    const w = watcher(() => gateway)
    const changes: string[][] = []
    const read = () => w.read({ interfaces: wifi('192.168.1.20'), tailscaleIps: new Set(), tailnet: null, allowed: allowedHome, beforeChange: async (c) => { changes.push(c) } })
    await read()
    gateway = '192.168.1.1|'
    expect((await read()).candidates[0].refusal).toBeNull()
    gateway = '192.168.1.1|de:ad:be:ef:00:01'
    expect((await read()).candidates[0].refusal).toBe(NOT_ALLOWED_SENTENCE)
    expect(changes).toEqual([['Wi-Fi']])
  })

  it('consent review 1: an unreadable MAC is carried only on the same link; after the interface went down, Wi-Fi off/on or a new address the network is unidentified and never allowed', async () => {
    const offline = {} as Record<string, NetworkInterfaceInfo[]>
    const wifiOff = { 'Wi-Fi': [nic('fe80::5')] }
    for (const [what, between, after] of [
      ['interface went down', offline, '192.168.1.20'],
      ['Wi-Fi off and on', wifiOff, '192.168.1.20'],
      ['another address, same subnet', null, '192.168.1.30'],
    ] as const) {
      let gateway = '192.168.1.1|a4:2b:b0:01:02:03'
      const w = watcher(() => gateway)
      const read = (interfaces: Record<string, NetworkInterfaceInfo[]>) => w.read({ interfaces, tailscaleIps: new Set(), tailnet: null, allowed: allowedHome })
      expect((await read(wifi('192.168.1.20'))).candidates[0].refusal, what).toBeNull()
      if (between) await read(between)
      // A rogue access point: same subnet, gateway .1, never answers ARP.
      gateway = '192.168.1.1|'
      const r = await read(wifi(after))
      expect(r.candidates[0], what).toMatchObject({ networkId: null, refusal: NOT_ALLOWED_SENTENCE })
      expect(r.networks[0], what).toMatchObject({ id: null, label: 'Unidentified network', allowed: false })
    }
  })
})

describe('remote-access.json (§3.1)', () => {
  it('absent = off with a default name; a bad file = off with the reason, never silently on', () => {
    const dir = tempDir()
    expect(loadRemoteAccessConfig(dir)).toMatchObject({ config: { enabled: false, daemonId: null }, problem: null })
    writeFileSync(join(dir, 'remote-access.json'), '{"v":2,"enabled":true}')
    const bad = loadRemoteAccessConfig(dir)
    expect(bad.config.enabled).toBe(false)
    expect(bad.problem).toMatch(/unsupported version/)
    const config = { ...defaultRemoteAccessConfig(), enabled: true, name: 'agent-1 host', daemonId: newDaemonId() }
    saveRemoteAccessConfig(dir, config)
    expect(loadRemoteAccessConfig(dir).config).toMatchObject({ enabled: true, name: 'agent-1 host', daemonId: config.daemonId })
    if (process.platform !== 'win32') expect(statSync(join(dir, 'remote-access.json')).mode & 0o777).toBe(0o600)
    expect(fingerprintOf(config.daemonId)).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}$/)
  })

  it('display names refuse control and bidi characters (spoofing in the Allow prompt)', () => {
    expect(cleanDisplayName('  agent-2 laptop ', 64)).toBe('agent-2 laptop')
    expect(cleanDisplayName('evil\u202Egnp.exe', 64)).toBeNull()
    expect(cleanDisplayName('line\nbreak', 64)).toBeNull()
    expect(cleanDisplayName('', 64)).toBeNull()
    expect(cleanDisplayName('x'.repeat(65), 64)).toBeNull()
  })

  it('re-review 4: invisible fillers, tag characters and the soft hyphen are refused too', () => {
    for (const c of ['\u180E', '\u034F', '\u{E0001}', '\u{E0041}', '\u{E007F}', '\u2060', '\u2061', '\u2062', '\u2063', '\u2064', '\u3164', '\u115F', '\uFFA0', '\u00AD']) expect(cleanDisplayName(`agent${c}-2 laptop`, 64), c.codePointAt(0)!.toString(16)).toBeNull()
    // A name made only of Hangul fillers looks blank.
    expect(cleanDisplayName('\u3164\u3164', 64)).toBeNull()
  })
})

describe('device token store (§4.2, §4.3)', () => {
  it('stores only the hash: the token is returned once, the file never holds the secret', () => {
    const dir = tempDir()
    const store = new DeviceStore(dir)
    const { device, token } = store.create({ label: 'agent-2 laptop', origin: 'token', createdBy: 'cli' })
    expect(token).toMatch(/^adfd_[a-z2-7]{10}_[A-Za-z0-9_-]{43}$/)
    const parsed = parseDeviceToken(token)
    expect(parsed?.id).toBe(device.id)
    const file = readFileSync(join(dir, DEVICES_FILENAME), 'utf-8')
    expect(file).not.toContain(parsed?.secret)
    expect(file).toContain(device.secretSha256)
    if (process.platform !== 'win32') expect(statSync(join(dir, DEVICES_FILENAME)).mode & 0o777).toBe(0o600)
    expect(new DeviceStore(dir).check(token)).toMatchObject({ kind: 'device', device: { id: device.id } })
    // A wrong secret for a real id is unknown, not that device.
    expect(store.check(`adfd_${device.id}_${'A'.repeat(43)}`).kind).toBe('unknown')
  })

  it('revocation leaves a tombstone so the device is told; other devices keep working', () => {
    const dir = tempDir()
    const store = new DeviceStore(dir)
    const a = store.create({ label: 'agent-1 tablet', origin: 'paired', createdBy: 'studio' })
    const b = store.create({ label: 'agent-2 laptop', origin: 'token', createdBy: 'cli' })
    expect(store.revoke(a.device.id)?.label).toBe('agent-1 tablet')
    const reloaded = new DeviceStore(dir)
    expect(reloaded.check(a.token)).toMatchObject({ kind: 'revoked', tombstone: { label: 'agent-1 tablet' } })
    expect(reloaded.check(b.token).kind).toBe('device')
    expect(reloaded.revoke('zzzzzzzzzz')).toBeNull()
  })

  it('an unreadable file is never replaced: no device token is accepted and creating refuses', () => {
    const dir = tempDir()
    writeFileSync(join(dir, DEVICES_FILENAME), '{broken')
    const store = new DeviceStore(dir)
    expect(store.problem).toMatch(/no device token is accepted/)
    expect(() => store.create({ label: 'x', origin: 'token', createdBy: 'cli' })).toThrow(/cannot be read/)
    expect(readFileSync(join(dir, DEVICES_FILENAME), 'utf-8')).toBe('{broken')
  })

  it('lastSeen is exact in memory and written at most every 5 minutes', () => {
    const dir = tempDir()
    let now = Date.parse('2026-10-18T10:00:00Z')
    const store = new DeviceStore(dir, { now: () => now })
    const { device } = store.create({ label: 'agent-2 laptop', origin: 'token', createdBy: 'cli' })
    store.touch(device.id, '192.168.1.31')
    store.flushLastSeen()
    expect(new DeviceStore(dir).get(device.id)?.lastSeenAddress).toBe('192.168.1.31')
    now += 60_000
    store.touch(device.id, '192.168.1.32')
    store.flushLastSeen()
    expect(new DeviceStore(dir).get(device.id)?.lastSeenAddress).toBe('192.168.1.31')
    expect(store.get(device.id)?.lastSeenAddress).toBe('192.168.1.32')
    store.flushLastSeen(true)
    expect(new DeviceStore(dir).get(device.id)?.lastSeenAddress).toBe('192.168.1.32')
  })
})

describe('pairing window (§5.3-§5.5)', () => {
  function manager(now = { t: Date.parse('2026-10-18T10:00:00Z') }) {
    const events: string[] = []
    const m = new PairingManager({
      opened: () => events.push('opened'),
      closed: (reason) => events.push(`closed:${reason}`),
      claimPending: (claim) => events.push(`pending:${claim.deviceName}`),
      sourceLocked: (address) => events.push(`locked:${address}`),
    }, { now: () => now.t })
    return { m, events, now }
  }
  const claimInput = (code: string, address: string) => ({ code, deviceName: 'agent-2 laptop', clientKind: 'cli' as const, address, via: 'lan' as const, tailnetLogin: null })
  const wrongOf = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, '0')

  it('locks one source out after 5 wrong codes, tells the owner, and keeps the window open for others (security review item 8)', () => {
    const { m, events, now } = manager()
    const view = m.open()
    expect(view.code).toMatch(/^\d{6}$/)
    expect(view).toMatchObject({ attemptsLeft: PAIRING_MAX_WRONG_TOTAL, lockedSources: 0 })
    for (let i = 0; i < PAIRING_MAX_WRONG; i++) {
      now.t += 2_500
      let err: unknown
      try { m.claim(claimInput(wrongOf(view.code), '192.168.1.66')) } catch (e) { err = e }
      expect(err).toBeInstanceOf(PairingError)
      expect((err as PairingError).code).toBe('wrong_code')
      expect((err as PairingError).extra.attemptsLeft).toBe(PAIRING_MAX_WRONG - 1 - i)
    }
    expect(m.isOpen).toBe(true)
    expect(events).toContain('locked:192.168.1.66')
    expect(m.view()).toMatchObject({ attemptsLeft: PAIRING_MAX_WRONG_TOTAL - PAIRING_MAX_WRONG, lockedSources: 1 })
    now.t += 2_500
    // The locked source is refused even with the right code; another computer still pairs.
    expect(() => m.claim(claimInput(view.code, '192.168.1.66'))).toThrow(expect.objectContaining({ code: 'rate_limited', status: 429 }))
    expect(m.claim(claimInput(view.code, '192.168.1.31')).claimId).toMatch(/^[A-Za-z0-9_-]{22}$/)
  })

  it('closes the window after 20 wrong codes in total, and then answers as if never opened', () => {
    const { m, events, now } = manager()
    const view = m.open()
    for (let i = 0; i < PAIRING_MAX_WRONG_TOTAL; i++) {
      now.t += 2_500
      try { m.claim(claimInput(wrongOf(view.code), `192.168.1.${30 + i}`)) } catch { /* wrong */ }
    }
    expect(m.isOpen).toBe(false)
    expect(events).toContain('closed:wrong_codes')
    now.t += 2_500
    expect(() => m.claim(claimInput(view.code, '192.168.1.99'))).toThrow(expect.objectContaining({ code: 'pairing_closed', status: 404 }))
  })

  it('rate-limits each address (1 per 2 s, 10 per 10 minutes) with Retry-After', () => {
    const { m, now } = manager()
    const view = m.open()
    try { m.claim(claimInput(wrongOf(view.code), '192.168.1.50')) } catch { /* wrong */ }
    expect(() => m.claim(claimInput(view.code, '192.168.1.50'))).toThrow(expect.objectContaining({ code: 'rate_limited', status: 429 }))
    now.t += 2_100
    const ok = m.claim(claimInput(view.code, '192.168.1.50'))
    expect(ok.claimId).toMatch(/^[A-Za-z0-9_-]{22}$/)
  })

  it('a correct code waits for the owner; busy for others; approval delivers the token once', async () => {
    const { m, events, now } = manager()
    const view = m.open()
    const { claimId, collectSecret } = m.claim(claimInput(view.code, '192.168.1.31'))
    expect(events).toContain('pending:agent-2 laptop')
    now.t += 2_100
    expect(() => m.claim(claimInput(view.code, '192.168.1.32'))).toThrow(expect.objectContaining({ code: 'pairing_busy', status: 409 }))
    expect(await m.poll(claimId, collectSecret, 0)).toEqual({ state: 'pending' })
    const waiting = m.poll(claimId, collectSecret, 5_000)
    m.decide(claimId, true, () => ({ token: 'adfd_x', device: { id: 'abcdefghij', label: 'agent-2 laptop' }, daemon: { name: 'host', fingerprint: 'AAAA-BBBB', urls: [] } }))
    expect(await waiting).toMatchObject({ state: 'approved', token: 'adfd_x' })
    expect(await m.poll(claimId, collectSecret, 0)).toBeNull()
    expect(events).toContain('closed:paired')
    expect(() => m.decide(claimId, true, () => { throw new Error('never') })).toThrow(expect.objectContaining({ code: 'claim_not_found' }))
  })

  it('deny answers denied and closes; the code alone never yields a token', async () => {
    const { m } = manager()
    const view = m.open()
    const { claimId, collectSecret } = m.claim(claimInput(view.code, '192.168.1.31'))
    m.decide(claimId, false, () => { throw new Error('a denied claim mints nothing') })
    expect(await m.poll(claimId, collectSecret, 0)).toEqual({ state: 'denied' })
    expect(() => m.decide(claimId, true, () => { throw new Error('never') })).toThrow(expect.objectContaining({ code: 'claim_decided' }))
    expect(m.isOpen).toBe(false)
  })

  it('expires after 120 s, dropping a pending claim', async () => {
    const { m, now } = manager()
    const view = m.open()
    const { claimId, collectSecret } = m.claim(claimInput(view.code, '192.168.1.31'))
    now.t += 121_000
    expect(m.view()).toBeNull()
    m.close('expired')
    expect(await m.poll(claimId, collectSecret, 0)).toBeNull()
  })
})

describe('Tailscale and firewall parsers', () => {
  it('reads Self.TailscaleIPs and the MagicDNS name only while running', () => {
    expect(parseTailscaleStatus(JSON.stringify({ BackendState: 'Running', Self: { TailscaleIPs: ['100.101.102.103', 'FD7A:115C:A1E0::1'], DNSName: 'host-1.tail1234.ts.net.' } })))
      .toEqual({ state: 'running', ips: ['100.101.102.103', 'fd7a:115c:a1e0::1'], dnsName: 'host-1.tail1234.ts.net', tailnet: null })
    expect(parseTailscaleStatus(JSON.stringify({ BackendState: 'Stopped', Self: { TailscaleIPs: ['100.1.1.1'] } }))).toEqual({ state: 'stopped', ips: [], dnsName: null, tailnet: null })
  })

  it('serve is on only when a handler proxies to this daemon\'s port', () => {
    const json = JSON.stringify({ TCP: { 443: { HTTPS: true } }, Web: { 'host-1.tail1234.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:7385' } } } } })
    expect(parseServeStatus(json, 7385)).toEqual({ serve: 'on', httpsUrl: 'https://host-1.tail1234.ts.net' })
    expect(parseServeStatus(json, 7386)).toEqual({ serve: 'off', httpsUrl: null })
    expect(parseServeStatus('{}', 7385)).toEqual({ serve: 'off', httpsUrl: null })
  })

  it('firewall: Windows block rules and Public networks, macOS block-all, Linux commands', async () => {
    expect((await probeFirewall({ port: 7385, platform: 'win32', program: 'C:\\ADF Studio.exe', exec: async () => '1\r\n' })).state).toBe('blocked')
    expect((await probeFirewall({ port: 7385, platform: 'win32', exec: async () => '0' })).state).toBe('ok')
    const mac = (blockAll: string) => async (_f: string, args: string[]) => (args[0] === '--getglobalstate' ? 'Firewall is enabled. (State = 1)' : args[0] === '--getblockall' ? blockAll : 'is permitted')
    expect((await probeFirewall({ port: 7385, platform: 'darwin', exec: mac('Firewall has block all state set to enabled.') })).state).toBe('blocked')
    expect((await probeFirewall({ port: 7385, platform: 'darwin', exec: mac('Block all DISABLED!') })).state).toBe('ok')
    const linux = await probeFirewall({ port: 7385, platform: 'linux' })
    expect(linux.state).toBe('unknown')
    expect(linux.commands.join('\n')).toMatch(/ufw allow .*7385/)
  })
})

describe('request guard token matrix (§4.4, §4.5)', () => {
  const MASTER = 'm'.repeat(43)
  const DEVICE = `adfd_abcdefghij_${'s'.repeat(43)}`
  const REVOKED = `adfd_revokedaaa_${'s'.repeat(43)}`
  function guard(enabled = true) {
    const devices: DeviceTokenAuthority = {
      check: (t) => (t === DEVICE ? { kind: 'device', id: 'abcdefghij', label: 'agent-2 laptop' } : t === REVOKED ? { kind: 'revoked', label: 'old', revokedAt: '2026-10-01T00:00:00Z' } : { kind: 'unknown' }),
      enabled: () => enabled,
      computerName: () => 'host-1',
    }
    return new DaemonRequestGuard({ token: MASTER, deviceTokens: devices })
  }
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` })
  const local = { remoteListener: false }
  const remote = { remoteListener: true }

  it('the install token works on loopback and is refused on a remote listener', () => {
    expect(guard().authenticate('GET', '/agents', bearer(MASTER), local)).toEqual({ rejection: null, auth: { kind: 'master' } })
    expect(guard().authenticate('GET', '/agents', bearer(MASTER), remote).rejection).toMatchObject({ status: 401, body: { code: 'master_token_remote' } })
  })

  it('a device token is refused on every local-only and management route, from any listener', () => {
    for (const path of ['/identity/import', '/identity/unlock', '/daemon/shutdown', '/agents/x/identity/reveal', '/settings/providers/keys/reveal', '/client/reload-credentials', '/remote-access', '/remote-access/devices', '/remote-access/devices/abcdefghij', '/remote-access/pairing', '/remote-access/pairing/claims/c1', '/remote-access/tailscale-serve']) {
      expect(isLocalOnlyRoute(path)).toBe(true)
      for (const conn of [local, remote]) {
        expect(guard().authenticate('POST', path, bearer(DEVICE), conn).rejection).toMatchObject({ status: 403, body: { code: 'device_token_refused' } })
      }
    }
    expect(guard().authenticate('GET', '/agents', bearer(DEVICE), remote)).toEqual({ rejection: null, auth: { kind: 'device', deviceId: 'abcdefghij', label: 'agent-2 laptop' } })
  })

  it('the client-session routes whose handlers decide per request stay open to devices', () => {
    for (const [method, path] of [['POST', '/client/sessions'], ['POST', '/client/sessions/s1/quit'], ['PUT', '/client/sessions/s1/exit-when-closed']]) {
      expect(isDeviceRefusedRoute(method, path)).toBe(false)
      expect(guard().authenticate(method, path, bearer(DEVICE), remote).rejection).toBeNull()
    }
    expect(isDeviceRefusedRoute('GET', '/client/sessions')).toBe(true)
  })

  it('a device token while remote access is off, and a revoked one, get their sentences', () => {
    expect(guard(false).authenticate('GET', '/agents', bearer(DEVICE), local).rejection).toMatchObject({ status: 401, body: { code: 'remote_access_off' } })
    expect(guard().authenticate('GET', '/agents', bearer(REVOKED), remote).rejection).toMatchObject({ status: 401, body: { code: 'device_revoked' } })
    expect(guard().authenticate('GET', '/agents', bearer(`adfd_unknownaa_${'x'.repeat(43)}`), remote).rejection).toMatchObject({ status: 401, body: { code: 'unauthorized' } })
  })

  it('only /health and the pairing routes need no token', () => {
    expect(isUnauthenticatedRoute('GET', '/remote/hello')).toBe(true)
    expect(isUnauthenticatedRoute('POST', '/pair/claim')).toBe(true)
    expect(isUnauthenticatedRoute('GET', '/pair/claims/abc')).toBe(true)
    expect(isUnauthenticatedRoute('POST', '/pair/claims/abc')).toBe(false)
    expect(isUnauthenticatedRoute('GET', '/remote-access')).toBe(false)
    expect(guard().authenticate('POST', '/pair/claim', {}, remote)).toEqual({ rejection: null, auth: { kind: 'none' } })
    expect(guard().authenticate('GET', '/agents', {}, remote).rejection).toMatchObject({ status: 401 })
  })
})

describe('bounded per-source counters (security review item 3)', () => {
  it('the pairing limiter keeps at most SOURCE_TRACKING_CAP sources, dropping the oldest', () => {
    const m = new PairingManager({ opened: () => {}, closed: () => {}, claimPending: () => {}, sourceLocked: () => {} })
    m.open()
    for (let i = 0; i < SOURCE_TRACKING_CAP + 500; i++) {
      try { m.claim({ code: 'xxxxxx', deviceName: 'agent-2', clientKind: 'cli', source: `src-${i}`, address: '192.168.1.2', via: 'lan', tailnetLogin: null }) } catch { /* wrong code or closed */ }
    }
    expect((m as unknown as { perAddress: BoundedMap<string, number[]> }).perAddress.size).toBe(SOURCE_TRACKING_CAP)
    const b = new BoundedMap<string, number>(2)
    b.set('a', 1); b.set('b', 2); b.set('a', 3); b.set('c', 4)
    expect([b.get('a'), b.get('b'), b.get('c')]).toEqual([3, undefined, 4])
  })
})

describe('display names (security review item 4)', () => {
  const ch = (code: number) => String.fromCharCode(code)
  it('refuses every bidi control, line/paragraph separators, zero-width characters and U+FEFF', () => {
    for (const code of [0x061c, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2028, 0x2029, 0x202a, 0x202e, 0x2060, 0x2066, 0x2069, 0xfeff, 0x0007, 0x0085]) {
      expect(cleanDisplayName(`agent${ch(code)}-2`, 64), code.toString(16)).toBeNull()
    }
  })
  it('collapses whitespace and caps the length before and after', () => {
    expect(cleanDisplayName(`  agent-2${ch(0xa0)}${ch(0xa0)} laptop\t`, 64)).toBeNull() // tab is a control character
    expect(cleanDisplayName(`  agent-2${ch(0xa0)}${ch(0x3000)}  laptop `, 64)).toBe('agent-2 laptop')
    expect(cleanDisplayName('a'.repeat(64), 64)).toBe('a'.repeat(64))
    expect(cleanDisplayName('a'.repeat(65), 64)).toBeNull()
    expect(cleanDisplayName(' '.repeat(1000) + 'a', 64)).toBeNull()
  })
})
