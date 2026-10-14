import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { isIP } from 'node:net'
import { isLinkLocalIp, isLoopbackHostname, isLoopbackIp, isUnspecifiedIp } from '../../../utils/ssrf-guard'

/**
 * OAuth sign-in against a remote daemon (design §9.3, tracker W4-B).
 *
 * The daemon runs the OAuth flow (PKCE verifier, token exchange, token
 * store) and hands Studio an authorization URL whose `redirect_uri` is a
 * loopback callback on the daemon's machine (http://127.0.0.1:<port>/…).
 * The browser runs on this computer, so after sign-in it is sent to this
 * computer's loopback, where nothing of the daemon listens. The relay:
 *
 * 1. checks the authorization URL before anything is opened (https, a real
 *    host name or public address, no credentials in it: a daemon, or
 *    anything answering on its port, never makes Studio open another kind
 *    of address in the browser);
 * 2. listens on this computer's loopback at the redirect URI's port and path;
 * 3. opens the page; the user signs in;
 * 4. takes the one callback whose `state` matches the authorization URL's,
 *    and hands only its OAuth parameters (code, state, error, …) to the
 *    daemon (POST /oauth/relay), which delivers them to its own loopback
 *    callback. Only the short-lived code travels, useless without the
 *    verifier the daemon kept (as `adf auth login --relay` does for ChatGPT).
 *
 * When the port is taken on this computer (the daemon runs on this computer
 * behind a tunnel, or another program holds it), the page is still opened
 * and the log says the callback is not relayed.
 */

/** OAuth callback parameters handed to the daemon; anything else in the callback query is dropped. */
export const RELAYED_PARAMS = ['code', 'state', 'error', 'error_description', 'error_uri', 'iss'] as const

/** How long a relay waits for its callback (the daemon's MCP flow waits 5 minutes). */
export const RELAY_TIMEOUT_MS = 5 * 60_000
/** Callbacks with a wrong `state` before the relay gives up (a stray or forged hit is answered 400, not taken). */
const MAX_STRAY = 10

export type BrowserUrlCheck = { ok: true; url: URL } | { ok: false; reason: string }

/**
 * May Studio open `raw` in this computer's browser at a remote daemon's
 * request? Only an https page on a host name or a public address, with no
 * user name or password in it.
 */
export function checkRemoteBrowserUrl(raw: string): BrowserUrlCheck {
  let url: URL
  try { url = new URL(raw) } catch { return { ok: false, reason: 'it is not a URL' } }
  if (url.protocol !== 'https:') return { ok: false, reason: `it is not an https page (${url.protocol})` }
  if (url.username || url.password) return { ok: false, reason: 'it carries a user name or password' }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!host) return { ok: false, reason: 'it has no host' }
  if (isLoopbackHostname(host)) return { ok: false, reason: `it points at this computer (${host})` }
  if (isIP(host) && (isLoopbackIp(host) || isUnspecifiedIp(host) || isLinkLocalIp(host))) {
    return { ok: false, reason: `it points at a loopback or link-local address (${host})` }
  }
  return { ok: true, url }
}

export interface LoopbackRedirect {
  /** The redirect URI as the authorization URL names it. */
  uri: string
  /** Where this computer listens: 127.0.0.1 or ::1. */
  host: string
  port: number
  path: string
}

