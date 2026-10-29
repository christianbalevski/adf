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

export interface ComputeInstallMethod {
  command: string
  label: string
  autoRunnable: boolean
  url?: string
}

export interface ComputePrerequisite {
  id: 'wsl'
  name: string
  installed: boolean
  installCommand?: string
  requiresReboot?: boolean
  description?: string
  docsUrl?: string
}

/** Availability details returned by the Podman setup wizard. */
export interface PodmanAvailability {
  available: boolean
  binPath?: string
  version?: string
  machineRequired: boolean
  machineRunning?: boolean
  machineExists?: boolean
  error?: string
  platform: string
  installMethods: ComputeInstallMethod[]
  prerequisites: ComputePrerequisite[]
}

export interface ComputeSetupResult {
  success: boolean
  error?: string
  availability?: PodmanAvailability
}

export const BUILT_IN_COMPUTE_TARGETS = ['shared', 'isolated', 'host'] as const
export type BuiltInComputeTarget = typeof BUILT_IN_COMPUTE_TARGETS[number]

export interface ComputeAppSettings {
  hostAccessEnabled: boolean
  hostApproved: string[]
  /** name → source identity recorded when the name was approved (the host-grant squat guard, container-routing.ts). */
  hostApprovedSources?: Record<string, string>
  /**
   * The owner accepted running MCP servers on this computer instead of in a
   * container (container-routing.ts). Off by default; Studio turns it on only
   * after an explicit confirmation.
   */
  mcpOnHost?: boolean
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
  /** Managed container created before the current isolation feature set —
   *  gains it only via a (data-losing) rebuild. Undefined/false = up to date. */
  outdated?: boolean
  /** Set when the last create+provision of this container failed (state is
   *  then 'failed' and no container exists behind the row). The message is
   *  the provisioning error; Rebuild retries, Remove clears the row. */
  error?: string
  /** Other live runtimes on this machine that use this container ("daemon
   *  pid 4242"), in both backends; absent when nobody else does. */
  users?: string[]
}

/**
 * Lifecycle of one managed container as the runtime sees it. `absent` = no
 * container exists (created on the agent's next start), `provisioning` =
 * create + package install in flight, `starting` = `podman start` of an
 * existing container, `failed` = the last create+provision failed (nothing
 * exists behind the name; Rebuild retries).
 */
export type ContainerPhase = 'absent' | 'provisioning' | 'starting' | 'ready' | 'stopped' | 'failed'

/** Pushed to the renderer on every phase transition of a managed container. */
export interface ContainerPhaseEvent {
  containerName: string
  phase: ContainerPhase
  /** Human-readable step or failure message. */
  detail?: string
  agentId?: string
  timestamp: number
}

/** Answer to a Computer-tab open request: the phase always, the noVNC port only when ready. */
export interface BrowserSessionInfo {
  containerName: string
  hostPort: number | null
  phase: ContainerPhase
  /** Phase detail, or the browser bring-up error when the container is ready but its display is not. */
  detail?: string
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
