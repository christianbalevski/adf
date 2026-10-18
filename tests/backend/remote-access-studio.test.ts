/**
 * Remote access in Studio main
 * (docs/design/remote-access.md §7, §9, owner decisions 2026-10-18), against
 * a fake daemon with the contract's routes and error codes
 * (remote-access-fakes.ts):
 *
 * - host panel: the toggle's one confirmation, a token shown once, revoke,
 *   pairing with the "Allow <device>?" question, notices, local mode only;
 * - client: discovery merged by fingerprint, pairing with every error the
 *   dialog shows, the token saved like a pasted one (safe:), never returned;
 * - the quit question: asked every time, remembers nothing;
 * - the IPC registration and the backend config's `remote.paired`.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('./daemon-mode-electron')).electronStub.module)

import { electronStub } from './daemon-mode-electron'
import { createFakeRemoteDaemon, device, type FakeRemoteDaemon } from './remote-access-fakes'
import { DaemonClient, staticCredentials } from '../../src/shared/daemon-client'
import { IPC } from '../../src/shared/constants/ipc-channels'
import { RemoteAccessHost, deviceAddedNotice, deviceRemovedNotice, type RemoteAccessHostDeps } from '../../src/main/backend/remote-access/host'
import { PairingFlow, type PairingSaveInput } from '../../src/main/backend/remote-access/pairing'
import { DaemonPeerFeed, RemoteDiscovery, type PeerFeed } from '../../src/main/backend/remote-access/discovery'
import { RemoteQuitGate, quitQuestion } from '../../src/main/backend/remote-access/quit-gate'
import { claimQuestion, networkStatusView, registerRemoteAccessHandlers, runtimeName, unavailableReason } from '../../src/main/backend/remote-access-ipc'
import type { LanReach } from '../../src/main/services/lan-reach'
import { NetworkConsentPrompt, networkQuestion, PUBLIC_WARNING, type NetworkQuestion } from '../../src/main/backend/remote-access/network-consent'
import type { NetworkPeer, NetworkView } from '../../src/shared/types/remote-access.types'
import { hostname } from 'node:os'
import { applyBackendPatch, createBackendSettingsStore, defaultBackendConfig, normalizeBackendConfig, resolveBootBackend, type SecretCodec } from '../../src/main/backend/backend-config'
import type { RemoteAccessChange, RemotePairState, RemoteDiscoveryUpdate } from '../../src/shared/types/remote-access-ipc.types'

const LOOPBACK = 'http://127.0.0.1:47385'
const LAN = 'http://192.168.1.20:7385'
const TAILNET = 'http://100.101.102.103:7385'
const MASTER = 'm'.repeat(43)

const quiet = { log: () => {}, warn: () => {} }
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))
async function until(check: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await tick(5)
  }
}

function fakeCodec(available = true): SecretCodec {
  return {
    available: () => available,
    unavailableReason: () => (available ? null : 'No OS keyring is available.'),
    encrypt: (plain) => 'safe:' + Buffer.from(plain).toString('base64'),
    decrypt: (stored) => Buffer.from(stored.slice(5), 'base64').toString(),
  }
}

// --- Host ------------------------------------------------------------------------

function hostSetup(over: Partial<RemoteAccessHostDeps> = {}) {
  const daemon = createFakeRemoteDaemon({ loopback: LOOPBACK })
  const client = new DaemonClient({ baseUrl: LOOPBACK, credentials: staticCredentials(MASTER), fetch: daemon.fetch })
  const pushes: RemoteAccessChange[] = []
  const notices: string[] = []
  const confirms: Array<{ message: string; detail: string; ok: string }> = []
  const asked: string[] = []
  let confirmAnswer = true
  let claimAnswer: boolean | null = true
  const host = new RemoteAccessHost({
    daemon: () => ({ client: async () => client }),
    stopsWithStudio: () => true,
    push: (c) => pushes.push(c),
    notify: (t) => notices.push(t),
    confirm: async (p) => { confirms.push(p); return confirmAnswer },
    askClaim: async ({ claim }) => { asked.push(claim.deviceName); return claimAnswer },
    platform: 'win32',
    pollMs: 10,
    log: quiet,
    ...over,
  })
  return {
    daemon, host, pushes, notices, confirms, asked,
    setConfirm: (v: boolean) => { confirmAnswer = v },
    setClaim: (v: boolean | null) => { claimAnswer = v },
  }
}

describe('host panel (Settings → Networking → Remote access)', () => {
  let h: ReturnType<typeof hostSetup>
  beforeEach(() => { h = hostSetup() })
  afterEach(() => h.host.dispose())

  it('reads the status through the management route with the master token', async () => {
    const view = await h.host.get()
    expect(view).toMatchObject({ available: true, unavailableReason: null, error: null, stopsWithStudio: true })
    expect(view.status?.enabled).toBe(false)
    const req = h.daemon.requests.find((r) => r.path === '/remote-access')!
    expect(req.origin).toBe(LOOPBACK)
    expect(req.headers.Authorization).toBe(`Bearer ${MASTER}`)
  })

  it('turning on asks once, plainly (seed phrase; the Windows firewall prompt); Cancel changes nothing', async () => {
    await h.host.get()
    h.setConfirm(false)
    expect(await h.host.set({ enabled: true })).toEqual({ ok: false, code: 'cancelled', error: 'Nothing changed.' })
    expect(h.daemon.requests.some((r) => r.method === 'PUT')).toBe(false)
    expect(h.confirms).toHaveLength(1)
    expect(h.confirms[0].message).toBe('Turn on remote access')
    expect(h.confirms[0].detail).toContain('as powerful as your seed phrase')
    expect(h.confirms[0].detail).toContain('Choose Allow on private networks')
    h.setConfirm(true)
    const on = await h.host.set({ enabled: true })
    expect(on.ok && on.view.status?.enabled).toBe(true)
    expect(h.daemon.requests.find((r) => r.method === 'PUT')?.body).toEqual({ enabled: true })
    // Turning off is not asked about.
    const off = await h.host.set({ enabled: false })
    expect(off.ok && off.view.status?.enabled).toBe(false)
    expect(h.confirms).toHaveLength(2)
  })

  it('Add a computer returns the device token once, with a notice; the view never holds it', async () => {
    h.daemon.state.enabled = true
    const result = await h.host.addDevice('agent-2 laptop')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.token).toMatch(/^adfd_/)
    expect(result.device.label).toBe('agent-2 laptop')
    expect(JSON.stringify(result.view)).not.toContain(result.token)
    expect(JSON.stringify(h.pushes)).not.toContain(result.token)
    expect(h.notices).toEqual([deviceAddedNotice('agent-2 laptop')])
  })

  it('Revoke confirms first, then removes and says so', async () => {
    h.daemon.state.enabled = true
    h.daemon.state.devices.push(device({ id: 'dev-a', label: 'agent-2 laptop', connected: true }))
    await h.host.get()
    h.setConfirm(false)
    expect((await h.host.removeDevice('dev-a')).ok).toBe(false)
    expect(h.daemon.state.devices).toHaveLength(1)
    expect(h.confirms.at(-1)).toMatchObject({ message: 'Revoke device', detail: '"agent-2 laptop" is disconnected now and its token stops working.' })
    h.setConfirm(true)
    const result = await h.host.removeDevice('dev-a')
    expect(result.ok && result.view.status?.devices).toEqual([])
    expect(h.notices).toEqual([deviceRemovedNotice('agent-2 laptop')])
    // The daemon's own event for the same removal is not a second notice.
    h.host.onDaemonEvent({ type: 'device_revoked', deviceId: 'dev-a', label: 'agent-2 laptop' })
    expect(h.notices).toHaveLength(1)
  })

  it('Pair device: a claim raises "Allow device" once; Allow adds the device with a notice', async () => {
    h.daemon.state.enabled = true
    const opened = await h.host.openPairing()
    expect(opened.ok && opened.view.status?.pairing?.code).toBe('123456')
    // Another computer enters the right code.
    const pairing = new PairingClientShim(h.daemon)
    await pairing.claim('123456', 'agent-2 laptop')
    await until(() => h.asked.length === 1)
    await until(() => h.notices.length === 1)
    expect(h.notices).toEqual([deviceAddedNotice('agent-2 laptop')])
    expect(h.daemon.state.devices.map((d) => d.label)).toEqual(['agent-2 laptop'])
    await tick(40)
    expect(h.asked).toHaveLength(1)
  })

  it('Deny: no device, no notice', async () => {
    h.daemon.state.enabled = true
    h.setClaim(false)
    await h.host.openPairing()
    await new PairingClientShim(h.daemon).claim('123456', 'agent-3 laptop')
    await until(() => h.asked.length === 1)
    await until(() => h.daemon.state.pairing === null)
    expect(h.daemon.state.devices).toEqual([])
    expect(h.notices).toEqual([])
  })

  it('a claim decided elsewhere (the terminal) closes the question unanswered', async () => {
    h.daemon.state.enabled = true
    let aborted = false
    h.host.dispose()
    h = hostSetup({
      askClaim: ({ signal }) => new Promise((resolve) => signal.addEventListener('abort', () => { aborted = true; resolve(null) })),
    })
    h.daemon.state.enabled = true
    await h.host.openPairing()
    await new PairingClientShim(h.daemon).claim('123456', 'agent-2 laptop')
    await until(() => h.daemon.state.pairing?.claim !== null)
    await tick(30)
    h.daemon.decide(true)
    await until(() => aborted)
    expect(h.daemon.requests.some((r) => r.path.startsWith('/remote-access/pairing/claims/'))).toBe(false)
  })

  it('pairing closed by wrong codes is a notice', async () => {
    h.daemon.state.enabled = true
    await h.host.openPairing()
    h.daemon.state.pairing!.attemptsLeft = 2
    const shim = new PairingClientShim(h.daemon)
    for (let i = 0; i < 2; i++) { await shim.claim('000000', 'stranger'); await tick(30) }
    await until(() => h.notices.includes('Pairing closed after too many wrong codes.'))
  })

  it('a source locked out (pairing_lockout) is a notice each time; the window stays open with lockedSources', async () => {
    h.daemon.state.enabled = true
    await h.host.openPairing()
    const shim = new PairingClientShim(h.daemon)
    for (let i = 0; i < 5; i++) await shim.claim('000000', 'stranger')
    expect((await h.host.get()).status?.pairing).toMatchObject({ lockedSources: 1, attemptsLeft: 15 })
    expect((await shim.claim('123456', 'stranger')).status).toBe(429)
    h.host.onDaemonEvent({ type: 'pairing_lockout' })
    h.host.onDaemonEvent({ type: 'pairing_lockout' })
    expect(h.notices.filter((n) => n === 'Pairing: a device was locked out after 5 wrong codes.')).toHaveLength(2)
  })

  it('claim_pending carries nothing: the claim is read from the local status and "Allow device" asked', async () => {
    h.daemon.state.enabled = true
    await h.host.openPairing()
    h.host.dispose()
    // No poll running: only the event can bring the question.
    h = hostSetup({ pollMs: 60_000 })
    h.daemon.state.enabled = true
    h.daemon.state.pairing = { code: '123456', name: 'agent-1-pc', fingerprint: 'ABCD-EFGH', openedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 120_000).toISOString(), attemptsLeft: 20, lockedSources: 0, claim: null }
    await new PairingClientShim(h.daemon).claim('123456', 'agent-2 laptop')
    h.host.onDaemonEvent({ type: 'claim_pending' })
    await until(() => h.asked.length === 1)
    expect(h.asked).toEqual(['agent-2 laptop'])
    expect(h.daemon.requests.some((r) => r.origin === LOOPBACK && r.path === '/remote-access')).toBe(true)
  })

  it('the daemon\'s events: device added elsewhere is a notice, and the view is pushed', async () => {
    h.host.onDaemonEvent({ type: 'device_added', deviceId: 'x1', label: 'agent-4 desktop' })
    await until(() => h.pushes.some((p) => p.notice === null && p.view.status !== null))
    expect(h.notices).toEqual([deviceAddedNotice('agent-4 desktop')])
    expect(h.pushes.some((p) => p.notice === deviceAddedNotice('agent-4 desktop'))).toBe(true)
  })

  it('tailscale serve names the exact command before running it', async () => {
    h.daemon.state.enabled = true
    await h.host.get()
    const result = await h.host.tailscaleServe(true)
    expect(h.confirms.at(-1)?.detail).toContain('tailscale serve --bg 7385')
    expect(result.ok && result.view.status?.tailscale.serve).toBe('on')
  })

  it('counts connected computers for the quit question; none while off', async () => {
    expect(await h.host.connectedCount()).toBe(0)
    h.daemon.state.enabled = true
    h.daemon.state.devices.push(device({ id: 'a', connected: true }), device({ id: 'b', connected: false }), device({ id: 'c', connected: true }))
    expect(await h.host.connectedCount()).toBe(2)
  })

  it('outside local mode every action answers why, and nothing is requested', async () => {
    const other = hostSetup({ daemon: () => ({ unavailable: unavailableReason('remote') }) })
    expect(await other.host.get()).toMatchObject({ available: false, unavailableReason: unavailableReason('remote'), status: null, stopsWithStudio: false })
    expect(await other.host.set({ enabled: true })).toMatchObject({ ok: false, code: 'unavailable' })
    expect(await other.host.addDevice('x')).toMatchObject({ ok: false, code: 'unavailable' })
    expect(other.daemon.requests).toEqual([])
    expect(unavailableReason('embedded')).toContain('This computer')
  })

  it('Allow on this network posts the network id; Remove deletes it; set() has no trustNetwork', async () => {
    h.daemon.state.enabled = true
    h.daemon.state.allowed = []
    const allowed = await h.host.network('allow', 'lan-0123456789abcdef')
    expect(allowed).toMatchObject({ ok: true, view: { status: { allowedNetworks: [{ id: 'lan-0123456789abcdef' }] } } })
    expect(h.daemon.requests.find((r) => r.method === 'POST' && r.path === '/remote-access/networks')?.body).toEqual({ id: 'lan-0123456789abcdef' })
    const removed = await h.host.network('forget', 'lan-0123456789abcdef')
    expect(removed).toMatchObject({ ok: true, view: { status: { allowedNetworks: [] } } })
    expect(h.daemon.requests.some((r) => r.method === 'DELETE' && r.path === '/remote-access/networks/lan-0123456789abcdef')).toBe(true)
    expect(await h.host.network('allow', 'lan-ffffffffffffffff')).toMatchObject({ ok: false, code: 'daemon', error: 'That network is not one this computer is on now.' })
    expect(await h.host.set({ trustNetwork: true } as never)).toMatchObject({ ok: false, error: 'Nothing to change.' })
    expect(h.confirms).toEqual([])
  })

  it('an older daemon (404 not_found): one sentence', async () => {
    h.daemon.state.old = true
    expect((await h.host.get()).error).toBe('This ADF daemon has no remote access. Update ADF, then restart the daemon.')
  })

  it('an older daemon without the routes: one sentence, no crash', async () => {
    const old = hostSetup({
      daemon: () => ({ client: async () => new DaemonClient({ baseUrl: LOOPBACK, fetch: (async () => new Response(JSON.stringify({ message: 'Route GET:/remote-access not found', error: 'Not Found', statusCode: 404 }), { status: 404 })) as typeof fetch }) }),
    })
    expect((await old.host.get()).error).toBe('This ADF daemon has no remote access. Update ADF, then restart the daemon.')
  })
})

/** Another computer's claim against the fake daemon (the client side of §5.4, bare). */
class PairingClientShim {
  constructor(private readonly daemon: FakeRemoteDaemon) {}
  async claim(code: string, deviceName: string): Promise<Response> {
    return this.daemon.fetch(`${LAN}/pair/claim`, { method: 'POST', body: JSON.stringify({ code, deviceName, clientKind: 'studio' }) })
  }
}

