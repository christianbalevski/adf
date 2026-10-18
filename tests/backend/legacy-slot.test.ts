/**
 * A remote paired before the shared list (studio-backend.json remote.url,
 * token and paired) is pinned like every saved connection, and moves into
 * cli-remotes.json and the keychain on its first use (review item 4).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => (await import('./daemon-mode-electron')).electronStub.module)

import { SUPPORTED_CLIENT_API_VERSION } from '../../src/shared/daemon-client'
import { resolveBootBackend, type SecretCodec, type StudioBackendConfig } from '../../src/main/backend/backend-config'
import { migratePairedSlot, remotesEnv } from '../../src/main/backend/connections'
import { remoteDaemonConnector, RemoteConnectError } from '../../src/main/backend/daemon-mode/remote/connector'
import { loadRemotes, readRemoteToken } from '../../src/main/cli/remotes'

const URL_ = 'http://100.101.102.103:7385'
const TOKEN = 'adfd_' + 'q'.repeat(40)
const codec: SecretCodec = { available: () => true, encrypt: (p) => `safe:${p}`, decrypt: (s) => s.slice(5) }
const quiet = { log: () => {}, warn: () => {} }
const paired = { fingerprint: 'ABCD-EFGH', name: 'rawl-hub', deviceId: 'dev1', label: 'agent-2 laptop' }
const slotConfig = (mode: 'local' | 'remote'): StudioBackendConfig => ({ v: 1, mode, keepDaemonRunning: false, remote: { url: URL_, token: codec.encrypt(TOKEN), allowInsecureHttp: false, paired } })

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function setup(mode: 'local' | 'remote', keychain = true) {
  const dir = mkdtempSync(join(tmpdir(), 'adf-legacy-slot-'))
  dirs.push(dir)
  const env = keychain ? { ...remotesEnv(dir), ADF_TEST_KEYCHAIN_FILE: join(dir, 'keychain.json'), ADF_TEST_SEAMS: '1' } : { ...remotesEnv(dir), ADF_KEYCHAIN: '0' }
  if (keychain) delete env.ADF_KEYCHAIN
  const path = join(dir, 'studio-backend.json')
  writeFileSync(path, JSON.stringify(slotConfig(mode)))
  return { env, path, boot: resolveBootBackend(path, {}, quiet) }
}

function fakeServer(fingerprint: string) {
  const sent: Array<{ path: string; auth: string | null }> = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    sent.push({ path: url.pathname, auth: new Headers(init?.headers).get('authorization') })
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
    if (url.pathname === '/remote/hello') return json(200, { v: 1, name: 'x', fingerprint, pairingOpen: false, api: '2' })
    if (url.pathname === '/health') return json(200, { ok: true })
    if (url.pathname === '/version') return json(200, { version: '0.9.0', clientApiVersion: SUPPORTED_CLIENT_API_VERSION, pid: 1, startedBy: 'cli' })
    return json(200, {})
  }) as typeof fetch
  return { fetch: fetchImpl, tokenSent: () => sent.some((s) => s.auth === `Bearer ${TOKEN}`) }
}

describe('the paired remote URL of studio-backend.json', () => {
  it('moves into the shared list on first use; remote mode then uses it by name; the file keeps no token', async () => {
    const s = setup('remote')
    expect(await migratePairedSlot(s.boot, codec, s.env, quiet)).toBe('rawl-hub')
    expect(loadRemotes(s.env).remotes['rawl-hub']).toMatchObject({ url: URL_, fingerprint: 'ABCD-EFGH', deviceId: 'dev1', label: 'agent-2 laptop' })
    expect(readRemoteToken('ABCD-EFGH', s.env)).toBe(TOKEN)
    const file = JSON.parse(readFileSync(s.path, 'utf8'))
    expect(file.mode).toBe('remote')
    expect(file.remote).toEqual({ url: null, token: null, allowInsecureHttp: false, name: 'rawl-hub' })
    expect(s.boot.config.remote.name).toBe('rawl-hub')
    // Done once: nothing left to move.
    expect(await migratePairedSlot(s.boot, codec, s.env, quiet)).toBeNull()
  })

  it('in local mode it moves too, without becoming the connection in use', async () => {
    const s = setup('local')
    expect(await migratePairedSlot(s.boot, codec, s.env, quiet)).toBe('rawl-hub')
    expect(JSON.parse(readFileSync(s.path, 'utf8')).remote).toEqual({ url: null, token: null, allowInsecureHttp: false })
  })

  it('a keychain that does not take it keeps the slot, and the connector still checks its pin before the token', async () => {
    const s = setup('remote', false)
    expect(await migratePairedSlot(s.boot, codec, s.env, quiet)).toBeNull()
    expect(s.boot.config.remote.url).toBe(URL_)
    const evil = fakeServer('EVIL-2345')
    const connector = remoteDaemonConnector(s.boot.config, codec, { env: s.env, fetch: evil.fetch, retry: { maxAttempts: 1 } })
    expect(connector.pinCheck).toBeTypeOf('function')
    const error = await connector(() => {}).catch((e) => e)
    expect(error).toBeInstanceOf(RemoteConnectError)
    expect(error).toMatchObject({ problem: 'fingerprint' })
    expect(evil.tokenSent()).toBe(false)
    const real = fakeServer('ABCD-EFGH')
    expect((await remoteDaemonConnector(s.boot.config, codec, { env: s.env, fetch: real.fetch })(() => {})).baseUrl).toBe(URL_)
  })

  it('a pasted token (no pairing) stays as it is', async () => {
    const s = setup('remote')
    s.boot.config = { ...s.boot.config, remote: { ...s.boot.config.remote, paired: null } }
    mkdirSync(join(s.env.ADF_DAEMON_SETTINGS!, '..'), { recursive: true })
    expect(await migratePairedSlot(s.boot, codec, s.env, quiet)).toBeNull()
    expect(remoteDaemonConnector(s.boot.config, codec).pinCheck).toBeUndefined()
  })
})
