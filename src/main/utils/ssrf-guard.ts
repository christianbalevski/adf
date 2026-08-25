import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

// =============================================================================
// SSRF / egress guard (shared)
//
// sys_fetch and ws_connect are reachable from the LLM loop, so a prompt-injected
// agent could otherwise drive the unauthenticated local daemon (127.0.0.1:7385),
// cloud metadata (169.254.169.254) or anything else on the LAN.
//
// Policy: LOOPBACK is allowed by default (local dev servers are a core agent
// use case) — except the daemon control API, which is never reachable. Private
// LAN / CGNAT destinations are default-denied; `security.allow_local_fetch:
// true` is the config-level escape hatch for agents that legitimately call
// LAN services. It is NOT a master key: the daemon control API and
// link-local/cloud-metadata addresses stay blocked even when it is set.
// =============================================================================

const ALLOWED_FETCH_PROTOCOLS = new Set(['http:', 'https:'])
const ALLOWED_CONNECT_PROTOCOLS = new Set(['ws:', 'wss:', 'http:', 'https:'])

export interface FetchGuardOptions {
  /** security.allow_local_fetch; default false. Gates private/LAN/CGNAT only — loopback is allowed by default. */
  allowLocal?: boolean
  /** Loopback daemon control-API port; ALWAYS blocked on loopback, even if allowLocal. */
  daemonPort?: number
  /** The agent's own served origin; ALLOWED even when !allowLocal. */
  ownOrigin?: { port: number; pathPrefix: string }
}

/**
 * Parse the loose inet_aton forms a resolver accepts but `net.isIP` rejects
 * ("127.1", "0x7f000001", "2130706433", "0177.0.0.1") into dotted-quad form.
 * Returns null when the host is not a numeric IPv4 spelling at all.
 */
export function parseLooseIPv4(host: string): string | null {
  const parts = host.split('.')
  if (parts.length < 1 || parts.length > 4) return null
  const nums: number[] = []
  for (const part of parts) {
    if (part === '') return null
    let n: number
    if (/^0[xX][0-9a-fA-F]+$/.test(part)) n = parseInt(part.slice(2), 16)
    else if (/^0[0-7]+$/.test(part)) n = parseInt(part.slice(1), 8)
    else if (/^[0-9]+$/.test(part)) n = parseInt(part, 10)
    else return null
    if (!Number.isFinite(n) || n < 0) return null
    nums.push(n)
  }
  // In inet_aton the final part absorbs all remaining octets.
  for (let i = 0; i < nums.length - 1; i++) if (nums[i] > 255) return null
  const last = nums[nums.length - 1]
  if (last >= Math.pow(256, 4 - nums.length + 1)) return null
  let value = last
  for (let i = 0; i < nums.length - 1; i++) value += nums[i] * Math.pow(256, 3 - i)
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.')
}

/** Loopback, RFC1918, CGNAT, link-local, multicast/reserved. */
export function isBlockedIPv4(ip: string): boolean {
  const o = ip.split('.').map(Number)
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const [a, b, c] = o
  if (a === 0) return true                            // 0.0.0.0/8 "this host"
  if (a === 10) return true                           // RFC1918
  if (a === 127) return true                          // loopback
  if (a === 100 && b >= 64 && b <= 127) return true   // RFC6598 CGNAT
  if (a === 169 && b === 254) return true             // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true    // RFC1918
  if (a === 192 && b === 0 && c === 0) return true    // IETF protocol assignments
  if (a === 192 && b === 168) return true             // RFC1918
  if (a === 198 && (b === 18 || b === 19)) return true // benchmarking
  if (a >= 224) return true                           // multicast, reserved, broadcast
  return false
}

