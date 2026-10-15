import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { networkInterfaces } from 'node:os'

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

/** IPv4-mapped / -compatible IPv6, dotted (`::ffff:169.254.169.254`). */
const MAPPED_DOTTED = /^::(?:ffff:(?:0{1,4}:)?)?((?:\d{1,3}\.){3}\d{1,3})$/
/** The same, in the hex form the URL parser writes (`[::ffff:a9fe:a9fe]`). */
const MAPPED_HEX = /^::(?:ffff:(?:0{1,4}:)?)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/

/**
 * The IPv4 address inside an IPv4-mapped or -compatible IPv6 address, as
 * `[match, dotted]`, in either spelling; null otherwise. `new URL()` turns
 * `::ffff:169.254.169.254` into `::ffff:a9fe:a9fe`, so the hex form must
 * classify the same as the dotted one. NAT64 (`64:ff9b::/96`, RFC 6052;
 * local-use `64:ff9b:1::/48`, RFC 8215), 6to4 (`2002::/16`, RFC 3056) and
 * Teredo (`2001::/32`, RFC 4380) addresses carry an IPv4 address too and are
 * classified as it (W1-D, W4-B follow-ups): a NAT64 gateway turns
 * `64:ff9b::a9fe:a9fe` into a connection to 169.254.169.254.
 */
function mappedIPv4Match(addr: string): [string, string] | null {
  const dotted = addr.match(MAPPED_DOTTED)
  if (dotted) return [dotted[0], dotted[1]]
  const hex = addr.match(MAPPED_HEX)
  if (hex) {
    const hi = parseInt(hex[1], 16)
    const lo = parseInt(hex[2], 16)
    return [hex[0], `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`]
  }
  const embedded = translatedIPv4(addr)
  return embedded ? [addr, embedded] : null
}

/**
 * The IPv4 address of a NAT64 (64:ff9b::/96, local-use 64:ff9b:1::/48) or
 * 6to4 (2002::/16) address, or the client address of a Teredo address
 * (2001::/32), either spelling; null otherwise.
 */
function translatedIPv4(raw: string): string | null {
  let addr = raw.toLowerCase()
  // A dotted IPv4 tail (64:ff9b::169.254.169.254) as two hex groups.
  const tail = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr)
  if (tail) {
    const o = tail.slice(2, 6).map(Number)
    if (o.some((n) => n > 255)) return null
    addr = `${tail[1]}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`
  }
  if (isIP(addr) !== 6) return null
  const groups = expandIPv6(addr).split(':').map((g) => parseInt(g, 16))
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0)) return v4(groups[6], groups[7])
  // Local-use NAT64 (RFC 8215): the IPv4 address in the last 32 bits.
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups[2] === 1) return v4(groups[6], groups[7])
  if (groups[0] === 0x2002) return v4(groups[1], groups[2])
  // Teredo (RFC 4380): the client's IPv4 address, inverted, in the last 32 bits.
  if (groups[0] === 0x2001 && groups[1] === 0) return v4(groups[6] ^ 0xffff, groups[7] ^ 0xffff)
  return null
}

const ALLOWED_FETCH_PROTOCOLS = new Set(['http:', 'https:'])
const ALLOWED_CONNECT_PROTOCOLS = new Set(['ws:', 'wss:', 'http:', 'https:'])

export interface FetchGuardOptions {
  /** security.allow_local_fetch; default false. Gates private/LAN/CGNAT only — loopback is allowed by default. */
  allowLocal?: boolean
  /** Loopback daemon control-API port; ALWAYS blocked on loopback, even if allowLocal. */
  daemonPort?: number
  /** The agent's own served origin; ALLOWED even when !allowLocal. */
  ownOrigin?: { port: number; pathPrefix: string }
  /**
   * Allow link-local addresses (169.254.0.0/16, fe80::/10): APIPA and
   * direct-cable LANs, where mesh peers can live. Default false. The cloud
   * metadata addresses stay blocked either way (isCloudMetadataIp).
   */
  allowLinkLocal?: boolean
}

/** IPv4 instance-metadata and credential endpoints (see isCloudMetadataIp). */
const METADATA_IPV4 = new Set([
  '169.254.169.254', // AWS, GCP, Azure IMDS, OCI, DigitalOcean, …
  '169.254.170.2', // AWS ECS task credentials
  '169.254.170.23', // AWS EKS Pod Identity agent
  '100.100.100.200', // Alibaba Cloud metadata
  '168.63.129.16', // Azure WireServer (host agent, platform keys)
  '192.0.0.192', // Oracle Cloud (OCI) metadata
])
/** IPv6 ones, expanded: AWS IMDS and the EKS Pod Identity agent. */
const METADATA_IPV6 = new Set(['fd00:0ec2:0000:0000:0000:0000:0000:0254', 'fd00:0ec2:0000:0000:0000:0000:0000:0023'])

