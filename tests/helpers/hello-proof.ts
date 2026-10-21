/**
 * Test fakes of a remote ADF host's GET /remote/hello (docs/design/
 * remote-access.md §5.2.1): what a real daemon answers for the device
 * tokens it issued. The proof is computed exactly as the daemon does
 * (src/main/services/remote-hello.ts), from the token the fake host issued;
 * nothing in the client is bypassed.
 */
import { createHash } from 'node:crypto'
import { base32 } from '../../src/main/daemon/remote-access/config'
import { parseDeviceToken } from '../../src/main/daemon/remote-access/device-store'
import { helloProofMac, helloProofMessage, helloProofRequest } from '../../src/main/services/remote-hello'

/** A device token (`adfd_<id>_<secret>`) derived from `seed`: the same seed, the same token. */
export function deviceToken(seed: string): string {
  const id = base32(createHash('sha256').update(`id:${seed}`).digest()).slice(0, 10)
  const secret = createHash('sha256').update(`secret:${seed}`).digest('base64url')
  return `adfd_${id}_${secret}`
}

/** A fingerprint of the daemon's shape (`XXXX-XXXX`, base32 upper case) derived from `seed`. */
export function fingerprintFor(seed: string): string {
  const fp = base32(createHash('sha256').update(`fp:${seed}`).digest()).slice(0, 8).toUpperCase()
  return `${fp.slice(0, 4)}-${fp.slice(4)}`
}

export interface FakeHelloHost {
  name: string
  /** The fingerprint the hello shows. */
  fingerprint: string
  /** The device tokens this host issued (it keeps SHA-256 of each secret). */
  tokens: string[]
  /** Device ids it removed. */
  revoked?: string[]
  pairingOpen?: boolean
  /** An older ADF: no `helloProof`, the query ignored. */
  old?: boolean
}

/** The body a host answers to `url` (its query decides the proof), as the daemon's RemoteAccessService.hello does. */
export function helloBody(url: URL, host: FakeHelloHost): Record<string, unknown> {
  const base = { v: 1, name: host.name, fingerprint: host.fingerprint, pairingOpen: host.pairingOpen ?? false, clientApiVersion: 2 }
  if (host.old) return base
  const query = Object.fromEntries(url.searchParams.entries())
  const asked = 'nonce' in query || 'device' in query || 'origin' in query
  if (!asked) return { ...base, helloProof: 1 }
  const prove = helloProofRequest(query)
  if (!prove) throw new Error(`fake host ${host.name}: malformed hello query ${url.search}`)
  const token = host.tokens.find((t) => parseDeviceToken(t)?.id === prove.device)
  if (!token) return { ...base, helloProof: 1, device: host.revoked?.includes(prove.device) ? 'revoked' : 'unknown', proof: null }
  const key = createHash('sha256').update(parseDeviceToken(token)!.secret, 'utf-8').digest()
  return { ...base, helloProof: 1, device: 'known', proof: helloProofMac(key, helloProofMessage({ ...prove, fingerprint: host.fingerprint })) }
}

/** helloBody as a JSON Response. */
export function helloResponse(url: URL, host: FakeHelloHost): Response {
  return new Response(JSON.stringify(helloBody(url, host)), { status: 200, headers: { 'Content-Type': 'application/json' } })
}
