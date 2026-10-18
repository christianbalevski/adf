/**
 * Remote access routes and listeners end to end (docs/design/remote-access.md
 * §11), on a real Fastify instance with real sockets:
 *
 * - management routes: local caller + local proof, never a device token;
 * - the remote listener refuses the install's token and takes device tokens;
 * - pairing: code, owner confirmation, single delivery, brute-force lockout;
 * - revocation closes the device's streams (event bus SSE and client session);
 * - no listener on a network that is not marked private;
 * - a device's session does not hold a Studio-requested stop.
 *
 * The network is faked (interfaces, categories, Tailscale, mDNS, firewall);
 * the "private address" 192.168.77.10 is bound on 127.0.0.1 through the
 * service's bindAddress seam, on its own port.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, request as httpRequest, type IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NetworkInterfaceInfo } from 'node:os'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  const dir = join(tmpdir(), `adf-remote-access-${process.pid}`)
  return {
    app: { getPath: () => dir, on: () => {}, getName: () => 'adf-remote-access-test', getVersion: () => '0.0.0-test' },
    safeStorage: { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
    shell: { openExternal: async () => {} },
    ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {}, removeAllListeners: () => {} },
    BrowserWindow: class {},
    dialog: {},
  }
})

import Ajv2020 from 'ajv/dist/2020'
import spec from '../docs/daemon/openapi.json'
import type { FastifyInstance } from 'fastify'
import { createDaemonHttpApi } from '../src/main/daemon/http-api'
import { DaemonEventBus } from '../src/main/daemon/event-bus'
import { RuntimeService } from '../src/main/runtime/runtime-service'
import { RemoteAccessService } from '../src/main/daemon/remote-access/service'
import type { Announcement, Announcer } from '../src/main/daemon/remote-access/announcer'
import type { ClientSessionRegistry } from '../src/main/daemon/client-sessions'
import type { RemoteAccessEvent } from '../src/shared/types/remote-access.types'

const TOKEN = 'q'.repeat(43)
const PROOF = 'p'.repeat(43)
const LAN = '192.168.77.10'
const master = { authorization: `Bearer ${TOKEN}` }
const managed = { ...master, 'x-adf-local-proof': PROOF }

function validate(schema: string, body: unknown): string[] {
  const ajv = new Ajv2020({ strict: false, allErrors: true })
  ajv.addSchema(spec as object, 'spec')
  const check = ajv.compile({ $ref: `spec#/components/schemas/${schema}` })
  return check(body) ? [] : (check.errors ?? []).map((e) => `${e.instancePath} ${e.message}`)
}

const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', () => resolve()))
  const port = (probe.address() as { port: number }).port
  await new Promise<void>(resolve => probe.close(() => resolve()))
  return port
}

class FakeAnnouncer implements Announcer {
  readonly announced: Announcement[] = []
  announcing = false
  problem: string | null = null
  async announce(a: Announcement): Promise<void> { this.announced.push(a); this.announcing = true }
  async stop(): Promise<void> { this.announcing = false }
}

interface Harness {
  server: FastifyInstance
  service: RemoteAccessService
  port: number
  announcer: FakeAnnouncer
  events: RemoteAccessEvent[]
  logs: string[]
  requestShutdown: ReturnType<typeof vi.fn>
  network: { category: 'private' | 'public' }
  sessions(): ClientSessionRegistry
}

const harnesses: Harness[] = []
afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.service.shutdown()
    await h.server.close()
  }
})

async function harness(opts: { category?: 'private' | 'public'; startedBy?: 'studio' | 'cli' } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'adf-remote-routes-'))
  dirs.push(dir)
  const port = await freePort()
  const announcer = new FakeAnnouncer()
  const events: RemoteAccessEvent[] = []
  const logs: string[] = []
  const network = { category: opts.category ?? 'private' as 'private' | 'public' }
  let server: FastifyInstance | null = null
  const sessions = () => (server as unknown as { adfClientSessions: ClientSessionRegistry }).adfClientSessions
  const service = new RemoteAccessService({
    settingsDir: dir,
    port,
    clientApiVersion: 2,
    platform: 'linux',
    hostName: () => 'host-1',
    interfaces: () => ({ eth0: [{ address: LAN, family: 'IPv4', internal: false, netmask: '255.255.255.0', mac: '00:00:00:00:00:01', cidr: `${LAN}/24` } as NetworkInterfaceInfo] }),
    categories: async (ifaces) => ({
      categories: new Map(ifaces.map(i => [i, network.category])),
      current: [{ iface: 'eth0', id: 'net-home', label: 'eth0 via 192.168.77.1' }],
      problem: null,
    }),
    tailscale: {
      self: async () => ({ state: 'absent', ips: [], dnsName: null }),
      serveStatus: async () => ({ serve: 'unknown', httpsUrl: null }),
      setServe: async () => { throw new Error('Tailscale is not installed on this computer.') },
      serveCommand: (p, on) => (on ? ['serve', '--bg', String(p)] : ['serve', '--https=443', 'off']),
      whois: async () => null,
      command: null,
    },
    announcer,
    firewall: async () => ({ state: 'unknown', message: 'test', commands: [] }),
    bindAddress: () => '127.0.0.1',
    wrongCodeDelayMs: 0,
    log: (line) => logs.push(line),
    emit: (event) => events.push(event),
    sessions,
  })
  const requestShutdown = vi.fn()
  server = createDaemonHttpApi(new RuntimeService({ enforceReviewGate: false }), {
    routes: { remoteAccess: service, startedBy: opts.startedBy ?? 'studio' },
    security: { token: TOKEN, localProof: PROOF },
    eventBus: new DaemonEventBus(100),
    requestShutdown,
  })
  await server.listen({ host: '127.0.0.1', port: 0 })
  const s = server
  await service.attach((req, res) => s.routing(req, res))
  const h: Harness = { server: s, service, port, announcer, events, logs, requestShutdown, network, sessions }
  harnesses.push(h)
  return h
}

/** A request over the remote listener (a real socket on the remote port). */
function remote(h: Harness, method: string, path: string, headers: Record<string, string> = {}, body?: unknown): Promise<{ status: number; json: any; headers: IncomingMessage['headers'] }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = httpRequest({
      host: '127.0.0.1', port: h.port, method, path,
      headers: { host: `${LAN}:${h.port}`, connection: 'close', ...(payload ? { 'content-type': 'application/json' } : {}), ...headers },
    }, (res) => {
      let text = ''
      res.setEncoding('utf-8')
      res.on('data', (c) => { text += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null, headers: res.headers }))
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

async function turnOn(h: Harness): Promise<void> {
  const res = await h.server.inject({ method: 'PUT', url: '/remote-access', headers: managed, payload: { enabled: true } })
  expect(res.statusCode).toBe(200)
}

async function addDevice(h: Harness, label = 'agent-2 laptop'): Promise<{ id: string; token: string }> {
  const res = await h.server.inject({ method: 'POST', url: '/remote-access/devices', headers: managed, payload: { label } })
  expect(res.statusCode).toBe(201)
  return { id: res.json().device.id, token: res.json().token }
}

describe('management routes (§11.2)', () => {
  it('turn on: listeners on the private address, status and events; turn off closes them', async () => {
    const h = await harness()
    const off = await h.server.inject({ method: 'GET', url: '/remote-access', headers: managed })
    expect(off.json()).toMatchObject({ enabled: false, state: 'off', message: 'Not reachable from other computers.' })
    expect(validate('RemoteAccessStatus', off.json())).toEqual([])
    const on = await h.server.inject({ method: 'PUT', url: '/remote-access', headers: managed, payload: { enabled: true, name: 'agent-1 host' } })
    const status = on.json()
    expect(validate('RemoteAccessStatus', status)).toEqual([])
    expect(status).toMatchObject({ enabled: true, state: 'on', name: 'agent-1 host', message: `Reachable from other computers at ${LAN}.` })
    expect(status.fingerprint).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}$/)
    expect(status.addresses).toEqual([{ address: LAN, family: 'IPv4', kind: 'lan', iface: 'eth0', network: 'private', listening: true, problem: null }])
    expect(status.urls.map((u: { url: string }) => u.url)).toEqual([`http://${LAN}:${h.port}`, `http://host-1.local:${h.port}`])
    expect(status.hostNames).toEqual(['host-1', 'host-1.local'])
    expect(h.events.map(e => e.type)).toContain('enabled')
    // macOS / Linux: turning on marks the current network private, visibly.
    expect(h.events.map(e => e.type)).toContain('networks_changed')
    expect(h.announcer.announced.at(-1)).toMatchObject({ name: 'agent-1 host', port: h.port, txt: { v: '1', pair: '0', api: '2', fp: status.fingerprint } })
    expect((await remote(h, 'GET', '/remote/hello')).json).toEqual({ v: 1, name: 'agent-1 host', fingerprint: status.fingerprint, pairingOpen: false, clientApiVersion: 2 })

    const offAgain = await h.server.inject({ method: 'PUT', url: '/remote-access', headers: managed, payload: { enabled: false } })
    expect(offAgain.json().state).toBe('off')
    await expect(remote(h, 'GET', '/remote/hello')).rejects.toThrow()
    expect(h.announcer.announcing).toBe(false)
    expect(h.logs.some(l => /turned off: closed/.test(l))).toBe(true)
  })

  it('needs this machine: the local proof, a loopback caller, never a device token', async () => {
    const h = await harness()
    await turnOn(h)
    const device = await addDevice(h)
    const noProof = await h.server.inject({ method: 'GET', url: '/remote-access', headers: master })
    expect(noProof.statusCode).toBe(403)
    expect(noProof.json().code).toBe('loopback_only')
    const proxied = await h.server.inject({ method: 'GET', url: '/remote-access', headers: { ...managed, 'x-forwarded-for': '203.0.113.9' } })
    expect(proxied.statusCode).toBe(403)
    for (const [method, url] of [['GET', '/remote-access'], ['PUT', '/remote-access'], ['POST', '/remote-access/devices'], ['DELETE', `/remote-access/devices/${device.id}`], ['POST', '/remote-access/pairing'], ['DELETE', '/remote-access/pairing'], ['POST', '/remote-access/pairing/claims/x'], ['POST', '/remote-access/tailscale-serve']] as const) {
      // Even from loopback with the proof (an SSH tunnel): a device token is refused.
      const res = await h.server.inject({ method, url, headers: { authorization: `Bearer ${device.token}`, 'x-adf-local-proof': PROOF }, payload: {} })
      expect(res.statusCode, `${method} ${url}`).toBe(403)
      expect(res.json().code).toBe('device_token_refused')
      const over = await remote(h, method, url, { authorization: `Bearer ${device.token}` }, {})
      expect(over.json.code).toBe('device_token_refused')
    }
  })

  it('validates bodies; trustNetwork marks or unmarks the current network', async () => {
    const h = await harness()
    const empty = await h.server.inject({ method: 'PUT', url: '/remote-access', headers: managed, payload: {} })
    expect(empty.statusCode).toBe(400)
    const badName = await h.server.inject({ method: 'PUT', url: '/remote-access', headers: managed, payload: { name: 'a‮b' } })
    expect(badName.json().code).toBe('bad_request')
    const badLabel = await h.server.inject({ method: 'POST', url: '/remote-access/devices', headers: managed, payload: { label: '' } })
    expect(badLabel.statusCode).toBe(400)
    const trust = await h.server.inject({ method: 'PUT', url: '/remote-access', headers: managed, payload: { trustNetwork: false } })
    expect(trust.statusCode).toBe(200)
    expect(h.events.map(e => e.type)).toContain('networks_changed')
    expect((await h.server.inject({ method: 'DELETE', url: '/remote-access/devices/zzzzzzzzzz', headers: managed })).json().code).toBe('device_not_found')
  })
})

