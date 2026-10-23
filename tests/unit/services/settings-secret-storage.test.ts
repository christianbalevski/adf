import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * Studio's own secrets through SettingsService against a fake safeStorage
 * whose availability each test sets: no keychain, Linux basic_text, a working
 * keychain, a keychain that stops decrypting. Never the real keychain.
 */
const h = vi.hoisted(() => ({ userDataDir: '', available: false, backend: 'gnome_libsecret', decryptThrows: false }))

vi.mock('electron', () => ({
  app: { getPath: () => h.userDataDir, on: () => {}, getName: () => 't', getVersion: () => '0', isPackaged: false },
  safeStorage: {
    isEncryptionAvailable: () => h.available,
    getSelectedStorageBackend: () => h.backend,
    // Reversible and recognisable: 'K' + reversed text.
    encryptString: (s: string) => { if (!h.available) throw new Error('Encryption is not available.'); return Buffer.from('K' + [...s].reverse().join('')) },
    decryptString: (b: Buffer) => {
      if (!h.available || h.decryptThrows) throw new Error('keychain access denied')
      return [...b.toString().slice(1)].reverse().join('')
    },
  },
  shell: { openExternal: async () => {} },
  ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {}, removeAllListeners: () => {} },
  BrowserWindow: class {},
  dialog: {},
}))

import { SettingsService } from '../../../src/main/services/settings.service'
import { SECRET_STORAGE_POLICY_KEY, SecretStorageRefusedError, choosePlaintextStorage } from '../../../src/main/services/secret-storage-policy'
import { AppSettingsOAuthStore, MCP_OAUTH_SETTINGS_KEY, type McpOAuthRecord } from '../../../src/main/services/mcp-oauth-store'
import { ownerMnemonicSupersededKey } from '../../../src/main/services/owner-identity.service'
import { generateMnemonic, deriveOwnerIdentity } from '../../../src/main/crypto/mnemonic-identity'

const SECRET_KEYS = ['ownerMnemonic', 'runtimePrivateKey', 'runtimeEncPrivateKey', MCP_OAUTH_SETTINGS_KEY]

let rootDir: string
const settingsPath = () => join(h.userDataDir, 'adf-settings.json')
const disk = (): Record<string, unknown> => (existsSync(settingsPath()) ? JSON.parse(readFileSync(settingsPath(), 'utf-8')) : {})
const seed = (data: Record<string, unknown>) => writeFileSync(settingsPath(), JSON.stringify(data, null, 2))
const record = (): McpOAuthRecord => ({
  serverUrl: 'https://mcp.example/mcp',
  tokens: { access_token: 'at-123', token_type: 'bearer' } as McpOAuthRecord['tokens'],
  updatedAt: 1,
} as McpOAuthRecord)

beforeEach(() => {
  h.available = false
  h.backend = 'gnome_libsecret'
  h.decryptThrows = false
  rootDir = mkdtempSync(join(tmpdir(), 'adf-settings-secret-storage-'))
  h.userDataDir = join(rootDir, 'userData')
  process.env.ADF_USER_DATA_DIR = h.userDataDir
  mkdirSync(h.userDataDir, { recursive: true })
})

afterEach(() => {
  delete process.env.ADF_USER_DATA_DIR
  rmSync(rootDir, { recursive: true, force: true })
})

