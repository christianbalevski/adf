/**
 * The daemon's keychain probe at boot (W5-D1): a keychain that exists but
 * does not answer is retried with backoff, the fallback to the passphrase
 * file is reported (GET /identity, GET /version), owner actions that would
 * put secrets in that file are refused, and refresh() probes again. The probe
 * is injected: the real OS keychain is never touched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const h = vi.hoisted(() => ({ userDataDir: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => h.userDataDir, on: () => {}, getName: () => 't', getVersion: () => '0' },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
  shell: { openExternal: async () => {} },
  ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {}, removeAllListeners: () => {} },
  BrowserWindow: class {},
  dialog: {},
}))

import { FileSettingsStore } from '../src/main/daemon/file-settings-store'
import { ensureDaemonEncKey } from '../src/main/daemon/daemon-enc-key'
import { DaemonIdentity, KEYCHAIN_PROBE_DELAYS_MS, TEST_KEYCHAIN_FILE_ENV, type KeychainProbeDeps } from '../src/main/daemon/daemon-identity'
import { createDaemonHttpApi } from '../src/main/daemon/http-api'
import { RuntimeService } from '../src/main/runtime/runtime-service'
import { MockLLMProvider } from '../src/main/runtime/headless'
import { generateMnemonic } from '../src/main/crypto/mnemonic-identity'
import type { KeychainProbe } from '../src/main/services/owner-secret-store'
import { fakeKeychain } from './helpers/studio-runtime-entry'
import { daemonStatus, daemonTarget } from '../src/main/cli/daemon-control'

const PROOF = 'test-local-proof-0123456789abcdefghijklmnopqrstuvwxyz'
const ENV_KEYS = ['ADF_SECRET_STORE', 'ADF_KEYCHAIN', TEST_KEYCHAIN_FILE_ENV] as const
const savedEnv: Record<string, string | undefined> = {}
let root: string
let settingsPath: string
const servers: Array<{ close: () => Promise<unknown> }> = []

beforeEach(() => {
  for (const key of ENV_KEYS) { savedEnv[key] = process.env[key]; delete process.env[key] }
  root = mkdtempSync(join(tmpdir(), 'adf-keychain-probe-'))
  h.userDataDir = join(root, 'userData')
  mkdirSync(h.userDataDir, { recursive: true })
  settingsPath = join(h.userDataDir, 'adf-settings.json')
})

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()))
  for (const key of ENV_KEYS) { if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key] }
  rmSync(root, { recursive: true, force: true })
})

const failing = (error = 'Platform secure storage failure: the service is not running'): KeychainProbe => ({ backend: null, present: true, error })
const working = (): KeychainProbe => ({ backend: fakeKeychain().backend, present: true, error: null })

/** A probe answering from `answers` in turn (the last repeats); counts calls. */
function scripted(answers: Array<() => KeychainProbe>) {
  let calls = 0
  return { probe: () => answers[Math.min(calls++, answers.length - 1)](), calls: () => calls }
}

function makeDaemon(deps: KeychainProbeDeps) {
  const settings = new FileSettingsStore(settingsPath)
  const identity = new DaemonIdentity({ settings, settingsPath, encKey: ensureDaemonEncKey(h.userDataDir), keychainProbe: deps })
  const runtime = new RuntimeService({ settings, providerFactory: () => new MockLLMProvider() })
  const server = createDaemonHttpApi(runtime, { settingsStore: settings, identity, security: { localProof: PROOF } })
  servers.push(server)
  return { identity, server }
}

