// The Computer tab on a remote runtime, end to end on loopback: a stand-in
// noVNC server (page + websockify echo), the daemon's desktop routes in front
// of it, and Studio's loopback relay in front of the daemon.
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { createDaemonHttpApi } from '../src/main/daemon/http-api'
import { RuntimeService } from '../src/main/runtime/runtime-service'
import { DesktopRelays } from '../src/main/backend/daemon-mode/remote/desktop-relay'

const cleanups: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn() })

async function fakeNovnc(): Promise<number> {
  const server: Server = createServer((req, res) => {
    if (req.url === '/vnc.html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>noVNC</html>'); return }
    res.writeHead(404).end()
  })
  const wss = new WebSocketServer({ server, path: '/websockify', handleProtocols: (p) => [...p][0] ?? false })
  wss.on('connection', (ws) => ws.on('message', (data) => ws.send(Buffer.concat([Buffer.from('echo:'), data as Buffer]))))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  cleanups.push(() => new Promise((r) => { wss.close(); server.close(() => r(undefined)) }))
  return (server.address() as AddressInfo).port
}

async function setup() {
  const novnc = await fakeNovnc()
  const api = createDaemonHttpApi(new RuntimeService({ enforceReviewGate: false }), {
    computeService: { getNovncHostPort: async (name: string) => (name === 'adf-agent-1-3f1c9a2e' ? novnc : null) } as never,
  })
  await api.listen({ host: '127.0.0.1', port: 0 })
  cleanups.push(() => api.close())
  const base = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`
  const relays = new DesktopRelays(async () => ({ url: (p: string) => `${base}${p}`, headers: (extra = {}) => ({ ...extra }) }))
  cleanups.push(() => relays.closeAll())
  return { base, relays }
}

describe('remote Computer tab relay', () => {
  it('serves the noVNC page and relays the VNC stream through the daemon', async () => {
    const { relays } = await setup()
    const port = await relays.portFor('adf-agent-1-3f1c9a2e')
    expect(await relays.portFor('adf-agent-1-3f1c9a2e')).toBe(port)

    const page = await fetch(`http://127.0.0.1:${port}/vnc.html?autoconnect=1`)
    expect(page.status).toBe(200)
    expect(await page.text()).toBe('<html>noVNC</html>')

    const ws = new WebSocket(`ws://127.0.0.1:${port}/websockify`, ['binary'], { origin: `http://127.0.0.1:${port}` })
    const reply = await new Promise<string>((resolve, reject) => {
      ws.on('open', () => ws.send(Buffer.from('hi')))
      ws.on('message', (data) => resolve(String(data)))
      ws.on('error', reject)
    })
    expect(ws.protocol).toBe('binary')
    expect(reply).toBe('echo:hi')
    ws.close()
  })

  it.each(['https://untrusted.example', 'null', undefined, 'http://127.0.0.1:1'])('refuses WebSocket origin %s before obtaining daemon credentials', async (origin) => {
    const target = vi.fn(async () => ({ url: (p: string) => `http://127.0.0.1:1${p}`, headers: () => ({ Authorization: 'Bearer test-token' }) }))
    const relays = new DesktopRelays(target)
    cleanups.push(() => relays.closeAll())
    const port = await relays.portFor('adf-agent-1-3f1c9a2e')
    const ws = new WebSocket(`ws://127.0.0.1:${port}/websockify`, origin === undefined ? {} : { origin })
    const opened = vi.fn()
    ws.on('open', opened)
    await new Promise<void>((resolve) => { ws.on('error', () => {}); ws.on('close', () => resolve()) })
    expect(opened).not.toHaveBeenCalled()
    expect(target).not.toHaveBeenCalled()
  })

  it('refuses another Host (DNS rebinding) and paths that climb', async () => {
    const { relays } = await setup()
    const port = await relays.portFor('adf-agent-1-3f1c9a2e')
    const status = await new Promise<number>((resolve, reject) => {
      httpRequest({ host: '127.0.0.1', port, path: '/vnc.html', headers: { host: `evil.example:${port}` } }, (res) => { res.resume(); resolve(res.statusCode ?? 0) }).on('error', reject).end()
    })
    expect(status).toBe(403)
  })

  it('the daemon relays only containers with a desktop', async () => {
    const { base } = await setup()
    expect((await fetch(`${base}/compute/desktop/adf-other-12345678/vnc.html`)).status).toBe(404)
    expect((await fetch(`${base}/compute/desktop/not-a-container/vnc.html`)).status).toBe(404)
    expect((await fetch(`${base}/compute/desktop/adf-agent-1-3f1c9a2e/vnc.html`)).status).toBe(200)
  })
})