describe('no keychain and no plain-text choice', () => {
  it('a fresh install mints nothing and writes no secret, no owner and no runtime DID', () => {
    const settings = new SettingsService()
    expect(() => settings.ensureRuntimeIdentity()).toThrow(SecretStorageRefusedError)
    const onDisk = disk()
    for (const key of [...SECRET_KEYS, 'ownerDid', 'runtimeDid', 'runtimeDelegation', 'legacyOwnerDids', SECRET_STORAGE_POLICY_KEY]) expect(onDisk[key]).toBeUndefined()
  })

  it.skipIf(process.platform !== 'linux')('Linux basic_text obfuscation is not a keychain', () => {
    h.available = true
    h.backend = 'basic_text'
    const settings = new SettingsService()
    expect(settings.isSafeStorageAvailable()).toBe(false)
    expect(() => settings.setSecret('ownerMnemonic', 'words')).toThrow(SecretStorageRefusedError)
    expect(disk().ownerMnemonic).toBeUndefined()
  })

  it('every secret write path is refused: phrase, superseded copy, runtime keys, MCP sign-ins, import', async () => {
    const settings = new SettingsService()
    for (const key of [...SECRET_KEYS, ownerMnemonicSupersededKey('did:key:zOld')]) {
      expect(() => settings.setSecret(key, 'value')).toThrow(SecretStorageRefusedError)
    }
    await expect(new AppSettingsOAuthStore(settings).save('https://mcp.example/mcp', record())).rejects.toThrow(/Cannot store MCP OAuth tokens/)
    expect(() => settings.getOwnerIdentity().importMnemonic(generateMnemonic())).toThrow(SecretStorageRefusedError)
    expect(Object.keys(disk()).filter((k) => SECRET_KEYS.includes(k) || k.startsWith('ownerMnemonicSuperseded:') || k === 'legacyOwnerDids')).toEqual([])
  })

  it('an owner switch by import is refused before legacyOwnerDids changes', () => {
    h.available = true
    const settings = new SettingsService()
    settings.ensureRuntimeIdentity()
    const before = disk()
    h.available = false
    expect(() => settings.getOwnerIdentity().importMnemonic(generateMnemonic())).toThrow(SecretStorageRefusedError)
    expect(disk()).toEqual(before)
  })

  it('secrets and the choice are never ordinary settings (the renderer\'s settings:set)', () => {
    h.available = true
    const settings = new SettingsService()
    for (const key of [...SECRET_KEYS, ownerMnemonicSupersededKey('did:key:zX'), SECRET_STORAGE_POLICY_KEY]) {
      expect(() => settings.set(key, 'plaintext')).toThrow(/cannot be written as an ordinary setting/)
    }
    settings.setSecret('ownerMnemonic', 'words')
    settings.setSecret(ownerMnemonicSupersededKey('did:key:zX'), 'old words')
    const all = settings.getAll()
    expect(Object.keys(all).filter((k) => SECRET_KEYS.includes(k) || k.startsWith('ownerMnemonicSuperseded:'))).toEqual([])
  })
})

describe('the plain-text choice', () => {
  it.each(['unavailable', 'denied'] as const)('preserves existing MCP sign-ins when the keychain is %s, then merges after unlocking', async (state) => {
    h.available = true
    const settings = new SettingsService()
    const original = record()
    await new AppSettingsOAuthStore(settings).save(original.serverUrl!, original)
    const sealed = disk()[MCP_OAUTH_SETTINGS_KEY]
    expect(sealed).toMatch(/^safe:/)

    // The launch choice permits new plaintext secrets, but keeps old ciphertext.
    expect(choosePlaintextStorage(settingsPath()).ok).toBe(true)
    h.available = state !== 'unavailable'
    h.decryptThrows = state === 'denied'
    const later = new SettingsService()
    const store = new AppSettingsOAuthStore(later)
    const bytes = readFileSync(settingsPath(), 'utf-8')
    const next = { ...record(), serverUrl: 'https://new.example/mcp' }
    expect(later.secretWriteRefusal()).toBeNull()
    expect(later.secretStatus(MCP_OAUTH_SETTINGS_KEY)).toBe('locked')
    await expect(store.get(original.serverUrl!)).resolves.toBeUndefined()
    await expect(store.save(next.serverUrl, next)).rejects.toThrow(/existing.*locked/i)
    await expect(store.invalidate(original.serverUrl!)).rejects.toThrow(/existing.*locked/i)
    expect(readFileSync(settingsPath(), 'utf-8')).toBe(bytes)
    expect(disk()[MCP_OAUTH_SETTINGS_KEY]).toBe(sealed)

    h.available = true
    h.decryptThrows = false
    await expect(store.get(original.serverUrl!)).resolves.toEqual(original)
    await store.save(next.serverUrl, next)
    await expect(store.get(original.serverUrl!)).resolves.toEqual(original)
    await expect(store.get(next.serverUrl)).resolves.toEqual(next)
  })

  it('stores secrets as plain text, is remembered across restarts, and stays visible while the keychain works', () => {
    seed({ [SECRET_STORAGE_POLICY_KEY]: 'plaintext' })
    const first = new SettingsService()
    const ids = first.ensureRuntimeIdentity()
    const phrase = first.getSecret('ownerMnemonic')!
    expect(disk().ownerMnemonic).toBe(phrase)
    expect(first.secretStorageStatus()).toMatchObject({ policy: 'plaintext', keyringAvailable: false, plaintextSecrets: 3, writesBlocked: false })

    // Restart, now with a working keychain: the same identity; still plain text, no silent switch.
    h.available = true
    const second = new SettingsService()
    expect(second.ensureRuntimeIdentity()).toEqual(ids)
    second.setSecret(MCP_OAUTH_SETTINGS_KEY, '{}')
    expect(disk()[MCP_OAUTH_SETTINGS_KEY]).toBe('{}')
    expect(second.secretStorageStatus()).toMatchObject({ policy: 'plaintext', keyringAvailable: true, plaintextSecrets: 4, writesBlocked: false })
  })

  it('leaves values already encrypted by the keychain encrypted (never decrypts them to plain text)', () => {
    h.available = true
    const settings = new SettingsService()
    settings.ensureRuntimeIdentity()
    const sealed = disk().ownerMnemonic as string
    expect(sealed).toMatch(/^safe:/)
    h.available = false
    writeFileSync(settingsPath(), JSON.stringify({ ...disk(), [SECRET_STORAGE_POLICY_KEY]: 'plaintext' }))
    const later = new SettingsService()
    expect(later.secretStatus('ownerMnemonic')).toBe('locked')
    later.ensureRuntimeIdentity() // locked: nothing minted over it
    expect(disk().ownerMnemonic).toBe(sealed)
  })
})

