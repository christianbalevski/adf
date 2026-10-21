/**
 * A pinned connection is checked on every new connection, not only at
 * launch (settings-scopes.md §5.2; review item 1): after a drop, on wake, on
 * a requested reconnect, nothing goes out until the address shows the
 * fingerprint saved when it was paired. Another fingerprint stops the
 * connection with its sentence; the token is never sent.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('./daemon-mode-electron')).electronStub.module)

import { SUPPORTED_CLIENT_API_VERSION } from '../../src/shared/daemon-client'
import { DaemonConnection, PinMismatchError, type DaemonConnector } from '../../src/main/backend/daemon-mode/connection'
import { remoteDaemonConnector } from '../../src/main/backend/daemon-mode/remote/connector'
import { defaultBackendConfig, type SecretCodec, type StudioBackendConfig } from '../../src/main/backend/backend-config'
import { remotesEnv, saveConnection } from '../../src/main/backend/connections'
import { deviceToken, helloResponse, type FakeHelloHost } from '../helpers/hello-proof'

const URL_ = 'http://100.101.102.103:7385'
const TOKEN = deviceToken('box-1')
const quiet = { log: () => {}, warn: () => {}, error: () => {} }
const codec: SecretCodec = { available: () => true, encrypt: (p) => `safe:${p}`, decrypt: (s) => s.slice(5) }
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms))
async function until(check: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await tick()
  }
}

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

/**
 * A daemon at URL_: /health, /version behind the token, /remote/hello with `fingerprint()` (null: nothing
 * answers) and the proof for TOKEN (`hello` changes what the host holds: an impostor, an older ADF).
 */
function fakeServer(fingerprint: () => string | null, hello: () => Partial<FakeHelloHost> = () => ({})) {
  const sent: Array<{ path: string; auth: string | null }> = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const auth = new Headers(init?.headers).get('authorization')
    sent.push({ path: url.pathname, auth })
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    if (url.pathname === '/remote/hello') {
      const fp = fingerprint()
      if (fp === null) throw new TypeError('fetch failed')
      return helloResponse(url, { name: 'box-1', fingerprint: fp, tokens: [TOKEN], ...hello() })
    }
    if (url.pathname === '/health') return json(200, { ok: true })
    if (auth !== `Bearer ${TOKEN}`) return json(401, { error: 'Unauthorized' })
    if (url.pathname === '/version') return json(200, { version: '0.9.0', clientApiVersion: SUPPORTED_CLIENT_API_VERSION, pid: 1, startedBy: 'cli' })
    return json(200, { agents: [] })
  }) as typeof fetch
  return { fetch: fetchImpl, sent, withToken: () => sent.filter((s) => s.auth === `Bearer ${TOKEN}`).map((s) => s.path) }
}

