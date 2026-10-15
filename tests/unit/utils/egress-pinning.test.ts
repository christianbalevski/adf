// Egress pinning beyond guardedFetch (tracker §6, W4-B follow-up owned by
// W5-A). Written first as a characterization of the guard and of sys_fetch /
// ws_connect as they were (E3); each fix commit flips the rows it changes.
import { createServer, type Server } from 'node:http'
import { gzipSync } from 'node:zlib'
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
import { checkConnectTarget, checkFetchTarget, embeddedIPv4s, envProxyEnabled, envProxyFor, isCloudMetadataIp } from '../../../src/main/utils/ssrf-guard'
import { SysFetchTool } from '../../../src/main/tools/built-in/sys-fetch.tool'
import { pinnedFetch } from '../../../src/main/utils/guarded-fetch'
import { WsConnectionManager, type WsManagerDelegate } from '../../../src/main/services/ws-connection-manager'
import { WsConnectTool } from '../../../src/main/tools/built-in/ws-connect.tool'
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

describe('local-use NAT64 prefixes /48 to /64 and ISATAP', () => {
  it('after: classified as the IPv4 address they carry (RFC 6052 embedding by prefix length; ISATAP interface id)', async () => {
    const open = { allowLocal: true, allowLinkLocal: true }
    expect(embeddedIPv4s('64:ff9b:1:a9fe:a9:fe00::')).toContain('169.254.169.254') // /48
    expect(embeddedIPv4s('64:ff9b:1:12a9:fe:a9fe::')).toContain('169.254.169.254') // /56
    expect(embeddedIPv4s('64:ff9b:1:1234:a9:fea9:fe00:0')).toContain('169.254.169.254') // /64
    for (const ip of ['64:ff9b:1:a9fe:a9:fe00::', '64:ff9b:1:12a9:fe:a9fe::', '64:ff9b:1:1234:a9:fea9:fe00:0', '2001:db8:1::5efe:169.254.169.254', '2001:db8:1::200:5efe:a9fe:a9fe', '::5efe:a9fe:a9fe']) {
      expect(isCloudMetadataIp(ip), ip).toBe(true)
      expect(await checkFetchTarget(`http://[${ip}]/latest/`, open), ip).toMatch(/cloud-metadata/)
    }
    expect(await checkFetchTarget('http://[2001:db8:1::5efe:c0a8:105]/')).toMatch(/private-network/) // ISATAP 192.168.1.5
    expect(await checkConnectTarget('ws://[64:ff9b:1:7f00:1:100::]:7385/', { daemonPort: 7385 })).toMatch(/daemon/) // /48 127.0.0.1
    // A public address under each reading stays allowed: 93.184.216.34 in a /48 prefix.
    expect(await checkFetchTarget('http://[64:ff9b:1:5db8:d8:2200::]/')).toBeNull()
    // The u-octet (bits 64-71) must be zero for an embedding.
    expect(embeddedIPv4s('64:ff9b:1:a9fe:ffa9:fe00::')).toEqual([])
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

  it('a name this machine does resolve is checked as any other; only ENOTFOUND / EAI_AGAIN are left to the proxy', async () => {
    proxyEnv({ NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'http://127.0.0.1:9' })
    dnsScript.set('meta.adf-test.invalid', ['169.254.169.254'])
    dnsScript.set('daemon.adf-test.invalid', ['127.0.0.1'])
    dnsScript.set('lan.adf-test.invalid', ['10.0.0.7'])
    dnsScript.set('public.adf-test.invalid', ['93.184.216.34'])
    expect(await checkFetchTarget('https://meta.adf-test.invalid/latest/', { allowLocal: true })).toMatch(/cloud-metadata/)
    expect(await checkFetchTarget('https://daemon.adf-test.invalid:7385/', { allowLocal: true, daemonPort: 7385 })).toMatch(/daemon control API/)
    expect(await checkFetchTarget('https://lan.adf-test.invalid/')).toMatch(/private-network/)
    expect(await checkFetchTarget('https://public.adf-test.invalid/')).toBeNull()
    expect(await checkFetchTarget('https://no-such-host.invalid/')).toBeNull() // ENOTFOUND: the proxy resolves it
  })

  it('only what Node honours turns the proxy on: NODE_USE_ENV_PROXY=1 or --use-env-proxy', async () => {
    const base = { HTTP_PROXY: 'http://proxy:3128' }
    for (const value of ['true', 'yes', 'on', ' 1']) {
      expect(envProxyEnabled({ ...base, NODE_USE_ENV_PROXY: value }, []), value).toBe(false)
      expect(envProxyFor('http://a.example/', { ...base, NODE_USE_ENV_PROXY: value }, []), value).toBeNull()
    }
    expect(envProxyEnabled({ NODE_USE_ENV_PROXY: '1' }, [])).toBe(true)
    expect(envProxyEnabled({}, ['--use-env-proxy'])).toBe(true)
    expect(envProxyEnabled({ NODE_OPTIONS: '--max-old-space-size=4096 --use-env-proxy' }, [])).toBe(true)
    expect(envProxyEnabled({ NODE_OPTIONS: '--use-env-proxy-not' }, [])).toBe(false)
    // `true` is not honoured by Node's fetch, which then connects directly: the guard looks the name up itself.
    proxyEnv({ NODE_USE_ENV_PROXY: 'true', HTTPS_PROXY: 'http://127.0.0.1:9' })
    expect(await checkFetchTarget('https://no-such-host.invalid/')).toMatch(/could not be looked up/)
  })
})

describe('sys_fetch: the connection uses the addresses the guard checked', () => {
  it('after: a name only the checked lookup knows is reached, with its Host header', async () => {
    const { port, hits } = await httpServer()
    dnsScript.set('pinned.adf-test.invalid', ['127.0.0.1'])
    const r = await new SysFetchTool().execute({ url: `http://pinned.adf-test.invalid:${port}/x`, method: 'GET', timeout_ms: 10000 }, workspace)
    expect(r.isError).toBe(false)
    expect(JSON.parse(r.content)).toMatchObject({ status: 200, body: 'reached' })
    expect(hits).toEqual(['/x'])
  }, 20000)

  it('after: an answer that changes to the daemon port after the check is refused, never reached', async () => {
    const { port, hits } = await httpServer()
    process.env.ADF_DAEMON_PORT = String(port)
    // The tool's check sees a public address; every later answer is loopback on the daemon port.
    dnsScript.set('rebind.adf-test.invalid', ['93.184.216.34', '127.0.0.1'])
    const r = await new SysFetchTool().execute({ url: `http://rebind.adf-test.invalid:${port}/runtime`, method: 'GET', timeout_ms: 10000 }, workspace)
    expect(r.isError).toBe(true)
    expect(JSON.parse(r.content).error).toMatch(/daemon control API/)
    expect(hits).toEqual([])
  }, 20000)
})

describe('pinnedFetch keeps fetch semantics', () => {
  it('sends method, headers and body; decodes gzip; follows a redirect after re-checking it; answers it under manual', async () => {
    const seen: Array<{ method?: string; url?: string; host?: string; body: string; type?: string }> = []
    const s: Server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        seen.push({ method: req.method, url: req.url, host: req.headers.host, body, type: req.headers['content-type'] })
        if (req.url === '/moved') { res.writeHead(302, { location: '/gz' }); res.end(); return }
        if (req.url === '/gz') { res.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'text/plain' }); res.end(gzipSync('decoded')); return }
        res.end('ok')
      })
    })
    servers.push(s)
    await new Promise<void>((done) => s.listen(0, '127.0.0.1', () => done()))
    const port = (s.address() as { port: number }).port
    dnsScript.set('semantics.adf-test.invalid', ['127.0.0.1'])
    const f = pinnedFetch({ daemonPort: 1 })
    const base = `http://semantics.adf-test.invalid:${port}`
    const posted = await f(`${base}/echo`, { method: 'POST', body: JSON.stringify({ a: 1 }), headers: { 'content-type': 'application/json' } })
    expect(await posted.text()).toBe('ok')
    expect(seen[0]).toEqual({ method: 'POST', url: '/echo', host: `semantics.adf-test.invalid:${port}`, body: '{"a":1}', type: 'application/json' })
    const followed = await f(`${base}/moved`, { method: 'POST', body: 'x' })
    expect([followed.status, await followed.text(), followed.url]).toEqual([200, 'decoded', `${base}/gz`])
    expect(seen.slice(1).map((r) => `${r.method} ${r.url}`)).toEqual(['POST /moved', 'GET /gz'])
    const manual = await f(`${base}/moved`, { redirect: 'manual' })
    expect([manual.status, manual.headers.get('location')]).toEqual([302, '/gz'])
    // A redirect to a refused address is refused before it is sent.
    const refused = pinnedFetch({ daemonPort: port })
    await expect(refused(`${base}/x`)).rejects.toThrow(/daemon control API/)
    const aborted = new AbortController()
    aborted.abort()
    await expect(f(`${base}/x`, { signal: aborted.signal })).rejects.toMatchObject({ name: 'AbortError' })
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

