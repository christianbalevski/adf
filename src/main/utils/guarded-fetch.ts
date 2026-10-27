/**
 * Guarded HTTPS fetch for remote *catalog* data (skill catalogs and the
 * packages they point at).
 *
 * Everything here exists because the bodies fetched by this helper are
 * attacker-influenced by construction: a catalog is a JSON document on someone
 * else's server, and the URLs inside it are chosen by whoever publishes it.
 * Four properties are therefore enforced on EVERY hop, not just the first:
 *
 * 1. **https only.** A 302 from `https://catalog.example` to `http://…` is a
 *    downgrade, not a redirect worth following.
 * 2. **The egress guard runs per hop, with `daemonPort`.** Without the port the
 *    guard's daemon tier is inert and loopback is default-open, so a redirect
 *    to `http://127.0.0.1:7385/…` would reach the unauthenticated local daemon
 *    control API. Link-local / cloud-metadata (169.254.169.254) is blocked by
 *    the guard's own always-block tier.
 * 3. **Manual redirects with a hop cap.** `redirect: 'follow'` would hand the
 *    hop decision to undici, where no guard runs at all.
 * 4. **The size cap is enforced while streaming**, plus a `content-length`
 *    precheck. A chunked response with no length header must not be buffered
 *    in full before being measured.
 *
 * 5. **The connection uses the addresses the guard checked.** The guard
 *    resolves the host, then the connection used to resolve it again: a
 *    DNS answer that changes in between (rebinding, TTL 0) reached a
 *    refused address. Each hop now connects through node:http(s) with a
 *    lookup that checks every address it answers against the same policy
 *    (W1-D follow-up).
 *
 * Headless-safe: no Electron imports. Backs the SKILLS_CATALOG_GET /
 * SKILLS_PACKAGE_GET IPC handlers, which is how Studio's catalog browser
 * reaches a remote catalog at all — the renderer's CSP blocks remote
 * origins, so every hop it makes lands here. A replaced global fetch (unit
 * tests stub it) is used as it is.
 */

import { lookup as dnsLookup } from 'node:dns/promises'
import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import type { LookupFunction } from 'node:net'
import { pipeline, Readable, type Transform } from 'node:stream'
import { constants as zlibConstants, createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import { assertSafeBrotliRuntime, brotliRuntimeVerdict, refusalMessage } from './brotli-runtime-guard'
import { checkConnectTarget, checkFetchTarget, envProxyFor, type FetchGuardOptions } from './ssrf-guard'

/** The process's own fetch, as loaded; a stub that replaced it (tests) is used without the pinned connection. */
const NATIVE_FETCH = globalThis.fetch

/**
 * A lookup for the connection that checks what it connects to: every
 * address the resolver answers must pass `check` (the guard's policy for
 * that address as a literal), else the connection fails with the guard's
 * reason.
 */
export function guardedLookup(check: (address: string) => Promise<string | null>): LookupFunction {
  return ((hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    void (async () => {
      const addresses = await dnsLookup(hostname, { all: true, verbatim: true })
      if (addresses.length === 0) throw Object.assign(new Error(`No address for ${hostname}`), { code: 'ENOTFOUND' })
      for (const entry of addresses) {
        const refusal = await check(entry.address)
        if (refusal) throw Object.assign(new Error(refusal), { code: 'EGUARD' })
      }
      return addresses
    })().then((addresses) => {
      if (options?.all) callback(null, addresses)
      else callback(null, addresses[0].address, addresses[0].family)
    }, (err) => callback(err))
  }) as unknown as LookupFunction
}

/** Statuses whose Response has no body. */
const NULL_BODY = new Set([101, 103, 204, 205, 304])

/**
 * The guard's policy for one resolved address of `target`: the URL with the
 * address as its literal host, checked as a fetch (http, https) or a
 * connect (ws, wss) target. For `guardedLookup`.
 */
export function addressCheck(target: URL, guard: FetchGuardOptions, kind: 'fetch' | 'connect' = 'fetch'): (address: string) => Promise<string | null> {
  const secure = target.protocol === 'https:' || target.protocol === 'wss:'
  const port = target.port || (secure ? '443' : '80')
  const check = kind === 'connect' ? checkConnectTarget : checkFetchTarget
  return (address) => {
    const literal = address.includes(':') ? `[${address}]` : address
    return check(`${target.protocol}//${literal}:${port}${target.pathname}`, guard)
  }
}

/** One GET over node:http(s), connecting only to addresses `guardedLookup` checked. */
function pinnedGet(url: string, signal: AbortSignal, guard: FetchGuardOptions): Promise<Response> {
  const target = new URL(url)
  const check = addressCheck(target, guard)
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise<Response>((resolve, reject) => {
    const req = send(target, { method: 'GET', signal, lookup: guardedLookup(check) }, (res: IncomingMessage) => {
      const headers = new Headers()
      for (const [name, value] of Object.entries(res.headers)) {
        if (value === undefined) continue
        for (const one of Array.isArray(value) ? value : [value]) headers.append(name, one)
      }
      const status = res.statusCode ?? 502
      if (NULL_BODY.has(status)) res.resume()
      resolve(new Response(NULL_BODY.has(status) ? null : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>), { status, headers }))
    })
    req.on('error', reject)
    req.end()
  })
}

