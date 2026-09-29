import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DaemonRequestGuard, daemonHostAllowList, parseHostHeader, TOKEN_REQUIRED_MESSAGE } from '../src/main/daemon/request-guard'
import { daemonTokenPath, ensureDaemonToken, readDaemonToken, tokensEqual } from '../src/main/daemon/daemon-token'
import { localDaemonToken, localProofHeaders, resolveDaemonToken } from '../src/main/cli/daemon-url'
import { behindProxyFromEnv, localProofPath, mintLocalProof, readLocalProof } from '../src/main/daemon/local-access'
import { createDaemonHttpApi } from '../src/main/daemon/http-api'
import { DaemonHost } from '../src/main/daemon/daemon-host'
import { RuntimeService } from '../src/main/runtime/runtime-service'
import { MockLLMProvider } from '../src/main/runtime/headless'

const TOKEN = 'a'.repeat(43)
const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'adf-guard-'))
  dirs.push(dir)
  return dir
}
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

describe('daemon token file', () => {
  it('mints once (0600 on POSIX), then reads the same token; replaces a malformed file', () => {
    const dir = tempDir()
    const first = ensureDaemonToken(dir)
    expect(first.created).toBe(true)
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    if (process.platform !== 'win32') expect(statSync(first.path).mode & 0o777).toBe(0o600)
    const again = ensureDaemonToken(dir)
    expect(again).toEqual({ token: first.token, path: first.path, created: false })
    expect(readDaemonToken(dir)).toBe(first.token)

    writeFileSync(daemonTokenPath(dir), 'short\n')
    expect(readDaemonToken(dir)).toBeNull()
    const replaced = ensureDaemonToken(dir)
    expect(replaced.created).toBe(true)
    expect(replaced.token).not.toBe(first.token)
    expect(readFileSync(daemonTokenPath(dir), 'utf-8').trim()).toBe(replaced.token)
  })

  it('compares in constant time over any lengths', () => {
    expect(tokensEqual(TOKEN, TOKEN)).toBe(true)
    expect(tokensEqual(TOKEN, `${TOKEN}x`)).toBe(false)
    expect(tokensEqual('', TOKEN)).toBe(false)
  })

  it('clients read it for loopback URLs only; --token / ADF_DAEMON_TOKEN win', () => {
    const dir = tempDir()
    const { token } = ensureDaemonToken(dir)
    const env = { ADF_DAEMON_SETTINGS: join(dir, 'adf-settings.json') }
    expect(localDaemonToken('http://127.0.0.1:7385', env)).toBe(token)
    // Another loopback port is presumably a tunnel to a daemon elsewhere: not our token.
    expect(localDaemonToken('http://localhost:9000', env)).toBeUndefined()
    expect(localDaemonToken('http://127.0.0.1:7386', env)).toBeUndefined()
    expect(localDaemonToken('http://127.0.0.1:7386', { ...env, ADF_DAEMON_PORT: '7386' })).toBe(token)
    expect(localDaemonToken('http://[::1]:7385', env)).toBe(token)
    expect(localDaemonToken('http://daemon.example:7385', env)).toBeUndefined()
    expect(localDaemonToken('http://192.168.1.5:7385', env)).toBeUndefined()
    expect(resolveDaemonToken(undefined, env, 'http://127.0.0.1:7385')).toBe(token)
    expect(resolveDaemonToken(undefined, { ...env, ADF_DAEMON_TOKEN: 'from-env' }, 'http://127.0.0.1:7385')).toBe('from-env')
    expect(resolveDaemonToken('explicit', { ...env, ADF_DAEMON_TOKEN: 'from-env' }, 'http://127.0.0.1:7385')).toBe('explicit')
    // Without a URL (old call shape) the file is never consulted.
    expect(resolveDaemonToken(undefined, env)).toBeUndefined()
  })
})

