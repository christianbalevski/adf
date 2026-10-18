/**
 * Remote access in the renderer (Runtime → Networking, Studio → Connection)
 * (docs/design/remote-access.md §7, §9.1; owner decisions 2026-10-18): the
 * status line (consent per network), the address order and labels, the devices
 * list, the pairing code, the token shown once, the computers found and the
 * pairing dialog's messages. Static markup, no jsdom.
 */
import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  AddDeviceDialog,
  addedDeviceLine,
  HostOnlyRemoteAccess,
  meshServerHosts,
  meshVisibilityLine,
  networkStatusText,
  NetworkConsentPanel,
  PUBLIC_NETWORK_WARNING,
  NewTokenPanel,
  NOT_ENCRYPTED_WARNING,
  PairingCodePanel,
  RemoteAddressList,
  RemoteDeviceList,
  formatCode,
  lastSeenText,
  orderedUrls,
  pairMessage,
  pairingCountdown,
  remoteStatusLine,
} from '../../../src/renderer/components/settings/RemoteAccessSettings'
import type { RemoteAccessStatus, RemoteDevice, RemoteUrl } from '../../../src/shared/types/remote-access.types'
import type { NetworkStatusView, RemotePairState } from '../../../src/shared/types/remote-access-ipc.types'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DOCS } from '../../../src/shared/constants/docs-links'

// Vitest compiles JSX with the classic runtime (the renderer build uses the automatic one).
;(globalThis as { React?: typeof React }).React = React

const status = (over: Partial<RemoteAccessStatus> = {}): RemoteAccessStatus => ({
  enabled: true, state: 'on', message: '', problem: null, name: 'agent-1-pc', fingerprint: 'ABCD-EFGH', port: 7385,
  addresses: [
    { address: '192.168.1.20', family: 'IPv4', kind: 'lan', iface: 'Wi-Fi', networkId: 'lan-0123456789abcdef', allowed: true, listening: true, problem: null },
    { address: '100.101.102.103', family: 'IPv4', kind: 'tailnet', iface: 'Tailscale', networkId: 'tailnet-0123456789abcdef', allowed: true, listening: true, problem: null },
  ],
  networks: [], allowedNetworks: [], meshLan: false,
  urls: [], hostNames: [],
  tailscale: { state: 'running', serve: 'off', httpsUrl: null, serveCommand: null },
  mdns: { announcing: true, problem: null },
  firewall: { state: 'ok', message: '', commands: [] },
  devices: [], pairing: null, ...over,
})

const device = (over: Partial<RemoteDevice> = {}): RemoteDevice => ({
  id: 'k3j9q2m7xa', label: 'agent-2 laptop', origin: 'paired', createdAt: '2026-10-18T09:12:03Z', createdBy: 'studio',
  lastSeenAt: null, lastSeenAddress: null, connected: false, connections: 0, sessions: 0, ...over,
})

describe('status line', () => {
  it('off, on with the listening addresses, and paused on a network not allowed (nothing listens)', () => {
    expect(remoteStatusLine(status({ enabled: false, state: 'off' }))).toBe('Off.')
    expect(remoteStatusLine(status())).toBe('Listening on 192.168.1.20, 100.101.102.103.')
    expect(remoteStatusLine(status({ state: 'paused', message: 'Paused on Cafe (10.0.0.0/24).', addresses: [] }))).toBe('Paused on Cafe (10.0.0.0/24).')
  })

  it('no address, the env bind and errors show the daemon\'s sentence', () => {
    expect(remoteStatusLine(status({ state: 'no_address', message: 'No private network address now.' }))).toBe('No private network address now.')
    expect(remoteStatusLine(status({ state: 'error', message: '', problem: 'daemon-devices.json cannot be read.' }))).toBe('daemon-devices.json cannot be read.')
  })
})

