import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { RemoteHello } from '../../shared/types/remote-access.types'
import { parseDeviceToken } from '../daemon/remote-access/device-store'
import { peerName, readCapped } from './peer-text'

const FINGERPRINT = /^[A-Z2-7]{4}-[A-Z2-7]{4}$/

/** The parts of a hello body every client reads; null when it is not an ADF daemon's hello. */
function parseHello(body: Partial<Record<keyof RemoteHello, unknown>> | null): RemoteHello | null {
  if (!body || body.v !== 1 || typeof body.fingerprint !== 'string' || !FINGERPRINT.test(body.fingerprint)) return null
  const name = peerName(body.name)
  if (!name) return null
  return {
    v: 1,
    name,
    fingerprint: body.fingerprint,
    pairingOpen: body.pairingOpen === true,
    clientApiVersion: typeof body.clientApiVersion === 'number' && Number.isInteger(body.clientApiVersion) ? body.clientApiVersion : 0,
    ...(body.helloProof === 1 ? { helloProof: 1 as const } : {}),
  }
}

/**
 * GET <url>/remote/hello with a timeout (docs/design/remote-access.md §5.2):
 * null when it is not an ADF daemon with remote access on. The tailnet
 * sweep (tailnet-discovery.ts), Studio pairing and `adf pair` use it.
 *
 * Untrusted (discovery review 3): a body over 4 KB is dropped unread, the
 * fingerprint must have its shape, the name is cleaned and bounded. Nothing
 * in it is authenticated: before a token goes out, verifyHello.
 */
export async function fetchHello(url: string, fetchImpl: typeof fetch = fetch, timeoutMs = 2_500): Promise<RemoteHello | null> {
  try {
    const res = await fetchImpl(`${url.replace(/\/+$/, '')}/remote/hello`, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' })
    if (!res.ok) return null
    const text = await readCapped(res)
    if (text === null) return null
    return parseHello(JSON.parse(text) as Partial<Record<keyof RemoteHello, unknown>>)
  } catch {
    return null
  }
}

// --- the authenticated hello (remote-access.md §5.2.1) -------------------------------

/** The domain of the proof's message: a MAC for nothing else. */
export const HELLO_PROOF_DOMAIN = 'adf-remote-hello-v1'
const NONCE = /^[A-Za-z0-9_-]{43}$/
const DEVICE_ID = /^[a-z2-7]{10}$/
const MAX_ORIGIN = 300

/** 32 random bytes, base64url: one per hello. */
export function newHelloNonce(): string {
  return randomBytes(32).toString('base64url')
}

/** The origin a client dialed, as it goes into the proof; null when `raw` is not an http(s) URL. */
export function helloOrigin(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length > MAX_ORIGIN) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.origin
  } catch {
    return null
  }
}

/** The proof's query as `GET /remote/hello` takes it; null when any part is malformed. */
export function helloProofRequest(query: { nonce?: unknown; device?: unknown; origin?: unknown }): { nonce: string; device: string; origin: string } | null {
  const { nonce, device, origin } = query
  if (typeof nonce !== 'string' || !NONCE.test(nonce)) return null
  if (typeof device !== 'string' || !DEVICE_ID.test(device)) return null
  if (typeof origin !== 'string' || helloOrigin(origin) !== origin) return null
  return { nonce, device, origin }
}

/** The message the proof covers: domain, nonce, the daemon's fingerprint, the origin dialed, the device id. */
export function helloProofMessage(input: { nonce: string; fingerprint: string; origin: string; device: string }): string {
  return [HELLO_PROOF_DOMAIN, input.nonce, input.fingerprint, input.origin, input.device].join('\n')
}

/**
 * base64url(HMAC-SHA256(key, message)). The key is SHA-256 of the device
 * secret: what the daemon keeps (daemon-devices.json `secretSha256`), and
 * what the device computes from its token. Nothing without the record or
 * the token can make it.
 */
export function helloProofMac(secretSha256: Buffer, message: string): string {
  return createHmac('sha256', secretSha256).update(message, 'utf-8').digest('base64url')
}

/** What the client holds: the device id and SHA-256 of the secret of an `adfd_` token; null for any other token. */
function deviceKey(token: string): { id: string; key: Buffer } | null {
  const parsed = parseDeviceToken(token)
  return parsed ? { id: parsed.id, key: createHash('sha256').update(parsed.secret, 'utf-8').digest() } : null
}

export type HelloCheck =
  /** The daemon proved it holds this device's token: `hello` is its own. */
  | { kind: 'verified'; hello: RemoteHello }
  /** Nothing answers there as an ADF daemon with remote access on (down, off, another program). */
  | { kind: 'none' }
  /** 429: the daemon there limits hellos from this source; ask again after `retryAfterMs` (the token was not sent). */
  | { kind: 'rate_limited'; retryAfterMs: number }
  /** An answer without the proof: an older ADF, or anything that cannot make it. */
  | { kind: 'unsigned'; hello: RemoteHello }
  /** A proof that does not verify: not the computer that issued this token. */
  | { kind: 'forged'; hello: RemoteHello }
  /** The daemon there does not know this device (unauthenticated: only ever a refusal). */
  | { kind: 'unknown_device'; hello: RemoteHello }
  /** The daemon there says this device was removed (unauthenticated: only ever a refusal). */
  | { kind: 'revoked'; hello: RemoteHello }
  /** The token is not a device token (`adfd_…`): nothing can prove it. */
  | { kind: 'not_device_token' }