// --- Client: pairing ----------------------------------------------------------------

function pairSetup(opts: { tailnet?: { running: boolean; suffix: string | null; peerIps: Set<string>; peerNames: Set<string> }; saveBlocked?: string | null; saveFails?: boolean; useEncrypted?: boolean; savedConnections?: Array<{ name: string; url: string; fingerprint: string | null }>; replace?: boolean } = {}) {
  const daemon = createFakeRemoteDaemon({ loopback: LOOPBACK })
  daemon.state.enabled = true
  daemon.state.pairing = { code: '654321', openedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 120_000).toISOString(), attemptsLeft: 5, claim: null }
  const states: RemotePairState[] = []
  const saved: PairingSaveInput[] = []
  const logs: string[] = []
  const switches: Array<{ from: string; to: string }> = []
  const replaces: string[] = []
  const flow = new PairingFlow({
    savedConnections: () => opts.savedConnections ?? [],
    confirmReplace: async (prompt) => { replaces.push(`${prompt.name}: ${prompt.from} → ${prompt.to}`); return opts.replace ?? true },
    confirmSwitch: async (prompt) => { switches.push({ from: prompt.from, to: prompt.to }); return opts.useEncrypted ?? true },
    tailnetView: async () => opts.tailnet ?? { running: true, suffix: 'tail1234.ts.net', peerIps: new Set(['100.101.102.103']), peerNames: new Set<string>() },
    onState: (s) => states.push(s),
    save: async (input) => { saved.push(input); return opts.saveFails ? { ok: false, error: 'Could not save studio-backend.json.' } : { ok: true, id: 'remote:agent-1-pc' } },
    saveBlocked: () => opts.saveBlocked ?? null,
    defaultDeviceName: () => 'agent-2-laptop',
    fetch: daemon.fetch,
    log: { log: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) },
    retryMs: 5,
  })
  return { daemon, flow, states, saved, logs, switches, replaces, last: () => states.at(-1)! }
}