describe('addresses', () => {
  const urls: RemoteUrl[] = [
    { url: 'http://agent-1-pc.local:7385', kind: 'mdns-name', encrypted: false },
    { url: 'http://192.168.1.20:7385', kind: 'lan', encrypted: false },
    { url: 'https://agent-1-pc.tail1234.ts.net', kind: 'tailscale-https', encrypted: true },
    { url: 'http://100.101.102.103:7385', kind: 'tailnet', encrypted: true },
  ]

  it('Tailscale https first, then the tailnet, LAN http, the .local name', () => {
    expect(orderedUrls(urls).map((u) => u.kind)).toEqual(['tailscale-https', 'tailnet', 'lan', 'mdns-name'])
  })

  it('each has Copy and its label; plain http carries the short warning', () => {
    const html = renderToStaticMarkup(<RemoteAddressList urls={urls} />)
    expect(html.indexOf('https://agent-1-pc.tail1234.ts.net')).toBeLessThan(html.indexOf('http://192.168.1.20:7385'))
    expect(html.match(/>Copy</g)).toHaveLength(4)
    expect(html.match(/>Encrypted</g)).toHaveLength(2)
    expect(html.match(/>Not encrypted</g)).toHaveLength(2)
    expect(html.split(NOT_ENCRYPTED_WARNING)).toHaveLength(3)
    expect(NOT_ENCRYPTED_WARNING.split(/[.!?]\s/)).toHaveLength(1)
  })
})

describe('computers list', () => {
  const now = Date.parse('2026-10-18T12:00:00Z')
  it('name, how it was added, last seen, and Revoke', () => {
    expect(lastSeenText(device({ connected: true }), now)).toBe('Connected now')
    expect(lastSeenText(device(), now)).toBe('Never connected')
    expect(lastSeenText(device({ lastSeenAt: '2026-10-18T11:40:00Z', lastSeenAddress: '192.168.1.31' }), now)).toBe('Last seen 20 min ago (192.168.1.31)')
    const html = renderToStaticMarkup(<RemoteDeviceList devices={[device({ connected: true }), device({ id: 'b', label: 'old tablet', origin: 'token' })]} busy={false} onRemove={() => {}} now={now} />)
    expect(html).toContain('agent-2 laptop')
    expect(html).toContain('Paired · Connected now')
    expect(html).toContain('Token · Never connected')
    expect(html.match(/>Revoke</g)).toHaveLength(2)
  })
})

describe('Add device (host): the code view', () => {
  it('the 6-digit code in large digits, the countdown and the tries left', () => {
    const now = Date.parse('2026-10-18T12:00:00Z')
    expect(pairingCountdown('2026-10-18T12:01:45Z', now)).toBe('1:45')
    expect(pairingCountdown('2026-10-18T11:00:00Z', now)).toBe('0:00')
    expect(formatCode('012345')).toBe('012 345')
    const html = renderToStaticMarkup(<PairingCodePanel pairing={{ code: '012345', name: 'agent-1-pc', fingerprint: 'ABCD-EFGH', openedAt: '', expiresAt: '2026-10-18T12:02:00Z', attemptsLeft: 20, lockedSources: 1, claim: null }} fingerprint="ABCD-EFGH" now={now} />)
    expect(html).toContain('Enter this code on the device.')
    expect(html).toContain('012 345')
    expect(html).toContain('Expires in 2:00 · 20 wrong codes left · Fingerprint ABCD-EFGH')
    expect(html).toContain('1 device locked out after 5 wrong codes.')
  })
})

