/**
 * Remote mode's connector (design §9.2, tracker W4-B): the transport rule as
 * a URL matrix, the version handshake, the sentence for each way a
 * connection fails, and where the token and the local proof may go.
 *
 * Servers here bind 127.0.0.1 only; "remote" is the connector's view.
 */
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('./daemon-mode-electron')).electronStub.module)
import { SUPPORTED_CLIENT_API_VERSION } from '../../src/shared/daemon-client'
import { checkRemoteDaemonUrl } from '../../src/shared/utils/remote-backend-url'
import { defaultBackendConfig, type SecretCodec, type StudioBackendConfig } from '../../src/main/backend/backend-config'
import { DaemonConnection } from '../../src/main/backend/daemon-mode/connection'
import { remoteDaemonConnector, remoteHandshake, RemoteConnectError } from '../../src/main/backend/daemon-mode/remote/connector'
import { LOCAL_PROOF_HEADER } from '../../src/main/daemon/local-access'

const TOKEN = 'tok_7c1e9a3b5d2f4e6081a9c3e5b7d1f2a4c6e8'
const TLS_DIR = join(__dirname, 'fixtures', 'remote-tls')

const codec: SecretCodec = {
  available: () => true,
  encrypt: (plain) => `safe:${Buffer.from(plain).toString('base64')}`,
  decrypt: (stored) => Buffer.from(stored.slice(5), 'base64').toString(),
}

function remoteConfig(url: string, opts: { allowInsecureHttp?: boolean; token?: string | null } = {}): StudioBackendConfig {
  const token = opts.token === undefined ? TOKEN : opts.token
  return { ...defaultBackendConfig(), mode: 'remote', remote: { url, token: token ? codec.encrypt(token) : null, allowInsecureHttp: opts.allowInsecureHttp === true } }
}

interface Seen { method: string; url: string; headers: IncomingMessage['headers'] }

/** A daemon stand-in: /health open, /version behind the token, as the request guard does. */
function daemonHandler(seen: Seen[], opts: { clientApiVersion?: number; versionStatus?: number; hostNotAllowed?: boolean } = {}) {
  return (req: IncomingMessage, res: ServerResponse) => {
    seen.push({ method: req.method ?? 'GET', url: req.url ?? '', headers: req.headers })
    const json = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (opts.hostNotAllowed) return json(403, { error: 'Host header not allowed for this daemon (DNS rebinding protection).', code: 'host_not_allowed' })
    if (req.url === '/health') return json(200, { ok: true })
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { error: 'Unauthorized' })
    if (req.url === '/version') {
      if (opts.versionStatus) return json(opts.versionStatus, { error: 'boom' })
      return json(200, { version: '0.9.0', clientApiVersion: opts.clientApiVersion ?? SUPPORTED_CLIENT_API_VERSION, settingsPath: '/srv/adf/adf-settings.json', dataDir: '/srv/adf', runtimeId: null, pid: 4242, startedBy: 'cli' })
    }
    return json(200, { ok: true })
  }
}

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((done) => {
    s.closeAllConnections()
    s.close(() => done())
  })))
})

async function listen(server: Server): Promise<number> {
  servers.push(server)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()))
  const address = server.address()
  return typeof address === 'object' && address ? address.port : 0
}

async function connectError(config: StudioBackendConfig, fetchImpl?: typeof fetch): Promise<RemoteConnectError> {
  try {
    await remoteDaemonConnector(config, codec, { fetch: fetchImpl, timeoutMs: 3000, retry: { maxAttempts: 1 } })(() => {})
  } catch (err) {
    expect(err).toBeInstanceOf(RemoteConnectError)
    expect(String((err as Error).message)).not.toContain(TOKEN)
    return err as RemoteConnectError
  }
  throw new Error('expected the connector to fail')
}

