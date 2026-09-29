/** Shared by the one-shot CLI and the TUI: where the daemon is and how to reach it. */

import { daemonSettingsDir, readDaemonToken } from '../daemon/daemon-token'

export const DEFAULT_DAEMON_URL = 'http://127.0.0.1:7385'

/** `--url` wins, then `ADF_DAEMON_URL`, then the default. Trailing slashes are dropped. */
export function resolveDaemonUrl(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  return (explicit ?? env.ADF_DAEMON_URL ?? DEFAULT_DAEMON_URL).replace(/\/+$/, '')
}

function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase()
    return host === 'localhost' || host === '::1' || /^127\./.test(host)
  } catch {
    return false
  }
}

/**
 * This machine's daemon token (`<settings dir>/daemon-token`, the directory
 * the daemon resolves from ADF_DAEMON_SETTINGS / ADF_USER_DATA_DIR), only for
 * a loopback `url`: the local token is never sent to another host.
 */
export function localDaemonToken(url: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!isLoopbackUrl(url)) return undefined
  return readDaemonToken(daemonSettingsDir(env)) ?? undefined
}

/**
 * Bearer token for the daemon at `url`: `--token`, then ADF_DAEMON_TOKEN,
 * then (loopback daemons) the install's token file. Without `url` only the
 * first two are consulted.
 */
export function resolveDaemonToken(explicit?: string, env: NodeJS.ProcessEnv = process.env, url?: string): string | undefined {
  const token = explicit ?? env.ADF_DAEMON_TOKEN
  if (token) return token
  return url ? localDaemonToken(url, env) : undefined
}
