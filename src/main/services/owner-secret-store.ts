/**
 * Headless secret storage for the owner identity (daemon/CLI users who never
 * run Studio), plus the one keychain entry Studio and the daemon share.
 *
 * Two backends behind one small interface:
 *  - KeychainSecretBackend: the OS keychain (Windows Credential Manager,
 *    macOS Keychain, Linux Secret Service) via @napi-rs/keyring. N-API, so the
 *    same prebuilt binary loads under Node (daemon) and Electron (Studio).
 *  - FileSecretBackend: a passphrase-encrypted JSON file (scrypt +
 *    AES-256-GCM, 0600) for machines without a usable keychain (headless
 *    Linux). Locked until unlock(passphrase).
 *
 * Electron-free and never logs secret values.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { createRequire } from 'module'

/** Keychain service name shared by Studio and the daemon. */
export const KEYCHAIN_SERVICE = 'ADF'
/** Keychain account holding the owner's BIP-39 phrase (shared Studio ↔ daemon). */
export const OWNER_MNEMONIC_ACCOUNT = 'owner-mnemonic'

export type SecretStorageKind = 'keychain' | 'file'

export interface SecretBackend {
  readonly kind: SecretStorageKind
  /** False only for a file backend that exists but has not been unlocked. */
  isUnlocked(): boolean
  get(account: string): string | null
  set(account: string, value: string): void
  delete(account: string): void
}

export class WrongPassphraseError extends Error {
  constructor() {
    super('Wrong passphrase')
    this.name = 'WrongPassphraseError'
  }
}

export class SecretStoreLockedError extends Error {
  constructor(message = 'The owner secret file is locked — unlock it with its passphrase first') {
    super(message)
    this.name = 'SecretStoreLockedError'
  }
}

// ---------------------------------------------------------------------------
// Keychain
// ---------------------------------------------------------------------------

interface KeyringEntry {
  getPassword(): string | null
  setPassword(password: string): void
  deleteCredential(): boolean
}
type KeyringEntryCtor = new (service: string, account: string, opts?: { linux?: { store?: 'secret-service' | 'keyutils' } }) => KeyringEntry

let keyringCtor: KeyringEntryCtor | null | undefined

function loadKeyring(): KeyringEntryCtor | null {
  if (keyringCtor !== undefined) return keyringCtor
  try {
    // Lazy: a missing/incompatible native binary must degrade to the file
    // backend, never break module load.
    const req = createRequire(import.meta.url)
    keyringCtor = (req('@napi-rs/keyring') as { Entry: KeyringEntryCtor }).Entry
  } catch {
    keyringCtor = null
  }
  return keyringCtor
}

export class KeychainSecretBackend implements SecretBackend {
  readonly kind = 'keychain' as const
  constructor(private readonly Entry: KeyringEntryCtor, private readonly service = KEYCHAIN_SERVICE) {}

  private entry(account: string): KeyringEntry {
    // Secret Service only on Linux: keyutils is per-session and would lose the
    // phrase at logout.
    return new this.Entry(this.service, account, { linux: { store: 'secret-service' } })
  }

  isUnlocked(): boolean { return true }

  get(account: string): string | null {
    return this.entry(account).getPassword() ?? null
  }

  set(account: string, value: string): void {
    this.entry(account).setPassword(value)
  }

  delete(account: string): void {
    try { this.entry(account).deleteCredential() } catch { /* absent */ }
  }
}

/**
 * The OS keychain, or null when it cannot be used here (no native binary, no
 * Secret Service on a headless box, ADF_KEYCHAIN=0). Probes with a read so an
 * unusable store is detected up front instead of on the first write.
 */
export function openKeychainBackend(): KeychainSecretBackend | null {
  if (process.env.ADF_KEYCHAIN === '0' || process.env.ADF_KEYCHAIN === 'off') return null
  const Entry = loadKeyring()
  if (!Entry) return null
  try {
    const backend = new KeychainSecretBackend(Entry)
    backend.get(OWNER_MNEMONIC_ACCOUNT)
    return backend
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Passphrase-encrypted file
// ---------------------------------------------------------------------------

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
/** Known plaintext sealed with the key, so a wrong passphrase is detected even with no secrets stored. */
const CHECK_VALUE = 'adf-owner-secrets-v1'

interface SealedValue { iv: string; tag: string; ct: string }
interface SecretFileShape {
  v: 1
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string }
  check: SealedValue
  data: SealedValue
}

function seal(key: Buffer, plaintext: string): SealedValue {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()])
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64') }
}

