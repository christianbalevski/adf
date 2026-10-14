/**
 * Reads of a remote mesh peer for the fleet map's peer cards: its /health
 * state and one of its shared files. Run in a backend process, not the
 * renderer, because the mesh server sends no CORS headers. Shared by
 * Studio's MESH_PEER_AGENT_HEALTH / MESH_PEER_SHARED_FILE handlers and the
 * daemon's /network/peers routes (in remote mode the request then goes out
 * from the host that discovered the peer). Both requests time out.
 */

/** Largest shared file the card viewer previews. */
export const PEER_SHARED_FILE_MAX_BYTES = 2_000_000

/** Live health probe for a remote agent (the readout shows idle/active). 5 s timeout. */
export async function probePeerHealth(healthUrl: unknown) {
  if (typeof healthUrl !== 'string' || !/^https?:\/\//.test(healthUrl)) {
    return { ok: false as const, error: 'Bad health URL' }
  }
  try {
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(5_000) })
    if (!res.ok) return { ok: false as const, error: `HTTP ${res.status}` }
    const body = (await res.json()) as { status?: string; state?: string }
    return { ok: true as const, status: body?.status, state: body?.state }
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : 'Fetch failed' }
  }
}

/**
 * One of a remote agent's shared files. baseUrl is the agent's base
 * (<runtime>/<handle>); shared files are served at <base>/<path>
 * (mesh-server agentCatchAll). 10 s timeout, 2 MB cap; binary content
 * (a NUL byte in the first 8 KiB) comes back base64 for download-only.
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
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return { ok: false as const, error: `HTTP ${res.status}` }
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > MAX_BYTES) return { ok: false as const, error: 'File too large to preview (>2 MB)' }
    // Null byte in the head = binary; the viewer offers download-only
    const binary = buf.subarray(0, 8192).includes(0)
    return {
      ok: true as const,
      mime: res.headers.get('content-type') ?? '',
      size: buf.length,
      binary,
      content: binary ? buf.toString('base64') : buf.toString('utf8')
    }
  } catch {
    return { ok: false as const, error: 'Peer unreachable' }
  }
}