describe('tokens on the remote listener (§4.4)', () => {
  it('refuses the install token, accepts a device token, refuses it while off and after revocation', async () => {
    const h = await harness()
    await turnOn(h)
    const masterRemote = await remote(h, 'GET', '/version', master)
    expect(masterRemote.status).toBe(401)
    expect(masterRemote.json.code).toBe('master_token_remote')
    const device = await addDevice(h)
    const ok = await remote(h, 'GET', '/version', { authorization: `Bearer ${device.token}` })
    expect(ok.status).toBe(200)
    const listed = await h.server.inject({ method: 'GET', url: '/remote-access', headers: managed })
    expect(listed.json().devices[0]).toMatchObject({ id: device.id, label: 'agent-2 laptop', origin: 'token', createdBy: 'cli', lastSeenAddress: '127.0.0.1', connected: true })
    // The same device token through a proxy on this host (tailscale serve) works too; the install token keeps working on loopback.
    expect((await h.server.inject({ method: 'GET', url: '/version', headers: master })).statusCode).toBe(200)
    expect((await h.server.inject({ method: 'GET', url: '/version', headers: { authorization: `Bearer ${device.token}`, 'x-forwarded-for': '100.64.1.2' } })).statusCode).toBe(200)

    await h.server.inject({ method: 'PUT', url: '/remote-access', headers: managed, payload: { enabled: false } })
    const whileOff = await h.server.inject({ method: 'GET', url: '/version', headers: { authorization: `Bearer ${device.token}` } })
    expect(whileOff.statusCode).toBe(401)
    expect(whileOff.json().code).toBe('remote_access_off')

    await turnOn(h)
    const revoked = await h.server.inject({ method: 'DELETE', url: `/remote-access/devices/${device.id}`, headers: managed })
    expect(revoked.statusCode, revoked.body).toBe(200)
    expect(revoked.json().device.id).toBe(device.id)
    const after = await remote(h, 'GET', '/version', { authorization: `Bearer ${device.token}` })
    expect(after.status).toBe(401)
    expect(after.json.code).toBe('device_revoked')
    expect(h.events.map(e => e.type)).toContain('device_revoked')
  })

  it('a device session cannot claim daemon shutdown even through loopback', async () => {
    const h = await harness()
    await turnOn(h)
    const device = await addDevice(h)
    const res = await h.server.inject({ method: 'POST', url: '/client/sessions', headers: { authorization: `Bearer ${device.token}` }, payload: { client: 'studio', version: '1', exitDaemonWhenClosed: true } })
    expect(res.statusCode).toBe(403)
    expect(res.json().code).toBe('device_token_refused')
  })
})

