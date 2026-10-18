/**
 * Remote access building blocks (docs/design/remote-access.md): the address
 * filter and the public/private network rule (§3.3, §3.3.1), the device
 * token store (§4.2-§4.3), the pairing window's limits (§5.3-§5.5), the
 * Tailscale and firewall parsers, and the request guard's token matrix (§4.4).
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NetworkInterfaceInfo } from 'node:os'
import { afterAll, describe, expect, it } from 'vitest'
import { addressCandidates, PUBLIC_NETWORK_SENTENCE } from '../src/main/daemon/remote-access/addresses'
import {
  currentNetworks, networkId, parseDarwinArp, parseDarwinDefaultRoutes, parseLinuxArp, parseLinuxRoutes,
  parseWindowsArp, parseWindowsProfiles, parseWindowsRoutes, readGatewayIdentities, readNetworkCategories,
} from '../src/main/daemon/remote-access/network-category'
import { DeviceStore, DEVICES_FILENAME, parseDeviceToken } from '../src/main/daemon/remote-access/device-store'
import { cleanDisplayName, fingerprintOf, loadRemoteAccessConfig, newDaemonId, saveRemoteAccessConfig, defaultRemoteAccessConfig } from '../src/main/daemon/remote-access/config'
import { PairingError, PairingManager, PAIRING_MAX_WRONG } from '../src/main/daemon/remote-access/pairing'
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

describe('address candidates (§3.3) and public networks (§3.3.1)', () => {
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
    const out = addressCandidates({
      interfaces,
      tailscaleIps: new Set(['100.101.102.103', 'fd7a:115c:a1e0::1']),
      categories: new Map([['Wi-Fi', 'private'], ['Ethernet', 'private'], ['eth2', 'private']]),
    })
    // Wi-Fi's ULA is left out: the interface has a private IPv4 address; eth2 has only ULA.
    expect(out.map(c => `${c.address}/${c.kind}/${c.network}`)).toEqual([
      '100.101.102.103/tailnet/tailnet',
      'fd7a:115c:a1e0::1/tailnet/tailnet',
      '10.0.0.4/lan/private',
      '192.168.1.20/lan/private',
      'fd99::2/lan/private',
    ])
    expect(out.every(c => c.refusal === null)).toBe(true)
  })

  it('never listens on a network that is not marked private: unsure = public (owner decision O2)', () => {
    const out = addressCandidates({ interfaces, tailscaleIps: new Set(), categories: new Map([['Wi-Fi', 'public']]) })
    const lan = out.filter(c => c.kind === 'lan')
    expect(lan.length).toBe(3) // 192.168.1.20, 10.0.0.4, fd99::2
    // Wi-Fi is Public; Ethernet has no category at all: both refused.
    expect(lan.every(c => c.network === 'public' && c.refusal === PUBLIC_NETWORK_SENTENCE)).toBe(true)
    // Unconfirmed 100.64/10 (carrier-grade NAT) and Tailscale IPv6 are never candidates.
    expect(out.find(c => c.address.startsWith('100.') || c.address.startsWith('fd7a'))).toBeUndefined()
  })

  it('an `addresses` override still obeys every rule', () => {
    const out = addressCandidates({ interfaces, tailscaleIps: new Set(), categories: new Map([['Ethernet', 'private']]), only: ['10.0.0.4', '203.0.113.4'] })
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

  it('Windows: a failed query makes every interface public and says why', async () => {
    const read = await readNetworkCategories(['Wi-Fi'], [], { platform: 'win32', exec: async () => { throw new Error('powershell missing') } })
    expect(read.categories.get('Wi-Fi')).toBe('public')
    expect(read.problem).toMatch(/treating it as public/)
  })

  it('macOS: the default gateway (IP + MAC) identifies the network; only an owner-marked one is private', async () => {
    const netstat = 'Routing tables\n\nInternet:\nDestination        Gateway            Flags        Netif Expire\ndefault            192.168.1.1        UGScg          en0\ndefault            link#14            UCSIg        utun3\n'
    const arp = '? (192.168.1.1) at a4:2b:b0:1:2:3 on en0 ifscope [ethernet]\n? (192.168.1.9) at (incomplete) on en0 ifscope [ethernet]\n'
    expect(Object.fromEntries(parseDarwinDefaultRoutes(netstat))).toEqual({ en0: '192.168.1.1' })
    expect(parseDarwinArp(arp).get('en0|192.168.1.1')).toBe('a4:2b:b0:01:02:03')
    const exec = async (file: string) => (file === 'netstat' ? netstat : arp)
    const home = networkId('192.168.1.1', 'a4:2b:b0:01:02:03')
    const unknown = await readNetworkCategories(['en0'], [], { platform: 'darwin', exec })
    expect(unknown.categories.get('en0')).toBe('public')
    expect(unknown.current).toEqual([{ iface: 'en0', id: home, label: 'en0 via 192.168.1.1' }])
    const trusted = await readNetworkCategories(['en0'], [{ id: home, label: 'en0 via 192.168.1.1', addedAt: '2026-10-18T00:00:00Z' }], { platform: 'darwin', exec })
    expect(trusted.categories.get('en0')).toBe('private')
    // Same gateway IP, another router (hotel): another network.
    expect(networkId('192.168.1.1', 'de:ad:be:ef:00:01')).not.toBe(home)
  })

  it('Linux: /proc/net/route (little-endian gateway) and /proc/net/arp; no gateway or no MAC = not identified', async () => {
    const route = 'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\nwlan0\t00000000\t0101A8C0\t0003\t0\t0\t600\t00000000\t0\t0\t0\neth1\t0001A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0\n'
    const arp = 'IP address       HW type     Flags       HW address            Mask     Device\n192.168.1.1      0x1         0x2         a4:2b:b0:01:02:03     *        wlan0\n'
    const routes = parseLinuxRoutes(route)
    expect(Object.fromEntries(routes)).toEqual({ wlan0: '192.168.1.1' })
    const macs = parseLinuxArp(arp)
    expect(currentNetworks(['wlan0', 'eth1'], routes, macs).map(n => n.iface)).toEqual(['wlan0'])
    const read = await readNetworkCategories(['wlan0', 'eth1'], [], { platform: 'linux', readText: async (p) => (p.endsWith('route') ? route : arp) })
    expect(Object.fromEntries(read.categories)).toEqual({ wlan0: 'public', eth1: 'public' })
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
    }, { now: () => now.t })
    return { m, events, now }
  }
  const claimInput = (code: string, address: string) => ({ code, deviceName: 'agent-2 laptop', clientKind: 'cli' as const, address, via: 'lan' as const, tailnetLogin: null })
  const wrongOf = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, '0')

  it('locks out after 5 wrong codes, across addresses, and then answers as if never opened', () => {
    const { m, events, now } = manager()
    const view = m.open()
    expect(view.code).toMatch(/^\d{6}$/)
    for (let i = 0; i < PAIRING_MAX_WRONG; i++) {
      now.t += 2_500
      let err: unknown
      try { m.claim(claimInput(wrongOf(view.code), `192.168.1.${30 + i}`)) } catch (e) { err = e }
      expect(err).toBeInstanceOf(PairingError)
      expect((err as PairingError).code).toBe('wrong_code')
      expect((err as PairingError).extra.attemptsLeft).toBe(PAIRING_MAX_WRONG - 1 - i)
    }
    expect(m.isOpen).toBe(false)
    expect(events).toContain('closed:wrong_codes')
    now.t += 2_500
    // Even the right code is refused now: the window is closed.
    expect(() => m.claim(claimInput(view.code, '192.168.1.40'))).toThrow(expect.objectContaining({ code: 'pairing_closed', status: 404 }))
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
      .toEqual({ state: 'running', ips: ['100.101.102.103', 'fd7a:115c:a1e0::1'], dnsName: 'host-1.tail1234.ts.net' })
    expect(parseTailscaleStatus(JSON.stringify({ BackendState: 'Stopped', Self: { TailscaleIPs: ['100.1.1.1'] } }))).toEqual({ state: 'stopped', ips: [], dnsName: null })
  })

  it('serve is on only when a handler proxies to this daemon\'s port', () => {
    const json = JSON.stringify({ TCP: { 443: { HTTPS: true } }, Web: { 'host-1.tail1234.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:7385' } } } } })
    expect(parseServeStatus(json, 7385)).toEqual({ serve: 'on', httpsUrl: 'https://host-1.tail1234.ts.net' })
    expect(parseServeStatus(json, 7386)).toEqual({ serve: 'off', httpsUrl: null })
    expect(parseServeStatus('{}', 7385)).toEqual({ serve: 'off', httpsUrl: null })
  })

  it('firewall: Windows block rules and Public networks, macOS block-all, Linux commands', async () => {
    expect((await probeFirewall({ port: 7385, allLanPublic: false, platform: 'win32', program: 'C:\\ADF Studio.exe', exec: async () => '1\r\n' })).state).toBe('blocked')
    expect((await probeFirewall({ port: 7385, allLanPublic: true, platform: 'win32', exec: async () => '0' })).state).toBe('public_network')
    expect((await probeFirewall({ port: 7385, allLanPublic: false, platform: 'win32', exec: async () => '0' })).state).toBe('ok')
    const mac = (blockAll: string) => async (_f: string, args: string[]) => (args[0] === '--getglobalstate' ? 'Firewall is enabled. (State = 1)' : args[0] === '--getblockall' ? blockAll : 'is permitted')
    expect((await probeFirewall({ port: 7385, allLanPublic: false, platform: 'darwin', exec: mac('Firewall has block all state set to enabled.') })).state).toBe('blocked')
    expect((await probeFirewall({ port: 7385, allLanPublic: false, platform: 'darwin', exec: mac('Block all DISABLED!') })).state).toBe('ok')
    const linux = await probeFirewall({ port: 7385, allLanPublic: false, platform: 'linux' })
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
