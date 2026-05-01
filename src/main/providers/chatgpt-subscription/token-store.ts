import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { getUserDataPath } from '../../utils/user-data-path'
import type { TokenSet } from './types'

const SAFE_STORAGE_PREFIX = 'safe:'
const DIR_NAME = 'chatgpt-subscription'
const FILE_NAME = 'auth.json'

interface ElectronSafeStorage {
  isEncryptionAvailable: () => boolean
  encryptString: (value: string) => Buffer
  decryptString: (value: Buffer) => string
}

function getStorePath(): string {
  const dir = join(getUserDataPath(), DIR_NAME)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return join(dir, FILE_NAME)
}

function encryptValue(value: string): string {
  const safeStorage = getSafeStorage()
  if (safeStorage?.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(value)
    return SAFE_STORAGE_PREFIX + encrypted.toString('base64')
  }
  console.warn('[ChatGPT Auth] safeStorage unavailable, storing tokens in plaintext')
  return value
}

function decryptValue(raw: string): string | null {
  if (raw.startsWith(SAFE_STORAGE_PREFIX)) {
    const safeStorage = getSafeStorage()
    if (!safeStorage?.isEncryptionAvailable()) {
      console.warn('[ChatGPT Auth] safeStorage unavailable, cannot decrypt tokens')
      return null
    }
    try {
      const buf = Buffer.from(raw.slice(SAFE_STORAGE_PREFIX.length), 'base64')
      return safeStorage.decryptString(buf)
    } catch (err) {
      console.warn('[ChatGPT Auth] Failed to decrypt tokens:', err)
      return null
    }
  }
  return raw
}

function getSafeStorage(): ElectronSafeStorage | null {
  try {
    const electron = require('electron') as { safeStorage?: ElectronSafeStorage }
    return electron.safeStorage ?? null
  } catch {
    return null
  }
}

export function readTokens(): TokenSet | null {
  const path = getStorePath()
  if (!existsSync(path)) return null

  try {
    const raw = readFileSync(path, 'utf-8')
    const decrypted = decryptValue(raw)
    if (!decrypted) return null
    return JSON.parse(decrypted) as TokenSet
  } catch (err) {
    console.warn('[ChatGPT Auth] Failed to read tokens:', err)
    return null
  }
}

export function writeTokens(tokens: TokenSet): void {
  const path = getStorePath()
  const json = JSON.stringify(tokens)
  const value = encryptValue(json)
  writeFileSync(path, value, { mode: 0o600 })
}

export function clearTokens(): void {
  const path = getStorePath()
  if (existsSync(path)) {
    try {
      unlinkSync(path)
    } catch {
      // Ignore
    }
  }
}
