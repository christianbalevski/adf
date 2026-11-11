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

/** Env vars that user-supplied MCP config must never override. */
export const BLOCKED_ENV_VARS = new Set([
  'ELECTRON_RUN_AS_NODE',
  'NODE_OPTIONS',
  'LD_PRELOAD',
  'DYLD_INSERT_LIBRARIES',
  'LD_LIBRARY_PATH',
  'DYLD_LIBRARY_PATH',
])

/** Strip security-sensitive env vars that MCP server configs must not override. */
export function filterBlockedEnv(env: Record<string, string>): Record<string, string> {
  const filtered: Record<string, string> = {}
  const blocked: string[] = []
  for (const [key, value] of Object.entries(env)) {
    if (BLOCKED_ENV_VARS.has(key)) {
      blocked.push(key)
    } else {
      filtered[key] = value
    }
  }
  if (blocked.length) {
    console.warn(`[MCP] Blocked security-sensitive env vars: ${blocked.join(', ')}`)
  }
  return filtered
}

/**
 * A leading `~/` in every env value an MCP server receives (its config env
 * and the environment it inherits alike), expanded against the HOME
 * (else USERPROFILE) of the env the server is started with: its own home
 * folder when it has one (mcp-server-home.ts), the container home in a
 * container. Servers resolve such a path themselves, mostly against their
 * cwd, not their home. Other values, `~user/…` included, are unchanged, and
 * so is everything when the env names no home.
 */
export function expandHomeInEnv(env: Record<string, string>): Record<string, string> {
  const home = env.HOME || env.USERPROFILE
  if (!home) return env
  const expanded: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) expanded[key] = value.startsWith('~/') ? `${home}/${value.slice(2)}` : value
  return expanded
}
