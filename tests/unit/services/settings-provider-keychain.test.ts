import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

const h = vi.hoisted(() => ({
  userDataDir: '',
  /** What openKeychainBackend() returns: a fake-keyring backend, or null = no usable keychain. */
  backend: null as unknown,
  opens: 0,
}))

vi.mock('electron', () => ({
  app: { getPath: () => h.userDataDir, on: () => {}, getName: () => 't', getVersion: () => '0' },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
  shell: { openExternal: async () => {} },
  ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {}, removeAllListeners: () => {} },
  BrowserWindow: class {},
  dialog: {},
}))

// The real @napi-rs/keyring is loaded via createRequire (outside vitest's
// module graph), so the keyring is faked one level up: openKeychainBackend
// returns a real KeychainSecretBackend over an in-memory Entry class. No test
// touches the OS keychain.
vi.mock('../../../src/main/services/owner-secret-store', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/main/services/owner-secret-store')>()
  return { ...real, openKeychainBackend: () => { h.opens++; return h.backend } }
})

import { SettingsService } from '../../../src/main/services/settings.service'
import { KeychainSecretBackend } from '../../../src/main/services/owner-secret-store'
import { KeychainProviderKeys, providerKeyAccount, settingsScope } from '../../../src/main/services/provider-key-store'
import { FileSettingsStore } from '../../../src/main/daemon/file-settings-store'
import { SecretBackendProviderKeyVault } from '../../../src/main/daemon/provider-key-vault'
import { DaemonIdentity } from '../../../src/main/daemon/daemon-identity'
import type { ProviderConfig } from '../../../src/shared/types/ipc.types'

const KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef'

function fakeKeyring() {
  const store = new Map<string, string>()
  let reads = 0
  class Entry {
    constructor(private service: string, private account: string) {}
    getPassword() { reads++; return store.get(`${this.service}/${this.account}`) ?? null }
    setPassword(p: string) { store.set(`${this.service}/${this.account}`, p) }
    deleteCredential() { return store.delete(`${this.service}/${this.account}`) }
  }
  return { store, backend: new KeychainSecretBackend(Entry), reads: () => reads }
}

const secretStoreProvider = (id = 'custom:or1'): ProviderConfig => ({
  id, type: 'openrouter', name: 'OpenRouter', baseUrl: '', apiKey: '', apiKeyStorage: 'secret-store',
})

let root: string
let settingsPath: string

function writeSettings(data: Record<string, unknown>): void {
  writeFileSync(settingsPath, JSON.stringify(data))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'adf-settings-keychain-'))
  h.userDataDir = join(root, 'userData')
  mkdirSync(h.userDataDir, { recursive: true })
  settingsPath = join(h.userDataDir, 'adf-settings.json')
  h.backend = null
  h.opens = 0
  delete process.env.ADF_USER_DATA_DIR
})

afterEach(() => {
  delete process.env.ADF_USER_DATA_DIR
  rmSync(root, { recursive: true, force: true })
})

describe('provider-key-store naming', () => {
  it('scope is the daemon runtime-key hash of the resolved settings path', () => {
    const expected = createHash('sha256').update(resolve(settingsPath)).digest('hex').slice(0, 12)
    expect(settingsScope(settingsPath)).toBe(expected)
    expect(providerKeyAccount('abc', 'custom:x')).toBe('provider-api-key:abc:custom:x')
  })

  it('the daemon vault and Studio use the identical keychain entry', () => {
    const kr = fakeKeyring()
    // Daemon wiring (daemon-identity.ts computes the scope itself).
    const daemon = new DaemonIdentity({ settings: new FileSettingsStore(settingsPath), settingsPath, encKey: null, backend: kr.backend })
    daemon.providerKeys.set('custom:or1', KEY)
    const studio = new KeychainProviderKeys(() => settingsPath, () => kr.backend)
    expect(studio.get('custom:or1')).toBe(KEY)
    expect([...kr.store.keys()]).toEqual([`ADF/provider-api-key:${settingsScope(settingsPath)}:custom:or1`])
  })
})

