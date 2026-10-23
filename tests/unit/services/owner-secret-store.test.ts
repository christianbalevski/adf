import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  FileSecretBackend,
  KeychainSecretBackend,
  OWNER_MNEMONIC_ACCOUNT,
  readKeychainItemsAsync,
  resetKeychainPreread,
  SecretStoreLockedError,
  WrongPassphraseError,
} from '../../../src/main/services/owner-secret-store'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'adf-secret-store-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const PHRASE = 'abandon ability able about above absent absorb abstract absurd abuse access accident'

describe('FileSecretBackend', () => {
  it('round-trips secrets through the encrypted file and never writes them in plaintext', () => {
    const path = join(dir, 'owner-secrets.json')
    const a = new FileSecretBackend(path)
    expect(a.exists()).toBe(false)
    a.unlock('correct horse battery')
    a.set(OWNER_MNEMONIC_ACCOUNT, PHRASE)
    a.set('runtime', 'rk')
    expect(readFileSync(path, 'utf-8')).not.toContain('abandon')

    const b = new FileSecretBackend(path)
    expect(b.isUnlocked()).toBe(false)
    expect(b.get(OWNER_MNEMONIC_ACCOUNT)).toBeNull()
    b.unlock('correct horse battery')
    expect(b.get(OWNER_MNEMONIC_ACCOUNT)).toBe(PHRASE)
    expect(b.get('runtime')).toBe('rk')
    b.delete('runtime')
    expect(new FileSecretBackend(path).exists()).toBe(true)
  })

  it('rejects a wrong passphrase and stays locked', () => {
    const path = join(dir, 'owner-secrets.json')
    const a = new FileSecretBackend(path)
    a.unlock('correct horse battery')
    a.set(OWNER_MNEMONIC_ACCOUNT, PHRASE)

    const b = new FileSecretBackend(path)
    expect(() => b.unlock('wrong passphrase!')).toThrow(WrongPassphraseError)
    expect(b.isUnlocked()).toBe(false)
    expect(() => b.set('x', 'y')).toThrow(SecretStoreLockedError)
  })

  it('refuses a short passphrase for a new file, and lock() forgets the secrets', () => {
    const path = join(dir, 'owner-secrets.json')
    const a = new FileSecretBackend(path)
    expect(() => a.unlock('short')).toThrow(/at least 8/)
    a.unlock('long enough pass')
    a.set(OWNER_MNEMONIC_ACCOUNT, PHRASE)
    a.lock()
    expect(a.isUnlocked()).toBe(false)
    expect(a.get(OWNER_MNEMONIC_ACCOUNT)).toBeNull()
  })
})

describe('KeychainSecretBackend', () => {
  it('stores under service ADF with Secret Service pinned on Linux', () => {
    const store = new Map<string, string>()
    const seen: unknown[] = []
    class FakeEntry {
      constructor(private service: string, private account: string, opts?: unknown) { seen.push(opts) }
      getPassword() { return store.get(`${this.service}/${this.account}`) ?? null }
      setPassword(p: string) { store.set(`${this.service}/${this.account}`, p) }
      deleteCredential() { return store.delete(`${this.service}/${this.account}`) }
    }
    const backend = new KeychainSecretBackend(FakeEntry)
    expect(backend.get(OWNER_MNEMONIC_ACCOUNT)).toBeNull()
    backend.set(OWNER_MNEMONIC_ACCOUNT, PHRASE)
    expect(store.get('ADF/owner-mnemonic')).toBe(PHRASE)
    expect(backend.get(OWNER_MNEMONIC_ACCOUNT)).toBe(PHRASE)
    backend.delete(OWNER_MNEMONIC_ACCOUNT)
    expect(backend.get(OWNER_MNEMONIC_ACCOUNT)).toBeNull()
    expect(seen[0]).toEqual({ linux: { store: 'secret-service' } })
  })
})

describe('readKeychainItemsAsync (one read of every item serves the reads after it)', () => {
  afterEach(() => { resetKeychainPreread(); vi.useRealTimers() })

  function fakeKeychain(items: Record<string, string>) {
    const reads: string[] = []
    class FakeEntry {
      constructor(private service: string, private account: string) {}
      getPassword() { reads.push(this.account); return items[this.account] ?? null }
      setPassword(p: string) { items[this.account] = p }
      deleteCredential() { delete items[this.account] }
    }
    const find = vi.fn(async () => Object.entries(items).map(([account, password]) => ({ account, password })))
    return { reads, find, backend: new KeychainSecretBackend(FakeEntry) }
  }

  it('reads each item once: the sync reads after it and further callers take its values', async () => {
    const k = fakeKeychain({ 'owner-mnemonic': PHRASE, 'remote-token:AB': 'tok' })
    const [a, b] = await Promise.all([readKeychainItemsAsync('ADF', k.find), readKeychainItemsAsync('ADF', k.find)])
    expect([a, b]).toEqual([2, 2])
    expect(await readKeychainItemsAsync('ADF', k.find)).toBe(2)
    expect(k.find).toHaveBeenCalledOnce()
    expect(k.backend.get('owner-mnemonic')).toBe(PHRASE)
    expect(k.backend.get('remote-token:AB')).toBe('tok')
    expect(k.reads).toEqual([])
    // An item not in that read is read from the keychain.
    expect(k.backend.get('other')).toBeNull()
    expect(k.reads).toEqual(['other'])
  })

  it('writes and deletes keep it current, and it expires', async () => {
    vi.useFakeTimers()
    const k = fakeKeychain({ 'remote-token:AB': 'old' })
    await readKeychainItemsAsync('ADF', k.find)
    k.backend.set('remote-token:AB', 'new')
    expect(k.backend.get('remote-token:AB')).toBe('new')
    k.backend.delete('remote-token:AB')
    expect(k.backend.get('remote-token:AB')).toBeNull()
    expect(k.reads).toEqual(['remote-token:AB'])
    vi.advanceTimersByTime(61_000)
    await readKeychainItemsAsync('ADF', k.find)
    expect(k.find).toHaveBeenCalledTimes(2)
  })
})