/** ::, ::1, fe80::/10, fc00::/7, ff00::/8 and IPv4-mapped forms of the above. */
export function isBlockedIPv6(raw: string): boolean {
  const addr = raw.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]
  if (addr === '::' || addr === '::1') return true
  if (/^(0:){7}[01]$/.test(addr)) return true
  const mapped = addr.match(/^::(?:ffff:(?:0{1,4}:)?)?((?:\d{1,3}\.){3}\d{1,3})$/)
  if (mapped) return isBlockedIPv4(mapped[1])
  const head = addr.split(':')[0]
  if (!head) return false
  const h = parseInt(head, 16)
  if (Number.isNaN(h)) return false
  if ((h & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if ((h & 0xfe00) === 0xfc00) return true // fc00::/7 unique-local
  if ((h & 0xff00) === 0xff00) return true // ff00::/8 multicast
  return false
}

/** True when a literal IP address is loopback / link-local / private. */
export function isBlockedIpAddress(ip: string): boolean {
  const version = isIP(ip.replace(/^\[|\]$/g, ''))
  if (version === 4) return isBlockedIPv4(ip)
  if (version === 6) return isBlockedIPv6(ip)
  return false
}

/** True for 169.254.0.0/16 and fe80::/10 (incl. IPv4-mapped) — cloud metadata lives here. */
export function isLinkLocalIp(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, '').split('%')[0]
  const version = isIP(bare)
  if (version === 4) {
    const o = bare.split('.').map(Number)
    return o[0] === 169 && o[1] === 254
  }
  if (version === 6) {
    const addr = bare.toLowerCase()
    const mapped = addr.match(/^::(?:ffff:(?:0{1,4}:)?)?((?:\d{1,3}\.){3}\d{1,3})$/)
    if (mapped) {
      const o = mapped[1].split('.').map(Number)
      return o[0] === 169 && o[1] === 254
    }
    const head = addr.split(':')[0]
    const h = parseInt(head, 16)
    if (Number.isNaN(h)) return false
    return (h & 0xffc0) === 0xfe80
  }
  return false
}

/** True for 127.0.0.0/8 and ::1 (incl. IPv4-mapped 127/8). */
export function isLoopbackIp(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, '').split('%')[0]
  const version = isIP(bare)
  if (version === 4) return bare.split('.').map(Number)[0] === 127
  if (version === 6) {
    const addr = bare.toLowerCase()
    if (addr === '::1') return true
    if (/^(0:){7}1$/.test(addr)) return true
    const mapped = addr.match(/^::(?:ffff:(?:0{1,4}:)?)?((?:\d{1,3}\.){3}\d{1,3})$/)
    if (mapped) return mapped[1].split('.').map(Number)[0] === 127
    return false
  }
  return false
}

export function isLoopbackHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '')
  return h === 'localhost' || h === 'localhost.localdomain' || h.endsWith('.localhost')
}

/**
 * True for 0.0.0.0 and :: (incl. IPv4-mapped 0.0.0.0). Connecting to the
 * unspecified address reaches loopback listeners on most stacks, so the
 * daemon-port tier must treat it as loopback — but it is NOT default-allowed
 * the way real loopback is.
 */
export function isUnspecifiedIp(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, '').split('%')[0].toLowerCase()
  if (bare === '0.0.0.0') return true
  if (bare === '::') return true
  if (/^(0{1,4}:){7}0{1,4}$/.test(bare)) return true
  const mapped = bare.match(/^::(?:ffff:(?:0{1,4}:)?)?((?:\d{1,3}\.){3}\d{1,3})$/)
  if (mapped) return mapped[1] === '0.0.0.0'
  return false
}

function blockedMessage(target: string): string {
  return (
    `Blocked by the sys_fetch SSRF guard: "${target}" is a private-network address (loopback is allowed by default). ` +
    'Set security.allow_local_fetch: true in your config to permit private/LAN fetches — ' +
    'an agent-initiated write to that setting raises an owner approval request.'
  )
}

function connectBlockedMessage(target: string): string {
  return (
    `Blocked by the ws_connect SSRF guard: "${target}" is a private-network address (loopback is allowed by default). ` +
    'Set security.allow_local_fetch: true in your config to permit private/LAN connections — ' +
    'an agent-initiated write to that setting raises an owner approval request.'
  )
}

interface HostClass {
  anyLinkLocal: boolean
  anyLoopback: boolean
  anyUnspecified: boolean
  /** Any candidate in a blocked class OTHER than loopback (private, CGNAT, unspecified, …). */
  anyNonLoopbackBlocked: boolean
}

/**
 * Resolve `host` to candidate IPs and classify them. Returns null when a
 * hostname fails to resolve — the caller lets the network layer surface the
 * real error instead of masking it as a security denial.
 */
async function classifyHost(host: string): Promise<HostClass | null> {
  let loopbackHost = false
  let candidates: string[] = []

  if (isIP(host)) {
    candidates = [host]
  } else if (isLoopbackHostname(host)) {
    loopbackHost = true // no DNS — the name itself is loopback
  } else {
    const loose = parseLooseIPv4(host)
    if (loose) {
      candidates = [loose]
    } else {
      try {
        const addresses = await lookup(host, { all: true, verbatim: true })
        candidates = addresses.map((a) => a.address)
      } catch {
        return null
      }
    }
  }

  return {
    anyLinkLocal: candidates.some(isLinkLocalIp),
    anyLoopback: loopbackHost || candidates.some(isLoopbackIp),
    anyUnspecified: candidates.some(isUnspecifiedIp),
    // Blocked classes minus loopback (private, CGNAT, unspecified, multicast, …)
    // — loopback itself is allowed by default and only tier-gated per-port.
    anyNonLoopbackBlocked: candidates.some((ip) => isBlockedIpAddress(ip) && !isLoopbackIp(ip))
  }
}

