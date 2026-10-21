/**
 * Settings → Networking, review of PR #186 (docs/guides/settings.md#networking):
 * Managed by the paired fingerprint first (B1), the HTTPS row names the real
 * cause (B2), the status card's entries are one sentence each (B3). Static
 * markup and pure helpers, no jsdom, no IPC.
 */
import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  consentLines,
  httpsText,
  isManaged,
  NetworkingStatusCard,
  publicAgentsLine,
} from '../../../src/renderer/components/settings/NetworkingSettings'
import type { NetworkStatusView, RemoteAccessView } from '../../../src/shared/types/remote-access-ipc.types'
import type { RemoteAccessStatus } from '../../../src/shared/types/remote-access.types'

;(globalThis as { React?: typeof React }).React = React

const FP_1 = 'ABCD-EFGH'
const FP_2 = 'WXYZ-1234'

describe('B1: Managed is matched by the paired fingerprint first, the host only as a fallback', () => {
  it('a remote saved under its Tailscale https name is Managed by its fingerprint', () => {
    const runtime = { host: '192.168.1.20', url: 'http://192.168.1.20:7295', fingerprint: FP_1, daemon_port: 7385 }
    expect(isManaged(runtime, [{ kind: 'saved', url: 'https://host-1.tail1234.ts.net', fingerprint: FP_1 }])).toBe(true)
  })

  it('two runtimes on one host: only the paired one is Managed', () => {
    const paired = { host: '192.168.1.20', url: 'http://192.168.1.20:7295', fingerprint: FP_1, daemon_port: 7385 }
    const other = { host: '192.168.1.20', url: 'http://192.168.1.20:7296', fingerprint: FP_2, daemon_port: 7386 }
    const bare = { host: '192.168.1.20', url: 'http://192.168.1.20:7297' }
    const rows = [{ kind: 'saved' as const, url: 'http://192.168.1.20:7385', fingerprint: FP_1 }]
    const found = [paired, other, bare]
    expect(isManaged(paired, rows, found)).toBe(true)
    expect(isManaged(other, rows, found)).toBe(false)
    // No fingerprint announced: the host is the fallback, but not for a row another runtime here holds by fingerprint.
    expect(isManaged(bare, rows, found)).toBe(false)
  })

  it('the host fallback: a runtime that announces no fingerprint, a row saved without one, the daemon port when both say it', () => {
    const bare = { host: '192.168.1.20', url: 'http://192.168.1.20:7295' }
    expect(isManaged(bare, [{ kind: 'saved', url: 'http://192.168.1.20:7385', fingerprint: FP_1 }])).toBe(true)
    expect(isManaged({ ...bare, fingerprint: FP_1 }, [{ kind: 'saved', url: 'http://192.168.1.20:7385', fingerprint: null }])).toBe(true)
    expect(isManaged({ ...bare, daemon_port: 7386 }, [{ kind: 'saved', url: 'http://192.168.1.20:7385', fingerprint: null }])).toBe(false)
    expect(isManaged(bare, [{ kind: 'found', url: 'http://192.168.1.20:7385', fingerprint: FP_1 }])).toBe(false)
  })
})

const tailscale = (over: Partial<RemoteAccessStatus['tailscale']>): RemoteAccessView => ({
  available: true, unavailableReason: null, error: null, stopsWithStudio: false,
  status: { tailscale: { state: 'running', serve: 'off', httpsUrl: null, serveCommand: null, ...over } } as RemoteAccessStatus,
})

describe('B2: HTTPS names the real cause, one sentence', () => {
  it('Inside Studio (legacy) or a remote connection: the reason the panel cannot be used', () => {
    const view: RemoteAccessView = { available: false, unavailableReason: 'Remote access needs Local as the connection (Settings → Connections).', status: null, error: null, stopsWithStudio: false }
    expect(httpsText(view)).toBe('Remote access needs Local as the connection (Settings → Connections).')
  })

  it('the daemon down: its error, cut to one sentence', () => {
    const view: RemoteAccessView = { available: true, unavailableReason: null, status: null, error: 'Studio is not connected to the ADF daemon yet. Retry in a moment.', stopsWithStudio: false }
    expect(httpsText(view)).toBe('Studio is not connected to the ADF daemon yet.')
    expect(httpsText({ ...view, error: 'connect ECONNREFUSED 127.0.0.1:7385' })).toBe('connect ECONNREFUSED 127.0.0.1:7385.')
  })

  it('Tailscale running but its serve state unknown; Tailscale absent; on; off; not read yet', () => {
    expect(httpsText(tailscale({ serve: 'unknown' }))).toBe('Tailscale did not answer.')
    expect(httpsText(tailscale({ state: 'absent', serve: 'unknown' }))).toBe('Needs Tailscale.')
    expect(httpsText(tailscale({ state: 'stopped', serve: 'unknown' }))).toBe('Needs Tailscale.')
    expect(httpsText(tailscale({ serve: 'on', httpsUrl: 'https://host-1.tail1234.ts.net' }))).toBe('On: https://host-1.tail1234.ts.net.')
    expect(httpsText(tailscale({ serve: 'off' }))).toBe('Off.')
    expect(httpsText(null)).toBe('Checking…')
  })
})

describe('B3: the status card, one sentence per entry', () => {
  const cafe = { id: 'lan-fedcba9876543210', kind: 'lan' as const, label: 'Cafe (10.0.0.0/24)', allowed: false, osCategory: 'unknown' as const, ifaces: ['Wi-Fi'], addresses: ['10.0.0.5'] }
  const net = (over: Partial<NetworkStatusView>): NetworkStatusView => ({
    available: true, lan: [], networks: [cafe], allowedNetworks: [],
    tailscale: 'running', tailnetAddress: null, firewall: { state: 'ok', message: '' }, waiting: { remoteAccess: true, mesh: true }, ...over,
  })
  /** Sentence ends (., !, ? or ; before a space or the end); a dotted address is not one. */
  const sentences = (s: string) => (s.match(/[.!?;](?=\s|$)/g) ?? []).length

  it('"agent-1 is public." under the paused line; the button is just Allow', () => {
    expect(publicAgentsLine(['agent-1'])).toBe('agent-1 is public.')
    expect(publicAgentsLine(['agent-1', 'agent-2'])).toBe('agent-1 and agent-2 are public.')
    expect(publicAgentsLine(['agent-1', 'agent-2', 'agent-3'])).toBe('agent-1, agent-2 and agent-3 are public.')
    expect(publicAgentsLine([])).toBeNull()
    const entry = consentLines(net({}), ['agent-1'])[0]
    expect(entry.lines).toEqual(['Remote access and agent sharing paused on Cafe (10.0.0.0/24).', 'agent-1 is public.'])
    for (const line of entry.lines) expect(sentences(line), line).toBe(1)
    const html = renderToStaticMarkup(<NetworkingStatusCard line="Mesh on" consent={[entry]} busy={false} note={null} firewall={null} onAllow={() => {}} />)
    expect(html).not.toContain('Allow on this network')
    expect(html.match(/>Allow</g)).toHaveLength(1)
  })
})
