import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { clearTokens, readTokens, writeTokens } from '../src/main/providers/chatgpt-subscription/token-store'
import { AES_GCM_PREFIX, resetCredentialKeyCache } from '../src/main/utils/credential-cipher'
import type { TokenSet } from '../src/main/providers/chatgpt-subscription/types'

const previousUserDataDir = process.env.ADF_USER_DATA_DIR

/** Fresh user-data dir plus the provider subdirectory paths for one test. */
function setupUserDataDir(): { dir: string; providerDir: string; studioFile: string; daemonFile: string } {
  const dir = mkdtempSync(join(tmpdir(), 'adf-chatgpt-token-store-'))
  process.env.ADF_USER_DATA_DIR = dir
  const providerDir = join(dir, 'chatgpt-subscription')
  return {
    dir,
    providerDir,
    studioFile: join(providerDir, 'auth.json'),
    daemonFile: join(providerDir, 'auth.daemon.json'),
  }
}

function makeTokens(): TokenSet {
  return {
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    expires_at: Date.now() + 60_000,
    account_id: 'account-id',
  }
}

afterEach(() => {
  clearTokens()
  resetCredentialKeyCache()
  if (previousUserDataDir === undefined) {
    delete process.env.ADF_USER_DATA_DIR
  } else {
    process.env.ADF_USER_DATA_DIR = previousUserDataDir
  }
})

describe('ChatGPT subscription token store under plain Node', () => {
  it('reads and writes tokens without an Electron app object', () => {
    const { daemonFile, studioFile } = setupUserDataDir()

    expect(readTokens()).toBeNull()

    const tokens = makeTokens()

    writeTokens(tokens)

    expect(readTokens()).toEqual(tokens)
    // Plain Node is the daemon surface: it owns auth.daemon.json, never auth.json.
    expect(existsSync(daemonFile)).toBe(true)
    expect(existsSync(studioFile)).toBe(false)

    clearTokens()
    expect(readTokens()).toBeNull()
  })

  it('encrypts its own token file rather than writing bearer tokens in the clear', () => {
    const { dir, daemonFile } = setupUserDataDir()

    writeTokens(makeTokens())

    // No keychain here, but that is not a licence to store tokens in plaintext.
    const raw = readFileSync(daemonFile, 'utf-8')
    expect(raw.startsWith(AES_GCM_PREFIX)).toBe(true)
    expect(raw).not.toContain('access-token')
    expect(raw).not.toContain('refresh-token')
    expect(existsSync(join(dir, 'credential.key'))).toBe(true)
  })

  it('cannot read its own file once the key file is replaced', () => {
    const { dir } = setupUserDataDir()
    writeTokens(makeTokens())

    writeFileSync(join(dir, 'credential.key'), Buffer.alloc(32, 7).toString('base64'))
    resetCredentialKeyCache()

    expect(readTokens()).toBeNull()
  })

  it('adopts a legacy plaintext auth.json into auth.daemon.json', () => {
    const { providerDir, studioFile, daemonFile } = setupUserDataDir()
    mkdirSync(providerDir, { recursive: true })

    const tokens = makeTokens()
    const legacyRaw = JSON.stringify(tokens)
    writeFileSync(studioFile, legacyRaw, { mode: 0o600 })

    expect(readTokens()).toEqual(tokens)

    expect(existsSync(daemonFile)).toBe(true)
    expect(readFileSync(daemonFile, 'utf-8')).toBe(legacyRaw)
    // The legacy file belongs to whoever wrote it — adoption copies, never moves.
    expect(existsSync(studioFile)).toBe(true)
    expect(readFileSync(studioFile, 'utf-8')).toBe(legacyRaw)
  })

  it('does not adopt a safeStorage-encrypted legacy auth.json', () => {
    const { providerDir, studioFile, daemonFile } = setupUserDataDir()
    mkdirSync(providerDir, { recursive: true })

    const encrypted = 'safe:' + Buffer.from('not-really-encrypted-garbage').toString('base64')
    writeFileSync(studioFile, encrypted, { mode: 0o600 })

    expect(readTokens()).toBeNull()
    expect(existsSync(daemonFile)).toBe(false)
    expect(readFileSync(studioFile, 'utf-8')).toBe(encrypted)
  })

  it('refuses to overwrite an encrypted token file with plaintext', () => {
    const { providerDir, daemonFile } = setupUserDataDir()
    mkdirSync(providerDir, { recursive: true })

    const encrypted = 'safe:' + Buffer.from('not-really-encrypted-garbage').toString('base64')
    writeFileSync(daemonFile, encrypted, { mode: 0o600 })

    expect(() => writeTokens(makeTokens())).toThrow(/refusing to overwrite/)
    expect(readFileSync(daemonFile, 'utf-8')).toBe(encrypted)
  })
})
