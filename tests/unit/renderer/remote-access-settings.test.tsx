/**
 * Remote access and Networking in the renderer (docs/design/remote-access.md
 * §7, §9.1; owner decisions 2026-10-18 and 2026-10-21, redesign 2026-10-21):
 * Add → Share (the name devices see, consent inline, the code, the address
 * table grouped by network with one Copy per row), Connections → Devices,
 * the Networking status card (one fact per line; consent per network, the
 * service named), the servers list, the firewall commands (R9), the devices
 * list, the token shown once and the Connect dialog's messages. Static
 * markup, no jsdom.
 */
import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  canAddDevice,
  changeOn,
  addedDeviceLine,
  AddressTable,
  DevicesGroupView,
  devicesSummary,
  groupedUrls,
  meshServerHosts,
  PUBLIC_NETWORK_WARNING,
  devicesHint,
  shareConsent,
  shareLeave,
  SharePanelView,
  STAYS_ON_LINE,
  NewTokenPanel,
  NOT_ENCRYPTED_WARNING,
  PairingCodePanel,
  RemoteDeviceList,
  SHARE_AS_HELP,
  SHARE_AS_LABEL,
  STOPS_WITH_STUDIO,
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
  networkingStatusItems,
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

  it('one table, grouped by network; one row per address, each with its own Copy in the last column; the warning once, under the table', () => {
    const home: NetworkView = { id: 'lan-0123456789abcdef', kind: 'lan', label: 'Home (192.168.1.0/24)', allowed: true, osCategory: 'private', ifaces: ['Wi-Fi'], addresses: ['192.168.1.20'] }
    const html = renderToStaticMarkup(<AddressTable status={{ urls, networks: [home] }} />)
    expect(html).toContain('<table')
    expect(html.indexOf('data-address-group="Tailscale"')).toBeLessThan(html.indexOf('data-address-group="Home (192.168.1.0/24)"'))
    expect(html.indexOf('data-address-group="Home (192.168.1.0/24)"')).toBeLessThan(html.indexOf('data-address-group="Other"'))
    expect(html.indexOf('https://agent-1-pc.tail1234.ts.net')).toBeLessThan(html.indexOf('http://192.168.1.20:7385'))
    // Each address row: the address, its badge, its Copy, in that order; no Copy outside a row.
    const rows = html.split('<tr').filter((r) => r.includes('data-address='))
    expect(rows).toHaveLength(4)
    for (const r of rows) {
      expect(r.match(/>Copy</g), r).toHaveLength(1)
      expect(r.indexOf('crypted<')).toBeLessThan(r.indexOf('>Copy<'))
    }
    expect(html.match(/>Copy</g)).toHaveLength(4)
    expect(html.slice(html.lastIndexOf('</table>'))).not.toContain('>Copy<')
    expect(html.match(/>Encrypted</g)).toHaveLength(2)
    expect(html.match(/>Not encrypted</g)).toHaveLength(2)
    expect(html.split(NOT_ENCRYPTED_WARNING)).toHaveLength(2)
    expect(renderToStaticMarkup(<AddressTable status={{ urls: urls.filter((u) => u.encrypted), networks: [] }} />)).not.toContain(NOT_ENCRYPTED_WARNING)
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
    expect(html).toMatch(/Paired<\/span>.*Connected now/)
    expect(html).toMatch(/Token<\/span>.*Never connected/)
    expect(renderToStaticMarkup(<RemoteDeviceList devices={[]} busy={false} onRemove={() => {}} />)).toContain('None. To add a device, click Add, then Share.')
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
    expect(html).toContain('Enter this code on the other device.')
    expect(html).toContain('012 345')
    expect(html).toMatch(/Expires in <span[^>]*>2:00<\/span> · 20 tries left/)
    expect(html).toContain('Fingerprint <span class="font-mono">ABCD-EFGH</span>')
    expect(html).toContain('1 device is locked out after 5 wrong codes.')
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
    // Review A2: the network it will listen on is named, already allowed or not.
    expect(consent!.text).toBe('Devices that you pair on Home (192.168.1.0/24) get full control of this server. This control is equal to your seed phrase.')
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
    // Review A2: every network it will listen on, the one already allowed too.
    expect(consent!.text).toBe('Devices that you pair on Home (192.168.1.0/24) and Cafe (10.0.0.0/24) get full control of this server. This control is equal to your seed phrase.')
    expect(render(view(status({ networks: [cafe] })))).toContain(PUBLIC_NETWORK_WARNING)
    // An unidentified network cannot be allowed: it is not asked for.
    expect(shareConsent(status({ networks: [home, { ...cafe, id: null, label: 'Unidentified network' }] }))).toBeNull()
    expect(shareConsent(status({ networks: [home] }))).toBeNull()
  })

  it('allowed and listening: the name, the code with its countdown, the addresses by network with Copy, a token under Token', () => {
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
      ['Other', ['mdns-name']],
    ])
    const html = render(view(s))
    // "Name": the name devices see (the hello carries it), then the code, then the addresses.
    expect(SHARE_AS_LABEL).toBe('Name')
    expect(html).toContain(`aria-label="${SHARE_AS_LABEL}"`)
    expect(html).toContain('value="agent-1-pc"')
    expect(html).toContain(SHARE_AS_HELP)
    expect(html.indexOf(`>${SHARE_AS_LABEL}<`)).toBeGreaterThan(-1)
    expect(html.indexOf(`>${SHARE_AS_LABEL}<`)).toBeLessThan(html.indexOf('012 345'))
    expect(html.indexOf('012 345')).toBeLessThan(html.indexOf('>Addresses<'))
    expect(html).toContain('>2:00<')
    expect(html.indexOf('>Tailscale<')).toBeLessThan(html.indexOf('>Home (192.168.1.0/24)<'))
    expect(html.match(/>Copy</g)).toHaveLength(4)
    expect(html).toContain('>Token</summary>')
    expect(html).toContain('aria-label="Device name"')
    expect(html).toContain('>Create<')
    expect(html).not.toContain('>Allow<')
    expect(html).not.toContain('>Details</summary>')
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

  it('review A2: a Public network allowed earlier (for agent sharing) still carries the warning when remote access is turned on there', () => {
    const allowedCafe = { ...cafe, allowed: true }
    const consent = shareConsent(status({ enabled: false, state: 'off', networks: [allowedCafe] }))
    expect(consent).toMatchObject({ enable: true, networks: [], warning: PUBLIC_NETWORK_WARNING })
    expect(consent!.text).toContain('on Cafe (10.0.0.0/24)')
  })

  it('review A6: the sentence names the local server Share shares; Devices names it in its help sentence', () => {
    expect(shareConsent(status({ enabled: false, state: 'off', networks: [home] }), 'box-1 (Local)')!.text).toBe('Devices that you pair on Home (192.168.1.0/24) get full control of box-1 (Local). This control is equal to your seed phrase.')
    expect(devicesHint('box-1 (Local)')).toBe('Devices that can access box-1 (Local).')
    expect(devicesHint(null)).toBe('Devices that can access this server.')
    const html = renderToStaticMarkup(<DevicesGroupView view={view(status())} runtime="box-1 (Local)" busy={false} message={null} onSwitch={noop} onRevoke={noop} />)
    // The heading's help sentence, and the row.
    expect(html).toContain('Devices that can access box-1 (Local).')
    expect(html).toContain('Devices that you pair can connect to box-1 (Local).')
    expect(html).not.toMatch(/runtime/i)
  })

  it('an expired code offers Renew; not local mode says why', () => {
    expect(render(view(status({ networks: [home], pairing: { ...pairing, expiresAt: '2026-10-18T11:00:00Z' } })))).toContain('>Renew<')
    // Review A3: the daemon drops an expired window (pairing null), as after 20 wrong codes or a failed open: Renew, never "Opening…" for good.
    const closed = render(view(status({ networks: [home], pairing: null })), { opened: true })
    expect(closed).toContain('>Renew<')
    expect(closed).not.toContain('Opening…')
    // Before Share opened one: Opening….
    expect(render(view(status({ networks: [home], pairing: null })))).toContain('Opening…')
    expect(render(view(null, { available: false, unavailableReason: 'Remote access needs Local as the connection (Settings → Connections).' }))).toContain('Remote access needs Local as the connection')
  })

  it('review A4: after consent, the firewall line and its commands when the daemon cannot tell or sees a block', () => {
    const unknown = render(view(status({ networks: [home], pairing, firewall: { state: 'unknown', message: 'Linux does not ask. If ufw or firewalld runs, allow port 7385 from your network.', commands: ['sudo ufw allow from 192.168.0.0/16 to any port 7385 proto tcp'] } })))
    expect(unknown).toContain('Linux does not ask. If ufw or firewalld runs, allow port 7385 from your network.')
    expect(unknown).toContain('sudo ufw allow from 192.168.0.0/16 to any port 7385 proto tcp')
    const blocked = render(view(status({ networks: [home], pairing, firewall: { state: 'blocked', message: 'Windows Firewall blocks ADF Studio.', commands: [] } })))
    expect(blocked).toContain('Windows Firewall blocks ADF Studio.')
    expect(render(view(status({ networks: [home], pairing })))).not.toContain('>Firewall<')
    // Before consent nothing of it shows.
    expect(render(view(status({ enabled: false, state: 'off', networks: [home], firewall: { state: 'blocked', message: 'Windows Firewall blocks ADF Studio.', commands: [] } })))).not.toContain('Windows Firewall blocks')
  })

  it('review A5: leaving Share after its Allow: off again when Share turned it on and no device was added; else one line that it stays on', () => {
    expect(shareLeave({ turnedOn: true, allowed: true, added: false })).toBe('off')
    expect(shareLeave({ turnedOn: true, allowed: true, added: true })).toBe('stays')
    expect(shareLeave({ turnedOn: false, allowed: true, added: false })).toBe('stays')
    expect(shareLeave({ turnedOn: false, allowed: false, added: false })).toBeNull()
    expect(STAYS_ON_LINE).toBe('Remote access stays on. To turn it off, use Devices.')
    expect(NOT_ENCRYPTED_WARNING).toBe('Some addresses use http. Anyone on those networks can read the token.')
    expect(render(view(status({ networks: [home], pairing })), { leave: 'stays' })).toContain(STAYS_ON_LINE)
    expect(render(view(status({ networks: [home], pairing })), { leave: 'off' })).not.toContain(STAYS_ON_LINE)
    // S1: leaving (Back, Cancel, the dialog closing) asks main, which decides; the renderer never turns it off itself.
    const src = readFileSync(join(__dirname, '../../../src/renderer/components/settings/RemoteAccessSettings.tsx'), 'utf-8')
    expect(src).toMatch(/useEffect\(\(\) => \(\) => \{ void window\.adfApi\?\.leaveRemoteShare/)
    expect(src).not.toContain('setRemoteAccess({ enabled: false })')
    expect(src).not.toContain('closeRemotePairing')
    // While Share works (the Allow dialog is open), Back and Cancel are disabled.
    const busy = render(view(status({ enabled: false, state: 'off', networks: [home] })), { busy: true })
    expect(busy).toMatch(/<button[^>]*disabled=""[^>]*>Back<\/button>/)
    expect(busy).toMatch(/<button[^>]*disabled=""[^>]*>Cancel<\/button>/)
    // Review A1: Share's Allow goes to main's Share call; the renderer never asserts a confirmation.
    expect(src).toContain('window.adfApi.shareRemoteAccess()')
    expect(src).not.toContain('confirmed')
  })

  it('the token once, with Copy and Done, and where to use it', () => {
    const html = renderToStaticMarkup(<NewTokenPanel label="agent-2 laptop" token="adfd_k3j9q2m7xa_secret" onDone={() => {}} />)
    expect(html).toContain('adfd_k3j9q2m7xa_secret')
    expect(html).toContain('Studio shows it only one time.')
    expect(html).toContain('>Copy<')
    expect(html).toContain('>Done<')
    expect(html).toContain('On the other computer, click Add, then Connect, and enter the token.')
  })
})

