/**
 * An MCP server's home folder, and where its file credentials live.
 *
 * A server is identified by who owns its credentials plus its name:
 *  - app credentials (a Settings registration whose credentials are stored
 *    in the app, the default): the registration's own folder,
 *    <user data>/mcp-home/app/<name>. Every agent that attaches the server
 *    uses that one sign-in.
 *  - agent credentials (the agent's own server, or a registration set to
 *    store credentials per agent): sealed in the agent's .adf under
 *    `mcp:<name>:...` and written into a folder per agent and name before
 *    each spawn — <user data>/mcp-home/agents/<agent id>/<name> on the host.
 *
 * Only a server that declares credential files gets a folder of its own:
 * declaring them is the sign it keeps state under ~ (a Gmail token file, for
 * example), and two copies sharing one ~ would sign each other out. Every
 * other server keeps the real home on the host and the agent's home in a
 * container, so ~/.gitconfig, ~/.aws and the like keep working.
 *
 * In a container the folder is <agent home>/.mcp-home/<name>: the agent's
 * home is already its own, and names are unique within an agent.
 *
 * What moves with the folder: HOME and USERPROFILE (os.homedir() on
 * Windows). The npm cache, ~/.npmrc and the uv cache keep pointing at the
 * real ones, so npx/uvx do not download into every folder. APPDATA,
 * LOCALAPPDATA and XDG_* are not moved.
 *
 * A server's name is fixed once created: the folder and the stored
 * credentials are keyed by it, and renaming is adding a copy under the new
 * name and removing the old one.
 *
 * Electron-free.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { delimiter, join } from 'path'
import { getUserDataPath } from '../utils/user-data-path'
import type { McpServerConfig } from '../../shared/types/adf-v02.types'
import type { McpServerRegistration } from '../../shared/types/ipc.types'
import { folderCredentialStore, RUNTIME_ONLY_CREDENTIAL_STORE, type CredentialStore } from './mcp-credential-files'

/** Who owns a server's credentials: the app (one sign-in for every agent) or one agent. */
export type McpCredentialOwner = { kind: 'app' } | { kind: 'agent'; agentId: string }

type HomeCfg = Pick<McpServerConfig, 'name' | 'credential_files'>

/** App when the server is a Settings registration that stores credentials in the app; else the agent. */
export function mcpCredentialOwner(
  registration: Pick<McpServerRegistration, 'credentialStorage'> | undefined,
  agentId: string,
): McpCredentialOwner {
  return registration && (registration.credentialStorage ?? 'app') === 'app'
    ? { kind: 'app' }
    : { kind: 'agent', agentId }
}

/** Whether the server gets a home folder of its own (it declares credential files). */
export function hasOwnHome(cfg: Pick<McpServerConfig, 'credential_files'>): boolean {
  return (cfg.credential_files?.length ?? 0) > 0
}

/** Names and agent ids are path segments here: refuse anything that is not one plain, portable segment. */
function segment(value: string, what: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value)) {
    throw new Error(`${what} "${value}" cannot name an MCP server home folder (letters, digits, "_" and "-" only; not a reserved device name).`)
  }
  return value
}

/** The host folder of a server with credential files (not created). */
export function mcpOwnHostHome(name: string, owner: McpCredentialOwner): string {
  const root = join(getUserDataPath(), 'mcp-home')
  return owner.kind === 'app'
    ? join(root, 'app', segment(name, 'Server name'))
    : join(root, 'agents', segment(owner.agentId, 'Agent id'), segment(name, 'Server name'))
}

/** HOME of a host-spawned server: its own folder when it has credential files, else the real home. */
export function mcpServerHostHome(cfg: HomeCfg, owner: McpCredentialOwner): string {
  return hasOwnHome(cfg) ? mcpOwnHostHome(cfg.name, owner) : homedir()
}

/** HOME of a containerized server, given the agent's container home (containerAgentHome). */
export function mcpServerContainerHome(cfg: HomeCfg, agentHome: string): string {
  return hasOwnHome(cfg) ? `${agentHome}/.mcp-home/${segment(cfg.name, 'Server name')}` : agentHome
}