describe('SettingsService secret-store provider keys', () => {
  it('a provider added from the terminal app resolves in Studio (daemon -> Studio)', () => {
    const kr = fakeKeyring()
    h.backend = kr.backend
    // The daemon writes the provider exactly as provider-routes does.
    const daemonSettings = new FileSettingsStore(settingsPath)
    daemonSettings.setProviderKeyVault(new SecretBackendProviderKeyVault(kr.backend, settingsScope(settingsPath)))
    daemonSettings.set('providers', [{ ...secretStoreProvider(), apiKey: KEY }])
    expect(readFileSync(settingsPath, 'utf8')).not.toContain(KEY)

    const settings = new SettingsService()
    expect(settings.getProvider('custom:or1')?.apiKey).toBe(KEY)
    expect((settings.get('providers') as ProviderConfig[])[0].apiKey).toBe(KEY)
    const all = settings.getAll().providers as ProviderConfig[]
    expect(all[0].apiKey).toBe(KEY)
    expect(all[0].apiKeyStatus).toBeUndefined()
  })

  it('saving (echoing the resolved key back) never writes it to the file', () => {
    const kr = fakeKeyring()
    kr.store.set(`ADF/${providerKeyAccount(settingsScope(settingsPath), 'custom:or1')}`, KEY)
    h.backend = kr.backend
    writeSettings({ providers: [secretStoreProvider()] })
    const settings = new SettingsService()
    const echoed = settings.getAll().providers as ProviderConfig[]
    settings.set('providers', echoed.map((p) => ({ ...p, name: 'Renamed' })))
    settings.flush()
    const disk = JSON.parse(readFileSync(settingsPath, 'utf8')) as { providers: ProviderConfig[] }
    expect(JSON.stringify(disk)).not.toContain(KEY)
    expect(disk.providers[0]).toMatchObject({ name: 'Renamed', apiKey: '', apiKeyStorage: 'secret-store' })
    expect(settings.getProvider('custom:or1')?.apiKey).toBe(KEY)
  })

  it('a key typed in Studio for such a provider goes to the keychain (Studio -> daemon)', () => {
    const kr = fakeKeyring()
    h.backend = kr.backend
    writeSettings({ providers: [secretStoreProvider()] })
    const settings = new SettingsService()
    settings.set('providers', [{ ...secretStoreProvider(), apiKey: 'sk-rotated-key-1234' }])
    settings.flush()
    expect(readFileSync(settingsPath, 'utf8')).not.toContain('sk-rotated-key-1234')
    const daemonVault = new SecretBackendProviderKeyVault(kr.backend, settingsScope(settingsPath))
    expect(daemonVault.get('custom:or1')).toBe('sk-rotated-key-1234')
    expect(settings.getProvider('custom:or1')?.apiKey).toBe('sk-rotated-key-1234')
  })

  it('no usable keychain: Studio says so, never crashes, never writes plaintext', () => {
    h.backend = null
    writeSettings({ providers: [secretStoreProvider()] })
    const settings = new SettingsService()
    expect(settings.getProvider('custom:or1')?.apiKey).toBe('')
    const all = settings.getAll().providers as ProviderConfig[]
    expect(all[0]).toMatchObject({ apiKey: '', apiKeyStatus: 'unavailable' })

    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    settings.set('providers', [{ ...all[0], apiKey: 'sk-typed-while-locked' }])
    settings.flush()
    expect(err).toHaveBeenCalled()
    err.mockRestore()
    const raw = readFileSync(settingsPath, 'utf8')
    expect(raw).not.toContain('sk-typed-while-locked')
    expect(raw).not.toContain('apiKeyStatus')
    expect((JSON.parse(raw) as { providers: ProviderConfig[] }).providers[0]).toMatchObject({ apiKey: '', apiKeyStorage: 'secret-store' })
  })

  it('keychain without an entry reports missing; the status is never persisted', () => {
    h.backend = fakeKeyring().backend
    writeSettings({ providers: [secretStoreProvider()] })
    const settings = new SettingsService()
    const all = settings.getAll().providers as ProviderConfig[]
    expect(all[0].apiKeyStatus).toBe('missing')
    settings.set('providers', all)
    settings.flush()
    expect(readFileSync(settingsPath, 'utf8')).not.toContain('apiKeyStatus')
  })

  it('Studio-added (plaintext) providers are untouched and never open the keychain', () => {
    h.backend = fakeKeyring().backend
    const plain: ProviderConfig = { id: 'anthropic', type: 'anthropic', name: 'Anthropic', baseUrl: '', apiKey: 'sk-ant-plain' }
    writeSettings({ providers: [plain] })
    const settings = new SettingsService()
    expect(settings.getProvider('anthropic')?.apiKey).toBe('sk-ant-plain')
    settings.set('providers', settings.getAll().providers)
    settings.flush()
    expect((JSON.parse(readFileSync(settingsPath, 'utf8')) as { providers: ProviderConfig[] }).providers[0].apiKey).toBe('sk-ant-plain')
    expect(h.opens).toBe(0)
  })

  it('caches: the keychain is opened once and a found key read once', () => {
    const kr = fakeKeyring()
    kr.store.set(`ADF/${providerKeyAccount(settingsScope(settingsPath), 'custom:or1')}`, KEY)
    h.backend = kr.backend
    writeSettings({ providers: [secretStoreProvider()] })
    const settings = new SettingsService()
    for (let i = 0; i < 5; i++) {
      settings.getProvider('custom:or1')
      settings.get('providers')
      settings.getAll()
    }
    expect(h.opens).toBe(1)
    expect(kr.reads()).toBe(1)
  })
})

describe('KeychainProviderKeys', () => {
  it('re-checks a miss after the TTL so a key added from the terminal app shows up', () => {
    const kr = fakeKeyring()
    let t = 0
    const keys = new KeychainProviderKeys(() => settingsPath, () => kr.backend, () => t)
    expect(keys.get('p')).toBeNull()
    kr.store.set(`ADF/${providerKeyAccount(settingsScope(settingsPath), 'p')}`, KEY)
    expect(keys.get('p')).toBeNull()
    t += 31_000
    expect(keys.get('p')).toBe(KEY)
  })

  it('a throwing keychain degrades to unavailable/null', () => {
    const keys = new KeychainProviderKeys(() => settingsPath, () => { throw new Error('no secret service') })
    expect(keys.available()).toBe(false)
    expect(keys.get('p')).toBeNull()
    expect(keys.set('p', KEY)).toBe(false)
  })
})