describe('keychain probe at daemon boot', () => {
  it('a keychain that answers on the third try is used: two waits, 1 s then 4 s, each logged', () => {
    const sleeps: number[] = []
    const probe = scripted([() => failing(), () => failing(), working])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { identity } = makeDaemon({ probe: probe.probe, sleep: (ms) => sleeps.push(ms), platform: 'win32' })
    expect(sleeps).toEqual(KEYCHAIN_PROBE_DELAYS_MS)
    expect(sleeps.reduce((a, b) => a + b, 0)).toBe(5000)
    expect(probe.calls()).toBe(3)
    expect(identity.storage).toBe('keychain')
    expect(identity.status().keychainProblem).toBeNull()
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('The OS keychain did not answer'))).toHaveLength(2)
    warn.mockRestore()
  })

  it('still failing after three tries: the passphrase file, reported in /identity and /version, and create, restore and trust-daemon are refused', async () => {
    const probe = scripted([() => failing()])
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { identity, server } = makeDaemon({ probe: probe.probe, sleep: () => {}, platform: 'darwin', now: () => 0 })
    expect(probe.calls()).toBe(3)
    expect(identity.storage).toBe('file')
    expect(error.mock.calls.some((c) => String(c[0]).includes('could not be read after 3 tries'))).toBe(true)

    const status = (await server.inject({ method: 'GET', url: '/identity' })).json()
    expect(status.storage).toBe('file')
    expect(status.keychainProblem).toContain('The OS keychain could not be read (Platform secure storage failure')
    expect(status.keychainProblem).toContain('adf daemon restart')
    expect((await server.inject({ method: 'GET', url: '/version' })).json().keychainProblem).toBe(status.keychainProblem)

    for (const [url, payload] of [
      ['/identity/restore', { mnemonic: generateMnemonic(), passphrase: 'a long passphrase' }],
      ['/identity/create', { passphrase: 'a long passphrase' }],
      ['/identity/trust-daemon', { confirm: true }],
    ] as const) {
      const res = await server.inject({ method: 'POST', url, headers: { 'x-adf-local-proof': PROOF }, payload })
      expect(res.statusCode, url).toBe(409)
      expect(res.json().code, url).toBe('keychain_unavailable')
      expect(res.json().error, url).toContain('ADF_SECRET_STORE=file')
    }
    vi.restoreAllMocks()
  })

  it('refresh() probes again (at most every 30 s) and says when the keychain answers; the daemon keeps the file until it restarts', () => {
    let now = 0
    const probe = scripted([() => failing(), () => failing(), () => failing(), () => failing(), working])
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { identity } = makeDaemon({ probe: probe.probe, sleep: () => {}, platform: 'win32', now: () => now })
    expect(probe.calls()).toBe(3)
    identity.refresh()
    expect(probe.calls()).toBe(3) // within 30 s: no probe
    now = 30_000
    identity.refresh()
    expect(probe.calls()).toBe(4) // still failing
    now = 60_000
    const status = identity.refresh()
    expect(probe.calls()).toBe(5)
    expect(identity.storage).toBe('file')
    expect(status.keychainProblem).toContain('the keychain answers now. Restart the daemon (adf daemon restart)')
    expect(warn.mock.calls.some((c) => String(c[0]).includes('The OS keychain answers now'))).toBe(true)
    vi.restoreAllMocks()
  })

  it('Linux without a Secret Service is "no keychain": one probe, no wait, no problem reported, nothing refused', () => {
    const sleeps: number[] = []
    const probe = scripted([() => failing('no secret service provider')])
    const { identity } = makeDaemon({ probe: probe.probe, sleep: (ms) => sleeps.push(ms), platform: 'linux' })
    expect(probe.calls()).toBe(1)
    expect(sleeps).toEqual([])
    expect(identity.storage).toBe('file')
    expect(identity.status().keychainProblem).toBeNull()
    expect(identity.create({ passphrase: 'a long passphrase' }).identity.status).toBe('ready')
  })

  it('ADF_SECRET_STORE=file and ADF_KEYCHAIN=0 choose the file on purpose: no probe', () => {
    for (const [key, value] of [['ADF_SECRET_STORE', 'file'], ['ADF_KEYCHAIN', '0']] as const) {
      process.env[key] = value
      const probe = scripted([() => failing()])
      const { identity } = makeDaemon({ probe: probe.probe, sleep: () => {}, platform: 'win32' })
      expect(probe.calls()).toBe(0)
      expect(identity.status().keychainProblem).toBeNull()
      delete process.env[key]
    }
  })

  it('adf daemon status shows the keychain problem', async () => {
    const problem = 'The OS keychain could not be read (x; tried 3 times at start), so the daemon uses the passphrase file owner-secrets.json instead.'
    const fetchImpl = (async (url: string) => {
      const path = new URL(url).pathname
      const body = path === '/version' ? { startedBy: 'cli', keychainProblem: problem } : path === '/health' ? { ok: true } : {}
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const { lines } = await daemonStatus(daemonTarget('http://127.0.0.1:7999'), { env: { ADF_USER_DATA_DIR: h.userDataDir, ADF_DAEMON_TOKEN: 'a'.repeat(43) }, fetch: fetchImpl })
    expect(lines).toContain(`keychain  unavailable: ${problem}`)
  })
})
