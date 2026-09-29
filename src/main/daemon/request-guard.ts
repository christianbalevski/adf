/**
 * Cross-site request protection for the daemon HTTP API.
 *
 * A web page in the user's browser can send requests to 127.0.0.1:7385
 * (CSRF) or, through DNS rebinding, make its own hostname resolve there.
 * Three checks, in order, on every request:
 *
 *   1. Host allow-list: the Host header must name this daemon — 127.0.0.1,
 *      localhost or [::1] with the bound port (plus the bind address itself),
 *      and for non-loopback binds any IP literal on that port and the names in
 *      ADF_DAEMON_ALLOWED_HOSTS. A rebinding attacker's hostname never
 *      matches.
 *   2. Browser context: a request carrying an Origin that is not one of the
 *      allowed hosts, or `Sec-Fetch-Site: cross-site|same-site`, is refused.
 *      Browsers always attach these to cross-site fetches and form posts;
 *      the CLI and terminal app send neither. No CORS headers are ever sent.
 *   3. Bearer token (daemon-token.ts) on everything but GET /health.
 */

import { isIP } from 'node:net'
import { tokensEqual } from './daemon-token'

export interface HostRule {
  /** Lowercase hostname, IPv6 without brackets. */
  host: string
  /** Required port; undefined = any port. */
  port?: number
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
}

export interface GuardRejection {
  status: 401 | 403
  body: { error: string; code: string }
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

function hostMatches(host: string, port: number, rules: HostRule[], ipLiteralPort: number | null): boolean {
  if (ipLiteralPort !== null && port === ipLiteralPort && isIP(host) !== 0) return true
  return rules.some(rule => rule.host === host && (rule.port === undefined || rule.port === port))
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

  /** null = allowed. `path` is the URL path without the query string. */
  check(method: string, path: string, headers: Record<string, HeaderValue>): GuardRejection | null {
    const rules = this.rules
    if (rules) {
      const parsed = parseHostHeader(single(headers.host) ?? '')
      if (!parsed || !hostMatches(parsed.host, parsed.port ?? 80, rules, this.ipLiteralPort)) {
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

    if (this.token && !(method === 'GET' && path === '/health')) {
      const auth = single(headers.authorization) ?? ''
      const match = /^Bearer\s+(.+)$/i.exec(auth.trim())
      if (!match || !tokensEqual(match[1].trim(), this.token)) {
        return { status: 401, body: { error: TOKEN_REQUIRED_MESSAGE, code: 'unauthorized' } }
      }
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

function forbidden(error: string, code: string): GuardRejection {
  return { status: 403, body: { error, code } }
}