describe('DaemonConnection with a pinned connector', () => {
  function setup(pinCheck: () => Promise<void>) {
    const server = fakeServer(() => 'ABCD-EFGH')
    const connect = Object.assign(async () => ({ baseUrl: URL_, source: { token: () => TOKEN }, logFile: null, description: 'box-1' }), { logFile: null, pinCheck }) as DaemonConnector
    const connection = new DaemonConnection(connect, quiet, server.fetch)
    return { server, connection }
  }

  it('after a drop nothing is sent until the fingerprint matches; then the token goes and the listener fires', async () => {
    let release!: () => void
    const pinCheck = vi.fn(() => new Promise<void>((r) => { release = r }))
    const { server, connection } = setup(pinCheck)
    const client = await connection.client()
    connection.markConnected()
    const verified = vi.fn()
    connection.onListenerVerified(verified)
    connection.markDisconnected('the stream dropped')
    await until(() => pinCheck.mock.calls.length === 1)
    await expect(client.request('GET', '/agents')).rejects.toThrow(/fingerprint/)
    expect(server.sent).toEqual([])
    release()
    await until(() => verified.mock.calls.length === 1)
    await client.request('GET', '/agents')
    expect(server.withToken()).toEqual(['/agents'])
  })

  it('another fingerprint: the connection fails with the sentence and sends nothing, then or later', async () => {
    const { server, connection } = setup(async () => { throw new PinMismatchError('http://x is not box-1 (fingerprint EVIL-2345, paired as ABCD-EFGH); the token was not sent.') })
    const client = await connection.client()
    connection.markConnected()
    connection.markDisconnected('the stream dropped')
    await until(() => connection.state.state === 'failed')
    expect(connection.state).toEqual({ state: 'failed', message: 'http://x is not box-1 (fingerprint EVIL-2345, paired as ABCD-EFGH); the token was not sent.' })
    await expect(client.request('GET', '/agents')).rejects.toThrow(/not box-1/)
    expect(server.sent).toEqual([])
  })

  it('a wake or a requested reconnect checks the fingerprint first, even while the stream looks connected', async () => {
    const pinCheck = vi.fn(async () => {})
    const { connection } = setup(pinCheck)
    await connection.client()
    connection.markConnected()
    expect(connection.pinned).toBe(true)
    expect(await connection.reverify('the computer resumed')).toBe(true)
    expect(pinCheck).toHaveBeenCalledTimes(1)
    const failing = setup(async () => { throw new PinMismatchError('another computer') })
    await failing.connection.client()
    expect(await failing.connection.reverify('a requested reconnect')).toBe(false)
    expect(failing.connection.state.state).toBe('failed')
  })

  it('a connection that is not pinned is not checked (local mode keeps its pid check)', async () => {
    const server = fakeServer(() => 'ABCD-EFGH')
    const connection = new DaemonConnection(Object.assign(async () => ({ baseUrl: URL_, source: { token: () => TOKEN }, logFile: null, description: 'x' }), { logFile: null }), quiet, server.fetch)
    await connection.client()
    expect(connection.pinned).toBe(false)
    expect(await connection.reverify('x')).toBe(false)
  })
})

