/**
 * Routing decision: should an MCP server run in the container or on the host?
 *
 * Default: ALL MCP servers run in the shared container.
 *
 * A server runs on host ONLY when all these conditions are met:
 *   1. Server has run_location: 'host' (or legacy host_requested: true)
 *   2. Runtime has hostAccessEnabled: true  (Studio settings)
 *   3. The agent has compute.host_access, OR the server name is in the
 *      hostApproved list (Studio settings)
 *
 * Agent-level host_access already grants arbitrary host command execution
 * via compute_exec, so the per-name allowlist only gates agents without it.
 *
 * If any condition fails, the server runs in the container.
 */

import type { AgentConfig, McpServerConfig } from '../../shared/types/adf-v02.types'

export interface ComputeSettings {
  hostAccessEnabled: boolean
  hostApproved: string[]
  /**
   * name → registration source/package (e.g. "npm:@scope/pkg") recorded when
   * a Settings host install auto-approved the name. When present for a name,
   * the host grant applies only to a server whose own source/package matches —
   * a different package squatting an approved NAME stays containerized.
   * Names without an entry keep legacy name-only semantics (no migration
   * breakage for manually approved entries).
   */
  hostApprovedSources?: Record<string, string>
}

/** The comparable source identity of a server config (mirrors registration `source`). */
function serverSourceIdentity(serverConfig: McpServerConfig): string | null {
  if (serverConfig.source) return serverConfig.source
  // Fallback derivation mirrors buildMcpServerConfigFromRegistration's
  // source composition so registration-recorded values compare equal.
  if (serverConfig.npm_package) return `npm:${serverConfig.npm_package}`
  if (serverConfig.pypi_package) return `uvx:${serverConfig.pypi_package}`
  return null
}

/** Does the approved-name host grant apply to this specific server config? */
function hostApprovalMatches(
  serverName: string,
  serverConfig: McpServerConfig,
  settings: ComputeSettings
): boolean {
  if (!settings.hostApproved.includes(serverName)) return false
  const recorded = settings.hostApprovedSources?.[serverName]
  if (!recorded) return true // legacy name-only entry
  return serverSourceIdentity(serverConfig) === recorded
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
  agentConfig: AgentConfig,
  settings: ComputeSettings
): boolean {
  const location = effectiveRunLocation(serverConfig)

  // Server didn't request host access — containerize (default)
  if (location !== 'host') return true

  // Host access master toggle off — containerize
  if (!settings.hostAccessEnabled) return true

  // Agent has blanket host access — it can already run arbitrary host
  // commands via compute_exec, so the per-name allowlist adds nothing
  if (agentConfig.compute?.host_access) return false

  // Not in approved list, or the approval was recorded for a different
  // package under this name — containerize
  if (!hostApprovalMatches(serverName, serverConfig, settings)) return true

  // All conditions met — run on host
  return false
}

/**
 * Why a host-requested server is being containerized anyway.
 * Returns null when host was not requested, or when it was granted.
 */
export function hostDenialReason(
  serverName: string,
  serverConfig: McpServerConfig,
  agentConfig: AgentConfig,
  settings: ComputeSettings
): string | null {
  if (effectiveRunLocation(serverConfig) !== 'host') return null
  if (!shouldContainerize(serverName, serverConfig, agentConfig, settings)) return null
  if (!settings.hostAccessEnabled) {
    return 'host access is disabled app-wide — your principal must turn on "Enable host access" in ADF Studio → Settings → Compute, then call mcp_restart to reconnect on the host'
  }
  const recorded = settings.hostApprovedSources?.[serverName]
  if (settings.hostApproved.includes(serverName) && recorded) {
    const actual = serverSourceIdentity(serverConfig) ?? 'unknown source'
    return `"${serverName}" is host-approved for ${recorded}, but this server resolves to ${actual} — the host grant does not transfer across packages. Reinstall under a different name, or have your principal host-approve this package in ADF Studio → Settings`
  }
  return `agent lacks compute.host_access and "${serverName}" is not host-approved — either set compute.host_access to true via sys_update_config, or have your principal approve "${serverName}" in ADF Studio → Settings → Compute, then call mcp_restart`
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