describe('D5: the name field', () => {
  it('blank says "Enter a name."; the daemon\'s rule in plain words; focus to Back or Cancel does not save', async () => {
    const { NAME_BLANK, NAME_RULE, nameError, leavingFocus, ShareNameField } = await import('../../../src/renderer/components/settings/RemoteAccessSettings')
    expect(NAME_BLANK).toBe('Enter a name.')
    expect(nameError('name must be 1-63 characters without control or bidi characters')).toBe(NAME_RULE)
    expect(NAME_RULE).toBe('Use 1 to 63 characters. Do not use control characters.')
    expect(nameError('Studio could not reach the server.')).toBe('Studio could not reach the server.')
    expect(leavingFocus({ dataset: { shareLeave: '' } } as never)).toBe(true)
    expect(leavingFocus({ dataset: {} } as never)).toBe(false)
    expect(leavingFocus(null)).toBe(false)
    expect(renderToStaticMarkup(<ShareNameField name="laptop-1" draft="" busy={false} note={{ kind: 'error', text: NAME_BLANK }} onDraft={() => {}} onSave={() => {}} />)).toContain(NAME_BLANK)
    const src = readFileSync(join(__dirname, '../../../src/renderer/components/settings/RemoteAccessSettings.tsx'), 'utf-8')
    expect(src).toContain('onBlur={(e) => { if (!leavingFocus(e.relatedTarget)) onSave() }}')
    expect(src.match(/data-share-leave=""/g)).toHaveLength(2)
    expect(src).toContain("if (!next) { setNameNote({ kind: 'error', text: NAME_BLANK }); return }")
  })
})