describe('the remote connector of a saved connection gives the connection its pin', () => {
  function savedEnv() {
    const dir = mkdtempSync(join(tmpdir(), 'adf-pin-'))
    dirs.push(dir)
    const env = { ...remotesEnv(dir), ADF_TEST_KEYCHAIN_FILE: join(dir, 'keychain.json'), ADF_TEST_SEAMS: '1' }
    delete env.ADF_KEYCHAIN
    return env
  }
  const config: StudioBackendConfig = { ...defaultBackendConfig(), mode: 'remote', remote: { url: null, token: null, allowInsecureHttp: false, name: 'box-1' } }

  it('pinCheck passes for the paired fingerprint, rejects PinMismatchError for another, and a plain error while nothing answers', async () => {
    const env = savedEnv()
    await saveConnection(env, { url: URL_, token: TOKEN, fingerprint: 'ABCD-EFGH', hostName: 'box-1', deviceId: 'd', label: 'l' })
    let fp: string | null = 'ABCD-EFGH'
    const server = fakeServer(() => fp)
    const connector = remoteDaemonConnector(config, codec, { env, fetch: server.fetch })
    expect(connector.pinCheck).toBeTypeOf('function')
    await connector(() => {})
    await expect(connector.pinCheck!()).resolves.toBeUndefined()
    fp = 'EVIL-2345'
    const mismatch = await connector.pinCheck!().catch((e) => e)
    expect(mismatch).toBeInstanceOf(PinMismatchError)
    expect(mismatch.message).toBe(`${URL_} is not box-1 (fingerprint EVIL-2345, paired as ABCD-EFGH); the token was not sent.`)
    fp = null
    const down = await connector.pinCheck!().catch((e) => e)
    expect(down).not.toBeInstanceOf(PinMismatchError)
    expect(down.message).toBe(`${URL_} does not answer as box-1; the token was not sent.`)
  })

  // R2A-2: the pin is not a string anything can echo. The daemon proves it holds this token's device record.
  it('an impostor that echoes the pinned fingerprint gets no token: at launch, and on a re-dial', async () => {
    const env = savedEnv()
    await saveConnection(env, { url: URL_, token: TOKEN, fingerprint: 'ABCD-EFGH', hostName: 'box-1', deviceId: 'd', label: 'l' })
    // Shows the real fingerprint and claims to know the device, without its record: no proof it can make.
    const impostor = fakeServer(() => 'ABCD-EFGH', () => ({ tokens: [deviceToken('another-device')] }))
    const forging = fakeServer(() => 'ABCD-EFGH', () => ({ tokens: [] }))
    for (const server of [impostor, forging]) {
      const connector = remoteDaemonConnector(config, codec, { env, fetch: server.fetch, retry: { maxAttempts: 1 } })
      const err = await connector(() => {}).catch((e) => e)
      expect(err.message).toMatch(/^box-1 does not know this computer's token, which was not sent; pair it again\.$/)
      expect(server.withToken()).toEqual([])
      expect(server.sent.every((s) => s.auth === null)).toBe(true)
    }
    // An impostor that sends a proof of its own making: refused as not the computer that issued the token.
    const real = fakeServer(() => 'ABCD-EFGH')
    let lie = false
    const lying = (async (input: string | URL | Request, init?: RequestInit) => {
      const res = await real.fetch(input, init)
      if (!lie || new URL(String(input)).pathname !== '/remote/hello') return res
      const body = await res.json() as Record<string, unknown>
      return new Response(JSON.stringify({ ...body, proof: 'A'.repeat(43) }), { status: 200 })
    }) as typeof fetch
    const connector = remoteDaemonConnector(config, codec, { env, fetch: lying })
    await connector(() => {})
    const sentBefore = real.withToken().length
    lie = true
    const forged = await connector.pinCheck!().catch((e) => e)
    expect(forged).toBeInstanceOf(PinMismatchError)
    expect(forged.message).toBe(`${URL_} could not prove it is box-1; the token was not sent.`)
    expect(real.withToken()).toHaveLength(sentBefore)
  })

  it('a proof replayed for another nonce fails; a valid one passes', async () => {
    const { verifyHello } = await import('../../src/main/services/remote-hello')
    const server = fakeServer(() => 'ABCD-EFGH')
    expect((await verifyHello(URL_, TOKEN, { fetch: server.fetch })).kind).toBe('verified')
    // Record the answer to one nonce, then replay it to a client that asked with another.
    const nonceA = 'a'.repeat(43)
    const recorded = await (await server.fetch(`${URL_}/remote/hello?${new URLSearchParams({ nonce: nonceA, device: TOKEN.slice(5, 15), origin: URL_ })}`)).text()
    const replay = (async () => new Response(recorded, { status: 200 })) as unknown as typeof fetch
    expect((await verifyHello(URL_, TOKEN, { fetch: replay, nonce: nonceA })).kind).toBe('verified')
    expect((await verifyHello(URL_, TOKEN, { fetch: replay, nonce: 'b'.repeat(43) })).kind).toBe('forged')
    // Nor for another origin (the address the client dialed is in the message).
    expect((await verifyHello('http://100.101.102.104:7385', TOKEN, { fetch: replay, nonce: nonceA })).kind).toBe('forged')
  })

  it('an older ADF, which cannot prove who it is, is refused with one sentence, never downgraded; no token goes out', async () => {
    const env = savedEnv()
    await saveConnection(env, { url: URL_, token: TOKEN, fingerprint: 'ABCD-EFGH', hostName: 'box-1', deviceId: 'd', label: 'l' })
    const server = fakeServer(() => 'ABCD-EFGH', () => ({ old: true }))
    const connector = remoteDaemonConnector(config, codec, { env, fetch: server.fetch })
    const err = await connector(() => {}).catch((e) => e)
    expect(err.message).toBe('box-1 runs an older ADF; update it.')
    expect(err.problem).toBe('fingerprint')
    expect(server.withToken()).toEqual([])
  })

  it('the remote URL without a fingerprint has no pin', () => {
    expect(remoteDaemonConnector({ ...defaultBackendConfig(), mode: 'remote', remote: { url: URL_, token: 'safe:x', allowInsecureHttp: false } }, codec).pinCheck).toBeUndefined()
  })

  // F2 (review round 3): an `adfd_` token in the remote slot, unpinned, goes only to the daemon that proves it issued it.
  it('the remote slot with a device token: the hello must prove it, at launch and on every re-dial; nothing answering is waited for, never sent to', async () => {
    const slot: StudioBackendConfig = { ...defaultBackendConfig(), mode: 'remote', remote: { url: URL_, token: `safe:${TOKEN}`, allowInsecureHttp: false } }
    // An impostor at the address (it holds no record of the token): refused, the token never sent.
    const impostor = fakeServer(() => 'ABCD-EFGH', () => ({ tokens: [] }))
    const refused = await remoteDaemonConnector(slot, codec, { fetch: impostor.fetch, retry: { maxAttempts: 1 } })(() => {}).catch((e) => e)
    expect(refused).toMatchObject({ problem: 'fingerprint', message: '100.101.102.103 does not know this computer\'s token, which was not sent; pair it again.' })
    expect(impostor.withToken()).toEqual([])
    // Nothing answers the hello: waited for as a host that is down; nothing sent.
    const down = fakeServer(() => null)
    const waited = await remoteDaemonConnector(slot, codec, { fetch: down.fetch, retry: { maxAttempts: 1 } })(() => {}).catch((e) => e)
    expect(waited).toMatchObject({ problem: 'unreachable' })
    expect(down.withToken()).toEqual([])
    // The computer that issued it: connected, and its re-dials are checked too.
    let fp: string | null = 'ABCD-EFGH'
    let tokens = [TOKEN]
    const real = fakeServer(() => fp, () => ({ tokens }))
    const connector = remoteDaemonConnector(slot, codec, { fetch: real.fetch })
    expect(connector.pinCheck).toBeTypeOf('function')
    await connector(() => {})
    expect(real.sent.map((s) => s.path)).toEqual(['/remote/hello', '/health', '/version'])
    await expect(connector.pinCheck!()).resolves.toBeUndefined()
    tokens = []
    expect(await connector.pinCheck!().catch((e) => e)).toBeInstanceOf(PinMismatchError)
    fp = null
    const gone = await connector.pinCheck!().catch((e) => e)
    expect(gone).not.toBeInstanceOf(PinMismatchError)
  })

  // F4 (review round 3): a 429 to the hello is "rate-limiting", waited out with its Retry-After; never "down", never a token.
  it('a hello answered 429: said as rate-limiting, waited out for its Retry-After, the token not sent meanwhile', async () => {
    const env = savedEnv()
    await saveConnection(env, { url: URL_, token: TOKEN, fingerprint: 'ABCD-EFGH', hostName: 'box-1', deviceId: 'd', label: 'l' })
    const real = fakeServer(() => 'ABCD-EFGH')
    let limited = 2
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      if (new URL(String(input)).pathname === '/remote/hello' && limited > 0) {
        limited--
        return new Response(JSON.stringify({ error: 'Too many requests from this address. Wait a minute.', code: 'rate_limited' }), { status: 429, headers: { 'Retry-After': '9' } })
      }
      return real.fetch(input, init)
    }) as typeof fetch
    const progress: string[] = []
    const slept: number[] = []
    const connector = remoteDaemonConnector(config, codec, { env, fetch: fetchImpl, retry: { initialMs: 10, maxMs: 20 }, sleep: async (ms) => { slept.push(ms); expect(real.withToken()).toEqual([]) } })
    await connector((line) => progress.push(line))
    expect(progress.filter((l) => l.includes('rate-limiting'))).toEqual(['box-1 is rate-limiting connections; retrying.', 'box-1 is rate-limiting connections; retrying.'])
    expect(progress.some((l) => /Waiting for the remote ADF daemon|does not answer/.test(l))).toBe(false)
    expect(slept).toEqual([9_000, 9_000])
    expect(real.withToken()).toEqual(['/version'])
    // A re-dial's check: not a mismatch (the connection is not failed), it carries the wait.
    limited = 1
    const again = await connector.pinCheck!().catch((e) => e)
    expect(again).not.toBeInstanceOf(PinMismatchError)
    expect(again).toMatchObject({ message: 'box-1 is rate-limiting connections; retrying.', retryAfterMs: 9_000 })
  })
})