describe('transport rule (§9.2): URL matrix', () => {
  const MATRIX: Array<[string, ReturnType<typeof checkRemoteDaemonUrl>['kind']]> = [
    ['https://adf.example.com', 'https'],
    ['https://adf.example.com:8443/daemon/', 'https'],
    ['https://192.168.1.5:7385', 'https'],
    ['http://127.0.0.1:7386', 'loopback'],
    ['http://127.8.9.10:7386', 'loopback'],
    ['http://localhost:7386', 'loopback'],
    ['http://[::1]:7386', 'loopback'],
    ['http://0x7f.1:7386', 'loopback'], // the URL parser canonicalizes to 127.0.0.1
    ['http://100.64.0.1:7385', 'tailnet'],
    ['http://100.101.102.103:7385', 'tailnet'],
    ['http://100.127.255.254:7385', 'tailnet'],
    ['http://[fd7a:115c:a1e0::1]:7385', 'tailnet'],
    ['http://100.63.255.255:7385', 'insecure-http'],
    ['http://100.128.0.1:7385', 'insecure-http'],
    ['http://192.168.1.5:7385', 'insecure-http'],
    ['http://10.0.0.5:7385', 'insecure-http'],
    ['http://adf.lan:7385', 'insecure-http'],
    ['http://server.tail1234.ts.net:7385', 'insecure-http'], // MagicDNS names are not addresses: https (tailscale serve) or confirm
    ['http://localhost.evil.example:7385', 'insecure-http'],
    ['http://127.0.0.1.nip.io:7385', 'insecure-http'],
    ['http://[::ffff:127.0.0.1]:7385', 'insecure-http'],
    ['http://[fd7a:115c:a1e1::1]:7385', 'insecure-http'],
    ['https://user:secret@adf.example.com', 'invalid'],
    ['https://adf.example.com/?token=x', 'invalid'],
    ['https://adf.example.com/#x', 'invalid'],
    ['ws://adf.example.com', 'invalid'],
    ['file:///etc/passwd', 'invalid'],
    ['adf.example.com', 'invalid'],
    ['', 'invalid'],
  ]

  it.each(MATRIX)('%s is %s', (url, kind) => {
    expect(checkRemoteDaemonUrl(url).kind).toBe(kind)
  })

  it('the connector refuses an unconfirmed plain-http URL without a single request', async () => {
    const calls: string[] = []
    const spy = (async (input: string | URL | Request) => { calls.push(String(input)); throw new Error('no request expected') }) as typeof fetch
    for (const [url, kind] of MATRIX) {
      if (kind !== 'insecure-http') continue
      const err = await connectError(remoteConfig(url), spy)
      expect(err.problem, url).toBe('transport')
    }
    expect(calls).toEqual([])
  })

  it('a confirmed plain-http URL is used; https, loopback and tailnet need no confirmation', async () => {
    const seen: Seen[] = []
    const port = await listen(createHttpServer(daemonHandler(seen)))
    const endpoint = await remoteDaemonConnector(remoteConfig(`http://127.0.0.1:${port}`), codec)(() => {})
    expect(endpoint.baseUrl).toBe(`http://127.0.0.1:${port}`)
    // The same daemon through a "LAN" spelling is refused until confirmed (the fake fetch maps it to the server).
    const lan = (async (input: string | URL | Request, init?: RequestInit) =>
      fetch(String(input).replace('http://192.168.1.5:7385', `http://127.0.0.1:${port}`), init)) as typeof fetch
    expect((await connectError(remoteConfig('http://192.168.1.5:7385'), lan)).problem).toBe('transport')
    const confirmed = await remoteDaemonConnector(remoteConfig('http://192.168.1.5:7385', { allowInsecureHttp: true }), codec, { fetch: lan })(() => {})
    expect(confirmed.baseUrl).toBe('http://192.168.1.5:7385')
  })

  it('no URL and no token are refused with a sentence, before any request', async () => {
    expect((await connectError({ ...defaultBackendConfig(), mode: 'remote' })).problem).toBe('not_configured')
    expect((await connectError(remoteConfig('https://adf.example.com', { token: null }))).problem).toBe('no_token')
  })
})

