// Egress pinning beyond guardedFetch (tracker §6, W4-B follow-up owned by
// W5-A). Written first as a characterization of the guard and of sys_fetch /
// ws_connect as they were (E3); each fix commit flips the rows it changes.
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'

/** Scripted DNS answers per host name (in order); other names resolve for real. */
const dnsScript = vi.hoisted(() => new Map<string, string[]>())
vi.mock('node:dns/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:dns/promises')>()
  const lookup = (async (host: string, opts?: unknown) => {
    const answers = dnsScript.get(host)
    if (!answers || answers.length === 0) return real.lookup(host, opts as never)
    const address = answers.length > 1 ? answers.shift()! : answers[0]
    const family = address.includes(':') ? 6 : 4
    return (opts as { all?: boolean } | undefined)?.all ? [{ address, family }] : { address, family }
  }) as typeof real.lookup
  return { ...real, lookup, default: { ...real, lookup } }
})
import { checkConnectTarget, checkFetchTarget, envProxyFor, isCloudMetadataIp } from '../../../src/main/utils/ssrf-guard'
import { SysFetchTool } from '../../../src/main/tools/built-in/sys-fetch.tool'
import { WsConnectionManager, type WsManagerDelegate } from '../../../src/main/services/ws-connection-manager'
import type { AdfWorkspace } from '../../../src/main/adf/adf-workspace'

const servers: Array<{ close(cb: () => void): void }> = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((done) => s.close(() => done()))))
  dnsScript.clear()
  delete process.env.ADF_DAEMON_PORT
})

async function httpServer(): Promise<{ port: number; hits: string[] }> {
  const hits: string[] = []
  const s: Server = createServer((req, res) => { hits.push(req.url ?? ''); res.end('reached') })
  servers.push(s)
  await new Promise<void>((done) => s.listen(0, '127.0.0.1', () => done()))
  return { port: (s.address() as { port: number }).port, hits }
}

const workspace = { insertLog: () => {} } as unknown as AdfWorkspace

describe('NAT64 local-use 64:ff9b:1::/48 and Teredo 2001::/32', () => {
  it('after: classified as the IPv4 address they carry', async () => {
    const open = { allowLocal: true, allowLinkLocal: true }
    // 64:ff9b:1::a9fe:a9fe carries 169.254.169.254 in its last 32 bits.
    expect(isCloudMetadataIp('64:ff9b:1::a9fe:a9fe')).toBe(true)
    expect(await checkFetchTarget('http://[64:ff9b:1::a9fe:a9fe]/latest/', open)).toMatch(/cloud-metadata/)
    expect(await checkFetchTarget('http://[64:ff9b:1::c0a8:105]/')).toMatch(/private-network/) // 192.168.1.5
    expect(await checkConnectTarget('ws://[64:ff9b:1::7f00:1]:7385/', { daemonPort: 7385 })).toMatch(/daemon/)
    // Teredo: the client IPv4 is the last 32 bits inverted (5601:5601 → 169.254.169.254).
    expect(isCloudMetadataIp('2001:0:4136:e378:8000:63bf:5601:5601')).toBe(true)
    expect(await checkFetchTarget('http://[2001:0:4136:e378:8000:63bf:5601:5601]/', open)).toMatch(/cloud-metadata/)
    expect(await checkFetchTarget('http://[2001:0:4136:e378:8000:63bf:3f57:fefe]/')).toMatch(/private-network/) // 192.168.1.1
    // A public address behind them stays allowed; documentation 2001:db8::/32 is not Teredo.
    expect(await checkFetchTarget('http://[64:ff9b:1::5db8:d822]/')).toBeNull() // 93.184.216.34
    expect(await checkFetchTarget('http://[2001:0:4136:e378:8000:63bf:a247:27dd]/')).toBeNull() // 93.184.216.34 inverted
    expect(await checkFetchTarget('http://[2001:db8::1]/')).toBeNull()
  })
})

