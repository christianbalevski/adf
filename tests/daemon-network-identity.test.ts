/**
 * Network identity on macOS (docs/design/remote-access.md §3.3.1): the
 * exact `netstat -rn -f inet` and `arp -an` formats of a Mac with Tailscale
 * (not an exit node), the tools by absolute path (a GUI app's or a login
 * shell's PATH may leave out /usr/sbin), and the reason an unidentified
 * network carries to the log, the status and the UI. Synthetic values only.
 */
import type { NetworkInterfaceInfo } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  DARWIN_TOOLS, parseDarwinArp, parseDarwinDefaultRoutes, readGatewayIdentities, readGatewayReadings, readWifiNames,
  type CategoryReaderDeps, type Exec,
} from '../src/main/daemon/remote-access/network-category'
import { lanNetworkId, NetworkWatcher, toGatewayReading } from '../src/main/daemon/remote-access/network-key'
import { networkQuestion } from '../src/main/backend/remote-access/network-consent'
import { unidentifiedText } from '../src/shared/utils/network-consent-text'

// `netstat -rn -f inet | grep default` and `arp -an` on a Mac with Tailscale running (not an exit node).
const NETSTAT = [
  'Routing tables',
  '',
  'Internet:',
  'Destination        Gateway            Flags               Netif Expire',
  'default            192.168.1.1        UGScg                 en0       ',
  'default            link#23            UCSIg               utun4       ',
  '127                127.0.0.1          UCS                   lo0       ',
  '192.168.1          link#11            UCS                   en0      !',
  '',
].join('\n')
const ARP = [
  '? (192.168.1.1) at aa:bb:cc:dd:ee:01 on en0 ifscope [ethernet]',
  '? (192.168.1.20) at aa:b:c:1:2:3 on en0 ifscope permanent [ethernet]',
  '? (192.168.1.31) at 0:f6:8:38:90:9 on en0 ifscope [ethernet]',
  '? (192.168.1.44) at (incomplete) on en0 ifscope [ethernet]',
  '? (224.0.0.251) at 1:0:5e:0:0:fb on en0 ifscope permanent [ethernet]',
  '',
].join('\n')
const MAC = 'aa:bb:cc:dd:ee:01'

function nic(address: string, extra: Partial<NetworkInterfaceInfo> = {}): NetworkInterfaceInfo {
  const family = address.includes(':') ? 'IPv6' : 'IPv4'
  return { address, family, internal: false, netmask: family === 'IPv4' ? '255.255.255.0' : 'ffff:ffff:ffff:ffff::', mac: '00:00:00:00:00:00', cidr: null, ...(family === 'IPv6' ? { scopeid: 0 } : {}), ...extra } as NetworkInterfaceInfo
}

const MAC_INTERFACES = {
  lo0: [nic('127.0.0.1', { internal: true })],
  en0: [nic('fe80::1c2b:3c4d:5e6f:7a8b'), nic('192.168.1.20')],
  utun4: [nic('100.101.102.103')],
  awdl0: [nic('fe80::aa:bbff:fecc:dd01')],
}

function enoent(file: string): Error {
  return Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT', path: file })
}

