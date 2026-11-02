/**
 * MCP servers ADF Studio ships pre-bundled (scripts/bundle-mcp-servers.mjs →
 * <resources>/mcp-servers/, outside the asar). A host server that matches one
 * runs on Studio's own executable in Node mode — `process.execPath` with
 * ELECTRON_RUN_AS_NODE=1 — so it needs no system Node.js, npm or npx. This
 * holds in Studio main, in the daemon Studio spawns (itself Studio's
 * executable in Node mode) and in the background agent manager.
 *
 * Today only the Gmail catalog server, at the exact version package.json
 * pins. Anything else, or a config whose executable identity was edited
 * (command, args, package, a different version), keeps the npm/npx path; so
 * does every process without the bundled file (dev trees, the npm-distributed
 * daemon on plain Node, tests). Containers are unaffected: they never resolve
 * through here (container-command-resolver.ts).
 */

import { existsSync } from 'fs'
import { dirname, join, resolve } from 'path'
import type { McpInstalledPackage, McpServerConfig } from '../../shared/types/adf-v02.types'
import { GMAIL_BUNDLED_CLIENT_NPM_PACKAGE } from '../../shared/utils/gmail-oauth-client'

export interface BundledMcpServer {
  npmPackage: string
  /** Exact version bundled; must equal the package.json devDependencies pin. */
  version: string
  /** Folder under <resources>/mcp-servers/. */
  dir: string
}

export const BUNDLED_MCP_SERVERS: readonly BundledMcpServer[] = [
  { npmPackage: GMAIL_BUNDLED_CLIENT_NPM_PACKAGE, version: '1.1.11', dir: 'gmail' },
]

/** The process facts resolution depends on (the live process by default). */
export interface BundledMcpRuntime {
  /** Electron's resources directory; undefined on plain Node. */
  resourcesPath?: string
  execPath: string
  /** Running on an Electron binary (main process or ELECTRON_RUN_AS_NODE). */
  electron: boolean
}

export function currentBundledMcpRuntime(): BundledMcpRuntime {
  return {
    resourcesPath: (process as { resourcesPath?: string }).resourcesPath,
    execPath: process.execPath,
    electron: !!process.versions.electron,
  }
}

/** Absolute path of a bundled server's entry file, or null when this process has none. */
export function bundledMcpServerEntry(server: BundledMcpServer, rt: BundledMcpRuntime = currentBundledMcpRuntime()): string | null {
  if (!rt.electron || !rt.resourcesPath) return null
  const entry = join(rt.resourcesPath, 'mcp-servers', server.dir, 'index.mjs')
  return existsSync(entry) ? entry : null
}

/**
 * The bundled server a HOST config launches, or null. Matches only the
 * catalog shape: the package, no command, no args beyond the `-y <pkg>` npx
 * prefix, and a `source` of `npm:<pkg>` (or `npm:<pkg>@<bundled version>`).
 */
export function matchBundledMcpServer(
  cfg: Pick<McpServerConfig, 'npm_package' | 'command' | 'args' | 'source'>,
): BundledMcpServer | null {
  const server = BUNDLED_MCP_SERVERS.find((s) => s.npmPackage === cfg.npm_package)
  if (!server || cfg.command) return null
  let args = (cfg.args ?? []).filter(Boolean)
  if (args[0] === '-y' && args[1] === server.npmPackage) args = args.slice(2)
  if (args.length) return null
  const source = cfg.source
  if (source !== undefined && source !== `npm:${server.npmPackage}` && source !== `npm:${server.npmPackage}@${server.version}`) return null
  return server
}

export interface BundledMcpSpawn {
  command: string
  args: string[]
  server: BundledMcpServer
}

/** Studio's executable + the bundled entry for a matching host config, or null (npm/npx path). */
export function resolveBundledMcpSpawn(
  cfg: Pick<McpServerConfig, 'npm_package' | 'command' | 'args' | 'source'>,
  rt: BundledMcpRuntime = currentBundledMcpRuntime(),
): BundledMcpSpawn | null {
  const server = matchBundledMcpServer(cfg)
  const entry = server && bundledMcpServerEntry(server, rt)
  return server && entry ? { command: rt.execPath, args: [entry], server } : null
}

/**
 * Whether a resolved host spawn is Studio's executable running one of its
 * own bundled server files. The one case that gets ELECTRON_RUN_AS_NODE=1
 * (which MCP configs may otherwise never set, see mcp-client-manager.ts):
 * decided from the command line, never from config env.
 */
export function isBundledMcpServerSpawn(
  command: string | undefined,
  args: readonly string[] | undefined,
  rt: BundledMcpRuntime = currentBundledMcpRuntime(),
): boolean {
  if (!command || !args?.length || resolve(command) !== resolve(rt.execPath)) return false
  return BUNDLED_MCP_SERVERS.some((s) => {
    const entry = bundledMcpServerEntry(s, rt)
    return !!entry && resolve(args[0]) === resolve(entry)
  })
}

/** The env a bundled-server spawn adds on top of the filtered server env. */
export function bundledMcpServerEnv(
  command: string | undefined,
  args: readonly string[] | undefined,
  rt: BundledMcpRuntime = currentBundledMcpRuntime(),
): Record<string, string> {
  return isBundledMcpServerSpawn(command, args, rt) ? { ELECTRON_RUN_AS_NODE: '1' } : {}
}

/** The bundled servers present in this process (MCP_REGISTRY_GET's `bundledServers`). */
export function availableBundledMcpServers(rt: BundledMcpRuntime = currentBundledMcpRuntime()): { npmPackage: string; version: string }[] {
  return BUNDLED_MCP_SERVERS.filter((s) => bundledMcpServerEntry(s, rt)).map((s) => ({ npmPackage: s.npmPackage, version: s.version }))
}

/**
 * What a managed install of `spec` resolves to when this app ships it (no
 * npm run, nothing written to the install manifest), or null. `spec` is the
 * bare package or `<pkg>@<bundled version>`.
 */
export function bundledMcpInstall(spec: string, rt: BundledMcpRuntime = currentBundledMcpRuntime()): McpInstalledPackage | null {
  const server = BUNDLED_MCP_SERVERS.find((s) => spec === s.npmPackage || spec === `${s.npmPackage}@${s.version}`)
  const entry = server && bundledMcpServerEntry(server, rt)
  if (!server || !entry) return null
  return { package: server.npmPackage, version: server.version, command: entry, installPath: dirname(entry), installedAt: Date.now() }
}