describe('pairing from Settings → Connection', () => {
  it('hello, the code, the host\'s Allow, then the token is saved for the encrypted address; never returned or logged', async () => {
    const p = pairSetup()
    const started = await p.flow.start({ url: LAN, allowInsecureHttp: true })
    expect(started).toMatchObject({ step: 'need_code', code: null, host: { name: 'agent-1-pc', fingerprint: 'ABCD-EFGH', url: LAN, encrypted: false }, deviceName: 'agent-2-laptop' })
    const waiting = await p.flow.submitCode('654321')
    expect(waiting).toMatchObject({ step: 'waiting', message: 'Waiting for agent-1-pc to allow this device…' })
    expect(p.daemon.state.pairing?.claim?.deviceName).toBe('agent-2-laptop')
    p.daemon.decide(true)
    await until(() => p.last().step === 'paired')
    // The tailnet URL answers hello with the same fingerprint: it is saved instead of plain LAN http (§5.7).
    expect(p.saved).toHaveLength(1)
    expect(p.saved[0]).toMatchObject({ url: TAILNET, allowInsecureHttp: false, fingerprint: 'ABCD-EFGH', name: 'agent-1-pc', label: 'agent-2-laptop' })
    expect(p.saved[0].token).toMatch(/^adfd_/)
    expect(p.last()).toMatchObject({ savedUrl: TAILNET, savedId: 'remote:agent-1-pc', message: 'Paired with agent-1-pc. Its address and token are saved.' })
    const token = p.saved[0].token
    expect(JSON.stringify(p.states)).not.toContain(token)
    expect(JSON.stringify(p.states)).not.toContain('654321')
    expect(p.logs.join('\n')).not.toContain(token)
    expect(p.logs.join('\n')).not.toContain('654321')
  })

  it('switches only to a tailnet address or a *.ts.net https name, and only after asking (security review 2)', async () => {
    // A host-supplied "encrypted" URL elsewhere is ignored, even when it answers with the same fingerprint.
    const p = pairSetup()
    p.daemon.state.urls = [
      { url: 'https://evil.example.com', kind: 'tailscale-https', encrypted: true },
      { url: 'http://192.168.1.99:7385', kind: 'tailnet', encrypted: true },
      { url: TAILNET, kind: 'tailnet', encrypted: true },
    ]
    await p.flow.start({ url: LAN, allowInsecureHttp: true })
    await p.flow.submitCode('654321')
    p.daemon.decide(true)
    await until(() => p.last().step === 'paired')
    expect(p.switches).toEqual([{ from: LAN, to: TAILNET }])
    expect(p.saved[0].url).toBe(TAILNET)
    expect(p.daemon.requests.some((r) => r.origin === 'https://evil.example.com' || r.origin === 'http://192.168.1.99:7385')).toBe(false)

    // Declined: the address the user paired with is kept.
    const q = pairSetup({ useEncrypted: false })
    await q.flow.start({ url: LAN, allowInsecureHttp: true })
    await q.flow.submitCode('654321')
    q.daemon.decide(true)
    await until(() => q.last().step === 'paired')
    expect(q.switches).toHaveLength(1)
    expect(q.saved[0]).toMatchObject({ url: LAN, allowInsecureHttp: true })
  })

  it('the fingerprint the host approves with must be the one hello showed (security review 4)', async () => {
    const p = pairSetup()
    await p.flow.start({ url: TAILNET })
    await p.flow.submitCode('654321')
    p.daemon.state.fingerprint = 'ZZZZ-ZZZZ'
    p.daemon.decide(true)
    await until(() => p.last().step === 'failed')
    expect(p.last()).toMatchObject({ code: 'fingerprint_mismatch' })
    expect(p.last().message).toContain('ZZZZ-ZZZZ')
    expect(p.saved).toEqual([])
  })

  it('a saved connection\'s pinned fingerprint (trust on first use): another one at its address is refused (security review 4)', async () => {
    const p = pairSetup({ savedConnections: [{ name: 'rawl-hub', url: TAILNET, fingerprint: 'QQQQ-QQQQ' }] })
    expect(await p.flow.start({ url: TAILNET })).toMatchObject({ step: 'failed', code: 'fingerprint_mismatch' })
    expect(p.last().message).toBe('100.101.102.103 now answers with fingerprint ABCD-EFGH, not QQQQ-QQQQ as when rawl-hub was paired. Studio sent nothing. If that computer was set up again, remove rawl-hub in Settings → Connection first.')
    expect(p.replaces).toEqual([])
    expect(p.daemon.requests.some((r) => r.path === '/pair/claim')).toBe(false)
  })

  it('a saved connection is never moved to another address without asking (security review 4); other saved connections are not touched', async () => {
    const saved = [{ name: 'agent-1-pc', url: 'https://adf.example.com', fingerprint: 'ABCD-EFGH' }]
    const kept = pairSetup({ savedConnections: saved, replace: false })
    expect(await kept.flow.start({ url: TAILNET })).toMatchObject({ step: 'failed', code: 'kept', message: 'Kept the saved address of agent-1-pc. Nothing was sent.' })
    expect(kept.replaces).toEqual([`agent-1-pc: https://adf.example.com → ${TAILNET}`])
    expect(kept.daemon.requests.some((r) => r.path === '/pair/claim')).toBe(false)

    const replaced = pairSetup({ savedConnections: saved, replace: true })
    await replaced.flow.start({ url: TAILNET })
    await replaced.flow.submitCode('654321')
    replaced.daemon.decide(true)
    await until(() => replaced.last().step === 'paired')
    expect(replaced.replaces).toHaveLength(1)
    expect(replaced.saved).toHaveLength(1)

    // Another computer saved (another fingerprint, another address): a new connection, no question.
    const other = pairSetup({ savedConnections: [{ name: 'rawl-hub', url: 'https://hub.example.com', fingerprint: 'QQQQ-QQQQ' }, { name: 'legacy', url: 'https://old.example.com', fingerprint: null }] })
    expect(await other.flow.start({ url: TAILNET })).toMatchObject({ step: 'need_code' })
    expect(other.replaces).toEqual([])
  })

  it('re-review 3: only this tailnet\'s ts.net names and Tailscale peers qualify; without Tailscale nothing switches', async () => {
    const offered = [
      { url: 'https://evil.ts.net', kind: 'tailscale-https' as const, encrypted: true },
      { url: 'https://agent-1-pc.other9999.ts.net', kind: 'tailscale-https' as const, encrypted: true },
      { url: 'http://100.64.9.9:7385', kind: 'tailnet' as const, encrypted: true },
    ]
    const p = pairSetup()
    p.daemon.state.urls = offered
    await p.flow.start({ url: LAN, allowInsecureHttp: true })
    await p.flow.submitCode('654321')
    p.daemon.decide(true)
    await until(() => p.last().step === 'paired')
    expect(p.switches).toEqual([])
    expect(p.saved[0].url).toBe(LAN)

    // This tailnet's own name qualifies.
    const own = pairSetup()
    own.daemon.state.urls = [...offered, { url: 'https://agent-1-pc.tail1234.ts.net', kind: 'tailscale-https', encrypted: true }]
    await own.flow.start({ url: LAN, allowInsecureHttp: true })
    await own.flow.submitCode('654321')
    own.daemon.decide(true)
    await until(() => own.last().step === 'paired')
    expect(own.saved[0].url).toBe('https://agent-1-pc.tail1234.ts.net')

    // Without Tailscale: not even a tailnet address the host lists.
    const none = pairSetup({ tailnet: { running: false, suffix: null, peerIps: new Set(['100.101.102.103']), peerNames: new Set() } })
    await none.flow.start({ url: LAN, allowInsecureHttp: true })
    await none.flow.submitCode('654321')
    none.daemon.decide(true)
    await until(() => none.last().step === 'paired')
    expect(none.switches).toEqual([])
    expect(none.saved[0].url).toBe(LAN)
  })

  it('keeps plain LAN http, with its confirmation, when no encrypted address answers', async () => {
    const p = pairSetup()
    p.daemon.state.unreachable.add(TAILNET)
    await p.flow.start({ url: LAN, allowInsecureHttp: true })
    await p.flow.submitCode('654321')
    p.daemon.decide(true)
    await until(() => p.last().step === 'paired')
    expect(p.saved[0]).toMatchObject({ url: LAN, allowInsecureHttp: true })
  })

  it('plain LAN http needs "I trust this network" before anything is sent', async () => {
    const p = pairSetup()
    expect(await p.flow.start({ url: LAN })).toMatchObject({ step: 'failed', code: 'insecure_unconfirmed' })
    expect(p.daemon.requests).toEqual([])
  })

  it('wrong code: tries left, then "no tries are left"', async () => {
    const p = pairSetup()
    await p.flow.start({ url: TAILNET })
    expect(await p.flow.submitCode('111111')).toMatchObject({ step: 'need_code', code: 'wrong_code', attemptsLeft: 4, message: 'Wrong code. 4 tries left.' })
    p.daemon.state.pairing!.attemptsLeft = 1
    expect(await p.flow.submitCode('222222')).toMatchObject({ step: 'failed', code: 'attempts_used', message: 'Wrong code, and no tries are left. Choose Add device on agent-1-pc for a new code.' })
  })

  it('collects the token with the collect secret from the 202; the claim id alone gets nothing, and the secret is never pushed or logged', async () => {
    const p = pairSetup()
    await p.flow.start({ url: TAILNET })
    await p.flow.submitCode('654321')
    p.daemon.decide(true)
    await until(() => p.last().step === 'paired')
    const polls = p.daemon.requests.filter((r) => r.path.startsWith('/pair/claims/'))
    expect(polls.length).toBeGreaterThan(0)
    const secret = polls[0].headers['X-ADF-Pair-Secret']
    expect(secret).toMatch(/^secret-/)
    expect(JSON.stringify(p.states)).not.toContain(secret)
    expect(p.logs.join('\n')).not.toContain(secret)
    // Without the secret the fake daemon (like the real one) answers claim_not_found.
    const bare = await p.daemon.fetch(`${TAILNET}${polls[0].path}`)
    expect(bare.status).toBe(404)
  })

  it('a device locked out of the window (5 wrong codes) is told so plainly', async () => {
    const p = pairSetup()
    p.daemon.state.pairing!.attemptsLeft = 20
    await p.flow.start({ url: TAILNET })
    for (let i = 0; i < 4; i++) await p.flow.submitCode('111111')
    expect(await p.flow.submitCode('111111')).toMatchObject({ step: 'failed', code: 'attempts_used' })
    await p.flow.start({ url: TAILNET })
    expect(await p.flow.submitCode('654321')).toMatchObject({ step: 'need_code', code: 'rate_limited', message: 'Too many wrong codes from this computer for this pairing window. Ask the host to open a new one.' })
  })

  it('a malformed code is refused here', async () => {
    const p = pairSetup()
    await p.flow.start({ url: TAILNET })
    const before = p.daemon.requests.length
    expect(await p.flow.submitCode('12ab')).toMatchObject({ step: 'need_code', code: 'bad_request', message: 'Enter the 6-digit code shown on agent-1-pc.' })
    expect(p.daemon.requests.length).toBe(before)
  })

  it('window closed', async () => {
    const p = pairSetup()
    await p.flow.start({ url: TAILNET })
    p.daemon.state.pairing = null
    expect(await p.flow.submitCode('654321')).toMatchObject({ step: 'failed', code: 'window_closed', message: 'The pairing window on agent-1-pc is closed. Choose Add device there for a new code.' })
  })

  it('host refused', async () => {
    const p = pairSetup()
    await p.flow.start({ url: TAILNET })
    await p.flow.submitCode('654321')
    p.daemon.decide(false)
    await until(() => p.last().step === 'failed')
    expect(p.last()).toMatchObject({ code: 'denied', message: 'agent-1-pc denied this device.' })
    expect(p.saved).toEqual([])
  })

  it('firewall: a LAN address that does not answer says the port may be blocked', async () => {
    const p = pairSetup()
    p.daemon.state.unreachable.add(LAN)
    expect(await p.flow.start({ url: LAN, allowInsecureHttp: true })).toMatchObject({
      step: 'failed', code: 'firewall', message: 'Studio could not reach 192.168.1.20 at http://192.168.1.20:7385. The host\'s firewall may block port 7385.',
    })
  })

  it('an older ADF on the host (hello answers 401) says to update it', async () => {
    const p = pairSetup()
    p.daemon.state.old = true
    expect(await p.flow.start({ url: TAILNET })).toMatchObject({ step: 'failed', code: 'old_daemon', message: '100.101.102.103 runs an older ADF. Update ADF there, then pair again.' })
  })

  it('remote access off on the host', async () => {
    const p = pairSetup()
    p.daemon.state.enabled = false
    expect(await p.flow.start({ url: TAILNET })).toMatchObject({ step: 'failed', code: 'remote_access_off' })
  })

  it('no OS keychain: refused before the code is sent, so no device is created for nothing', async () => {
    const p = pairSetup({ saveBlocked: 'No OS keyring is available.' })
    expect(await p.flow.start({ url: TAILNET })).toMatchObject({ step: 'failed', code: 'encryption_unavailable', message: 'No OS keyring is available.' })
    expect(p.daemon.requests).toEqual([])
  })

  it('a save that fails names the device to remove on the host', async () => {
    const p = pairSetup({ saveFails: true })
    await p.flow.start({ url: TAILNET })
    await p.flow.submitCode('654321')
    p.daemon.decide(true)
    await until(() => p.last().step === 'failed')
    expect(p.last()).toMatchObject({ code: 'save_failed' })
    expect(p.last().message).toContain('Remove "agent-2-laptop" on agent-1-pc and pair again.')
  })

  it('Cancel stops the wait', async () => {
    const p = pairSetup()
    await p.flow.start({ url: TAILNET })
    await p.flow.submitCode('654321')
    expect(p.flow.cancel()).toMatchObject({ step: 'cancelled' })
    p.daemon.decide(true)
    await tick(30)
    expect(p.saved).toEqual([])
  })

  it('re-review 4: a device name with an invisible filler, a tag character or a soft hyphen is refused here, and shown escaped in Allow device', async () => {
    for (const c of ['\u180E', '\u034F', '\u{E0001}', '\u{E0041}', '\u{E007F}', '\u2060', '\u2061', '\u2062', '\u2063', '\u2064', '\u3164', '\u115F', '\uFFA0', '\u00AD']) {
      const p = pairSetup()
      expect(await p.flow.start({ url: TAILNET, deviceName: `agent${c}-2` }), c.codePointAt(0)!.toString(16)).toMatchObject({ step: 'failed', code: 'bad_request' })
      const q = claimQuestion({ claimId: 'c', deviceName: `agent${c}-2`, clientKind: 'studio', address: '192.168.1.31', via: 'lan', tailnetLogin: null, at: '' })
      expect(q.detail.split('\n')[1]).not.toContain(c)
    }
  })

  it('a device name with control characters is refused', async () => {
    const p = pairSetup()
    expect(await p.flow.start({ url: TAILNET, deviceName: 'agent‮-2' })).toMatchObject({ step: 'failed', code: 'bad_request' })
  })
})

