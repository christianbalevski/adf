/**
 * Live compute capabilities for compute_exec and fs_transfer.
 *
 * The capabilities follow the agent's current config, not its start-time
 * snapshot: an agent that turns on compute (or changes its targets) with
 * sys_update_config gets the new targets on its next call, without a restart.
 * When the isolated container becomes available mid-run it is brought up right
 * away, so the Computer tab can show it before the first command.
 */

import type { AgentConfig } from '../../../shared/types/adf-v02.types'
import { isolatedContainerName, type PodmanService } from '../../services/podman.service'
import { resolveAgentComputeTargetSelection } from '../../services/execution-target-settings'
import type { ComputeCapabilities } from './compute-target'

export interface ComputeCapabilityInputs {
  podmanService: PodmanService | null | undefined
  /** The runtime's `compute` settings (execution targets, host access). */
  computeSettings: unknown
  runtimeHostAllowed: boolean
  /** Host OS/shell note; only called when host access is allowed. */
  describeHost?: () => string
}

export function buildComputeCapabilities(config: AgentConfig, inputs: ComputeCapabilityInputs): ComputeCapabilities {
  const hostAllowed = !!config.compute?.host_access && inputs.runtimeHostAllowed
  return {
    hasIsolated: !!(config.compute?.enabled && inputs.podmanService),
    hasShared: !!inputs.podmanService,
    hasHost: hostAllowed,
    ...resolveAgentComputeTargetSelection(inputs.computeSettings, config.compute),
    isolatedContainerName: config.compute?.enabled ? isolatedContainerName(config.name, config.id) : undefined,
    agentName: config.name,
    pipPackages: config.compute?.packages?.pip,
    browserDisplay: config.compute?.browser !== false,
    agentId: config.id,
    hostInfo: hostAllowed ? inputs.describeHost?.() : undefined,
  }
}

/**
 * A capabilities source that re-reads the agent config on every use.
 * `initial` is what the agent started with; its isolated container is brought
 * up by the start path, so only a later off→on change provisions here.
 */
export function liveComputeCapabilities(
  initial: ComputeCapabilities,
  getConfig: () => AgentConfig,
  getInputs: () => ComputeCapabilityInputs,
  agentFilePath?: string,
): () => ComputeCapabilities {
  let last = initial
  let hostInfo = initial.hostInfo
  return () => {
    let config: AgentConfig
    try {
      config = getConfig()
    } catch {
      return last // workspace closed mid-call: keep the last known state
    }
    const inputs = getInputs()
    // describeHost probes the shell once; the host does not change mid-run.
    const next = buildComputeCapabilities(config, {
      ...inputs,
      describeHost: () => (hostInfo ??= inputs.describeHost?.()) ?? '',
    })
    const podman = inputs.podmanService
    if (podman && next.hasIsolated && next.isolatedContainerName
      && (!last.hasIsolated || last.isolatedContainerName !== next.isolatedContainerName)) {
      const name = next.isolatedContainerName
      // Deferred so a bring-up failure can never break reading the tool's description.
      void Promise.resolve()
        .then(() => podman.ensureIsolatedRunning(config.name, config.id, next.pipPackages ?? [], agentFilePath, next.browserDisplay !== false))
        .then(() => podman.ensureWorkspace(name, '/workspace'))
        .catch((err) => {
          console.warn(`[Compute] Isolated container for ${config.name} is not ready:`, err instanceof Error ? err.message : err)
        })
    }
    last = next
    return next
  }
}
