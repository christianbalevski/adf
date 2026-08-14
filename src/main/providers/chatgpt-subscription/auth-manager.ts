import crypto from 'crypto'
import { startCallbackServer } from './callback-server'
import { readTokens, writeTokens, clearTokens } from './token-store'
import type { TokenSet, AuthStatus } from './types'

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const AUTH_URL = 'https://auth.openai.com/oauth/authorize'
const TOKEN_URL = 'https://auth.openai.com/oauth/token'
const SCOPE = 'openid profile email offline_access api.connectors.read api.connectors.invoke'

// Refresh 5 minutes before expiry
const REFRESH_BUFFER_MS = 5 * 60 * 1000

// A relay flow parks its PKCE verifier in the daemon while the user completes
// sign-in against a callback server running on their own machine.
const RELAY_FLOW_TTL_MS = 10 * 60 * 1000

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function generateCodeVerifier(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(64))
  return base64url(Buffer.from(bytes))
}

function generateCodeChallenge(verifier: string): string {
  const hash = crypto.createHash('sha256').update(verifier).digest()
  return base64url(hash)
}

function generateState(): string {
  return base64url(Buffer.from(crypto.getRandomValues(new Uint8Array(32))))
}

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
  console.log(`[ChatGPT Auth] Open this URL to sign in: ${url}`)
}

/**
 * Reject redirect URIs that don't point back at the caller's own machine. The
 * relay endpoint hands the resulting authorization code to whoever holds the
 * flow id, so a non-loopback redirect would let a caller aim the OAuth
 * callback — and the code — at a host they control.
 */
