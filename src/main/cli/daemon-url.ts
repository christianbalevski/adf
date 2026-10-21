/** Shared by the one-shot CLI and the TUI: where the daemon is and how to reach it. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { daemonSettingsDir, readDaemonToken } from '../daemon/daemon-token'
import { isLocalOnlyRoute, readLocalProof } from '../daemon/local-access'
import type { DaemonCredentials } from '../../shared/daemon-client/client'
import { pinnedRemoteRefusal, savedRemoteFor, savedRemoteToken, selectedRemote } from './remotes'

export const DEFAULT_DAEMON_PORT = 7385
export const DEFAULT_DAEMON_URL = `http://127.0.0.1:${DEFAULT_DAEMON_PORT}`

/**
 * `--url` wins, then `ADF_DAEMON_URL`, then the remote `--remote` /
 * ADF_REMOTE names or the default saved remote (remotes.ts, `adf pair`),
 * then this machine's daemon. Trailing slashes are dropped.
 */
export function resolveDaemonUrl(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  return (explicit ?? env.ADF_DAEMON_URL ?? selectedRemote(env)?.remote.url ?? DEFAULT_DAEMON_URL).replace(/\/+$/, '')
}

/** The port of a loopback `url` (127.x, localhost, [::1]); null for any other host. */
export function loopbackPort(url: string): number | null {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    if (!(host === 'localhost' || host === '::1' || /^127\./.test(host))) return null
    return parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80
  } catch {
    return null
  }
}

function pidFileAlive(file: string): boolean {
  try {
    const raw = readFileSync(file, 'utf-8').trim()
    const pid = raw.startsWith('{') ? (JSON.parse(raw) as { pid?: unknown }).pid : Number.parseInt(raw, 10)
    if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) return false
    try { process.kill(pid, 0); return true } catch (err) { return (err as NodeJS.ErrnoException)?.code === 'EPERM' }
  } catch {
    return false
  }
}

/**
 * `url` is this machine's own daemon: loopback on the default port, on
 * ADF_DAEMON_PORT, or on a port an adf-started daemon (foreground or
 * background) holds a live pid file for in the settings dir. Any other
 * loopback port is presumably forwarded (ssh -L) to a daemon elsewhere: it
 * gets no auto-start and never this machine's token.
 */
export function isLocalDaemonUrl(url: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const port = loopbackPort(url)
  if (port === null) return false
  if (port === DEFAULT_DAEMON_PORT || port === Number(env.ADF_DAEMON_PORT)) return true
  return pidFileAlive(join(daemonSettingsDir(env), `adf-daemon-${port}.pid`))
}

/**
 * This machine's daemon token (`<settings dir>/daemon-token`, the directory
 * the daemon resolves from ADF_DAEMON_SETTINGS / ADF_USER_DATA_DIR), only for
 * this machine's daemon (isLocalDaemonUrl): the local token is never sent to
 * another host, nor through a tunnel to one.
 */
export function localDaemonToken(url: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!isLocalDaemonUrl(url, env)) return undefined
  return readDaemonToken(daemonSettingsDir(env)) ?? undefined
}

/** Extra advice for a 401 from a forwarded loopback port without a token; null otherwise. */
export function tunnelTokenHint(url: string, explicit?: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (explicit || env.ADF_DAEMON_TOKEN) return null
  if (loopbackPort(url) === null || isLocalDaemonUrl(url, env)) return null
  return `${url} is not this machine's daemon port (${Number(env.ADF_DAEMON_PORT) || DEFAULT_DAEMON_PORT}; e.g. an SSH tunnel), so the local token is not sent there. ` +
    'Pass --token or set ADF_DAEMON_TOKEN to the remote daemon\'s token (print it on that host with: adf daemon token).'
}