// --- pinnedFetch ----------------------------------------------------------------

/** Statuses a fetch with `redirect: 'follow'` follows. */
const REDIRECTS = new Set([301, 302, 303, 307, 308])
/** fetch's own redirect limit. */
const MAX_FOLLOWED_REDIRECTS = 20

/**
 * Keep-alive agents per policy: a pooled socket is reused only by requests
 * under the policy whose lookup checked its address (the pool key ignores
 * the lookup).
 */
const pinnedAgents = new Map<string, HttpAgent | HttpsAgent>()
function pinnedAgent(protocol: string, guard: FetchGuardOptions): HttpAgent | HttpsAgent {
  const key = `${protocol}|${JSON.stringify(guard, Object.keys(guard).sort())}|${JSON.stringify(guard.ownOrigin ?? null)}`
  let agent = pinnedAgents.get(key)
  if (!agent) {
    agent = protocol === 'https:' ? new HttpsAgent({ keepAlive: true }) : new HttpAgent({ keepAlive: true })
    pinnedAgents.set(key, agent)
  }
  return agent
}

/** The response body as fetch delivers it: decoded per `content-encoding` (gzip, deflate, br). */
function decodedBody(res: IncomingMessage): Readable {
  const encodings = String(res.headers['content-encoding'] ?? '').toLowerCase().split(',').map((e) => e.trim()).filter(Boolean)
  const decoders: Transform[] = []
  for (const encoding of encodings.reverse()) {
    if (encoding === 'gzip' || encoding === 'x-gzip') decoders.push(createGunzip({ flush: zlibConstants.Z_SYNC_FLUSH, finishFlush: zlibConstants.Z_SYNC_FLUSH }))
    else if (encoding === 'deflate') decoders.push(createInflate({ flush: zlibConstants.Z_SYNC_FLUSH, finishFlush: zlibConstants.Z_SYNC_FLUSH }))
    else if (encoding === 'br') decoders.push(createBrotliDecompress({ flush: zlibConstants.BROTLI_OPERATION_FLUSH, finishFlush: zlibConstants.BROTLI_OPERATION_FLUSH }))
    else if (encoding !== 'identity') return res // an encoding fetch does not decode either: the bytes as sent
  }
  if (decoders.length === 0) return res
  return pipeline([res, ...decoders] as unknown as [Readable, ...Transform[]], () => { /* errors reach the last stream */ }) as unknown as Readable
}

/** The error fetch rejects with for an aborted signal. */
function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('This operation was aborted', 'AbortError')
}

