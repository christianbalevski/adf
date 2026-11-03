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
import { isAbsolute, join, resolve } from 'path'
import type { McpServerConfig } from '../../shared/types/adf-v02.types'
import { GMAIL_BUNDLED_CLIENT_NPM_PACKAGE } from '../../shared/utils/gmail-oauth-client'
import { bundledMcpServerForShape } from '../../shared/utils/bundled-mcp-shape'
import { filterBlockedEnv } from '../utils/child-env'

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
  /** An installed app (resources hold app.asar), not a dev tree on node_modules/electron. */
  packaged?: boolean
}

export function currentBundledMcpRuntime(): BundledMcpRuntime {
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath
  return {
    resourcesPath,
    execPath: process.execPath,
    electron: !!process.versions.electron,
    packaged: !!resourcesPath && existsSync(join(resourcesPath, 'app.asar')),
  }
}

const warnedMissing = new Set<string>()

/** Absolute path of a bundled server's entry file, or null when this process has none. */
export function bundledMcpServerEntry(server: BundledMcpServer, rt: BundledMcpRuntime = currentBundledMcpRuntime()): string | null {
  if (!rt.electron || !rt.resourcesPath) return null
  const entry = join(rt.resourcesPath, 'mcp-servers', server.dir, 'index.mjs')
  if (existsSync(entry)) return entry
  // An installed app should ship it: say so once, or the npx fallback is silent.
  if (rt.packaged && !warnedMissing.has(entry)) {
    warnedMissing.add(entry)
    console.warn(`[MCP] Built-in ${server.npmPackage} is missing from this installation (${entry}); running it through npx instead.`)
  }
  return null
}

/**
 * The bundled server a HOST config launches, or null. Matches only the
 * catalog shape (shared/utils/bundled-mcp-shape.ts, which the Settings label
 * uses too).
 */
export function matchBundledMcpServer(
  cfg: Pick<McpServerConfig, 'npm_package' | 'command' | 'args' | 'source'>,
): BundledMcpServer | null {
  return bundledMcpServerForShape(cfg, BUNDLED_MCP_SERVERS) ?? null
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
 * decided from the command line, never from config env. The entry must be
 * absolute: the child runs in another cwd than the one a relative path would
 * be checked against.
 */
export function isBundledMcpServerSpawn(
  command: string | undefined,
  args: readonly string[] | undefined,
  rt: BundledMcpRuntime = currentBundledMcpRuntime(),
): boolean {
  if (!command || !args?.length || !isAbsolute(args[0]) || resolve(command) !== resolve(rt.execPath)) return false
  return BUNDLED_MCP_SERVERS.some((s) => {
    const entry = bundledMcpServerEntry(s, rt)
    return !!entry && resolve(args[0]) === resolve(entry)
  })
}

/**
 * The env of a bundled-server spawn, or null for any other spawn (which keeps
 * its caller's env). Like the daemon's (buildDaemonEnv): the inherited env
 * minus what configures Electron or its Node (ELECTRON_*, NODE_OPTIONS); the
 * config env through the MCP blocklist; then ELECTRON_RUN_AS_NODE=1.
 */
export function bundledMcpSpawnEnv(
  command: string | undefined,
  args: readonly string[] | undefined,
  inherited: Record<string, string>,
  configEnv: Record<string, string>,
  rt: BundledMcpRuntime = currentBundledMcpRuntime(),
): Record<string, string> | null {
  if (!isBundledMcpServerSpawn(command, args, rt)) return null
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(inherited)) {
    if (/^ELECTRON_/i.test(key) || /^NODE_OPTIONS$/i.test(key)) continue
    env[key] = value
  }
  return { ...env, ...filterBlockedEnv(configEnv), ELECTRON_RUN_AS_NODE: '1' }
}

/** The bundled servers present in this process (MCP_REGISTRY_GET's `bundledServers`). */
export function availableBundledMcpServers(rt: BundledMcpRuntime = currentBundledMcpRuntime()): { npmPackage: string; version: string }[] {
  return BUNDLED_MCP_SERVERS.filter((s) => bundledMcpServerEntry(s, rt)).map((s) => ({ npmPackage: s.npmPackage, version: s.version }))
}
