/**
 * ADF_SECRET_STORE=keychain is strict: the daemon uses the OS keychain or
 * does not start. It never creates, opens or unlocks the fallback passphrase
 * file (owner-secrets.json), even with the right ADF_OWNER_PASSPHRASE, and a
 * file already there keeps its bytes. Unset and `file` behave as before.
 *
 * The keychain probe is injected (the real OS keychain is never touched);
 * the probe results are the shapes probeKeychain returns for each case. The
 * spawned-daemon half is tests/daemon-strict-keychain-boot.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
import * as daemonIdentity from '../src/main/daemon/daemon-identity'
import { DaemonIdentity, KEYCHAIN_PROBE_DELAYS_MS, SECRET_FILE_NAME, TEST_KEYCHAIN_FILE_ENV, type KeychainProbeDeps } from '../src/main/daemon/daemon-identity'
import { FileSecretBackend, OWNER_MNEMONIC_ACCOUNT, type KeychainProbe, type SecretBackend } from '../src/main/services/owner-secret-store'
import { generateMnemonic } from '../src/main/crypto/mnemonic-identity'
import { fakeKeychain } from './helpers/studio-runtime-entry'

const ENV_KEYS = ['ADF_SECRET_STORE', 'ADF_KEYCHAIN', TEST_KEYCHAIN_FILE_ENV, 'ADF_TEST_SEAMS'] as const
const PASSPHRASE = 'fallback file passphrase 0123'
const savedEnv: Record<string, string | undefined> = {}
let root: string
let settingsPath: string
let secretFile: string
let logged: string[]

beforeEach(() => {
  for (const key of ENV_KEYS) { savedEnv[key] = process.env[key]; delete process.env[key] }
  root = mkdtempSync(join(tmpdir(), 'adf-strict-keychain-'))
  h.userDataDir = join(root, 'userData')
  mkdirSync(h.userDataDir, { recursive: true })
  settingsPath = join(h.userDataDir, 'adf-settings.json')
  secretFile = join(h.userDataDir, SECRET_FILE_NAME)
  logged = []
  for (const level of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')) })
  }
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const key of ENV_KEYS) { if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key] }
  rmSync(root, { recursive: true, force: true })
})

/** probeKeychain's result per case (owner-secret-store.ts). */
const noBinding = (): KeychainProbe => ({ backend: null, present: false, error: null })
const failing = (error: string) => (): KeychainProbe => ({ backend: null, present: true, error })
const working = (backend: SecretBackend = fakeKeychain().backend) => (): KeychainProbe => ({ backend: backend as KeychainProbe['backend'], present: true, error: null })
const NO_SECRET_SERVICE = 'Platform failure: DBus error: The name org.freedesktop.secrets was not provided by any .service files'
const LOCKED = 'Platform failure: The collection is locked'
const MAC_BUSY = 'Platform secure storage failure: User interaction is not allowed.'

function scripted(answers: Array<() => KeychainProbe>) {
  let calls = 0
  return { probe: () => answers[Math.min(calls++, answers.length - 1)](), calls: () => calls }
}

function boot(deps: KeychainProbeDeps, bootPassphrase?: string): DaemonIdentity {
  const settings = new FileSettingsStore(settingsPath)
  return new DaemonIdentity({ settings, settingsPath, encKey: ensureDaemonEncKey(h.userDataDir), keychainProbe: deps, bootPassphrase })
}

/** A fallback file from an earlier run on the file store, holding a phrase. */
function existingFallbackFile(): { bytes: Buffer; mnemonic: string } {
  const mnemonic = generateMnemonic()
  const file = new FileSecretBackend(secretFile)
  file.unlock(PASSPHRASE)
  file.set(OWNER_MNEMONIC_ACCOUNT, mnemonic)
  file.lock()
  return { bytes: readFileSync(secretFile), mnemonic }
}

/** Boot must throw SecretStoreSelectionError having never touched the fallback file. */
function expectRefused(deps: KeychainProbeDeps, bootPassphrase?: string): string {
  const exists = vi.spyOn(FileSecretBackend.prototype, 'exists')
  const unlock = vi.spyOn(FileSecretBackend.prototype, 'unlock')
  let thrown: unknown
  try { boot(deps, bootPassphrase) } catch (err) { thrown = err }
  expect(thrown).toBeInstanceOf(Error)
  expect((thrown as Error).name).toBe('SecretStoreSelectionError')
  expect(thrown).toBeInstanceOf(daemonIdentity.SecretStoreSelectionError)
  expect(exists).not.toHaveBeenCalled()
  expect(unlock).not.toHaveBeenCalled()
  // Nothing written next to the settings (no owner-secrets.json, no .tmp).
  expect(readdirSync(h.userDataDir).filter((f) => f.startsWith(SECRET_FILE_NAME))).toEqual(existsSync(secretFile) ? [SECRET_FILE_NAME] : [])
  return (thrown as Error).message
}