describe('Add device (host): one dialog, the code or a token (settings-scopes.md §6)', () => {
  const pairing = { code: '012345', name: 'agent-1-pc', fingerprint: 'ABCD-EFGH', openedAt: '', expiresAt: '2026-10-18T12:02:00Z', attemptsLeft: 20, lockedSources: 0, claim: null }
  const noop = async () => true
  const create = async () => ({ ok: true as const, label: 'x', token: 't' })

  it('opens on the code, with Use a token instead', () => {
    const html = renderToStaticMarkup(<AddDeviceDialog pairing={pairing} fingerprint="ABCD-EFGH" devices={[]} now={Date.parse('2026-10-18T12:00:00Z')} onOpenCode={noop} onCloseCode={noop} onCreateToken={create} onClose={() => {}} />)
    expect(html).toContain('Add device')
    expect(html).toContain('012 345')
    expect(html).toContain('Use a token instead')
    expect(html).toContain('>Cancel<')
    expect(html).not.toContain('Pair device')
  })

  it('the token view: Device name, Create token, Use a code instead', () => {
    const html = renderToStaticMarkup(<AddDeviceDialog initialView="token" pairing={null} fingerprint="ABCD-EFGH" devices={[]} onOpenCode={noop} onCloseCode={noop} onCreateToken={create} onClose={() => {}} />)
    expect(html).toContain('Device name')
    expect(html).toContain('Create token')
    expect(html).toContain('Use a code instead')
  })

  it('"Added <label>." once a device that entered the code is allowed', () => {
    expect(addedDeviceLine(new Set(['a']), [device({ id: 'a' })])).toBeNull()
    expect(addedDeviceLine(new Set(['a']), [device({ id: 'a' }), device({ id: 'b', label: 'agent-2 phone' })])).toBe('Added agent-2 phone.')
    expect(addedDeviceLine(new Set(), [device({ id: 'c', origin: 'token' })])).toBeNull()
  })

  it('the token once, with Copy and Done, and where to use it', () => {
    const html = renderToStaticMarkup(<NewTokenPanel label="agent-2 laptop" token="adfd_k3j9q2m7xa_secret" onDone={() => {}} />)
    expect(html).toContain('adfd_k3j9q2m7xa_secret')
    expect(html).toContain('shown once')
    expect(html).toContain('>Copy<')
    expect(html).toContain('>Done<')
    expect(html).toContain('On the device: Settings → Connection → Add connection.')
  })
})

describe('a remote runtime: host-only (settings-scopes.md §7)', () => {
  it('Remote access says where it is changed, with no control', () => {
    const html = renderToStaticMarkup(<HostOnlyRemoteAccess name="rawl-hub" />)
    expect(html).toContain('Remote access')
    expect(html).toContain('Change on rawl-hub.')
    expect(html).not.toContain('<input')
    expect(html).not.toContain('<button')
  })
})

describe('pairing dialog messages (client)', () => {
  const state = (over: Partial<RemotePairState>): RemotePairState => ({ step: 'need_code', host: null, deviceName: 'agent-2-laptop', attemptsLeft: null, message: null, code: null, savedUrl: null, ...over })
  it('errors inline; waiting and paired are plain', () => {
    expect(pairMessage(state({ step: 'need_code', code: 'wrong_code', message: 'Wrong code. 4 tries left.', attemptsLeft: 4 }), 'agent-1-pc')).toEqual({ kind: 'error', text: 'Wrong code. 4 tries left.' })
    expect(pairMessage(state({ step: 'failed', code: 'denied', message: 'agent-1-pc denied this device.' }), 'agent-1-pc')).toEqual({ kind: 'error', text: 'agent-1-pc denied this device.' })
    expect(pairMessage(state({ step: 'waiting' }), 'agent-1-pc')).toEqual({ kind: 'ok', text: 'Waiting for agent-1-pc to allow this device…' })
    expect(pairMessage(state({ step: 'paired', message: 'Paired with agent-1-pc. Its address and token are saved.' }), 'agent-1-pc')?.kind).toBe('ok')
    expect(pairMessage(null, 'x')).toBeNull()
  })
})