describe('ws_connect: the socket uses the addresses the guard checked', () => {
  it('after: a name only the checked lookup knows is reached', async () => {
    const { port, connections } = await wsServer()
    dnsScript.set('pinned.adf-test.invalid', ['127.0.0.1'])
    const url = `ws://pinned.adf-test.invalid:${port}/`
    const mgr = wsManager()
    const result = await mgr.connectOutbound('agent-1.adf', { id: 'c1', url, enabled: true, auth: 'none', auto_reconnect: false }, undefined, { daemonPort: 1 })
    expect(result.error).toBeUndefined()
    expect(result.connection_id).toBeTruthy()
    expect(connections).toHaveLength(1)
    mgr.unregisterAgent('agent-1.adf')
  }, 20000)

  it('after: an answer that changes to the daemon port after the check is refused, never reached', async () => {
    const { port, connections } = await wsServer()
    dnsScript.set('rebind.adf-test.invalid', ['93.184.216.34', '127.0.0.1'])
    const url = `ws://rebind.adf-test.invalid:${port}/`
    const guard = { daemonPort: port }
    expect(await checkConnectTarget(url, guard)).toBeNull() // the tool's check sees the public address
    const mgr = wsManager()
    const result = await mgr.connectOutbound('agent-1.adf', { id: 'c1', url, enabled: true, auth: 'none', auto_reconnect: false }, undefined, guard)
    expect(result.error).toMatch(/daemon control API/)
    expect(connections).toEqual([])
    mgr.unregisterAgent('agent-1.adf')
  }, 20000)

  it('the tool hands its policy to the connection with the ad-hoc URL, not with a stored id', async () => {
    const calls: Array<Record<string, unknown>> = []
    const tool = new WsConnectTool(async (opts) => { calls.push(opts); return { connection_id: 'c1' } }, () => ({ allow_local_fetch: true }) as never)
    await tool.execute({ url: 'ws://127.0.0.1:9999/' }, workspace)
    await tool.execute({ id: 'stored' }, workspace)
    expect(calls[0].guard).toEqual({ allowLocal: true, daemonPort: Number(process.env.ADF_DAEMON_PORT) || 7385 })
    expect('guard' in calls[1]).toBe(false)
  })
})