describe('a host name behind an HTTP proxy (NODE_USE_ENV_PROXY)', () => {
  const saved = { ...process.env }
  afterEach(() => {
    for (const key of ['NODE_USE_ENV_PROXY', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy']) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  })

  function proxyEnv(vars: Record<string, string>): void {
    for (const key of ['NODE_USE_ENV_PROXY', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy']) delete process.env[key]
    Object.assign(process.env, vars)
  }

  it('after: left to the proxy, which looks it up; literal addresses and loopback names are still checked', async () => {
    proxyEnv({ NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'http://127.0.0.1:9' })
    expect(await checkFetchTarget('https://no-such-host.invalid/')).toBeNull()
    expect(await checkFetchTarget('https://169.254.169.254/latest/', { allowLocal: true })).toMatch(/cloud-metadata/)
    expect(await checkFetchTarget('https://10.0.0.1/')).toMatch(/private-network/)
    expect(await checkFetchTarget('https://localhost:7385/', { daemonPort: 7385 })).toMatch(/daemon/)
    // http has no proxy configured: this machine looks the name up.
    expect(await checkFetchTarget('http://no-such-host.invalid/')).toMatch(/could not be looked up/)
    // ws_connect never goes through the env proxy.
    expect(await checkConnectTarget('wss://no-such-host.invalid/')).toMatch(/could not be looked up/)
  })

  it('after: a host NO_PROXY names, or NODE_USE_ENV_PROXY off, is looked up here as before', async () => {
    proxyEnv({ NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'http://127.0.0.1:9', NO_PROXY: 'example.com, .invalid' })
    expect(await checkFetchTarget('https://no-such-host.invalid/')).toMatch(/could not be looked up/)
    proxyEnv({ HTTPS_PROXY: 'http://127.0.0.1:9' })
    expect(await checkFetchTarget('https://no-such-host.invalid/')).toMatch(/could not be looked up/)
  })

  it('envProxyFor reads the proxy as Node\'s fetch does', () => {
    const env = { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: 'http://proxy:3128', NO_PROXY: 'exact.example, .corp.example, *.wild.example, ported.example:8443' }
    expect(envProxyFor('https://a.example/', env)).toBe('http://proxy:3128') // https falls back to HTTP_PROXY
    expect(envProxyFor('http://exact.example/', env)).toBeNull()
    expect(envProxyFor('http://sub.exact.example/', env)).toBe('http://proxy:3128')
    expect(envProxyFor('http://a.corp.example/', env)).toBeNull()
    expect(envProxyFor('http://a.wild.example/', env)).toBeNull()
    expect(envProxyFor('https://ported.example:8443/', env)).toBeNull()
    expect(envProxyFor('https://ported.example/', env)).toBe('http://proxy:3128')
    expect(envProxyFor('ws://a.example/', env)).toBeNull()
    expect(envProxyFor('http://a.example/', { ...env, NO_PROXY: '*' })).toBeNull()
    expect(envProxyFor('http://a.example/', { ...env, NODE_USE_ENV_PROXY: '0' })).toBeNull()
  })
})

describe('sys_fetch: the guard and the connection resolve the host separately', () => {
  it('before: a name only the guard\'s lookup knows passes the guard, then the connection\'s own lookup fails', async () => {
    const { port, hits } = await httpServer()
    dnsScript.set('pinned.adf-test.invalid', ['127.0.0.1'])
    expect(await checkFetchTarget(`http://pinned.adf-test.invalid:${port}/x`)).toBeNull()
    const r = await new SysFetchTool().execute({ url: `http://pinned.adf-test.invalid:${port}/x`, method: 'GET', timeout_ms: 10000 }, workspace)
    expect(r.isError).toBe(true)
    expect(hits).toEqual([])
  }, 20000)
})

function wsManager(): WsConnectionManager {
  const delegate = {
    getAgentDid: () => null,
    getPrivateKey: () => null,
    getPublicKey: () => null,
    processIngressMessage: async () => ({}),
    getCodeSandbox: () => null,
    getAdfCallHandler: () => null,
    getWorkspace: () => null,
    getToolConfig: () => null,
    getAllowUnsigned: () => true,
  } satisfies WsManagerDelegate
  return new WsConnectionManager(delegate)
}

async function wsServer(): Promise<{ port: number; connections: number[] }> {
  const connections: number[] = []
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  servers.push(wss)
  wss.on('connection', () => connections.push(Date.now()))
  await new Promise<void>((done) => wss.once('listening', () => done()))
  return { port: (wss.address() as { port: number }).port, connections }
}

describe('ws_connect: the guard and the connection resolve the host separately', () => {
  it('before: a name only the guard\'s lookup knows passes the guard, then the socket\'s own lookup fails', async () => {
    const { port, connections } = await wsServer()
    dnsScript.set('pinned.adf-test.invalid', ['127.0.0.1'])
    const url = `ws://pinned.adf-test.invalid:${port}/`
    expect(await checkConnectTarget(url)).toBeNull()
    const mgr = wsManager()
    const result = await mgr.connectOutbound('agent-1.adf', { id: 'c1', url, enabled: true, auth: 'none', auto_reconnect: false })
    expect(result.error).toBeTruthy()
    expect(connections).toEqual([])
    mgr.unregisterAgent('agent-1.adf')
  }, 20000)
})