describe('a re-dial check answered 429 (F4)', () => {
  it('the check is asked again only after the wait the host named, not every second; the token is withheld meanwhile', async () => {
    const calls: number[] = []
    const connector = Object.assign(async () => ({ baseUrl: 'http://127.0.0.1:47399', logFile: null, description: 'fake', source: { token: () => TOKEN } }), {
      logFile: null,
      pinCheck: async () => {
        calls.push(Date.now())
        if (calls.length === 1) throw Object.assign(new Error('box-1 is rate-limiting connections; retrying.'), { retryAfterMs: 1_600 })
      },
    }) as unknown as DaemonConnector
    const c = new DaemonConnection(connector, quiet, (async () => new Response('{}')) as typeof fetch)
    await c.client()
    c.markConnected()
    c.markDisconnected('the stream dropped')
    await until(() => calls.length === 1)
    await tick(1_100)
    // A plain refusal would be asked again after 1 s; this one waits the 1.6 s it was given.
    expect(calls).toHaveLength(1)
    expect(c.tokenAllowed).toBe(false)
    expect(c.state.state).not.toBe('failed')
    await until(() => c.tokenAllowed, 3_000)
    expect(calls[1] - calls[0]).toBeGreaterThanOrEqual(1_500)
  })
})

describe('a second drop before the stream opened again (A8)', () => {
  it('re-arms the pin check: the token is withheld again until the fingerprint matches again', async () => {
    let pinChecks = 0
    let pinOk = false
    const connector = Object.assign(async () => ({ baseUrl: 'http://127.0.0.1:47399', logFile: null, description: 'fake', source: { token: () => TOKEN } }), {
      logFile: null,
      pinCheck: async () => { pinChecks++; if (!pinOk) throw new Error('Nothing answers at the address') },
    }) as unknown as DaemonConnector
    const c = new DaemonConnection(connector, quiet, (async () => new Response('{}')) as typeof fetch)
    const client = await c.client()
    c.markConnected()
    c.markDisconnected('the stream dropped')
    expect(c.tokenAllowed).toBe(false)
    pinOk = true
    await until(() => c.tokenAllowed, 3_000)
    const checks = pinChecks
    // The re-dial starting (no error yet) is not a failure: the token goes with it.
    c.markDisconnected()
    expect(c.tokenAllowed).toBe(true)
    // The re-dial after the check fails too (a proxy's 502): the connection is still down.
    pinOk = false
    c.markDisconnected('the re-dial failed')
    expect(c.tokenAllowed).toBe(false)
    expect(client.headers({}).Authorization).toBeUndefined()
    // Checked again (at most once a second), and until it passes the token stays withheld.
    await until(() => pinChecks > checks, 3_000)
    expect(client.headers({}).Authorization).toBeUndefined()
    pinOk = true
    await until(() => c.tokenAllowed, 3_000)
    expect(client.headers({}).Authorization).toBe(`Bearer ${TOKEN}`)
    c.dispose()
  })
})