// --- Client: discovery ------------------------------------------------------------

describe('Discovered (discovery): a view of the one discovery feed', () => {
  class FakeFeed implements PeerFeed {
    list: NetworkPeer[] = []
    waits: number[] = []
    trouble: string | null = null
    released = 0
    private listeners = new Set<() => void>()
    async peers(opts: { waitMs?: number } = {}): Promise<NetworkPeer[]> { this.waits.push(opts.waitMs ?? 0); return this.list }
    subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
    problem(): string | null { return this.trouble }
    release(): void { this.released++ }
    changed(): void { for (const l of this.listeners) l() }
  }
  const peer = (over: Partial<NetworkPeer> = {}, remote: Partial<NonNullable<NetworkPeer['remote']>> | null = {}): NetworkPeer => ({
    key: 'peer-1', name: 'agent-1-pc', source: 'mdns', mesh: null,
    remote: remote === null ? null : { url: LAN, port: 7385, fingerprint: 'ABCD-EFGH', pairingOpen: false, kind: 'lan', clash: null, ...remote },
    ...over,
  })
  function setup(feed: FakeFeed | null = new FakeFeed()) {
    const updates: RemoteDiscoveryUpdate[] = []
    const paired = new Set<string>()
    let own: string | null = null
    const discovery = new RemoteDiscovery({
      feed: () => feed,
      onUpdate: (u) => updates.push(u),
      pairedFingerprints: () => paired,
      ownFingerprint: () => own,
      pollMs: 60_000,
      log: quiet,
    })
    return { feed, discovery, updates, setPaired: (fp: string) => { paired.add(fp) }, setOwn: (fp: string) => { own = fp } }
  }

  it('lists the feed\'s entries with remote access; pairing open is "ready to pair"; a peers_changed re-reads; stop releases the feed', async () => {
    const d = setup()
    d.feed!.list = [peer({}, { pairingOpen: true }), peer({ key: 'mesh-only', name: 'mesh-only', mesh: { url: 'http://192.168.1.9:7295', port: 7295 } }, null)]
    d.discovery.start()
    await until(() => (d.updates.at(-1)?.entries.length ?? 0) === 1)
    expect(d.updates.at(-1)).toEqual({ browsing: true, problem: null, entries: [{ fingerprint: 'ABCD-EFGH', name: 'agent-1-pc', url: LAN, address: '192.168.1.20', kind: 'lan', encrypted: false, pairingOpen: true, alreadyPaired: false, clash: null }] })
    // The first read waits a moment for a fresh browser's answers.
    expect(d.feed!.waits[0]).toBeGreaterThan(0)
    d.feed!.list = []
    d.feed!.changed()
    await until(() => d.updates.at(-1)?.entries.length === 0)
    d.discovery.stop()
    expect(d.feed!.released).toBe(1)
  })

  it('discovery review 3: one fingerprint at two addresses lists both, flagged', async () => {
    const d = setup()
    d.feed!.list = [peer({ key: 'fp:ABCD-EFGH@192.168.1.20' }, { clash: 2 }), peer({ key: 'fp:ABCD-EFGH@192.168.1.66', name: 'impostor' }, { url: 'http://192.168.1.66:7385', clash: 2 })]
    d.discovery.start()
    await until(() => (d.updates.at(-1)?.entries.length ?? 0) === 2)
    expect(d.updates.at(-1)?.entries.map((e) => [e.name, e.address, e.clash])).toEqual([['agent-1-pc', '192.168.1.20', 2], ['impostor', '192.168.1.66', 2]])
    d.discovery.stop()
  })

  it('a tailnet sighting is encrypted and listed before LAN ones', async () => {
    const d = setup()
    d.feed!.list = [peer({ key: 'b', name: 'b-lan' }, { fingerprint: 'BBBB-BBBB' }), peer({ key: 'a', name: 'z-tailnet' }, { url: TAILNET, kind: 'tailnet' })]
    d.discovery.start()
    await until(() => (d.updates.at(-1)?.entries.length ?? 0) === 2)
    expect(d.updates.at(-1)?.entries.map((e) => [e.name, e.kind, e.encrypted])).toEqual([['z-tailnet', 'tailnet', true], ['b-lan', 'lan', false]])
    d.discovery.stop()
  })

  it('marks every saved connection "paired" and leaves out this computer\'s own daemon; snapshot() is the last list while running', async () => {
    const d = setup()
    d.setPaired('ABCD-EFGH')
    d.setPaired('BBBB-BBBB')
    d.setOwn('SELF-2345')
    d.feed!.list = [peer(), peer({ key: 'b', name: 'b' }, { fingerprint: 'BBBB-BBBB', url: 'http://192.168.1.6:7385' }), peer({ key: 'c', name: 'c' }, { fingerprint: 'CCCC-CCCC', url: 'http://192.168.1.7:7385' }), peer({ key: 'self', name: 'self' }, { fingerprint: 'SELF-2345', url: 'http://192.168.1.5:7385' })]
    expect(d.discovery.snapshot()).toBeNull()
    d.discovery.start()
    await until(() => (d.updates.at(-1)?.entries.length ?? 0) === 3)
    expect(d.updates.at(-1)?.entries.map((e) => [e.fingerprint, e.alreadyPaired])).toEqual([['ABCD-EFGH', true], ['BBBB-BBBB', true], ['CCCC-CCCC', false]])
    expect(d.discovery.snapshot()).toEqual(d.updates.at(-1))
    d.discovery.stop()
    expect(d.discovery.snapshot()).toBeNull()
  })

  it('without a feed (the daemon not connected yet) or without mDNS it says so', async () => {
    const none = setup(null)
    none.discovery.start()
    expect(none.updates[0]).toMatchObject({ browsing: false, entries: [], problem: 'Studio is not connected to the ADF daemon yet.' })
    none.discovery.stop()
    const feed = new FakeFeed()
    feed.trouble = 'mDNS is not available here. Tailnet computers are still listed; or enter an address.'
    feed.list = [peer({}, { url: TAILNET, kind: 'tailnet' })]
    const d = setup(feed)
    d.discovery.start()
    await until(() => (d.updates.at(-1)?.entries.length ?? 0) === 1)
    expect(d.updates.at(-1)).toMatchObject({ browsing: false, problem: expect.stringContaining('mDNS') })
    d.discovery.stop()
  })

  it('local mode reads the daemon\'s feed (GET /network/peers) and re-reads on its peers_changed push', async () => {
    const requests: string[] = []
    let peers: NetworkPeer[] = [peer()]
    const feed = new DaemonPeerFeed(async (path) => { requests.push(path); return { peers } })
    expect(await feed.peers({ waitMs: 2_000 })).toEqual(peers)
    expect(requests).toEqual(['/network/peers?wait=2000'])
    const seen: number[] = []
    const off = feed.subscribe(() => seen.push(1))
    peers = []
    feed.changed()
    expect(seen).toEqual([1])
    off()
    expect(await feed.peers()).toEqual([])
    expect(requests.at(-1)).toBe('/network/peers')
  })
})

