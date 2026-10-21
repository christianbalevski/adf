/**
 * Cross-site request protection for the daemon HTTP API.
 *
 * A web page in the user's browser can send requests to 127.0.0.1:7385
 * (CSRF) or, through DNS rebinding, make its own hostname resolve there.
 * Three checks, in order, on every request:
 *
 *   1. Host allow-list: the Host header must name this daemon — 127.0.0.1,
 *      localhost or [::1] (any port: an SSH tunnel `-L 7386:127.0.0.1:7385`
 *      arrives as Host 127.0.0.1:7386), the bind address itself on the bound
 *      port, and for non-loopback binds any IP literal on that port and the
 *      names in ADF_DAEMON_ALLOWED_HOSTS. DNS rebinding always carries the
 *      attacker's hostname, so only the name matters; it never matches.
 *      Origin (check 2) still needs the bound port for loopback names.
 *   2. Browser context: a request carrying an Origin that is not one of the
 *      allowed hosts, or `Sec-Fetch-Site: cross-site|same-site`, is refused.
 *      Browsers always attach these to cross-site fetches and form posts;
 *      the CLI and terminal app send neither. No CORS headers are ever sent.
 *   3. Bearer token (daemon-token.ts) on everything but GET/HEAD /health
 *      and the pairing routes (/remote/hello, /pair/*, remote-access.md §5).
 *      Two kinds of token (remote-access.md §4.4): the install's own token,
 *      never accepted on a remote listener, and device tokens (`adfd_…`),
 *      accepted only while remote access is on and never on a local-only
 *      route (isDeviceRefusedRoute, which includes /remote-access).
 */

import { isIP } from 'node:net'
import { tokensEqual } from './daemon-token'
import { isDeviceRefusedRoute } from './local-access'
import { isDeviceTokenShape } from './remote-access/device-store'
import { DEVICE_TOKEN_REFUSED_MESSAGE, type RequestAuth } from './remote-access/request-auth'

export interface HostRule {
  /** Lowercase hostname, IPv6 without brackets. */
  host: string
  /** Required port; undefined = any port. */
  port?: number
}

/** Device tokens (remote-access.md §4): the store, and whether remote access is on. */
export interface DeviceTokenAuthority {
  check(token: string): { kind: 'device'; id: string; label: string } | { kind: 'revoked'; label: string; revokedAt: string } | { kind: 'unknown' }
  enabled(): boolean
  /** This computer's name, for the refusal sentences. */
  computerName(): string
}

export interface DaemonRequestGuardOptions {
  /** Required bearer token (every route except GET /health). Absent = no token check. */
  token?: string | null
  /**
   * Host header allow-list. Absent = the Host header is not checked (tests
   * that call createDaemonHttpApi directly); any Origin is then refused.
   */
  allowedHosts?: HostRule[] | null | (() => HostRule[] | null)
  /**
   * Non-loopback bind: IP-literal hosts (Host / Origin) on this port are
   * accepted too — DNS rebinding always carries a hostname, never an IP.
   */
  ipLiteralPort?: number | null | (() => number | null)
  /** Device tokens; absent = only the install's token is accepted. */
  deviceTokens?: DeviceTokenAuthority | null
}

/** Where the request came in: a remote listener (remote-access.md §3.2) or the loopback one. */
export interface GuardConnection {
  remoteListener: boolean
}

export interface GuardRejection {
  status: 401 | 403
  body: { error: string; code: string }
}

export const MASTER_TOKEN_REMOTE_MESSAGE =
  'This computer\'s own token is not accepted from other computers. Pair this computer, or create a token for it on the host: adf daemon devices add <label>.'

/** Routes that need no bearer token: the liveness check and the pairing routes (they answer 404 while remote access is off). */
export function isUnauthenticatedRoute(method: string, path: string): boolean {
  if ((method === 'GET' || method === 'HEAD') && path === '/health') return true
  if (method === 'GET' && path === '/remote/hello') return true
  if (method === 'POST' && path === '/pair/claim') return true
  return method === 'GET' && /^\/pair\/claims\/[^/]+$/.test(path)
}

