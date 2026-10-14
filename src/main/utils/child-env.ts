/**
 * The environment a runtime hands to processes it spawns for MCP servers and
 * their auth preflights: its own, minus the variables that hold the
 * runtime's own secrets. An MCP server is third-party code; it must not read
 * the daemon's access token (which drives every route, including ones that
 * run commands) or the owner identity passphrase.
 *
 * Removed: `ADF_DAEMON_TOKEN` and `ADF_OWNER_PASSPHRASE*` (the passphrase and
 * the path of the file holding it). Kept: everything else, including the
 * non-secret daemon location variables (`ADF_DAEMON_PORT`, `ADF_DAEMON_URL`,
 * `ADF_DAEMON_SETTINGS`, …), so a server that shells out to `adf` still finds
 * a daemon on a non-default port. The other `ADF_*` variables the code reads
 * are paths, switches and display settings, not credentials.
 */

const RUNTIME_SECRET_ENV = /^(ADF_DAEMON_TOKEN|ADF_OWNER_PASSPHRASE.*)$/i

export function isRuntimeSecretEnvKey(key: string): boolean {
  return RUNTIME_SECRET_ENV.test(key)
}

export function inheritableEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || isRuntimeSecretEnvKey(key)) continue
    env[key] = value
  }
  return env
}