describe('DaemonRequestGuard', () => {
  const guard = new DaemonRequestGuard({ token: TOKEN, allowedHosts: daemonHostAllowList('127.0.0.1', 7385) })
  const auth = { authorization: `Bearer ${TOKEN}` }

  it('parses Host headers', () => {
    expect(parseHostHeader('127.0.0.1:7385')).toEqual({ host: '127.0.0.1', port: 7385 })
    expect(parseHostHeader('[::1]:7385')).toEqual({ host: '::1', port: 7385 })
    expect(parseHostHeader('LocalHost')).toEqual({ host: 'localhost' })
    expect(parseHostHeader('::1')).toBeNull()
    expect(parseHostHeader('a:b')).toBeNull()
    expect(parseHostHeader('')).toBeNull()
  })

  it('accepts the loopback names with the bound port and a valid token', () => {
    for (const host of ['127.0.0.1:7385', 'localhost:7385', '[::1]:7385']) {
      expect(guard.check('GET', '/agents', { host, ...auth })).toBeNull()
    }
  })

  it('accepts loopback names on any port (SSH tunnel -L 7386:127.0.0.1:7385)', () => {
    for (const host of ['127.0.0.1:7386', 'localhost:9000', '[::1]:7390', '127.0.0.1']) {
      expect(guard.check('GET', '/agents', { host, ...auth })).toBeNull()
    }
    // Still token-gated, and a loopback Origin on another port is still another origin.
    expect(guard.check('GET', '/agents', { host: '127.0.0.1:7386' })?.status).toBe(401)
    expect(guard.check('POST', '/agents/x/start', { host: '127.0.0.1:7386', origin: 'http://127.0.0.1:7386', ...auth })?.body.code).toBe('cross_origin')
  })

  it('rejects DNS rebinding (foreign Host) on any port', () => {
    for (const host of ['evil.example:7385', 'evil.example:7386', 'localhost.evil.example:7385', '127.0.0.2:7385', '192.168.1.5:7385', undefined]) {
      expect(guard.check('GET', '/agents', { host, ...auth })?.body.code).toBe('host_not_allowed')
    }
    // Even /health.
    expect(guard.check('GET', '/health', { host: 'evil.example:7385' })?.status).toBe(403)
  })

  it('rejects foreign Origins and cross-site fetch metadata; accepts same-origin', () => {
    const host = '127.0.0.1:7385'
    for (const origin of ['http://evil.example', 'http://localhost:3000', 'null', 'file://', 'chrome-extension://abc']) {
      expect(guard.check('POST', '/agents/x/start', { host, origin, ...auth })?.body.code).toBe('cross_origin')
    }
    expect(guard.check('POST', '/agents/x/start', { host, 'sec-fetch-site': 'cross-site', ...auth })?.status).toBe(403)
    expect(guard.check('POST', '/agents/x/start', { host, 'sec-fetch-site': 'same-site', ...auth })?.status).toBe(403)
    expect(guard.check('POST', '/agents/x/start', { host, origin: 'http://127.0.0.1:7385', 'sec-fetch-site': 'same-origin', ...auth })).toBeNull()
    expect(guard.check('GET', '/agents', { host, 'sec-fetch-site': 'none', ...auth })).toBeNull()
  })

  it('requires the bearer token everywhere but GET /health', () => {
    const host = '127.0.0.1:7385'
    expect(guard.check('GET', '/health', { host })).toBeNull()
    expect(guard.check('POST', '/health', { host })?.status).toBe(401)
    for (const headers of [{}, { authorization: 'Bearer wrong' }, { authorization: TOKEN }, { authorization: `Basic ${TOKEN}` }]) {
      const rejection = guard.check('GET', '/agents', { host, ...headers })
      expect(rejection?.status).toBe(401)
      expect(rejection?.body).toEqual({ error: TOKEN_REQUIRED_MESSAGE, code: 'unauthorized' })
    }
    for (const path of ['/openapi.json', '/events', '/agents/x/identity/foo']) {
      expect(guard.check('GET', path, { host })?.status).toBe(401)
    }
  })

  it('non-loopback binds: IP literals on the bound port and ADF_DAEMON_ALLOWED_HOSTS names', () => {
    const lan = new DaemonRequestGuard({ token: TOKEN, allowedHosts: daemonHostAllowList('0.0.0.0', 7385, ['daemon.lan', 'proxy.example:443']), ipLiteralPort: 7385 })
    expect(lan.check('GET', '/agents', { host: '192.168.1.5:7385', ...auth })).toBeNull()
    expect(lan.check('GET', '/agents', { host: 'daemon.lan:7385', ...auth })).toBeNull()
    expect(lan.check('GET', '/agents', { host: 'daemon.lan:9999', ...auth })).toBeNull()
    expect(lan.check('GET', '/agents', { host: 'proxy.example:443', ...auth })).toBeNull()
    expect(lan.check('GET', '/agents', { host: 'proxy.example:8443', ...auth })?.status).toBe(403)
    expect(lan.check('GET', '/agents', { host: '192.168.1.5:8080', ...auth })?.status).toBe(403)
    expect(lan.check('GET', '/agents', { host: 'evil.example:7385', ...auth })?.status).toBe(403)
    expect(lan.check('GET', '/agents', { host: '127.0.0.1:7386', ...auth })).toBeNull()
    expect(lan.check('POST', '/agents', { host: '192.168.1.5:7385', origin: 'http://192.168.1.9:8080', ...auth })?.status).toBe(403)
  })
})

