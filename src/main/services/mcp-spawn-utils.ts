import { delimiter, isAbsolute, join } from 'path'
import { existsSync } from 'fs'
import type { McpEnvKeySchema, McpInstalledPackage, McpServerConfig } from '../../shared/types/adf-v02.types'
import { buildEnvSchemaFromKeys, buildHeaderEnvSchemaFromEntries, mcpCredentialNamespace, mcpCredentialRef } from '../../shared/utils/mcp-config'

export { buildEnvSchemaFromKeys, buildHeaderEnvSchemaFromEntries, mcpCredentialNamespace, mcpCredentialRef }

export type McpRuntime = 'npm' | 'npx' | 'uvx' | 'pip' | 'custom'

export interface ParsedSource {
  runtime: McpRuntime
  package?: string
  version?: string
}

/**
 * Parse an MCP server source string into its components.
 *
 * Examples:
 *   "npm:@scope/pkg"           → { runtime: 'npm', package: '@scope/pkg' }
 *   "uvx:mcp-server@1.2.3"    → { runtime: 'uvx', package: 'mcp-server', version: '1.2.3' }
 *   "pip:some-server"          → { runtime: 'pip', package: 'some-server' }
 *   "custom" | undefined       → { runtime: 'custom' }
 */
export function parseSource(source?: string): ParsedSource {
  if (!source) return { runtime: 'custom' }
  const colonIdx = source.indexOf(':')
  if (colonIdx === -1) return { runtime: 'custom' }

  const prefix = source.slice(0, colonIdx) as McpRuntime
  if (!['npm', 'npx', 'uvx', 'pip'].includes(prefix)) return { runtime: 'custom' }

  const rest = source.slice(colonIdx + 1)
  // Handle scoped npm packages: npm:@scope/pkg@version
  let pkg: string
  let version: string | undefined
  if (rest.startsWith('@')) {
    // Scoped: @scope/pkg@version — find the second @
    const secondAt = rest.indexOf('@', 1)
    if (secondAt !== -1) {
      pkg = rest.slice(0, secondAt)
      version = rest.slice(secondAt + 1)
    } else {
      pkg = rest
    }
  } else {
    const atIdx = rest.indexOf('@')
    if (atIdx !== -1) {
      pkg = rest.slice(0, atIdx)
      version = rest.slice(atIdx + 1)
    } else {
      pkg = rest
    }
  }

  return { runtime: prefix, package: pkg, version }
}

export interface McpSpawnConfig {
  command: string
  args: string[]
}

/**
 * win32: resolve a bare command name (npx, uvx, ...) to its real on-PATH file.
 * Resolving uvx → uvx.exe lets the SDK spawn the server directly instead of
 * through cross-spawn's cmd.exe shim (whose close orphans the real process);
 * for .cmd shims (npx) the shim is unavoidable, but the resolved path pins
 * which binary runs.  Pass-through on POSIX and for paths that are already
 * absolute or contain separators.
 */
export function resolveWindowsCommandPath(command: string): string {
  if (process.platform !== 'win32') return command
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) return command
  const exts = ['.exe', '.cmd', '.bat', '.com']
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = join(dir, command + ext)
      try {
        if (existsSync(candidate)) return candidate
      } catch { /* ignore unreadable PATH entries */ }
    }
  }
  return command
}

/** Strip a trailing @version from an npm/pypi package spec ("@scope/pkg@1.2" → "@scope/pkg"). */
function stripVersion(spec: string): string {
  const at = spec.indexOf('@', spec.startsWith('@') ? 1 : 0)
  return at === -1 ? spec : spec.slice(0, at)
}

/**
 * npx/uvx flags that are known to take no value — the only flags allowed to
 * precede the package token on the managed-install fast path.
 */
const BOOLEAN_FLAGS = new Set(['-y', '--yes', '-q', '--quiet'])

