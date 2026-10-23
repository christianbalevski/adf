import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { app, safeStorage } from 'electron'
import { SAFE_STORAGE_PREFIX, type SecretCipher } from '../services/secret-storage-policy'
import { testSeamsAllowed, type TestSeamGateInput } from './test-seams'

/**
 * Electron `safeStorage` as ADF Studio's own secrets use it
 * (SettingsService.setSecret, the secret-storage choice at launch).
 *
 * "Usable" means a real OS keychain: DPAPI on Windows, the login Keychain on
 * macOS, a Secret Service keyring on Linux. Linux's `basic_text` backend only
 * obfuscates with a fixed key, so it never counts, whatever
 * `isEncryptionAvailable()` says.
 */
export interface StudioSafeStorage {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
  getSelectedStorageBackend?(): string
}

/**
 * TEST ONLY. Names a control file: while it reads `available`, safeStorage is
 * replaced by a mock that encrypts with a fixed test key; anything else (or no
 * file) is "no keychain". Lets the real Electron UI be driven through Retry and
 * the switch back to the keychain on a machine without one, without touching
 * any real keychain. Honoured only behind every test-seam fence: ADF_TEST_SEAMS=1,
 * not app.isPackaged, and not a packaged module or runtime (testSeamsAllowed).
 */
export const MOCK_SAFE_STORAGE_ENV = 'ADF_TEST_MOCK_SAFE_STORAGE'

/** The mock's control file, or null when the mock must not be used (see MOCK_SAFE_STORAGE_ENV). */
export function mockSafeStorageControlFile(input: { env?: NodeJS.ProcessEnv; appPackaged?: boolean; seams?: Omit<TestSeamGateInput, 'env'> } = {}): string | null {
  const env = input.env ?? process.env
  const controlFile = env[MOCK_SAFE_STORAGE_ENV]
  if (!controlFile) return null
  const appPackaged = input.appPackaged ?? (app ? app.isPackaged : true)
  if (appPackaged || !testSeamsAllowed({ env, ...input.seams })) {
    console.warn(`[SecretStorage] ${MOCK_SAFE_STORAGE_ENV} ignored: test seams are not allowed in this build or environment`)
    return null
  }
  return controlFile
}

const MOCK_MAGIC = Buffer.from('ADF-TEST-MOCK-SAFESTORAGE-1:')
const MOCK_KEY = createHash('sha256').update('adf test-only mock safeStorage key').digest()

function mockSafeStorage(controlFile: string): StudioSafeStorage {
  const available = (): boolean => {
    try { return readFileSync(controlFile, 'utf-8').trim() === 'available' } catch { return false }
  }
  return {
    isEncryptionAvailable: available,
    getSelectedStorageBackend: () => (available() ? 'adf_test_mock' : 'basic_text'),
    encryptString(plain) {
      if (!available()) throw new Error('Encryption is not available.')
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', MOCK_KEY, iv)
      const body = Buffer.concat([cipher.update(plain, 'utf-8'), cipher.final()])
      return Buffer.concat([MOCK_MAGIC, iv, cipher.getAuthTag(), body])
    },
    decryptString(encrypted) {
      if (!available()) throw new Error('Decryption is not available.')
      if (!encrypted.subarray(0, MOCK_MAGIC.length).equals(MOCK_MAGIC)) throw new Error('Not a test mock safeStorage payload')
      const rest = encrypted.subarray(MOCK_MAGIC.length)
      const decipher = createDecipheriv('aes-256-gcm', MOCK_KEY, rest.subarray(0, 12))
      decipher.setAuthTag(rest.subarray(12, 28))
      return Buffer.concat([decipher.update(rest.subarray(28)), decipher.final()]).toString('utf-8')
    },
  }
}

let mock: StudioSafeStorage | null | undefined

/** Electron's safeStorage, or the test mock (only behind every test-seam fence, mockSafeStorageControlFile). */
export function studioSafeStorage(): StudioSafeStorage {
  if (mock === undefined) {
    const controlFile = mockSafeStorageControlFile()
    mock = controlFile ? mockSafeStorage(controlFile) : null
    if (mock) console.warn(`[SecretStorage] TEST ONLY: safeStorage is a mock controlled by ${controlFile} (${MOCK_SAFE_STORAGE_ENV})`)
  }
  return mock ?? safeStorage
}

/**
 * Linux without a Secret Service keyring: safeStorage falls back to
 * 'basic_text', a fixed key that only obfuscates.
 */
export function isObfuscationOnly(storage: StudioSafeStorage = studioSafeStorage()): boolean {
  if (process.platform !== 'linux') return false
  return storage.getSelectedStorageBackend?.() === 'basic_text'
}

/** A real OS keychain is usable right now. Asked fresh each time: Retry rechecks here. */
export function keyringAvailable(storage: StudioSafeStorage = studioSafeStorage()): boolean {
  try {
    return storage.isEncryptionAvailable() && !isObfuscationOnly(storage)
  } catch {
    return false
  }
}

/** safeStorage as the `safe:` codec of `adf-settings.json`. Decrypts nothing without a real keychain. */
export const studioSecretCipher: SecretCipher = {
  encrypt: (plain) => SAFE_STORAGE_PREFIX + studioSafeStorage().encryptString(plain).toString('base64'),
  decrypt: (stored) => {
    if (!stored.startsWith(SAFE_STORAGE_PREFIX) || !keyringAvailable()) return null
    try {
      return studioSafeStorage().decryptString(Buffer.from(stored.slice(SAFE_STORAGE_PREFIX.length), 'base64'))
    } catch {
      return null
    }
  },
}
