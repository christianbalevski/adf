/**
 * Remote access and Networking in the renderer (docs/design/remote-access.md
 * §7, §9.1; owner decisions 2026-10-18 and 2026-10-21): Add → Share (consent
 * inline, the addresses by network, the code), Connections → Devices, the
 * Networking status card (consent per network, the service named), the
 * runtimes list, the firewall commands (R9), the devices list, the pairing
 * code, the token shown once and the Connect dialog's messages. Static
 * markup, no jsdom.
 */
import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  canAddDevice,
  changeOn,
  addedDeviceLine,
  DevicesGroupView,
  groupedUrls,
  meshServerHosts,
  PUBLIC_NETWORK_WARNING,
  shareConsent,
  SharePanelView,
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
import {
  addressMatches,
  consentLines,
  FirewallCommands,
  firewallText,
  foundBy,
  isManaged,
  meshWarningLine,
  networkDetailText,
  networkingStatusLine,
  NetworkingStatusCard,
  publicAgentsLine,
  runtimeList,
  sharedAgents,
} from '../../../src/renderer/components/settings/NetworkingSettings'
import { PUBLIC_MESH_WARNING, PUBLIC_WARNING } from '../../../src/shared/utils/network-consent-text'
import type { NetworkView, RemoteAccessStatus, RemoteDevice, RemoteUrl } from '../../../src/shared/types/remote-access.types'
import type { NetworkStatusView, RemoteAccessView, RemotePairState } from '../../../src/shared/types/remote-access-ipc.types'
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

describe('Share: the pairing window', () => {
  it('opens only while remote access listens: never while off or paused on a network not allowed', () => {
    expect(canAddDevice(status())).toBe(true)
    expect(canAddDevice(status({ state: 'paused', message: 'Paused on Wi-Fi.' }))).toBe(false)
    expect(canAddDevice(status({ state: 'no_address' }))).toBe(false)
    expect(canAddDevice(status({ enabled: false, state: 'off' }))).toBe(false)
    expect(canAddDevice(null)).toBe(false)
  })
})