describe('createDaemonHttpApi without host rules (tests / embedding)', () => {
  it('still refuses any browser Origin and sends no CORS headers', async () => {
    const server = createDaemonHttpApi(new RuntimeService({ enforceReviewGate: false }))
    try {
      const res = await server.inject({ method: 'POST', url: '/agents/x/start', headers: { origin: 'http://127.0.0.1:7385' } })
      expect(res.statusCode).toBe(403)
      expect(res.headers['access-control-allow-origin']).toBeUndefined()
      const pre = await server.inject({ method: 'OPTIONS', url: '/agents', headers: { origin: 'http://evil.example', 'access-control-request-method': 'POST' } })
      expect(pre.statusCode).toBe(403)
      expect(pre.headers['access-control-allow-origin']).toBeUndefined()
    } finally {
      await server.close()
    }
  })
})

describe('DaemonHost over real HTTP', () => {
  let host: DaemonHost
  let port: number
  let runtime: RuntimeService
  let agentId: string

  beforeEach(async () => {
    const { RuntimeGate } = await import('../src/main/runtime/runtime-gate')
    ;(RuntimeGate as unknown as { _resetForTests?: () => void })._resetForTests?.()
    runtime = new RuntimeService({ enforceReviewGate: false })
    agentId = runtime.createAgent({ name: 'agent-1', provider: new MockLLMProvider() }).id
    host = new DaemonHost({ runtime, host: '127.0.0.1', port: 0, token: TOKEN, installSignalHandlers: false })
    await host.start()
    const address = host.getServer()!.server.address()
    port = typeof address === 'object' && address ? address.port : 0
  })
  afterEach(async () => { await host.stop() })

  function send(method: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
        let body = ''
        res.on('data', (d) => { body += d })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }))
      })
      req.on('error', reject)
      req.end()
    })
  }

  it('health is open; everything else needs the token; the actual bound port is allowed', async () => {
    expect((await send('GET', '/health')).status).toBe(200)
    const denied = await send('GET', '/agents')
    expect(denied.status).toBe(401)
    expect(JSON.parse(denied.body).error).toMatch(/adf daemon token/)
    expect((await send('GET', '/agents', { authorization: `Bearer ${TOKEN}` })).status).toBe(200)
    expect((await send('GET', '/openapi.json')).status).toBe(401)
    // A forwarded port (ssh -L) arrives with its own port in Host.
    expect((await send('GET', '/agents', { host: `127.0.0.1:${port + 1}`, authorization: `Bearer ${TOKEN}` })).status).toBe(200)
  })

  it('a web page cannot drive it: foreign Origin, cross-site metadata and rebinding Host are refused', async () => {
    const auth = { authorization: `Bearer ${TOKEN}` }
    const csrf = await send('POST', `/agents/${agentId}/tasks/approve-all`, { origin: 'http://evil.example', 'content-type': 'text/plain' })
    expect(csrf.status).toBe(403)
    expect(csrf.headers['access-control-allow-origin']).toBeUndefined()
    expect((await send('POST', `/agents/${agentId}/start`, { 'sec-fetch-site': 'cross-site', ...auth })).status).toBe(403)
    expect((await send('GET', '/agents', { host: `attacker.example:${port}`, ...auth })).status).toBe(403)
    // Without a token a same-origin-looking request still fails.
    expect((await send('POST', `/agents/${agentId}/start`)).status).toBe(401)
  })

  it('SSE /events accepts the token header', async () => {
    const res = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: '/events', headers: { authorization: `Bearer ${TOKEN}` } }, (r) => { resolve(r.statusCode ?? 0); r.destroy() })
      req.on('error', reject)
      req.end()
    })
    // No event bus configured on this host: 503 means the guard let it through.
    expect([200, 503]).toContain(res)
    expect((await send('GET', '/events')).status).toBe(401)
  })
})

