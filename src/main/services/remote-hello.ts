import type { RemoteHello } from '../../shared/types/remote-access.types'

/**
 * GET <url>/remote/hello with a timeout (docs/design/remote-access.md §5.2):
 * null when it is not an ADF daemon with remote access on. The tailnet
 * sweep (tailnet-discovery.ts), Studio pairing and `adf pair` use it.
 */
export async function fetchHello(url: string, fetchImpl: typeof fetch = fetch, timeoutMs = 2_500): Promise<RemoteHello | null> {
  try {
    const res = await fetchImpl(`${url.replace(/\/+$/, '')}/remote/hello`, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' })
    if (!res.ok) return null
    const body = await res.json() as Partial<RemoteHello>
    return body && body.v === 1 && typeof body.name === 'string' && typeof body.fingerprint === 'string' ? body as RemoteHello : null
  } catch {
    return null
  }
}
