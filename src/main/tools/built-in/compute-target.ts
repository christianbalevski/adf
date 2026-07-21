/**
 * Compute target resolution — shared by compute_exec and fs_transfer.
 *
 * Determines which compute environment a tool invocation should target
 * (isolated container, shared container, configured external target, or host) based on agent
 * capabilities and an optional explicit target parameter.
 */

import type { ExecutionTarget } from '../../../shared/types/compute.types'

export type ComputeTarget = string

export interface ComputeCapabilities {
  /** Agent has an isolated container (compute.enabled && podman available) */
  hasIsolated: boolean
  /** Shared container is available (podman available) */
  hasShared: boolean
  /** Host execution is allowed (compute.host_access) */
  hasHost: boolean
  /** Trusted external targets keyed by their safe agent-facing aliases. */
  externalTargets?: Record<string, ExecutionTarget>
  /** Exact target aliases this agent may use. Undefined preserves legacy built-in behavior. */
  allowedTargets?: ComputeTarget[]
  /** Configured target used when compute_exec.target is omitted. */
  defaultTarget?: ComputeTarget
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
  const builtIns: ComputeTarget[] = []
  if (caps.hasIsolated) builtIns.push('isolated')
  if (caps.hasShared) builtIns.push('shared')
  if (caps.hasHost) builtIns.push('host')

  // Legacy agents without an explicit allowlist retain their built-in target
  // behavior but never inherit newly registered external targets.
  if (caps.allowedTargets === undefined) return builtIns

  const available = new Set([
    ...builtIns,
    ...Object.keys(caps.externalTargets ?? {}),
  ])
  return [...new Set(caps.allowedTargets)].filter(target => available.has(target))
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
        requested === 'shared' ? 'Ensure Podman is running.' :
        'Authorize this registered target in Agent > Compute.'
      throw new Error(`Target '${requested}' is not available. ${hint} Available: ${available.join(', ')}.`)
    }
    return requested
  }

  if (caps.defaultTarget) {
    if (!available.includes(caps.defaultTarget)) {
      throw new Error(`Configured compute target '${caps.defaultTarget}' is unavailable. Update Agent > Compute before running commands.`)
    }
    return caps.defaultTarget
  }

  // Default: least privileged (first in the ordered list)
  return available[0]
}