describe('revocation closes streams (§4.7)', () => {
  function openStream(h: Harness, path: string, token: string): Promise<{ res: IncomingMessage; chunks: string[]; closed: Promise<void> }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port: h.port, path, headers: { host: `${LAN}:${h.port}`, authorization: `Bearer ${token}` } }, (res) => {
        const chunks: string[] = []
        res.setEncoding('utf-8')
        res.on('data', (c) => chunks.push(c))
        const closed = new Promise<void>(done => { res.on('close', () => done()); res.on('error', () => done()) })
        resolve({ res, chunks, closed })
      })
      req.on('error', reject)
      req.end()
    })
  }

  it('the event bus stream and the client session stream end; other devices keep theirs', async () => {
    const h = await harness()
    await turnOn(h)
    const a = await addDevice(h, 'agent-1 tablet')
    const b = await addDevice(h, 'agent-2 laptop')
    const busA = await openStream(h, '/events', a.token)
    expect(busA.res.statusCode).toBe(200)
    const busB = await openStream(h, '/events', b.token)
    const created = await remote(h, 'POST', '/client/sessions', { authorization: `Bearer ${a.token}` }, { client: 'studio', version: '1' })
    expect(created.status).toBe(201)
    const session = await openStream(h, `/client/sessions/${created.json.sessionId}/events`, a.token)
    await new Promise(r => setTimeout(r, 50))
    expect(h.sessions().sessionsOfDevice(a.id)).toBe(1)

    const revoked = await h.server.inject({ method: 'DELETE', url: `/remote-access/devices/${a.id}`, headers: managed })
    expect(revoked.json()).toMatchObject({ closedSessions: 1 })
    expect(revoked.json().closedConnections).toBeGreaterThanOrEqual(2)
    await Promise.race([Promise.all([busA.closed, session.closed]), new Promise((_, rej) => setTimeout(() => rej(new Error('streams stayed open')), 3_000))])
    expect(session.chunks.join('')).toContain('session.ended')
    expect(h.sessions().sessionsOfDevice(a.id)).toBe(0)
    expect(busB.res.destroyed).toBe(false)
    busB.res.destroy()
  })
})

