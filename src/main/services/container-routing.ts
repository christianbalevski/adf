/**
 * Routing decision: should an MCP server run in the container or on the host?
 *
 * Default: ALL MCP servers run in the shared container.
 *
 * A server runs on host ONLY when all these conditions are met:
 *   1. Server has run_location: 'host' (or legacy host_requested: true)
 *   2. Runtime has hostAccessEnabled: true  (Studio settings)
 *   3. Server name is in hostApproved list  (Studio settings)
 *
 * If any condition fails, the server runs in the container.
 */

import type { AgentConfig, McpServerConfig } from '../../shared/types/adf-v02.types'

export interface ComputeSettings {
  hostAccessEnabled: boolean
  hostApproved: string[]
}

/** Resolve the effective run location for a server, considering run_location and legacy host_requested. */
function effectiveRunLocation(serverConfig: McpServerConfig): 'host' | 'shared' | undefined {
  if (serverConfig.run_location) return serverConfig.run_location
  // Legacy fallback
  if (serverConfig.host_requested) return 'host'
  return undefined
}

/**
 * Returns true if the server should run inside a container.
 * Returns false if the server should run on the host.
 */
export function shouldContainerize(
  serverName: string,
  serverConfig: McpServerConfig,
  _agentConfig: AgentConfig,
  settings: ComputeSettings
): boolean {
  const location = effectiveRunLocation(serverConfig)

  // Server didn't request host access — containerize (default)
  if (location !== 'host') return true

  // Host access master toggle off — containerize
  if (!settings.hostAccessEnabled) return true

  // Not in approved list — containerize
  if (!settings.hostApproved.includes(serverName)) return true

  // All conditions met — run on host
  return false
}

/**
 * Returns true if this agent should get its own isolated container
 * instead of the shared one.
 *
 * A per-server run_location of 'shared' overrides isolation for that server,
 * but this function only checks the agent-level flag. Callers should also
 * check isServerForceShared() for per-server overrides.
 */
export function shouldIsolate(agentConfig: AgentConfig): boolean {
  return agentConfig.compute?.enabled === true
}

/**
 * Returns true if a server explicitly requests the shared container,
 * overriding agent-level isolation.
 */
export function isServerForceShared(serverConfig: McpServerConfig): boolean {
  return effectiveRunLocation(serverConfig) === 'shared'
}