// --- Quit question -----------------------------------------------------------------

describe('quit while computers are connected (owner decision 5)', () => {
  function gate(opts: { wouldStop?: boolean; count?: number | null; answers?: Array<'keep' | 'stop' | 'cancel'>; countFails?: boolean }) {
    const asked: Array<number | null> = []
    const answers = [...(opts.answers ?? [])]
    const g = new RemoteQuitGate({
      daemonWouldStop: () => opts.wouldStop ?? true,
      connectedCount: async () => { if (opts.countFails) throw new Error('no answer'); return opts.count === undefined ? 2 : opts.count },
      ask: async (n) => { asked.push(n); return answers.shift() ?? 'stop' },
      log: { log: () => {} },
    })
    return { g, asked }
  }

  it('the question names the count and both choices', () => {
    expect(quitQuestion(2)).toMatchObject({ title: 'Quit', message: '2 devices connected' })
    expect(quitQuestion(2).detail).toMatch(/^Keep the daemon running for them, or stop it\./)
    expect(quitQuestion(1).message).toBe('1 device connected')
    expect(quitQuestion(2).buttons).toEqual(['Keep running', 'Stop daemon', 'Cancel'])
  })

  it('no question when the daemon keeps running anyway', () => {
    const { g, asked } = gate({ wouldStop: false })
    expect(g.hold(() => {})).toBe(true)
    expect(asked).toEqual([])
  })

  it('a count that cannot be read still asks, with a generic question (security review 5)', async () => {
    for (const opts of [{ count: null }, { countFails: true }]) {
      const { g, asked } = gate({ ...opts, answers: ['keep'] })
      let resumed = false
      expect(g.hold(() => { resumed = true })).toBe(false)
      await until(() => resumed)
      expect(asked).toEqual([null])
      expect(g.keepDaemonForThisQuit).toBe(true)
    }
    expect(quitQuestion(null)).toMatchObject({ title: 'Quit', message: 'Devices may be connected' })
    expect(quitQuestion(null).buttons).toEqual(['Keep running', 'Stop daemon', 'Cancel'])
  })

  it('an older daemon without remote access counts as nobody connected', async () => {
    const h = hostSetup()
    h.daemon.state.old = true
    expect(await h.host.connectedCount()).toBe(0)
    h.host.dispose()
  })

  it('no question when nobody is connected', async () => {
    for (const count of [0]) {
      const { g, asked } = gate({ count })
      let resumed = false
      expect(g.hold(() => { resumed = true })).toBe(false)
      await until(() => resumed)
      expect(asked).toEqual([])
      expect(g.keepDaemonForThisQuit).toBe(false)
    }
  })

  it('asks every time: Cancel keeps Studio open and the next quit asks again; Keep running is for this quit only', async () => {
    const { g, asked } = gate({ answers: ['cancel', 'keep'] })
    let resumed = 0
    expect(g.hold(() => { resumed++ })).toBe(false)
    // A second quit request while the question is up is held too, not asked twice.
    expect(g.hold(() => { resumed++ })).toBe(false)
    await until(() => asked.length === 1)
    await tick(5)
    expect(resumed).toBe(0)
    expect(g.keepDaemonForThisQuit).toBe(false)
    expect(g.hold(() => { resumed++ })).toBe(false)
    await until(() => resumed === 1)
    expect(asked).toEqual([2, 2])
    expect(g.keepDaemonForThisQuit).toBe(true)
    expect(g.hold(() => {})).toBe(true)
  })

  it('Stop Daemon quits as configured', async () => {
    const { g } = gate({ answers: ['stop'] })
    let resumed = false
    g.hold(() => { resumed = true })
    await until(() => resumed)
    expect(g.keepDaemonForThisQuit).toBe(false)
  })
})

