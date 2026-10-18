/**
 * Settings → Backend, "Allow other computers to connect" in the renderer
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
import type { RemotePairState } from '../../../src/shared/types/remote-access-ipc.types'

// Vitest compiles JSX with the classic runtime (the renderer build uses the automatic one).
;(globalThis as { React?: typeof React }).React = React

const status = (over: Partial<RemoteAccessStatus> = {}): RemoteAccessStatus => ({
  enabled: true, state: 'on', message: '', problem: null, name: 'agent-1-pc', fingerprint: 'ABCD-EFGH', port: 7385,
  addresses: [
    { address: '192.168.1.20', family: 'IPv4', kind: 'lan', iface: 'Wi-Fi', listening: true, problem: null },
    { address: '100.101.102.103', family: 'IPv4', kind: 'tailnet', iface: 'Tailscale', listening: true, problem: null },
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
    expect(remoteStatusLine(status({ enabled: false, state: 'off' }))).toBe('Not reachable from other computers.')
    expect(remoteStatusLine(status())).toBe('Reachable from other computers at 192.168.1.20, 100.101.102.103.')
    expect(remoteStatusLine(status({ addresses: [], firewall: { state: 'public_network', message: '', commands: [] } }))).toBe('Not reachable on this network (Public).')
  })

  it('no address, the env bind and errors show the daemon\'s sentence', () => {
    expect(remoteStatusLine(status({ state: 'no_address', message: 'No private network address now; other computers cannot reach this computer.' }))).toBe('No private network address now; other computers cannot reach this computer.')
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

describe('Pair a computer (host)', () => {
  it('the 6-digit code in large digits, the countdown and the tries left', () => {
    const now = Date.parse('2026-10-18T12:00:00Z')
    expect(pairingCountdown('2026-10-18T12:01:45Z', now)).toBe('1:45')
    expect(pairingCountdown('2026-10-18T11:00:00Z', now)).toBe('0:00')
    expect(formatCode('012345')).toBe('012 345')
    const html = renderToStaticMarkup(<PairingCodePanel pairing={{ code: '012345', openedAt: '', expiresAt: '2026-10-18T12:02:00Z', attemptsLeft: 5, claim: null }} name="agent-1-pc" fingerprint="ABCD-EFGH" now={now} />)
    expect(html).toContain('012 345')
    expect(html).toContain('Expires in 2:00 · 5 tries left · Fingerprint ABCD-EFGH')
  })
})

describe('Add a computer (host)', () => {
  it('the token once, with Copy and Done', () => {
    const html = renderToStaticMarkup(<NewTokenPanel label="agent-2 laptop" token="adfd_k3j9q2m7xa_secret" onDone={() => {}} />)
    expect(html).toContain('adfd_k3j9q2m7xa_secret')
    expect(html).toContain('Shown once')
    expect(html).toContain('>Copy<')
    expect(html).toContain('>Done<')
  })
})

describe('Found on your network (client)', () => {
  it('name, address and Encrypted / Not encrypted, with Pair', () => {
    const html = renderToStaticMarkup(<DiscoveredList onPair={() => {}} update={{ browsing: true, problem: null, entries: [
      { fingerprint: 'ABCD-EFGH', name: 'agent-1-pc', url: 'http://100.101.102.103:7385', address: '100.101.102.103', kind: 'tailnet', encrypted: true, pairingOpen: true, alreadyPaired: false },
      { fingerprint: 'WXYZ-2345', name: 'agent-3-mac', url: 'http://192.168.1.44:7385', address: '192.168.1.44', kind: 'lan', encrypted: false, pairingOpen: false, alreadyPaired: true },
    ] }} />)
    expect(html).toContain('agent-1-pc')
    expect(html).toContain('100.101.102.103 · ABCD-EFGH')
    expect(html).toContain('Ready to pair')
    expect(html).toContain('Already paired')
    expect(html).toContain('>Encrypted<')
    expect(html).toContain('>Not encrypted<')
    expect(html.match(/>Pair</g)).toHaveLength(2)
  })

  it('says how to make one appear when none is found', () => {
    expect(renderToStaticMarkup(<DiscoveredList onPair={() => {}} update={{ browsing: true, problem: null, entries: [] }} />)).toContain('turn on Allow other computers to connect')
  })
})

describe('pairing dialog messages (client)', () => {
  const state = (over: Partial<RemotePairState>): RemotePairState => ({ step: 'need_code', host: null, deviceName: 'agent-2-laptop', attemptsLeft: null, message: null, code: null, savedUrl: null, ...over })
  it('errors inline; waiting and paired are plain', () => {
    expect(pairMessage(state({ step: 'need_code', code: 'wrong_code', message: 'Wrong code. 4 tries left.', attemptsLeft: 4 }), 'agent-1-pc')).toEqual({ kind: 'error', text: 'Wrong code. 4 tries left.' })
    expect(pairMessage(state({ step: 'failed', code: 'denied', message: 'agent-1-pc did not allow this computer.' }), 'agent-1-pc')).toEqual({ kind: 'error', text: 'agent-1-pc did not allow this computer.' })
    expect(pairMessage(state({ step: 'waiting' }), 'agent-1-pc')).toEqual({ kind: 'ok', text: 'Waiting for agent-1-pc to allow this computer…' })
    expect(pairMessage(state({ step: 'paired', message: 'Paired with agent-1-pc. Its address and token are saved.' }), 'agent-1-pc')?.kind).toBe('ok')
    expect(pairMessage(null, 'x')).toBeNull()
  })
})
