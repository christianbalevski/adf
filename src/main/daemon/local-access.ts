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

import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { tokensEqual } from './daemon-token'
import { restrictToCurrentUserWindows } from '../utils/secret-file'

// Moved to utils/secret-file.ts (W5-D1: the other secret files use it too); re-exported for existing callers.
export { restrictToCurrentUserWindows }

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

/**
 * Mint a fresh proof for this daemon run; replaces any previous one. Readable
 * by the current user only: mode 0600 on POSIX; on Windows an explicit ACL
 * (restrictToCurrentUserWindows) set before the proof is written into the
 * file. Throws when the file cannot be protected (the caller then runs
 * without a proof: the routes that need it refuse).
 */
export function mintLocalProof(settingsDir: string, port: number = DEFAULT_PORT, platform: NodeJS.Platform = process.platform): { proof: string; path: string } {
  mkdirSync(settingsDir, { recursive: true })
  const proof = randomBytes(32).toString('base64url')
  const path = localProofPath(settingsDir, port)
  if (platform === 'win32') {
    // Protect first, write the secret after: the file never holds it under the inherited ACL.
    writeFileSync(path, '')
    try {
      restrictToCurrentUserWindows(path)
    } catch (err) {
      try { unlinkSync(path) } catch { /* gone */ }
      throw new Error(`Could not restrict ${path} to the current user (icacls): ${err instanceof Error ? err.message : String(err)}`)
    }
    writeFileSync(path, `${proof}\n`)
    return { proof, path }
  }
  writeFileSync(path, `${proof}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
  return { proof, path }
}

let proofProblem: string | null = null

/** This daemon run could not mint its proof: why (GET /version `localProof.problem`, `adf daemon status`). */
export function noteLocalProofProblem(problem: string): void {
  proofProblem = problem
}

export function localProofProblem(): string | null {
  return proofProblem
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

/**
 * Routes the daemon answers for local callers only, where a client on this
 * machine sends the local proof: owner secrets and shutdown (proof required
 * behind a proxy), owner import, trust-daemon / untrust-daemon and the
 * stored-value reveal routes, agent values and app provider keys, and the
 * remote-access management routes (proof required in every mode). A client
 * never sends the proof for another route. A device token is refused on
 * every one of them, from any address (request-guard.ts).
 */
export function isLocalOnlyRoute(path: string): boolean {
  const p = path.split('?')[0]
  return p === '/daemon/shutdown'
    || p === '/client/reload-credentials'
    || p === '/client/sessions'
    || /^\/client\/sessions\/[^/]+\/exit-when-closed$/.test(p)
    || /^\/client\/sessions\/[^/]+\/quit$/.test(p)
    || /^\/identity\/(create|restore|import|unlock|lock|confirm-backup|trust-daemon|untrust-daemon)$/.test(p)
    || /^\/agents\/[^/]+\/identity\/reveal$/.test(p)
    || p === '/files/agent/identity/reveal'
    || p === '/settings/providers/keys/reveal'
    // Remote access management (remote-access.md §4.5): device tokens, pairing, the toggle.
    || p === '/remote-access'
    || p.startsWith('/remote-access/')
}

/**
 * Routes a device token (another computer, remote-access.md §4.5) is refused
 * on by the request guard, from any address: every local-only route except
 * the client-session routes whose handlers decide per request (opening a
 * session, quitting it, its quit behaviour): those stay usable by a remote
 * client and refuse a device only where they need a local caller
 * (requireLocalCaller: stopDaemon, exitDaemonWhenClosed).
 */
export function isDeviceRefusedRoute(method: string, path: string): boolean {
  const p = path.split('?')[0]
  if (!isLocalOnlyRoute(p)) return false
  if (method === 'POST' && p === '/client/sessions') return false
  if (/^\/client\/sessions\/[^/]+\/(quit|exit-when-closed)$/.test(p)) return false
  return true
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