/** The authorization URL's loopback `redirect_uri`, or null when it has none (nothing to relay). */
export function loopbackRedirectOf(authorizeUrl: URL): LoopbackRedirect | null {
  const raw = authorizeUrl.searchParams.get('redirect_uri')
  if (!raw) return null
  let r: URL
  try { r = new URL(raw) } catch { return null }
  if (r.protocol !== 'http:' || !r.port) return null
  const hostname = r.hostname.toLowerCase()
  const host = hostname === '[::1]' ? '::1' : hostname === '127.0.0.1' || hostname === 'localhost' ? '127.0.0.1' : null
  if (!host) return null
  const port = Number(r.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return { uri: raw, host, port, path: r.pathname || '/' }
}

export interface RelayAnswer {
  delivered: boolean
  status: number | null
  error?: string
}

export interface OAuthRelayDeps {
  /** POST /oauth/relay on the daemon: deliver the callback's parameters to its loopback redirect URI. */
  relay(body: { redirectUri: string; params: Record<string, string> }): Promise<RelayAnswer>
  openExternal(url: string): Promise<void> | void
  log: Pick<Console, 'log' | 'warn'>
  /** Tests: listen here instead of the redirect URI's own loopback address. */
  bindHost?: string
  timeoutMs?: number
}

export interface RelayOpenResult {
  opened: boolean
  /** A listener waits for the callback on this computer. */
  relaying: boolean
  /** Why the page was not opened, or why its callback is not relayed. */
  reason?: string
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function page(res: ServerResponse, status: number, title: string, text: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(`<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><body style="font-family:system-ui,sans-serif;margin:3em"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(text)}</p></body>`)
}

interface Listener { server: Server; state: string | null; close(): void }

export class OAuthCallbackRelay {
  /** One listener per local port. */
  private readonly listeners = new Map<number, Listener>()

  constructor(private readonly deps: OAuthRelayDeps) {}

  /**
   * Check `authorizeUrl`, start the relay for its loopback redirect, and open
   * it in the browser. Resolves once the page was opened (or refused); the
   * relay itself runs until its callback arrives or it times out.
   */
  async open(authorizeUrl: string, label: string): Promise<RelayOpenResult> {
    const check = checkRemoteBrowserUrl(authorizeUrl)
    if (!check.ok) {
      this.deps.log.warn(`[Remote] The sign-in page for ${label} was not opened: ${check.reason}`)
      return { opened: false, relaying: false, reason: `The ADF daemon sent a sign-in address Studio does not open: ${check.reason}.` }
    }
    const redirect = loopbackRedirectOf(check.url)
    let relaying = false
    let reason: string | undefined
    if (redirect) {
      const existing = this.listeners.get(redirect.port)
      const state = check.url.searchParams.get('state')
      if (existing && existing.state === state) {
        relaying = true
      } else {
        existing?.close()
        try {
          await this.listen(redirect, state, label)
          relaying = true
        } catch (err) {
          const code = (err as NodeJS.ErrnoException)?.code
          reason = code === 'EADDRINUSE'
            ? `Port ${redirect.port} on this computer is in use, so Studio cannot take the sign-in callback for the daemon. If the daemon runs on this computer the callback reaches it directly; otherwise free the port and sign in again.`
            : `Studio could not listen for the sign-in callback on port ${redirect.port}: ${err instanceof Error ? err.message : String(err)}`
          this.deps.log.warn(`[Remote] ${label}: ${reason}`)
        }
      }
    } else {
      this.deps.log.log(`[Remote] ${label}: the sign-in page has no loopback redirect; nothing to relay`)
    }
    this.deps.log.log(`[Remote] ${label}: opening the sign-in page in the browser${relaying ? `; its callback is relayed to the daemon` : ''}`)
    await this.deps.openExternal(check.url.toString())
    return { opened: true, relaying, ...(reason ? { reason } : {}) }
  }

  private listen(redirect: LoopbackRedirect, state: string | null, label: string): Promise<void> {
    let strays = 0
    let done = false
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
      if (req.method !== 'GET' || url.pathname !== redirect.path || done) {
        page(res, 404, 'Not found', 'This address only takes an ADF sign-in callback.')
        return
      }
      if (state !== null && url.searchParams.get('state') !== state) {
        page(res, 400, 'Sign-in callback refused', 'This callback does not belong to the sign-in Studio started.')
        if (++strays >= MAX_STRAY) {
          this.deps.log.warn(`[Remote] ${label}: ${MAX_STRAY} callbacks with a wrong state; the relay stops`)
          listener.close()
        }
        return
      }
      done = true
      const params: Record<string, string> = {}
      for (const key of RELAYED_PARAMS) {
        const value = url.searchParams.get(key)
        if (value !== null) params[key] = value
      }
      void this.deps.relay({ redirectUri: redirect.uri, params }).then((answer) => {
        if (answer.delivered) {
          this.deps.log.log(`[Remote] ${label}: sign-in callback relayed to the daemon`)
          page(res, 200, 'Signed in', 'The ADF daemon has the sign-in. You can close this tab and return to ADF Studio.')
        } else {
          const why = answer.error ?? `the daemon's sign-in answered HTTP ${answer.status}`
          this.deps.log.warn(`[Remote] ${label}: the relayed sign-in callback was not accepted: ${why}`)
          page(res, 502, 'Sign-in not completed', `The ADF daemon did not accept the sign-in: ${why}. Start the sign-in again from ADF Studio.`)
        }
      }, (err) => {
        const why = err instanceof Error ? err.message : String(err)
        this.deps.log.warn(`[Remote] ${label}: relaying the sign-in callback failed: ${why}`)
        page(res, 502, 'Sign-in not completed', `Studio could not hand the sign-in to the ADF daemon: ${why}`)
      }).finally(() => listener.close())
    })
    const timer = setTimeout(() => {
      this.deps.log.warn(`[Remote] ${label}: no sign-in callback within ${Math.round((this.deps.timeoutMs ?? RELAY_TIMEOUT_MS) / 1000)} s; the relay stops`)
      listener.close()
    }, this.deps.timeoutMs ?? RELAY_TIMEOUT_MS)
    timer.unref?.()
    const listener: Listener = {
      server,
      state,
      close: () => {
        clearTimeout(timer)
        if (this.listeners.get(redirect.port) === listener) this.listeners.delete(redirect.port)
        // Let a callback being answered finish; refuse new connections.
        server.close()
        server.closeIdleConnections?.()
      },
    }
    return new Promise<void>((resolve, reject) => {
      const failed = (err: Error) => {
        clearTimeout(timer)
        reject(err)
      }
      server.once('error', failed)
      server.listen(redirect.port, this.deps.bindHost ?? redirect.host, () => {
        server.off('error', failed)
        server.on('error', (err) => this.deps.log.warn(`[Remote] ${label}: the sign-in callback listener failed: ${err.message}`))
        this.listeners.set(redirect.port, listener)
        resolve()
      })
    })
  }

  /** Stop every relay (shutdown). */
  closeAll(): void {
    for (const listener of [...this.listeners.values()]) listener.close()
  }

  get active(): number {
    return this.listeners.size
  }
}
