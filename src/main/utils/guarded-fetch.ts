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
 * Headless-safe: no Electron imports, plain global fetch. Backs the
 * SKILLS_CATALOG_GET / SKILLS_PACKAGE_GET IPC handlers, which is how Studio's
 * catalog browser reaches a remote catalog at all — the renderer's CSP blocks
 * remote origins, so every hop it makes lands here.
 */

import { checkFetchTarget } from './ssrf-guard'

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
      if (protocol !== 'https:') {
        return { error: `only https URLs may be fetched (got "${protocol}")` }
      }
      // allowLocal is deliberately NOT plumbed through: `security.
      // allow_local_fetch` is a decision about the agent's OWN fetches, not
      // about where a third-party catalog may redirect us.
      const blocked = await checkFetchTarget(current, { allowLocal: false, daemonPort })
      if (blocked) return { error: blocked }

      const response = await fetch(current, { signal: controller.signal, redirect: 'manual' })
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