/** One request over node:http(s) to an address `guardedLookup` checked; no redirect is followed. */
function pinnedRequest(url: URL, method: string, headers: Headers, body: Buffer | null, signal: AbortSignal, guard: FetchGuardOptions): Promise<Response> {
  const sent: Record<string, string> = {}
  headers.forEach((value, name) => { sent[name] = value })
  // The defaults Node's fetch sends.
  sent.accept ??= '*/*'
  sent['user-agent'] ??= 'node'
  sent['accept-encoding'] ??= 'gzip, deflate, br'
  if (body) sent['content-length'] = String(body.length)
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise<Response>((resolve, reject) => {
    // The abort is handled here, not through the request's `signal` option,
    // so a body being read fails with the signal's reason, as fetch's does.
    let res: IncomingMessage | null = null
    const onAbort = () => {
      const reason = abortReason(signal) as Error
      if (res) res.destroy(reason)
      req.destroy(reason)
    }
    const req = send(url, {
      method,
      headers: sent,
      agent: pinnedAgent(url.protocol, guard),
      lookup: guardedLookup(addressCheck(url, guard)),
    }, (incoming: IncomingMessage) => {
      res = incoming
      res.once('close', () => signal.removeEventListener('abort', onAbort))
      const responseHeaders = new Headers()
      for (const [name, value] of Object.entries(res.headers)) {
        if (value === undefined) continue
        for (const one of Array.isArray(value) ? value : [value]) responseHeaders.append(name, one)
      }
      const status = res.statusCode ?? 502
      const empty = NULL_BODY.has(status) || method === 'HEAD'
      if (empty) res.resume()
      const response = new Response(empty ? null : (Readable.toWeb(decodedBody(res)) as unknown as ReadableStream<Uint8Array>), {
        status,
        statusText: res.statusMessage ?? '',
        headers: responseHeaders,
      })
      Object.defineProperty(response, 'url', { value: url.toString() })
      resolve(response)
    })
    signal.addEventListener('abort', onAbort, { once: true })
    req.on('error', (err: NodeJS.ErrnoException) => {
      if (!res) signal.removeEventListener('abort', onAbort)
      if (signal.aborted) reject(abortReason(signal))
      // The guard refused an address the lookup answered: its sentence.
      else if (err.code === 'EGUARD') reject(new Error(err.message))
      else reject(new TypeError('fetch failed', { cause: err }))
    })
    req.end(body ?? undefined)
  })
}

/**
 * A `fetch` that connects only to addresses the egress guard checked (W4-B
 * follow-up): each hop is checked with `checkFetchTarget` (the guard's
 * sentence when refused, the resolver's code for an unknown host), then
 * sent over node:http(s) with `guardedLookup`, so the connection reaches an
 * address the guard passed, with the URL's host name as SNI and Host. A DNS
 * answer that changes between the check and the connection (rebinding, TTL
 * 0) is refused, never reached.
 *
 * Fetch semantics kept: request bodies and headers as `Request` builds
 * them, fetch's default headers, a decoded body (gzip, deflate, br), a
 * streamed body (SSE), `redirect` (`follow` re-checks every hop; `manual`
 * answers the 3xx), the abort reason. A hop that goes through an env proxy
 * (ssrf-guard envProxyFor) is checked the same way, then sent with Node's
 * fetch (the proxy connects, and resolves a name this machine cannot), one
 * hop at a time: its redirects are checked here, not followed by Node.
 * `guard` is read per call.
 */
export function pinnedFetch(guard: FetchGuardOptions | (() => FetchGuardOptions), opts: PinnedFetchOptions = {}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    // Every path decodes `br` whatever was advertised (decodedBody, or Node's
    // fetch behind a proxy), so a vulnerable decoder stops the request before
    // it is sent, not just drops br from accept-encoding.
    assertSafeBrotliRuntime()
    const policy = typeof guard === 'function' ? guard() : guard
    const request = new Request(input, init?.body != null ? { ...init, duplex: 'half' } as RequestInit : init)
    const signal = request.signal
    // An abort is honoured at every step: before each send and after every await.
    const stopIfAborted = () => { if (signal.aborted) throw abortReason(signal) }
    stopIfAborted()
    let url = new URL(request.url)
    let method = request.method
    const headers = new Headers(request.headers)
    let body: Buffer | null = request.body ? Buffer.from(await request.arrayBuffer()) : null
    for (let hop = 0; ; hop++) {
      stopIfAborted()
      // Every hop is checked first, literal addresses included, whoever connects.
      const refusal = await checkFetchTarget(url.toString(), policy)
      stopIfAborted()
      if (refusal) throw new Error(refusal)
      // Behind the env proxy the proxy connects (a name this machine could
      // not look up is the proxy's to resolve); its redirects come back here
      // and are checked as every other hop.
      const replaced = opts.useReplacedFetch && globalThis.fetch !== NATIVE_FETCH ? globalThis.fetch : null
      const viaFetch = replaced ?? (envProxyFor(url) ? NATIVE_FETCH : null)
      const response = viaFetch
        ? await viaFetch(url, { method, headers, ...(body ? { body: body as unknown as BodyInit } : {}), signal, redirect: 'manual' })
        : await pinnedRequest(url, method, headers, body, signal, policy)
      if (signal.aborted) {
        try { await response.body?.cancel() } catch { /* best effort */ }
        throw abortReason(signal)
      }
      const location = response.headers.get('location')
      if (!REDIRECTS.has(response.status) || !location || request.redirect === 'manual') return response
      try { await response.body?.cancel() } catch { /* best effort */ }
      stopIfAborted()
      if (request.redirect === 'error') throw new TypeError('fetch failed', { cause: new Error(`unexpected redirect to ${location}`) })
      if (hop >= MAX_FOLLOWED_REDIRECTS) throw new TypeError('fetch failed', { cause: new Error('redirect count exceeded') })
      const next = new URL(location, url)
      if (response.status === 303 ? method !== 'GET' && method !== 'HEAD' : (response.status === 301 || response.status === 302) && method === 'POST') {
        method = 'GET'
        body = null
        for (const name of ['content-type', 'content-length', 'content-encoding', 'content-language', 'content-location']) headers.delete(name)
      }
      // As fetch: credentials stay with the origin they were given for.
      if (next.origin !== url.origin) for (const name of ['authorization', 'proxy-authorization', 'cookie']) headers.delete(name)
      url = next
    }
  }) as typeof fetch
}