/**
 * Index of the package token for the managed-install fast path, or -1 to fall
 * through to the npx/uvx passthrough.  The first non-dash token is NOT the
 * package when it's the value of a value-taking flag (`npx -p <pkg> <cmd>`,
 * `uvx --from <pkg> <cmd>`), and equals-form flags (`npx --package=<pkg>
 * <cmd>`) make the first non-dash token the command to run, not a package.
 * Conservative rule: trust the token only when every preceding token is a
 * known boolean flag; anything else falls through to passthrough, where the
 * real npx/uvx applies its own semantics.
 */
function managedFastPathPackageIndex(args: string[]): number {
  const idx = args.findIndex((a) => !a.startsWith('-'))
  if (idx === -1) return -1
  for (let i = 0; i < idx; i++) {
    if (!BOOLEAN_FLAGS.has(args[i])) return -1
  }
  return idx
}

export interface McpSpawnDeps {
  npmResolver: {
    getInstalled(pkg: string): McpInstalledPackage | undefined
  }
  uvxResolver?: {
    getInstalled(pkg: string): McpInstalledPackage | undefined
  }
  uvBinPath?: string
}

/**
 * Resolve the command + args needed to spawn an MCP server process.
 * Handles npm (managed + npx fallback), uvx (managed + uvx fallback), and custom commands.
 * Used by both foreground IPC and background agent manager.
 */
export function resolveMcpSpawnConfig(
  serverCfg: McpServerConfig,
  deps: McpSpawnDeps
): { command?: string; args?: string[] } {
  const userArgs = (serverCfg.args ?? []).filter(Boolean)

  // --- npm packages ---
  if (serverCfg.npm_package) {
    const installed = deps.npmResolver.getInstalled(serverCfg.npm_package)
    // Strip npx/entrypoint prefixes from user args
    let cleanArgs = [...userArgs]
    if (cleanArgs[0] === '-y' && cleanArgs[1] === serverCfg.npm_package) {
      cleanArgs = cleanArgs.slice(2)
    }

    if (installed) {
      cleanArgs = cleanArgs.filter((a) => a !== installed.command)
      return { command: 'node', args: [installed.command, ...cleanArgs] }
    }
    if (!serverCfg.command) {
      return { command: resolveWindowsCommandPath('npx'), args: ['-y', serverCfg.npm_package, ...cleanArgs] }
    }
  }

  // --- uvx packages ---
  if (serverCfg.pypi_package) {
    const installed = deps.uvxResolver?.getInstalled(serverCfg.pypi_package)
    if (installed) {
      return { command: installed.command, args: [...userArgs] }
    }
    if (deps.uvBinPath) {
      return { command: deps.uvBinPath, args: ['tool', 'run', serverCfg.pypi_package, ...userArgs] }
    }
    return { command: resolveWindowsCommandPath('uvx'), args: [serverCfg.pypi_package, ...userArgs] }
  }

  // --- pip: not yet supported ---
  const parsed = parseSource(serverCfg.source)
  if (parsed.runtime === 'pip') {
    throw new Error(`pip: source not yet supported — use uvx: instead`)
  }

  // --- command: "npx" (Claude Desktop import or manual config) ---
  // Prefer the managed install when present — a direct `node <entry>` spawn
  // avoids the win32 cmd.exe shim whose close orphans the real server.
  if (serverCfg.command === 'npx') {
    const pkgIdx = managedFastPathPackageIndex(userArgs)
    if (pkgIdx !== -1) {
      const installed = deps.npmResolver.getInstalled(stripVersion(userArgs[pkgIdx]))
      if (installed) {
        return { command: 'node', args: [installed.command, ...userArgs.slice(pkgIdx + 1)] }
      }
    }
    return { command: resolveWindowsCommandPath('npx'), args: userArgs }
  }

  // --- command: "uvx" (Claude Desktop import or manual config) ---
  if (serverCfg.command === 'uvx') {
    const pkgIdx = managedFastPathPackageIndex(userArgs)
    if (pkgIdx !== -1) {
      const installed = deps.uvxResolver?.getInstalled(stripVersion(userArgs[pkgIdx]))
      // Only direct executables — skip "<uv> tool run <pkg>" fallback strings
      if (installed && !installed.command.includes(' tool run ')) {
        return { command: installed.command, args: userArgs.slice(pkgIdx + 1) }
      }
    }
    if (deps.uvBinPath) {
      return { command: deps.uvBinPath, args: ['tool', 'run', ...userArgs] }
    }
    return { command: resolveWindowsCommandPath('uvx'), args: userArgs }
  }

  return { command: serverCfg.command, args: userArgs.length ? userArgs : serverCfg.args }
}

