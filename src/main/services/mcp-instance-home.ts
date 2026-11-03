/**
 * Per-instance HOME for additional instances of an MCP server
 * (McpServerRegistration.isolatedHome → the runtime-only `isolated_home` on
 * the pinned spawn config, which carries the instance key).
 *
 * A second registration of the same package would otherwise read and write
 * the first one's files: most servers keep their tokens under `~`. Giving
 * the process its own HOME is the one generic lever — `~/...` credential
 * files, `~/...` args, the server's own token cache and os.homedir() all
 * follow it, with no per-server code. The folder is keyed by the instance
 * key (the registration id), so renaming or re-adding a server never picks
 * up an old folder.
 *
 *  - host:      <user data dir>/mcp-instances/<key>/ (getUserDataPath: the
 *               same dir Studio main and the daemon keep managed installs in)
 *  - container: <agent home>/.mcp-instances/<key>
 *
 * Isolated: HOME and USERPROFILE (os.homedir() on Windows). Not isolated:
 * APPDATA / LOCALAPPDATA / XDG_* — a server that stores state there instead
 * of under ~ shares it between instances. The npm cache, ~/.npmrc and the uv
 * cache keep pointing at the real ones, so npx/uvx behave as for the first
 * instance and do not download into every instance folder.
 *
 * Electron-free.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { delimiter, join } from 'path'
import { getUserDataPath } from '../utils/user-data-path'
import { mcpInstanceKey, type McpInstanceServerConfig } from '../../shared/utils/mcp-config'

type InstanceCfg = Pick<McpInstanceServerConfig, 'name' | 'isolated_home'>

/** Instance keys are path segments here: refuse anything that is not one plain, portable segment. */
function instanceSegment(key: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(key) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(key)) {
    throw new Error(`"${key}" cannot name an MCP instance folder (letters, digits, "_" and "-" only; not a reserved device name).`)
  }
  return key
}

/** Host folder an additional instance runs in (not created), by instance key. */
export function hostMcpInstanceHome(key: string): string {
  return join(getUserDataPath(), 'mcp-instances', instanceSegment(key))
}

/** HOME of a host-spawned server: its instance folder, or the real home. */
export function mcpServerHostHome(cfg: InstanceCfg): string {
  const key = mcpInstanceKey(cfg)
  return key ? hostMcpInstanceHome(key) : homedir()
}

/** HOME of a containerized server, given the agent-scoped container home (containerAgentHome). */
export function mcpServerContainerHome(cfg: InstanceCfg, agentHome: string): string {
  const key = mcpInstanceKey(cfg)
  return key ? `${agentHome}/.mcp-instances/${instanceSegment(key)}` : agentHome
}

function hasEnvKey(env: Record<string, string | undefined>, key: string): boolean {
  return Object.keys(env).some((k) => k.toLowerCase() === key.toLowerCase())
}

/**
 * HOME/USERPROFILE → `home`, plus each `keep` variable (a real location the
 * instance HOME would otherwise hide) unless `base` — the env being built —
 * already names it.
 */
function isolatedHomeEnv(home: string, base: Record<string, string | undefined>, keep: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = { HOME: home, USERPROFILE: home }
  for (const [key, value] of Object.entries(keep)) if (!hasEnvKey(base, key)) env[key] = value
  return env
}

/**
 * Linux only: a server that opens the sign-in page itself (xdg-open, or
 * $BROWSER) would start the browser with the instance HOME — a separate,
 * signed-out browser profile. This shim, first on PATH and as BROWSER, opens
 * it with the real HOME. (macOS `open` and Windows `start` hand the URL to
 * the OS, which does not use the caller's HOME.)
 */
const XDG_OPEN_SHIM = `#!/bin/sh
# ADF Studio: an MCP server instance runs with its own HOME; open links with the real one.
unset BROWSER
export HOME="$ADF_REAL_HOME"
export PATH="\${PATH#"\${0%/*}:"}"
exec xdg-open "$@"
`

function linuxBrowserShimEnv(base: Record<string, string | undefined>): Record<string, string> {
  if (process.platform !== 'linux') return {}
  const dir = join(getUserDataPath(), 'mcp-instances', '.bin')
  const shim = join(dir, 'xdg-open')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (!existsSync(shim) || readFileSync(shim, 'utf8') !== XDG_OPEN_SHIM) writeFileSync(shim, XDG_OPEN_SHIM)
  chmodSync(shim, 0o755)
  const env: Record<string, string> = { PATH: base.PATH ? `${dir}${delimiter}${base.PATH}` : dir, ADF_REAL_HOME: homedir() }
  if (!hasEnvKey(base, 'BROWSER')) env.BROWSER = shim
  return env
}

/**
 * Host spawn env override, applied LAST (after the config env, so it cannot
 * point HOME back at the shared home). Empty for normal servers.
 * HOME/USERPROFILE → the instance folder (created); ~/.npmrc, the npm cache
 * and the uv cache → the real ones unless `base` sets them (on Windows npm
 * and uv cache under LOCALAPPDATA, which is not redirected); on Linux the
 * browser shim above.
 */
export function hostIsolatedHomeEnv(cfg: InstanceCfg, base: Record<string, string | undefined> = {}): Record<string, string> {
  if (!mcpInstanceKey(cfg)) return {}
  const home = mcpServerHostHome(cfg)
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const real = homedir()
  const keep: Record<string, string> = { npm_config_userconfig: join(real, '.npmrc') }
  if (process.platform !== 'win32') {
    keep.npm_config_cache = join(real, '.npm')
    if (!hasEnvKey(base, 'XDG_CACHE_HOME')) keep.UV_CACHE_DIR = join(real, '.cache', 'uv')
  }
  return { ...isolatedHomeEnv(home, base, keep), ...linuxBrowserShimEnv(base) }
}

/** Container spawn env override (the container's npm cache stays under the agent home). */
export function containerIsolatedHomeEnv(cfg: InstanceCfg, agentHome: string, base: Record<string, string | undefined> = {}): Record<string, string> {
  if (!mcpInstanceKey(cfg)) return {}
  return isolatedHomeEnv(mcpServerContainerHome(cfg, agentHome), base, { npm_config_cache: `${agentHome}/.npm` })
}
