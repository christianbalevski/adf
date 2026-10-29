import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DaemonRequestGuard, daemonHostAllowList, type DeviceTokenAuthority } from '../src/main/daemon/request-guard'
import { registerWebStudio, type WebStudioOptions } from '../src/main/daemon/web/routes'
import type { WebTabOptions } from '../src/main/daemon/web/context'

const TOKEN = 'a'.repeat(43)
const PROOF = 'p'.repeat(43)
const CLIENT = 'browser-tab-00000001'
const servers: FastifyInstance[] = []
const dirs: string[] = []
function sessionCookie(reply: { headers: Record<string, unknown> }): string {
  return ([reply.headers['set-cookie']].flat() as string[]).find(value => value.startsWith('adf_web_session_'))!.split(';')[0]
}
async function readThrough(reader: ReadableStreamDefaultReader<Uint8Array>, marker: string): Promise<string> {
  let text = ''
  while (!text.includes(marker)) {
    const chunk = await reader.read()
    if (chunk.done) throw new Error(`Event stream ended before ${marker}`)
    text += new TextDecoder().decode(chunk.value)
  }
  return text
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
async function start(options: WebStudioOptions = {}, deviceTokens?: DeviceTokenAuthority, listenPort = 0) {
  const server = Fastify()
  servers.push(server)
  let port = 0
  const guard = new DaemonRequestGuard({ token: TOKEN, allowedHosts: () => daemonHostAllowList('127.0.0.1', port), deviceTokens })
  let pairToken = ''
  const pairing = {
    enabled: true, wrongCodeDelayMs: 0,
    claim: vi.fn(async () => ({ claimId: 'test-claim', collectSecret: 'test-secret', expiresAt: new Date(Date.now() + 60_000).toISOString() })),
    poll: vi.fn(async () => ({ state: 'approved' as const, token: pairToken, device: { id: 'device', label: 'Browser' }, daemon: { name: 'Host', fingerprint: '', urls: [] } })),
  }
  registerWebStudio(server, guard, { localProof: PROOF, remoteAccess: pairing, ...options })
  await server.listen({ host: '127.0.0.1', port: listenPort })
  port = (server.server.address() as { port: number }).port
  const host = `127.0.0.1:${port}`
  const headers = { host, origin: `http://${host}`, 'sec-fetch-site': 'same-origin' }
  const scopes = new Map<string, string>()
  async function launch() {
    return server.inject({ method: 'POST', url: '/web/launch', headers: { host, authorization: `Bearer ${TOKEN}`, 'x-adf-local-proof': PROOF } })
  }
  async function loginResponse(token = TOKEN, existingCookie?: string) {
    if (token === TOKEN) {
      const launchReply = await launch()
      expect(launchReply.statusCode).toBe(200)
      const ticket = new URLSearchParams(new URL(launchReply.json().url).hash.slice(1)).get('ticket')
      return server.inject({ method: 'POST', url: '/web/session', headers: { ...headers, ...(existingCookie ? { cookie: existingCookie } : {}) }, payload: { ticket } })
    }
    pairToken = token
    const pending = await server.inject({ method: 'POST', url: '/web/pair', headers, payload: { code: '123456', deviceName: 'Browser' } })
    expect(pending.statusCode).toBe(202)
    return server.inject({ url: '/web/pair', headers: { ...headers, cookie: String(pending.headers['set-cookie']).split(';')[0] } })
  }
  async function login(token = TOKEN) {
    const reply = await loginResponse(token)
    expect(reply.statusCode).toBe(200)
    const cookies = [reply.headers['set-cookie']].flat() as string[]
    const cookie = cookies.find(value => value.startsWith('adf_web_session_'))!.split(';')[0]
    scopes.set(cookie, reply.json().storageScope)
    return cookie
  }
  return { server, headers, login, loginResponse, launch, pairing, scopeFor: (cookie: string) => scopes.get(cookie)!, baseUrl: `http://${host}` }

}
function factory() {
  const opened: WebTabOptions[] = []
  const closes = vi.fn()
  const resync = vi.fn(async () => {})
  const createTab = vi.fn(async (opts: WebTabOptions) => {
    opened.push(opts)
    let current: unknown = null
    return {
      invoke: async (channel: string, args: unknown[]) => {
        if (channel === 'open') current = args[0]
        if (channel === 'push') opts.send('changed', args[0])
        if (channel === 'fail') throw new Error('Explicit failure')
        return current
      },
      snapshot: async () => new Response('snapshot'),
      readFile: async () => new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }),
      resync, close: async () => { closes() },
    }
  })
  return { opened, closes, createTab, resync }
}

