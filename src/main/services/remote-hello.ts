import type { RemoteHello } from '../../shared/types/remote-access.types'
import { peerName, readCapped } from './peer-text'

const FINGERPRINT = /^[A-Z2-7]{4}-[A-Z2-7]{4}$/

/**
 * GET <url>/remote/hello with a timeout (docs/design/remote-access.md §5.2):
 * null when it is not an ADF daemon with remote access on. The tailnet
 * sweep (tailnet-discovery.ts), Studio pairing and `adf pair` use it.
 *
 * Untrusted (discovery review 3): a body over 4 KB is dropped unread, the
 * fingerprint must have its shape, the name is cleaned and bounded.
 */
export async function fetchHello(url: string, fetchImpl: typeof fetch = fetch, timeoutMs = 2_500): Promise<RemoteHello | null> {
  try {
    const res = await fetchImpl(`${url.replace(/\/+$/, '')}/remote/hello`, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' })
    if (!res.ok) return null
    const text = await readCapped(res)
    if (text === null) return null
    const body = JSON.parse(text) as Partial<Record<keyof RemoteHello, unknown>>
    if (!body || body.v !== 1 || typeof body.fingerprint !== 'string' || !FINGERPRINT.test(body.fingerprint)) return null
    const name = peerName(body.name)
    if (!name) return null
    return {
      v: 1,
      name,
      fingerprint: body.fingerprint,
      pairingOpen: body.pairingOpen === true,
      clientApiVersion: typeof body.clientApiVersion === 'number' && Number.isInteger(body.clientApiVersion) ? body.clientApiVersion : 0,
    }
  } catch {
    return null
  }
}