/**
 * The authenticated hello (remote-access.md §5.2.1): GET
 * /remote/hello?nonce=&device=&origin= at `url`, no token sent. Verified
 * only when the answer's proof is the MAC of this nonce, the fingerprint it
 * shows, this origin and this device, keyed by SHA-256 of the token's
 * secret. Every client asks it before a saved token goes out (every dial
 * and re-dial) and before a pairing is saved.
 */
export async function verifyHello(url: string, token: string, opts: { fetch?: typeof fetch; timeoutMs?: number; signal?: AbortSignal; nonce?: string } = {}): Promise<HelloCheck> {
  const device = deviceKey(token)
  if (!device) return { kind: 'not_device_token' }
  const origin = helloOrigin(url)
  if (!origin) return { kind: 'none' }
  const nonce = opts.nonce ?? newHelloNonce()
  const query = new URLSearchParams({ nonce, device: device.id, origin })
  let body: Record<string, unknown> | null
  try {
    const signals = [AbortSignal.timeout(opts.timeoutMs ?? 5_000), ...(opts.signal ? [opts.signal] : [])]
    const res = await (opts.fetch ?? fetch)(`${url.replace(/\/+$/, '')}/remote/hello?${query}`, { signal: AbortSignal.any(signals), redirect: 'manual' })
    if (res.status === 429) {
      void res.body?.cancel().catch(() => {})
      return { kind: 'rate_limited', retryAfterMs: retryAfterMs(res.headers.get('retry-after')) }
    }
    if (!res.ok) return { kind: 'none' }
    const text = await readCapped(res)
    if (text === null) return { kind: 'none' }
    body = JSON.parse(text) as Record<string, unknown> | null
  } catch {
    return { kind: 'none' }
  }
  const hello = parseHello(body)
  if (!hello || !body) return { kind: 'none' }
  if (body.helloProof !== 1 || !('proof' in body)) return { kind: 'unsigned', hello }
  if (body.device === 'revoked') return { kind: 'revoked', hello }
  if (body.device !== 'known') return { kind: 'unknown_device', hello }
  if (typeof body.proof !== 'string') return { kind: 'forged', hello }
  const expected = Buffer.from(helloProofMac(device.key, helloProofMessage({ nonce, fingerprint: hello.fingerprint, origin, device: device.id })))
  const given = Buffer.from(body.proof)
  return given.length === expected.length && timingSafeEqual(given, expected) ? { kind: 'verified', hello } : { kind: 'forged', hello }
}

/** Retry-After (seconds) as a wait: 1-60 s, 10 s when absent or unreadable. */
function retryAfterMs(header: string | null): number {
  const seconds = Number(header)
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(60, Math.max(1, Math.ceil(seconds))) * 1000 : 10_000
}

/** The sentence of a 429 to a hello, while the client waits and asks again (the token was not sent). */
export function rateLimitedSentence(name: string): string {
  return `${name} is rate-limiting connections; retrying.`
}

/** The sentence of an older ADF, which cannot prove who it is: refused, never downgraded. */
export function olderAdfSentence(name: string): string {
  return `${name} runs an older ADF; update it.`
}

/**
 * The sentence of a hello that did not verify, for `name` (the saved
 * connection) at `url`; null for `verified` and `none` (each caller says
 * those its own way). The token was not sent in any case. `rate_limited` is
 * not a refusal: the caller waits `retryAfterMs` and asks again.
 */
export function helloRefusal(check: HelloCheck, name: string, url: string): string | null {
  switch (check.kind) {
    case 'unsigned': return olderAdfSentence(name)
    case 'forged': return `${url} could not prove it is ${name}; the token was not sent.`
    case 'unknown_device': return `${name} does not know this computer's token, which was not sent; pair it again.`
    case 'revoked': return `${name} removed this computer's access; pair it again.`
    case 'not_device_token': return `${name} can prove who it is only for a device token; pair it again.`
    case 'rate_limited': return rateLimitedSentence(name)
    default: return null
  }
}

/**
 * verifyHello, waiting out a 429 (`rate_limited`) up to `retries` times for
 * the Retry-After the host named (`onWait` says so each time). For a check
 * that cannot simply be asked again later: the save after a pairing, whose
 * device the host already created.
 */
export async function verifyHelloWaiting(url: string, token: string, opts: Parameters<typeof verifyHello>[2] & { retries?: number; sleep?: (ms: number) => Promise<void>; onWait?: (retryAfterMs: number) => void } = {}): Promise<HelloCheck> {
  const { retries = 3, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)), onWait, ...verify } = opts
  let check = await verifyHello(url, token, verify)
  for (let attempt = 0; check.kind === 'rate_limited' && attempt < retries; attempt++) {
    onWait?.(check.retryAfterMs)
    await sleep(check.retryAfterMs)
    check = await verifyHello(url, token, verify)
  }
  return check
}
