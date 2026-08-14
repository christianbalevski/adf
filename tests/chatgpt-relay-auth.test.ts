import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetCredentialKeyCache } from '../src/main/utils/credential-cipher'
import { createSubscriptionTokenStore } from '../src/main/providers/subscription-token-store'
import type { TokenSet } from '../src/main/providers/chatgpt-subscription/types'

/**
 * Relay sign-in: the daemon holds the PKCE verifier while the *caller* serves
 * the OAuth callback, which is the only way a remote daemon can complete
 * ChatGPT's loopback-redirect flow.
 */

const previousUserDataDir = process.env.ADF_USER_DATA_DIR
const REDIRECT_URI = 'http://localhost:1455/auth/callback'

function fakeJwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode(claims)}.sig`
}

async function freshManager() {
  vi.resetModules()
  const mod = await import('../src/main/providers/chatgpt-subscription/auth-manager')
  return mod.getChatGptAuthManager()
}

beforeEach(() => {
  process.env.ADF_USER_DATA_DIR = mkdtempSync(join(tmpdir(), 'adf-relay-auth-'))
  resetCredentialKeyCache()
})

afterEach(() => {
  vi.unstubAllGlobals()
  resetCredentialKeyCache()
  if (previousUserDataDir === undefined) {
    delete process.env.ADF_USER_DATA_DIR
  } else {
    process.env.ADF_USER_DATA_DIR = previousUserDataDir
  }
})

describe('ChatGPT relay auth flow', () => {
  it('issues an auth URL bound to the caller-supplied redirect and PKCE challenge', async () => {
    const manager = await freshManager()
    const flow = manager.startRelayAuthFlow(REDIRECT_URI)

    const url = new URL(flow.authUrl)
    expect(url.origin + url.pathname).toBe('https://auth.openai.com/oauth/authorize')
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toBeTruthy()
    expect(url.searchParams.get('state')).toBe(flow.state)
    expect(flow.flowId).toBeTruthy()
    expect(flow.expiresAt).toBeGreaterThan(Date.now())
  })

  it('rejects redirect URIs that are not loopback', async () => {
    const manager = await freshManager()

    expect(() => manager.startRelayAuthFlow('http://evil.example.com/cb')).toThrow(/must target localhost/)
    expect(() => manager.startRelayAuthFlow('not-a-url')).toThrow(/Invalid redirectUri/)
  })

  it('exchanges the relayed code and persists the session', async () => {
    const manager = await freshManager()
    const flow = manager.startRelayAuthFlow(REDIRECT_URI)

    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({
      access_token: 'relayed-access',
      refresh_token: 'relayed-refresh',
      expires_in: 3600,
      id_token: fakeJwt({ email: 'user@example.com', chatgpt_account_id: 'acct-9' }),
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)

    await manager.completeRelayAuthFlow(flow.flowId, 'the-code', flow.state)

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    const body = new URLSearchParams(String(init.body))
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code')).toBe('the-code')
    expect(body.get('redirect_uri')).toBe(REDIRECT_URI)
    expect(body.get('code_verifier')).toBeTruthy()

    expect(manager.getAuthStatus()).toMatchObject({ authenticated: true, email: 'user@example.com' })
    expect(manager.getAccountId()).toBe('acct-9')

    // Persisted into this surface's own token file.
    const store = createSubscriptionTokenStore<TokenSet>('chatgpt-subscription')
    expect(store.readTokens()).toMatchObject({ access_token: 'relayed-access', refresh_token: 'relayed-refresh' })

    manager.logout()
  })

  it('rejects a mismatched state', async () => {
    const manager = await freshManager()
    const flow = manager.startRelayAuthFlow(REDIRECT_URI)

    await expect(manager.completeRelayAuthFlow(flow.flowId, 'code', 'wrong-state'))
      .rejects.toThrow(/state mismatch/)
  })

  it('refuses to reuse a flow id', async () => {
    const manager = await freshManager()
    const flow = manager.startRelayAuthFlow(REDIRECT_URI)

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      access_token: 'a', refresh_token: 'r', expires_in: 3600,
    }), { status: 200 })))

    await manager.completeRelayAuthFlow(flow.flowId, 'code', flow.state)
    await expect(manager.completeRelayAuthFlow(flow.flowId, 'code', flow.state))
      .rejects.toThrow(/Unknown or expired auth flow/)

    manager.logout()
  })

  it('rejects an unknown flow id', async () => {
    const manager = await freshManager()
    await expect(manager.completeRelayAuthFlow('nope', 'code', 'state'))
      .rejects.toThrow(/Unknown or expired auth flow/)
  })
})