describe('switching back to the keychain (Settings → Identity)', () => {
  it('encrypts every secret in place, keeps owner and runtime identity and every key, and remembers the switch', () => {
    seed({ [SECRET_STORAGE_POLICY_KEY]: 'plaintext', theme: 'dark', providers: [{ id: 'anthropic', type: 'anthropic', name: 'Anthropic', baseUrl: '', apiKey: 'sk-ant' }] })
    const settings = new SettingsService()
    const ids = settings.ensureRuntimeIdentity()
    settings.setSecret(MCP_OAUTH_SETTINGS_KEY, JSON.stringify({ 'https://mcp.example/mcp': record() }))
    settings.setSecret(ownerMnemonicSupersededKey('did:key:zOld'), 'previous owner words')
    const svc = settings.getOwnerIdentity()
    const before = {
      phrase: settings.getSecret('ownerMnemonic'),
      runtimeKey: svc.getRuntimeSigningKey()!.toString('base64'),
      ownerKey: svc.getOwnerSigningKey()!.toString('base64'),
      oauth: settings.getSecret(MCP_OAUTH_SETTINGS_KEY),
      superseded: settings.getSecret(ownerMnemonicSupersededKey('did:key:zOld')),
      encPub: disk().runtimeEncPublicKey,
    }

    h.available = true
    expect(settings.secretStorageStatus()).toMatchObject({ policy: 'plaintext', keyringAvailable: true, plaintextSecrets: 5 })
    expect(settings.useKeyringForSecrets()).toMatchObject({ ok: true, encrypted: 5 })

    const onDisk = disk()
    expect(onDisk[SECRET_STORAGE_POLICY_KEY]).toBe('keyring')
    for (const key of [...SECRET_KEYS, ownerMnemonicSupersededKey('did:key:zOld')]) expect(onDisk[key]).toMatch(/^safe:/)
    expect(onDisk.theme).toBe('dark')
    expect((onDisk.providers as Array<{ apiKey: string }>)[0].apiKey).toBe('sk-ant') // ordinary setting, not covered

    // This process and a restart read the very same values: nothing re-minted.
    for (const s of [settings, new SettingsService()]) {
      const o = s.getOwnerIdentity()
      expect(s.ensureRuntimeIdentity()).toEqual(ids)
      expect(s.getSecret('ownerMnemonic')).toBe(before.phrase)
      expect(o.getRuntimeSigningKey()!.toString('base64')).toBe(before.runtimeKey)
      expect(o.getOwnerSigningKey()!.toString('base64')).toBe(before.ownerKey)
      expect(s.getSecret(MCP_OAUTH_SETTINGS_KEY)).toBe(before.oauth)
      expect(s.getSecret(ownerMnemonicSupersededKey('did:key:zOld'))).toBe(before.superseded)
      expect(s.secretStorageStatus()).toMatchObject({ policy: 'keyring', keyringAvailable: true, plaintextSecrets: 0, writesBlocked: false })
    }
    expect(disk().runtimeEncPublicKey).toBe(before.encPub)
    expect(deriveOwnerIdentity(before.phrase!).did).toBe(ids.ownerDid)
  })

  it('without the keychain changes nothing', () => {
    seed({ [SECRET_STORAGE_POLICY_KEY]: 'plaintext' })
    const settings = new SettingsService()
    settings.ensureRuntimeIdentity()
    const bytes = readFileSync(settingsPath(), 'utf-8')
    expect(settings.useKeyringForSecrets()).toEqual({ ok: false, error: 'The OS keychain is not available. Nothing was changed.' })
    expect(readFileSync(settingsPath(), 'utf-8')).toBe(bytes)
    expect(settings.secretStorageStatus().policy).toBe('plaintext')
  })

  it('a keychain that encrypts but cannot decrypt back changes nothing', () => {
    seed({ [SECRET_STORAGE_POLICY_KEY]: 'plaintext' })
    const settings = new SettingsService()
    settings.ensureRuntimeIdentity()
    const bytes = readFileSync(settingsPath(), 'utf-8')
    h.available = true
    h.decryptThrows = true
    const result = settings.useKeyringForSecrets()
    expect(result.ok).toBe(false)
    expect(readFileSync(settingsPath(), 'utf-8')).toBe(bytes)
    h.decryptThrows = false
    expect(settings.getSecret('ownerMnemonic')).toBe(JSON.parse(bytes).ownerMnemonic)
  })
})

