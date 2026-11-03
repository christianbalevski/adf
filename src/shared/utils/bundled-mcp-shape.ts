/**
 * Whether an MCP server config has the catalog shape of a server the runtime
 * ships pre-bundled (main/services/bundled-mcp-servers.ts): its npm package,
 * no command, no args beyond the npx `-y <pkg>` prefix, and a `source` of
 * `npm:<pkg>` or `npm:<pkg>@<bundled version>`. Pure: the runtime decides
 * the launch with it and Settings labels the server with it.
 */
import type { McpServerConfig } from '../types/adf-v02.types'

export function bundledMcpServerForShape<S extends { npmPackage: string; version: string }>(
  cfg: Pick<McpServerConfig, 'npm_package' | 'command' | 'args' | 'source'>,
  servers: readonly S[] | undefined,
): S | undefined {
  const server = servers?.find((s) => s.npmPackage === cfg.npm_package)
  if (!server || cfg.command) return undefined
  let args = (cfg.args ?? []).filter(Boolean)
  if (args[0] === '-y' && args[1] === server.npmPackage) args = args.slice(2)
  if (args.length) return undefined
  const source = cfg.source
  if (source !== undefined && source !== `npm:${server.npmPackage}` && source !== `npm:${server.npmPackage}@${server.version}`) return undefined
  return server
}
