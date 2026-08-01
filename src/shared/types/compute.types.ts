export type ContainerEngine = 'docker' | 'podman'

/**
 * A user-owned, already-running container that ADF may execute commands in.
 * ADF never starts, stops, rebuilds, provisions, or removes this container.
 */
export interface LocalContainerExecutionTarget {
  id: string
  name: string
  /** Safe, human-readable name exposed to agents (for example docker-python-tools). */
  alias?: string
  kind: 'local-container'
  engine: ContainerEngine
  containerRef: string
  workdir: string
  /** Optional immutable container ID. When present, name reuse is rejected. */
  expectedContainerId?: string
}

/** Extensible without adding another agent-facing tool. */
export type ExecutionTarget = LocalContainerExecutionTarget

export const BUILT_IN_COMPUTE_TARGETS = ['shared', 'isolated', 'host'] as const
export type BuiltInComputeTarget = typeof BUILT_IN_COMPUTE_TARGETS[number]

export interface ComputeAppSettings {
  hostAccessEnabled: boolean
  hostApproved: string[]
  containerPackages: string[]
  machineCpus: number
  machineMemoryMb: number
  containerImage: string
  executionTargets: ExecutionTarget[]
}

export interface ExecutionTargetProbeResult {
  success: boolean
  error?: string
  engine?: ContainerEngine
  engineVersion?: string
  containerId?: string
  containerName?: string
  image?: string
  running?: boolean
}

export interface ContainerSummary {
  id: string
  name: string
  status: string
  state: string
  running: boolean
  image: string
  createdAt?: string
  managed: boolean
  scope: 'shared' | 'dedicated' | 'legacy'
  agentId?: string
  agentName?: string
}

/** Pushed to the renderer when a browser process appears in an agent's isolated container. */
export interface BrowserSessionEvent {
  agentId: string
  agentName: string
  agentFilePath: string
  containerName: string
  /** Host loopback port serving the container's noVNC viewer. */
  hostPort: number
  timestamp: number
}

export interface ContainerOverview {
  id: string
  name: string
  image: string
  createdAt?: string
  startedAt?: string
  state: string
  pid?: number
  ipAddress?: string
  command?: string[]
  labels: Record<string, string>
}