/**
 * Collect the set of env keys this server expects to source from the agent's
 * identity keystore. Merges env_schema (scope='agent') with legacy env_keys.
 */
function agentScopedEnvKeys(serverCfg: McpServerConfig): string[] {
  const keys = new Set<string>()
  if (serverCfg.env_schema?.length) {
    for (const entry of serverCfg.env_schema) {
      if (entry.scope === 'agent' && entry.key) keys.add(entry.key)
    }
  }
  // Legacy: env_keys are treated as agent-scoped identity lookups.
  if (serverCfg.env_keys?.length) {
    for (const key of serverCfg.env_keys) keys.add(key)
  }
  return [...keys]
}

/**
 * Resolve env vars from the identity keystore for an MCP server.
 * Handles both npm_package and pypi_package credential namespaces.
 */
export function resolveMcpEnvVars(
  serverCfg: McpServerConfig,
  getDecrypted: (key: string) => string | null
): Record<string, string> {
  const keys = agentScopedEnvKeys(serverCfg)
  if (!keys.length) return {}
  const pkg = serverCfg.npm_package ?? serverCfg.pypi_package

  const resolved: Record<string, string> = {}
  for (const key of keys) {
    let val: string | null = null
    if (pkg) val = getDecrypted(`mcp:${pkg}:${key}`)
    if (!val && serverCfg.name) val = getDecrypted(`mcp:${serverCfg.name}:${key}`)
    if (val) resolved[key] = val
  }
  return resolved
}

export function resolveMcpRequestHeaders(serverCfg: McpServerConfig): Record<string, string> {
  const headers: Record<string, string> = { ...(serverCfg.headers ?? {}) }
  const env = serverCfg.env ?? {}

  if (serverCfg.bearer_token_env_var) {
    const token = env[serverCfg.bearer_token_env_var]
    if (token) headers.Authorization = `Bearer ${token}`
  }

  for (const entry of serverCfg.header_env ?? []) {
    if (!entry.header || !entry.env) continue
    const value = env[entry.env]
    if (value) headers[entry.header] = value
  }

  return headers
}

/**
 * Build an updated env_schema snapshot from the keys that were actually supplied
 * on a successful connect. Existing entries in serverCfg.env_schema are preserved
 * (user-authored metadata wins); new keys are appended with the observed scope.
 *
 * @param serverCfg       The agent's server config (may already have env_schema)
 * @param appEnvKeys      Keys sourced from the app-level registration (scope='app')
 * @param agentEnvKeys    Keys sourced from the agent's identity keystore (scope='agent')
 * @returns The merged schema, or null if nothing changed.
 */
export function captureEnvSchema(
  serverCfg: McpServerConfig,
  appEnvKeys: string[],
  agentEnvKeys: string[],
): McpEnvKeySchema[] | null {
  const existing = serverCfg.env_schema ?? []
  const known = new Set(existing.map(e => e.key))
  const additions: McpEnvKeySchema[] = []

  for (const key of appEnvKeys) {
    if (!known.has(key)) {
      additions.push({ key, scope: 'app', credential_ref: mcpCredentialRef(serverCfg, key) })
      known.add(key)
    }
  }
  for (const key of agentEnvKeys) {
    if (!known.has(key)) {
      additions.push({ key, scope: 'agent' })
      known.add(key)
    }
  }

  if (!additions.length) return null
  return [...existing, ...additions]
}