// --- IPC registration and the saved pairing ---------------------------------------------

describe('IPC (registered in every mode) and the saved pairing', () => {
  const dirs: string[] = []
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

  function store(codec = fakeCodec()) {
    const dir = mkdtempSync(join(tmpdir(), 'adf-remote-access-'))
    dirs.push(dir)
    const path = join(dir, 'studio-backend.json')
    writeFileSync(path, JSON.stringify({ v: 1, mode: 'local' }))
    return { path, store: createBackendSettingsStore({ boot: resolveBootBackend(path, {}, quiet), codec, log: quiet }) }
  }

  it('registers every remote-access channel; the host answers "unavailable" in embedded mode; pairing saves the connection where adf pair does (cli-remotes.json, the keychain)', async () => {
    electronStub.handlers.clear()
    electronStub.pushes.length = 0
    const daemon = createFakeRemoteDaemon({ loopback: LOOPBACK })
    daemon.state.enabled = true
    daemon.state.pairing = { code: '654321', openedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 120_000).toISOString(), attemptsLeft: 5, claim: null }
    const s = store()
    const settingsDir = mkdtempSync(join(tmpdir(), 'adf-remotes-'))
    dirs.push(settingsDir)
    const env = { ...process.env, ADF_DAEMON_SETTINGS: join(settingsDir, 'adf-settings.json'), ADF_TEST_KEYCHAIN_FILE: join(settingsDir, 'keychain.json'), ADF_TEST_SEAMS: '1' }
    let changes = 0
    const ipc = registerRemoteAccessHandlers({
      mode: 'embedded', daemon: () => null, backend: s.store, codec: fakeCodec(), window: () => null, keepDaemonRunning: () => false,
      remotesEnv: env, onConnectionsChanged: () => { changes++ },
      overrides: { discovery: { feed: () => null }, pairing: { fetch: daemon.fetch, retryMs: 5 } },
      log: quiet,
    })
    for (const channel of [IPC.REMOTE_ACCESS_GET, IPC.REMOTE_ACCESS_SET, IPC.REMOTE_ACCESS_DEVICE_ADD, IPC.REMOTE_ACCESS_DEVICE_REMOVE, IPC.REMOTE_ACCESS_PAIRING_OPEN, IPC.REMOTE_ACCESS_PAIRING_CLOSE, IPC.REMOTE_ACCESS_TAILSCALE_SERVE, IPC.REMOTE_DISCOVERY_START, IPC.REMOTE_DISCOVERY_STOP, IPC.REMOTE_PAIR_START, IPC.REMOTE_PAIR_SUBMIT_CODE, IPC.REMOTE_PAIR_CANCEL]) {
      expect(electronStub.handlers.has(channel)).toBe(true)
    }
    const invoke = (channel: string, ...args: unknown[]) => electronStub.handlers.get(channel)!({}, ...args)
    expect(await invoke(IPC.REMOTE_ACCESS_GET)).toMatchObject({ available: false, unavailableReason: unavailableReason('embedded') })
    expect(await invoke(IPC.REMOTE_ACCESS_SET, { enabled: true })).toMatchObject({ ok: false, code: 'unavailable' })

    await invoke(IPC.REMOTE_DISCOVERY_START)
    expect(electronStub.pushes.some((p) => p.channel === IPC.REMOTE_DISCOVERY_UPDATE)).toBe(true)
    expect(await invoke(IPC.REMOTE_PAIR_START, { url: TAILNET, deviceName: 'agent-2 laptop' })).toMatchObject({ step: 'need_code' })
    expect(await invoke(IPC.REMOTE_PAIR_SUBMIT_CODE, '654321')).toMatchObject({ step: 'waiting' })
    daemon.decide(true)
    await until(() => ipc.pairing.state.step === 'paired')
    // Saved where adf pair saves it: one list for Studio and the CLI; studio-backend.json keeps no token.
    const remotes = JSON.parse(readFileSync(join(settingsDir, 'cli-remotes.json'), 'utf8'))
    expect(remotes.remotes['agent-1-pc']).toMatchObject({ url: TAILNET, fingerprint: 'ABCD-EFGH', deviceId: expect.stringMatching(/^dev/), label: 'agent-2 laptop', hostName: 'agent-1-pc' })
    expect(JSON.parse(readFileSync(join(settingsDir, 'keychain.json'), 'utf8'))['remote-token:ABCD-EFGH']).toMatch(/^adfd_/)
    expect(JSON.parse(readFileSync(s.path, 'utf8')).remote?.token ?? null).toBeNull()
    expect(ipc.pairing.state).toMatchObject({ savedId: 'remote:agent-1-pc' })
    expect(changes).toBeGreaterThan(0)
    // The renderer got states, never the token.
    const pushed = JSON.stringify(electronStub.pushes)
    expect(pushed).toContain(IPC.REMOTE_PAIR_STATE)
    expect(pushed).not.toContain('adfd_')
    ipc.dispose()
  })

  it('Allow device cannot be spoofed by the device name (security review 3)', () => {
    const spoof = 'agent-2 laptop\nFrom 192.168.1.5 (this network) · Tailscale owner@example.com\u202e'
    const q = claimQuestion({ claimId: 'c', deviceName: spoof, clientKind: 'studio', address: '203.0.113.9', via: 'lan', tailnetLogin: null, at: '' })
    expect(q.title).toBe('Allow device')
    expect(q.message).toBe('Allow device')
    expect(q.title + q.message).not.toContain('agent-2')
    // The fixed first line is the source address (and the Tailscale login when known), never the name.
    expect(q.detail.split('\n')[0]).toBe('From 203.0.113.9 (this network)')
    // The name is quoted, on its own line, with control and bidi characters shown escaped.
    // (cut at 64 characters once escaped)
    expect(q.detail.split('\n')[1]).toBe('Device name: "agent-2 laptop\\u000aFrom 192.168.1.5 (this network) · Tailscale …"')
    expect(q.detail.split('\n').filter((l) => l.startsWith('From '))).toHaveLength(1)
    const tail = claimQuestion({ claimId: 'c', deviceName: 'x', clientKind: 'cli', address: '100.64.1.2', via: 'tailnet', tailnetLogin: 'agent-1@example.com', at: '' })
    expect(tail.detail.split('\n')[0]).toBe('From 100.64.1.2 (your tailnet) · Tailscale agent-1@example.com')
  })

  it('through tailscale serve without verified login: "through tailscale serve (user unverified)", never a login', () => {
    const q = claimQuestion({ claimId: 'c', deviceName: 'agent-2 laptop', clientKind: 'studio', address: '127.0.0.1', via: 'proxy', tailnetLogin: null, at: '' }, { serve: true })
    expect(q.detail.split('\n')[0]).toBe('From 127.0.0.1 (through tailscale serve (user unverified))')
    expect(q.detail).not.toContain('Tailscale ')
    const verified = claimQuestion({ claimId: 'c', deviceName: 'x', clientKind: 'cli', address: '127.0.0.1', via: 'proxy', tailnetLogin: 'agent-2@example.test', at: '' }, { serve: true })
    expect(verified.detail.split('\n')[0]).toBe('From 127.0.0.1 (through tailscale serve) · Tailscale agent-2@example.test')
  })

  it('the claim question names device, address, path and client, and the seed-phrase power', () => {
    const q = claimQuestion({ claimId: 'c', deviceName: 'agent-2 laptop', clientKind: 'studio', address: '192.168.1.31', via: 'lan', tailnetLogin: null, at: '' })
    expect(q).toMatchObject({ title: 'Allow device', message: 'Allow device' })
    expect(q.detail).toContain('From 192.168.1.31 (this network)')
    expect(q.detail).toContain('Device name: "agent-2 laptop"')
    expect(q.detail).toContain('Client: ADF Studio')
    expect(q.detail).toContain('as powerful as your seed phrase')
    expect(claimQuestion({ claimId: 'c', deviceName: 'x', clientKind: 'cli', address: '100.64.1.2', via: 'tailnet', tailnetLogin: 'agent-1@example.com', at: '' }).detail).toContain('Tailscale agent-1@example.com')
  })

  it('remote.paired belongs to the token: a pasted token or another address drops it; a bad record is ignored', () => {
    const codec = fakeCodec()
    const base = defaultBackendConfig()
    const paired = { fingerprint: 'ABCD-EFGH', name: 'agent-1-pc', deviceId: 'dev1', label: 'agent-2 laptop' }
    const saved = applyBackendPatch(base, { remoteUrl: TAILNET, remoteToken: 'adfd_dev1_' + 's'.repeat(43) }, { codec, paired })
    expect(saved.ok && saved.config.remote.paired).toEqual(paired)
    if (!saved.ok) return
    const pasted = applyBackendPatch(saved.config, { remoteToken: 't'.repeat(43) }, { codec })
    expect(pasted.ok && pasted.config.remote.paired).toBeUndefined()
    const moved = applyBackendPatch(saved.config, { remoteUrl: 'https://adf.example.com' }, { codec })
    expect(moved.ok && moved.config.remote.paired).toBeUndefined()
    const cleared = applyBackendPatch(saved.config, { clearRemoteToken: true }, { codec })
    expect(cleared.ok && cleared.config.remote.paired).toBeUndefined()
    const kept = applyBackendPatch(saved.config, { keepDaemonRunning: true }, { codec })
    expect(kept.ok && kept.config.remote.paired).toEqual(paired)
    expect(normalizeBackendConfig({ mode: 'remote', remote: { url: TAILNET, token: 'safe:x', paired } }).config.remote.paired).toEqual(paired)
    expect(normalizeBackendConfig({ mode: 'remote', remote: { url: TAILNET, token: 'safe:x', paired: { fingerprint: 1 } } }).config.remote.paired).toBeUndefined()
    // The renderer's patch cannot set it: `paired` is not a patch field.
    const sneaky = applyBackendPatch(base, { remoteUrl: TAILNET, remoteToken: 'x'.repeat(43), paired } as never, { codec })
    expect(sneaky.ok && sneaky.config.remote.paired).toBeUndefined()
  })
})