describe('Settings → Networking', () => {
  const home = { id: 'lan-0123456789abcdef', kind: 'lan' as const, label: 'Home (192.168.1.0/24)', allowed: true, osCategory: 'private' as const, ifaces: ['Wi-Fi'], addresses: ['192.168.1.20'] }
  const cafe = { id: 'lan-fedcba9876543210', kind: 'lan' as const, label: 'Cafe (10.0.0.0/24)', allowed: false, osCategory: 'unknown' as const, ifaces: ['Wi-Fi'], addresses: ['10.0.0.5'] }
  const net = (over: Partial<NetworkStatusView>): NetworkStatusView => ({
    available: true, lan: [{ address: '192.168.1.20', iface: 'Wi-Fi', allowed: true }], networks: [home],
    allowedNetworks: [{ id: home.id, kind: 'lan', label: home.label, addedAt: '2026-10-18T00:00:00Z' }],
    tailscale: 'running', tailnetAddress: '100.101.102.103', firewall: { state: 'ok', message: '' }, ...over,
  })

  it('the status line: the networks (allowed or not), LAN address, Tailscale, firewall', () => {
    expect(networkStatusText(net({}))).toBe('Network: Home (192.168.1.0/24) · LAN 192.168.1.20 · Tailscale on (100.101.102.103) · Firewall ok')
    expect(networkStatusText(net({ networks: [cafe], lan: [{ address: '10.0.0.5', iface: 'Wi-Fi', allowed: false }], tailscale: 'absent', tailnetAddress: null, firewall: { state: 'blocked', message: 'x' } })))
      .toBe('Network: Cafe (10.0.0.0/24) (not allowed) · LAN 10.0.0.5, not listening · Tailscale not installed · Firewall blocked')
    expect(networkStatusText(net({ networks: [], lan: [], tailscale: 'stopped' }))).toBe('Network: no LAN address · Tailscale stopped · Firewall ok')
  })

  it('a network not allowed: "Remote access paused on <network>.", Allow on this network, the warning; Allowed networks with Remove', () => {
    const html = renderToStaticMarkup(<NetworkConsentPanel view={net({ networks: [cafe] })} busy={false} note={null} onAllow={() => {}} onRemove={() => {}} />)
    expect(html).toContain('Remote access paused on Cafe (10.0.0.0/24).')
    expect(html).toContain('Allow on this network')
    expect(html).toContain(PUBLIC_NETWORK_WARNING)
    expect(PUBLIC_NETWORK_WARNING).toBe('Public network. The token is sent unencrypted.')
    expect(html).toContain('Allowed networks')
    expect(html).toContain('Home (192.168.1.0/24)')
    expect(html).toContain('Remove')
    const allowedHere = renderToStaticMarkup(<NetworkConsentPanel view={net({})} busy={false} note={null} onAllow={() => {}} onRemove={() => {}} />)
    expect(allowedHere).not.toContain('Allow on this network')
    expect(allowedHere).toContain('Current network')
    // A Windows Private network gets the button but no warning.
    const privateCafe = renderToStaticMarkup(<NetworkConsentPanel view={net({ networks: [{ ...cafe, osCategory: 'private' }] })} busy={false} note={null} onAllow={() => {}} onRemove={() => {}} />)
    expect(privateCafe).toContain('Allow on this network')
    expect(privateCafe).not.toContain(PUBLIC_NETWORK_WARNING)
    expect(renderToStaticMarkup(<NetworkConsentPanel view={net({ allowedNetworks: [] })} busy={false} note={null} onAllow={() => {}} onRemove={() => {}} />)).toContain('None')
    // Consent review 1: an unidentified network is named, paused, and cannot be allowed.
    const unidentified = renderToStaticMarkup(<NetworkConsentPanel view={net({ networks: [{ ...cafe, id: null, label: 'Unidentified network' }] })} busy={false} note={null} onAllow={() => {}} onRemove={() => {}} />)
    expect(unidentified).toContain('Remote access paused on Unidentified network.')
    expect(unidentified).not.toContain('Allow on this network')
  })

  it('agent visibility on the mesh: the LanAgentsList predicate, then public, then the rest', () => {
    expect(meshVisibilityLine([{ visibility: 'lan' }, { visibility: 'lan' }, { visibility: 'public' }, { visibility: 'localhost' }, { visibility: 'off' }, {}]))
      .toBe('2 agents visible on LAN · 1 public · 3 private')
    expect(meshVisibilityLine([{ visibility: 'lan' }])).toBe('1 agent visible on LAN · 0 public · 0 private')
  })

  it('the mesh server line names its listeners in LAN mode', () => {
    expect(meshServerHosts({ host: '127.0.0.1' })).toBe('127.0.0.1')
    expect(meshServerHosts({ host: '0.0.0.0', lanAddresses: ['192.168.1.20', '100.101.102.103'] })).toBe('127.0.0.1, 192.168.1.20, 100.101.102.103')
    expect(meshServerHosts({ host: '0.0.0.0', lanAddresses: [] })).toBe('127.0.0.1 only (no private network)')
    expect(meshServerHosts({ host: '0.0.0.0', lanAddresses: ['0.0.0.0'] })).toBe('all interfaces')
  })

  it('every remote-access docs link is a heading of its guide', () => {
    const slug = (heading: string) => heading.toLowerCase().replace(/[^\p{L}\p{N} -]/gu, '').replace(/ /g, '-')
    const anchors = (file: string) => new Set(readFileSync(join(__dirname, '../../../docs/guides', file), 'utf-8').split(/\r?\n/).filter((l) => /^#{2,3} /.test(l)).map((l) => slug(l.replace(/^#+ /, ''))))
    for (const url of [DOCS.remoteAccess, DOCS.remoteAccessPair, DOCS.networkingStatus]) {
      const [, file, anchor] = /\/docs\/guides\/([^#]+)#(.+)$/.exec(url)!
      expect(anchors(file).has(anchor), url).toBe(true)
    }
  })

  it('no question-style or banned phrasing in what the UI renders', () => {
    const html = renderToStaticMarkup(<RemoteDeviceList devices={[]} busy={false} onRemove={() => {}} />)
      + renderToStaticMarkup(<NewTokenPanel label="x" token="t" onDone={() => {}} />)
    for (const banned of ['Allow other computers to connect', 'Found on your network', 'Who can reach this computer?', 'Your other computers']) expect(html).not.toContain(banned)
  })
})

describe('consent review 3: the network notice is a strip in the window, not a dialog', () => {
  it('message, Allow on this network and Not now; the Public warning; an unidentified network offers Open Networking instead', async () => {
    const { NetworkNoticeList } = await import('../../../src/renderer/components/common/NetworkNoticeBanner')
    const noop = () => {}
    const html = renderToStaticMarkup(<NetworkNoticeList busy={null} error={null} onAllow={noop} onDismiss={noop} onOpenNetworking={noop} notices={[
      { key: 'lan-0123456789abcdef', networkId: 'lan-0123456789abcdef', message: 'Remote access paused on Cafe (10.0.0.0/24).', warning: 'Public network. The token is sent unencrypted.', canAllow: true },
      { key: 'unidentified:lan:Wi-Fi', networkId: null, message: 'Remote access paused on Unidentified network.', warning: null, canAllow: false },
    ]} />)
    expect(html).toContain('role="status"')
    expect(html).not.toContain('role="dialog"')
    expect(html).toContain('Remote access paused on Cafe (10.0.0.0/24).')
    expect(html.match(/Allow on this network/g)?.length).toBe(1)
    expect(html.match(/Not now/g)?.length).toBe(2)
    expect(html).toContain('Public network. The token is sent unencrypted.')
    expect(html).toContain('Remote access paused on Unidentified network.')
    expect(html).toContain('Open Networking')
    expect(renderToStaticMarkup(<NetworkNoticeList busy={null} error={null} onAllow={noop} onDismiss={noop} onOpenNetworking={noop} notices={[]} />)).toBe('')
  })
})
