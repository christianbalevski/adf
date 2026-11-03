/**
 * Per-instance HOME for additional instances of an MCP server
 * (McpServerRegistration.isolatedHome → the runtime-only `isolated_home` on
 * the pinned spawn config).
 *
 * A second registration of the same package would otherwise read and write
 * the first one's files: most servers keep their tokens under `~`. Giving
 * the process its own HOME (keyed by the immutable server name) is the one
 * generic lever — `~/...` credential files, the server's own token cache and
 * os.homedir() all follow it, with no per-server code.
 *
 *  - host:      <user data dir>/mcp-instances/<name>/ (getUserDataPath: the
 *               same dir Studio main and the daemon keep managed installs in)
 *  - container: <agent home>/.mcp-instances/<name>
 *
 * Isolated: HOME and USERPROFILE (os.homedir() on Windows). Not isolated:
 * APPDATA / LOCALAPPDATA / XDG_* — a server that stores state there instead
 * of under ~ shares it between instances. The npm cache keeps pointing at the
 * real one, so an npx spawn does not download into every instance folder.
 *
 * Electron-free.
 */

import { mkdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { getUserDataPath } from '../utils/user-data-path'
import { isIsolatedMcpInstance, type McpInstanceServerConfig } from '../../shared/utils/mcp-config'

/** Server names are path segments here: refuse anything that is not one plain segment. */
function instanceSegment(name: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error(`MCP server name "${name}" cannot name an instance folder (letters, digits, "_" and "-" only).`)
  }
  return name
}

/** Host folder an additional instance runs in (not created). */
export function hostMcpInstanceHome(name: string): string {
  return join(getUserDataPath(), 'mcp-instances', instanceSegment(name))
}

/** HOME of a host-spawned server: its instance folder, or the real home. */
export function mcpServerHostHome(cfg: Pick<McpInstanceServerConfig, 'name' | 'isolated_home'>): string {
  return isIsolatedMcpInstance(cfg) ? hostMcpInstanceHome(cfg.name) : homedir()
}

/** HOME of a containerized server, given the agent-scoped container home (containerAgentHome). */
export function mcpServerContainerHome(cfg: Pick<McpInstanceServerConfig, 'name' | 'isolated_home'>, agentHome: string): string {
  return isIsolatedMcpInstance(cfg) ? `${agentHome}/.mcp-instances/${instanceSegment(cfg.name)}` : agentHome
}

/**
 * The env an isolated instance's spawn must end with — applied LAST, after
 * the config env, so config env cannot point HOME back at the shared home.
 * Empty for normal servers. `base` is the env being built (an npm cache the
 * caller already set is kept).
 */
export function isolatedHomeEnv(
  cfg: Pick<McpInstanceServerConfig, 'name' | 'isolated_home'>,
  home: string,
  base: Record<string, string | undefined> = {},
  npmCache?: string,
): Record<string, string> {
  if (!isIsolatedMcpInstance(cfg)) return {}
  const env: Record<string, string> = { HOME: home, USERPROFILE: home }
  const hasCache = Object.keys(base).some((k) => k.toLowerCase() === 'npm_config_cache')
  if (!hasCache && npmCache) env.npm_config_cache = npmCache
  return env
}

/**
 * Host spawn env override: HOME/USERPROFILE → the instance folder (created),
 * npm cache → the real one (POSIX default ~/.npm; on Windows npm caches under
 * LOCALAPPDATA, which is not redirected).
 */
export function hostIsolatedHomeEnv(
  cfg: Pick<McpInstanceServerConfig, 'name' | 'isolated_home'>,
  base: Record<string, string | undefined> = {},
): Record<string, string> {
  if (!isIsolatedMcpInstance(cfg)) return {}
  const home = hostMcpInstanceHome(cfg.name)
  mkdirSync(home, { recursive: true, mode: 0o700 })
  return isolatedHomeEnv(cfg, home, base, process.platform === 'win32' ? undefined : join(homedir(), '.npm'))
}

/** Container spawn env override (the container's npm cache stays under the agent home). */
export function containerIsolatedHomeEnv(
  cfg: Pick<McpInstanceServerConfig, 'name' | 'isolated_home'>,
  agentHome: string,
  base: Record<string, string | undefined> = {},
): Record<string, string> {
  return isolatedHomeEnv(cfg, mcpServerContainerHome(cfg, agentHome), base, `${agentHome}/.npm`)
}