describe('no listener on a network that is not private (owner decision O2)', () => {
  it('stays on, lists the address with the reason, and nothing listens', async () => {
    const h = await harness({ category: 'public' })
    await turnOn(h)
    const status = (await h.server.inject({ method: 'GET', url: '/remote-access', headers: managed })).json()
    expect(status).toMatchObject({ enabled: true, state: 'no_address', message: 'Not reachable on this network (Public).', firewall: { state: 'public_network' } })
    expect(status.addresses).toEqual([{ address: LAN, family: 'IPv4', kind: 'lan', iface: 'eth0', network: 'public', listening: false, problem: 'Not reachable on this network (Public).' }])
    expect(status.urls).toEqual([])
    await expect(remote(h, 'GET', '/remote/hello')).rejects.toThrow(/ECONNREFUSED/)
    expect(h.announcer.announcing).toBe(false)
    // The network turns private: the listener opens at the next check.
    h.network.category = 'private'
    await h.service.apply({ force: true })
    expect((await remote(h, 'GET', '/remote/hello')).status).toBe(200)
  })
})

describe('pairing over the remote listener (§5)', () => {
  const claim = (h: Harness, code: string, deviceName = 'agent-2 laptop') => remote(h, 'POST', '/pair/claim', {}, { code, deviceName, clientKind: 'cli' })
  const wrongOf = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, '0')

  it('code → owner allows → token delivered once → it works; the code is never logged or emitted', async () => {
    const h = await harness()
    await turnOn(h)
    expect((await claim(h, '123456')).json.code).toBe('pairing_closed')
    const svc = h.service as unknown as { pairing: { perAddress: Map<string, number[]> } }
    svc.pairing.perAddress.clear() // the per-address limit has its own test
    const opened = await h.server.inject({ method: 'POST', url: '/remote-access/pairing', headers: managed })
    expect(opened.statusCode).toBe(201)
    expect(validate('PairingWindowView', opened.json())).toEqual([])
    expect(opened.json()).toMatchObject({ name: 'host-1', fingerprint: expect.stringMatching(/^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/) })
    const code = opened.json().code as string
    expect(h.announcer.announced.at(-1)?.txt.pair).toBe('1')
    expect((await remote(h, 'GET', '/remote/hello')).json.pairingOpen).toBe(true)

    const accepted = await claim(h, code)
    expect(accepted.status).toBe(202)
    const { claimId } = accepted.json
    expect((await remote(h, 'GET', `/pair/claims/${claimId}`)).json).toEqual({ state: 'pending' })
    const view = (await h.server.inject({ method: 'GET', url: '/remote-access', headers: managed })).json().pairing
    expect(view.claim).toMatchObject({ claimId, deviceName: 'agent-2 laptop', clientKind: 'cli', address: '127.0.0.1', via: 'lan' })

    const waiting = remote(h, 'GET', `/pair/claims/${claimId}?wait=5`)
    const decided = await h.server.inject({ method: 'POST', url: `/remote-access/pairing/claims/${claimId}`, headers: managed, payload: { allow: true } })
    expect(decided.json()).toMatchObject({ state: 'approved', device: { label: 'agent-2 laptop', origin: 'paired' } })
    const result = await waiting
    expect(result.headers['cache-control']).toBe('no-store')
    expect(result.json).toMatchObject({ state: 'approved', device: { label: 'agent-2 laptop' }, daemon: { name: 'host-1' } })
    expect(validate('PairClaimResult', result.json)).toEqual([])
    expect((await remote(h, 'GET', `/pair/claims/${claimId}`)).json.code).toBe('claim_not_found')
    expect((await remote(h, 'GET', '/version', { authorization: `Bearer ${result.json.token}` })).status).toBe(200)

    const transcript = JSON.stringify(h.events) + h.logs.join('\n')
    expect(transcript).not.toContain(code)
    expect(transcript).not.toContain(result.json.token)
    expect(h.events.map(e => e.type)).toEqual(expect.arrayContaining(['pairing_opened', 'claim_pending', 'device_added', 'pairing_closed']))
  })

  it('brute force: 5 wrong codes close the window; the right code is then refused', async () => {
    const h = await harness()
    await turnOn(h)
    const code = (await h.server.inject({ method: 'POST', url: '/remote-access/pairing', headers: managed })).json().code as string
    const svc = h.service as unknown as { pairing: { perAddress: Map<string, number[]> } }
    for (let i = 4; i >= 0; i--) {
      svc.pairing.perAddress.clear() // one source address here; the per-address limit has its own test
      const res = await claim(h, wrongOf(code))
      expect(res.status).toBe(403)
      expect(res.json).toMatchObject({ code: 'wrong_code', attemptsLeft: i })
    }
    svc.pairing.perAddress.clear()
    expect((await claim(h, code)).json.code).toBe('pairing_closed')
    expect(h.events.some(e => e.type === 'pairing_closed' && e.reason === 'wrong_codes')).toBe(true)
    expect(h.logs.some(l => /after 5 wrong codes/.test(l))).toBe(true)
  })

  it('rate limit answers 429 with Retry-After; bad bodies 400; deny answers denied', async () => {
    const h = await harness()
    await turnOn(h)
    const code = (await h.server.inject({ method: 'POST', url: '/remote-access/pairing', headers: managed })).json().code as string
    expect((await claim(h, wrongOf(code))).status).toBe(403)
    const limited = await claim(h, code)
    expect(limited.status).toBe(429)
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0)
    expect((await remote(h, 'POST', '/pair/claim', {}, { code: '12', deviceName: 'x', clientKind: 'cli' })).status).toBe(400)
    expect((await remote(h, 'POST', '/pair/claim', {}, { code: '123456', deviceName: 'a\nb', clientKind: 'cli' })).status).toBe(400)
    const svc = h.service as unknown as { pairing: { perAddress: Map<string, number[]> } }
    svc.pairing.perAddress.clear()
    const { claimId } = (await claim(h, code)).json
    await h.server.inject({ method: 'POST', url: `/remote-access/pairing/claims/${claimId}`, headers: managed, payload: { allow: false } })
    expect((await remote(h, 'GET', `/pair/claims/${claimId}`)).json).toEqual({ state: 'denied' })
    const again = await h.server.inject({ method: 'POST', url: `/remote-access/pairing/claims/${claimId}`, headers: managed, payload: { allow: true } })
    expect(again.statusCode).toBe(409)
    expect(again.json().code).toBe('claim_decided')
  })

  it('off: the unauthenticated routes answer 404 remote_access_off; pairing cannot open', async () => {
    const h = await harness()
    for (const [method, url] of [['GET', '/remote/hello'], ['POST', '/pair/claim'], ['GET', '/pair/claims/x']] as const) {
      const res = await h.server.inject({ method, url, payload: method === 'POST' ? { code: '123456', deviceName: 'x', clientKind: 'cli' } : undefined })
      expect(res.statusCode, url).toBe(404)
      expect(res.json().code).toBe('remote_access_off')
    }
    const open = await h.server.inject({ method: 'POST', url: '/remote-access/pairing', headers: managed })
    expect(open.statusCode).toBe(409)
    expect(open.json().code).toBe('remote_access_off')
  })
})

describe('quit with devices connected (§3.6, owner decision O3)', () => {
  it('a device session does not hold the stop Studio asked for', async () => {
    const h = await harness({ startedBy: 'studio' })
    await turnOn(h)
    const device = await addDevice(h)
    const deviceSession = await h.server.inject({ method: 'POST', url: '/client/sessions', headers: { authorization: `Bearer ${device.token}` }, payload: { client: 'studio', version: '1' } })
    expect(deviceSession.statusCode).toBe(201)
    const studio = await h.server.inject({ method: 'POST', url: '/client/sessions', headers: master, payload: { client: 'studio', version: '1', exitDaemonWhenClosed: true } })
    const quit = await h.server.inject({ method: 'POST', url: `/client/sessions/${studio.json().sessionId}/quit`, headers: master, payload: { stopDaemon: true } })
    expect(quit.json()).toMatchObject({ stopping: true, otherSessions: 0 })
    await new Promise(r => setTimeout(r, 80))
    expect(h.requestShutdown).toHaveBeenCalled()
  })
})
