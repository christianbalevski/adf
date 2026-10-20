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

const URL_ = 'http://100.101.102.103:7385'
const TOKEN = 'adfd_' + 'p'.repeat(40)
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

/** A daemon at URL_: /health, /version behind the token, /remote/hello with `fingerprint()` (null: nothing answers). */
function fakeServer(fingerprint: () => string | null) {
  const sent: Array<{ path: string; auth: string | null }> = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const auth = new Headers(init?.headers).get('authorization')
    sent.push({ path: url.pathname, auth })
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    if (url.pathname === '/remote/hello') {
      const fp = fingerprint()
      if (fp === null) throw new TypeError('fetch failed')
      return json(200, { v: 1, name: 'rawl-hub', fingerprint: fp, pairingOpen: false, api: '2' })
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
    const connect = Object.assign(async () => ({ baseUrl: URL_, source: { token: () => TOKEN }, logFile: null, description: 'rawl-hub' }), { logFile: null, pinCheck }) as DaemonConnector
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
    const { server, connection } = setup(async () => { throw new PinMismatchError('http://x is not rawl-hub (fingerprint EVIL-2345, paired as ABCD-EFGH); the token was not sent.') })
    const client = await connection.client()
    connection.markConnected()
    connection.markDisconnected('the stream dropped')
    await until(() => connection.state.state === 'failed')
    expect(connection.state).toEqual({ state: 'failed', message: 'http://x is not rawl-hub (fingerprint EVIL-2345, paired as ABCD-EFGH); the token was not sent.' })
    await expect(client.request('GET', '/agents')).rejects.toThrow(/not rawl-hub/)
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
  const config: StudioBackendConfig = { ...defaultBackendConfig(), mode: 'remote', remote: { url: null, token: null, allowInsecureHttp: false, name: 'rawl-hub' } }

  it('pinCheck passes for the paired fingerprint, rejects PinMismatchError for another, and a plain error while nothing answers', async () => {
    const env = savedEnv()
    await saveConnection(env, { url: URL_, token: TOKEN, fingerprint: 'ABCD-EFGH', hostName: 'rawl-hub', deviceId: 'd', label: 'l' })
    let fp: string | null = 'ABCD-EFGH'
    const server = fakeServer(() => fp)
    const connector = remoteDaemonConnector(config, codec, { env, fetch: server.fetch })
    expect(connector.pinCheck).toBeTypeOf('function')
    await connector(() => {})
    await expect(connector.pinCheck!()).resolves.toBeUndefined()
    fp = 'EVIL-2345'
    const mismatch = await connector.pinCheck!().catch((e) => e)
    expect(mismatch).toBeInstanceOf(PinMismatchError)
    expect(mismatch.message).toBe(`${URL_} is not rawl-hub (fingerprint EVIL-2345, paired as ABCD-EFGH); the token was not sent.`)
    fp = null
    const down = await connector.pinCheck!().catch((e) => e)
    expect(down).not.toBeInstanceOf(PinMismatchError)
    expect(down.message).toBe(`${URL_} does not answer as rawl-hub; the token was not sent.`)
  })

  it('the remote URL without a fingerprint has no pin', () => {
    expect(remoteDaemonConnector({ ...defaultBackendConfig(), mode: 'remote', remote: { url: URL_, token: 'safe:x', allowInsecureHttp: false } }, codec).pinCheck).toBeUndefined()
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
