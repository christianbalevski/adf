/**
 * Remote access in the renderer (Settings → Networking, Settings → Backend)
 * (docs/design/remote-access.md §7, §9.1; owner decisions 2026-10-18): the
 * status line (Public network), the address order and labels, the devices
 * list, the pairing code, the token shown once, the computers found and the
 * pairing dialog's messages. Static markup, no jsdom.
 */
import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  DiscoveredList,
  meshServerHosts,
  meshVisibilityLine,
  networkStatusText,
  remoteSummary,
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
import type { NetworkStatusView, RemoteAccessView, RemotePairState } from '../../../src/shared/types/remote-access-ipc.types'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DOCS } from '../../../src/shared/constants/docs-links'

// Vitest compiles JSX with the classic runtime (the renderer build uses the automatic one).
;(globalThis as { React?: typeof React }).React = React

const status = (over: Partial<RemoteAccessStatus> = {}): RemoteAccessStatus => ({
  enabled: true, state: 'on', message: '', problem: null, name: 'agent-1-pc', fingerprint: 'ABCD-EFGH', port: 7385,
  addresses: [
    { address: '192.168.1.20', family: 'IPv4', kind: 'lan', iface: 'Wi-Fi', network: 'private', listening: true, problem: null },
    { address: '100.101.102.103', family: 'IPv4', kind: 'tailnet', iface: 'Tailscale', network: 'tailnet', listening: true, problem: null },
  ],
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
  it('off, on with the listening addresses, and Public (nothing listens)', () => {
    expect(remoteStatusLine(status({ enabled: false, state: 'off' }))).toBe('Off.')
    expect(remoteStatusLine(status())).toBe('Listening on 192.168.1.20, 100.101.102.103.')
    expect(remoteStatusLine(status({ addresses: [], firewall: { state: 'public_network', message: '', commands: [] } }))).toBe('Not reachable on this network (Public).')
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

describe('Pair device (host)', () => {
  it('the 6-digit code in large digits, the countdown and the tries left', () => {
    const now = Date.parse('2026-10-18T12:00:00Z')
    expect(pairingCountdown('2026-10-18T12:01:45Z', now)).toBe('1:45')
    expect(pairingCountdown('2026-10-18T11:00:00Z', now)).toBe('0:00')
    expect(formatCode('012345')).toBe('012 345')
    const html = renderToStaticMarkup(<PairingCodePanel pairing={{ code: '012345', name: 'agent-1-pc', fingerprint: 'ABCD-EFGH', openedAt: '', expiresAt: '2026-10-18T12:02:00Z', attemptsLeft: 5, claim: null }} fingerprint="ABCD-EFGH" now={now} />)
    expect(html).toContain('Enter this code on the device.')
    expect(html).toContain('012 345')
    expect(html).toContain('Expires in 2:00 · 5 tries left · Fingerprint ABCD-EFGH')
  })
})

describe('Add device (host)', () => {
  it('the token once, with Copy and Done', () => {
    const html = renderToStaticMarkup(<NewTokenPanel label="agent-2 laptop" token="adfd_k3j9q2m7xa_secret" onDone={() => {}} />)
    expect(html).toContain('adfd_k3j9q2m7xa_secret')
    expect(html).toContain('shown once')
    expect(html).toContain('>Copy<')
    expect(html).toContain('>Done<')
  })
})

describe('Discovered (client)', () => {
  it('name, address and Encrypted / Not encrypted, with Pair', () => {
    const html = renderToStaticMarkup(<DiscoveredList onPair={() => {}} update={{ browsing: true, problem: null, entries: [
      { fingerprint: 'ABCD-EFGH', name: 'agent-1-pc', url: 'http://100.101.102.103:7385', address: '100.101.102.103', kind: 'tailnet', encrypted: true, pairingOpen: true, alreadyPaired: false },
      { fingerprint: 'WXYZ-2345', name: 'agent-3-mac', url: 'http://192.168.1.44:7385', address: '192.168.1.44', kind: 'lan', encrypted: false, pairingOpen: false, alreadyPaired: true },
    ] }} />)
    expect(html).toContain('agent-1-pc')
    expect(html).toContain('100.101.102.103 · ABCD-EFGH')
    expect(html).toContain('>Pairing open<')
    expect(html).toContain('>Paired<')
    expect(html).toContain('>Encrypted<')
    expect(html).toContain('>Not encrypted<')
    expect(html.match(/>Pair</g)).toHaveLength(2)
  })

  it('says how to make one appear when none is found', () => {
    expect(renderToStaticMarkup(<DiscoveredList onPair={() => {}} update={{ browsing: true, problem: null, entries: [] }} />)).toContain('None yet. Turn on Remote access on the other computer.')
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
  const net = (over: Partial<NetworkStatusView>): NetworkStatusView => ({
    available: true, network: 'private', lan: [{ address: '192.168.1.20', iface: 'Wi-Fi', network: 'private' }],
    tailscale: 'running', tailnetAddress: '100.101.102.103', firewall: { state: 'ok', message: '' }, problem: null, markable: false, ...over,
  })

  it('the status line: category, LAN address, Tailscale, firewall', () => {
    expect(networkStatusText(net({}))).toBe('Network: Private (Wi-Fi) · LAN 192.168.1.20 · Tailscale on (100.101.102.103) · Firewall ok')
    expect(networkStatusText(net({ network: 'public', lan: [{ address: '10.0.0.5', iface: 'Wi-Fi', network: 'public' }], tailscale: 'absent', tailnetAddress: null, firewall: { state: 'blocked', message: 'x' } })))
      .toBe('Network: Public (Wi-Fi) · LAN 10.0.0.5, not listening · Tailscale not installed · Firewall blocked')
    expect(networkStatusText(net({ network: 'none', lan: [], tailscale: 'stopped' }))).toBe('Network: no LAN address · Tailscale stopped · Firewall ok')
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

  it('Settings → Backend: one line for remote access', () => {
    const view = (over: Partial<RemoteAccessView>): RemoteAccessView => ({ available: true, unavailableReason: null, status: status({ devices: [device(), device({ id: 'b' })] }), error: null, stopsWithStudio: false, ...over })
    expect(remoteSummary(view({}))).toBe('On · 2 devices')
    expect(remoteSummary(view({ status: status({ enabled: false }) }))).toBe('Off')
    expect(remoteSummary(view({ status: status({ devices: [device()] }) }))).toBe('On · 1 device')
  })

  it('every remote-access docs link is a heading of its guide', () => {
    const slug = (heading: string) => heading.toLowerCase().replace(/[^\p{L}\p{N} -]/gu, '').replace(/ /g, '-')
    const anchors = (file: string) => new Set(readFileSync(join(__dirname, '../../../docs/guides', file), 'utf-8').split(/\r?\n/).filter((l) => /^#{2,3} /.test(l)).map((l) => slug(l.replace(/^#+ /, ''))))
    for (const url of [DOCS.remoteAccess, DOCS.remoteAccessPair, DOCS.remoteAccessDiscovered, DOCS.networkingStatus]) {
      const [, file, anchor] = /\/docs\/guides\/([^#]+)#(.+)$/.exec(url)!
      expect(anchors(file).has(anchor), url).toBe(true)
    }
  })

  it('no question-style or banned phrasing in what the UI renders', () => {
    const html = renderToStaticMarkup(<DiscoveredList onPair={() => {}} update={{ browsing: true, problem: null, entries: [] }} />)
      + renderToStaticMarkup(<RemoteDeviceList devices={[]} busy={false} onRemove={() => {}} />)
      + renderToStaticMarkup(<NewTokenPanel label="x" token="t" onDone={() => {}} />)
    for (const banned of ['Allow other computers to connect', 'Found on your network', 'Who can reach this computer?', 'Your other computers']) expect(html).not.toContain(banned)
  })
})