/**
 * Cloud instance-metadata and credential endpoints (METADATA_IPV4,
 * METADATA_IPV6; incl. IPv4-mapped, NAT64 and 6to4 forms). Never
 * fetchable, whatever the options.
 */
export function isCloudMetadataIp(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, '').split('%')[0].toLowerCase()
  const version = isIP(bare)
  if (version === 4) return METADATA_IPV4.has(bare)
  if (version === 6) {
    const mapped = mappedIPv4Match(bare)
    if (mapped) return METADATA_IPV4.has(mapped[1])
    return METADATA_IPV6.has(expandIPv6(bare))
  }
  return false
}

/** Full eight-group, four-digit form of an IPv6 address (no IPv4 tail). */
function expandIPv6(addr: string): string {
  const [head, tail] = addr.includes('::') ? addr.split('::') : [addr, '']
  const left = head ? head.split(':') : []
  const right = tail ? tail.split(':') : []
  const fill = addr.includes('::') ? Array(Math.max(0, 8 - left.length - right.length)).fill('0') : []
  return [...left, ...fill, ...right].map((g) => g.padStart(4, '0')).join(':')
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
  const mapped = mappedIPv4Match(addr)
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
    const mapped = mappedIPv4Match(addr)
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
    const mapped = mappedIPv4Match(addr)
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
  const mapped = mappedIPv4Match(bare)
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

/** Normalized form for comparing addresses: IPv4 dotted (also from mapped/NAT64/6to4 IPv6), IPv6 expanded. */
function comparableIp(ip: string): string | null {
  const bare = ip.replace(/^\[|\]$/g, '').split('%')[0].toLowerCase()
  const version = isIP(bare)
  if (version === 4) return bare
  if (version !== 6) return null
  const mapped = mappedIPv4Match(bare)
  return mapped ? mapped[1] : expandIPv6(bare)
}

const OWN_ADDRESSES_TTL_MS = 30_000
let ownAddressCache: { at: number; set: Set<string> } | null = null

/**
 * The addresses of this machine's network interfaces. A daemon bound to the
 * network (`adf daemon --host 0.0.0.0`) answers on every one of them, not
 * only on loopback (W1-D follow-up). Cached briefly: interfaces change
 * rarely, and the lookup is synchronous.
 */
export function isOwnInterfaceIp(ip: string, now = Date.now()): boolean {
  if (!ownAddressCache || now - ownAddressCache.at > OWN_ADDRESSES_TTL_MS) {
    const set = new Set<string>()
    try {
      for (const list of Object.values(networkInterfaces())) {
        for (const entry of list ?? []) {
          const c = comparableIp(entry.address)
          if (c) set.add(c)
        }
      }
    } catch { /* no interface list: loopback and unspecified still count */ }
    ownAddressCache = { at: now, set }
  }
  const c = comparableIp(ip)
  return c !== null && ownAddressCache.set.has(c)
}

/**
 * The proxy Node's fetch sends `target` through when `NODE_USE_ENV_PROXY` is
 * on, else null: `HTTPS_PROXY` (falling back to `HTTP_PROXY`) for https,
 * `HTTP_PROXY` for http, none for a host `NO_PROXY` names. NO_PROXY is read
 * as undici's EnvHttpProxyAgent reads it: `*` exempts every host; an entry
 * names an exact host, or a domain and its subdomains with a leading `.` or
 * `*.`; `host:port` limits it to that port. Other schemes (ws, wss) never go
 * through it.
 */
export function envProxyFor(target: URL | string, env: NodeJS.ProcessEnv = process.env): string | null {
  const flag = (env.NODE_USE_ENV_PROXY ?? '').trim().toLowerCase()
  if (!flag || flag === '0' || flag === 'false') return null
  let url: URL
  try { url = typeof target === 'string' ? new URL(target) : target } catch { return null }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const httpProxy = env.http_proxy || env.HTTP_PROXY || ''
  const proxy = url.protocol === 'https:' ? env.https_proxy || env.HTTPS_PROXY || httpProxy : httpProxy
  if (!proxy) return null
  const noProxy = (env.no_proxy ?? env.NO_PROXY ?? '').trim()
  if (noProxy === '*') return null
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const port = url.port || (url.protocol === 'https:' ? '443' : '80')
  for (const raw of noProxy.split(/[,\s]+/)) {
    if (!raw) continue
    const m = /^(.*?)(?::(\d+))?$/.exec(raw.toLowerCase())!
    const entryHost = m[1].replace(/^\[|\]$/g, '')
    if (m[2] && m[2] !== port) continue
    if (!/^[.*]/.test(entryHost)) {
      if (host === entryHost) return null
    } else if (host.endsWith(entryHost.replace(/^\*/, ''))) {
      return null
    }
  }
  return proxy
}

let proxySkipLogged = false

/**
 * A host name behind an env proxy (envProxyFor): the proxy looks it up, and
 * this machine may have no DNS of its own. The guard can then check neither
 * its addresses nor pin a connection to them; it leaves the name to the
 * proxy (W4-B follow-up). Literal addresses and loopback names are still
 * checked. Logged once per process.
 */
function proxiedHostName(url: URL, host: string): boolean {
  if (isIP(host) || isLoopbackHostname(host) || parseLooseIPv4(host)) return false
  const proxy = envProxyFor(url)
  if (!proxy) return false
  if (!proxySkipLogged) {
    proxySkipLogged = true
    let via = proxy
    try { via = new URL(proxy).host } catch { /* shown as given */ }
    console.log(`[Egress] NODE_USE_ENV_PROXY is on: host names are looked up by the proxy (${via}), so the egress guard checks only literal addresses and loopback names, and connections are not pinned (first: ${url.hostname})`)
  }
  return true
}

function unresolvedMessage(target: string, reason: string): string {
  return `Blocked: the address of "${target}" could not be looked up (${reason}), so the egress guard could not check it. Check the host name and the network.`
}

interface HostClass {
  anyMetadata: boolean
  anyLinkLocal: boolean
  anyLoopback: boolean
  anyUnspecified: boolean
  /** Any candidate is an address of this machine's interfaces (where a network-bound daemon listens). */
  anyOwnAddress: boolean
  /** Any candidate in a blocked class OTHER than loopback (private, CGNAT, unspecified, …). */
  anyNonLoopbackBlocked: boolean
}

/**
 * Resolve `host` to candidate IPs and classify them. A host name that does
 * not resolve answers `{ unresolved }` (W1-D follow-up): the guard cannot
 * check it, and the connection's own lookup could get another answer, so
 * the caller refuses it with the resolver's reason.
 */
async function classifyHost(host: string): Promise<HostClass | { unresolved: string }> {
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
      } catch (err) {
        return { unresolved: (err as NodeJS.ErrnoException)?.code ?? (err instanceof Error ? err.message : String(err)) }
      }
      if (candidates.length === 0) return { unresolved: 'no addresses' }
    }
  }

  return {
    anyMetadata: candidates.some(isCloudMetadataIp),
    anyLinkLocal: candidates.some(isLinkLocalIp),
    anyLoopback: loopbackHost || candidates.some(isLoopbackIp),
    anyUnspecified: candidates.some(isUnspecifiedIp),
    anyOwnAddress: candidates.some((ip) => isOwnInterfaceIp(ip)),
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
  // Tier 0 — cloud metadata / credential endpoints: never reachable.
  if (cls.anyMetadata) {
    return `Blocked: "${target}" is a link-local / cloud-metadata address, which is never fetchable (even with allow_local_fetch).`
  }
  // Tier 1 — link-local: never reachable, ignores allowLocal, unless the
  // caller opts in (allowLinkLocal: mesh peers on APIPA / direct-cable LANs).
  if (cls.anyLinkLocal && !opts.allowLinkLocal) {
    return `Blocked: "${target}" is a link-local / cloud-metadata address, which is never fetchable (even with allow_local_fetch).`
  }
  // Tier 2 — the local ADF daemon control API: never reachable, ignores
  // allowLocal. The unspecified address (0.0.0.0 / ::) reaches loopback
  // listeners on most stacks, so it counts as loopback here; so does every
  // address of this machine, where a network-bound daemon also answers.
  if ((cls.anyLoopback || cls.anyUnspecified || cls.anyOwnAddress) && opts.daemonPort && port === opts.daemonPort) {
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
  if (proxiedHostName(url, host)) return null

  const cls = await classifyHost(host)
  if ('unresolved' in cls) return unresolvedMessage(url.hostname, cls.unresolved)
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
  if ('unresolved' in cls) return unresolvedMessage(url.hostname, cls.unresolved)
  return applyPolicy(url.hostname, port, url.pathname, cls, opts, connectBlockedMessage)
}
