/**
 * Shared token store for subscription providers (ChatGPT, Grok).
 *
 * Sessions are per-surface: Studio (Electron) and the daemon each own a
 * separate token file and never write to the other's. A shared file can't
 * work — Studio encrypts via safeStorage, which the daemon can't decrypt,
 * and both surfaces refreshing one token set races refresh-token rotation.
 *
 *  - Studio:  <userData>/<provider>/auth.json         (safeStorage-encrypted)
 *  - Daemon:  <userData>/<provider>/auth.daemon.json  (AES-256-GCM, 0600)
 *
 * The daemon has no keychain access, but "no keychain" needn't mean "no
 * encryption": it falls back to AES-256-GCM under a machine-local key file
 * rather than writing bearer tokens in the clear. That key sits beside the
 * ciphertext, so it protects against other users and against a copied file,
 * not against code already running as you — strictly better than plaintext,
 * strictly weaker than Studio's keychain. See `utils/credential-cipher`.
 *
 * The daemon adopts a legacy plaintext auth.json once (pre-split shared
 * file); an encrypted auth.json is Studio's and is left alone — the daemon
 * reports "not logged in" rather than guessing.
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { getUserDataPath } from '../utils/user-data-path'
import { encryptCredential, decryptCredential, SAFE_STORAGE_PREFIX } from '../utils/credential-cipher'

const STUDIO_FILE = 'auth.json'
const DAEMON_FILE = 'auth.daemon.json'

interface ElectronSafeStorage {
  isEncryptionAvailable: () => boolean
  encryptString: (value: string) => Buffer
  decryptString: (value: Buffer) => string
}

export interface SubscriptionTokenStore<T> {
  readTokens: () => T | null
  writeTokens: (tokens: T) => void
  clearTokens: () => void
}

function getSafeStorage(): ElectronSafeStorage | null {
  try {
    const electron = require('electron') as { safeStorage?: ElectronSafeStorage }
    return electron.safeStorage ?? null
  } catch {
    return null
  }
}

/** Electron main process (Studio) vs plain Node (daemon/CLI). */
function isElectronSurface(): boolean {
  return getSafeStorage() !== null
}

export function createSubscriptionTokenStore<T>(dirName: string): SubscriptionTokenStore<T> {
  const logTag = `[${dirName} Auth]`

  function getDir(): string {
    const dir = join(getUserDataPath(), dirName)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    return dir
  }

  /** This surface's own token file — the only file this store ever writes. */
  function getStorePath(): string {
    return join(getDir(), isElectronSurface() ? STUDIO_FILE : DAEMON_FILE)
  }

  function encryptValue(value: string): string {
    const safeStorage = getSafeStorage()
    if (safeStorage?.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(value)
      return SAFE_STORAGE_PREFIX + encrypted.toString('base64')
    }
    if (safeStorage) {
      console.warn(`${logTag} safeStorage unavailable — falling back to key-file encryption`)
    }
    return encryptCredential(value)
  }

  /** Handles safeStorage, key-file, and pre-split plaintext payloads alike. */
  function decryptValue(raw: string): string | null {
    return decryptCredential(raw, logTag)
  }

  /**
   * One-time adoption of the pre-split shared file: a plaintext auth.json
   * could only have been written by a keyring-less surface, so the daemon
   * copies it into its own file and proceeds. An encrypted auth.json is
   * Studio's session — never adopted, never touched.
   */
  function adoptLegacyFile(ownPath: string): void {
    const legacyPath = join(getDir(), STUDIO_FILE)
    if (!existsSync(legacyPath)) return
    try {
      const raw = readFileSync(legacyPath, 'utf-8')
      if (raw.startsWith(SAFE_STORAGE_PREFIX)) {
        console.warn(
          `${logTag} ${STUDIO_FILE} is encrypted by ADF Studio and cannot be used here — ` +
          'log in from this surface to create its own session'
        )
        return
      }
      writeFileSync(ownPath, raw, { mode: 0o600 })
      console.log(`${logTag} Adopted legacy shared token file into ${DAEMON_FILE}`)
    } catch (err) {
      console.warn(`${logTag} Failed to adopt legacy token file:`, err)
    }
  }

  function readTokens(): T | null {
    const path = getStorePath()
    if (!existsSync(path) && !isElectronSurface()) {
      adoptLegacyFile(path)
    }
    if (!existsSync(path)) return null

    try {
      const raw = readFileSync(path, 'utf-8')
      const decrypted = decryptValue(raw)
      if (!decrypted) return null
      return JSON.parse(decrypted) as T
    } catch (err) {
      console.warn(`${logTag} Failed to read tokens:`, err)
      return null
    }
  }

  function writeTokens(tokens: T): void {
    const path = getStorePath()
    const value = encryptValue(JSON.stringify(tokens))
    // Never downgrade a keychain-backed session: if the existing file is
    // safeStorage-encrypted and this process can only reach the key file,
    // overwriting would silently weaken at-rest protection on a session a
    // healthier surface wrote. Log out first to make the downgrade deliberate.
    if (!value.startsWith(SAFE_STORAGE_PREFIX) && existsSync(path)) {
      let existing: string | null = null
      try {
        existing = readFileSync(path, 'utf-8')
      } catch {
        // Unreadable existing file — nothing to protect, replace it.
      }
      if (existing?.startsWith(SAFE_STORAGE_PREFIX)) {
        throw new Error(
          `${logTag} refusing to overwrite a keychain-encrypted session with weaker key-file encryption. ` +
          'Log out (clearing the stored session) and log in again from this surface.'
        )
      }
    }
    writeFileSync(path, value, { mode: 0o600 })
  }

  function clearTokens(): void {
    const path = getStorePath()
    if (existsSync(path)) {
      try {
        unlinkSync(path)
      } catch {
        // Ignore
      }
    }
  }

  return { readTokens, writeTokens, clearTokens }
}
