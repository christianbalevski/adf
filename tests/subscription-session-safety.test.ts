import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createSubscriptionTokenStore } from '../src/main/providers/subscription-token-store'
import { resetCredentialKeyCache, AES_GCM_PREFIX } from '../src/main/utils/credential-cipher'
import type { TokenSet } from '../src/main/providers/chatgpt-subscription/types'

/**
 * Sessions are per-surface, but "one surface" is not "one process": the daemon
 * and every `adf` CLI invocation are all plain Node and therefore all share
 * auth.daemon.json. Since OpenAI rotates the refresh token on every refresh, a
 * stale in-memory copy is not merely out of date — spending it invalidates the
 * session the other process just created. These cover that.
 */

const previousUserDataDir = process.env.ADF_USER_DATA_DIR
const TOKEN_STORE_MODULE = '../src/main/providers/chatgpt-subscription/token-store'

function newStore() {
  return createSubscriptionTokenStore<TokenSet>('chatgpt-subscription')
}

function tokenSet(overrides: Partial<TokenSet> = {}): TokenSet {
  return {
    access_token: 'access-1',
    refresh_token: 'refresh-1',
    expires_at: Date.now() + 3_600_000,
    account_id: 'account-1',
    ...overrides,
  }
}

async function freshManager() {
  vi.resetModules()
  const mod = await import('../src/main/providers/chatgpt-subscription/auth-manager')
  return mod.getChatGptAuthManager()
}

beforeEach(() => {
  process.env.ADF_USER_DATA_DIR = mkdtempSync(join(tmpdir(), 'adf-session-safety-'))
  resetCredentialKeyCache()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.doUnmock(TOKEN_STORE_MODULE)
  resetCredentialKeyCache()
  if (previousUserDataDir === undefined) {
    delete process.env.ADF_USER_DATA_DIR
  } else {
    process.env.ADF_USER_DATA_DIR = previousUserDataDir
  }
})

describe('daemon-surface token file', () => {
  it('is encrypted at rest even without a keychain', () => {
    const dir = process.env.ADF_USER_DATA_DIR as string
    newStore().writeTokens(tokenSet())

    const raw = readFileSync(join(dir, 'chatgpt-subscription', 'auth.daemon.json'), 'utf-8')
    expect(raw.startsWith(AES_GCM_PREFIX)).toBe(true)
    expect(raw).not.toContain('access-1')
  })

  it('never writes to or reads a Studio-encrypted auth.json', () => {
    const dir = process.env.ADF_USER_DATA_DIR as string
    const providerDir = join(dir, 'chatgpt-subscription')
    mkdirSync(providerDir, { recursive: true })

    const studioSession = `safe:${Buffer.from('studios-own-session').toString('base64')}`
    writeFileSync(join(providerDir, 'auth.json'), studioSession, { mode: 0o600 })

    const store = newStore()
    expect(store.readTokens()).toBeNull()

    store.writeTokens(tokenSet())

    // Studio's session is untouched, and ours went to our own file.
    expect(readFileSync(join(providerDir, 'auth.json'), 'utf-8')).toBe(studioSession)
    expect(existsSync(join(providerDir, 'auth.daemon.json'))).toBe(true)
  })

  it('is visible to a second plain-Node reader of the same surface', () => {
    const daemon = newStore()
    const cli = newStore()

    daemon.writeTokens(tokenSet({ access_token: 'written-by-daemon' }))

    expect(cli.readTokens()?.access_token).toBe('written-by-daemon')
  })
})

describe('ChatGPT auth manager refresh-rotation safety', () => {
  it('adopts a session another process already refreshed instead of spending a dead refresh token', async () => {
    const store = newStore()
    store.writeTokens(tokenSet({ access_token: 'expiring', refresh_token: 'r1', expires_at: Date.now() + 1_000 }))

    const manager = await freshManager()

    // Another process refreshes before we ask for a token.
    store.writeTokens(tokenSet({ access_token: 'refreshed-elsewhere', refresh_token: 'r2', expires_at: Date.now() + 3_600_000 }))

    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    await expect(manager.getValidAccessToken()).resolves.toBe('refreshed-elsewhere')
    // The whole point: no refresh request was made, so r2 stays valid.
    expect(fetchSpy).not.toHaveBeenCalled()

    manager.logout()
  })

  it('recovers a live session when its own refresh request loses the rotation race', async () => {
    const store = newStore()
    store.writeTokens(tokenSet({ access_token: 'expiring', refresh_token: 'r1', expires_at: Date.now() + 1_000 }))

    const manager = await freshManager()

    // The refresh fails because r1 was already rotated away — but the winner
    // wrote a healthy replacement, so this must not clear the session.
    vi.stubGlobal('fetch', vi.fn(async () => {
      store.writeTokens(tokenSet({ access_token: 'winner', refresh_token: 'r2', expires_at: Date.now() + 3_600_000 }))
      return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
    }))

    await expect(manager.getValidAccessToken()).resolves.toBe('winner')
    expect(store.readTokens()?.refresh_token).toBe('r2')

    manager.logout()
  })

  it('clears the session when the refresh genuinely fails and no newer tokens exist', async () => {
    const store = newStore()
    store.writeTokens(tokenSet({ access_token: 'expiring', refresh_token: 'r1', expires_at: Date.now() + 1_000 }))

    const manager = await freshManager()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })))

    await expect(manager.getValidAccessToken()).rejects.toThrow('Session expired')
    expect(store.readTokens()).toBeNull()
  })

  it('reports a refused write as a storage problem, not an expired session', async () => {
    const store = newStore()
    store.writeTokens(tokenSet({ access_token: 'expiring', refresh_token: 'r1', expires_at: Date.now() + 1_000 }))

    // Stand in for the store's no-downgrade guard refusing to weaken a
    // keychain-encrypted session's at-rest protection.
    vi.doMock(TOKEN_STORE_MODULE, async importOriginal => ({
      ...(await importOriginal<typeof import('../src/main/providers/chatgpt-subscription/token-store')>()),
      writeTokens: () => { throw new Error('refusing to overwrite a keychain-encrypted session') },
    }))

    const manager = await freshManager()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      access_token: 'new-access', refresh_token: 'r2', expires_in: 3600,
    }), { status: 200 })))

    await expect(manager.getValidAccessToken()).rejects.toThrow(/refusing to overwrite/)
    // Credentials on disk survive — the user is not silently logged out.
    expect(store.readTokens()?.refresh_token).toBe('r1')
  })
})