/**
 * Bearer token for the daemon at `url`: `--token`, then ADF_DAEMON_TOKEN,
 * then the device token saved for that origin by `adf pair` (remotes.ts),
 * then (this machine's daemon) the install's token file. Without `url` only
 * the first two are consulted.
 */
export function resolveDaemonToken(explicit?: string, env: NodeJS.ProcessEnv = process.env, url?: string): string | undefined {
  const token = explicit ?? env.ADF_DAEMON_TOKEN
  if (token) return token
  if (!url) return undefined
  return savedRemoteToken(url, env) ?? localDaemonToken(url, env)
}

/** Routes that take this machine's local proof (local-access.ts). */
export { isLocalOnlyRoute }

/**
 * X-ADF-Local-Proof for a local-only route of this machine's daemon
 * (isLocalDaemonUrl): a daemon in proxy mode (ADF_DAEMON_BEHIND_PROXY) requires
 * it there, and POST /identity/import requires it in every mode. Never sent to
 * another host or for any other route.
 */
export function localProofHeaders(url: string, path: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (!isLocalOnlyRoute(path) || !isLocalDaemonUrl(url, env)) return {}
  const proof = readLocalProof(daemonSettingsDir(env), loopbackPort(url) ?? DEFAULT_DAEMON_PORT)
  return proof ? { 'X-ADF-Local-Proof': proof } : {}
}

export interface NodeCredentialOptions {
  /** `--token`: used as is, never re-read. */
  token?: string
  /**
   * With no token given: read this machine's daemon token file (this
   * machine's daemon only; isLocalDaemonUrl), re-read it on a 401, and send
   * the local proof on local-only routes. The terminal app sets it; tests
   * leave it off so they never read real user files.
   */
  localToken?: boolean
  /** Environment for the lookup. Defaults to process.env. */
  env?: NodeJS.ProcessEnv
  /** For the authenticated hello of a saved remote (pinnedRemoteRefusal). Defaults to fetch. */
  fetch?: typeof fetch
}

/**
 * The shared client's credentials for the daemon at `url`, the Node way:
 * `token`, then ADF_DAEMON_TOKEN, then (with `localToken`) the token file of
 * this machine's daemon. Everything is resolved for `url` alone; the client
 * sends it only to `url`'s origin.
 */
export function daemonCredentials(url: string, options: NodeCredentialOptions = {}): DaemonCredentials {
  const env = options.env ?? process.env
  let token = resolveDaemonToken(options.token, env, options.localToken ? url : undefined)
  // A saved remote's device token (no --token, no ADF_DAEMON_TOKEN): it goes only after the daemon at `url` proved,
  // by the authenticated hello, that it is the paired computer (pinnedRemoteRefusal), at the first connection and
  // again after every failed or dropped one (a re-dial may reach another host at that address).
  const pinned = !!options.localToken && !options.token && !env.ADF_DAEMON_TOKEN && savedRemoteFor(url, env) !== null
  const fetchImpl = options.fetch ?? fetch
  let proved: Promise<void> | null = null
  const ready = (): Promise<void> => {
    proved ??= pinnedRemoteRefusal(url, env, fetchImpl).then((refusal) => { if (refusal) throw new Error(refusal) })
    const check = proved
    return check.catch((err: unknown) => {
      // Refused or not answered: the next connection checks again.
      if (proved === check) proved = null
      throw err
    })
  }
  return {
    token: () => token,
    ...(pinned ? { ready, dropped: () => { proved = null } } : {}),
    // The daemon answered 401: pick up a token file that appeared or changed
    // since (daemon first start). localDaemonToken is null for any URL that is
    // not this machine's daemon, so a remote URL never gets the local token.
    refresh: () => {
      if (!options.localToken || options.token || env.ADF_DAEMON_TOKEN) return false
      const fresh = localDaemonToken(url, env)
      if (!fresh || fresh === token) return false
      token = fresh
      return true
    },
    localProof: path => (options.localToken ? localProofHeaders(url, path, env) : {}),
  }
}
