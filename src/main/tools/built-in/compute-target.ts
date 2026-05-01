/**
 * Compute target resolution — shared by compute_exec and fs_transfer.
 *
 * Determines which compute environment a tool invocation should target
 * (isolated container, shared container, or host) based on agent
 * capabilities and an optional explicit target parameter.
 */

export type ComputeTarget = 'isolated' | 'shared' | 'host'

export interface ComputeCapabilities {
  /** Agent has an isolated container (compute.enabled && podman available) */
  hasIsolated: boolean
  /** Shared container is available (podman available) */
  hasShared: boolean
  /** Host execution is allowed (compute.host_access) */
  hasHost: boolean
  /** Isolated container name (e.g. adf-{name}-{shortid}), set when hasIsolated */
  isolatedContainerName?: string
  /** Agent DID */
  agentId: string
  /**
   * Description of the host environment (OS + shell) to inject into the
   * agent-facing tool description. Only populated when BOTH the runtime's
   * host access setting AND the agent's compute.host_access are enabled —
   * otherwise host details must not leak into the agent's context.
   */
  hostInfo?: string
}

/**
 * Returns the ordered list of available targets (least → most privileged).
 */
export function availableTargets(caps: ComputeCapabilities): ComputeTarget[] {
  const targets: ComputeTarget[] = []
  if (caps.hasIsolated) targets.push('isolated')
  if (caps.hasShared) targets.push('shared')
  if (caps.hasHost) targets.push('host')
  return targets
}

/**
 * Resolve the effective target for a tool invocation.
 *
 * - If `requested` is provided, validates it against capabilities.
 * - If omitted, returns the least-privileged available target.
 * - Throws a descriptive error if no target is available or the
 *   requested target is not permitted.
 */
export function resolveTarget(
  requested: ComputeTarget | undefined,
  caps: ComputeCapabilities
): ComputeTarget {
  const available = availableTargets(caps)

  if (available.length === 0) {
    throw new Error('No compute environment available. Enable compute or configure MCP servers.')
  }

  if (requested) {
    if (!available.includes(requested)) {
      const hint =
        requested === 'isolated' ? 'Set compute.enabled to true.' :
        requested === 'host' ? 'Set compute.host_access to true.' :
        'Ensure Podman is running.'
      throw new Error(`Target '${requested}' is not available. ${hint} Available: ${available.join(', ')}.`)
    }
    return requested
  }

  // Default: least privileged (first in the ordered list)
  return available[0]
}
