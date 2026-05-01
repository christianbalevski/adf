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

class ChatGptAuthManager {
  private refreshPromise: Promise<string> | null = null
  private cachedTokens: TokenSet | null = null
  private email?: string
  private activeAuthFlow: ChatGptAuthFlow | null = null

  constructor() {
    this.cachedTokens = readTokens()
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

        // Exchange code for tokens
        const tokenResponse = await fetch(TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: CLIENT_ID,
            code: result.code,
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
        const tokens: TokenSet = {
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token,
          expires_at: Date.now() + tokenData.expires_in * 1000,
          account_id: accountId
        }

        writeTokens(tokens)
        this.cachedTokens = tokens
      } finally {
        server.close()
        this.activeAuthFlow = null
      }
    })()

    this.activeAuthFlow = { authUrl, callbackPort: server.port, completion }
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

      const data = await response.json() as {
        access_token: string
        refresh_token: string
        expires_in: number
        id_token?: string
      }

      // Extract email from refreshed id_token
      if (data.id_token) {
        const claims = decodeJwtPayload(data.id_token)
        this.email = claims.email as string | undefined
      }

      // OpenAI rotates refresh tokens — persist new one immediately
      const newTokens: TokenSet = {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: Date.now() + data.expires_in * 1000,
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
      return { authenticated: false }
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
  }
}

export interface ChatGptAuthFlow {
  authUrl: string
  callbackPort: number
  completion: Promise<void>
}

// Singleton
let instance: ChatGptAuthManager | null = null

export function getChatGptAuthManager(): ChatGptAuthManager {
  if (!instance) {
    instance = new ChatGptAuthManager()
  }
  return instance
}
