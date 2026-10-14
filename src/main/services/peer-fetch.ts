/**
 * Reads of a remote mesh peer for the fleet map's peer cards: its /health
 * state and one of its shared files. Run in a backend process, not the
 * renderer, because the mesh server sends no CORS headers. Shared by
 * Studio's MESH_PEER_AGENT_HEALTH / MESH_PEER_SHARED_FILE handlers and the
 * daemon's /network/peers routes (in remote mode the request then goes out
 * from the host that discovered the peer).
 *
 * The URL comes from a peer's directory card, so it is remote data: both
 * reads go through the shared egress guard (utils/guarded-fetch.ts) on every
 * redirect hop. Peers live on the LAN, a tailnet or a link-local network and
 * answer over http, so those targets and http are allowed; the local daemon
 * control port and the cloud metadata addresses are refused. The size cap is enforced
 * while streaming, and both reads have a time budget.
 */

import { guardedFetch } from '../utils/guarded-fetch'

/** Largest shared file the card viewer previews. */
export const PEER_SHARED_FILE_MAX_BYTES = 2_000_000
/** A /health answer is a few bytes of JSON. */
const PEER_HEALTH_MAX_BYTES = 64 * 1024
/**
 * Peers sit on the LAN, a tailnet, or an APIPA / direct-cable link
 * (169.254.x.x, fe80::/10), and answer over http. Redirects: fetch's own
 * default of 20 hops, each re-checked by the guard.
 */
const PEER_FETCH = { allowHttp: true, allowLocal: true, allowLinkLocal: true, maxRedirects: 20 } as const

/** Studio's wording for an error status (`HTTP 404`), from the guard's `HTTP 404 Not Found`. */
function httpError(error: string): string | null {
  const status = /^HTTP (\d{3})\b/.exec(error)?.[1]
  return status ? `HTTP ${status}` : null
}

/** Live health probe for a remote agent (the readout shows idle/active). 5 s budget. */
export async function probePeerHealth(healthUrl: unknown) {
  if (typeof healthUrl !== 'string' || !/^https?:\/\//.test(healthUrl)) {
    return { ok: false as const, error: 'Bad health URL' }
  }
  const res = await guardedFetch(healthUrl, { ...PEER_FETCH, maxBytes: PEER_HEALTH_MAX_BYTES, timeoutMs: 5_000 })
  if ('error' in res) return { ok: false as const, error: httpError(res.error) ?? res.error }
  try {
    const body = JSON.parse(res.bytes.toString('utf8')) as { status?: string; state?: string }
    return { ok: true as const, status: body?.status, state: body?.state }
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : 'Fetch failed' }
  }
}

/**
 * One of a remote agent's shared files. baseUrl is the agent's base
 * (<runtime>/<handle>); shared files are served at <base>/<path>
 * (mesh-server agentCatchAll). 10 s budget, 2 MB cap (the read stops at the
 * cap); binary content (a NUL byte in the first 8 KiB) comes back base64 for
 * download-only.
 */
export async function fetchPeerSharedFile(baseUrl: unknown, filePath: unknown) {
  const MAX_BYTES = PEER_SHARED_FILE_MAX_BYTES
  if (typeof baseUrl !== 'string' || !/^https?:\/\//.test(baseUrl)) {
    return { ok: false as const, error: 'Bad base URL' }
  }
  if (typeof filePath !== 'string' || filePath.includes('..') || filePath.startsWith('/')) {
    return { ok: false as const, error: 'Bad file path' }
  }
  const url = `${baseUrl.replace(/\/+$/, '')}/${filePath.split('/').map(encodeURIComponent).join('/')}`
  const res = await guardedFetch(url, { ...PEER_FETCH, maxBytes: MAX_BYTES, timeoutMs: 10_000 })
  if ('error' in res) {
    if (res.error === `exceeds ${MAX_BYTES} bytes`) return { ok: false as const, error: 'File too large to preview (>2 MB)' }
    // A refused target (daemon port, metadata address, bad redirect) reads
    // as unreachable, as a network failure does.
    return { ok: false as const, error: httpError(res.error) ?? 'Peer unreachable' }
  }
  const buf = res.bytes
  // Null byte in the head = binary; the viewer offers download-only
  const binary = buf.subarray(0, 8192).includes(0)
  return {
    ok: true as const,
    mime: res.contentType,
    size: buf.length,
    binary,
    content: binary ? buf.toString('base64') : buf.toString('utf8')
  }
}