export interface PinnedFetchOptions {
  /**
   * When the global fetch was replaced (unit tests stub it), send each hop
   * through it instead of node:http(s); every hop is still checked and
   * redirects still come back to the hop loop.
   */
  useReplacedFetch?: boolean
}

/**
 * pinnedFetch for egress an agent or a file drives (sys_fetch, MCP HTTP).
 * A replaced global fetch (unit tests stub it) carries the hops, each one
 * checked (decided per hop).
 */
export function egressFetch(guard: FetchGuardOptions | (() => FetchGuardOptions)): typeof fetch {
  return pinnedFetch(guard, { useReplacedFetch: true })
}

/** Port the local daemon control API listens on when nothing overrides it. */
export const DEFAULT_DAEMON_PORT = 7385

/** Redirect hops allowed before giving up. Each one is fully re-checked. */
export const MAX_FETCH_REDIRECTS = 3

/**
 * The loopback port the egress guard must always refuse. Read from the
 * environment at call time (not module load) so a daemon started on a custom
 * port after this module was imported is still protected.
 */
export function daemonGuardPort(): number {
  return Number(process.env.ADF_DAEMON_PORT) || DEFAULT_DAEMON_PORT
}

/**
 * The egress policy of an MCP HTTP server's requests. The owner (or a file's
 * reviewed config) names the server, so loopback, LAN and link-local servers
 * are allowed; the always-blocked tiers stay: cloud metadata and the local
 * daemon control API (read per request: the daemon port can change).
 */
export const MCP_HTTP_EGRESS = (): FetchGuardOptions => ({ allowLocal: true, allowLinkLocal: true, daemonPort: daemonGuardPort() })

export interface GuardedFetchBody {
  bytes: Buffer
  contentType: string
}

export interface GuardedFetchFailure {
  error: string
}

export type GuardedFetchResult = GuardedFetchBody | GuardedFetchFailure

export interface GuardedFetchOptions {
  /** Hard ceiling on the response body. Enforced while reading, not after. */
  maxBytes: number
  /** Whole-request budget, including every redirect hop. */
  timeoutMs: number
  /** Redirect hops allowed. Defaults to MAX_FETCH_REDIRECTS. */
  maxRedirects?: number
  /**
   * Also allow plain http on every hop. Default false (catalogs are https
   * only). Mesh peers on the LAN or a tailnet answer over http.
   */
  allowHttp?: boolean
  /**
   * Allow private/LAN/CGNAT targets (the guard's allowLocal). Default false.
   * The daemon control port and link-local / cloud-metadata addresses stay
   * blocked either way.
   */
  allowLocal?: boolean
  /**
   * Allow link-local targets (169.254.0.0/16, fe80::/10). Default false.
   * Cloud metadata addresses stay blocked (ssrf-guard isCloudMetadataIp).
   */
  allowLinkLocal?: boolean
}

/** Narrow a GuardedFetchResult without repeating the `'error' in x` dance. */
export function isFetchFailure(result: GuardedFetchResult): result is GuardedFetchFailure {
  return 'error' in result
}