describe('one name and the Networking status line', () => {
  const dirs: string[] = []
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

  it('this device\'s name for pairing is the runtime alias, else the host name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-runtime-name-'))
    dirs.push(dir)
    expect(runtimeName(dir)).toBe(hostname())
    writeFileSync(join(dir, 'adf-settings.json'), JSON.stringify({ runtimeAlias: '  agent-2 laptop ' }))
    expect(runtimeName(dir)).toBe('agent-2 laptop')
    writeFileSync(join(dir, 'adf-settings.json'), JSON.stringify({ runtimeAlias: 'evil\u202e' }))
    expect(runtimeName(dir)).toBe(hostname())
  })

  it('the status line view: the networks, each allowed or not, and the allowed list', () => {
    const lan: NetworkView = { id: 'lan-0123456789abcdef', kind: 'lan', label: 'Wi-Fi (192.168.1.0/24)', allowed: false, osCategory: 'public', ifaces: ['Wi-Fi'], addresses: ['192.168.1.20'] }
    const snapshot = {
      addresses: [
        { address: '100.101.102.103', family: 'IPv4' as const, kind: 'tailnet' as const, iface: 'Tailscale', networkId: 'tailnet-0123456789abcdef', refusal: null },
        { address: '192.168.1.20', family: 'IPv4' as const, kind: 'lan' as const, iface: 'Wi-Fi', networkId: lan.id, refusal: 'Not allowed on this network.' },
      ],
      listenable: ['100.101.102.103'], networks: [lan], tailscale: 'running' as const,
    }
    const allowedTailnet = [{ id: 'tailnet-0123456789abcdef', kind: 'tailnet' as const, label: 'Tailnet tail1234.ts.net', addedAt: '2026-10-18T00:00:00Z' }]
    expect(networkStatusView(snapshot, { state: 'ok', message: '', commands: [] }, allowedTailnet)).toEqual({
      available: true, lan: [{ address: '192.168.1.20', iface: 'Wi-Fi', allowed: false }], networks: [lan], allowedNetworks: allowedTailnet,
      tailscale: 'running', tailnetAddress: '100.101.102.103', firewall: { state: 'ok', message: '' },
    })
  })

  it('NETWORK_STATUS_GET reads this computer\'s network; remote mode answers available: false', async () => {
    electronStub.handlers.clear()
    const dir = mkdtempSync(join(tmpdir(), 'adf-netstatus-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'studio-backend.json'), JSON.stringify({ v: 1, mode: 'local' }))
    const store = createBackendSettingsStore({ boot: resolveBootBackend(join(dir, 'studio-backend.json'), {}, quiet), codec: fakeCodec(), log: quiet })
    const home: NetworkView = { id: 'lan-0123456789abcdef', kind: 'lan', label: 'Wi-Fi (192.168.1.0/24)', allowed: true, osCategory: 'private', ifaces: ['Wi-Fi'], addresses: ['192.168.1.20'] }
    writeFileSync(join(dir, 'remote-access.json'), JSON.stringify({ v: 1, enabled: false, name: 'h', daemonId: null, allowedNetworks: [{ id: home.id, kind: 'lan', label: home.label, addedAt: '2026-10-18T00:00:00Z' }] }))
    const reach = { snapshot: async () => ({ addresses: [{ address: '192.168.1.20', family: 'IPv4', kind: 'lan', iface: 'Wi-Fi', networkId: home.id, refusal: null }], listenable: ['192.168.1.20'], networks: [home], tailscale: 'absent' }) } as unknown as LanReach
    const ipc = registerRemoteAccessHandlers({
      mode: 'embedded', daemon: () => null, backend: store, codec: fakeCodec(), window: () => null, keepDaemonRunning: () => false, settingsDir: dir,
      overrides: { reach, firewall: async () => ({ state: 'ok', message: 'fine', commands: [] }), platform: 'win32', discovery: { feed: () => null } },
      log: quiet,
    })
    const view = await electronStub.handlers.get(IPC.NETWORK_STATUS_GET)!({})
    expect(view).toMatchObject({ available: true, lan: [{ address: '192.168.1.20', iface: 'Wi-Fi', allowed: true }], networks: [home], allowedNetworks: [{ id: home.id }], tailscale: 'absent', firewall: { state: 'ok' } })
    ipc.dispose()
    electronStub.handlers.clear()
    const remote = registerRemoteAccessHandlers({ mode: 'remote', daemon: () => null, backend: store, codec: fakeCodec(), window: () => null, keepDaemonRunning: () => false, overrides: { reach }, log: quiet })
    expect(await electronStub.handlers.get(IPC.NETWORK_STATUS_GET)!({})).toMatchObject({ available: false })
    remote.dispose()
  })
})