describe('ADF_SECRET_STORE=keychain: the keychain or no start', () => {
  beforeEach(() => { process.env.ADF_SECRET_STORE = 'keychain' })

  it('no native keyring binding: refused after one probe, no wait, no file created', () => {
    const probe = scripted([noBinding])
    const sleeps: number[] = []
    const message = expectRefused({ probe: probe.probe, sleep: (ms) => sleeps.push(ms), platform: 'linux' })
    expect(probe.calls()).toBe(1)
    expect(sleeps).toEqual([])
    expect(message).toContain('no OS keychain binding (@napi-rs/keyring)')
    expect(message).toContain('ADF_SECRET_STORE=file')
    expect(existsSync(secretFile)).toBe(false)
  })

  it('Linux with no Secret Service: refused after one probe (no Linux retry, as before), the probe error in the message', () => {
    const probe = scripted([failing(NO_SECRET_SERVICE)])
    const sleeps: number[] = []
    const message = expectRefused({ probe: probe.probe, sleep: (ms) => sleeps.push(ms), platform: 'linux' })
    expect(probe.calls()).toBe(1)
    expect(sleeps).toEqual([])
    expect(message).toContain(NO_SECRET_SERVICE)
    expect(message).not.toContain('tries')
    expect(existsSync(secretFile)).toBe(false)
  })

  it('a locked or unreadable keyring: refused, never the file', () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      const message = expectRefused({ probe: failing(LOCKED), sleep: () => {}, platform })
      expect(message, platform).toContain(LOCKED)
    }
    expect(existsSync(secretFile)).toBe(false)
  })

  it('Windows and macOS: the same three tries (1 s, then 4 s) before refusing', () => {
    for (const platform of ['win32', 'darwin'] as const) {
      const probe = scripted([failing(MAC_BUSY)])
      const sleeps: number[] = []
      const message = expectRefused({ probe: probe.probe, sleep: (ms) => sleeps.push(ms), platform })
      expect(probe.calls(), platform).toBe(KEYCHAIN_PROBE_DELAYS_MS.length + 1)
      expect(sleeps, platform).toEqual(KEYCHAIN_PROBE_DELAYS_MS)
      expect(message, platform).toContain(`could not be read after 3 tries (${MAC_BUSY})`)
    }
  })

  it('Windows and macOS: a keychain that answers on a retry is used', () => {
    for (const platform of ['win32', 'darwin'] as const) {
      const probe = scripted([failing(MAC_BUSY), failing(MAC_BUSY), working()])
      const sleeps: number[] = []
      const identity = boot({ probe: probe.probe, sleep: (ms) => sleeps.push(ms), platform })
      expect(probe.calls(), platform).toBe(3)
      expect(sleeps, platform).toEqual(KEYCHAIN_PROBE_DELAYS_MS)
      expect(identity.storage, platform).toBe('keychain')
      expect(identity.status().keychainProblem, platform).toBeNull()
    }
    expect(existsSync(secretFile)).toBe(false)
  })

  it('a usable keychain is used on the first probe', () => {
    const probe = scripted([working()])
    const identity = boot({ probe: probe.probe, sleep: () => {}, platform: 'linux' })
    expect(probe.calls()).toBe(1)
    expect(identity.storage).toBe('keychain')
  })

  it('ADF_KEYCHAIN=0 or off conflicts: refused before any probe', () => {
    for (const value of ['0', 'off']) {
      process.env.ADF_KEYCHAIN = value
      const probe = scripted([working()])
      const message = expectRefused({ probe: probe.probe, sleep: () => {}, platform: 'win32' })
      expect(probe.calls()).toBe(0)
      expect(message).toContain(`ADF_SECRET_STORE=keychain conflicts with ADF_KEYCHAIN=${value}`)
    }
  })

  it('the test keychain seam without the test seams: refused, neither the real keychain nor the file', () => {
    process.env[TEST_KEYCHAIN_FILE_ENV] = join(root, 'fake-keychain.json')
    const probe = scripted([working()])
    const message = expectRefused({ probe: probe.probe, sleep: () => {}, platform: 'linux' })
    expect(probe.calls()).toBe(0)
    expect(message).toContain(TEST_KEYCHAIN_FILE_ENV)
  })

  it('the test keychain seam with ADF_TEST_SEAMS=1 still stands in for the keychain', () => {
    process.env[TEST_KEYCHAIN_FILE_ENV] = join(root, 'fake-keychain.json')
    process.env.ADF_TEST_SEAMS = '1'
    const probe = scripted([failing(NO_SECRET_SERVICE)])
    const identity = boot({ probe: probe.probe, sleep: () => {}, platform: 'linux' })
    expect(probe.calls()).toBe(0)
    expect(identity.storage).toBe('keychain')
  })

  it('an existing fallback file keeps its bytes, and the right boot passphrase does not unlock it', () => {
    const { bytes, mnemonic } = existingFallbackFile()
    for (const platform of ['linux', 'darwin'] as const) {
      const message = expectRefused({ probe: failing(LOCKED), sleep: () => {}, platform }, PASSPHRASE)
      expect(readFileSync(secretFile).equals(bytes), platform).toBe(true)
      expect(message).not.toContain(PASSPHRASE)
      expect(message).not.toContain(mnemonic)
    }
    expectRefused({ probe: noBinding, sleep: () => {}, platform: 'linux' }, PASSPHRASE)
    expect(readFileSync(secretFile).equals(bytes)).toBe(true)
    expect(readdirSync(h.userDataDir).filter((f) => f.startsWith(SECRET_FILE_NAME))).toEqual([SECRET_FILE_NAME])
    const output = logged.join('\n')
    expect(output).not.toContain(PASSPHRASE)
    expect(output).not.toContain(mnemonic)
  })

  it('keychain errors after boot do not switch stores or probe again', () => {
    let broken = false
    const keychain = fakeKeychain().backend
    const flaky: SecretBackend = {
      kind: 'keychain',
      isUnlocked: () => true,
      get: (account) => { if (broken) throw new Error(LOCKED); return keychain.get(account) },
      set: (account, value) => { if (broken) throw new Error(LOCKED); keychain.set(account, value) },
      delete: (account) => keychain.delete(account),
    }
    let now = 0
    const probe = scripted([working(flaky)])
    const identity = boot({ probe: probe.probe, sleep: () => {}, platform: 'win32', now: () => now })
    expect(identity.storage).toBe('keychain')
    broken = true
    now = 120_000
    identity.refresh()
    expect(probe.calls()).toBe(1)
    expect(identity.storage).toBe('keychain')
    expect(identity.status().keychainProblem).toBeNull()
    expect(existsSync(secretFile)).toBe(false)
  })
})

