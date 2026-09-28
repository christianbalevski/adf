/** Shared by the one-shot CLI and the TUI: where the daemon is and how to reach it. */

export const DEFAULT_DAEMON_URL = 'http://127.0.0.1:7385'

/** `--url` wins, then `ADF_DAEMON_URL`, then the default. Trailing slashes are dropped. */
export function resolveDaemonUrl(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  return (explicit ?? env.ADF_DAEMON_URL ?? DEFAULT_DAEMON_URL).replace(/\/+$/, '')
}

/** Bearer token for daemons bound off-loopback (`ADF_DAEMON_TOKEN`, see daemon-host). */
export function resolveDaemonToken(explicit?: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const token = explicit ?? env.ADF_DAEMON_TOKEN
  return token ? token : undefined
}
