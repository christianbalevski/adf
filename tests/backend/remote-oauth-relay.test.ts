/**
 * OAuth sign-in against a remote daemon (design §9.3, tracker W4-B): Studio
 * takes the browser's loopback callback on this computer and hands it to the
 * daemon (POST /oauth/relay), which delivers it to its own loopback callback.
 *
 * One machine plays both: the "daemon host" callback listens on 127.0.0.1,
 * Studio's relay on 127.0.0.2 at the same port (where the browser of another
 * computer would land). Skipped where 127.0.0.2 cannot be bound (macOS
 * without a loopback alias).
 */
import Fastify, { type FastifyInstance } from 'fastify'
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { checkRemoteBrowserUrl, loopbackRedirectOf, OAuthCallbackRelay } from '../../src/main/backend/daemon-mode/remote/oauth-relay'
import { registerOAuthRelayRoutes } from '../../src/main/daemon/routes/oauth-relay-routes'

const quiet = { log: () => {}, warn: () => {} }
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c() })

async function listen(server: Server, host = '127.0.0.1', port = 0): Promise<number> {
  await new Promise<void>((done, fail) => { server.once('error', fail); server.listen(port, host, () => done()) })
  cleanups.push(() => new Promise<void>((done) => server.close(() => done())))
  const a = server.address()
  return typeof a === 'object' && a ? a.port : 0
}

async function daemonApi(): Promise<{ app: FastifyInstance; url: string }> {
  const app = Fastify()
  registerOAuthRelayRoutes(app, {} as never)
  await app.listen({ port: 0, host: '127.0.0.1' })
  cleanups.push(() => app.close())
  const a = app.server.address()
  return { app, url: `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}` }
}

const canBindAlias = await (async () => {
  const s = createServer()
  try {
    await new Promise<void>((done, fail) => { s.once('error', fail); s.listen(0, '127.0.0.2', () => done()) })
    await new Promise<void>((done) => s.close(() => done()))
    return true
  } catch { return false }
})()

describe('which sign-in pages Studio opens for a remote daemon', () => {
  it.each([
    ['https://auth.example.com/authorize?x=1', true],
    ['https://203.0.113.9/authorize', true],
    ['http://auth.example.com/authorize', false],
    ['https://user:pw@auth.example.com/authorize', false],
    ['https://localhost/authorize', false],
    ['https://127.0.0.1:8443/authorize', false],
    ['https://[::1]/authorize', false],
    ['https://169.254.169.254/latest', false],
    ['https://0.0.0.0/x', false],
    ['javascript:alert(1)', false],
    ['file:///etc/passwd', false],
    ['not a url', false],
  ])('%s → %s', (url, ok) => {
    expect(checkRemoteBrowserUrl(url).ok).toBe(ok)
  })

  it('reads a loopback redirect_uri only', () => {
    const at = (redirect: string) => loopbackRedirectOf(new URL(`https://auth.example.com/a?redirect_uri=${encodeURIComponent(redirect)}`))
    expect(at('http://127.0.0.1:53817/callback')).toEqual({ uri: 'http://127.0.0.1:53817/callback', host: '127.0.0.1', port: 53817, path: '/callback' })
    expect(at('http://localhost:1455/auth/callback')).toMatchObject({ host: '127.0.0.1', port: 1455, path: '/auth/callback' })
    expect(at('http://[::1]:53817/callback')).toMatchObject({ host: '::1', port: 53817 })
    expect(at('https://app.example.com/callback')).toBeNull()
    expect(at('http://127.0.0.1/callback')).toBeNull()
    expect(loopbackRedirectOf(new URL('https://auth.example.com/a'))).toBeNull()
  })
})