describe('browser Studio authentication and transport', () => {
  it('authenticates before parsing potentially large RPC attachment bodies', async () => {
    const { server, headers } = await start()
    const response = await server.inject({
      method: 'POST', url: '/web/invoke', headers: { ...headers, 'content-type': 'application/json' },
      payload: '{ malformed attachment body',
    })
    expect(response.statusCode).toBe(401)
    expect(response.json().code).toBe('web_session_required')
  })
  it('exchanges a desktop launch ticket for an opaque HttpOnly cookie and refuses unauthenticated calls', async () => {
    const { server, headers, login, loginResponse, scopeFor } = await start({ createTab: factory().createTab })
    const unauthenticated = await server.inject({ method: 'POST', url: '/web/invoke', headers, payload: { channel: 'open', args: [], clientId: CLIENT } })
    expect(unauthenticated.statusCode).toBe(401)
    const wrong = await server.inject({ method: 'POST', url: '/web/session', headers, payload: { token: 'wrong' } })
    expect(wrong.statusCode).toBe(400)
    const response = await loginResponse()
    expect(String(response.headers['set-cookie'])).toContain('HttpOnly; SameSite=Strict')
    expect(response.headers['set-cookie']).not.toContain(TOKEN)
    expect(response.body).not.toContain(TOKEN)
    expect(response.headers['cache-control']).toBe('no-store')
    const cookie = await login()
    expect((await server.inject({ url: '/web/session', headers: { ...headers, cookie } })).json()).toMatchObject({ authenticated: true, storageScope: expect.stringMatching(/^[a-f0-9]{32}$/) })
  })
  it('requires a direct local desktop master with proof to mint a launch ticket', async () => {
    const { server, headers } = await start()
    const local = { host: headers.host, authorization: `Bearer ${TOKEN}`, 'x-adf-local-proof': PROOF }
    for (const patch of [
      { 'x-adf-local-proof': '' }, { 'x-adf-local-proof': 'wrong' },
      { origin: headers.origin }, { forwarded: 'for=198.51.100.1' }, { 'x-forwarded-for': '198.51.100.1' },
    ]) {
      expect((await server.inject({ method: 'POST', url: '/web/launch', headers: { ...local, ...patch } })).statusCode).toBe(403)
    }
    expect((await server.inject({ method: 'POST', url: '/web/launch', headers: local, remoteAddress: '198.51.100.1' })).statusCode).toBe(403)
    expect((await server.inject({ method: 'POST', url: '/web/launch', headers: { host: headers.host, 'x-adf-local-proof': PROOF } })).statusCode).toBe(401)
    const minted = await server.inject({ method: 'POST', url: '/web/launch', headers: local })
    expect(minted.statusCode).toBe(200)
    expect(new URL(minted.json().url).pathname).toBe('/studio/')
    expect(minted.body).not.toContain(TOKEN)
    expect(minted.body).not.toContain(PROOF)
  })
  it('binds short-lived one-use launch tickets to their local authority', async () => {
    const { server, headers, launch } = await start()
    const minted = await launch()
    const ticket = new URLSearchParams(new URL(minted.json().url).hash.slice(1)).get('ticket')
    const otherHost = headers.host.replace('127.0.0.1', 'localhost')
    expect((await server.inject({ method: 'POST', url: '/web/session', headers: { host: otherHost, origin: `http://${otherHost}` }, payload: { ticket } })).statusCode).toBe(403)
    expect((await server.inject({ method: 'POST', url: '/web/session', headers, payload: { ticket } })).statusCode).toBe(200)
    expect((await server.inject({ method: 'POST', url: '/web/session', headers, payload: { ticket } })).statusCode).toBe(401)
    const expired = await launch()
    const expiredTicket = new URLSearchParams(new URL(expired.json().url).hash.slice(1)).get('ticket')
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_001)
    try {
      expect((await server.inject({ method: 'POST', url: '/web/session', headers, payload: { ticket: expiredTicket } })).statusCode).toBe(401)
    } finally { clock.mockRestore() }
    expect((await server.inject({ method: 'POST', url: '/web/session', headers, payload: { token: TOKEN } })).statusCode).toBe(400)
  })
  it('keeps pairing collection secrets server-side and uses the original requester for host approval', async () => {
    const device = `adfd_${'b'.repeat(43)}`
    const authority: DeviceTokenAuthority = {
      enabled: () => true, computerName: () => 'Host',
      check: token => token === device ? { kind: 'device', id: 'browser-device', label: 'Tablet' } : { kind: 'unknown' },
    }
    let state: 'pending' | 'denied' | 'approved' = 'pending'
    const claim = vi.fn(async () => ({ claimId: 'private-claim', collectSecret: 'private-secret', expiresAt: new Date(Date.now() + 60_000).toISOString() }))
    const poll = vi.fn(async () => state === 'approved' ? { state, token: device, device: { id: 'browser-device', label: 'Tablet' }, daemon: { name: 'Host', fingerprint: '', urls: [] } } : { state })
    const { server, headers } = await start({ remoteAccess: { enabled: true, wrongCodeDelayMs: 0, claim, poll } }, authority)
    const pending = await server.inject({ method: 'POST', url: '/web/pair', headers, remoteAddress: '198.51.100.7', payload: { code: '123456', deviceName: 'Tablet' } })
    expect(pending.statusCode).toBe(202)
    expect(pending.json().state).toBe('pending')
    expect(pending.body).not.toContain('private-')
    expect(claim.mock.calls[0][0].socket.remoteAddress).toBe('198.51.100.7')
    const pairingCookie = String(pending.headers['set-cookie']).split(';')[0]
    const waiting = await server.inject({ url: '/web/pair', headers: { ...headers, cookie: pairingCookie } })
    expect(waiting.json().state).toBe('pending')
    expect(poll).toHaveBeenCalledWith('private-claim', 'private-secret', 0)
    state = 'approved'
    const approved = await server.inject({ url: '/web/pair', headers: { ...headers, cookie: pairingCookie } })
    expect(approved.json()).toMatchObject({ state: 'approved', authenticated: true })
    expect(approved.body).not.toContain(device)
    const remembered = ([approved.headers['set-cookie']].flat() as string[]).find(value => value.startsWith('adf_web_device_'))!
    expect(remembered).toContain('HttpOnly; SameSite=Strict; Max-Age=2592000')
    expect((await server.inject({ url: '/web/session', headers: { ...headers, cookie: sessionCookie(approved) } })).statusCode).toBe(200)
    expect((await server.inject({ url: '/web/pair', headers: { ...headers, cookie: pairingCookie } })).statusCode).toBe(404)
  })
  it('never creates a session before host approval and serializes collection polls', async () => {
    let finish!: (value: { state: 'denied' }) => void
    const result = new Promise<{ state: 'denied' }>(resolve => { finish = resolve })
    const claim = vi.fn(async () => ({ claimId: 'claim', collectSecret: 'secret', expiresAt: new Date(Date.now() + 60_000).toISOString() }))
    const poll = vi.fn(() => result)
    const { server, headers } = await start({ remoteAccess: { enabled: true, wrongCodeDelayMs: 0, claim, poll } })
    const pending = await server.inject({ method: 'POST', url: '/web/pair', headers, payload: { code: '123456', deviceName: 'Tablet' } })
    const cookie = String(pending.headers['set-cookie']).split(';')[0]
    expect((await server.inject({ url: '/web/session', headers: { ...headers, cookie } })).statusCode).toBe(401)
    const first = server.inject({ url: '/web/pair', headers: { ...headers, cookie } }).then(value => value)
    await vi.waitFor(() => expect(poll).toHaveBeenCalledTimes(1))
    const concurrent = await server.inject({ url: '/web/pair', headers: { ...headers, cookie } })
    expect(concurrent.json().state).toBe('pending')
    expect(poll).toHaveBeenCalledTimes(1)
    finish({ state: 'denied' })
    const denied = await first
    expect(denied.json()).toEqual({ state: 'denied' })
    expect(String(denied.headers['set-cookie'])).not.toContain('adf_web_session_')
    expect((await server.inject({ url: '/web/session', headers: { ...headers, cookie } })).statusCode).toBe(401)
  })
  it('collects approvals made near the pairing-window deadline', async () => {
    const device = `adfd_${'d'.repeat(43)}`
    const authority: DeviceTokenAuthority = {
      enabled: () => true, computerName: () => 'Host',
      check: token => token === device ? { kind: 'device', id: 'late-device', label: 'Browser' } : { kind: 'unknown' },
    }
    const { server, headers, pairing } = await start({}, authority)
    const pending = await server.inject({ method: 'POST', url: '/web/pair', headers, payload: { code: '123456', deviceName: 'Tablet' } })
    const cookie = String(pending.headers['set-cookie']).split(';')[0]
    pairing.poll.mockResolvedValue({ state: 'approved', token: device, device: { id: 'late-device', label: 'Browser' }, daemon: { name: 'Host', fingerprint: '', urls: [] } })
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(pending.json().expiresAt) + 1_000)
    try {
      const approved = await server.inject({ url: '/web/pair', headers: { ...headers, cookie } })
      expect(approved.json()).toMatchObject({ state: 'approved', authenticated: true })
    } finally { clock.mockRestore() }
  })
  it('preserves source pairing refusals and remote-access-off behavior', async () => {
    const claim = vi.fn(async () => { throw Object.assign(new Error('Pairing is rate limited for this address.'), { status: 429, code: 'rate_limited', extra: { retryAfter: 2 } }) })
    const { server, headers } = await start({ remoteAccess: { enabled: true, wrongCodeDelayMs: 0, claim, poll: vi.fn() } })
    const refused = await server.inject({ method: 'POST', url: '/web/pair', headers, payload: { code: '123456', deviceName: 'Tablet' } })
    expect(refused.statusCode).toBe(429)
    expect(refused.json().code).toBe('rate_limited')
    expect(refused.headers['retry-after']).toBe('2')
    expect(refused.headers['set-cookie']).toBeUndefined()
    const off = await start({ remoteAccess: null })
    expect((await off.server.inject({ method: 'POST', url: '/web/pair', headers: off.headers, payload: { code: '123456', deviceName: 'Tablet' } })).statusCode).toBe(404)
  })
  it('invalidates late renewal cookies and prevents remembered re-login after sign-out', async () => {
    const device = `adfd_${'e'.repeat(43)}`
    const authority: DeviceTokenAuthority = {
      enabled: () => true, computerName: () => 'Host',
      check: token => token === device ? { kind: 'device', id: 'logout-device', label: 'Browser' } : { kind: 'unknown' },
    }
    const { server, headers, loginResponse } = await start({}, authority)
    const approved = await loginResponse(device)
    const oldSession = sessionCookie(approved)
    const remembered = ([approved.headers['set-cookie']].flat() as string[]).find(value => value.startsWith('adf_web_device_'))!.split(';')[0]
    // The request already minted its session; its response can arrive after
    // logout over another connection. Receiving that cookie must grant nothing.
    const renewal = await server.inject({ url: '/web/session', headers: { ...headers, cookie: remembered } })
    expect(renewal.statusCode).toBe(200)
    const lateCookie = sessionCookie(renewal)
    expect(lateCookie).not.toBe(oldSession)
    expect(String(renewal.headers['set-cookie'])).not.toContain('adf_web_device_')
    await server.inject({ method: 'DELETE', url: '/web/session', headers: { ...headers, cookie: `${oldSession}; ${remembered}` } })
    for (const cookie of [oldSession, lateCookie, remembered, `${lateCookie}; ${remembered}`]) {
      expect((await server.inject({ url: '/web/session', headers: { ...headers, cookie } })).statusCode).toBe(401)
    }
    // An explicit new approval is allowed to authorize this browser again.
    expect((await loginResponse(device)).statusCode).toBe(200)
  })
  it('does not finish an in-flight pairing collection after browser logout', async () => {
    const device = `adfd_${'f'.repeat(43)}`
    const authority: DeviceTokenAuthority = {
      enabled: () => true, computerName: () => 'Host',
      check: token => token === device ? { kind: 'device', id: 'cancelled-device', label: 'Browser' } : { kind: 'unknown' },
    }
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const poll = vi.fn(async () => { await pending; return { state: 'approved' as const, token: device, device: { id: 'cancelled-device', label: 'Browser' }, daemon: { name: 'Host', fingerprint: '', urls: [] } } })
    const claim = vi.fn(async () => ({ claimId: 'cancelled-claim', collectSecret: 'secret', expiresAt: new Date(Date.now() + 60_000).toISOString() }))
    const { server, headers } = await start({ remoteAccess: { enabled: true, wrongCodeDelayMs: 0, claim, poll } }, authority)
    const accepted = await server.inject({ method: 'POST', url: '/web/pair', headers, payload: { code: '123456', deviceName: 'Tablet' } })
    const cookie = String(accepted.headers['set-cookie']).split(';')[0]
    const collecting = server.inject({ url: '/web/pair', headers: { ...headers, cookie } }).then(response => response)
    await vi.waitFor(() => expect(poll).toHaveBeenCalledOnce())
    await server.inject({ method: 'DELETE', url: '/web/session', headers: { ...headers, cookie } })
    release()
    const rejected = await collecting
    expect(rejected.statusCode).toBe(401)
    expect(rejected.json().code).toBe('web_pairing_cancelled')
    expect(rejected.headers['set-cookie']).toBeUndefined()
  })
  it('retains paired browser sign-in across daemon restart and rejects revoked credentials', async () => {
    const device = `adfd_${'c'.repeat(43)}`
    let revoked = false
    const authority: DeviceTokenAuthority = {
      enabled: () => true, computerName: () => 'Host',
      check: token => token !== device ? { kind: 'unknown' } : revoked
        ? { kind: 'revoked', label: 'Browser', revokedAt: '2026-10-29T00:00:00Z' }
        : { kind: 'device', id: 'browser-device', label: 'Browser' },
    }
    const first = await start({}, authority)
    const approved = await first.loginResponse(device)
    const remembered = ([approved.headers['set-cookie']].flat() as string[]).find(value => value.startsWith('adf_web_device_'))!.split(';')[0]
    const oldScope = approved.json().storageScope
    const port = Number(new URL(first.baseUrl).port)
    await first.server.close()
    const next = await start({}, authority, port)
    // A reverse proxy terminates HTTPS; same-origin GET need not carry Origin.
    const resumed = await next.server.inject({ url: '/web/session', headers: { host: next.headers.host, cookie: remembered, 'x-forwarded-proto': 'https' } })
    expect(resumed.statusCode).toBe(200)
    expect(resumed.json().storageScope).not.toBe(oldScope)
    expect(resumed.json().recoveryScope).toBe(approved.json().recoveryScope)
    expect(String(resumed.headers['set-cookie'])).toContain('; Secure')
    expect(resumed.body).not.toContain(device)
    revoked = true
    const refused = await next.server.inject({ url: '/web/session', headers: { ...next.headers, cookie: remembered } })
    expect(refused.statusCode).toBe(401)
    expect(String(refused.headers['set-cookie'])).toContain('Max-Age=0')
    const signedOut = await next.server.inject({ method: 'DELETE', url: '/web/session', headers: { ...next.headers, cookie: remembered } })
    expect(([signedOut.headers['set-cookie']].flat() as string[]).find(value => value.startsWith('adf_web_device_'))).toContain('Max-Age=0')
  })
  it('provides an independent storage scope that persists only for the browser session', async () => {
    const { server, headers, loginResponse } = await start()
    const first = await loginResponse()
    const cookie = sessionCookie(first)
    const scope = first.json().storageScope
    expect(scope).toMatch(/^[a-f0-9]{32}$/)
    expect(cookie).not.toContain(scope)
    expect((await server.inject({ url: '/web/session', headers: { ...headers, cookie } })).json().storageScope).toBe(scope)
    const second = await loginResponse(TOKEN, cookie)
    expect(second.json().storageScope).not.toBe(scope)
    expect(second.json().recoveryScope).toBe(first.json().recoveryScope)
    expect((await server.inject({ url: '/web/session', headers: { ...headers, cookie: sessionCookie(second) } })).json().recoveryScope).toBe(first.json().recoveryScope)
  })
  it('keeps recovery namespaces distinct for the master and paired device principals', async () => {
    const device = `adfd_${'b'.repeat(43)}`
    const authority: DeviceTokenAuthority = {
      enabled: () => true, computerName: () => 'Host',
      check: token => token === device ? { kind: 'device', id: 'device-one', label: 'Browser' } : { kind: 'unknown' },
    }
    const { loginResponse: login } = await start({}, authority)
    const master = (await login(TOKEN)).json()
    const paired = (await login(device)).json()
    expect(paired.recoveryScope).not.toBe(master.recoveryScope)
    expect((await login(device)).json().recoveryScope).toBe(paired.recoveryScope)
  })
  it('rejects stale-tab authority after another tab replaces the shared login cookie', async () => {
    const f = factory()
    const { server, headers, login, loginResponse, scopeFor } = await start({ createTab: f.createTab })
    const oldCookie = await login()
    const oldScope = scopeFor(oldCookie)
    const cookie = await login()
    const newScope = scopeFor(cookie)
    expect(newScope).not.toBe(oldScope)
    const requestHeaders = { ...headers, cookie }
    const invoke = (storageScope?: string) => server.inject({ method: 'POST', url: '/web/invoke', headers: requestHeaders, payload: { storageScope, channel: 'open', args: ['one.adf'], clientId: CLIENT } })
    expect((await invoke()).statusCode).toBe(401)
    expect((await invoke(oldScope)).statusCode).toBe(401)
    for (const route of ['events', 'file', 'snapshot']) {
      expect((await server.inject({ url: `/web/${route}?clientId=${CLIENT}&storageScope=${oldScope}&path=image.svg`, headers: requestHeaders })).statusCode).toBe(401)
    }
    expect(f.createTab).not.toHaveBeenCalled()
    expect((await invoke(newScope)).statusCode).toBe(200)
    // A stale tab must not invalidate the replacement session when rejected.
    expect((await server.inject({ url: '/web/session', headers: requestHeaders })).statusCode).toBe(200)
  })
  it('does not expose routes when explicitly disabled', async () => {
    const { server, headers } = await start({ enabled: false })
    expect((await server.inject({ url: '/studio/', headers })).statusCode).toBe(404)
    expect((await server.inject({ method: 'POST', url: '/web/session', headers, payload: { token: TOKEN } })).statusCode).toBe(404)
  })
  it('does not revive a pending event stream after logout', async () => {
    const f = factory()
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const createTab = vi.fn(async (opts: WebTabOptions) => { await pending; return f.createTab(opts) })
    const { server, headers, login, scopeFor, baseUrl } = await start({ createTab })
    const cookie = await login()
    const response = fetch(`${baseUrl}/web/events?clientId=${CLIENT}&storageScope=${scopeFor(cookie)}`, { headers: { cookie } })
    await vi.waitFor(() => expect(createTab).toHaveBeenCalledTimes(1))
    await server.inject({ method: 'DELETE', url: '/web/session', headers: { ...headers, cookie } })
    release()
    expect((await response).status).toBe(401)
    expect(f.closes).toHaveBeenCalledTimes(1)
  })
  it('does not invoke a handler whose tab finished opening after logout', async () => {
    const f = factory()
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const invoke = vi.fn()
    const createTab = vi.fn(async (opts: WebTabOptions) => { await pending; return { ...await f.createTab(opts), invoke } })
    const { server, headers, login, loginResponse, scopeFor } = await start({ createTab })
    const cookie = await login()
    const request = server.inject({ method: 'POST', url: '/web/invoke', headers: { ...headers, cookie }, payload: { storageScope: scopeFor(cookie), channel: 'open', args: ['one.adf'], clientId: CLIENT } }).then(result => result)
    await vi.waitFor(() => expect(createTab).toHaveBeenCalledTimes(1))
    await server.inject({ method: 'DELETE', url: '/web/session', headers: { ...headers, cookie } })
    release()
    expect((await request).statusCode).toBe(401)
    expect(invoke).not.toHaveBeenCalled()
  })
  it('keeps cookies and logout independent for daemons on different ports of the same host', async () => {
    const first = await start()
    const second = await start()
    const firstCookie = await first.login()
    // Browsers send all same-host cookies regardless of the request port.
    const secondLogin = await second.loginResponse(TOKEN, firstCookie)
    expect(secondLogin.statusCode).toBe(200)
    const secondCookie = sessionCookie(secondLogin)
    expect(firstCookie.split('=')[0]).not.toBe(secondCookie.split('=')[0])
    const combined = `${firstCookie}; ${secondCookie}`
    for (const daemon of [first, second]) {
      expect((await daemon.server.inject({ url: '/web/session', headers: { ...daemon.headers, cookie: combined } })).statusCode).toBe(200)
    }
    const logout = await second.server.inject({ method: 'DELETE', url: '/web/session', headers: { ...second.headers, cookie: combined } })
    expect(sessionCookie(logout).split('=')[0]).toBe(secondCookie.split('=')[0])
    expect((await first.server.inject({ url: '/web/session', headers: { ...first.headers, cookie: firstCookie } })).statusCode).toBe(200)
    expect((await second.server.inject({ url: '/web/session', headers: { ...second.headers, cookie: combined } })).statusCode).toBe(401)
  })
  it('applies exact origin, Fetch Metadata and host restrictions to login and cookie requests', async () => {
    const { server, headers, login, loginResponse, scopeFor } = await start()
    const cookie = await login()
    for (const bad of [{ origin: 'https://attacker.test' }, { 'sec-fetch-site': 'same-site' }, { host: 'attacker.test' }]) {
      const response = await server.inject({ method: 'POST', url: '/web/session', headers: { ...headers, ...bad, cookie }, payload: { token: TOKEN } })
      expect(response.statusCode).toBe(403)
    }
  })
  it('isolates open documents between tabs and sessions, retains them across reloads and destroys them on logout', async () => {
    const f = factory()
    const { server, headers, login, loginResponse, scopeFor } = await start({ createTab: f.createTab })
    const cookie = await login()
    const invoke = (clientId: string, channel: string, args: unknown[] = [], authCookie = cookie) => server.inject({ method: 'POST', url: '/web/invoke', headers: { ...headers, cookie: authCookie }, payload: { storageScope: scopeFor(authCookie), clientId, channel, args } })
    expect((await invoke(CLIENT, 'open', ['one.adf'])).json()).toEqual({ result: 'one.adf' })
    expect((await invoke('browser-tab-00000002', 'get')).json()).toEqual({ result: null })
    expect((await invoke(CLIENT, 'get')).json()).toEqual({ result: 'one.adf' })
    const otherCookie = await login()
    expect((await invoke(CLIENT, 'get', [], otherCookie)).json()).toEqual({ result: null })
    expect(f.createTab).toHaveBeenCalledTimes(3)
    const logout = await server.inject({ method: 'DELETE', url: '/web/session', headers: { ...headers, cookie } })
    expect(String(logout.headers['set-cookie'])).toContain('Max-Age=0')
    expect((await invoke(CLIENT, 'get')).statusCode).toBe(401)
    expect(f.closes).toHaveBeenCalledTimes(2)
  })
  it('rechecks paired-device authority for every session request', async () => {
    let revoked = false
    const device = `adfd_${'b'.repeat(43)}`
    const authority: DeviceTokenAuthority = {
      enabled: () => true, computerName: () => 'Host',
      check: token => token === device ? (revoked ? { kind: 'revoked', label: 'Browser', revokedAt: '2026-10-29T00:00:00Z' } : { kind: 'device', id: 'device', label: 'Browser' }) : { kind: 'unknown' },
    }
    const { server, headers, login, loginResponse, scopeFor } = await start({ createTab: factory().createTab }, authority)
    const cookie = await login(device)
    revoked = true
    const response = await server.inject({ url: '/web/session', headers: { ...headers, cookie } })
    expect(response.statusCode).toBe(401)
    expect(response.json().code).toBe('device_revoked')
  })
  it('limits repeated sign-in attempts without creating sessions', async () => {
    const { server, headers, loginResponse } = await start()
    for (let i = 0; i < 20; i++) {
      expect((await server.inject({ method: 'POST', url: '/web/session', headers, payload: { token: 'wrong' } })).statusCode).toBe(400)
    }
    const response = await loginResponse()
    expect(response.statusCode).toBe(429)
    expect(response.headers['retry-after']).toBe('60')
  })
  it('caps RPC bursts and replenishes the allowance over time', async () => {
    const { server, headers, login, loginResponse, scopeFor } = await start({ createTab: factory().createTab })
    const cookie = await login()
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    const invoke = () => server.inject({ method: 'POST', url: '/web/invoke', headers: { ...headers, cookie }, payload: { storageScope: scopeFor(cookie), channel: 'get', args: [], clientId: CLIENT } })
    try {
      for (let i = 0; i < 120; i++) expect((await invoke()).statusCode).toBe(200)
      expect((await invoke()).statusCode).toBe(429)
      clock.mockReturnValue(now + 100)
      expect((await invoke()).statusCode).toBe(200)
      expect((await invoke()).statusCode).toBe(429)
    } finally { clock.mockRestore() }
  })
  it('shares request limits across RPC, files and snapshot generation', async () => {
    const { server, headers, login, loginResponse, scopeFor } = await start({ createTab: factory().createTab })
    const cookie = await login()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now())
    try {
      for (let i = 0; i < 120; i++) {
        const route = i % 2 ? 'file' : 'snapshot'
        expect((await server.inject({ url: `/web/${route}?clientId=${CLIENT}&storageScope=${scopeFor(cookie)}&path=image.svg`, headers: { ...headers, cookie } })).statusCode).toBe(200)
      }
      expect((await server.inject({ url: `/web/snapshot?clientId=${CLIENT}&storageScope=${scopeFor(cookie)}`, headers: { ...headers, cookie } })).statusCode).toBe(429)
      expect((await server.inject({ method: 'POST', url: '/web/invoke', headers: { ...headers, cookie }, payload: { storageScope: scopeFor(cookie), channel: 'get', args: [], clientId: CLIENT } })).statusCode).toBe(429)
    } finally { clock.mockRestore() }
  })
  it('validates RPC input and preserves explicit errors', async () => {
    const { server, headers, login, loginResponse, scopeFor } = await start({ createTab: factory().createTab })
    const cookie = await login()
    const call = (payload: unknown) => server.inject({ method: 'POST', url: '/web/invoke', headers: { ...headers, cookie }, payload: { ...(payload as object), storageScope: scopeFor(cookie) } })
    expect((await call({ channel: 'open', args: [], clientId: '../bad' })).statusCode).toBe(400)
    expect((await call({ channel: 'open', args: {}, clientId: CLIENT })).statusCode).toBe(400)
    const failure = await call({ channel: 'fail', args: [], clientId: CLIENT })
    expect(failure.statusCode).toBe(400)
    expect(failure.json().error).toBe('Explicit failure')
  })
  it('streams the shared IPC event format and closes the stream on logout', async () => {
    const f = factory()
    const { server, headers, login, scopeFor, baseUrl } = await start({ createTab: f.createTab })
    const cookie = await login()
    const controller = new AbortController()
    const response = await fetch(`${baseUrl}/web/events?clientId=${CLIENT}&storageScope=${scopeFor(cookie)}`, { headers: { cookie }, signal: controller.signal })
    expect(response.status).toBe(200)
    const reader = response.body!.getReader()
    expect(await readThrough(reader, 'web:tab-generation')).toContain(': connected')
    f.opened[0].send('adf:agent:event', { text: 'hello' })
    expect(await readThrough(reader, 'hello')).toContain('data: {"channel":"adf:agent:event","args":[{"text":"hello"}]}')
    await server.inject({ method: 'DELETE', url: '/web/session', headers: { ...headers, cookie } })
    expect((await reader.read()).done).toBe(true)
    controller.abort()
  })

  it('pushes appearance to sibling tabs in the same browser session only', async () => {
    const f = factory()
    const { server, headers, login, baseUrl, scopeFor } = await start({ createTab: f.createTab })
    const cookie = await login()
    const otherCookie = await login()
    const invoke = (auth: string, clientId: string) => server.inject({
      method: 'POST', url: '/web/invoke', headers: { ...headers, cookie: auth },
      payload: { storageScope: scopeFor(auth), clientId, channel: 'get', args: [] },
    })
    await invoke(cookie, CLIENT)
    await invoke(cookie, 'browser-sibling-0001')
    await invoke(otherCookie, 'browser-other-000001')
    f.opened[0].appearanceChanged!({ theme: 'dark' })
    const readInitial = async (auth: string, clientId: string) => {
      const response = await fetch(`${baseUrl}/web/events?clientId=${clientId}&storageScope=${scopeFor(auth)}`, { headers: { cookie: auth } })
      const reader = response.body!.getReader()
      try { return new TextDecoder().decode((await reader.read()).value) }
      finally { await reader.cancel() }
    }
    expect(await readInitial(cookie, 'browser-sibling-0001')).toContain('"theme":"dark"')
    expect(await readInitial(cookie, CLIENT)).not.toContain('"theme":"dark"')
    expect(await readInitial(otherCookie, 'browser-other-000001')).not.toContain('"theme":"dark"')
  })
  it('resynchronizes after an ordinary SSE disconnect, including queued last frames', async () => {
    const f = factory()
    const { headers, login, scopeFor, baseUrl } = await start({ createTab: f.createTab })
    const cookie = await login()
    const url = `${baseUrl}/web/events?clientId=${CLIENT}&storageScope=${scopeFor(cookie)}`
    const firstController = new AbortController()
    const first = await fetch(url, { headers: { cookie }, signal: firstController.signal })
    await first.body!.getReader().read()
    f.opened[0].send('changed', { lastFrame: true })
    firstController.abort()
    const secondController = new AbortController()
    try {
      const second = await fetch(url, { headers: { cookie }, signal: secondController.signal })
      expect(second.status).toBe(200)
      await second.body!.getReader().read()
      await vi.waitFor(() => expect(f.resync).toHaveBeenCalledTimes(1))
      expect(f.createTab).toHaveBeenCalledTimes(1)
    } finally { secondController.abort() }
  })
  it('announces the tab generation before events and rejects mutations from an old generation', async () => {
    const f = factory()
    const { server, headers, login, scopeFor, baseUrl } = await start({ createTab: f.createTab })
    const cookie = await login()
    const storageScope = scopeFor(cookie)
    const controller = new AbortController()
    try {
      const response = await fetch(`${baseUrl}/web/events?clientId=${CLIENT}&storageScope=${storageScope}`, { headers: { cookie }, signal: controller.signal })
      const frame = await readThrough(response.body!.getReader(), ']}\n\n')
      const generation = JSON.parse(frame.split('data: ')[1].split('\n')[0]).args[0]
      expect(generation).toMatch(/^[a-f0-9]{32}$/)
      const invoke = (value: string) => server.inject({ method: 'POST', url: '/web/invoke', headers: { ...headers, cookie }, payload: { clientId: CLIENT, storageScope, generation: value, channel: 'open', args: ['one.adf'] } })
      const stale = await invoke('old-generation')
      expect(stale.statusCode).toBe(409)
      expect(stale.json().code).toBe('web_tab_reset')
      expect((await invoke(generation)).statusCode).toBe(200)
    } finally { controller.abort() }
  })
  it('closes live SSE before HTTP shutdown and awaits the original tab cleanup', async () => {
    const f = factory()
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const close = vi.fn(() => pending)
    const createTab = async (opts: WebTabOptions) => ({ ...await f.createTab(opts), close })
    // start() deliberately uses ordinary Fastify shutdown, without forced sockets.
    const { server, login, scopeFor, baseUrl } = await start({ createTab })
    const cookie = await login()
    const controller = new AbortController()
    try {
      const response = await fetch(`${baseUrl}/web/events?clientId=${CLIENT}&storageScope=${scopeFor(cookie)}`, { headers: { cookie }, signal: controller.signal })
      const reader = response.body!.getReader()
      await readThrough(reader, 'web:tab-generation')
      let finished = false
      const closing = server.close().then(() => { finished = true })
      await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1))
      expect((await reader.read()).done).toBe(true)
      expect(finished).toBe(false)
      release()
      await closing
      expect(finished).toBe(true)
      expect(close).toHaveBeenCalledTimes(1)
    } finally { release(); controller.abort() }
  })
  it('serves internal media with a sandbox policy and no credential leakage', async () => {
    const { server, headers, login, loginResponse, scopeFor } = await start({ createTab: factory().createTab })
    const cookie = await login()
    const result = await server.inject({ url: `/web/file?clientId=${CLIENT}&storageScope=${scopeFor(cookie)}&path=image.svg`, headers: { ...headers, cookie } })
    expect(result.statusCode).toBe(200)
    expect(result.headers['content-security-policy']).toContain('sandbox')
    expect(result.headers['x-content-type-options']).toBe('nosniff')
    expect(result.body).toBe('<svg/>')
  })
  it('serves only compiled assets inside the static root, including symlink containment', async () => {
    const root = mkdtempSync(join(tmpdir(), 'adf-web-test-')); dirs.push(root)
    const publicDir = join(root, 'web'); mkdirSync(publicDir)
    writeFileSync(join(publicDir, 'index.html'), '<div>Studio</div>')
    writeFileSync(join(root, 'secret.js'), 'secret')
    symlinkSync(join(root, 'secret.js'), join(publicDir, 'escape.js'))
    const { server, headers } = await start({ root: publicDir })
    const index = await server.inject({ url: '/studio/', headers })
    expect(index.statusCode).toBe(200)
    expect(index.headers['content-security-policy']).toContain("frame-ancestors 'none'")
    expect((await server.inject({ url: '/studio/escape.js', headers })).statusCode).toBe(404)
    expect((await server.inject({ url: '/studio/%2e%2e/secret.js', headers })).statusCode).toBe(404)
  })
})
