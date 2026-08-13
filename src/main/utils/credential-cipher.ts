import { randomBytes, createCipheriv, createDecipheriv } from 'crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { getUserDataPath } from './user-data-path'

/**
 * Portable at-rest encryption for credentials that BOTH ADF Studio (Electron)
 * and the daemon (plain Node) must read.
 *
 * Electron's `safeStorage` is backed by the OS keychain (DPAPI / Keychain /
 * libsecret) and is simply not callable outside Electron, so anything written
 * with it is opaque to the daemon. This module uses AES-256-GCM under a
 * machine-local key file instead, which both processes can open.
 *
 * Security trade-off, stated plainly: the key sits next to the ciphertext at
 * `<userData>/credential.key` with mode 0600. That protects against other
 * users on the box and against a stolen copy of the credential file alone — it
 * does NOT protect against code already running as this user, which the OS
 * keychain does. This matches the existing bar for provider API keys, which are
 * stored as plain JSON in `adf-settings.json`. Note that Node's `mode` is
 * advisory on Windows (it only toggles the read-only attribute); NTFS ACLs
 * still limit the file to the user's profile directory.
 *
 * Read stays backward compatible: `safe:` payloads written by an older Studio
 * still decrypt when running under Electron, and bare payloads are treated as
 * legacy plaintext. Writes are always `aesgcm:` so the next write migrates the
 * file to the portable format.
 */

export const AES_GCM_PREFIX = 'aesgcm:'
export const SAFE_STORAGE_PREFIX = 'safe:'

const KEY_FILE_NAME = 'credential.key'
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16

interface ElectronSafeStorage {
  isEncryptionAvailable: () => boolean
  encryptString: (value: string) => Buffer
  decryptString: (value: Buffer) => string
}

let cachedKey: Buffer | null = null
let cachedKeyPath: string | null = null

function getSafeStorage(): ElectronSafeStorage | null {
  try {
    const electron = require('electron') as { safeStorage?: ElectronSafeStorage }
    return electron.safeStorage ?? null
  } catch {
    return null
  }
}

function credentialKeyPath(): string {
  const dir = getUserDataPath()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return join(dir, KEY_FILE_NAME)
}

function readKeyFile(path: string): Buffer | null {
  try {
    const key = Buffer.from(readFileSync(path, 'utf-8').trim(), 'base64')
    return key.length === KEY_BYTES ? key : null
  } catch {
    return null
  }
}

/**
 * Load the machine-local credential key, generating it on first use.
 *
 * `wx` makes creation atomic against a concurrent Studio/daemon start: whoever
 * loses the race re-reads the winner's key rather than overwriting it, which
 * would strand every credential file already encrypted under the old key.
 */
export function getCredentialKey(): Buffer {
  const path = credentialKeyPath()
  if (cachedKey && cachedKeyPath === path) return cachedKey

  let key = existsSync(path) ? readKeyFile(path) : null

  if (!key && existsSync(path)) {
    // A corrupt key can't decrypt anything that was written under it, so
    // regenerating loses nothing that wasn't already lost — but say so loudly
    // rather than silently dropping the user's sessions.
    console.warn(`[Credentials] Key file at ${path} is unreadable — regenerating. Stored credentials will need re-authentication.`)
  }

  if (!key) {
    const generated = randomBytes(KEY_BYTES)
    try {
      writeFileSync(path, generated.toString('base64'), { mode: 0o600, flag: 'wx' })
      key = generated
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        key = readKeyFile(path)
        if (!key) {
          // Existing file is corrupt and `wx` won't clobber it — force it.
          writeFileSync(path, generated.toString('base64'), { mode: 0o600 })
          key = generated
        }
      } else {
        throw err
      }
    }
  }

  cachedKey = key
  cachedKeyPath = path
  return key
}

/** Encrypt to the portable `aesgcm:<iv>.<tag>.<ciphertext>` format (all base64). */
export function encryptCredential(value: string): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', getCredentialKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(value, 'utf-8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${AES_GCM_PREFIX}${iv.toString('base64')}.${tag.toString('base64')}.${ciphertext.toString('base64')}`
}

function decryptAesGcm(raw: string, logPrefix: string): string | null {
  const parts = raw.slice(AES_GCM_PREFIX.length).split('.')
  if (parts.length !== 3) {
    console.warn(`${logPrefix} Malformed encrypted credential payload`)
    return null
  }
  try {
    const iv = Buffer.from(parts[0], 'base64')
    const tag = Buffer.from(parts[1], 'base64')
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
      console.warn(`${logPrefix} Malformed encrypted credential payload`)
      return null
    }
    const decipher = createDecipheriv('aes-256-gcm', getCredentialKey(), iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([
      decipher.update(Buffer.from(parts[2], 'base64')),
      decipher.final(),
    ]).toString('utf-8')
  } catch {
    // GCM tag mismatch — wrong key (key file regenerated) or tampering.
    console.warn(`${logPrefix} Could not decrypt credential — the key file may have been regenerated. Sign in again.`)
    return null
  }
}

/**
 * Decrypt any of the three on-disk formats. Returns null when the payload is
 * unreadable in this process (e.g. a legacy `safe:` blob outside Electron), so
 * callers degrade to "signed out" instead of throwing.
 */
export function decryptCredential(raw: string, logPrefix = '[Credentials]'): string | null {
  if (raw.startsWith(AES_GCM_PREFIX)) {
    return decryptAesGcm(raw, logPrefix)
  }

  if (raw.startsWith(SAFE_STORAGE_PREFIX)) {
    const safeStorage = getSafeStorage()
    if (!safeStorage?.isEncryptionAvailable()) {
      console.warn(`${logPrefix} Credential is safeStorage-encrypted and this process has no Electron keychain access. Start ADF Studio once to migrate it, or sign in here.`)
      return null
    }
    try {
      return safeStorage.decryptString(Buffer.from(raw.slice(SAFE_STORAGE_PREFIX.length), 'base64'))
    } catch (err) {
      console.warn(`${logPrefix} Failed to decrypt safeStorage credential:`, err)
      return null
    }
  }

  // Legacy plaintext, written by an older daemon build.
  return raw
}

/** Test seam — drops the in-process key cache so ADF_USER_DATA_DIR changes take effect. */
export function resetCredentialKeyCache(): void {
  cachedKey = null
  cachedKeyPath = null
}