describe('Connections → Devices: devices that can access the local server, each with Revoke', () => {
  const noop = () => {}
  it('the Remote access switch with its line, the devices and Revoke; what quitting does, exactly, with no second quit control', () => {
    const html = renderToStaticMarkup(<DevicesGroupView view={{ available: true, unavailableReason: null, status: status({ devices: [device({ connected: true })] }), error: null, stopsWithStudio: true }} runtime="host-0 (Local)" busy={false} message={null} onSwitch={noop} onRevoke={noop} />)
    expect(html).toContain('>Devices<')
    expect(html).toContain('Devices that can access host-0 (Local).')
    expect(html).toContain('<details class="group" open="">')
    expect(html).toContain('>On · 1 device<')
    expect(html).toContain('aria-label="Remote access"')
    expect(html).toContain('Listening on 192.168.1.20, 100.101.102.103.')
    expect(html).toContain('agent-2 laptop')
    expect(html).toContain('>Revoke<')
    expect(html).toContain(STOPS_WITH_STUDIO)
    expect(html).not.toContain('>Keep running<')
    expect(html).not.toContain('lose the connection')
    expect(html.match(/role="switch"/g)).toHaveLength(1)
  })

  it('off with no device: collapsed to its heading, which says Off', () => {
    const v = { available: true, unavailableReason: null, status: status({ enabled: false, state: 'off' }), error: null, stopsWithStudio: false }
    const html = renderToStaticMarkup(<DevicesGroupView view={v} busy={false} message={null} onSwitch={noop} onRevoke={noop} />)
    expect(html).toContain('<details class="group">')
    expect(devicesSummary(v)).toBe('Off')
    expect(html).toContain('>Off<')
  })

  it('not local mode: the reason, and the switch is disabled', () => {
    const v = { available: false, unavailableReason: 'Remote access needs Local as the connection (Settings → Connections).', status: null, error: null, stopsWithStudio: false }
    const html = renderToStaticMarkup(<DevicesGroupView view={v} busy={false} message={null} onSwitch={noop} onRevoke={noop} />)
    expect(html).toContain('Remote access needs Local as the connection')
    expect(devicesSummary(v)).toBe('Not available')
    expect(html).toMatch(/role="switch"[^>]*disabled=""|disabled=""[^>]*role="switch"/)
  })
})