/**
 * The tiered egress policy shared by fetch and connect. The always-block tiers
 * run BEFORE the allowLocal short-circuit, so allow_local_fetch never re-opens
 * the daemon control API or cloud metadata.
 */
function applyPolicy(
  target: string,
  port: number,
  path: string,
  cls: HostClass,
  opts: FetchGuardOptions,
  overridableMessage: (target: string) => string
): string | null {
  // Tier 1 — link-local / cloud metadata: never reachable, ignores allowLocal.
  if (cls.anyLinkLocal) {
    return `Blocked: "${target}" is a link-local / cloud-metadata address, which is never fetchable (even with allow_local_fetch).`
  }
  // Tier 2 — the local ADF daemon control API: never reachable, ignores
  // allowLocal. The unspecified address (0.0.0.0 / ::) reaches loopback
  // listeners on most stacks, so it counts as loopback here.
  if ((cls.anyLoopback || cls.anyUnspecified) && opts.daemonPort && port === opts.daemonPort) {
    return `Blocked: "${target}" (port ${port}) is the local ADF daemon control API, which is never fetchable, even with allow_local_fetch.`
  }
  // Tier 3 — own served origin: allowed unconditionally. Redundant while
  // loopback is default-open (tier 4 lets it through anyway), but kept as a
  // safety net so the agent's own origin survives any future tightening of
  // the loopback policy.
  if (
    opts.ownOrigin &&
    cls.anyLoopback &&
    port === opts.ownOrigin.port &&
    path.startsWith(opts.ownOrigin.pathPrefix)
  ) {
    return null
  }
  // Tier 4 — overridable private/LAN block. Loopback passes by default;
  // private, CGNAT, and unspecified addresses need allow_local_fetch.
  if (opts.allowLocal) return null
  if (cls.anyNonLoopbackBlocked) return overridableMessage(target)
  return null
}

/**
 * Returns a rejection reason when `rawUrl` must not be fetched, else null.
 * Hostnames are resolved and every returned address is checked, so a
 * DNS-rebinding record pointing at 127.0.0.1 is rejected too.
 *
 * `opts` defaults to `{ allowLocal: false }` so single-arg callers block all
 * private/LAN destinations (loopback is allowed by default). NOTE: single-arg
 * callers get no daemon-port tier — pass `daemonPort` to enforce it.
 */
export async function checkFetchTarget(
  rawUrl: string,
  opts: FetchGuardOptions = { allowLocal: false }
): Promise<string | null> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return `Invalid URL: ${rawUrl}`
  }
  if (!ALLOWED_FETCH_PROTOCOLS.has(url.protocol)) {
    return `Blocked by the sys_fetch guard: only http and https URLs may be fetched (got "${url.protocol}").`
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (!host) return `Invalid URL: ${rawUrl}`
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80

  const cls = await classifyHost(host)
  if (!cls) return null
  return applyPolicy(url.hostname, port, url.pathname, cls, opts, blockedMessage)
}

/**
 * Same host classification as checkFetchTarget, but accepts ws/wss (as well as
 * http/https). Returns a rejection reason when `rawUrl` must not be connected,
 * else null. ownOrigin is not consulted for ws.
 */
export async function checkConnectTarget(
  rawUrl: string,
  opts: FetchGuardOptions = { allowLocal: false }
): Promise<string | null> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return `Invalid URL: ${rawUrl}`
  }
  if (!ALLOWED_CONNECT_PROTOCOLS.has(url.protocol)) {
    return `Blocked by the ws_connect guard: only ws, wss, http and https URLs may be connected (got "${url.protocol}").`
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (!host) return `Invalid URL: ${rawUrl}`
  const secure = url.protocol === 'wss:' || url.protocol === 'https:'
  const port = url.port ? Number(url.port) : secure ? 443 : 80

  const cls = await classifyHost(host)
  if (!cls) return null
  return applyPolicy(url.hostname, port, url.pathname, cls, opts, connectBlockedMessage)
}
