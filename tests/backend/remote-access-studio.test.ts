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
import { RemoteDiscovery, type DaemonAnnouncement } from '../../src/main/backend/remote-access/discovery'
import { RemoteQuitGate, quitQuestion } from '../../src/main/backend/remote-access/quit-gate'
import { claimQuestion, networkStatusView, registerRemoteAccessHandlers, runtimeName, unavailableReason } from '../../src/main/backend/remote-access-ipc'
import type { LanReach } from '../../src/main/services/lan-reach'
import { hostname } from 'node:os'
import { probeTailnet } from '../../src/main/cli/daemon-discovery'
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

describe('host panel (Settings → Backend → This computer)', () => {
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

  it('Allow on This Network (macOS, Linux) sends trustNetwork only', async () => {
    h.daemon.state.enabled = true
    const result = await h.host.set({ trustNetwork: true })
    expect(result.ok).toBe(true)
    expect(h.daemon.state.trusted).toBe(true)
    expect(h.daemon.requests.find((r) => r.method === 'PUT')?.body).toEqual({ trustNetwork: true })
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

function pairSetup(opts: { tailnet?: { running: boolean; suffix: string | null; peerIps: Set<string>; peerNames: Set<string> }; saveBlocked?: string | null; saveFails?: boolean; useEncrypted?: boolean; savedRemote?: { url: string | null; tokenSaved: boolean; fingerprint: string | null }; replace?: boolean } = {}) {
  const daemon = createFakeRemoteDaemon({ loopback: LOOPBACK })
  daemon.state.enabled = true
  daemon.state.pairing = { code: '654321', openedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 120_000).toISOString(), attemptsLeft: 5, claim: null }
  const states: RemotePairState[] = []
  const saved: PairingSaveInput[] = []
  const logs: string[] = []
  const switches: Array<{ from: string; to: string }> = []
  const replaces: string[] = []
  const flow = new PairingFlow({
    savedRemote: () => opts.savedRemote ?? { url: null, tokenSaved: false, fingerprint: null },
    confirmReplace: async (prompt) => { replaces.push(prompt.current); return opts.replace ?? true },
    confirmSwitch: async (prompt) => { switches.push({ from: prompt.from, to: prompt.to }); return opts.useEncrypted ?? true },
    tailnetView: async () => opts.tailnet ?? { running: true, suffix: 'tail1234.ts.net', peerIps: new Set(['100.101.102.103']), peerNames: new Set<string>() },
    onState: (s) => states.push(s),
    save: async (input) => { saved.push(input); return opts.saveFails ? { ok: false, error: 'Could not save studio-backend.json.' } : { ok: true } },
    saveBlocked: () => opts.saveBlocked ?? null,
    defaultDeviceName: () => 'agent-2-laptop',
    fetch: daemon.fetch,
    log: { log: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) },
    retryMs: 5,
  })
  return { daemon, flow, states, saved, logs, switches, replaces, last: () => states.at(-1)! }
}

describe('pairing from Settings → Backend → Remote computer', () => {
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
    expect(p.last()).toMatchObject({ savedUrl: TAILNET, message: 'Paired with agent-1-pc. Its address and token are saved.' })
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

  it('a saved remote\'s pinned fingerprint (trust on first use): another one at its address is refused (security review 4)', async () => {
    const p = pairSetup({ savedRemote: { url: TAILNET, tokenSaved: true, fingerprint: 'QQQQ-QQQQ' } })
    expect(await p.flow.start({ url: TAILNET })).toMatchObject({ step: 'failed', code: 'fingerprint_mismatch' })
    expect(p.last().message).toBe('100.101.102.103 now answers with fingerprint ABCD-EFGH, not QQQQ-QQQQ as when it was paired. Studio sent nothing. If that computer was set up again, remove the saved token first (Remove token).')
    expect(p.replaces).toEqual([])
    expect(p.daemon.requests.some((r) => r.path === '/pair/claim')).toBe(false)
  })

  it('a saved remote is never replaced without asking (security review 4)', async () => {
    const kept = pairSetup({ savedRemote: { url: 'https://adf.example.com', tokenSaved: true, fingerprint: null }, replace: false })
    expect(await kept.flow.start({ url: TAILNET })).toMatchObject({ step: 'failed', code: 'kept', message: 'Kept the saved remote computer. Nothing was sent.' })
    expect(kept.replaces).toEqual(['https://adf.example.com'])
    expect(kept.daemon.requests.some((r) => r.path === '/pair/claim')).toBe(false)

    const replaced = pairSetup({ savedRemote: { url: 'https://adf.example.com', tokenSaved: true, fingerprint: null }, replace: true })
    await replaced.flow.start({ url: TAILNET })
    await replaced.flow.submitCode('654321')
    replaced.daemon.decide(true)
    await until(() => replaced.last().step === 'paired')
    expect(replaced.replaces).toEqual(['https://adf.example.com'])
    expect(replaced.saved).toHaveLength(1)
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
    expect(await p.flow.submitCode('222222')).toMatchObject({ step: 'failed', code: 'attempts_used', message: 'Wrong code, and no tries are left. Choose Pair device on agent-1-pc for a new code.' })
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
    expect(await p.flow.submitCode('654321')).toMatchObject({ step: 'failed', code: 'window_closed', message: 'The pairing window on agent-1-pc is closed. Choose Pair device there for a new code.' })
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

describe('Discovered (discovery)', () => {
  function setup(peers: string[] = []) {
    const daemon = createFakeRemoteDaemon({ loopback: LOOPBACK })
    daemon.state.enabled = true
    const updates: RemoteDiscoveryUpdate[] = []
    let handlers: { up: (a: DaemonAnnouncement) => void; down: (a: DaemonAnnouncement) => void } | null = null
    let stopped = false
    let paired: string | null = null
    let own: string | null = null
    const discovery = new RemoteDiscovery({
      onUpdate: (u) => updates.push(u),
      pairedFingerprint: () => paired,
      ownFingerprint: () => own,
      browse: (h) => { handlers = h; return { stop: () => { stopped = true } } },
      tailnet: () => probeTailnet({ exec: tailscaleExec(peers), fetch: daemon.fetch }),
      sweepMs: 60_000,
      log: quiet,
    })
    return { daemon, discovery, updates, up: (a: DaemonAnnouncement) => handlers!.up(a), down: (a: DaemonAnnouncement) => handlers!.down(a), stopped: () => stopped, setPaired: (fp: string) => { paired = fp }, setOwn: (fp: string) => { own = fp } }
  }
  /** `tailscale status --json` with these online peers. */
  function tailscaleExec(peers: string[]) {
    return async () => JSON.stringify({ BackendState: 'Running', Self: { TailscaleIPs: ['100.64.0.1'] }, Peer: Object.fromEntries(peers.map((ip, i) => [`p${i}`, { TailscaleIPs: [ip], Online: true }])) })
  }
  const announcement = (over: Partial<DaemonAnnouncement> = {}): DaemonAnnouncement => ({
    name: 'agent-1-pc', port: 7385, referer: '192.168.1.20', addresses: ['192.168.1.20', '172.20.0.1'], txt: { v: '1', fp: 'ABCD-EFGH', pair: '0', api: '1' }, ...over,
  })

  it('lists an mDNS announcement as LAN, not encrypted; pair=1 is "ready to pair"; goodbye removes it', async () => {
    const d = setup()
    d.discovery.start()
    d.up(announcement({ txt: { v: '1', fp: 'ABCD-EFGH', pair: '1', api: '1' } }))
    expect(d.updates.at(-1)?.entries).toEqual([{ fingerprint: 'ABCD-EFGH', name: 'agent-1-pc', url: LAN, address: '192.168.1.20', kind: 'lan', encrypted: false, pairingOpen: true, alreadyPaired: false }])
    d.down(announcement())
    expect(d.updates.at(-1)?.entries).toEqual([])
    d.discovery.stop()
    expect(d.stopped()).toBe(true)
  })

  it('merges LAN and tailnet sightings by fingerprint; the tailnet address wins and is encrypted', async () => {
    const d = setup(['100.101.102.103'])
    d.discovery.start()
    d.up(announcement())
    await until(() => d.updates.some((u) => u.entries.some((e) => e.kind === 'tailnet')))
    expect(d.updates.at(-1)?.entries).toEqual([{ fingerprint: 'ABCD-EFGH', name: 'agent-1-pc', url: TAILNET, address: '100.101.102.103', kind: 'tailnet', encrypted: true, pairingOpen: false, alreadyPaired: false }])
    d.discovery.stop()
  })

  it('marks the saved remote "already paired" and leaves out this computer\'s own daemon', () => {
    const d = setup()
    d.setPaired('ABCD-EFGH')
    d.discovery.start()
    d.up(announcement())
    d.up(announcement({ name: 'self', referer: '192.168.1.5', txt: { v: '1', fp: 'SELF-2345', pair: '0' } }))
    d.setOwn('SELF-2345')
    d.discovery.refresh()
    expect(d.updates.at(-1)?.entries.map((e) => [e.fingerprint, e.alreadyPaired])).toEqual([['ABCD-EFGH', true]])
    d.discovery.stop()
  })

  it('ignores announcements without a fingerprint or of another version', () => {
    const d = setup()
    d.discovery.start()
    d.up(announcement({ txt: { v: '1' } }))
    d.up(announcement({ txt: { v: '2', fp: 'ABCD-EFGH' } }))
    expect(d.updates.at(-1)?.entries).toEqual([])
    d.discovery.stop()
  })

  it('without mDNS it says so and still probes the tailnet', async () => {
    const daemon = createFakeRemoteDaemon({ loopback: LOOPBACK })
    daemon.state.enabled = true
    const updates: RemoteDiscoveryUpdate[] = []
    const discovery = new RemoteDiscovery({
      onUpdate: (u) => updates.push(u), pairedFingerprint: () => null,
      browse: () => { throw new Error('EADDRINUSE 5353') },
      tailnet: () => probeTailnet({ exec: tailscaleExec(['100.101.102.103']), fetch: daemon.fetch }), log: quiet,
    })
    discovery.start()
    expect(updates[0]).toMatchObject({ browsing: false })
    expect(updates[0].problem).toContain('mDNS')
    await until(() => updates.at(-1)!.entries.length === 1)
    discovery.stop()
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

  it('registers every remote-access channel; the host answers "unavailable" in embedded mode; pairing saves URL, safe: token and remote.paired', async () => {
    electronStub.handlers.clear()
    electronStub.pushes.length = 0
    const daemon = createFakeRemoteDaemon({ loopback: LOOPBACK })
    daemon.state.enabled = true
    daemon.state.pairing = { code: '654321', openedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 120_000).toISOString(), attemptsLeft: 5, claim: null }
    const s = store()
    const ipc = registerRemoteAccessHandlers({
      mode: 'embedded', daemon: () => null, backend: s.store, codec: fakeCodec(), window: () => null, keepDaemonRunning: () => false,
      overrides: { discovery: { browse: () => ({ stop: () => {} }), tailnet: async () => [] }, pairing: { fetch: daemon.fetch, retryMs: 5 } },
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
    const file = JSON.parse(readFileSync(s.path, 'utf8'))
    expect(file.remote.url).toBe(TAILNET)
    expect(file.remote.token).toMatch(/^safe:/)
    expect(file.remote.paired).toEqual({ fingerprint: 'ABCD-EFGH', name: 'agent-1-pc', deviceId: expect.stringMatching(/^dev/), label: 'agent-2 laptop' })
    expect(s.store.get().configured).toMatchObject({ remoteUrl: TAILNET, remoteTokenSaved: true, remotePaired: { fingerprint: 'ABCD-EFGH', name: 'agent-1-pc', label: 'agent-2 laptop' } })
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

  it('the status line view: Private when a LAN address is on a private network, Public when none is', () => {
    const snapshot = {
      addresses: [
        { address: '100.101.102.103', family: 'IPv4' as const, kind: 'tailnet' as const, iface: 'Tailscale', network: 'tailnet' as const, refusal: null },
        { address: '192.168.1.20', family: 'IPv4' as const, kind: 'lan' as const, iface: 'Wi-Fi', network: 'public' as const, refusal: 'Not reachable on this network (Public).' },
      ],
      listenable: ['100.101.102.103'], tailscale: 'running' as const, problem: null,
    }
    expect(networkStatusView(snapshot, { state: 'ok', message: '', commands: [] }, 'darwin')).toEqual({
      available: true, network: 'public', lan: [{ address: '192.168.1.20', iface: 'Wi-Fi', network: 'public' }],
      tailscale: 'running', tailnetAddress: '100.101.102.103', firewall: { state: 'ok', message: '' }, problem: null, markable: true,
    })
    const priv = { ...snapshot, addresses: [snapshot.addresses[0], { ...snapshot.addresses[1], network: 'private' as const, refusal: null }] }
    expect(networkStatusView(priv, { state: 'ok', message: '', commands: [] }, 'win32')).toMatchObject({ network: 'private', markable: false })
  })

  it('NETWORK_STATUS_GET reads this computer\'s network; remote mode answers available: false', async () => {
    electronStub.handlers.clear()
    const dir = mkdtempSync(join(tmpdir(), 'adf-netstatus-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'studio-backend.json'), JSON.stringify({ v: 1, mode: 'local' }))
    const store = createBackendSettingsStore({ boot: resolveBootBackend(join(dir, 'studio-backend.json'), {}, quiet), codec: fakeCodec(), log: quiet })
    const reach = { snapshot: async () => ({ addresses: [{ address: '192.168.1.20', family: 'IPv4', kind: 'lan', iface: 'Wi-Fi', network: 'private', refusal: null }], listenable: ['192.168.1.20'], tailscale: 'absent', problem: null }) } as unknown as LanReach
    const ipc = registerRemoteAccessHandlers({
      mode: 'embedded', daemon: () => null, backend: store, codec: fakeCodec(), window: () => null, keepDaemonRunning: () => false, settingsDir: dir,
      overrides: { reach, firewall: async () => ({ state: 'ok', message: 'fine', commands: [] }), platform: 'win32', discovery: { browse: () => ({ stop: () => {} }), tailnet: async () => [] } },
      log: quiet,
    })
    const view = await electronStub.handlers.get(IPC.NETWORK_STATUS_GET)!({})
    expect(view).toMatchObject({ available: true, network: 'private', lan: [{ address: '192.168.1.20', iface: 'Wi-Fi', network: 'private' }], tailscale: 'absent', firewall: { state: 'ok' } })
    ipc.dispose()
    electronStub.handlers.clear()
    const remote = registerRemoteAccessHandlers({ mode: 'remote', daemon: () => null, backend: store, codec: fakeCodec(), window: () => null, keepDaemonRunning: () => false, overrides: { reach }, log: quiet })
    expect(await electronStub.handlers.get(IPC.NETWORK_STATUS_GET)!({})).toMatchObject({ available: false })
    remote.dispose()
  })
})