function hasEnvKey(env: Record<string, string | undefined>, key: string): boolean {
  return Object.keys(env).some((k) => k.toLowerCase() === key.toLowerCase())
}

/**
 * Linux only: a server that opens the sign-in page itself (xdg-open, or
 * $BROWSER) would start the browser with the server's HOME — a separate,
 * signed-out browser profile. This shim, first on PATH and as BROWSER, opens
 * it with the real HOME. (macOS `open` and Windows `start` hand the URL to
 * the OS, which does not use the caller's HOME.)
 */
const XDG_OPEN_SHIM = `#!/bin/sh
# ADF Studio: an MCP server runs with its own HOME; open links with the real one.
unset BROWSER
export HOME="$ADF_REAL_HOME"
export PATH="\${PATH#"\${0%/*}:"}"
exec xdg-open "$@"
`

function linuxBrowserShimEnv(base: Record<string, string | undefined>): Record<string, string> {
  if (process.platform !== 'linux') return {}
  const dir = join(getUserDataPath(), 'mcp-home', '.bin')
  const shim = join(dir, 'xdg-open')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (!existsSync(shim) || readFileSync(shim, 'utf8') !== XDG_OPEN_SHIM) writeFileSync(shim, XDG_OPEN_SHIM)
  chmodSync(shim, 0o755)
  const env: Record<string, string> = { PATH: base.PATH ? `${dir}${delimiter}${base.PATH}` : dir, ADF_REAL_HOME: homedir() }
  if (!hasEnvKey(base, 'BROWSER')) env.BROWSER = shim
  return env
}

/** HOME/USERPROFILE → `home`, plus each `keep` variable unless `base` (the env being built) already names it. */
function homeEnv(home: string, base: Record<string, string | undefined>, keep: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = { HOME: home, USERPROFILE: home }
  for (const [key, value] of Object.entries(keep)) if (!hasEnvKey(base, key)) env[key] = value
  return env
}

/**
 * Env for a host spawn of a server with credential files, merged LAST into
 * its env so config cannot point it back at the shared home. Creates the
 * folder. Empty for every other server.
 */
export function mcpHostHomeEnv(cfg: HomeCfg, owner: McpCredentialOwner, base: Record<string, string | undefined> = {}): Record<string, string> {
  if (!hasOwnHome(cfg)) return {}
  const home = mcpOwnHostHome(cfg.name, owner)
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const real = homedir()
  const keep: Record<string, string> = { npm_config_userconfig: join(real, '.npmrc') }
  // On Windows npm and uv cache under LOCALAPPDATA, which is not moved.
  if (process.platform !== 'win32') {
    keep.npm_config_cache = join(real, '.npm')
    if (!hasEnvKey(base, 'XDG_CACHE_HOME')) keep.UV_CACHE_DIR = join(real, '.cache', 'uv')
  }
  return { ...homeEnv(home, base, keep), ...linuxBrowserShimEnv(base) }
}

/** Env for a container spawn of a server with credential files (the npm cache stays under the agent home). */
export function mcpContainerHomeEnv(cfg: HomeCfg, agentHome: string, base: Record<string, string | undefined> = {}): Record<string, string> {
  if (!hasOwnHome(cfg)) return {}
  return homeEnv(mcpServerContainerHome(cfg, agentHome), base, { npm_config_cache: `${agentHome}/.npm` })
}

/**
 * The store a server's credential files are read from and captured into:
 *  - agent credentials: the agent's keystore (`agentStore`);
 *  - app credentials on the host: none — the registration's folder is the
 *    server's home, so the files are already where it runs;
 *  - app credentials in a container: the registration's host folder.
 */
export function mcpCredentialFileStore<S extends CredentialStore & { setIdentitySealed: (purpose: string, value: string) => void }>(
  cfg: HomeCfg,
  owner: McpCredentialOwner,
  agentStore: S,
  where: 'host' | 'container',
): CredentialStore & { setIdentitySealed: (purpose: string, value: string) => void } {
  if (owner.kind === 'agent') return agentStore
  if (where === 'host') return RUNTIME_ONLY_CREDENTIAL_STORE
  return folderCredentialStore(mcpOwnHostHome(cfg.name, owner))
}