describe('status line', () => {
  it('off, on with the listening addresses, and paused on a network not allowed (nothing listens)', () => {
    expect(remoteStatusLine(status({ enabled: false, state: 'off' }))).toBe('Off.')
    expect(remoteStatusLine(status())).toBe('Listening on 192.168.1.20, 100.101.102.103.')
    expect(remoteStatusLine(status({ state: 'paused', message: 'Paused on Cafe (10.0.0.0/24).', addresses: [] }))).toBe('Paused on Cafe (10.0.0.0/24).')
  })

  it('no address, the env bind and errors show the daemon\'s sentence', () => {
    expect(remoteStatusLine(status({ state: 'no_address', message: 'No LAN or tailnet address.' }))).toBe('No LAN or tailnet address.')
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

describe('Share (host): the code view', () => {
  it('the 6-digit code in large digits, the countdown and the tries left', () => {
    const now = Date.parse('2026-10-18T12:00:00Z')
    expect(pairingCountdown('2026-10-18T12:01:45Z', now)).toBe('1:45')
    expect(pairingCountdown('2026-10-18T11:00:00Z', now)).toBe('0:00')
    expect(formatCode('012345')).toBe('012 345')
    const html = renderToStaticMarkup(<PairingCodePanel pairing={{ code: '012345', name: 'agent-1-pc', fingerprint: 'ABCD-EFGH', openedAt: '', expiresAt: '2026-10-18T12:02:00Z', attemptsLeft: 20, lockedSources: 1, claim: null }} fingerprint="ABCD-EFGH" now={now} />)
    expect(html).toContain('Enter this code on the other computer.')
    expect(html).toContain('012 345')
    expect(html).toContain('Expires in 2:00 · 20 wrong codes left · Fingerprint ABCD-EFGH')
    expect(html).toContain('1 device locked out after 5 wrong codes.')
  })
})

describe('Add → Share (owner decision 2026-10-21): consent inline, the addresses by network, the code', () => {
  const home: NetworkView = { id: 'lan-0123456789abcdef', kind: 'lan', label: 'Home (192.168.1.0/24)', allowed: true, osCategory: 'private', ifaces: ['Wi-Fi'], addresses: ['192.168.1.20'] }
  const cafe: NetworkView = { id: 'lan-fedcba9876543210', kind: 'lan', label: 'Cafe (10.0.0.0/24)', allowed: false, osCategory: 'unknown', ifaces: ['Wi-Fi'], addresses: ['10.0.0.5'] }
  const pairing = { code: '012345', name: 'agent-1-pc', fingerprint: 'ABCD-EFGH', openedAt: '', expiresAt: '2026-10-18T12:02:00Z', attemptsLeft: 20, lockedSources: 0, claim: null }
  const now = Date.parse('2026-10-18T12:00:00Z')
  const view = (s: RemoteAccessStatus | null, over: Partial<RemoteAccessView> = {}): RemoteAccessView => ({ available: true, unavailableReason: null, status: s, error: null, stopsWithStudio: false, ...over })
  const noop = () => {}
  const render = (v: RemoteAccessView | null, over: Partial<Parameters<typeof SharePanelView>[0]> = {}) => renderToStaticMarkup(
    <SharePanelView view={v} busy={false} error={null} now={now} approved={null} label="" created={null} onLabel={noop} onAllow={noop} onRenew={noop} onCreateToken={noop} onBack={noop} onDone={noop} {...over} />,
  )

  it('remote access off: one sentence and one explicit Allow; nothing listens, no address or code is shown', () => {
    const consent = shareConsent(status({ enabled: false, state: 'off', networks: [home] }))
    expect(consent).toMatchObject({ enable: true, networks: [], warning: null })
    expect(consent!.text).toBe('Computers you pair get full control of this runtime, as powerful as your seed phrase.')
    const html = render(view(status({ enabled: false, state: 'off', networks: [home] })))
    expect(html).toContain(consent!.text)
    expect(html.match(/>Allow</g)).toHaveLength(1)
    expect(html).not.toContain('012 345')
    expect(html).not.toContain('>Addresses<')
    expect(html).toContain('>Back<')
    expect(html).toContain('>Cancel<')
  })

  it('a current network not allowed (consent per network): it is named, with the Public warning', () => {
    const consent = shareConsent(status({ networks: [home, cafe] }))
    expect(consent).toMatchObject({ enable: false, warning: PUBLIC_NETWORK_WARNING })
    expect(consent!.networks.map((n) => n.id)).toEqual([cafe.id])
    expect(consent!.text).toBe('Computers you pair on Cafe (10.0.0.0/24) get full control of this runtime, as powerful as your seed phrase.')
    expect(render(view(status({ networks: [cafe] })))).toContain(PUBLIC_NETWORK_WARNING)
    // An unidentified network cannot be allowed: it is not asked for.
    expect(shareConsent(status({ networks: [home, { ...cafe, id: null, label: 'Unidentified network' }] }))).toBeNull()
    expect(shareConsent(status({ networks: [home] }))).toBeNull()
  })

  it('allowed and listening: the code with its countdown, the addresses by network with Copy, a token under Details', () => {
    const s = status({
      networks: [home],
      pairing,
      urls: [
        { url: 'http://192.168.1.20:7385', kind: 'lan', encrypted: false },
        { url: 'https://agent-1-pc.tail1234.ts.net', kind: 'tailscale-https', encrypted: true },
        { url: 'http://100.101.102.103:7385', kind: 'tailnet', encrypted: true },
        { url: 'http://agent-1-pc.local:7385', kind: 'mdns-name', encrypted: false },
      ],
    })
    expect(groupedUrls(s).map((g) => [g.title, g.urls.map((u) => u.kind)])).toEqual([
      ['Tailscale', ['tailscale-https', 'tailnet']],
      ['Home (192.168.1.0/24)', ['lan']],
      ['Others', ['mdns-name']],
    ])
    const html = render(view(s))
    expect(html).toContain('012 345')
    expect(html).toContain('Expires in 2:00')
    expect(html.indexOf('>Tailscale<')).toBeLessThan(html.indexOf('>Home (192.168.1.0/24)<'))
    expect(html.match(/>Copy</g)).toHaveLength(4)
    expect(html).toContain('>Details</summary>')
    expect(html).toContain('Device name')
    expect(html).toContain('>Create<')
    expect(html).not.toContain('>Allow<')
  })

  it('a claimed code: answer Allow device on this computer; then "Approved: <name>." and Done', () => {
    expect(render(view(status({ networks: [home], pairing: { ...pairing, claim: { claimId: 'c', deviceName: 'agent-2 laptop', clientKind: 'studio', address: '192.168.1.31', via: 'lan', tailnetLogin: null, at: '' } } })))).toContain('A device entered the code. Answer the Allow device dialog.')
    const html = render(view(status({ networks: [home] })), { approved: 'Approved: agent-2 laptop.' })
    expect(html).toContain('Approved: agent-2 laptop.')
    expect(html).toContain('>Done<')
    expect(html).not.toContain('>Cancel<')
    expect(addedDeviceLine(new Set(['a']), [device({ id: 'a' })])).toBeNull()
    expect(addedDeviceLine(new Set(['a']), [device({ id: 'a' }), device({ id: 'b', label: 'agent-2 phone' })])).toBe('Approved: agent-2 phone.')
    expect(addedDeviceLine(new Set(), [device({ id: 'c', origin: 'token' })])).toBeNull()
  })

  it('an expired code offers Renew; not local mode says why', () => {
    expect(render(view(status({ networks: [home], pairing: { ...pairing, expiresAt: '2026-10-18T11:00:00Z' } })))).toContain('>Renew<')
    expect(render(view(null, { available: false, unavailableReason: 'Remote access needs Local as the connection (Settings → Connections).' }))).toContain('Remote access needs Local as the connection')
  })

  it('the token once, with Copy and Done, and where to use it', () => {
    const html = renderToStaticMarkup(<NewTokenPanel label="agent-2 laptop" token="adfd_k3j9q2m7xa_secret" onDone={() => {}} />)
    expect(html).toContain('adfd_k3j9q2m7xa_secret')
    expect(html).toContain('shown once')
    expect(html).toContain('>Copy<')
    expect(html).toContain('>Done<')
    expect(html).toContain('On the other computer: Add, Connect, then Details.')
  })
})

describe('Connections → Devices: computers using this runtime, each with Revoke', () => {
  const noop = () => {}
  it('the Remote access switch with its line, the devices and Revoke', () => {
    const html = renderToStaticMarkup(<DevicesGroupView view={{ available: true, unavailableReason: null, status: status({ devices: [device({ connected: true })] }), error: null, stopsWithStudio: true }} busy={false} message={null} onSwitch={noop} onKeepRunning={noop} onRevoke={noop} />)
    expect(html).toContain('>Devices<')
    expect(html).toContain('aria-label="Remote access"')
    expect(html).toContain('Listening on 192.168.1.20, 100.101.102.103.')
    expect(html).toContain('agent-2 laptop')
    expect(html).toContain('>Revoke<')
    expect(html).toContain('>Keep running<')
  })

  it('not local mode: the reason, and the switch is disabled', () => {
    const html = renderToStaticMarkup(<DevicesGroupView view={{ available: false, unavailableReason: 'Remote access needs Local as the connection (Settings → Connections).', status: null, error: null, stopsWithStudio: false }} busy={false} message={null} onSwitch={noop} onKeepRunning={noop} onRevoke={noop} />)
    expect(html).toContain('Remote access needs Local as the connection')
    expect(html).toMatch(/role="switch"[^>]*disabled=""|disabled=""[^>]*role="switch"/)
  })
})

describe('a remote runtime: one sentence for every host-only control (review item 11)', () => {
  it('changeOn is the one line; Settings uses it for identity, and Networking for the networks, firewall, HTTPS and endpoints', () => {
    expect(changeOn('rawl-hub')).toBe('Change on rawl-hub.')
    const read = (file: string) => readFileSync(join(__dirname, '../../../src/renderer/components/settings', file), 'utf-8')
    const page = read('SettingsPage.tsx')
    expect(page).not.toMatch(/Firewall: change on/)
    expect(page.match(/changeOn\(/g)?.length).toBe(2)
    expect(read('NetworkingSettings.tsx').match(/changeOn\(/g)?.length).toBe(4)
  })
})

describe('pairing dialog messages (client)', () => {
  const state = (over: Partial<RemotePairState>): RemotePairState => ({ step: 'need_code', host: null, deviceName: 'agent-2-laptop', attemptsLeft: null, message: null, code: null, savedUrl: null, ...over })
  it('errors inline; waiting and paired are plain', () => {
    expect(pairMessage(state({ step: 'need_code', code: 'wrong_code', message: 'Wrong code. 4 tries left.', attemptsLeft: 4 }), 'agent-1-pc')).toEqual({ kind: 'error', text: 'Wrong code. 4 tries left.' })
    expect(pairMessage(state({ step: 'failed', code: 'denied', message: 'agent-1-pc denied this device.' }), 'agent-1-pc')).toEqual({ kind: 'error', text: 'agent-1-pc denied this device.' })
    expect(pairMessage(state({ step: 'waiting' }), 'agent-1-pc')).toEqual({ kind: 'ok', text: 'Waiting for agent-1-pc to allow this device…' })
    expect(pairMessage(state({ step: 'paired', message: 'Saved agent-1-pc.' }), 'agent-1-pc')?.kind).toBe('ok')
    expect(pairMessage(null, 'x')).toBeNull()
  })
})

describe('Settings → Networking (owner decision 2026-10-21)', () => {
  const home = { id: 'lan-0123456789abcdef', kind: 'lan' as const, label: 'Home (192.168.1.0/24)', allowed: true, osCategory: 'private' as const, ifaces: ['Wi-Fi'], addresses: ['192.168.1.20'] }
  const cafe = { id: 'lan-fedcba9876543210', kind: 'lan' as const, label: 'Cafe (10.0.0.0/24)', allowed: false, osCategory: 'unknown' as const, ifaces: ['Wi-Fi'], addresses: ['10.0.0.5'] }
  const net = (over: Partial<NetworkStatusView>): NetworkStatusView => ({
    available: true, lan: [{ address: '192.168.1.20', iface: 'Wi-Fi', allowed: true }], networks: [home],
    allowedNetworks: [{ id: home.id, kind: 'lan', label: home.label, addedAt: '2026-10-18T00:00:00Z' }],
    tailscale: 'running', tailnetAddress: '100.101.102.103', firewall: { state: 'ok', message: '' }, waiting: { remoteAccess: false, mesh: false }, ...over,
  })
  const card = (consent: ReturnType<typeof consentLines>) => renderToStaticMarkup(<NetworkingStatusCard line="Mesh on" consent={consent} busy={false} note={null} firewall={null} onAllow={() => {}} />)

  it('the status card line: the mesh, the networks (allowed or not), the agents shared', () => {
    expect(networkingStatusLine({ meshOn: true, networks: [home], shared: 3 })).toBe('Mesh on · Home (192.168.1.0/24) (allowed) · 3 agents shared')
    expect(networkingStatusLine({ meshOn: false, networks: [cafe], shared: 1 })).toBe('Mesh off · Cafe (10.0.0.0/24) (not allowed) · 1 agent shared')
    expect(networkingStatusLine({ meshOn: true, networks: [], shared: 0 })).toBe('Mesh on · No network · 0 agents shared')
    // A remote runtime: its network is not this computer's.
    expect(networkingStatusLine({ meshOn: true, networks: null, shared: 2 })).toBe('Mesh on · 2 agents shared')
    expect(networkDetailText(net({}))).toBe('LAN 192.168.1.20 · Tailscale on (100.101.102.103)')
    expect(networkDetailText(net({ lan: [{ address: '10.0.0.5', iface: 'Wi-Fi', allowed: false }], tailscale: 'absent' }))).toBe('LAN 10.0.0.5, not listening · Tailscale not installed')
  })

  it('P0: the card names the service that waits, never Remote when only the mesh waits', () => {
    expect(consentLines(net({ networks: [cafe], waiting: { remoteAccess: false, mesh: true } }), [])[0].lines).toEqual(['Agent sharing paused on Cafe (10.0.0.0/24).'])
    expect(consentLines(net({ networks: [cafe], waiting: { remoteAccess: true, mesh: false } }), [])[0].lines).toEqual(['Remote access paused on Cafe (10.0.0.0/24).'])
    expect(consentLines(net({ networks: [cafe], waiting: { remoteAccess: true, mesh: true } }), [])[0].lines).toEqual(['Remote access and agent sharing paused on Cafe (10.0.0.0/24).'])
    // Nothing waits: the network is listed with Allow and no paused line.
    expect(consentLines(net({ networks: [cafe] }), [])[0]).toMatchObject({ networkId: cafe.id, lines: [], warning: null })
    // Allowed: no entry.
    expect(consentLines(net({}), [])).toEqual([])
    // The Public warning, by service.
    expect(consentLines(net({ networks: [cafe], waiting: { remoteAccess: true, mesh: false } }), [])[0].warning).toBe(PUBLIC_WARNING)
    expect(consentLines(net({ networks: [cafe], waiting: { remoteAccess: false, mesh: true } }), [])[0].warning).toBe(PUBLIC_MESH_WARNING)
    expect(consentLines(net({ networks: [{ ...cafe, osCategory: 'private' }], waiting: { remoteAccess: true, mesh: false } }), [])[0].warning).toBeNull()
  })

  it('a public agent asks for the same consent per network, visibly: "agent-1 is public; Allow on this network to share it."', () => {
    expect(publicAgentsLine(['agent-1'])).toBe('agent-1 is public; Allow on this network to share it.')
    expect(publicAgentsLine(['agent-1', 'agent-2'])).toBe('agent-1 and agent-2 are public; Allow on this network to share them.')
    expect(publicAgentsLine([])).toBeNull()
    expect(consentLines(net({ networks: [cafe] }), ['agent-1'])[0].lines).toEqual(['Agent sharing paused on Cafe (10.0.0.0/24).', 'agent-1 is public; Allow on this network to share it.'])
    const html = card(consentLines(net({ networks: [cafe] }), ['agent-1']))
    expect(html).toContain('agent-1 is public; Allow on this network to share it.')
    expect(html.match(/>Allow</g)).toHaveLength(1)
  })

  it('the card: one Allow per network not allowed; an unidentified network has none', () => {
    const html = card(consentLines(net({ networks: [cafe, { ...cafe, id: null, label: 'Unidentified network' }], waiting: { remoteAccess: true, mesh: false } }), []))
    expect(html).toContain('Remote access paused on Cafe (10.0.0.0/24).')
    expect(html).toContain('Remote access paused on Unidentified network.')
    expect(html.match(/>Allow</g)).toHaveLength(1)
    expect(html).not.toContain('Allow on this network<')
  })

  it('review A8: a public agent with no allowed network to listen on (a headless VPS, any runtime): the card says so and names MESH_HOST', () => {
    const warning = 'Public agents listen on this computer only (no allowed network); on a server, set MESH_HOST=0.0.0.0 and restart the daemon.'
    // A remote runtime (no consent lines) or this computer with nothing to allow: the line shows.
    expect(meshWarningLine({ warning }, [])).toBe(warning)
    expect(meshWarningLine({ warning }, consentLines(net({ networks: [{ ...cafe, id: null, label: 'Unidentified network' }] }), ['agent-1']))).toBe(warning)
    // A network to allow: its Allow line already says what to do.
    expect(meshWarningLine({ warning }, consentLines(net({ networks: [cafe] }), ['agent-1']))).toBeNull()
    expect(meshWarningLine({}, [])).toBeNull()
    const html = renderToStaticMarkup(<NetworkingStatusCard line="Mesh on" consent={[]} busy={false} note={null} firewall={null} warning={warning} onAllow={() => {}} />)
    expect(html).toContain(warning)
  })

  it('shared agents: visibility lan or public', () => {
    expect(sharedAgents([{ visibility: 'lan' }, { visibility: 'public' }, { visibility: 'localhost' }, { visibility: 'off' }, {}])).toHaveLength(2)
  })

  it('Runtimes: one list, how each was found, Managed when Connections has it, added addresses that do not answer', () => {
    expect([foundBy('mdns'), foundBy(undefined), foundBy('tailnet'), foundBy('manual')]).toEqual(['LAN', 'LAN', 'Tailnet', 'Address'])
    const found = [
      { runtime_id: 'r1', host: '192.168.1.44', port: 7295, url: 'http://192.168.1.44:7295', source: 'mdns' as const, agent_count: 2 },
      { runtime_id: 'r2', host: '100.101.102.104', port: 7295, url: 'http://100.101.102.104:7295', source: 'manual' as const },
    ]
    const list = runtimeList(found, ['100.101.102.104:7295', 'lab.example:7295'])
    expect(list.map((r) => r.kind === 'found' ? [r.runtime.runtime_id, r.address] : ['address', r.address])).toEqual([['r1', null], ['r2', '100.101.102.104:7295'], ['address', 'lab.example:7295']])
    expect(isManaged(found[0], [{ kind: 'saved', url: 'http://192.168.1.44:7385' }])).toBe(true)
    expect(isManaged(found[0], [{ kind: 'found', url: 'http://192.168.1.44:7385' }, { kind: 'saved', url: 'http://10.0.0.9:7385' }])).toBe(false)
    expect(addressMatches('[fd7a::1]:7295', { host: 'fd7a::1', port: 7295 })).toBe(true)
    expect(addressMatches('desk', { host: 'desk', port: 7295 })).toBe(true)
  })

  it('the firewall: what blocks, the exact commands to run, never an elevated button (R9)', () => {
    expect(firewallText({ supported: true, ruleConfigured: false, reachable: null, lanIp: '192.168.1.20', detail: '', port: 7295, serverLanBound: true, verified: false })).toBe('Peers see this runtime but list 0 agents until a firewall rule lets them in.')
    expect(firewallText({ supported: true, ruleConfigured: true, reachable: true, lanIp: '192.168.1.20', detail: '', port: 7295, serverLanBound: true, verified: true })).toBe('Open on 192.168.1.20:7295.')
    const html = renderToStaticMarkup(<FirewallCommands commands={["New-NetFirewallRule -DisplayName 'ADF Mesh (LAN)'"]} />)
    expect(html).toContain('New-NetFirewallRule')
    expect(html).toContain('>Copy<')
    expect(html).toContain(DOCS.meshFirewall)
    const src = readFileSync(join(__dirname, '../../../src/renderer/components/settings/NetworkingSettings.tsx'), 'utf-8')
    for (const banned of ['applyLanFirewall', 'Enable in firewall', 'Requesting permission']) expect(src, banned).not.toContain(banned)
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
    for (const url of [DOCS.remoteAccess, DOCS.remoteAccessPair, DOCS.networkingStatus, DOCS.meshFirewall]) {
      const [, file, anchor] = /\/docs\/guides\/([^#]+)#(.+)$/.exec(url)!
      expect(anchors(file).has(anchor), url).toBe(true)
    }
  })

  it('no question-style or banned phrasing in what the UI renders; no "additive" or "alongside"', () => {
    const html = renderToStaticMarkup(<RemoteDeviceList devices={[]} busy={false} onRemove={() => {}} />)
      + renderToStaticMarkup(<NewTokenPanel label="x" token="t" onDone={() => {}} />)
      + card(consentLines(net({ networks: [cafe], waiting: { remoteAccess: true, mesh: true } }), ['agent-1']))
    for (const banned of ['Allow other computers to connect', 'Found on your network', 'Who can reach this computer?', 'Your other computers', 'additive', 'alongside', '?<']) expect(html).not.toContain(banned)
    for (const file of ['NetworkingSettings.tsx', 'RemoteAccessSettings.tsx', 'ConnectionSettings.tsx']) {
      const src = readFileSync(join(__dirname, '../../../src/renderer/components/settings', file), 'utf-8')
      expect(src, file).not.toMatch(/\badditive\b|\balongside\b/i)
    }
  })
})

describe('consent review 3: the network notice is a strip in the window, not a dialog', () => {
  it('message, Allow and Dismiss; the Public warning; an unidentified network offers Networking instead', async () => {
    const { NetworkNoticeList } = await import('../../../src/renderer/components/common/NetworkNoticeBanner')
    const noop = () => {}
    const html = renderToStaticMarkup(<NetworkNoticeList busy={null} error={null} onAllow={noop} onDismiss={noop} onOpenNetworking={noop} notices={[
      { key: 'lan-0123456789abcdef', networkId: 'lan-0123456789abcdef', message: 'Agent sharing paused on Cafe (10.0.0.0/24).', warning: PUBLIC_MESH_WARNING, canAllow: true },
      { key: 'unidentified:lan:Wi-Fi', networkId: null, message: 'Remote access paused on Unidentified network.', warning: null, canAllow: false },
    ]} />)
    expect(html).toContain('role="status"')
    expect(html).not.toContain('role="dialog"')
    expect(html).toContain('Agent sharing paused on Cafe (10.0.0.0/24).')
    expect(html.match(/>\s*Allow\s*</g)?.length).toBe(1)
    expect(html.match(/>Dismiss</g)?.length).toBe(2)
    expect(html).toContain(PUBLIC_MESH_WARNING)
    expect(html).toContain('Remote access paused on Unidentified network.')
    expect(html).toContain('>Networking<')
    for (const old of ['Allow on this network', 'Not now', 'Open Networking']) expect(html).not.toContain(old)
    expect(renderToStaticMarkup(<NetworkNoticeList busy={null} error={null} onAllow={noop} onDismiss={noop} onOpenNetworking={noop} notices={[]} />)).toBe('')
  })
})

describe('the pages render (static, no IPC)', () => {
  it('Settings → Networking: the status card, Sharing, Networks, Runtimes, Advanced closed', async () => {
    const { NetworkingSettings } = await import('../../../src/renderer/components/settings/NetworkingSettings')
    const html = renderToStaticMarkup(<NetworkingSettings remote={false} runtimeName="host-0 (Local)" pickedMesh={undefined} />)
    expect(html).toContain('Mesh off · 0 agents shared')
    for (const s of ['>Sharing<', '>Networks<', '>Runtimes<', '>Advanced</summary>', 'aria-label="Mesh"', 'aria-label="Network"', '>Agents', '0 shared']) expect(html, s).toContain(s)
    expect(html).not.toContain('<details open')
    expect(html).not.toContain('aria-label="LAN"')
    // A remote runtime: host-only rows say where they are changed.
    expect(renderToStaticMarkup(<NetworkingSettings remote runtimeName="rawl-hub" pickedMesh="remote:rawl-hub" />)).toContain('Change on rawl-hub.')
  })

  it('Add: Connect and Share; Connect lists what was found and an Address; Share loads', async () => {
    const { AddDialog, AddConnectionDialog } = await import('../../../src/renderer/components/settings/ConnectionSettings')
    const add = renderToStaticMarkup(<AddDialog onClose={() => {}} />)
    expect(add).toContain('>Add</h2>')
    expect(add).toContain('>Connect<')
    expect(add).toContain('>Share<')
    const connect = renderToStaticMarkup(<AddConnectionDialog onClose={() => {}} onBack={() => {}} />)
    expect(connect).toContain('aria-label="Address"')
    expect(connect).toContain('>Details</summary>')
    expect(connect).toContain('aria-label="Token"')
    expect(connect).toContain('>Back<')
    expect(connect).not.toContain('Use a token instead')
    const share = renderToStaticMarkup(<SharePanelView view={null} busy={false} error={null} approved={null} label="" created={null} onLabel={() => {}} onAllow={() => {}} onRenew={() => {}} onCreateToken={() => {}} onBack={() => {}} onDone={() => {}} />)
    expect(share).toContain('Loading…')
  })
})