describe('version handshake and its failures', () => {
  it.each([
    ['/health', 200], ['/health', 503], ['/version', 200], ['/version', 401],
  ] as const)('times out a stalled %s HTTP %i body', async (path, status) => {
    const port = await listen(createHttpServer((req, res) => {
      if (req.url !== path) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{"ok":true}')
        return
      }
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.write('{"unfinished":')
    }))
    await expect(remoteHandshake(`http://127.0.0.1:${port}`, TOKEN, { timeoutMs: 200 }))
      .rejects.toMatchObject({ problem: 'unreachable', message: expect.stringContaining('did not answer within') })
  })

  it('connects: /health without the token, /version with it; the endpoint carries no local proof and no token-file refresh', async () => {
    const seen: Seen[] = []
    const port = await listen(createHttpServer(daemonHandler(seen)))
    const progress: string[] = []
    const endpoint = await remoteDaemonConnector(remoteConfig(`http://127.0.0.1:${port}`), codec)((p) => progress.push(p))
    expect(progress).toEqual([`Connecting to the remote ADF daemon at http://127.0.0.1:${port}…`])
    expect(seen.map((s) => [s.url, s.headers.authorization ?? null])).toEqual([['/health', null], ['/version', `Bearer ${TOKEN}`]])
    expect(endpoint.description).toMatch(/version 0\.9\.0/)
    expect(endpoint.description).not.toContain(TOKEN)
    expect(endpoint.logFile).toBeNull()
    expect(endpoint.source.localProof).toBeUndefined()
    expect(endpoint.source.refresh).toBeUndefined()
    expect(endpoint.source.token()).toBe(TOKEN)
  })

  it('an unreachable daemon at launch is retried with backoff until it answers; a wrong token is not retried', async () => {
    const seen: Seen[] = []
    const server = createHttpServer(daemonHandler(seen))
    const port = await listen(server)
    await new Promise<void>((done) => server.close(() => done()))
    servers.pop()
    const progress: string[] = []
    const sleeps: number[] = []
    const connect = remoteDaemonConnector(remoteConfig(`http://127.0.0.1:${port}`), codec, {
      timeoutMs: 2000,
      sleep: async (ms) => {
        sleeps.push(ms)
        // The daemon comes up after the third failed attempt.
        if (sleeps.length === 3) { const up = createHttpServer(daemonHandler(seen)); servers.push(up); await new Promise<void>((r) => up.listen(port, '127.0.0.1', () => r())) }
      },
    })
    const endpoint = await connect((p) => progress.push(p))
    expect(endpoint.baseUrl).toBe(`http://127.0.0.1:${port}`)
    expect(sleeps).toEqual([2000, 4000, 8000])
    expect(progress.filter((p) => p.startsWith('Waiting for the remote ADF daemon'))).toHaveLength(3)

    const wrong = remoteDaemonConnector(remoteConfig(`http://127.0.0.1:${port}`, { token: 'tok_wrong_wrong_wrong_wrong_wrong_wrong' }), codec, { sleep: async () => { throw new Error('a wrong token must not be retried') } })
    await expect(wrong(() => {})).rejects.toMatchObject({ problem: 'unauthorized' })
  })

  it('a wrong token', async () => {
    const port = await listen(createHttpServer(daemonHandler([])))
    const err = await connectError(remoteConfig(`http://127.0.0.1:${port}`, { token: 'tok_wrong_wrong_wrong_wrong_wrong_wrong' }))
    expect(err.problem).toBe('unauthorized')
    expect(err.message).toMatch(/refused the token; on 127.0.0.1 choose Add, then Share, and pair again./)
  })

  it('an unreachable host (nothing listens on the port)', async () => {
    const port = await listen(createHttpServer(() => {}))
    await new Promise<void>((done) => servers.pop()!.close(() => done()))
    const err = await connectError(remoteConfig(`http://127.0.0.1:${port}`))
    expect(err.problem).toBe('unreachable')
    expect(err.message).toMatch(new RegExp(`Cannot reach the ADF daemon at http://127\\.0\\.0\\.1:${port} \\(ECONNREFUSED`))
  })

  it('a host that does not answer in time', async () => {
    const port = await listen(createHttpServer(() => { /* never answers */ }))
    const err = await (async () => {
      try { await remoteHandshake(`http://127.0.0.1:${port}`, TOKEN, { timeoutMs: 300 }) } catch (e) { return e as RemoteConnectError }
      throw new Error('expected a timeout')
    })()
    expect(err.problem).toBe('unreachable')
    expect(err.message).toMatch(/did not answer within/)
  })

  it('a TLS error: a self-signed certificate is not trusted, and there is no way to skip the check', async () => {
    const server = createHttpsServer({ key: readFileSync(join(TLS_DIR, 'test-only-key.pem')), cert: readFileSync(join(TLS_DIR, 'test-only-cert.pem')) }, daemonHandler([]))
    const port = await listen(server)
    const err = await connectError(remoteConfig(`https://127.0.0.1:${port}`))
    expect(err.problem).toBe('tls')
    expect(err.message).toMatch(/TLS connection to https:\/\/127\.0\.0\.1:\d+ failed \((DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE)/)
  })

  it('a TLS error: https to a plain-http port', async () => {
    const port = await listen(createHttpServer(daemonHandler([])))
    const err = await connectError(remoteConfig(`https://127.0.0.1:${port}`))
    expect(err.problem).toBe('tls')
  })

  it('another client API version, a proxy without its daemon, a host name the daemon refuses, not a daemon', async () => {
    const versionPort = await listen(createHttpServer(daemonHandler([], { clientApiVersion: SUPPORTED_CLIENT_API_VERSION + 1 })))
    expect((await connectError(remoteConfig(`http://127.0.0.1:${versionPort}`))).message).toMatch(/speaks client API \d+; this Studio needs/)

    const proxyPort = await listen(createHttpServer((_req, res) => { res.writeHead(502); res.end('Bad Gateway') }))
    expect((await connectError(remoteConfig(`http://127.0.0.1:${proxyPort}`))).problem).toBe('proxy')

    const hostPort = await listen(createHttpServer(daemonHandler([], { hostNotAllowed: true })))
    const host = await connectError(remoteConfig(`http://localhost:${hostPort}`))
    expect(host.problem).toBe('host_not_allowed')
    expect(host.message).toMatch(/ADF_DAEMON_ALLOWED_HOSTS/)

    const webPort = await listen(createHttpServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>hello</html>') }))
    expect((await connectError(remoteConfig(`http://127.0.0.1:${webPort}`))).problem).toBe('not_a_daemon')
  })

  it('a redirect is not followed: the token never reaches the location', async () => {
    const elsewhere: Seen[] = []
    const otherPort = await listen(createHttpServer(daemonHandler(elsewhere)))
    const seen: Seen[] = []
    const port = await listen(createHttpServer((req, res) => {
      seen.push({ method: req.method ?? 'GET', url: req.url ?? '', headers: req.headers })
      if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); return }
      res.writeHead(307, { Location: `http://127.0.0.2:${otherPort}${req.url}` })
      res.end()
    }))
    const err = await connectError(remoteConfig(`http://127.0.0.1:${port}`))
    expect(err.problem).toBe('redirect')
    expect(elsewhere).toEqual([])
  })
})

