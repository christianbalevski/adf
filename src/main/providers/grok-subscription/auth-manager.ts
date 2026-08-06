import { readTokens, writeTokens, clearTokens } from './token-store'
import type { TokenSet, AuthStatus, DeviceCodeResponse } from './types'

// xAI's shared public Grok-CLI OAuth client (no secret; same client used by
// Grok CLI and other subscription-auth integrations). Eligibility is decided
// server-side: SuperGrok / X Premium accounts get OAuth API tokens.
const CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'
// Endpoints from https://auth.x.ai/.well-known/openid-configuration
const DEVICE_AUTHORIZATION_URL = 'https://auth.x.ai/oauth2/device/code'
const TOKEN_URL = 'https://auth.x.ai/oauth2/token'
const DEVICE_CODE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code'
const SCOPE = 'openid profile email offline_access grok-cli:access api:access'

// Refresh 5 minutes before expiry
const REFRESH_BUFFER_MS = 5 * 60 * 1000

// Device-code poll bounds (RFC 8628). xAI returns `interval`/`expires_in` in
// seconds; these defaults cover missing or garbage values.
const POLL_DEFAULT_INTERVAL_MS = 5_000
const POLL_MIN_INTERVAL_MS = 1_000
const POLL_SLOW_DOWN_INCREMENT_MS = 5_000
const POLL_DEFAULT_EXPIRES_MS = 15 * 60 * 1000

function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.')
  if (parts.length < 2) return {}
  try {
    const payload = Buffer.from(parts[1], 'base64url').toString('utf-8')
    return JSON.parse(payload)
  } catch {
    return {}
  }
}

async function openExternal(url: string): Promise<void> {
  try {
    const electron = require('electron') as { shell?: { openExternal?: (url: string) => Promise<unknown> } }
    if (electron.shell?.openExternal) {
      await electron.shell.openExternal(url)
      return
    }
  } catch {
    // Running outside Electron (daemon/CLI). Fall through and print the URL.
  }
  console.log(`[Grok Auth] Open this URL to sign in: ${url}`)
}

interface TokenResponse {
  access_token: string
  refresh_token?: string
  id_token?: string
  expires_in?: number
}

/** Normalize a server-supplied seconds value to ms, guarding NaN/negatives. */
function positiveSecondsToMs(value: unknown, defaultMs: number): number {
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : defaultMs
}

export interface PollDeps {
  fetchFn?: typeof globalThis.fetch
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

/**
 * Poll the token endpoint until the user approves the device code (RFC 8628 §3.5).
 * `authorization_pending` keeps polling, `slow_down` backs off by 5s, anything
 * else is terminal. Exported with injectable deps for unit testing.
 */
export async function pollDeviceCodeToken(
  device: DeviceCodeResponse,
  deps: PollDeps = {}
): Promise<TokenResponse> {
  const fetchFn = deps.fetchFn ?? globalThis.fetch
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const now = deps.now ?? (() => Date.now())

  const deadline = now() + positiveSecondsToMs(device.expires_in, POLL_DEFAULT_EXPIRES_MS)
  let intervalMs = Math.max(
    positiveSecondsToMs(device.interval, POLL_DEFAULT_INTERVAL_MS),
    POLL_MIN_INTERVAL_MS
  )

  while (now() < deadline) {
    const response = await fetchFn(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: DEVICE_CODE_GRANT_TYPE,
        client_id: CLIENT_ID,
        device_code: device.device_code
      }).toString()
    })
    if (response.ok) return await response.json() as TokenResponse

    const body = await response.json().catch(() => ({})) as { error?: string; error_description?: string }
    if (body.error === 'authorization_pending') {
      await sleep(Math.min(intervalMs, Math.max(0, deadline - now())))
      continue
    }
    if (body.error === 'slow_down') {
      intervalMs += POLL_SLOW_DOWN_INCREMENT_MS
      await sleep(Math.min(intervalMs, Math.max(0, deadline - now())))
      continue
    }
    if (body.error === 'access_denied' || body.error === 'authorization_denied') {
      throw new Error('Sign-in was denied')
    }
    if (body.error === 'expired_token') {
      throw new Error('Device code expired — please sign in again')
    }
    const detail = body.error_description ?? body.error ?? ''
    throw new Error(`Grok token exchange failed (${response.status})${detail ? `: ${detail}` : ''}`)
  }
  throw new Error('Sign-in timed out — please try again')
}

class GrokAuthManager {
  private refreshPromise: Promise<string> | null = null
  private cachedTokens: TokenSet | null = null
  private email?: string
  private activeAuthFlow: GrokAuthFlow | null = null
  private lastFlowError?: string

  constructor() {
    this.cachedTokens = readTokens()
  }

  async startAuthFlow(): Promise<void> {
    const flow = await this.startAuthFlowDetached()
    await flow.completion
  }