describe('keychain chosen, then unavailable (Continue Without Keychain)', () => {
  it('blocks writes, never re-mints, and leaves the ciphertext byte-for-byte', async () => {
    h.available = true
    const settings = new SettingsService()
    const ids = settings.ensureRuntimeIdentity()
    const bytes = readFileSync(settingsPath(), 'utf-8')

    h.available = false
    const later = new SettingsService()
    expect(later.secretStorageStatus()).toMatchObject({ policy: 'keyring', keyringAvailable: false, plaintextSecrets: 0, writesBlocked: true })
    expect(later.ensureRuntimeIdentity()).toEqual(ids) // locked: reported, nothing minted
    expect(later.getOwnerIdentity().getStatus().mnemonicLocked).toBe(true)
    expect(() => later.setSecret('runtimePrivateKey', 'replacement')).toThrow(SecretStorageRefusedError)
    await expect(new AppSettingsOAuthStore(later).save('https://mcp.example/mcp', record())).rejects.toThrow(/Cannot store MCP OAuth tokens/)
    expect(readFileSync(settingsPath(), 'utf-8')).toBe(bytes)

    // The keychain is back: the same identity reads again.
    h.available = true
    const back = new SettingsService()
    expect(back.ensureRuntimeIdentity()).toEqual(ids)
    expect(back.getOwnerIdentity().getStatus().mnemonicLocked).toBe(false)
  })
})

describe('source audit', () => {
  const SRC = resolve(__dirname, '../../../src')
  function files(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []))
  }
  const sources = files(join(SRC, 'main')).map((path) => ({ path: path.slice(SRC.length + 1), text: readFileSync(path, 'utf-8') }))

  it('setSecret is called only from the identity service and the MCP sign-in store', () => {
    const callers = sources.filter((f) => /\.setSecret\(/.test(f.text)).map((f) => f.path).sort()
    expect(callers).toEqual(['main/services/mcp-oauth-store.ts', 'main/services/owner-identity.service.ts'])
  })

  it('nothing in Studio main writes a secret key into the settings data directly', () => {
    // Raw writes of Studio's secret keys: the handover (safeStorage only, refuses without it) and the daemon's
    // owner-switch move of Studio's existing copy, verbatim. Every other module goes through setSecret.
    const raw = /(\[\s*(MCP_OAUTH_SETTINGS_KEY|'ownerMnemonic'|'runtimePrivateKey'|'runtimeEncPrivateKey')\s*\]\s*=)|(\.set\(\s*(MCP_OAUTH_SETTINGS_KEY|'ownerMnemonic'|'runtimePrivateKey'|'runtimeEncPrivateKey')\b)/
    const writers = sources.filter((f) => raw.test(f.text)).map((f) => f.path).sort()
    expect(writers).toEqual(['main/backend/handover.ts'])
  })
})