/** Read a response body, aborting the moment it crosses `maxBytes`. */
async function readCapped(
  response: Response,
  maxBytes: number
): Promise<Buffer | GuardedFetchFailure> {
  const body = response.body as ReadableStream<Uint8Array> | null | undefined
  if (!body) return Buffer.alloc(0)
  // Defensive: a Response without a readable stream (test double, exotic
  // polyfill) still gets the cap, just after buffering rather than during.
  if (typeof body.getReader !== 'function') {
    const bytes = Buffer.from(new Uint8Array(await response.arrayBuffer()))
    return bytes.length > maxBytes ? { error: `exceeds ${maxBytes} bytes` } : bytes
  }
  const reader = body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > maxBytes) {
      try { await reader.cancel() } catch { /* best effort */ }
      return { error: `exceeds ${maxBytes} bytes` }
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

/**
 * Fetch `url` over https with the egress guard applied to every hop.
 *
 * Returns the body, or `{ error }` with a reason safe to show an agent or a
 * human. Never throws for a network-level failure — the error is returned.
 */
export async function guardedFetch(
  url: string,
  options: GuardedFetchOptions
): Promise<GuardedFetchResult> {
  const { maxBytes, timeoutMs } = options
  const maxRedirects = options.maxRedirects ?? MAX_FETCH_REDIRECTS
  // As pinnedFetch: the response may be `br` on either path.
  const runtime = brotliRuntimeVerdict()
  if (!runtime.safe) return { error: refusalMessage(runtime) }
  const daemonPort = daemonGuardPort()

  let current: string
  try {
    current = new URL(url).toString()
  } catch {
    return { error: `invalid URL: ${String(url).slice(0, 200)}` }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    for (let hop = 0; ; hop++) {
      // https-only is re-checked here rather than once up front: hop 0 and hop
      // N must be held to the same rule, and `new URL(location, current)` can
      // land on any scheme the redirect target names.
      const protocol = new URL(current).protocol
      if (protocol !== 'https:' && !(options.allowHttp && protocol === 'http:')) {
        return { error: `only ${options.allowHttp ? 'http(s)' : 'https'} URLs may be fetched (got "${protocol}")` }
      }
      // The agent's `security.allow_local_fetch` is deliberately NOT plumbed
      // through: it is a decision about the agent's OWN fetches, not about
      // where a third-party catalog may redirect us. Callers that fetch from
      // LAN peers opt in per call (options.allowLocal).
      const guard: FetchGuardOptions = { allowLocal: options.allowLocal === true, daemonPort, ...(options.allowLinkLocal ? { allowLinkLocal: true } : {}) }
      const blocked = await checkFetchTarget(current, guard)
      if (blocked) return { error: blocked }

      // Behind an env proxy the proxy resolves the host (ssrf-guard envProxyFor): nothing to pin.
      const response = globalThis.fetch === NATIVE_FETCH && !envProxyFor(current)
        ? await pinnedGet(current, controller.signal, guard)
        : await fetch(current, { signal: controller.signal, redirect: 'manual' })
      if (response.status >= 300 && response.status <= 399) {
        const location = response.headers.get('location')
        if (!location) return { error: `redirect without a location header (HTTP ${response.status})` }
        if (hop >= maxRedirects) return { error: `too many redirects (>${maxRedirects})` }
        try { await response.body?.cancel() } catch { /* best effort */ }
        try {
          current = new URL(location, current).toString()
        } catch {
          return { error: `redirect to an unusable location: ${location.slice(0, 200)}` }
        }
        continue
      }
      if (!response.ok) return { error: `HTTP ${response.status} ${response.statusText}`.trim() }

      // Cheap precheck: a server that declares an oversized body is refused
      // before a single byte is read.
      const lengthHeader = response.headers.get('content-length')
      const declared = lengthHeader === null ? NaN : Number(lengthHeader)
      if (Number.isFinite(declared) && declared > maxBytes) {
        try { await response.body?.cancel() } catch { /* best effort */ }
        return { error: `exceeds ${maxBytes} bytes` }
      }

      const bytes = await readCapped(response, maxBytes)
      if (!Buffer.isBuffer(bytes)) return bytes
      return { bytes, contentType: response.headers.get('content-type') ?? '' }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const timedOut = err instanceof Error && err.name === 'AbortError'
    return { error: timedOut ? `request timed out after ${timeoutMs}ms` : message }
  } finally {
    clearTimeout(timer)
  }
}