  async startAuthFlowDetached(): Promise<GrokAuthFlow> {
    if (this.activeAuthFlow) return this.activeAuthFlow
    this.lastFlowError = undefined

    // RFC 8628 device authorization — no loopback callback server needed.
    const response = await fetch(DEVICE_AUTHORIZATION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        scope: SCOPE,
        referrer: 'adf-studio'
      }).toString()
    })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(`Grok device code request failed (${response.status})${body ? `: ${body}` : ''}`)
    }
    const device = await response.json() as DeviceCodeResponse
    if (!device.device_code || !device.user_code || !device.verification_uri) {
      throw new Error('Grok device code response is missing device_code / user_code / verification_uri')
    }

    // verification_uri_complete has the user_code pre-filled — prefer it so the
    // user only has to confirm, not type the code.
    const openUrl = device.verification_uri_complete ?? device.verification_uri
    await openExternal(openUrl)

    const completion = (async () => {
      try {
        const tokenData = await pollDeviceCodeToken(device)

        let accountId = ''
        if (tokenData.id_token) {
          const claims = decodeJwtPayload(tokenData.id_token)
          this.email = claims.email as string | undefined
          accountId = (claims.sub as string) ?? ''
        }
        if (!accountId) {
          const accessClaims = decodeJwtPayload(tokenData.access_token)
          accountId = (accessClaims.sub as string) ?? ''
        }

        if (!tokenData.refresh_token) {
          throw new Error('Grok sign-in did not return a refresh token — is offline_access granted?')
        }

        const tokens: TokenSet = {
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token,
          expires_at: Date.now() + positiveSecondsToMs(tokenData.expires_in, 3600 * 1000),
          account_id: accountId
        }

        writeTokens(tokens)
        this.cachedTokens = tokens
      } catch (err) {
        this.lastFlowError = err instanceof Error ? err.message : String(err)
        throw err
      } finally {
        this.activeAuthFlow = null
      }
    })()
    // The detached caller may never await completion — swallow here so an
    // abandoned flow doesn't surface as an unhandled rejection. The error is
    // kept in lastFlowError and shown via getAuthStatus.
    completion.catch(() => {})

    this.activeAuthFlow = {
      userCode: device.user_code,
      verificationUri: device.verification_uri,
      verificationUriComplete: device.verification_uri_complete,
      expiresIn: positiveSecondsToMs(device.expires_in, POLL_DEFAULT_EXPIRES_MS) / 1000,
      completion
    }
    return this.activeAuthFlow
  }

  async getValidAccessToken(): Promise<string> {
    const tokens = this.cachedTokens
    if (!tokens) {
      throw new Error('Not authenticated — sign in first')
    }

    // Token still valid
    if (Date.now() + REFRESH_BUFFER_MS < tokens.expires_at) {
      return tokens.access_token
    }

    // Concurrent refresh protection
    if (this.refreshPromise) {
      return this.refreshPromise
    }

    this.refreshPromise = this.refreshTokens(tokens).finally(() => {
      this.refreshPromise = null
    })

    return this.refreshPromise
  }

  getAccountId(): string | undefined {
    return this.cachedTokens?.account_id
  }

  private async refreshTokens(tokens: TokenSet): Promise<string> {
    try {
      const response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: CLIENT_ID,
          refresh_token: tokens.refresh_token
        }).toString()
      })

      if (!response.ok) {
        throw new Error(`Token refresh failed (${response.status})`)
      }

      const data = await response.json() as TokenResponse

      if (data.id_token) {
        const claims = decodeJwtPayload(data.id_token)
        this.email = claims.email as string | undefined
      }

      // xAI may rotate the refresh token — persist the new one immediately,
      // falling back to the old one when the response omits it.
      const newTokens: TokenSet = {
        access_token: data.access_token,
        refresh_token: data.refresh_token || tokens.refresh_token,
        expires_at: Date.now() + positiveSecondsToMs(data.expires_in, 3600 * 1000),
        account_id: tokens.account_id
      }

      writeTokens(newTokens)
      this.cachedTokens = newTokens
      return newTokens.access_token
    } catch (err) {
      // Clear tokens on refresh failure
      clearTokens()
      this.cachedTokens = null
      this.email = undefined
      throw new Error('Session expired — please sign in again')
    }
  }

  getAuthStatus(): AuthStatus {
    const tokens = this.cachedTokens
    if (!tokens) {
      return {
        authenticated: false,
        flowPending: this.activeAuthFlow !== null,
        flowError: this.lastFlowError
      }
    }
    return {
      authenticated: true,
      email: this.email,
      expiresAt: tokens.expires_at
    }
  }

  isAuthenticated(): boolean {
    return this.cachedTokens !== null
  }

  logout(): void {
    clearTokens()
    this.cachedTokens = null
    this.email = undefined
    this.refreshPromise = null
    this.lastFlowError = undefined
  }
}

export interface GrokAuthFlow {
  userCode: string
  verificationUri: string
  verificationUriComplete?: string
  /** Seconds until the device code expires. */
  expiresIn: number
  completion: Promise<void>
}

// Singleton
let instance: GrokAuthManager | null = null

export function getGrokAuthManager(): GrokAuthManager {
  if (!instance) {
    instance = new GrokAuthManager()
  }
  return instance
}