describe('a remote runtime: one sentence for every host-only control (review item 11)', () => {
  it('changeOn is the one line; Settings uses it for identity, and Networking for the networks, firewall, HTTPS and endpoints', () => {
    expect(changeOn('box-1')).toBe('Change on box-1.')
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
  const items = networkingStatusItems({ meshOn: true, networks: [home], shared: 0 })
  const card = (consent: ReturnType<typeof consentLines>) => renderToStaticMarkup(<NetworkingStatusCard items={items} consent={consent} busy={false} note={null} firewall={null} onAllow={() => {}} />)

  it('the status card: one fact per line (Mesh, each network, Shared), each with its state', () => {
    expect(networkingStatusItems({ meshOn: true, networks: [home, cafe], shared: 3 })).toEqual([
      { label: 'Mesh', value: 'On', tone: 'ok' },
      { label: 'Network', value: 'Home (192.168.1.0/24) · Allowed', tone: 'ok' },
      { label: 'Network', value: 'Cafe (10.0.0.0/24) · Not allowed', tone: 'off' },
      { label: 'Shared', value: '3 agents', tone: 'ok' },
    ])
    expect(networkingStatusItems({ meshOn: false, networks: [], shared: 1 }).map((i) => i.value)).toEqual(['Off', 'None', '1 agent'])
    expect(networkingStatusItems({ meshOn: true, networks: [{ ...cafe, id: null, label: 'Unidentified network' }], shared: 0 })[1]).toEqual({ label: 'Network', value: 'Unidentified network · Not identified', tone: 'down' })
    // A remote server: its network is not this computer's.
    expect(networkingStatusItems({ meshOn: true, networks: null, shared: 2 }).map((i) => i.label)).toEqual(['Mesh', 'Shared'])
    const html = renderToStaticMarkup(<NetworkingStatusCard items={networkingStatusItems({ meshOn: true, networks: [home], shared: 3 })} consent={[]} busy={false} note={null} firewall={null} onAllow={() => {}} />)
    expect(html).toContain('<dl')
    for (const s of ['>Mesh<', '>On<', '>Network<', '>Home (192.168.1.0/24) · Allowed<', '>Shared<', '>3 agents<']) expect(html, s).toContain(s)
  })

  it('the status line (logs and tests): the mesh, the networks (allowed or not), the agents shared', () => {
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

  it('an unidentified network never dead-ends: the card and Share say why, with Help; no Allow', () => {
    const unknown: NetworkView = { id: null, problem: { step: 'no_answer', detail: 'no ARP entry for 192.168.1.1 on en0 after 3 probe(s)' }, kind: 'lan', label: 'Unidentified network', allowed: false, osCategory: 'unknown', ifaces: ['en0'], addresses: ['192.168.1.20'] }
    const lines = consentLines(net({ networks: [unknown], waiting: { remoteAccess: false, mesh: true } }), ['agent-1'])
    expect(lines).toEqual([{
      key: 'unidentified:en0', networkId: null, lines: ['Agent sharing paused on Unidentified network.'], warning: null,
      reason: 'Studio cannot identify this network. The router does not answer.', detail: 'no ARP entry for 192.168.1.1 on en0 after 3 probe(s)',
    }])
    // Nothing waits: still the reason.
    expect(consentLines(net({ networks: [unknown] }), [])[0].reason).toBe('Studio cannot identify this network. The router does not answer.')
    const html = card(lines)
    expect(html).toContain('Studio cannot identify this network. The router does not answer.')
    expect(html).toContain(`href="${DOCS.unidentifiedNetwork}"`)
    expect(html).toContain('>Help<')
    expect(html).not.toContain('>Allow<')
    const share = renderToStaticMarkup(<SharePanelView view={{ available: true, status: status({ networks: [unknown] }) } as RemoteAccessView} busy={false} error={null} approved={null} label="" created={null} onLabel={() => {}} onAllow={() => {}} onRenew={() => {}} onCreateToken={() => {}} onBack={() => {}} onDone={() => {}} />)
    expect(share).toContain('Studio cannot identify this network. The router does not answer.')
  })

  it('a public agent asks for the same consent per network, visibly: "agent-1 is public." under the paused line', () => {
    expect(publicAgentsLine(['agent-1'])).toBe('agent-1 is public.')
    expect(publicAgentsLine(['agent-1', 'agent-2'])).toBe('agent-1 and agent-2 are public.')
    expect(publicAgentsLine([])).toBeNull()
    expect(consentLines(net({ networks: [cafe] }), ['agent-1'])[0].lines).toEqual(['Agent sharing paused on Cafe (10.0.0.0/24).', 'agent-1 is public.'])
    const html = card(consentLines(net({ networks: [cafe] }), ['agent-1']))
    expect(html).toContain('agent-1 is public.')
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
    const warning = 'Public agents listen on this computer only. No network is allowed. On a computer with only a public address, set MESH_HOST=0.0.0.0. Then restart the server.'
    // A remote runtime (no consent lines) or this computer with nothing to allow: the line shows.
    expect(meshWarningLine({ warning }, [])).toBe(warning)
    expect(meshWarningLine({ warning }, consentLines(net({ networks: [{ ...cafe, id: null, label: 'Unidentified network' }] }), ['agent-1']))).toBe(warning)
    // A network to allow: its Allow line already says what to do.
    expect(meshWarningLine({ warning }, consentLines(net({ networks: [cafe] }), ['agent-1']))).toBeNull()
    expect(meshWarningLine({}, [])).toBeNull()
    const html = renderToStaticMarkup(<NetworkingStatusCard items={items} consent={[]} busy={false} note={null} firewall={null} warning={warning} onAllow={() => {}} />)
    expect(html).toContain(warning)
  })

  it('shared agents: visibility lan or public', () => {
    expect(sharedAgents([{ visibility: 'lan' }, { visibility: 'public' }, { visibility: 'localhost' }, { visibility: 'off' }, {}])).toHaveLength(2)
  })

  it('Servers: one list, how each was found, Managed when Connections has it, added addresses that do not answer', () => {
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
    expect(addressMatches('laptop-1', { host: 'laptop-1', port: 7295 })).toBe(true)
  })

  it('the firewall: what blocks, the exact commands to run, never an elevated button (R9)', () => {
    expect(firewallText({ supported: true, ruleConfigured: false, reachable: null, lanIp: '192.168.1.20', detail: '', port: 7295, serverLanBound: true, verified: false })).toBe('Other servers find this server. They see 0 agents. Add a firewall rule for the mesh port.')
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
  it('Settings → Networking: the status card, Sharing, Networks, Servers, Advanced closed, in that order', async () => {
    const { NetworkingSettings } = await import('../../../src/renderer/components/settings/NetworkingSettings')
    const html = renderToStaticMarkup(<NetworkingSettings remote={false} runtimeName="host-0 (Local)" pickedMesh={undefined} />)
    expect(html).toContain('data-status-card=""')
    expect(html).toContain('>Mesh<')
    expect(html).toContain('>0 agents<')
    const order = ['data-status-card=""', '>Sharing<', '>Networks<', '>Servers<', '>Advanced</summary>'].map((s) => html.indexOf(s))
    for (const at of order) expect(at).toBeGreaterThan(-1)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    for (const s of ['aria-label="Mesh"', 'aria-label="Network"', '>Agents', '0 shared', '>Mesh server<']) expect(html, s).toContain(s)
    expect(html).not.toContain('>Runtimes<')
    expect(html).not.toContain('<details open')
    expect(html).not.toContain('aria-label="LAN"')
    // Server naming in what it renders.
    expect(html.replace(/<[^>]+>/g, ' ')).not.toMatch(/\bruntimes?\b/i)
    // A remote server: host-only rows say where they are changed.
    expect(renderToStaticMarkup(<NetworkingSettings remote runtimeName="box-1" pickedMesh="remote:box-1" />)).toContain('Change on box-1.')
  })

  it('Add: Connect and Share; Connect shows Address, Code and Token at once; Share loads', async () => {
    const { AddDialog, AddConnectionDialog } = await import('../../../src/renderer/components/settings/ConnectionSettings')
    const add = renderToStaticMarkup(<AddDialog onClose={() => {}} />)
    expect(add).toContain('>Add</h2>')
    expect(add).toContain('>Connect<')
    expect(add).toContain('>Share<')
    const connect = renderToStaticMarkup(<AddConnectionDialog onClose={() => {}} onBack={() => {}} />)
    expect(connect).toContain('>Connect</h2>')
    expect(connect).toContain('aria-label="Address"')
    expect(connect).toContain('aria-label="Code"')
    expect(connect).toContain('aria-label="Token"')
    expect(connect).not.toContain('>Details</summary>')
    expect(connect).toContain('>Back<')
    expect(connect).not.toContain('Use a token instead')
    const share = renderToStaticMarkup(<SharePanelView view={null} busy={false} error={null} approved={null} label="" created={null} onLabel={() => {}} onAllow={() => {}} onRenew={() => {}} onCreateToken={() => {}} onBack={() => {}} onDone={() => {}} />)
    expect(share).toContain('Loading…')
  })
})