/** A Mac: the tools answer by absolute path; by name only when `onPath` (PATH has /usr/sbin). */
function macExec(opts: { onPath: boolean; calls?: string[]; netstat?: string; arp?: string }): Exec {
  return async (file, args) => {
    opts.calls?.push(`${file} ${args.join(' ')}`)
    const name = file.replace(/^\/usr\/sbin\//, '')
    if (file === name && !opts.onPath) throw enoent(file)
    if (name === 'netstat') return opts.netstat ?? NETSTAT
    if (name === 'arp') return opts.arp ?? ARP
    throw enoent(file)
  }
}

const quiet: Pick<CategoryReaderDeps, 'probe' | 'sleep'> = { probe: async () => null, sleep: async () => {} }

describe('macOS gateway: the exact formats', () => {
  it('netstat: en0 → its gateway; the scoped Tailscale default (link#23 on utun4) is skipped; older Refs/Use columns too', () => {
    expect(Object.fromEntries(parseDarwinDefaultRoutes(NETSTAT))).toEqual({ en0: '192.168.1.1' })
    const older = 'Destination        Gateway            Flags        Refs      Use   Netif Expire\ndefault            192.168.1.1        UGSc           12        0     en0\n'
    expect(Object.fromEntries(parseDarwinDefaultRoutes(older))).toEqual({ en0: '192.168.1.1' })
  })

  it('arp: octets without a leading zero are padded; incomplete entries are skipped', () => {
    const arp = parseDarwinArp(ARP)
    expect(arp.get('en0|192.168.1.1')).toBe(MAC)
    expect(arp.get('en0|192.168.1.20')).toBe('aa:0b:0c:01:02:03')
    expect(arp.get('en0|192.168.1.31')).toBe('00:f6:08:38:90:09')
    expect(arp.has('en0|192.168.1.44')).toBe(false)
  })

  it('the whole check identifies en0 (utun4 is the tailnet, never asked about)', async () => {
    const readings = await readGatewayReadings(['en0'], MAC_INTERFACES, { platform: 'darwin', exec: macExec({ onPath: true }), ...quiet })
    expect(Object.fromEntries(readings)).toEqual({ en0: { gateway: '192.168.1.1', mac: MAC, problem: null } })
  })
})

describe('macOS gateway: the tools by absolute path (the cause)', () => {
  it('PATH without /usr/sbin (Finder, launchd, a login shell that drops it): still identified', async () => {
    const calls: string[] = []
    const out = await readGatewayIdentities(['en0'], MAC_INTERFACES, { platform: 'darwin', exec: macExec({ onPath: false, calls }), ...quiet })
    expect(Object.fromEntries(out)).toEqual({ en0: `192.168.1.1|${MAC}` })
    expect(calls).toEqual([`${DARWIN_TOOLS.netstat} -rn -f inet`, `${DARWIN_TOOLS.arp} -an`])
  })

  it('an absolute path that is missing falls back to the name on PATH', async () => {
    const calls: string[] = []
    const exec: Exec = async (file, args) => {
      calls.push(file)
      if (file.startsWith('/')) throw enoent(file)
      return macExec({ onPath: true })(file, args)
    }
    const out = await readGatewayIdentities(['en0'], MAC_INTERFACES, { platform: 'darwin', exec, ...quiet })
    expect(Object.fromEntries(out)).toEqual({ en0: `192.168.1.1|${MAC}` })
    expect(calls).toEqual(['/usr/sbin/netstat', 'netstat', '/usr/sbin/arp', 'arp'])
  })

  it('the Wi-Fi name: /usr/sbin/ipconfig; redacted or missing is no name, never unidentified', async () => {
    const calls: string[] = []
    const exec: Exec = async (file, args) => {
      calls.push(`${file} ${args.join(' ')}`)
      return '<dictionary> {\n  InterfaceType : WiFi\n  SSID : <redacted>\n}\n'
    }
    expect((await readWifiNames(['en0'], { platform: 'darwin', exec })).size).toBe(0)
    expect(calls).toEqual(['/usr/sbin/ipconfig getsummary en0'])
    const w = new NetworkWatcher({ readGateways: async () => new Map([['en0', `192.168.1.1|${MAC}`]]), readWifiNames: async () => new Map(), slowCheckMs: 60_000 })
    const r = await w.read({ interfaces: MAC_INTERFACES, tailscaleIps: new Set(['100.101.102.103']), tailnet: null, allowed: [] })
    expect(r.networks.find((n) => n.kind === 'lan')).toMatchObject({ id: lanNetworkId(MAC, '192.168.1.0/24', null), label: 'en0 (192.168.1.0/24)', allowed: false })
  })
})

describe('an unidentified network says which step failed', () => {
  const read = (deps: CategoryReaderDeps) => readGatewayReadings(['en0'], MAC_INTERFACES, { platform: 'darwin', ...quiet, ...deps })

  it('route table, no default route, ARP table, no answer (with the probe error)', async () => {
    const noTools: Exec = async (file) => { throw enoent(file) }
    expect((await read({ exec: noTools })).get('en0')).toEqual({ gateway: null, mac: null, problem: { step: 'route_read', detail: 'netstat -rn -f inet: spawn netstat ENOENT' } })

    const onlyTailscale = 'default            link#23            UCSIg               utun4\n'
    expect((await read({ exec: macExec({ onPath: true, netstat: onlyTailscale }) })).get('en0')?.problem).toMatchObject({ step: 'no_gateway' })

    const noArp: Exec = async (file, args) => {
      if (file.endsWith('arp')) throw Object.assign(new Error('Command failed: /usr/sbin/arp -an\narp: sysctl: Operation not permitted'), { code: 1 })
      return macExec({ onPath: true })(file, args)
    }
    expect((await read({ exec: noArp })).get('en0')).toEqual({ gateway: '192.168.1.1', mac: null, problem: { step: 'arp_read', detail: 'arp -an: Command failed: /usr/sbin/arp -an' } })

    const probes: string[] = []
    const silent = await read({ exec: macExec({ onPath: true, arp: '' }), probe: async (gateway, from) => { probes.push(`${from}>${gateway}`); return 'send EHOSTUNREACH 192.168.1.1:9' } })
    expect(probes).toEqual(['192.168.1.20>192.168.1.1', '192.168.1.20>192.168.1.1', '192.168.1.20>192.168.1.1'])
    expect(silent.get('en0')).toEqual({ gateway: '192.168.1.1', mac: null, problem: { step: 'no_answer', detail: 'no ARP entry for 192.168.1.1 on en0 after 3 probe(s) (probe: send EHOSTUNREACH 192.168.1.1:9)' } })
  })

  it('the view carries the reason; the log gets one line per change, not one per check; consent never matches', async () => {
    let gateway: string | ReturnType<typeof toGatewayReading> = { gateway: null, mac: null, problem: { step: 'route_read', detail: 'netstat -rn -f inet: spawn netstat ENOENT' } }
    const lines: string[] = []
    const home = lanNetworkId(MAC, '192.168.1.0/24', null)
    const w = new NetworkWatcher({ readGateways: async () => new Map([['en0', gateway]]), slowCheckMs: 60_000, log: (l) => lines.push(l) })
    const check = () => w.read({ interfaces: MAC_INTERFACES, tailscaleIps: new Set(), tailnet: null, allowed: [{ id: home, kind: 'lan', label: 'en0 (192.168.1.0/24)', addedAt: '2026-10-18T00:00:00Z' }] })
    const r = await check()
    expect(r.candidates[0]).toMatchObject({ iface: 'en0', networkId: null, refusal: 'Not allowed on this network.' })
    expect(r.networks).toEqual([{ id: null, problem: { step: 'route_read', detail: 'netstat -rn -f inet: spawn netstat ENOENT' }, kind: 'lan', label: 'Unidentified network', allowed: false, osCategory: 'unknown', ifaces: ['en0'], addresses: ['192.168.1.20'] }])
    await check()
    expect(lines).toEqual(['network on en0 cannot be identified (route_read): It cannot read the route table. netstat -rn -f inet: spawn netstat ENOENT'])
    gateway = `192.168.1.1|${MAC}`
    const fixed = await check()
    expect(fixed.networks[0]).toMatchObject({ id: home, allowed: true })
    expect(fixed.networks[0]).not.toHaveProperty('problem')
    expect(lines.at(-1)).toBe('network on en0 identified')
  })

  it('a legacy gateway string infers the step', () => {
    expect(toGatewayReading('')).toEqual({ gateway: null, mac: null, problem: { step: 'no_gateway', detail: null } })
    expect(toGatewayReading('192.168.1.1|')).toEqual({ gateway: '192.168.1.1', mac: null, problem: { step: 'no_answer', detail: null } })
    expect(toGatewayReading(`192.168.1.1|${MAC}`)).toEqual({ gateway: '192.168.1.1', mac: MAC, problem: null })
  })

  it('the words: one sentence per fact; the strip says why and has no Allow', () => {
    expect(unidentifiedText({ step: 'no_gateway', detail: null })).toBe('Studio cannot identify this network. It cannot find the router address.')
    expect(unidentifiedText({ step: 'no_answer', detail: null }, 'ADF')).toBe('ADF cannot identify this network. The router does not answer.')
    expect(unidentifiedText(undefined)).toBe('Studio cannot identify this network.')
    const notice = networkQuestion({ id: null, problem: { step: 'route_read', detail: 'x' }, kind: 'lan', label: 'Unidentified network', allowed: false, osCategory: 'unknown', ifaces: ['en0'], addresses: ['192.168.1.20'] })
    expect(notice).toMatchObject({ canAllow: false, networkId: null, reason: 'Studio cannot identify this network. It cannot read the route table.' })
    expect(networkQuestion({ id: 'lan-0123456789abcdef', kind: 'lan', label: 'en0 (192.168.1.0/24)', allowed: false, osCategory: 'unknown', ifaces: ['en0'], addresses: ['192.168.1.20'] })).not.toHaveProperty('reason')
  })
})