describe('POST /oauth/relay (daemon)', () => {
  it('delivers only the OAuth parameters to a loopback callback, follows no redirect and returns no body', async () => {
    const hits: string[] = []
    const callbackPort = await listen(createServer((req, res) => {
      hits.push(req.url ?? '')
      if (req.url?.startsWith('/redirecting')) { res.writeHead(302, { Location: 'http://127.0.0.1:1/elsewhere' }); res.end(); return }
      res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('secret body')
    }))
    const { app } = await daemonApi()
    const ok = await app.inject({ method: 'POST', url: '/oauth/relay', payload: { redirectUri: `http://127.0.0.1:${callbackPort}/callback`, params: { code: 'c0de', state: 's7a7e', iss: 'https://auth.example.com' } } })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toEqual({ delivered: true, status: 200 })
    expect(ok.body).not.toContain('secret body')
    expect(hits).toEqual(['/callback?code=c0de&state=s7a7e&iss=https%3A%2F%2Fauth.example.com'])

    const redirect = await app.inject({ method: 'POST', url: '/oauth/relay', payload: { redirectUri: `http://127.0.0.1:${callbackPort}/redirecting`, params: { error: 'access_denied', state: 's' } } })
    expect(redirect.json()).toEqual({ delivered: false, status: 302 })
    expect(hits).toHaveLength(2)
  })

  it('refuses anything but a loopback http callback with OAuth parameters', async () => {
    const { app, url } = await daemonApi()
    const daemonPort = Number(new URL(url).port)
    const post = async (payload: unknown, viaSocket = false) => {
      if (!viaSocket) return (await app.inject({ method: 'POST', url: '/oauth/relay', payload })).statusCode
      const res = await fetch(`${url}/oauth/relay`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      return res.status
    }
    const params = { code: 'c', state: 's' }
    expect(await post({ redirectUri: 'http://10.0.0.5:53817/callback', params })).toBe(400)
    expect(await post({ redirectUri: 'https://127.0.0.1:53817/callback', params })).toBe(400)
    expect(await post({ redirectUri: 'http://127.0.0.1/callback', params })).toBe(400)
    expect(await post({ redirectUri: 'http://127.0.0.1:80/callback', params })).toBe(400)
    expect(await post({ redirectUri: 'http://user:pw@127.0.0.1:53817/callback', params })).toBe(400)
    expect(await post({ redirectUri: 'http://127.0.0.1:53817/callback', params: { code: 'c' } })).toBe(400)
    expect(await post({ redirectUri: 'http://127.0.0.1:53817/callback', params: { state: 's' } })).toBe(400)
    expect(await post({ redirectUri: 'http://127.0.0.1:53817/callback', params: { ...params, token: 'x' } })).toBe(400)
    expect(await post({ redirectUri: 'http://127.0.0.1:53817/callback', params: { ...params, code: 'x'.repeat(9000) } })).toBe(400)
    expect(await post({ redirectUri: `http://127.0.0.1:${daemonPort}/callback`, params }, true)).toBe(400)
  })

  it('a callback nobody waits for any more: 502 relay_unreachable with a sentence', async () => {
    const closed = createServer()
    const port = await listen(closed)
    await new Promise<void>((done) => closed.close(() => done()))
    cleanups.pop()
    const { app } = await daemonApi()
    const res = await app.inject({ method: 'POST', url: '/oauth/relay', payload: { redirectUri: `http://127.0.0.1:${port}/callback`, params: { code: 'c', state: 's' } } })
    expect(res.statusCode).toBe(502)
    expect(res.json()).toMatchObject({ code: 'relay_unreachable', error: expect.stringMatching(/No sign-in is waiting at 127\.0\.0\.1:\d+\/callback.*start the sign-in again/) })
  })
})

describe.skipIf(!canBindAlias)('relay end to end (Studio on 127.0.0.2, daemon host on 127.0.0.1)', () => {
  async function setup() {
    const daemonCallbacks: string[] = []
    // The daemon's MCP OAuth callback server (mcp-http-oauth.ts shape: GET /callback?code&state).
    const callbackPort = await listen(createServer((req, res) => { daemonCallbacks.push(req.url ?? ''); res.writeHead(200); res.end('ok') }))
    const { app } = await daemonApi()
    const opened: string[] = []
    const relay = new OAuthCallbackRelay({
      relay: async (body) => {
        const res = await app.inject({ method: 'POST', url: '/oauth/relay', payload: body })
        return res.statusCode === 200 ? res.json() : { delivered: false, status: res.statusCode, error: res.json().error }
      },
      openExternal: (url) => { opened.push(url) },
      log: quiet,
      bindHost: '127.0.0.2',
    })
    cleanups.push(() => relay.closeAll())
    const authorize = `https://auth.example.com/authorize?client_id=x&state=s-123&redirect_uri=${encodeURIComponent(`http://127.0.0.1:${callbackPort}/callback`)}`
    return { relay, opened, daemonCallbacks, callbackPort, authorize }
  }

  it('opens the page, refuses a callback with another state, relays the real one to the daemon host', async () => {
    const { relay, opened, daemonCallbacks, callbackPort, authorize } = await setup()
    expect(await relay.open(authorize, 'test sign-in')).toEqual({ opened: true, relaying: true })
    expect(opened).toEqual([authorize])
    // A stray or forged hit on this computer's callback port.
    const forged = await fetch(`http://127.0.0.2:${callbackPort}/callback?code=evil&state=other`)
    expect(forged.status).toBe(400)
    expect(daemonCallbacks).toEqual([])
    // The browser after sign-in.
    const browser = await fetch(`http://127.0.0.2:${callbackPort}/callback?code=c0de&state=s-123&extra=dropped`)
    expect(browser.status).toBe(200)
    expect(await browser.text()).toMatch(/Signed in/)
    expect(daemonCallbacks).toEqual(['/callback?code=c0de&state=s-123'])
    expect(relay.active).toBe(0)
  })

  it('refuses to open a page that is not https, and opens without relaying when the port is taken here', async () => {
    const { relay, opened, callbackPort, authorize } = await setup()
    expect(await relay.open(authorize.replace('https:', 'http:'), 'test sign-in')).toMatchObject({ opened: false, relaying: false, reason: expect.stringMatching(/not an https page/) })
    expect(opened).toEqual([])
    const squatter = createServer()
    await listen(squatter, '127.0.0.2', callbackPort)
    expect(await relay.open(authorize, 'test sign-in')).toMatchObject({ opened: true, relaying: false, reason: expect.stringMatching(/in use/) })
    expect(opened).toEqual([authorize])
  })
})
