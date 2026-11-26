// The Computer tab in browser Studio, end to end on loopback: a stand-in noVNC
// server (websockify echo), the daemon's desktop route in front of it, and the
// browser's cookie-authenticated stream route in front of that.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { createDaemonHttpApi } from '../src/main/daemon/http-api'
import { daemonHostAllowList } from '../src/main/daemon/request-guard'
import { RuntimeService } from '../src/main/runtime/runtime-service'

const TOKEN = 'a'.repeat(43)
const PROOF = 'p'.repeat(43)
const CONTAINER = 'adf-agent-1-3f1c9a2e'
const cleanups: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn() })

async function fakeNovnc(): Promise<number> {
  const server: Server = createServer((_req, res) => { res.writeHead(404).end() })
  const wss = new WebSocketServer({ server, path: '/websockify', handleProtocols: (p) => [...p][0] ?? false })
  wss.on('connection', (ws) => ws.on('message', (data) => ws.send(Buffer.concat([Buffer.from('echo:'), data as Buffer]))))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  cleanups.push(() => new Promise((r) => { wss.close(); server.close(() => r(undefined)) }))
  return (server.address() as AddressInfo).port
}

async function setup() {
  const novnc = await fakeNovnc()
  let port = 0
  const api = createDaemonHttpApi(new RuntimeService({ enforceReviewGate: false }), {
    computeService: { getNovncHostPort: async (name: string) => (name === CONTAINER ? novnc : null) } as never,
    security: { token: TOKEN, localProof: PROOF, allowedHosts: () => daemonHostAllowList('127.0.0.1', port) },
  })
  await api.listen({ host: '127.0.0.1', port: 0 })
  cleanups.push(() => api.close())
  port = (api.server.address() as AddressInfo).port
  const host = `127.0.0.1:${port}`
  const origin = `http://${host}`
  const launch = await api.inject({ method: 'POST', url: '/web/launch', headers: { host, authorization: `Bearer ${TOKEN}`, 'x-adf-local-proof': PROOF } })
  const ticket = new URLSearchParams(new URL(launch.json().url).hash.slice(1)).get('ticket')
  const login = await api.inject({ method: 'POST', url: '/web/session', headers: { host, origin, 'sec-fetch-site': 'same-origin' }, payload: { ticket } })
  expect(login.statusCode).toBe(200)
  const cookie = ([login.headers['set-cookie']].flat() as string[]).find((v) => v.startsWith('adf_web_session_'))!.split(';')[0]
  const storageScope = login.json().storageScope as string
  const stream = (container = CONTAINER, opts: { cookie?: string; origin?: string; scope?: string } = {}) =>
    new WebSocket(`ws://${host}/web/desktop/${container}/websockify?storageScope=${opts.scope ?? storageScope}`, ['binary'], {
      origin: opts.origin ?? origin,
      headers: opts.cookie === '' ? {} : { cookie: opts.cookie ?? cookie },
    })
  return { api, host, cookie, stream }
}

function echo(ws: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    ws.on('open', () => ws.send(Buffer.from('hi')))
    ws.on('message', (data) => resolve(String(data)))
    ws.on('error', reject)
  })
}

function refused(ws: WebSocket): Promise<boolean> {
  return new Promise((resolve) => {
    let opened = false
    ws.on('open', () => { opened = true })
    ws.on('error', () => {})
    ws.on('close', () => resolve(!opened))
  })
}

describe('browser Studio Computer tab stream', () => {
  it('relays the VNC stream for a signed-in browser tab', async () => {
    const { stream } = await setup()
    const ws = stream()
    expect(await echo(ws)).toBe('echo:hi')
    expect(ws.protocol).toBe('binary')
    ws.close()
  })

  it('refuses a request without the session cookie, from another origin, or from a previous sign-in', async () => {
    const { stream } = await setup()
    expect(await refused(stream(CONTAINER, { cookie: '' }))).toBe(true)
    expect(await refused(stream(CONTAINER, { origin: 'https://untrusted.example' }))).toBe(true)
    expect(await refused(stream(CONTAINER, { scope: 'stale-scope' }))).toBe(true)
  })

  it('carries nothing for a container that is not an agent desktop', async () => {
    const { stream } = await setup()
    const ws = stream('adf-other-12345678')
    const closed = await new Promise<number>((resolve) => { ws.on('error', () => {}); ws.on('close', (code) => resolve(code)) })
    expect(closed).not.toBe(1000)
  })

  it('allows four streams per browser session', async () => {
    const { stream } = await setup()
    const open: WebSocket[] = []
    // One at a time: echo() listens for 'open', which a socket opened earlier has already fired.
    for (let i = 0; i < 4; i++) { const ws = stream(); open.push(ws); expect(await echo(ws)).toBe('echo:hi') }
    expect(await refused(stream())).toBe(true)
    open[0].close()
    await new Promise((r) => setTimeout(r, 50))
    const again = stream()
    expect(await echo(again)).toBe('echo:hi')
    for (const ws of [...open, again]) ws.close()
  })

  it('closes open streams when the browser signs out', async () => {
    const { api, host, cookie, stream } = await setup()
    const ws = stream()
    expect(await echo(ws)).toBe('echo:hi')
    const closed = new Promise<void>((resolve) => ws.on('close', () => resolve()))
    const out = await api.inject({ method: 'DELETE', url: '/web/session', headers: { host, origin: `http://${host}`, 'sec-fetch-site': 'same-origin', cookie } })
    expect(out.statusCode).toBeLessThan(400)
    await closed
  })
})