function assertLoopbackRedirect(redirectUri: string): void {
  let parsed: URL
  try {
    parsed = new URL(redirectUri)
  } catch {
    throw new Error(`Invalid redirectUri: ${redirectUri}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('redirectUri must be an http(s) URL')
  }
  if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname)) {
    throw new Error('redirectUri must target localhost — the OAuth callback runs on the machine with the browser')
  }
}

interface RefreshResponse {
  access_token: string
  refresh_token: string
  expires_in: number
  id_token?: string
}

interface PendingRelayFlow {
  codeVerifier: string
  state: string
  redirectUri: string
  expiresAt: number
}

class ChatGptAuthManager {
  private refreshPromise: Promise<string> | null = null
  private cachedTokens: TokenSet | null = null
  private email?: string
  private activeAuthFlow: ChatGptAuthFlow | null = null
  private relayFlows = new Map<string, PendingRelayFlow>()

  constructor() {
    this.syncFromDisk()
  }

  /**
   * Re-read the token file, picking up writes from the other process.
   *
   * Studio and the daemon share one file, and OpenAI rotates the refresh token
   * on every refresh — so acting on a cached copy can invalidate the other
   * process's live session. Always reading is what prevents that; the file is
   * well under a kilobyte and this runs once per LLM request.
   */
  private syncFromDisk(): TokenSet | null {
    const tokens = readTokens()
    if (tokens?.access_token !== this.cachedTokens?.access_token) {
      // Different session material — the cached email described the old one.
      // It comes back on the next refresh's id_token.
      this.email = undefined
    }
    this.cachedTokens = tokens
    return tokens
  }

  private persist(tokens: TokenSet): void {
    writeTokens(tokens)
    this.cachedTokens = tokens
  }

  async startAuthFlow(): Promise<void> {
    const flow = await this.startAuthFlowDetached()
    await flow.completion
  }

  async startAuthFlowDetached(): Promise<ChatGptAuthFlow> {
    if (this.activeAuthFlow) return this.activeAuthFlow

    const codeVerifier = generateCodeVerifier()
    const codeChallenge = generateCodeChallenge(codeVerifier)
    const state = generateState()

    // Start callback server first to get the actual bound port
    const server = await startCallbackServer()

    const redirectUri = `http://localhost:${server.port}/auth/callback`

    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: 'code',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
      scope: SCOPE,
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      originator: 'adf_studio'
    })

    const authUrl = `${AUTH_URL}?${params.toString()}`
    await openExternal(authUrl)

    const completion = (async () => {
      try {
        // Wait for callback
        const result = await server.waitForCallback()

        // Verify state
        if (result.state !== state) {
          throw new Error('OAuth state mismatch — possible CSRF attack')
        }

        await this.exchangeCode(result.code, codeVerifier, redirectUri)
      } finally {
        server.close()
        this.activeAuthFlow = null
      }
    })()

    this.activeAuthFlow = { authUrl, callbackPort: server.port, completion }
    return this.activeAuthFlow
  }

  /**
   * Begin a sign-in whose OAuth callback lands on the *caller's* machine rather
   * than on this process.
   *
   * The loopback flow assumes the browser and the token store share a host.
   * That breaks for a daemon on a remote box: `http://localhost:1455` in the
   * user's browser reaches their laptop, not the daemon. Here the daemon keeps
   * the PKCE verifier, the caller runs its own callback server, and the caller
   * posts the code back via `completeRelayAuthFlow`.
   */
  startRelayAuthFlow(redirectUri: string): ChatGptRelayFlow {
    assertLoopbackRedirect(redirectUri)
    this.pruneRelayFlows()

    const codeVerifier = generateCodeVerifier()
    const state = generateState()
    const flowId = base64url(Buffer.from(crypto.getRandomValues(new Uint8Array(24))))
    const expiresAt = Date.now() + RELAY_FLOW_TTL_MS

    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: 'code',
      code_challenge: generateCodeChallenge(codeVerifier),
      code_challenge_method: 'S256',
      state,
      scope: SCOPE,
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      originator: 'adf_studio'
    })

    this.relayFlows.set(flowId, { codeVerifier, state, redirectUri, expiresAt })

    return { flowId, authUrl: `${AUTH_URL}?${params.toString()}`, state, expiresAt }
  }

  /** Finish a relay flow with the code the caller's callback server received. */
  async completeRelayAuthFlow(flowId: string, code: string, state: string): Promise<void> {
    this.pruneRelayFlows()

    const flow = this.relayFlows.get(flowId)
    if (!flow) {
      throw new Error('Unknown or expired auth flow — start sign-in again')
    }
    // Single use: consume before the exchange so a replayed code can't retry.
    this.relayFlows.delete(flowId)

    if (state !== flow.state) {
      throw new Error('OAuth state mismatch — possible CSRF attack')
    }

    await this.exchangeCode(code, flow.codeVerifier, flow.redirectUri)
  }

  private pruneRelayFlows(): void {
    const now = Date.now()
    for (const [id, flow] of this.relayFlows) {
      if (flow.expiresAt <= now) this.relayFlows.delete(id)
    }
  }

  /** Trade an authorization code for tokens and persist them. */
  private async exchangeCode(code: string, codeVerifier: string, redirectUri: string): Promise<void> {
    const tokenResponse = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier
      }).toString()
    })

    if (!tokenResponse.ok) {
      const body = await tokenResponse.text()
      throw new Error(`Token exchange failed (${tokenResponse.status}): ${body}`)
    }

    const tokenData = await tokenResponse.json() as {
      access_token: string
      refresh_token: string
      expires_in: number
      id_token?: string
    }

    // Extract email and chatgpt_account_id from id_token
    // The ChatGPT-Account-ID header needs the chatgpt_account_id claim, NOT sub
    let accountId = ''
    if (tokenData.id_token) {
      const claims = decodeJwtPayload(tokenData.id_token)
      this.email = claims.email as string | undefined
      accountId = (claims.chatgpt_account_id as string) ?? ''
      console.log(`[ChatGPT Auth] id_token claims: email=${this.email}, chatgpt_account_id=${accountId}, sub=${claims.sub}`)
    }

    // Fallback: try access_token claims
    if (!accountId) {
      const accessClaims = decodeJwtPayload(tokenData.access_token)
      accountId = (accessClaims.chatgpt_account_id as string) ?? (accessClaims.sub as string) ?? ''
      console.log(`[ChatGPT Auth] access_token fallback: chatgpt_account_id=${accountId}`)
    }

    // Use the access_token directly — the ChatGPT subscription backend
    // accepts OAuth access tokens with the ChatGPT-Account-ID header
    this.persist({
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_at: Date.now() + tokenData.expires_in * 1000,
      account_id: accountId
    })
  }

  async getValidAccessToken(): Promise<string> {
    const tokens = this.syncFromDisk()
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

    this.refreshPromise = this.refreshIfStillNeeded(tokens).finally(() => {
      this.refreshPromise = null
    })

    return this.refreshPromise
  }

  getAccountId(): string | undefined {
    return this.syncFromDisk()?.account_id
  }

  /**
   * Re-check the file after winning the in-process refresh lock.
   *
   * OpenAI rotates the refresh token on every refresh, so if Studio refreshed
   * while this call queued, our copy is already dead and spending it would both
   * fail here and be pointless. Adopt the newer set instead.
   */
  private async refreshIfStillNeeded(tokens: TokenSet): Promise<string> {
    const fresh = this.syncFromDisk()
    if (fresh && Date.now() + REFRESH_BUFFER_MS < fresh.expires_at) {
      return fresh.access_token
    }
    return this.refreshTokens(fresh ?? tokens)
  }

  private async refreshTokens(tokens: TokenSet): Promise<string> {
    let data: RefreshResponse
    try {
      // Codex CLI uses JSON body for refresh
      const response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: CLIENT_ID,
          grant_type: 'refresh_token',
          refresh_token: tokens.refresh_token
        })
      })

      if (!response.ok) {
        throw new Error(`Token refresh failed (${response.status})`)
      }

      data = await response.json() as RefreshResponse
    } catch {
      // A failure here may just mean another surface rotated the refresh token
      // between our disk check and this request. Look once more before
      // destroying what could be a perfectly live session.
      const fresh = this.syncFromDisk()
      if (
        fresh &&
        fresh.refresh_token !== tokens.refresh_token &&
        Date.now() + REFRESH_BUFFER_MS < fresh.expires_at
      ) {
        return fresh.access_token
      }

      // Clear tokens on refresh failure
      clearTokens()
      this.cachedTokens = null
      this.email = undefined
      throw new Error('Session expired — please sign in again')
    }

    // Extract email from refreshed id_token
    if (data.id_token) {
      const claims = decodeJwtPayload(data.id_token)
      this.email = claims.email as string | undefined
    }

    // Persisting sits outside the catch on purpose: the store refuses writes
    // that would weaken an existing session's at-rest encryption, and that is a
    // storage problem, not an expired session. Rewriting it as "sign in again"
    // would point the user at the wrong fix and discard live credentials.
    // OpenAI rotates refresh tokens — persist the new one immediately.
    this.persist({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + data.expires_in * 1000,
      account_id: tokens.account_id
    })
    return data.access_token
  }

  getAuthStatus(): AuthStatus {
    const tokens = this.syncFromDisk()
    if (!tokens) {
      return { authenticated: false }
    }
    return {
      authenticated: true,
      email: this.email,
      expiresAt: tokens.expires_at
    }
  }

  isAuthenticated(): boolean {
    return this.syncFromDisk() !== null
  }

  logout(): void {
    clearTokens()
    this.cachedTokens = null
    this.email = undefined
    this.refreshPromise = null
    this.relayFlows.clear()
  }
}

export interface ChatGptAuthFlow {
  authUrl: string
  callbackPort: number
  completion: Promise<void>
}

/** A sign-in whose OAuth callback is served by the caller, not by this process. */
export interface ChatGptRelayFlow {
  flowId: string
  authUrl: string
  /** The caller must echo this back with the code so CSRF checks hold. */
  state: string
  expiresAt: number
}

// Singleton
let instance: ChatGptAuthManager | null = null

export function getChatGptAuthManager(): ChatGptAuthManager {
  if (!instance) {
    instance = new ChatGptAuthManager()
  }
  return instance
}
