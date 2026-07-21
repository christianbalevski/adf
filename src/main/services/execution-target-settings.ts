import type { ExecutionTarget, LocalContainerExecutionTarget } from '../../shared/types/compute.types'
import type { ComputeConfig } from '../../shared/types/adf-v02.types'
import { resolveExecutionTargetAliases } from '../../shared/utils/compute-targets'

export function executionTargetsFromSettings(value: unknown): ExecutionTarget[] {
  const raw = value as { executionTargets?: unknown } | undefined
  if (!Array.isArray(raw?.executionTargets)) return []
  return raw.executionTargets.filter(isExecutionTarget)
}

export function resolveExecutionTarget(value: unknown, targetId: string | undefined): ExecutionTarget | undefined {
  if (!targetId) return undefined
  return executionTargetsFromSettings(value).find(target => target.id === targetId)
}

export interface AgentComputeTargetSelection {
  /** External targets keyed by the safe aliases exposed through compute_exec. */
  externalTargets: Record<string, ExecutionTarget>
  /** Undefined preserves the legacy capability-derived allowlist. */
  allowedTargets?: string[]
  defaultTarget?: string
}

/**
 * Resolve persisted target IDs into safe runtime aliases. The app-level
 * registry remains the source of truth; unknown IDs are retained only as a
 * default so routing fails closed with a useful error.
 */
export function resolveAgentComputeTargetSelection(
  value: unknown,
  compute: ComputeConfig | undefined,
): AgentComputeTargetSelection {
  const resolved = resolveExecutionTargetAliases(executionTargetsFromSettings(value))
  const externalTargets = Object.fromEntries(resolved.map(({ alias, target }) => [alias, target]))
  const byId = new Map(resolved.map(({ alias, target }) => [target.id, alias]))
  const mapKey = (key: string): string => byId.get(key) ?? key

  if (compute?.allowed_targets) {
    return {
      externalTargets,
      allowedTargets: [...new Set(compute.allowed_targets.map(mapKey))],
      defaultTarget: compute.default_target ? mapKey(compute.default_target) : undefined,
    }
  }

  // Backward compatibility for the original single-target field.
  if (compute?.target) {
    const target = mapKey(compute.target)
    return { externalTargets, allowedTargets: [target], defaultTarget: target }
  }

  return {
    externalTargets,
    defaultTarget: compute?.default_target ? mapKey(compute.default_target) : undefined,
  }
}

export function isExecutionTarget(value: unknown): value is LocalContainerExecutionTarget {
  const target = value as Partial<LocalContainerExecutionTarget> | null
  return !!target
    && target.kind === 'local-container'
    && (target.engine === 'docker' || target.engine === 'podman')
    && typeof target.id === 'string'
    && target.id.length > 0
    && typeof target.name === 'string'
    && target.name.length > 0
    && typeof target.containerRef === 'string'
    && target.containerRef.length > 0
    && typeof target.workdir === 'string'
    && target.workdir.startsWith('/')
    && (target.expectedContainerId === undefined || typeof target.expectedContainerId === 'string')
}