export const TOKEN_REQUIRED_MESSAGE =
  'This ADF daemon requires its access token (Authorization: Bearer). ' +
  'The adf CLI and terminal app read it automatically on the daemon\'s machine; update adf if yours does not. ' +
  'Elsewhere pass --token or set ADF_DAEMON_TOKEN. Print the token on the daemon host with: adf daemon token'

export function isLoopbackName(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  return h === 'localhost' || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
}

/** Parse `host[:port]` / `[v6][:port]`; null when malformed. */
export function parseHostHeader(value: string): { host: string; port?: number } | null {
  const raw = value.trim().toLowerCase()
  if (!raw) return null
  let host: string
  let portText: string | undefined
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']')
    if (end < 0) return null
    host = raw.slice(1, end)
    const rest = raw.slice(end + 1)
    if (rest && !rest.startsWith(':')) return null
    portText = rest ? rest.slice(1) : undefined
  } else {
    const colon = raw.lastIndexOf(':')
    if (colon >= 0 && raw.indexOf(':') !== colon) return null // bare IPv6 is not a valid Host
    host = colon >= 0 ? raw.slice(0, colon) : raw
    portText = colon >= 0 ? raw.slice(colon + 1) : undefined
  }
  if (!host) return null
  if (portText === undefined) return { host }
  if (!/^\d{1,5}$/.test(portText)) return null
  const port = Number(portText)
  return port > 0 && port <= 65535 ? { host, port } : null
}

/**
 * The Host allow-list for a daemon bound to `bindHost:port`. `extra` holds
 * ADF_DAEMON_ALLOWED_HOSTS entries (`name` = any port, `name:port`).
 */
export function daemonHostAllowList(bindHost: string, port: number, extra: string[] = []): HostRule[] {
  const rules: HostRule[] = [
    { host: '127.0.0.1', port },
    { host: 'localhost', port },
    { host: '::1', port },
  ]
  const bind = bindHost.toLowerCase().replace(/^\[|\]$/g, '')
  if (bind && bind !== '0.0.0.0' && bind !== '::' && !rules.some(r => r.host === bind)) rules.push({ host: bind, port })
  for (const entry of extra) {
    const parsed = parseHostHeader(entry)
    if (parsed) rules.push(parsed)
  }
  return rules
}

/** ADF_DAEMON_ALLOWED_HOSTS: comma/space separated. */
export function parseAllowedHostsEnv(value: string | undefined): string[] {
  return (value ?? '').split(/[\s,]+/).map(s => s.trim()).filter(Boolean)
}

const LOOPBACK_RULE_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

/**
 * `anyLoopbackPort` (Host header only): the loopback names in `rules` match on
 * any port, so a forwarded local port reaches the daemon. Origins keep the
 * exact port: a page on localhost:3000 is another origin.
 */
function hostMatches(host: string, port: number, rules: HostRule[], ipLiteralPort: number | null, anyLoopbackPort = false): boolean {
  if (ipLiteralPort !== null && port === ipLiteralPort && isIP(host) !== 0) return true
  return rules.some(rule => rule.host === host && (rule.port === undefined || rule.port === port || (anyLoopbackPort && LOOPBACK_RULE_HOSTS.has(rule.host))))
}

type HeaderValue = string | string[] | undefined

function single(value: HeaderValue): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

export class DaemonRequestGuard {
  private readonly token: string | null
  private readonly options: DaemonRequestGuardOptions

  constructor(options: DaemonRequestGuardOptions) {
    this.token = options.token ? options.token : null
    this.options = options
  }

  /** Resolved per request: DaemonHost binds port 0 in tests, known only after listen. */
  private get rules(): HostRule[] | null {
    const value = this.options.allowedHosts
    return (typeof value === 'function' ? value() : value) ?? null
  }

  private get ipLiteralPort(): number | null {
    const value = this.options.ipLiteralPort
    return (typeof value === 'function' ? value() : value) ?? null
  }

  get requiresToken(): boolean {
    return this.token !== null
  }

