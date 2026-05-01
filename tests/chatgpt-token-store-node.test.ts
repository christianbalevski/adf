import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { clearTokens, readTokens, writeTokens } from '../src/main/providers/chatgpt-subscription/token-store'
import type { TokenSet } from '../src/main/providers/chatgpt-subscription/types'

const previousUserDataDir = process.env.ADF_USER_DATA_DIR

afterEach(() => {
  clearTokens()
  if (previousUserDataDir === undefined) {
    delete process.env.ADF_USER_DATA_DIR
  } else {
    process.env.ADF_USER_DATA_DIR = previousUserDataDir
  }
})

describe('ChatGPT subscription token store under plain Node', () => {
  it('reads and writes tokens without an Electron app object', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adf-chatgpt-token-store-'))
    process.env.ADF_USER_DATA_DIR = dir

    expect(readTokens()).toBeNull()

    const tokens: TokenSet = {
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expires_at: Date.now() + 60_000,
      account_id: 'account-id',
    }

    writeTokens(tokens)

    expect(readTokens()).toEqual(tokens)
    expect(existsSync(join(dir, 'chatgpt-subscription', 'auth.json'))).toBe(true)
    expect(readFileSync(join(dir, 'chatgpt-subscription', 'auth.json'), 'utf-8')).toContain('access-token')

    clearTokens()
    expect(readTokens()).toBeNull()
  })
})