describe('loopback-only identity routes', () => {
  it('lock and confirm-backup refuse non-loopback callers', async () => {
    const identity = { lock: () => ({ status: 'locked' }), confirmBackup: () => ({ status: 'ready' }), status: () => ({}) }
    const server = createDaemonHttpApi(new RuntimeService({ enforceReviewGate: false }), { identity: identity as never })
    try {
      for (const url of ['/identity/lock', '/identity/confirm-backup']) {
        const remote = await server.inject({ method: 'POST', url, remoteAddress: '192.168.1.5' })
        expect(remote.statusCode, url).toBe(403)
        expect(remote.json().code).toBe('loopback_only')
        const local = await server.inject({ method: 'POST', url })
        expect(local.statusCode, url).toBe(200)
      }
    } finally {
      await server.close()
    }
  })
})

describe('local-only routes behind a reverse proxy', () => {
  const identity = { lock: () => ({ status: 'locked' }), confirmBackup: () => ({ status: 'ready' }), status: () => ({}) }
  const LOCAL_ROUTES = ['/identity/lock', '/identity/confirm-backup', '/daemon/shutdown']

  it('forwarded headers make a loopback request non-local (they never grant local)', async () => {
    const server = createDaemonHttpApi(new RuntimeService({ enforceReviewGate: false }), { identity: identity as never, requestShutdown: () => {} })
    try {
      for (const header of ['x-forwarded-for', 'forwarded', 'x-real-ip', 'x-forwarded-host', 'via']) {
        for (const url of LOCAL_ROUTES) {
          const res = await server.inject({ method: 'POST', url, headers: { [header]: '127.0.0.1' } })
          expect(res.statusCode, `${header} ${url}`).toBe(403)
          expect(res.json().code).toBe('loopback_only')
          expect(res.json().error).toMatch(/proxy/)
        }
      }
      // A remote peer claiming to be local through a header stays remote.
      const spoofed = await server.inject({ method: 'POST', url: '/identity/lock', remoteAddress: '203.0.113.9', headers: { 'x-forwarded-for': '127.0.0.1' } })
      expect(spoofed.statusCode).toBe(403)
      // Other routes are unaffected by the headers.
      expect((await server.inject({ method: 'GET', url: '/identity', headers: { 'x-forwarded-for': '198.51.100.1' } })).statusCode).toBe(200)
    } finally {
      await server.close()
    }
  })

  it('proxy mode: a bare loopback request is refused; this machine’s local proof admits it', async () => {
    const dir = tempDir()
    const { proof } = mintLocalProof(dir)
    const server = createDaemonHttpApi(new RuntimeService({ enforceReviewGate: false }), {
      identity: identity as never,
      security: { behindProxy: true, localProof: proof },
    })
    try {
      for (const url of ['/identity/lock', '/identity/confirm-backup']) {
        const bare = await server.inject({ method: 'POST', url })
        expect(bare.statusCode, url).toBe(403)
        expect(bare.json().error).toMatch(/ADF_DAEMON_BEHIND_PROXY/)
        expect((await server.inject({ method: 'POST', url, headers: { 'x-adf-local-proof': 'x'.repeat(43) } })).statusCode).toBe(403)
        expect((await server.inject({ method: 'POST', url, headers: { 'x-adf-local-proof': proof } })).statusCode, url).toBe(200)
        // The proof does not override the other two rules.
        expect((await server.inject({ method: 'POST', url, headers: { 'x-adf-local-proof': proof, 'x-forwarded-for': '1.2.3.4' } })).statusCode).toBe(403)
        expect((await server.inject({ method: 'POST', url, remoteAddress: '10.0.0.2', headers: { 'x-adf-local-proof': proof } })).statusCode).toBe(403)
      }
    } finally {
      await server.close()
    }
  })

  it('proxy mode without a proof refuses everything; the env flag turns it on', async () => {
    const server = createDaemonHttpApi(new RuntimeService({ enforceReviewGate: false }), { identity: identity as never, security: { behindProxy: true } })
    try {
      expect((await server.inject({ method: 'POST', url: '/identity/lock', headers: { 'x-adf-local-proof': 'a'.repeat(43) } })).statusCode).toBe(403)
    } finally {
      await server.close()
    }
    expect(behindProxyFromEnv({ ADF_DAEMON_BEHIND_PROXY: '1' })).toBe(true)
    expect(behindProxyFromEnv({ ADF_DAEMON_BEHIND_PROXY: 'true' })).toBe(true)
    expect(behindProxyFromEnv({ ADF_DAEMON_BEHIND_PROXY: '0' })).toBe(false)
    expect(behindProxyFromEnv({})).toBe(false)
  })

  it('clients send the proof to this machine’s daemon, on local-only routes only', () => {
    const dir = tempDir()
    const env = { ADF_DAEMON_SETTINGS: join(dir, 'adf-settings.json') }
    expect(localProofHeaders('http://127.0.0.1:7385', '/identity/unlock', env)).toEqual({})
    const { proof, path } = mintLocalProof(dir)
    expect(path).toBe(localProofPath(dir))
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readLocalProof(dir)).toBe(proof)
    expect(localProofHeaders('http://127.0.0.1:7385', '/identity/unlock', env)).toEqual({ 'X-ADF-Local-Proof': proof })
    expect(localProofHeaders('http://127.0.0.1:7385', '/daemon/shutdown', env)).toEqual({ 'X-ADF-Local-Proof': proof })
    expect(localProofHeaders('http://127.0.0.1:7385', '/agents', env)).toEqual({})
    expect(localProofHeaders('http://127.0.0.1:7386', '/identity/unlock', env)).toEqual({})
    expect(localProofHeaders('http://daemon.example:7385', '/identity/unlock', env)).toEqual({})
    // Another port has its own file: a second daemon on these settings does not clobber it.
    const other = mintLocalProof(dir, 7386)
    expect(other.path).toBe(join(dir, 'daemon-local-proof-7386'))
    expect(readLocalProof(dir)).toBe(proof)
    expect(localProofHeaders('http://127.0.0.1:7386', '/identity/unlock', { ...env, ADF_DAEMON_PORT: '7386' })).toEqual({ 'X-ADF-Local-Proof': other.proof })
    // Re-minted every daemon start.
    expect(mintLocalProof(dir).proof).not.toBe(proof)
  })
})
