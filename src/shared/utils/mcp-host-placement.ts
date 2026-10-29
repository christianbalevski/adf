/**
 * Where an MCP server runs, as Studio shows it ("Runs on"): the agent's (or
 * the registration's) choice AND the runtime's approval. The rule is
 * container-routing.ts's shouldContainerize/shouldIsolate, restated here for
 * the renderer; tests/unit/utils/mcp-host-placement.test.ts holds the two
 * together. Showing it never changes it: an agent's choice is its own config,
 * and the runtime's approval (compute.hostAccessEnabled, compute.hostApproved)
 * changes only through an explicit, confirmed Allow.
 */
import type { McpServerConfig } from '../types/adf-v02.types'
import type { McpServerRegistration } from '../types/ipc.types'
import { registrationSourceIdentity } from './mcp-config'

/** The runtime's host settings (settings.compute). */
export interface RuntimeHostApproval {
  hostAccessEnabled: boolean
  hostApproved: string[]
  hostApprovedSources?: Record<string, string>
  /** The owner accepted running MCP servers on this computer (settings.compute.mcpOnHost). */
  mcpOnHost?: boolean
}

export type McpLocation = 'Isolated' | 'Shared' | 'Host'

/** What is missing before a host choice runs on the host. */
export type HostApprovalGap = 'host-access' | 'server' | null

/** The comparable source identity of an agent's server config (container-routing.ts serverSourceIdentity). */
export function serverSourceIdentity(server: McpServerConfig): string | null {
  if (server.source) return server.source
  if (server.npm_package) return `npm:${server.npm_package}`
  if (server.pypi_package) return `uvx:${server.pypi_package}`
  return null
}

function approvalMatches(name: string, source: string | null, runtime: RuntimeHostApproval): boolean {
  if (!runtime.hostApproved.includes(name)) return false
  const recorded = runtime.hostApprovedSources?.[name]
  return !recorded || recorded === source
}

/**
 * An agent's server: the location the agent chose, where it runs, and what a
 * host choice still needs (`host-access`: the runtime switch is off;
 * `server`: the agent has no compute.host_access and the server is not
 * approved for this package).
 */
export function agentServerPlacement(
  server: McpServerConfig,
  agent: { compute?: { enabled?: boolean; host_access?: boolean } },
  runtime: RuntimeHostApproval,
): { choice: McpLocation; runsOn: McpLocation; gap: HostApprovalGap } {
  const isolated = agent.compute?.enabled === true
  const location = server.run_location ?? (server.host_requested ? 'host' : undefined)
  const container: McpLocation = location === 'shared' || !isolated ? 'Shared' : 'Isolated'
  if (runtime.mcpOnHost === true && runtime.hostAccessEnabled && !isolated && location !== 'shared') {
    return { choice: location === 'host' ? 'Host' : container, runsOn: 'Host', gap: null }
  }
  if (location !== 'host') return { choice: container, runsOn: container, gap: null }
  if (!runtime.hostAccessEnabled) return { choice: 'Host', runsOn: container, gap: 'host-access' }
  if (agent.compute?.host_access) return { choice: 'Host', runsOn: 'Host', gap: null }
  if (!approvalMatches(server.name, serverSourceIdentity(server), runtime)) return { choice: 'Host', runsOn: container, gap: 'server' }
  return { choice: 'Host', runsOn: 'Host', gap: null }
}

/** A Settings → MCP registration: host only when chosen, switched on, and approved for its package. */
export function registrationPlacement(reg: McpServerRegistration, runtime: RuntimeHostApproval): { runsOnHost: boolean; gap: HostApprovalGap } {
  if (reg.type === 'http') return { runsOnHost: false, gap: null }
  if (runtime.mcpOnHost === true && runtime.hostAccessEnabled && reg.runLocation !== 'shared') return { runsOnHost: true, gap: null }
  if (reg.runLocation !== 'host') return { runsOnHost: false, gap: null }
  if (!runtime.hostAccessEnabled) return { runsOnHost: false, gap: 'host-access' }
  if (!approvalMatches(reg.name, registrationSourceIdentity(reg), runtime)) return { runsOnHost: false, gap: 'server' }
  return { runsOnHost: true, gap: null }
}

/**
 * The settings write behind Allow: the runtime switch on, and the server
 * approved for its package when the agent has no host access of its own.
 */
export function allowHostPatch(
  name: string,
  source: string | null,
  needsServerApproval: boolean,
  runtime: RuntimeHostApproval,
): { hostAccessEnabled: true; hostApproved?: string[]; hostApprovedSources?: Record<string, string> } {
  if (!needsServerApproval) return { hostAccessEnabled: true }
  const hostApproved = runtime.hostApproved.includes(name) ? runtime.hostApproved : [...runtime.hostApproved, name]
  const hostApprovedSources = { ...(runtime.hostApprovedSources ?? {}) }
  if (source) hostApprovedSources[name] = source
  else delete hostApprovedSources[name]
  return { hostAccessEnabled: true, hostApproved, hostApprovedSources }
}

/** The tooltip on Allow: what is off, and where it is. */
export function allowHostTip(gap: HostApprovalGap): string {
  return gap === 'host-access'
    ? 'Host access is off in Settings → Compute. Allow turns it on, after you confirm.'
    : 'This server is not approved for the host in Settings → Compute, and the agent has no host access. Allow approves it, after you confirm.'
}