describe('where the token and the local proof go', () => {
  it('the connected client sends the token to the daemon origin only, and never a local proof, also on local-only routes', async () => {
    const sent: Array<{ url: string; headers: Record<string, string> }> = []
    const seen: Seen[] = []
    const port = await listen(createHttpServer(daemonHandler(seen)))
    const base = `http://127.0.0.1:${port}`
    const recording = (async (input: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(input), headers: { ...(init?.headers as Record<string, string> ?? {}) } })
      const url = String(input)
      if (!url.startsWith(base)) return new Response('{}', { status: 200 })
      return fetch(url, init)
    }) as typeof fetch
    const connection = new DaemonConnection(remoteDaemonConnector(remoteConfig(base), codec, { fetch: recording }), { log: () => {}, warn: () => {}, error: () => {} }, recording)
    const client = await connection.client()
    for (const path of ['/identity/import', '/identity/unlock', '/daemon/shutdown', '/files/agent/identity/reveal', '/agents/a1/identity/reveal']) {
      await client.request('POST', path, { body: {} }).catch(() => {})
    }
    // A path that turns the URL into another host gets no credentials.
    await client.request('GET', `@127.0.0.2:${port}/version`).catch(() => {})
    await client.withBaseUrl(`http://127.0.0.2:${port}`).request('GET', '/version').catch(() => {})

    for (const request of sent) {
      const names = Object.keys(request.headers).map((k) => k.toLowerCase())
      expect(names, request.url).not.toContain(LOCAL_PROOF_HEADER)
      // /health is the one request without the token (the handshake's first step).
      const own = new URL(request.url).origin === base && new URL(request.url).pathname !== '/health'
      expect(names.includes('authorization'), request.url).toBe(own)
    }
    expect(sent.filter((r) => new URL(r.url).origin !== base).length).toBe(2)
  })
})

describe('the waiting notification', () => {
  it('keeps the whole URL (it holds colons)', async () => {
    const { remoteWaitingNotice } = await import('../../src/main/backend/daemon-mode')
    expect(remoteWaitingNotice('Waiting for the remote ADF daemon at https://adf.example.test:8443 (attempt 1; next in 2 s): Cannot reach…'))
      .toBe('Waiting for the remote ADF daemon at https://adf.example.test:8443. Studio keeps trying.')
  })
})
