import { createServer } from 'http'
import type { Server } from 'http'
import { randomBytes } from 'crypto'
import { createRequire } from 'module'
import { dirname, join } from 'path'
import type { AddressInfo } from 'net'
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
  AuthResult,
} from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientMetadata,
  OAuthClientInformationMixed,
  OAuthClientInformationFull,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import type { McpOAuthStore, McpOAuthRecord } from './mcp-oauth.types'

/**
 * Interactive HTTP-OAuth for remote (`type: 'http'`) MCP servers — the
 * browser-consent alternative to pasting a bearer token (see
 * docs/design/mcp-http-oauth.md, sub-task A).
 *
 * Runtime-agnostic core — MUST NOT import 'electron'. Like
 * mcp-auth-preflight.ts, each runtime supplies its IO:
 *  - Studio passes `openUrl: shell.openExternal` (+ a logger).
 *  - Headless runtimes best-effort open + log; v1 runtime is Studio-only
 *    interactive, so the daemon never drives this flow (it relies on an
 *    agent-sealed token instead — fail plainly otherwise).
 *
 * The SDK's `auth()` orchestrator does all the protocol work (RFC 9728 →
 * RFC 8414/OIDC discovery → RFC 7591 DCR → PKCE → refresh); this module only
 * supplies an `OAuthClientProvider` (store-backed persistence + browser
 * redirect) and a loopback callback server to receive the authorization code.
 */

// Import the SDK's runtime auth symbols through the same CJS shim
// mcp-client-manager.ts uses: the package's wildcard export ("./*") does not
// append .js, so resolve the concrete file from the /client entry's directory.
// (ESM/CJS interop — `auth`/`UnauthorizedError` are runtime values, not types.)
const _require = createRequire(import.meta.url)
const _clientDir = dirname(_require.resolve('@modelcontextprotocol/sdk/client'))
const { auth, UnauthorizedError } = _require(join(_clientDir, 'auth.js')) as typeof import('@modelcontextprotocol/sdk/client/auth.js')
export { UnauthorizedError }

/** ~5 min — matches the interactive-auth timeout used elsewhere (preflight). */
const DEFAULT_FLOW_TIMEOUT_MS = 300_000

/**
 * Injected IO. Studio passes `shell.openExternal`; headless best-effort.
 * Mirrors McpAuthPreflightIO's split — no 'electron' dependency in this file.
 */
export interface McpHttpOAuthIO {
  /** Open the (https) authorization URL in the user's browser. */
  openUrl(url: string): void | Promise<void>
  log?(msg: string): void
}

export interface AdfOAuthClientProviderOpts {
  /** Pre-registered client id (skips DCR); otherwise DCR registers one. */
  clientId?: string
  /** Requested OAuth scopes. */
  scopes?: string[]
  /** Loopback callback URL — set by the flow after the callback server binds. */
  redirectUrl: string
}

/** Log a URL with its query stripped (state/code/PKCE never reach the log). */
function urlWithoutQuery(url: string | URL): string {
  try {
    const u = typeof url === 'string' ? new URL(url) : url
    return `${u.origin}${u.pathname}`
  } catch {
    return '<url>'
  }
}

/**
 * `OAuthClientProvider` backed by an {@link McpOAuthStore}. Tokens, the
 * DCR-issued client registration, and the discovery cache persist through the
 * store (sealed at rest by the concrete store); the PKCE code verifier and the
 * per-flow `state` are in-memory (ephemeral — must not cross sessions).
 */
export class AdfOAuthClientProvider implements OAuthClientProvider {
  private _codeVerifier: string | undefined
  private _state: string | undefined
  /** Serializes read-modify-write of the single store record for this URL. */
  private _writeChain: Promise<void> = Promise.resolve()

  constructor(
    private readonly serverUrl: string,
    private readonly store: McpOAuthStore,
    private readonly io: McpHttpOAuthIO,
    private readonly opts: AdfOAuthClientProviderOpts,
  ) {}

  get redirectUrl(): string {
    return this.opts.redirectUrl
  }

  get clientMetadata(): OAuthClientMetadata {
    const scopes = this.opts.scopes
    return {
      client_name: 'ADF Studio',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(scopes && scopes.length ? { scope: scopes.join(' ') } : {}),
    }
  }

  /** The state generated for the in-flight authorization (callback validates). */
  get lastState(): string | undefined {
    return this._state
  }

  state(): string {
    // Fresh cryptographically-random state per authorization; retained so the
    // loopback callback can reject a mismatched/forged redirect.
    this._state = randomBytes(32).toString('base64url')
    return this._state
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    // A statically-known client id short-circuits DCR.
    if (this.opts.clientId) return { client_id: this.opts.clientId }
    const record = await this.store.get(this.serverUrl)
    return record?.clientInformation
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    // REQUIRED for DCR — auth() throws without it. DCR yields a full record.
    await this.merge({ clientInformation: info as OAuthClientInformationFull })
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const record = await this.store.get(this.serverUrl)
    return record?.tokens
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.merge({ tokens })
  }