describe('ADF_SECRET_STORE values other than keychain and file', () => {
  it('an unknown value refuses to start without echoing it, before any probe', () => {
    for (const value of ['Keychain', 'files', ' keychain', 'sk-ant-not-a-selector']) {
      process.env.ADF_SECRET_STORE = value
      const probe = scripted([working()])
      const message = expectRefused({ probe: probe.probe, sleep: () => {}, platform: 'linux' })
      expect(probe.calls()).toBe(0)
      expect(message).toContain('ADF_SECRET_STORE has an unsupported value')
      if (value.startsWith('sk-')) expect(message).not.toContain(value)
    }
    expect(logged.join('\n')).not.toContain('sk-ant-not-a-selector')
  })

  it('an empty value is unset: the default choice', () => {
    process.env.ADF_SECRET_STORE = ''
    const identity = boot({ probe: failing(NO_SECRET_SERVICE), sleep: () => {}, platform: 'linux' })
    expect(identity.storage).toBe('file')
  })
})

describe('unset and file keep their behavior', () => {
  it('unset: no keychain falls back to the file and the boot passphrase unlocks an existing one', () => {
    existingFallbackFile()
    for (const [probe, platform] of [[noBinding, 'linux'], [failing(NO_SECRET_SERVICE), 'linux'], [failing(MAC_BUSY), 'darwin']] as const) {
      const identity = boot({ probe, sleep: () => {}, platform, now: () => 0 }, PASSPHRASE)
      expect(identity.storage, platform).toBe('file')
      expect(identity.status().status, platform).toBe('ready')
      expect(identity.status().keychainProblem === null, platform).toBe(platform === 'linux')
    }
  })

  it('file: the file with no probe, also with ADF_KEYCHAIN=0', () => {
    process.env.ADF_SECRET_STORE = 'file'
    for (const keychain of [undefined, '0']) {
      if (keychain) process.env.ADF_KEYCHAIN = keychain
      const probe = scripted([working()])
      const identity = boot({ probe: probe.probe, sleep: () => {}, platform: 'win32' })
      expect(probe.calls()).toBe(0)
      expect(identity.storage).toBe('file')
    }
  })

  it('the test keychain seam without the test seams still means the file when unset', () => {
    process.env[TEST_KEYCHAIN_FILE_ENV] = join(root, 'fake-keychain.json')
    writeFileSync(join(root, 'fake-keychain.json'), '{}')
    const identity = boot({ probe: working(), sleep: () => {}, platform: 'linux' })
    expect(identity.storage).toBe('file')
  })
})