  /** null = allowed. `path` is the URL path without the query string. A request on the loopback listener. */
  check(method: string, path: string, headers: Record<string, HeaderValue>): GuardRejection | null {
    return this.authenticate(method, path, headers, { remoteListener: false }).rejection
  }

  /** The guard's verdict and, when allowed, who the request authenticated as. */
  authenticate(method: string, path: string, headers: Record<string, HeaderValue>, conn: GuardConnection): { rejection: GuardRejection | null; auth: RequestAuth } {
    const none: RequestAuth = { kind: 'none' }
    const rejection = this.crossSite(headers)
    if (rejection) return { rejection, auth: none }
    if (isUnauthenticatedRoute(method, path)) return { rejection: null, auth: none }
    if (!this.token) {
      // No token configured (bare test servers): a remote listener never runs without one.
      return conn.remoteListener ? { rejection: unauthorized(), auth: none } : { rejection: null, auth: none }
    }
    const auth = single(headers.authorization) ?? ''
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim())
    if (!match) return { rejection: unauthorized(), auth: none }
    const presented = match[1].trim()
    const devices = this.options.deviceTokens
    if (devices && isDeviceTokenShape(presented)) {
      const result = devices.check(presented)
      if (result.kind === 'revoked') {
        return { rejection: { status: 401, body: { error: `This computer's access to ${devices.computerName()} was removed on ${result.revokedAt.slice(0, 10)}. Pair it again to reconnect.`, code: 'device_revoked' } }, auth: none }
      }
      // 'unknown' falls through: an operator-chosen ADF_DAEMON_TOKEN may start with the prefix too.
      if (result.kind === 'device') {
        if (!devices.enabled()) {
          return { rejection: { status: 401, body: { error: `Remote access is turned off on ${devices.computerName()}. Turn it on there (Settings → Connections → Add → Share, or adf daemon remote on).`, code: 'remote_access_off' } }, auth: none }
        }
        if (isDeviceRefusedRoute(method, path)) return { rejection: forbidden(DEVICE_TOKEN_REFUSED_MESSAGE, 'device_token_refused'), auth: none }
        return { rejection: null, auth: { kind: 'device', deviceId: result.id, label: result.label } }
      }
    }
    if (!tokensEqual(presented, this.token)) return { rejection: unauthorized(), auth: none }
    if (conn.remoteListener) return { rejection: { status: 401, body: { error: MASTER_TOKEN_REMOTE_MESSAGE, code: 'master_token_remote' } }, auth: none }
    return { rejection: null, auth: { kind: 'master' } }
  }

  /** Checks 1 and 2: Host allow-list, Origin and Sec-Fetch-Site. */
  private crossSite(headers: Record<string, HeaderValue>): GuardRejection | null {
    const rules = this.rules
    if (rules) {
      const parsed = parseHostHeader(single(headers.host) ?? '')
      if (!parsed || !hostMatches(parsed.host, parsed.port ?? 80, rules, this.ipLiteralPort, true)) {
        return forbidden('Host header not allowed for this daemon (DNS rebinding protection). Use 127.0.0.1 or localhost, or add the name to ADF_DAEMON_ALLOWED_HOSTS.', 'host_not_allowed')
      }
    }

    const origin = single(headers.origin)
    if (origin !== undefined && !this.originAllowed(origin)) {
      return forbidden('Cross-origin requests are not accepted by the ADF daemon.', 'cross_origin')
    }
    const site = single(headers['sec-fetch-site'])?.toLowerCase()
    if (site === 'cross-site' || site === 'same-site') {
      return forbidden('Cross-site requests are not accepted by the ADF daemon.', 'cross_origin')
    }
    return null
  }

  private originAllowed(origin: string): boolean {
    const rules = this.rules
    if (!rules) return false
    let url: URL
    try { url = new URL(origin) } catch { return false }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80
    return hostMatches(host, port, rules, this.ipLiteralPort)
  }
}

function unauthorized(): GuardRejection {
  return { status: 401, body: { error: TOKEN_REQUIRED_MESSAGE, code: 'unauthorized' } }
}

function forbidden(error: string, code: string): GuardRejection {
  return { status: 403, body: { error, code } }
}