  async saveDiscoveryState(discoveryState: OAuthDiscoveryState): Promise<void> {
    await this.merge({ discoveryState })
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    const record = await this.store.get(this.serverUrl)
    return record?.discoveryState
  }

  saveCodeVerifier(codeVerifier: string): void {
    this._codeVerifier = codeVerifier
  }

  codeVerifier(): string {
    if (!this._codeVerifier) {
      throw new Error('No PKCE code verifier available — authorization was not started in this flow')
    }
    return this._codeVerifier
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    switch (scope) {
      case 'verifier':
        this._codeVerifier = undefined
        return
      case 'discovery': {
        // The store's invalidate has no 'discovery' scope; drop just that field.
        const record = await this.store.get(this.serverUrl)
        if (record?.discoveryState) {
          const { discoveryState: _drop, ...rest } = record
          await this.store.save(this.serverUrl, { ...rest, updatedAt: Date.now() })
        }
        return
      }
      case 'all':
        this._codeVerifier = undefined
        this._state = undefined
        await this.store.invalidate(this.serverUrl, 'all')
        return
      case 'tokens':
        await this.store.invalidate(this.serverUrl, 'tokens')
        return
      case 'client':
        await this.store.invalidate(this.serverUrl, 'client')
        return
    }
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    // Only ever send the browser to an https URL from SDK discovery.
    if (authorizationUrl.protocol !== 'https:') {
      throw new Error(`Refusing to open non-https authorization URL (${authorizationUrl.protocol})`)
    }
    this.io.log?.(`[MCP][oauth] Opening authorization URL: ${urlWithoutQuery(authorizationUrl)}`)
    await Promise.resolve(this.io.openUrl(authorizationUrl.toString()))
  }

  /** Read-modify-write the single store record, serialized against races. */
  private merge(patch: Partial<Omit<McpOAuthRecord, 'updatedAt'>>): Promise<void> {
    const run = this._writeChain.then(async () => {
      const existing = (await this.store.get(this.serverUrl)) ?? { updatedAt: 0 }
      await this.store.save(this.serverUrl, { ...existing, ...patch, updatedAt: Date.now() })
    })
    // Keep the chain alive even if one write rejects.
    this._writeChain = run.catch(() => {})
    return run
  }
}

export interface OAuthCallbackServer {
  /** Bound loopback callback URL, e.g. http://127.0.0.1:54321/callback. */
  url: string
  /** Resolves with the authorization `code` once a valid callback arrives. */
  waitForCode: Promise<string>
  /** Stop listening and settle the wait (idempotent). */
  close(): void
}

/**
 * Loopback OAuth callback server: binds 127.0.0.1:0 (ephemeral port — per
 * locked decision #4, no fixed port ⇒ no EADDRINUSE class), serves a single
 * `GET /callback?code=...&state=...`, validates `state` against
 * `expectedState()`, and resolves `waitForCode` with the code. Single-use and
 * hard-timed-out; binds loopback only.
 */
export function startOAuthCallbackServer(
  expectedState: () => string | undefined,
  timeoutMs: number = DEFAULT_FLOW_TIMEOUT_MS,
): Promise<OAuthCallbackServer> {
  return new Promise<OAuthCallbackServer>((resolveServer, rejectServer) => {
    let resolveCode!: (code: string) => void
    let rejectCode!: (err: Error) => void
    const waitForCode = new Promise<string>((res, rej) => {
      resolveCode = res
      rejectCode = rej
    })
    // Never let waitForCode reject unhandled if no one awaits it yet.
    waitForCode.catch(() => {})

    let settled = false
    let timer: NodeJS.Timeout | undefined

    const server: Server = createServer((req, res) => {
      const host = req.headers.host ?? '127.0.0.1'
      let parsed: URL
      try {
        parsed = new URL(req.url ?? '/', `http://${host}`)
      } catch {
        res.writeHead(400, { 'content-type': 'text/plain' })
        res.end('Bad request')
        return
      }
      if (parsed.pathname !== '/callback') {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('Not found')
        return
      }
      const state = parsed.searchParams.get('state') ?? undefined
      const code = parsed.searchParams.get('code') ?? undefined
      const oauthError = parsed.searchParams.get('error') ?? undefined

      const expected = expectedState()
      if (!expected || state !== expected) {
        res.writeHead(400, { 'content-type': 'text/html' })
        res.end(errorPage('State mismatch — this authorization request could not be verified.'))
        finish(() => rejectCode(new Error('OAuth callback state mismatch — possible forged or stale redirect')))
        return
      }
      if (oauthError) {
        res.writeHead(400, { 'content-type': 'text/html' })
        res.end(errorPage(`Authorization failed: ${oauthError}`))
        finish(() => rejectCode(new Error(`Authorization server returned error: ${oauthError}`)))
        return
      }
      if (!code) {
        res.writeHead(400, { 'content-type': 'text/html' })
        res.end(errorPage('Authorization response was missing a code.'))
        finish(() => rejectCode(new Error('OAuth callback missing authorization code')))
        return
      }
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(successPage())
      // Single-use: settle with the code and stop accepting further callbacks.
      finish(() => resolveCode(code))
    })

    // Settle exactly once: run the resolve/reject, stop the timer, close the
    // listener. `close()` (external) routes here too.
    function finish(fn: () => void): void {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      fn()
      try { server.close() } catch { /* already closing */ }
    }

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return
      // Pre-bind failure: reject the whole start.
      rejectServer(new Error(`Cannot start OAuth callback server on 127.0.0.1: ${err.message}`))
    })

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo
      const url = `http://127.0.0.1:${addr.port}/callback`
      timer = setTimeout(() => {
        finish(() => rejectCode(new Error(`OAuth authorization timed out after ${Math.round(timeoutMs / 1000)}s`)))
      }, timeoutMs)
      timer.unref?.()
      resolveServer({
        url,
        waitForCode,
        close(): void {
          finish(() => rejectCode(new Error('OAuth callback server closed before authorization completed')))
        },
      })
    })
  })
}