describe('consent per network in Studio (owner decision 2026-10-18 b)', () => {
  const dirs: string[] = []
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
  const net = (over: Partial<NetworkView> = {}): NetworkView => ({ id: 'lan-0123456789abcdef', kind: 'lan', label: 'Cafe (10.0.0.0/24)', allowed: false, osCategory: 'unknown', ifaces: ['Wi-Fi'], addresses: ['10.0.0.5'], ...over })

  it('the notice: "Remote access paused on <network>." with Allow on this network; the warning only on a LAN not reported Private', () => {
    expect(networkQuestion(net())).toMatchObject({ key: 'lan-0123456789abcdef', networkId: 'lan-0123456789abcdef', message: 'Remote access paused on Cafe (10.0.0.0/24).', canAllow: true, warning: PUBLIC_WARNING })
    expect(PUBLIC_WARNING).toBe('Public network. The token is sent unencrypted.')
    expect(networkQuestion(net({ osCategory: 'public' })).warning).toBe(PUBLIC_WARNING)
    expect(networkQuestion(net({ osCategory: 'private' })).warning).toBeNull()
    expect(networkQuestion(net({ kind: 'tailnet', label: 'Tailnet tail1234.ts.net', osCategory: 'private' })).warning).toBeNull()
  })

  it('consent review 3: one notice per network per session, only while remote access or mesh LAN is on; flapping Wi-Fi never re-asks; it goes when the network is allowed or left', async () => {
    const state = { active: true, networks: [net()] }
    const shown: NetworkQuestion[] = []
    const withdrawn: string[][] = []
    const prompt = new NetworkConsentPrompt({ read: async () => state, show: (q) => { shown.push(q) }, withdraw: (keys) => { withdrawn.push(keys) }, log: quiet })
    await prompt.check()
    await prompt.check()
    expect(shown.map((q) => q.message)).toEqual(['Remote access paused on Cafe (10.0.0.0/24).'])
    // Wi-Fi flaps: gone (the notice goes), back (no new notice this session).
    state.networks = []
    await prompt.check()
    expect(withdrawn).toEqual([['lan-0123456789abcdef']])
    state.networks = [net()]
    await prompt.check()
    state.networks = []
    await prompt.check()
    state.networks = [net()]
    await prompt.check()
    expect(shown.length).toBe(1)
    // Off: no notice. An allowed network: no notice.
    const quiet2: NetworkQuestion[] = []
    await new NetworkConsentPrompt({ read: async () => ({ active: false, networks: [net()] }), show: (q) => { quiet2.push(q) }, withdraw: () => {} }).check()
    await new NetworkConsentPrompt({ read: async () => ({ active: true, networks: [net({ allowed: true })] }), show: (q) => { quiet2.push(q) }, withdraw: () => {} }).check()
    expect(quiet2).toEqual([])
  })

  it('consent review 1: an unidentified network gets the notice, labelled "Unidentified network", with nothing to allow', async () => {
    const shown: NetworkQuestion[] = []
    const unidentified = net({ id: null, label: 'Unidentified network' })
    await new NetworkConsentPrompt({ read: async () => ({ active: true, networks: [unidentified] }), show: (q) => { shown.push(q) }, withdraw: () => {} }).check()
    expect(shown).toEqual([expect.objectContaining({ message: 'Remote access paused on Unidentified network.', canAllow: false, networkId: null, warning: null })])
  })

  it('consent review 3: the notice is non-modal: pushed to the window (no dialog), listed for a window that opens later, dismissed by Not now, gone after Allow', async () => {
    electronStub.handlers.clear()
    electronStub.calls.length = 0
    electronStub.pushes.length = 0
    const dir = mkdtempSync(join(tmpdir(), 'adf-netnotice-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'studio-backend.json'), JSON.stringify({ v: 1, mode: 'embedded' }))
    const store = createBackendSettingsStore({ boot: resolveBootBackend(join(dir, 'studio-backend.json'), {}, quiet), codec: fakeCodec(), log: quiet })
    const cafe = net()
    const home = net({ id: 'lan-fedcba9876543210', label: 'Home (192.168.1.0/24)', osCategory: 'private' })
    let networks = [cafe, home]
    const reach = { snapshot: async () => ({ addresses: [], listenable: [], networks, tailscale: 'absent' }) } as unknown as LanReach
    const ipc = registerRemoteAccessHandlers({
      mode: 'embedded', daemon: () => null, backend: store, codec: fakeCodec(), window: () => null, keepDaemonRunning: () => false, settingsDir: dir,
      meshLan: () => ({ on: true, sync: async () => {} }),
      overrides: { reach, consentPollMs: 0, discovery: { feed: () => null } },
      log: quiet,
    })
    await ipc.consent.check()
    expect(electronStub.calls.filter((c) => c.api === 'dialog.showMessageBox')).toEqual([])
    const last = () => electronStub.pushes.filter((p) => p.channel === IPC.NETWORK_NOTICES_CHANGED).at(-1)?.args[0] as Array<{ key: string; message: string; warning: string | null; canAllow: boolean }>
    expect(last().map((n) => [n.message, n.warning, n.canAllow])).toEqual([
      ['Remote access paused on Cafe (10.0.0.0/24).', PUBLIC_WARNING, true],
      ['Remote access paused on Home (192.168.1.0/24).', null, true],
    ])
    expect(await electronStub.handlers.get(IPC.NETWORK_NOTICES_GET)!({})).toEqual(last())
    // Not now on Home; Allow on this network on Cafe.
    await electronStub.handlers.get(IPC.NETWORK_NOTICE_DISMISS)!({}, home.id)
    expect(last().map((n) => n.key)).toEqual([cafe.id])
    expect(await electronStub.handlers.get(IPC.NETWORK_ALLOW)!({}, cafe.id)).toEqual({ ok: true })
    expect(last()).toEqual([])
    // Home flaps: no new notice this session.
    networks = [cafe]
    await ipc.consent.check()
    networks = [{ ...cafe, allowed: true }, home]
    await ipc.consent.check()
    expect(await electronStub.handlers.get(IPC.NETWORK_NOTICES_GET)!({})).toEqual([])
    ipc.dispose()
  })

  it('without a daemon: Allow writes remote-access.json and re-syncs the mesh; Remove too', async () => {
    electronStub.handlers.clear()
    const dir = mkdtempSync(join(tmpdir(), 'adf-netconsent-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'studio-backend.json'), JSON.stringify({ v: 1, mode: 'embedded' }))
    const store = createBackendSettingsStore({ boot: resolveBootBackend(join(dir, 'studio-backend.json'), {}, quiet), codec: fakeCodec(), log: quiet })
    const cafe = net()
    const reach = { snapshot: async () => ({ addresses: [], listenable: [], networks: [cafe], tailscale: 'absent' }) } as unknown as LanReach
    let syncs = 0
    const ipc = registerRemoteAccessHandlers({
      mode: 'embedded', daemon: () => null, backend: store, codec: fakeCodec(), window: () => null, keepDaemonRunning: () => false, settingsDir: dir,
      meshLan: () => ({ on: true, sync: async () => { syncs++ } }),
      overrides: { reach, consentPollMs: 0, discovery: { feed: () => null } },
      log: quiet,
    })
    expect(await electronStub.handlers.get(IPC.NETWORK_ALLOW)!({}, cafe.id)).toEqual({ ok: true })
    const saved = () => JSON.parse(readFileSync(join(dir, 'remote-access.json'), 'utf-8')).allowedNetworks
    expect(saved()).toEqual([expect.objectContaining({ id: cafe.id, kind: 'lan', label: cafe.label })])
    expect(syncs).toBe(1)
    expect(await electronStub.handlers.get(IPC.NETWORK_FORGET)!({}, cafe.id)).toEqual({ ok: true })
    expect(saved()).toEqual([])
    expect(syncs).toBe(2)
    expect(await electronStub.handlers.get(IPC.NETWORK_ALLOW)!({}, 'lan-ffffffffffffffff')).toEqual({ ok: false, error: 'That network is not one this computer is on now.' })
    ipc.dispose()
    electronStub.handlers.clear()
    const remote = registerRemoteAccessHandlers({ mode: 'remote', daemon: () => null, backend: store, codec: fakeCodec(), window: () => null, keepDaemonRunning: () => false, overrides: { reach, consentPollMs: 0 }, log: quiet })
    expect(await electronStub.handlers.get(IPC.NETWORK_ALLOW)!({}, cafe.id)).toMatchObject({ ok: false })
    remote.dispose()
  })
})
