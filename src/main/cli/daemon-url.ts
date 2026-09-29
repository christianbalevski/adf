/** Shared by the one-shot CLI and the TUI: where the daemon is and how to reach it. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { daemonSettingsDir, readDaemonToken } from '../daemon/daemon-token'
import { readLocalProof } from '../daemon/local-access'

export const DEFAULT_DAEMON_PORT = 7385
export const DEFAULT_DAEMON_URL = `http://127.0.0.1:${DEFAULT_DAEMON_PORT}`

/** `--url` wins, then `ADF_DAEMON_URL`, then the default. Trailing slashes are dropped. */
export function resolveDaemonUrl(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  return (explicit ?? env.ADF_DAEMON_URL ?? DEFAULT_DAEMON_URL).replace(/\/+$/, '')
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
 * then (this machine's daemon) the install's token file. Without `url` only the
 * first two are consulted.
 */
export function resolveDaemonToken(explicit?: string, env: NodeJS.ProcessEnv = process.env, url?: string): string | undefined {
  const token = explicit ?? env.ADF_DAEMON_TOKEN
  if (token) return token
  return url ? localDaemonToken(url, env) : undefined
}

/** Routes the daemon answers for local callers only (local-access.ts). */
export function isLocalOnlyRoute(path: string): boolean {
  const p = path.split('?')[0]
  return p === '/daemon/shutdown' || /^\/identity\/(create|restore|unlock|lock|confirm-backup)$/.test(p)
}

/**
 * X-ADF-Local-Proof for a local-only route of this machine's daemon
 * (isLocalDaemonUrl): a daemon in proxy mode (ADF_DAEMON_BEHIND_PROXY) requires
 * it there. Never sent to another host or for any other route.
 */
export function localProofHeaders(url: string, path: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (!isLocalOnlyRoute(path) || !isLocalDaemonUrl(url, env)) return {}
  const proof = readLocalProof(daemonSettingsDir(env), loopbackPort(url) ?? DEFAULT_DAEMON_PORT)
  return proof ? { 'X-ADF-Local-Proof': proof } : {}
}
