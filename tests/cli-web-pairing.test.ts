/** Browser pairing, host approval and revocation need no Electron process. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir, type NetworkInterfaceInfo } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => { throw new Error('Headless browser pairing must not import Electron') })

import { createDaemonHttpApi } from '../src/main/daemon/http-api'
import { RemoteAccessService } from '../src/main/daemon/remote-access/service'
import { lanNetworkId } from '../src/main/daemon/remote-access/network-key'
import { daemonHostAllowList } from '../src/main/daemon/request-guard'
import { DAEMON_TOKEN_FILENAME } from '../src/main/daemon/daemon-token'
import { localProofPath } from '../src/main/daemon/local-access'
import { RuntimeService } from '../src/main/runtime/runtime-service'
import { runHostRemoteCommand, type HostCliIo } from '../src/main/cli/remote-access-cli'

const TOKEN = 't'.repeat(43)
const PROOF = 'p'.repeat(43)
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })

async function freePort(): Promise<number> {
  for (let i = 0; i < 100; i++) {
    const port = 20_000 + Math.floor(Math.random() * 10_000)
    const probe = createServer()
    const available = await new Promise<boolean>(resolve => {
      probe.once('error', () => resolve(false))
      probe.listen(port, '127.0.0.1', () => resolve(true))
    })
    if (available) { await new Promise<void>(resolve => probe.close(() => resolve())); return port }
  }
  throw new Error('No free isolated pairing-test port')
}

async function host() {
  const dataDir = mkdtempSync(join(tmpdir(), 'adf-cli-web-pairing-'))
  const remotePort = await freePort()
  const networkId = lanNetworkId('00:00:5e:00:01:01', '192.168.77.0/24', null)
  writeFileSync(join(dataDir, 'remote-access.json'), JSON.stringify({
    v: 1, enabled: false, name: 'Headless host', daemonId: null,
    allowedNetworks: [{ id: networkId, kind: 'lan', label: 'Test network', addedAt: new Date().toISOString() }],
  }))
  const service = new RemoteAccessService({
    settingsDir: dataDir, port: remotePort, clientApiVersion: 2, platform: 'linux', hostName: () => 'Headless host',
    interfaces: () => ({ eth0: [{ address: '192.168.77.10', family: 'IPv4', internal: false, netmask: '255.255.255.0', mac: '00:00:00:00:00:01', cidr: '192.168.77.10/24' } as NetworkInterfaceInfo] }),
    gateways: async ifaces => new Map(ifaces.map(iface => [iface, '192.168.77.1|00:00:5e:00:01:01'])),
    wifiNames: async () => new Map(), osCategories: async () => new Map(),
    tailscale: {
      self: async () => ({ state: 'absent', ips: [], dnsName: null }),
      serveStatus: async () => ({ serve: 'unknown', httpsUrl: null }),
      setServe: async () => { throw new Error('No real network changes in this test') },
      serveCommand: () => [], whois: async () => null, command: null,
    },
    announcer: { announcing: false, problem: null, announce: async () => {}, stop: async () => {} },
    firewall: async () => ({ state: 'unknown', message: 'Isolated test', commands: [] }),
    bindAddress: () => '127.0.0.1', wrongCodeDelayMs: 0, log: () => {},
  })
  let port = 0
  const server = createDaemonHttpApi(new RuntimeService({ enforceReviewGate: false }), {
    routes: { remoteAccess: service },
    security: { token: TOKEN, localProof: PROOF, allowedHosts: () => [...daemonHostAllowList('127.0.0.1', port), { host: '127.0.0.1', port: remotePort }] },
  })
  await server.listen({ host: '127.0.0.1', port: 0 })
  port = (server.server.address() as { port: number }).port
  await service.attach((request, response) => server.routing(request, response))
  cleanup.push(async () => { await service.shutdown(); await server.close(); rmSync(dataDir, { recursive: true, force: true }) })
  writeFileSync(join(dataDir, DAEMON_TOKEN_FILENAME), TOKEN)
  writeFileSync(localProofPath(dataDir, port), PROOF)
  const out: string[] = [], err: string[] = []
  let decide: ((answer: string) => void) | null = null
  const io: HostCliIo = {
    fetch, stdout: text => out.push(text), stderr: text => err.push(text),
    prompt: question => { err.push(question); return new Promise(resolve => { decide = resolve }) },
    sleep: () => new Promise(resolve => setTimeout(resolve, 10)),
  }
  const target = { url: `http://127.0.0.1:${port}`, port, dataDir }
  const run = (sub: 'remote' | 'devices' | 'pair', ...args: string[]) => runHostRemoteCommand(sub, args, io, target)
  const origin = `http://127.0.0.1:${remotePort}`
  const request = (path: string, init: RequestInit = {}) => fetch(origin + path, { ...init, headers: { origin, 'sec-fetch-site': 'same-origin', ...init.headers } })
  return { run, out, err, request, remotePort, answer: (value: string) => { if (!decide) throw new Error('No terminal approval prompt'); decide(value) } }
}

async function pairInBrowser(h: Awaited<ReturnType<typeof host>>) {
  expect(await h.run('remote', 'on')).toBe(0)
  h.out.length = 0
  const hostDone = h.run('pair')
  await vi.waitFor(() => expect(h.out.join('')).toMatch(/Code: \d{3} \d{3}/))
  const match = /Code: (\d{3}) (\d{3})/.exec(h.out.join(''))!
  expect(h.out.join('')).toContain(`http://192.168.77.10:${h.remotePort}/studio/`)
  expect(h.out.join('')).toContain('return to this terminal to approve')
  const response = await h.request('/web/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: match[1] + match[2], deviceName: 'Tablet browser' }) })
  expect(response.status).toBe(202)
  expect(await response.json()).toMatchObject({ state: 'pending' })
  const cookie = response.headers.getSetCookie()[0].split(';')[0]
  await vi.waitFor(() => expect(h.err.join('')).toContain('Allow "Tablet browser" (127.0.0.1, this network)'))
  expect((await h.request('/web/session', { headers: { cookie } })).status).toBe(401)
  expect(await (await h.request('/web/pair', { headers: { cookie } })).json()).toMatchObject({ state: 'pending' })
  return { hostDone, cookie }
}

describe('browser pairing against the standalone daemon and host CLI', () => {
  it('requires terminal approval, then permits browser use and terminal revocation', async () => {
    const h = await host()
    const { hostDone, cookie } = await pairInBrowser(h)
    h.answer('y')
    expect(await hostDone).toBe(0)
    const approved = await h.request('/web/pair', { headers: { cookie } })
    expect(approved.status).toBe(200)
    const body = await approved.json() as Record<string, unknown>
    expect(body).toMatchObject({ state: 'approved', authenticated: true })
    expect(body).not.toHaveProperty('token')
    const cookies = approved.headers.getSetCookie().map(value => value.split(';')[0])
    const session = cookies.find(value => value.startsWith('adf_web_session_'))!
    const remembered = cookies.find(value => value.startsWith('adf_web_device_'))!
    expect((await h.request('/web/session', { headers: { cookie: `${session}; ${remembered}` } })).status).toBe(200)
    h.out.length = 0
    expect(await h.run('devices', 'list')).toBe(0)
    expect(h.out.join('')).toContain('Tablet browser')
    expect(await h.run('devices', 'revoke', 'Tablet browser')).toBe(0)
    expect((await h.request('/web/session', { headers: { cookie: session } })).status).toBe(401)
    expect((await h.request('/web/session', { headers: { cookie: remembered } })).status).toBe(401)
  })

  it('denies a browser from the terminal without issuing browser credentials', async () => {
    const h = await host()
    const { hostDone, cookie } = await pairInBrowser(h)
    h.answer('n')
    expect(await hostDone).toBe(1)
    const refused = await h.request('/web/pair', { headers: { cookie } })
    expect(await refused.json()).toEqual({ state: 'denied' })
    expect(refused.headers.getSetCookie().join(';')).not.toContain('adf_web_session_')
    expect(refused.headers.getSetCookie().join(';')).not.toContain('adf_web_device_')
    h.out.length = 0
    expect(await h.run('devices', 'list')).toBe(0)
    expect(h.out.join('')).toContain('No computers yet.')
    expect((await h.request('/web/session', { headers: { cookie } })).status).toBe(401)
  })
})
