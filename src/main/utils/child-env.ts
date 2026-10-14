/**
 * The environment a runtime hands to processes it spawns for MCP servers and
 * their auth preflights: its own, minus the variables that hold or locate
 * the runtime's own secrets. An MCP server is third-party code; it must not
 * read the daemon's access token (which drives every route, including ones
 * that run commands) or the owner identity passphrase.
 *
 * Removed: every `ADF_DAEMON_*` (token, local proof, bind address, port,
 * settings and pid file locations) and `ADF_OWNER_PASSPHRASE*`.
 */

const RUNTIME_SECRET_ENV = /^(ADF_DAEMON_|ADF_OWNER_PASSPHRASE)/i

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