/**
 * Drive an interactive HTTP-OAuth sign-in for one remote MCP server end to
 * end: start the loopback callback server, run the SDK `auth()` orchestrator,
 * open the browser on `'REDIRECT'`, await the code, exchange it, and persist
 * tokens (+ DCR client info + discovery) into the store. The callback server
 * is always closed. Expected auth failures return `{ authorized: false, error }`
 * rather than throwing; token/code values never reach the log.
 */
export async function runMcpHttpOAuthFlow(
  serverUrl: string,
  store: McpOAuthStore,
  io: McpHttpOAuthIO,
  opts?: { clientId?: string; scopes?: string[]; timeoutMs?: number },
): Promise<{ authorized: boolean; error?: string }> {
  const log = io.log ?? (() => {})
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_FLOW_TIMEOUT_MS

  let provider: AdfOAuthClientProvider | undefined
  const server = await startOAuthCallbackServer(() => provider?.lastState, timeoutMs)
  provider = new AdfOAuthClientProvider(serverUrl, store, io, {
    clientId: opts?.clientId,
    scopes: opts?.scopes,
    redirectUrl: server.url,
  })

  try {
    log(`[MCP][oauth] Starting authorization for ${urlWithoutQuery(serverUrl)}`)
    const r1: AuthResult = await auth(provider, { serverUrl })
    if (r1 === 'AUTHORIZED') {
      // Valid token/refresh already in the store — nothing interactive to do.
      log('[MCP][oauth] Already authorized (existing token/refresh) — no browser step')
      return { authorized: true }
    }

    // 'REDIRECT' — the browser is opening; await the loopback callback.
    log('[MCP][oauth] Awaiting authorization callback…')
    const code = await server.waitForCode
    const r2: AuthResult = await auth(provider, { serverUrl, authorizationCode: code })
    if (r2 === 'AUTHORIZED') {
      log('[MCP][oauth] Authorization complete — tokens stored')
      return { authorized: true }
    }
    return { authorized: false, error: 'Authorization did not complete (unexpected redirect after code exchange)' }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log(`[MCP][oauth] Authorization failed: ${message}`)
    return { authorized: false, error: message }
  } finally {
    server.close()
  }
}

function successPage(): string {
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Authorization complete</title></head>',
    '<body style="font-family:system-ui,sans-serif;background:#111;color:#eee;display:flex;',
    'min-height:100vh;align-items:center;justify-content:center;margin:0">',
    '<main style="text-align:center;max-width:26rem;padding:2rem">',
    '<h1 style="font-size:1.25rem;margin:0 0 .5rem">Authorization complete</h1>',
    '<p style="opacity:.75;margin:0">You can close this tab and return to ADF Studio.</p>',
    '</main></body></html>',
  ].join('')
}

function errorPage(detail: string): string {
  const safe = detail.replace(/[<>&]/g, (c) => (c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;'))
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Authorization failed</title></head>',
    '<body style="font-family:system-ui,sans-serif;background:#111;color:#eee;display:flex;',
    'min-height:100vh;align-items:center;justify-content:center;margin:0">',
    '<main style="text-align:center;max-width:26rem;padding:2rem">',
    '<h1 style="font-size:1.25rem;margin:0 0 .5rem">Authorization failed</h1>',
    `<p style="opacity:.75;margin:0">${safe}</p>`,
    '</main></body></html>',
  ].join('')
}
