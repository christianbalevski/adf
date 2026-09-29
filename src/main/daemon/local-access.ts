/**
 * "This machine only" routes: POST /identity/{create,restore,unlock,lock,
 * confirm-backup} and POST /daemon/shutdown answer local callers only, on top
 * of the bearer token.
 *
 * Local used to mean "the TCP peer is loopback". A reverse proxy on the same
 * host (nginx, Caddy, cloudflared, …) connects from loopback too, so it made
 * those routes reachable from anywhere the proxy is. Two rules, both fail
 * closed; forwarded headers can only ever take "local" away, never grant it:
 *
 *   1. A request carrying a proxy header (Forwarded, X-Forwarded-*,
 *      X-Real-IP, Via) is never local, whatever its peer address.
 *   2. Proxy mode (ADF_DAEMON_BEHIND_PROXY=1): not every proxy adds those
 *      headers (nginx does not by default), so a loopback peer is not enough.
 *      The request must also carry X-ADF-Local-Proof: a random secret the
 *      daemon writes at every start to `<settings dir>/daemon-local-proof`
 *      (`-<port>` suffix off the default port; 0600). The adf CLI and terminal app on the daemon's host read it and
 *      send it to this machine's daemon only; a caller behind the proxy cannot.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { tokensEqual } from './daemon-token'

export const LOCAL_PROOF_FILENAME = 'daemon-local-proof'
export const LOCAL_PROOF_HEADER = 'x-adf-local-proof'
export const BEHIND_PROXY_ENV = 'ADF_DAEMON_BEHIND_PROXY'

/** Headers a reverse proxy adds; their presence means "not a local caller". */
export const PROXY_HEADERS = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'via'] as const

type HeaderValue = string | string[] | undefined

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false
  return address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.')
}

export function hasProxyHeaders(headers: Record<string, HeaderValue>): boolean {
  return PROXY_HEADERS.some(name => headers[name] !== undefined)
}

export function behindProxyFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test((env[BEHIND_PROXY_ENV] ?? '').trim())
}

const DEFAULT_PORT = 7385

/**
 * `<settingsDir>/daemon-local-proof` for the default port, `-<port>` for any
 * other (like the pid file): two daemons sharing one settings dir on
 * different ports must not overwrite each other's proof.
 */
export function localProofPath(settingsDir: string, port: number = DEFAULT_PORT): string {
  return join(settingsDir, port === DEFAULT_PORT ? LOCAL_PROOF_FILENAME : `${LOCAL_PROOF_FILENAME}-${port}`)
}

/** Mint a fresh proof for this daemon run (0600); replaces any previous one. */
export function mintLocalProof(settingsDir: string, port: number = DEFAULT_PORT): { proof: string; path: string } {
  mkdirSync(settingsDir, { recursive: true })
  const proof = randomBytes(32).toString('base64url')
  const path = localProofPath(settingsDir, port)
  writeFileSync(path, `${proof}\n`, { mode: 0o600 })
  try { chmodSync(path, 0o600) } catch { /* windows */ }
  return { proof, path }
}

/** The proof of the daemon on `port` (see localProofPath), or null. */
export function readLocalProof(settingsDir: string, port: number = DEFAULT_PORT): string | null {
  try {
    const proof = readFileSync(localProofPath(settingsDir, port), 'utf-8').trim()
    return /^[A-Za-z0-9_-]{32,}$/.test(proof) ? proof : null
  } catch {
    return null
  }
}

export interface LocalAccessOptions {
  /** Proxy mode (rule 2). */
  behindProxy?: boolean
  /** The secret X-ADF-Local-Proof must match in proxy mode; null = refuse all. */
  localProof?: string | null
}

export interface LocalAccessRequest {
  remoteAddress: string | undefined
  headers: Record<string, HeaderValue>
}

/** null = local caller; else the reason it is not. */
export function localAccessRefusal(request: LocalAccessRequest, opts: LocalAccessOptions): string | null {
  if (!isLoopbackAddress(request.remoteAddress)) return 'the request did not come from this machine'
  if (hasProxyHeaders(request.headers)) return 'the request came through a proxy (forwarded headers)'
  if (opts.behindProxy) {
    const raw = request.headers[LOCAL_PROOF_HEADER]
    const presented = (Array.isArray(raw) ? raw[0] : raw)?.trim()
    if (!presented || !opts.localProof || !tokensEqual(presented, opts.localProof)) {
      return `the daemon runs behind a proxy (${BEHIND_PROXY_ENV}) and the request lacks this machine's local proof`
    }
  }
  return null
}