function open(key: Buffer, sealed: SealedValue): string {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(sealed.ct, 'base64')), decipher.final()]).toString('utf-8')
}

export const MIN_PASSPHRASE_LENGTH = 8

export class FileSecretBackend implements SecretBackend {
  readonly kind = 'file' as const
  private key: Buffer | null = null
  private salt: Buffer | null = null
  private values: Record<string, string> = {}

  constructor(readonly filePath: string) {}

  exists(): boolean {
    return existsSync(this.filePath)
  }

  isUnlocked(): boolean {
    return this.key !== null
  }

  /**
   * Unlock an existing file, or create an empty one sealed with `passphrase`
   * when none exists yet. Throws WrongPassphraseError on a mismatch.
   */
  unlock(passphrase: string): void {
    if (!this.exists()) {
      if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
        throw new Error(`Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`)
      }
      this.salt = randomBytes(16)
      this.key = scryptSync(passphrase, this.salt, 32, SCRYPT)
      this.values = {}
      this.persist()
      return
    }
    const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8')) as SecretFileShape
    if (parsed?.v !== 1 || parsed.kdf?.name !== 'scrypt') throw new Error(`Unsupported secret file format: ${this.filePath}`)
    const salt = Buffer.from(parsed.kdf.salt, 'base64')
    const key = scryptSync(passphrase, salt, 32, { N: parsed.kdf.N, r: parsed.kdf.r, p: parsed.kdf.p, maxmem: SCRYPT.maxmem })
    let check: string
    try {
      check = open(key, parsed.check)
    } catch {
      throw new WrongPassphraseError()
    }
    const checkBuf = Buffer.from(check)
    const expected = Buffer.from(CHECK_VALUE)
    if (checkBuf.length !== expected.length || !timingSafeEqual(checkBuf, expected)) throw new WrongPassphraseError()
    this.values = JSON.parse(open(key, parsed.data)) as Record<string, string>
    this.key = key
    this.salt = salt
    try { chmodSync(this.filePath, 0o600) } catch { /* windows */ }
  }

  lock(): void {
    this.key?.fill(0)
    this.key = null
    this.values = {}
  }

  get(account: string): string | null {
    if (!this.key) return null
    return this.values[account] ?? null
  }

  set(account: string, value: string): void {
    if (!this.key) throw new SecretStoreLockedError()
    this.values[account] = value
    this.persist()
  }

  delete(account: string): void {
    if (!this.key || !(account in this.values)) return
    delete this.values[account]
    this.persist()
  }

  private persist(): void {
    if (!this.key || !this.salt) throw new SecretStoreLockedError()
    const record: SecretFileShape = {
      v: 1,
      kdf: { name: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: this.salt.toString('base64') },
      check: seal(this.key, CHECK_VALUE),
      data: seal(this.key, JSON.stringify(this.values)),
    }
    mkdirSync(dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp`
    writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, this.filePath)
    try { chmodSync(this.filePath, 0o600) } catch { /* windows */ }
  }
}

// ---------------------------------------------------------------------------
// Studio side: the shared mnemonic entry
// ---------------------------------------------------------------------------

/** The owner-mnemonic entry Studio mirrors into and imports from. */
export interface SharedMnemonicStore {
  read(): string | null
  write(mnemonic: string): void
}

/** Shared owner-mnemonic keychain entry, or null when no keychain is usable. */
export function openSharedMnemonicStore(): SharedMnemonicStore | null {
  const backend = openKeychainBackend()
  if (!backend) return null
  return {
    read: () => backend.get(OWNER_MNEMONIC_ACCOUNT),
    write: (mnemonic) => backend.set(OWNER_MNEMONIC_ACCOUNT, mnemonic),
  }
}
