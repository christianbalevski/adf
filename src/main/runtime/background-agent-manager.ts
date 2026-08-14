import { EventEmitter } from 'events'
import { realpathSync } from 'fs'
import { basename, join } from 'path'
import { deriveHandle } from '../utils/handle'
import { nanoid } from 'nanoid'
import type { AgentExecutor } from './agent-executor'
import { AgentSession } from './agent-session'
import type { TriggerEvaluator } from './trigger-evaluator'
import { assembleAgent, type AssembledAgent, type HostAttachment, type LifecycleResource } from './assemble-agent'
import type { AgentProfileName } from './agent-capability-profiles'
import { AdfWorkspace } from '../adf/adf-workspace'
import { unlockWorkspaceEnvelopes } from './identity-provisioner'
import { AdfDatabase } from '../adf/adf-database'
import { isConfigReviewed } from '../services/agent-review'
import { ToolRegistry } from '../tools/tool-registry'
import { SysCodeTool, SysLambdaTool, SysGetConfigTool, SysFetchTool, FsTransferTool, ComputeExecTool, StreamBindTool, StreamUnbindTool, StreamBindingsTool, McpInstallTool, McpRestartTool, McpUninstallTool, buildToolDiscovery, type McpConnectOutcome } from '../tools/built-in'
import { registerBuiltInTools } from '../tools/built-in/register-built-in-tools'
import { StreamBindingManager } from './stream-binding-manager'
import type { ComputeCapabilities } from '../tools/built-in/compute-target'
import { AdfCallHandler } from './adf-call-handler'
import type { TapManager } from './tap-manager'
import { createUmbilicalResources } from './umbilical-lifecycle'
import { RuntimeGate } from './runtime-gate'
import { SystemScopeHandler } from './system-scope-handler'
import type { CodeSandboxService } from './code-sandbox'
import { createProvider } from '../providers/provider-factory'
import { McpClientManager } from '../services/mcp-client-manager'
import { createScratchDir, removeScratchDir } from '../utils/scratch-dir'
import { ChannelAdapterManager } from '../services/channel-adapter-manager'
import { PackageResolver } from '../services/mcp-package-resolver'
import { captureEnvSchema, resolveMcpSpawnConfig, resolveMcpEnvVars } from '../services/mcp-spawn-utils'
import type { UvxPackageResolver } from '../services/uvx-package-resolver'
import type { UvManager } from '../services/uv-manager'
import type { PodmanService } from '../services/podman.service'
import type { WsConnectionManager } from '../services/ws-connection-manager'
import { containerWorkspacePath } from '../services/podman.service'
import { PodmanStdioTransport } from '../services/podman-stdio-transport'
import { shouldContainerize, shouldIsolate, isServerForceShared, type ComputeSettings } from '../services/container-routing'
import { syncDiscoveredMcpTools } from '../services/mcp-tool-sync'
import { resolveAgentComputeTargetSelection } from '../services/execution-target-settings'
import { getEnabledAgentAdapterConfig, withBuiltInAdapterRegistrations } from '../../shared/constants/adapter-registry'
import { adapterCredentialsLocked, createLockedCredentialsAdapter, describeHostEnv, detectLockedEnvelopes, HEADLESS_MCP_AUTH_UNAVAILABLE } from './agent-runtime-builder'
import type { SettingsService } from '../services/settings.service'
import type { AgentConfig } from '../../shared/types/adf-v02.types'
import type { AgentState, BackgroundAgentStatus, BackgroundAgentEvent, McpServerRegistration, AdapterRegistration } from '../../shared/types/ipc.types'
import type { CreateAdapterFn } from '../../shared/types/channel-adapter.types'
import { loadBuiltInAdapter } from '../adapters/built-in-loaders'
import { mapWithConcurrency, withDeadline } from '../utils/concurrency'

/** Max agents starting concurrently during the boot autostart scan. */
const AUTOSTART_CONCURRENCY = 5

/**
 * Per-agent budget for connecting all MCP servers. A hung server previously
 * stalled agent start for up to 120s x 3 retries; past this budget the agent
 * starts degraded and the MCP auto-restart machinery recovers in background.
 */
const MCP_CONNECT_BUDGET_MS = 25_000

/** Map executor internal states to display states for the UI. */
export function toDisplayState(executorState: string): AgentState {
  switch (executorState) {
    case 'thinking':
    case 'tool_use':
      return 'active'
    case 'idle':
      return 'idle'
    case 'awaiting_approval':
    case 'awaiting_ask':
    case 'suspended':
      return 'suspended'
    case 'error':
      return 'error'
    case 'stopped':
      return 'off'
    // ADF display states (pass-through from sys_set_state target)
    case 'active':
    case 'hibernate':
    case 'off':
      return executorState as AgentState
    default:
      return 'off'
  }
}

export interface BackgroundManagedAgent {
  assembledAgent: AssembledAgent<AgentProfileName>
  hostAttachment: HostAttachment | null
  filePath: string
  workspace: AdfWorkspace
  session: AgentSession
  executor: AgentExecutor
  triggerEvaluator: TriggerEvaluator
  config: AgentConfig
  state: AgentState
  toolRegistry: ToolRegistry
  accumulatedText: string
  mcpManager: McpClientManager | null
  adapterManager: ChannelAdapterManager | null
  adfCallHandler: AdfCallHandler | null
  scratchDir: string | null
  tapManager: TapManager | null
  streamBindingManager: StreamBindingManager | null
}

/**
 * Manages background agents independently of mesh mode.
 * When the user switches away from a file with a running agent,
 * the agent transitions here and continues executing in the background.
 * Also supports starting agents directly from the sidebar or directory toggles.
 */
/** Safely extract a loggable string from an error (avoids util.inspect crashes on complex objects). */
function safeErrorString(err: unknown): string {
  if (err instanceof Error) return err.stack || err.message
  try { return String(err) } catch { return '[unserializable error]' }
}

/** How long (ms) an agent can be idle before we consider it for memory pressure relief. */
const IDLE_MEMORY_THRESHOLD_MS = 5 * 60 * 1000 // 5 minutes

export class BackgroundAgentManager extends EventEmitter {
  /** Keyed by canonical (realpath) .adf file path — see canonicalPath(). */
  private agents: Map<string, BackgroundManagedAgent> = new Map()
  /**
   * In-flight starts keyed by canonical path. Claimed synchronously at the
   * top of startAgent so concurrent entry points (boot scan, dir-watcher,
   * START_ALL IPC, user click) await one start instead of building two full
   * agent instances for the same file.
   */
  private inFlightStarts: Map<string, Promise<boolean>> = new Map()

  /**
   * True while stopAll() is draining agents. Unlike RuntimeGate.tearingDown
   * (a process-lifetime latch), this is transient: EMERGENCY_STOP must remain
   * resumable, but an in-flight start finishing mid-stopAll must still dispose
   * its agent instead of registering it and escaping the teardown snapshot.
   */
  private stopAllInProgress = false
  private settings: SettingsService
  private basePrompt: string
  private toolPrompts: Record<string, string>
  private compactionPrompt: string | undefined
  private codeSandboxService: CodeSandboxService | null = null
  private mcpPackageResolver = new PackageResolver('mcp-servers')
  private uvxPackageResolver: UvxPackageResolver | null = null
  private uvManager: UvManager | null = null
  private adapterPackageResolver = new PackageResolver('channel-adapters')
  private podmanService: PodmanService | null = null
  private wsConnectionManager: WsConnectionManager | null = null
  /** Track last activity per agent for idle memory release */
  private lastActivityTime: Map<string, number> = new Map()
  private idleSweepTimer: ReturnType<typeof setInterval> | null = null
  /** External callback for config changes (e.g. to update mesh cache). */
  onAgentConfigChanged?: (filePath: string, config: AgentConfig) => void

  /**
   * External callback fired when an agent's config `name` changes at runtime
   * (e.g. via sys_update_config). IPC layer wires this to schedule a rename of
   * the .adf file once the agent stops.
   */
  onAgentRenamed?: (filePath: string, newName: string) => void

  /**
   * External callback fired after an agent successfully starts.
   * IPC layer wires this to register the agent with the mesh so autostart
   * and sys_create_adf autostart-child paths join the mesh without relying on
   * per-call-site registration code.
   */
  onAgentStarted?: (filePath: string) => void

  /**
   * External callback fired when an agent transitions to the 'off' display state.
   * IPC layer wires this to perform mesh unregister + foreground/background teardown.
   * Centralizing this in IPC ensures consistent hard-off semantics regardless of
   * which path triggered the transition (LLM tool call, lambda, HIL approval).
   */
  onAgentOff?: (filePath: string) => Promise<void> | void

  /** Re-entrancy guard — prevents recursive teardown when stopAgent fires events. */
  private offInProgress: Set<string> = new Set()

  /** Starts announced via agent_starting that haven't completed or failed yet. */
  private pendingStarts: Set<string> = new Set()

  constructor(settings: SettingsService, basePrompt: string, toolPrompts: Record<string, string>, compactionPrompt?: string) {
    super()
    this.settings = settings
    this.basePrompt = basePrompt
    this.toolPrompts = toolPrompts
    this.compactionPrompt = compactionPrompt
    // Periodically check for idle agents when we have many agents running
    this.idleSweepTimer = setInterval(() => this.sweepIdleAgents(), 60_000)
  }

  setCodeSandboxService(service: CodeSandboxService): void {
    this.codeSandboxService = service
  }

  setPodmanService(service: PodmanService): void {
    this.podmanService = service
  }

  setWsConnectionManager(service: WsConnectionManager | null): void {
    this.wsConnectionManager = service
  }

  setUvxPackageResolver(resolver: UvxPackageResolver): void {
    this.uvxPackageResolver = resolver
  }

  setUvManager(manager: UvManager): void {
    this.uvManager = manager
  }

  /**
   * Canonicalize an .adf path (realpath) so symlink/case variants of one file
   * share a single map entry — the unresolved path is kept only for display.
   */
  private canonicalPath(filePath: string): string {
    try { return realpathSync(filePath) } catch { return filePath }
  }

  hasAgent(filePath: string): boolean {
    return this.agents.has(this.canonicalPath(filePath))
  }

  /**
   * Get the executor for a background agent (used for ask/approval resolution).
   */
  getExecutor(filePath: string): AgentExecutor | null {
    return this.agents.get(this.canonicalPath(filePath))?.executor ?? null
  }

  /**
   * "Always approve" a tool for a background agent: drop its HIL gate
   * (enabled, un-restricted) so future calls run without asking, persist the
   * config, propagate to the live executor/trigger/call-handler + mesh cache,
   * then approve the pending request. Mirrors the foreground path in AgentLoop.
   */
  alwaysApproveTool(filePath: string, requestId: string, toolName: string): { success: boolean; error?: string } {
    filePath = this.canonicalPath(filePath)
    const managed = this.agents.get(filePath)
    if (!managed) return { success: false, error: 'Background agent not found' }
    // Refused when the declaration is locked or the approval is a protection
    // override — the UI disables the option, but the backend is the authority.
    const meta = managed.executor.getPendingApprovalMeta(requestId)
    const lockedDecl = managed.config.tools?.find((t) => t.name === toolName)?.locked === true
    if (meta?.canAlwaysApprove === false || lockedDecl) {
      return { success: false, error: meta?.alwaysApproveBlockedReason ?? 'Tool declaration is locked' }
    }
    const tools = managed.config.tools ? [...managed.config.tools] : []
    const idx = tools.findIndex((t) => t.name === toolName)
    if (idx >= 0) tools[idx] = { ...tools[idx], enabled: true, restricted: false }
    else tools.push({ name: toolName, enabled: true, visible: true, restricted: false })
    const updated: AgentConfig = { ...managed.config, tools }
    managed.config = updated
    managed.workspace.setAgentConfig(updated)
    managed.executor.updateConfig(updated)
    managed.triggerEvaluator.updateConfig(updated)
    managed.adfCallHandler?.updateConfig(updated)
    this.onAgentConfigChanged?.(filePath, updated)
    managed.executor.resolveApproval(requestId, true)
    return { success: true }
  }

  /**
   * Update a running agent's display name in config and propagate to the live
   * executor/trigger/call-handler + mesh cache. The .adf file itself is renamed
   * by the IPC layer once the agent stops (deferred rename).
   */
  setAgentName(filePath: string, name: string): boolean {
    filePath = this.canonicalPath(filePath)
    const managed = this.agents.get(filePath)
    if (!managed || managed.config.name === name) return false
    const updated: AgentConfig = { ...managed.config, name }
    managed.config = updated
    managed.workspace.setAgentConfig(updated)
    managed.executor.updateConfig(updated)
    managed.triggerEvaluator.updateConfig(updated)
    managed.adfCallHandler?.updateConfig(updated)
    this.onAgentConfigChanged?.(filePath, updated)
    return true
  }

  getAgentCount(): number {
    return this.agents.size
  }

  /**
   * Read-only accessor returning agent refs for MeshManager.
   */
  getAgent(filePath: string): {
    config: AgentConfig
    toolRegistry: ToolRegistry
    workspace: AdfWorkspace
    session: AgentSession
    triggerEvaluator: TriggerEvaluator
    executor: AgentExecutor
    adapterManager: ChannelAdapterManager | null
    adfCallHandler: AdfCallHandler | null
    codeSandboxService: CodeSandboxService | null
    assembledAgent: AssembledAgent<AgentProfileName>
  } | null {
    const managed = this.agents.get(this.canonicalPath(filePath))
    if (!managed) return null
    return {
      config: managed.config,
      toolRegistry: managed.toolRegistry,
      workspace: managed.workspace,
      session: managed.session,
      triggerEvaluator: managed.triggerEvaluator,
      executor: managed.executor,
      adapterManager: managed.adapterManager,
      adfCallHandler: managed.adfCallHandler,
      codeSandboxService: this.codeSandboxService,
      assembledAgent: managed.assembledAgent,
    }
  }

  /**
   * Restore a background agent's session from the loop if the idle sweep
   * released it. Callers that invoke the executor directly (bypassing the
   * trigger evaluator, e.g. AGENT_INVOKE chat) must call this first or the
   * turn runs on a truncated context while the loop retains full history.
   */
  ensureSessionHydrated(filePath: string): void {
    const managed = this.agents.get(this.canonicalPath(filePath))
    if (managed) this.rehydrateSessionIfEmpty(managed)
  }

  /**
   * Check whether a background agent's current turn was triggered by an incoming message.
   */
  getIsMessageTriggered(filePath: string): boolean {
    const managed = this.agents.get(this.canonicalPath(filePath))
    return managed?.executor.isMessageTriggered ?? false
  }

  /**
   * Enumerate all running agent file paths for mesh registration.
   */
  getAllAgentFilePaths(): string[] {
    return Array.from(this.agents.keys())
  }

  /**
   * Synchronously flush every managed agent's buffered loop entries to its
   * SQLite database. Shutdown fast-path helper: better-sqlite3 writes are
   * synchronous (sub-ms per agent), so this never awaits and fits inside the
   * OS session-end grace window. Per-agent failures (e.g. a DB already closed
   * by a partially-completed teardown) are swallowed — flushing the remaining
   * agents matters more than any single one.
   */
  flushAllSessions(): void {
    for (const managed of this.agents.values()) {
      try { managed.session.flushToLoop() } catch { /* best-effort during shutdown */ }
    }
  }

  /**
   * Start an agent from an .adf file (sidebar/directory toggle).
   * Opens the SQLite database, creates workspace/session/executor, and starts running.
   */
  async startAgent(filePath: string, derivedKey?: Buffer | null): Promise<boolean> {
    // Canonicalize once so symlink/case variants of one file cannot double-open
    // its database; everything below (map keys, events, closures) uses this.
    const canonicalPath = this.canonicalPath(filePath)
    if (this.agents.has(canonicalPath)) return true

    // Double-start TOCTOU guard: setup takes up to ~35s (MCP budget + adapter
    // deadline); claim an in-flight slot SYNCHRONOUSLY before any await so
    // concurrent entry points converge on a single instance.
    const pending = this.inFlightStarts.get(canonicalPath)
    if (pending) return pending

    const start = this.doStartAgent(canonicalPath, derivedKey)
    this.inFlightStarts.set(canonicalPath, start)
    try {
      return await start
    } finally {
      this.inFlightStarts.delete(canonicalPath)
    }
  }

  /** Actual start body — filePath is already canonical and the in-flight slot is claimed. */
  private async doStartAgent(filePath: string, derivedKey?: Buffer | null): Promise<boolean> {
    if (RuntimeGate.tearingDown || this.stopAllInProgress) {
      console.warn(`[BackgroundAgent] Refusing to start ${basename(filePath, '.adf')} — runtime teardown in progress`)
      return false
    }

    // Announce the in-flight start so the sidebar can show a spinner while the
    // workspace opens (idempotent with the boot autostart pre-announce, which
    // uses the same canonical path).
    this.emitEvent({
      type: 'agent_starting',
      payload: { filePath },
      timestamp: Date.now()
    })

    try {
      const workspace = AdfWorkspace.open(filePath)
      // Unlock envelope-sealed keys/credentials for this workspace instance (spec D10)
      unlockWorkspaceEnvelopes(workspace)
      // Parity with the daemon (B1 interim hardening): envelopes that remain
      // sealed mean adapter/MCP credentials silently resolve to null — mark
      // the agent loudly degraded instead of failing mysteriously.
      const lockedEnvelopes = detectLockedEnvelopes(workspace)
      const degradedReason = lockedEnvelopes.length > 0
        ? `credentials locked for ${filePath} — sealed envelopes remain locked (${lockedEnvelopes.join(', ')}). Envelope-sealed adapter/MCP credentials will resolve to null.`
        : null
      if (degradedReason) {
        console.error(`[BackgroundAgent] ${degradedReason}`)
        try { workspace.insertLog('error', 'runtime', 'credentials_locked', null, degradedReason.slice(0, 500)) } catch { /* non-fatal */ }
      }
      const config = workspace.getAgentConfig()

      const session = new AgentSession(workspace)
      const existingLoop = workspace.getLoop()
      if (existingLoop.length > 0) {
        session.restoreMessages(existingLoop.map(e => ({ role: e.role, content: e.content_json, created_at: e.created_at, seq: e.seq })))
      }

      await this.setupManagedAgent(filePath, config as AgentConfig, workspace, session, derivedKey, lockedEnvelopes.length > 0)

      if (degradedReason) {
        this.emitEvent({
          type: 'error',
          payload: { filePath, error: degradedReason, code: 'CREDENTIALS_LOCKED' },
          timestamp: Date.now()
        })
      }

      this.emitEvent({
        type: 'agent_started',
        payload: { filePath, state: config.start_in_state ?? 'idle', handle: (config as AgentConfig).handle || deriveHandle(filePath) },
        timestamp: Date.now()
      })

      console.log(`[BackgroundAgent] Started ${basename(filePath, '.adf')}`)

      try { this.onAgentStarted?.(filePath) } catch (err) {
        console.error(`[BackgroundAgent] onAgentStarted failed for ${basename(filePath, '.adf')}: ${safeErrorString(err)}`)
      }

      // Fire initial turn only if start_in_state is active (the default).
      // Autonomous mode controls loop behavior, not whether the agent starts working.
      const managed = this.agents.get(filePath)
      if (managed) {
        process.nextTick(() => {
          // dispatchStartup evaluates on_startup exactly once and independently
          // decides whether the active-state default startup turn is required.
          const startup = managed.assembledAgent.dispatchStartup()
          startup.catch((error) => {
            console.error(`[BackgroundAgent] Start turn error: ${safeErrorString(error)}`)
            managed.state = 'error'
          })
        })
      }

      return true
    } catch (err) {
      console.error(`[BackgroundAgent] Failed to start ${filePath}: ${safeErrorString(err)}`)
      this.emitEvent({
        type: 'agent_start_failed',
        payload: { filePath },
        timestamp: Date.now()
      })
      return false
    }
  }

  /** Transfer a stable assembled handle from foreground to background. */
  async transitionToBackground(
    filePath: string,
    config: AgentConfig,
    assembledAgent: AssembledAgent<AgentProfileName>,
    derivedKey?: Buffer | null,
  ): Promise<void> {
    filePath = this.canonicalPath(filePath)
    const existing = this.agents.get(filePath)
    if (existing?.assembledAgent === assembledAgent) return
    if (existing) {
      throw new Error(`Cannot attach a second assembled agent for ${filePath}`)
    }
    const managed = this.adoptAssembledAgent(filePath, config, assembledAgent, derivedKey)

    this.emitEvent({
      type: 'agent_started',
      payload: { filePath, state: managed.state, handle: config.handle || deriveHandle(filePath) },
      timestamp: Date.now()
    })

    console.log(`[BackgroundAgent] Transitioned ${basename(filePath, '.adf')} to background (state: ${managed.state})`)
  }

  /**
   * Extract a background agent's stable handle for foreground attachment. The
   * executor is NOT aborted, so in-progress turns and HIL state remain intact.
   * Only the owning background host is detached; core listeners remain owned by
   * the handle and a later foreground attachment atomically replaces the host.
   */
  extractBackgroundAgent(filePath: string): {
    assembledAgent: AssembledAgent<AgentProfileName>
    workspace: AdfWorkspace
    session: AgentSession
    executor: AgentExecutor
    triggerEvaluator: TriggerEvaluator
    toolRegistry: ToolRegistry
    mcpManager: McpClientManager | null
    scratchDir: string | null
    adapterManager: ChannelAdapterManager | null
    adfCallHandler: AdfCallHandler | null
    streamBindingManager: StreamBindingManager | null
    displayState: string
  } | null {
    filePath = this.canonicalPath(filePath)
    const managed = this.agents.get(filePath)
    if (!managed) return null

    // Flush any accumulated text before extraction
    this.flushAccumulatedText(managed)

    // Flush buffered loop writes so DOC_GET_BATCH sees mid-turn entries
    managed.session.flushToLoop()

    // If the idle sweep released this session's history, restore it from the
    // loop before handing the session to the foreground. AGENT_START skips its
    // own restore when it adopts an existing session, so an empty one would
    // silently truncate the LLM context to post-adoption messages only (the
    // loop keeps everything, but the model never sees the older turns).
    this.rehydrateSessionIfEmpty(managed)

    // Capture display state before disposing trigger evaluator
    const displayState = managed.triggerEvaluator.getDisplayState()

    // Detach only the background host. Executor/evaluator/resource listeners
    // belong to the stable handle and survive foreground transfer.
    managed.assembledAgent.setWorkspaceOwnership(false)
    managed.hostAttachment?.detach()
    managed.hostAttachment = null

    // Remove from map but do NOT close workspace/session/executor
    this.agents.delete(filePath)
    this.lastActivityTime.delete(filePath)

    this.emitEvent({
      type: 'agent_stopped',
      payload: { filePath },
      timestamp: Date.now()
    })

    console.log(`[BackgroundAgent] Extracted ${basename(filePath, '.adf')} for foreground use`)
    return {
      assembledAgent: managed.assembledAgent,
      workspace: managed.workspace,
      session: managed.session,
      executor: managed.executor,
      triggerEvaluator: managed.triggerEvaluator,
      toolRegistry: managed.toolRegistry,
      mcpManager: managed.mcpManager,
      scratchDir: managed.scratchDir,
      adapterManager: managed.adapterManager,
      adfCallHandler: managed.adfCallHandler,
      streamBindingManager: managed.streamBindingManager,
      displayState
    }
  }

  /**
   * Stop a background agent (from sidebar toggle or explicit stop).
   */
  /**
   * Fire the centralized agent-off teardown. Re-entrant: subsequent calls for the
   * same filePath while teardown is in progress are no-ops. Always invoked from a
   * state_changed='off' event listener — never call directly.
   */
  private requestAgentOff(filePath: string): void {
    if (this.offInProgress.has(filePath)) return
    if (!this.onAgentOff) return
    this.offInProgress.add(filePath)
    Promise.resolve(this.onAgentOff(filePath))
      .catch(err => console.error(`[BackgroundAgent] onAgentOff failed for ${basename(filePath, '.adf')}:`, err))
      .finally(() => this.offInProgress.delete(filePath))
  }

  async stopAgent(filePath: string): Promise<boolean> {
    filePath = this.canonicalPath(filePath)
    // A stop that races an in-flight start waits for the start to settle so
    // the built agent cannot escape the teardown below.
    const pending = this.inFlightStarts.get(filePath)
    if (pending) await pending.catch(() => {})
    const managed = this.agents.get(filePath)
    if (!managed) return false

    // Announce the registered stop so the sidebar can show a spinner while
    // dispose (which can await in-flight turns) runs.
    this.emitEvent({
      type: 'agent_stopping',
      payload: { filePath },
      timestamp: Date.now()
    })

    // Claim teardown before awaiting so concurrent stop entry points cannot
    // emit duplicate stop events or retain a second owner for this handle.
    this.agents.delete(filePath)
    this.lastActivityTime.delete(filePath)

    // The assembled handle is the sole owner of every managed resource.
    try { this.flushAccumulatedText(managed) } catch { /* ignore */ }
    try { managed.hostAttachment?.detach() } catch { /* ignore */ }
    managed.hostAttachment = null
    await managed.assembledAgent.disposeAsync({ mode: 'owner-off' })

    this.emitEvent({
      type: 'agent_stopped',
      payload: { filePath },
      timestamp: Date.now()
    })

    console.log(`[BackgroundAgent] Stopped ${basename(filePath, '.adf')}`)
    return true
  }

  /**
   * Stop all background agents.
   *
   * `finalTeardown: true` (app quit / cleanupAllProcesses) latches the
   * RuntimeGate terminally — resume() no-ops until process exit. Without it
   * (EMERGENCY_STOP) the gate is only stopped transiently so the user can
   * resume and start agents again without restarting the app; the escape race
   * is still covered in all cases by `stopAllInProgress` plus awaiting
   * in-flight starts, so a start finishing mid-stopAll disposes its agent
   * instead of registering it.
   */
  async stopAll(opts: { finalTeardown?: boolean } = {}): Promise<void> {
    // Close the gate FIRST: an agent whose start completes after the snapshot
    // below must not fire turns behind the teardown's back. Only final
    // teardown latches the gate — after beginTeardown, resume() no-ops and
    // doStartAgent/setupManagedAgent refuse to register new agents for good.
    if (opts.finalTeardown) RuntimeGate.beginTeardown()
    else RuntimeGate.stop()
    this.stopAllInProgress = true
    try {
      // Stop idle sweep timer first to prevent any interaction during shutdown
      if (this.idleSweepTimer) {
        clearInterval(this.idleSweepTimer)
        this.idleSweepTimer = null
      }

      // In-flight starts observe stopAllInProgress (or the teardown latch) and
      // dispose their own agent instead of registering it; await them so that
      // teardown completes here.
      if (this.inFlightStarts.size > 0) {
        await Promise.allSettled(Array.from(this.inFlightStarts.values()))
      }

      const managedAgents = Array.from(this.agents.entries())
      this.agents.clear()
      for (const [fp, managed] of managedAgents) {
        try { managed.hostAttachment?.detach() } catch { /* ignore */ }
        managed.hostAttachment = null
        try { await managed.assembledAgent.disposeAsync({ mode: 'immediate' }) } catch (e) {
          console.error(`[BackgroundAgent] dispose error for ${fp}:`, e)
        }
      }
      // Stop compute environment container
      try { if (this.podmanService) await this.podmanService.stop() } catch { /* ignore */ }
    } finally {
      this.stopAllInProgress = false
    }
  }

  /**
   * Scan tracked directories for .adf files with autostart enabled and start them.
   * Called once at boot — fire-and-forget. Per-agent failures are logged and skipped.
   */
  async autostartFromDirectories(trackedDirs: string[], maxDepth = 5): Promise<void> {
    RuntimeGate.resume()
    const { readdirSync, realpathSync } = await import('fs')

    const collectAdfFiles = (dir: string, depth: number): string[] => {
      if (depth > maxDepth) return []
      const results: string[] = []
      try {
        const entries = readdirSync(dir, { withFileTypes: true })
        for (const entry of entries) {
          const full = join(dir, entry.name)
          if (entry.isFile() && entry.name.endsWith('.adf')) {
            results.push(full)
          } else if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
            results.push(...collectAdfFiles(full, depth + 1))
          }
        }
      } catch { /* skip unreadable dirs */ }
      return results
    }

    // Deduplicate by resolved path — tracked directories may overlap
    const seen = new Set<string>()
    const uniqueFiles: string[] = []
    for (const dir of trackedDirs) {
      for (const file of collectAdfFiles(dir, 0)) {
        let resolved: string
        try { resolved = realpathSync(file) } catch { resolved = file }
        if (!seen.has(resolved)) {
          seen.add(resolved)
          uniqueFiles.push(file)
        }
      }
    }

    // Announce every autostart candidate up front: even with bounded-parallel
    // starts each agent can take a while, and the sidebar should show which
    // agents are queued to start from the moment the app boots. Candidate keys
    // are canonicalized so these events pair with the started/failed events
    // the start path emits (which uses canonical paths throughout).
    const candidates = new Set(
      uniqueFiles
        .map((filePath) => this.canonicalPath(filePath))
        .filter((filePath) => {
          const peek = AdfDatabase.peekBootStatus(filePath)
          return !!peek && peek.autostart && !peek.hasEncryptedIdentity
        })
    )
    for (const filePath of candidates) {
      this.emitEvent({ type: 'agent_starting', payload: { filePath }, timestamp: Date.now() })
    }

    // Bounded parallel start — the strictly serial loop multiplied per-agent
    // I/O into ~30s boots. tryAutostart never throws and dedups via the
    // agents map, so settled results need no extra handling here.
    await mapWithConcurrency(uniqueFiles, AUTOSTART_CONCURRENCY, async (filePath) => {
      const canonical = this.canonicalPath(filePath)
      const started = await this.tryAutostart(canonical)
      // Clear the queued spinner for candidates that were skipped (review
      // gate, already running) — startAgent's own failure path covers errors.
      if (!started && candidates.has(canonical)) {
        this.emitEvent({ type: 'agent_start_failed', payload: { filePath: canonical }, timestamp: Date.now() })
      }
    })
  }

  /**
   * Start an agent if its config has autostart enabled and it passes the
   * gates (not already running, not password-protected, reviewed).
   * Used by the boot scan and by the tracked-dir watcher when a new .adf
   * file appears. Returns true if the agent was started.
   */
  async tryAutostart(filePath: string): Promise<boolean> {
    filePath = this.canonicalPath(filePath)
    // Synchronous dedup against both running agents and in-flight starts —
    // the boot scan and the dir-watcher race each other for new files.
    if (this.agents.has(filePath) || this.inFlightStarts.has(filePath)) return false
    const name = basename(filePath, '.adf')

    const peeked = AdfDatabase.peekBootStatusDetailed(filePath)
    if (!peeked.status || !peeked.status.autostart) return false

    if (peeked.status.hasEncryptedIdentity) {
      console.warn(`[BackgroundAgent] Skipping autostart for ${name} — password-protected`)
      return false
    }

    // Review gate: no review, or changed reviewed config, means no autostart.
    // Uses the config the boot peek already parsed in the same readonly open.
    const reviewed = isConfigReviewed(this.settings.get('reviewedAgents'), peeked.config)
    if (!reviewed) {
      console.warn(`[BackgroundAgent] Skipping autostart for ${name} — not yet reviewed`)
      return false
    }
    try {
      const started = await this.startAgent(filePath)
      if (started) console.log(`[BackgroundAgent] Autostarted ${name}`)
      return started
    } catch (err) {
      console.warn(`[BackgroundAgent] Failed to autostart ${name}: ${safeErrorString(err)}`)
      return false
    }
  }

  /**
   * Return status array for renderer.
   */
  /** File paths with an announced but not yet completed start (boot autostart queue). */
  getPendingStarts(): string[] {
    return [...this.pendingStarts]
  }

  getStatuses(): BackgroundAgentStatus[] {
    const statuses: BackgroundAgentStatus[] = []
    for (const [filePath, managed] of this.agents) {
      statuses.push({
        filePath,
        handle: managed.config.handle || deriveHandle(filePath),
        state: managed.state
      })
    }
    return statuses
  }

  // --- Private helpers ---

  private adoptAssembledAgent(
    filePath: string,
    config: AgentConfig,
    assembledAgent: AssembledAgent<AgentProfileName>,
    derivedKey?: Buffer | null,
  ): BackgroundManagedAgent {
    if (RuntimeGate.tearingDown || this.stopAllInProgress) {
      // Shutdown race: never adopt a new owner mid-teardown — dispose instead.
      void assembledAgent.disposeAsync({ mode: 'immediate' }).catch(() => {})
      throw new Error(`Runtime teardown in progress — cannot adopt agent for ${filePath}`)
    }
    assembledAgent.setWorkspaceOwnership(true)
    const managed: BackgroundManagedAgent = {
      assembledAgent,
      hostAttachment: null,
      filePath,
      workspace: assembledAgent.workspace,
      session: assembledAgent.session,
      executor: assembledAgent.executor,
      triggerEvaluator: assembledAgent.triggerEvaluator,
      config,
      state: toDisplayState(assembledAgent.executor.getState()),
      toolRegistry: assembledAgent.registry,
      accumulatedText: '',
      mcpManager: assembledAgent.mcpManager,
      adapterManager: assembledAgent.adapterManager,
      adfCallHandler: assembledAgent.adfCallHandler,
      scratchDir: assembledAgent.scratchDir,
      tapManager: assembledAgent.tapManager,
      streamBindingManager: assembledAgent.streamBindingManager,
    }

    managed.hostAttachment = assembledAgent.attachHost({
      beforeDispatch: () => {
        if (!this.agents.has(filePath)) throw new Error(`Background agent is no longer attached: ${filePath}`)
        this.touchActivity(filePath)
        this.rehydrateSessionIfEmpty(managed)
      },
      onTriggerError: (error, dispatch) => {
        if (!this.agents.has(filePath) || managed.executor.getState() === 'stopped') return
        const eventType = 'event' in dispatch ? dispatch.event.type : dispatch.events[0]?.type ?? 'batch'
        try { managed.workspace.insertLog('error', 'runtime', 'trigger_error', eventType, safeErrorString(error).slice(0, 200)) } catch { /* non-fatal */ }
        managed.state = 'error'
      },
      onStateOff: () => this.requestAgentOff(filePath),
      onConfigChanged: (updatedConfig) => {
        const previousName = managed.config.name
        managed.config = updatedConfig
        this.onAgentConfigChanged?.(filePath, updatedConfig)
        if (updatedConfig.name !== previousName) this.onAgentRenamed?.(filePath, updatedConfig.name)
        this.reconcileAgentAdapters(managed.adapterManager, updatedConfig, managed.workspace, derivedKey)
      },
      onAutostartChild: async (childPath) => this.startAgent(childPath),
      onAdapterInbound: (type) => this.emit('adapter_inbound', { filePath, type }),
      onEvent: (event) => {
        if (!this.agents.has(filePath)) return
        if (event.type === 'state_changed') {
          managed.state = toDisplayState((event.payload as { state: string }).state)
          this.emitEvent({
            type: 'agent_state_changed',
            payload: { filePath, state: managed.state },
            timestamp: Date.now(),
          })
        }
        if (event.type === 'text_delta') managed.accumulatedText += (event.payload as { delta: string }).delta
        if (event.type === 'tool_call_start') this.flushAccumulatedText(managed)
        if (event.type === 'tool_call_start' || event.type === 'tool_call_result' ||
            event.type === 'ask_request' || event.type === 'tool_approval_request' ||
            event.type === 'response_metadata' || event.type === 'error' || event.type === 'turn_complete') {
          this.emitEvent({
            type: event.type,
            payload: { filePath, ...(event.payload as Record<string, unknown>) },
            timestamp: event.timestamp,
          })
        }
        if (event.type === 'adf_file_created') {
          this.emitEvent({
            type: 'adf_file_created',
            payload: { agentFilePath: filePath, filePath: (event.payload as Record<string, unknown>).filePath },
            timestamp: event.timestamp,
          })
        }
        if (event.type === 'turn_complete') this.flushAccumulatedText(managed)
      },
    })
    this.agents.set(filePath, managed)
    // Registration counts as activity. Without this the sweep reads lastActive
    // as 0 (epoch) for any agent that has not dispatched yet, so a freshly
    // adopted agent with a fully restored session is release-eligible on the
    // very first tick — and logs a nonsense "idle 29338000m".
    this.touchActivity(filePath)
    return managed
  }

  /**
   * Reconcile a managed agent's running channel adapters against its updated
   * config so adapter edits take effect live (see ChannelAdapterManager.reconcile).
   * Shared by fresh setup and transferred-handle host wiring.
   */
  private reconcileAgentAdapters(
    adapterManager: ChannelAdapterManager | null,
    updatedConfig: AgentConfig,
    workspace: AdfWorkspace,
    derivedKey?: Buffer | null
  ): void {
    if (!adapterManager) return
    const registrations = withBuiltInAdapterRegistrations(this.settings.get('adapters') as AdapterRegistration[] | undefined)
    void adapterManager.reconcile({
      registrations,
      adaptersConfig: updatedConfig.adapters,
      workspace,
      derivedKey,
      resolveFactory: async (type, reg) => {
        const installed = reg.npmPackage ? this.adapterPackageResolver.getInstalled(reg.npmPackage) : null
        let createFn = await loadBuiltInAdapter(type)
        if (!createFn && installed && reg.npmPackage) {
          const mod = require(join(installed.installPath, 'node_modules', reg.npmPackage))
          createFn = mod.createAdapter ?? mod.default?.createAdapter
        }
        return createFn ?? null
      },
    }).catch(err => console.error('[BackgroundAgent][Adapter] reconcile failed:', err))
  }

  private async setupManagedAgent(
    filePath: string,
    config: AgentConfig,
    workspace: AdfWorkspace,
    session: AgentSession,
    derivedKey?: Buffer | null,
    envelopesLocked = false
  ): Promise<BackgroundManagedAgent> {
    // Ensure inbox tools are in config
    const toolNames = config.tools.map((t) => t.name)
    for (const toolName of ['msg_list', 'msg_read', 'msg_update']) {
      if (!toolNames.includes(toolName)) {
        config.tools.push({ name: toolName, enabled: true, visible: true })
      }
    }
    for (const toolName of ['stream_bind', 'stream_unbind', 'stream_bindings']) {
      if (!toolNames.includes(toolName)) {
        config.tools.push({ name: toolName, enabled: false })
      }
    }

    // Create per-agent tool registry with built-in tools (NO communication tools)
    const agentToolRegistry = new ToolRegistry()
    registerBuiltInTools(agentToolRegistry)

    // Create provider + executor (check ADF-stored providers first)
    const adfProvider = config.providers?.find(p => p.id === config.model.provider)
    const resolvedProvider = adfProvider ? {
      ...adfProvider,
      apiKey: workspace.getIdentityDecrypted(`provider:${adfProvider.id}:apiKey`, derivedKey ?? null) ?? ''
    } : undefined
    const provider = createProvider(config, this.settings, resolvedProvider)

    // Create AdfCallHandler if code execution, sys_lambda, serving API routes, or middleware are declared
    const hasSystemLambda = Object.values(config.triggers ?? {}).some(
      (tc: any) => tc?.enabled && tc?.targets?.some((t: any) => t.scope === 'system' && t.lambda)
    )
    const hasApiRoutes = (config.serving?.api?.length ?? 0) > 0
    const hasMiddleware = !!(
      config.security?.middleware?.inbox?.length ||
      config.security?.middleware?.outbox?.length ||
      config.security?.fetch_middleware?.length ||
      config.serving?.api?.some(r => r.middleware?.length)
    )
    const needsAdfHandler = this.codeSandboxService && (hasSystemLambda || hasApiRoutes || hasMiddleware || config.tools.some(t =>
      t.name === 'sys_code' || t.name === 'sys_lambda'
    ))
    let adfCallHandler: AdfCallHandler | null = null
    if (needsAdfHandler) {
      adfCallHandler = new AdfCallHandler({
        toolRegistry: agentToolRegistry,
        workspace,
        config,
        provider,
        createProviderForModel: (modelId: string) => {
          const overrideConfig = { ...config, model: { ...config.model, model_id: modelId } }
          const overrideAdfProvider = overrideConfig.providers?.find(p => p.id === overrideConfig.model.provider)
          const overrideResolved = overrideAdfProvider ? {
            ...overrideAdfProvider,
            apiKey: workspace.getIdentityDecrypted(`provider:${overrideAdfProvider.id}:apiKey`, derivedKey ?? null) ?? ''
          } : undefined
          return createProvider(overrideConfig, this.settings, overrideResolved)
        },
        // ONLY reads from adf_identity — code_access + spec-D13 key-material guard.
        resolveIdentity: (purpose: string) => workspace.getIdentityForCode(purpose, derivedKey ?? null),
        getSigningKey: () => workspace.getSigningKeys(derivedKey ?? null)?.privateKey ?? null
      })
    }

    // Register sys_code tool if declared in agent config
    if (this.codeSandboxService && config.tools.some((t) => t.name === 'sys_code')) {
      agentToolRegistry.register(new SysCodeTool(this.codeSandboxService, filePath, adfCallHandler ?? undefined, config.limits?.execution_timeout_ms))
    }

    // Register sys_lambda tool if declared in agent config
    if (this.codeSandboxService && adfCallHandler && config.tools.some((t) => t.name === 'sys_lambda')) {
      agentToolRegistry.register(new SysLambdaTool(this.codeSandboxService, adfCallHandler, filePath, config.limits?.execution_timeout_ms))
    }

    // Compute tools: always register (shared container is always available)
    {
      const { isolatedContainerName } = await import('../services/podman.service')
      const computeSettings = this.settings.get('compute') as Record<string, unknown> | undefined
      const runtimeHostAllowed = computeSettings?.hostAccessEnabled === true
      const agentHostAllowed = !!config.compute?.host_access
      const targetSelection = resolveAgentComputeTargetSelection(computeSettings, config.compute)
      const bgComputeCaps: ComputeCapabilities = {
        hasIsolated: !!(config.compute?.enabled && this.podmanService),
        hasShared: !!this.podmanService,
        hasHost: agentHostAllowed && runtimeHostAllowed,
        ...targetSelection,
        isolatedContainerName: config.compute?.enabled ? isolatedContainerName(config.name, config.id) : undefined,
        browserDisplay: config.compute?.browser !== false,
        agentId: config.id,
        // Parity with the daemon builder: host-target compute_exec prompts
        // need OS/shell context or the model guesses the wrong syntax.
        hostInfo: agentHostAllowed && runtimeHostAllowed ? describeHostEnv() : undefined,
      }

      if (bgComputeCaps.hasIsolated && this.podmanService) {
        this.podmanService.ensureIsolatedRunning(config.name, config.id, config.compute?.packages?.pip, filePath, config.compute?.browser !== false)
          .then(() => this.podmanService!.ensureWorkspace(bgComputeCaps.isolatedContainerName!, '/workspace'))
          .catch(() => {})
      }

      agentToolRegistry.register(new FsTransferTool(this.podmanService ?? null, bgComputeCaps))
      agentToolRegistry.register(new ComputeExecTool(this.podmanService ?? null, bgComputeCaps, config.limits?.execution_timeout_ms))

      const legacyDecl = config.tools.find((t) => t.name === 'container_exec')
      if (legacyDecl) legacyDecl.name = 'compute_exec'
    }

    const streamBindingManager = new StreamBindingManager(config.id, config.name, filePath, config.stream_bind, this.wsConnectionManager, this.podmanService, workspace)
    agentToolRegistry.register(new StreamBindTool(streamBindingManager))
    agentToolRegistry.register(new StreamUnbindTool(streamBindingManager))
    agentToolRegistry.register(new StreamBindingsTool(streamBindingManager))

    // Wire fetch middleware deps into SysFetchTool
    if (this.codeSandboxService && adfCallHandler) {
      const fetchTool = agentToolRegistry.get('sys_fetch') as SysFetchTool | undefined
      if (fetchTool?.setMiddlewareDeps) {
        fetchTool.setMiddlewareDeps({
          codeSandboxService: this.codeSandboxService,
          adfCallHandler,
          agentId: filePath,
          getSecurityConfig: () => workspace.getAgentConfig().security
        })
      }
    }

    // Create the MCP manager UNCONDITIONALLY (parity with the Studio foreground):
    // mcp_install must be able to connect a server even when the agent started
    // with zero configured servers, so the manager + scratch dir exist up front.
    const scratchDir = createScratchDir(filePath)
    const mgr = new McpClientManager(scratchDir)
    let mcpManager: McpClientManager | null = mgr
    mgr.on('log', (serverName, entry) => {
      const level = entry.stream === 'stderr' ? 'warn' : 'info'
      try { workspace.insertLog(level, 'mcp', entry.stream, serverName, entry.message) } catch { /* ignore */ }
    })
    mgr.on('status-changed', (serverName, status, error) => {
      if (status === 'error') {
        try { workspace.insertLog('error', 'mcp', 'status', serverName, error ?? 'MCP server entered error state') } catch { /* ignore */ }
      }
    })

    // Set once the managed handle exists (see below). connectOneServer fans a
    // freshly-synced config out to this live executor after a hot install /
    // reconnect; during the initial connect loop it is still null (a no-op).
    let liveManaged: BackgroundManagedAgent | null = null

    // Connect ONE already-configured server, sync its discovered tools, persist,
    // and fan the fresh config out to the live executor. Shared by the initial
    // connect loop and the mcp_install / mcp_restart closures. Callers pass the
    // config to use: the initial loop passes the start-time `config`; the
    // closures pass workspace.getAgentConfig() so post-start config changes are
    // never clobbered by a stale start-time snapshot.
    const connectOneServer = async (
      freshConfig: AgentConfig,
      serverName: string,
      reason: string,
    ): Promise<McpConnectOutcome> => {
      const serverCfg = freshConfig.mcp?.servers?.find((s) => s.name === serverName)
      if (!serverCfg) throw new Error(`Server "${serverName}" not found.`)

      const mcpRegistrations = (this.settings.get('mcpServers') as McpServerRegistration[] | undefined) ?? []
      // Build a connection config — never mutate the original serverCfg to avoid
      // leaking decrypted secrets back into persisted config.
      const connCfg = { ...serverCfg }
      const reg = mcpRegistrations.find((r) => r.name === connCfg.name)
      if (reg?.toolCallTimeout) {
        connCfg.tool_call_timeout_ms = reg.toolCallTimeout * 1000
      }
      if (reg?.url && connCfg.transport === 'http') connCfg.url = reg.url
      if (reg?.headers?.length) {
        const appHeaders: Record<string, string> = {}
        for (const { key, value } of reg.headers) {
          if (key && value) appHeaders[key] = value
        }
        if (Object.keys(appHeaders).length) connCfg.headers = { ...connCfg.headers, ...appHeaders }
      }
      if (reg?.headerEnv?.length) {
        connCfg.header_env = [
          ...(connCfg.header_env ?? []),
          ...reg.headerEnv
            .filter((entry) => entry.key && entry.value)
            .map((entry) => ({ header: entry.key, env: entry.value, required: true }))
        ]
      }
      if (reg?.bearerTokenEnvVar) {
        connCfg.bearer_token_env_var = reg.bearerTokenEnvVar
      }

      const appEnvKeys: string[] = []
      if (reg?.env?.length) {
        const appEnv: Record<string, string> = {}
        for (const { key, value } of reg.env) {
          if (key && value) { appEnv[key] = value; appEnvKeys.push(key) }
        }
        if (Object.keys(appEnv).length) connCfg.env = { ...connCfg.env, ...appEnv }
      }

      const resolvedEnv = resolveMcpEnvVars(connCfg, (k) => workspace.getIdentityDecrypted(k, derivedKey ?? null))
      const agentEnvKeys = Object.keys(resolvedEnv)
      if (agentEnvKeys.length) {
        connCfg.env = { ...connCfg.env, ...resolvedEnv }
      }

      let uvBinPath: string | undefined
      if (connCfg.transport !== 'http' && (serverCfg.pypi_package || serverCfg.command === 'uvx')) {
        try { uvBinPath = await this.uvManager?.ensureUv() } catch (e) {
          console.warn('[BackgroundAgent][MCP] Failed to resolve uv binary:', e)
        }
      }

      // Compute environment routing: container vs host
      const computeSettings = (this.settings.get('compute') ?? { hostAccessEnabled: false, hostApproved: [] }) as ComputeSettings
      let connectOptions: import('../services/mcp-client-manager').McpConnectOptions | undefined
      let location: McpConnectOutcome['location'] = 'host'
      if (connCfg.transport === 'http') {
        location = 'remote http'
        console.log(`[BackgroundAgent][MCP] ${reason}: connecting "${connCfg.name}" (http): url=${connCfg.url}`)
      } else if (this.podmanService && shouldContainerize(connCfg.name, serverCfg, freshConfig, computeSettings)) {
        // Container path: resolve commands for in-container execution
        const { resolveContainerCommand } = await import('../services/container-command-resolver')
        const containerCmd = resolveContainerCommand(serverCfg)
        const isolated = shouldIsolate(freshConfig) && !isServerForceShared(serverCfg)
        location = isolated ? 'isolated container' : 'shared container'
        try {
          if (isolated) {
            await this.podmanService.ensureIsolatedRunning(freshConfig.name, freshConfig.id, freshConfig.compute?.packages?.pip)
          } else {
            await this.podmanService.ensureRunning()
          }
        } catch { /* fall through to host */ }
        const { isolatedContainerName } = await import('../services/podman.service')
        const podmanBin = await this.podmanService.findPodman()
        const containerName = isolated ? isolatedContainerName(freshConfig.name, freshConfig.id) : 'adf-mcp'
        try { await this.podmanService.ensureWorkspace(containerName, containerWorkspacePath(isolated, freshConfig.id)) } catch { /* ignore */ }
        if (podmanBin) {
          // Browser-dependent MCP servers need the container's browser
          // runtime env — parity with the Studio foreground connect path.
          let browserEnv: Record<string, string> = {}
          try { browserEnv = await this.podmanService.getBrowserRuntimeEnv() } catch { /* best effort */ }
          connectOptions = {
            externalTransport: new PodmanStdioTransport({
              podmanBin,
              containerName,
              command: containerCmd.command,
              args: containerCmd.args,
              env: { ...connCfg.env, ...browserEnv },
              cwd: containerWorkspacePath(isolated, freshConfig.id),
            })
          }
        }
      }

      // Host path: also the fallback when the containerized branch could not
      // produce a transport (e.g. podman binary missing) — parity with the
      // daemon builder, which never leaves an npm-package server without a
      // resolved spawn config.
      if (!connectOptions && connCfg.transport !== 'http') {
        const spawn = resolveMcpSpawnConfig(connCfg, { npmResolver: this.mcpPackageResolver, uvxResolver: this.uvxPackageResolver ?? undefined, uvBinPath })
        if (spawn.command) connCfg.command = spawn.command
        if (spawn.args) connCfg.args = spawn.args
      }

      const tools = await mgr.connect(connCfg, connectOptions)
      if (!tools) {
        const state = mgr.getServerState(serverName)
        const stderrTail = state?.logs.filter((l) => l.stream === 'stderr').slice(-5).map((l) => l.message)
        return { toolsDiscovered: 0, location, error: state?.error, stderrTail: stderrTail?.length ? stderrTail : undefined }
      }

      const changed = syncDiscoveredMcpTools(freshConfig, serverCfg, tools, agentToolRegistry, mgr)
      const nextSchema = captureEnvSchema(serverCfg, appEnvKeys, agentEnvKeys)
      if (nextSchema) serverCfg.env_schema = nextSchema
      if (changed || nextSchema) workspace.setAgentConfig(freshConfig)

      // Fan a fresh config out to the live executor — only once the managed
      // handle exists AND is still the one attached for this path (after a
      // foreground handoff the record is detached; persisting/fanning stale
      // config would clobber foreground-owned changes). Mirrors the late
      // tools-discovered listener below.
      const live = liveManaged
      if (live && this.agents.get(filePath) === live) {
        live.config = freshConfig
        live.executor.updateConfig(freshConfig)
        live.triggerEvaluator.updateConfig(freshConfig)
        live.adfCallHandler?.updateConfig(freshConfig)
      }
      return { toolsDiscovered: tools.length, location }
    }

    // Register the MCP management tools UNCONDITIONALLY. The .adf enabled/visible
    // flags govern per-call exposure + execution (in the shell/executor), NOT
    // registration — gating registration on the start-time config left the
    // background/daemon registry without these tools, so an agent that declared
    // mcp_install got "Tool not available" at call time (the bug fixed here).
    agentToolRegistry.register(new McpInstallTool(async (serverName, installOptions) => {
      const freshConfig = workspace.getAgentConfig()
      const serverCfg = freshConfig.mcp?.servers?.find((s) => s.name === serverName)
      if (!serverCfg) return
      // Interactive OAuth preflight needs a browser + confirmation dialog that no
      // background runtime has. Fail plainly rather than hang. The tool already
      // persisted the server, so foreground auth followed by mcp_restart recovers.
      if (installOptions?.auth && serverCfg.transport !== 'http') {
        throw new Error(HEADLESS_MCP_AUTH_UNAVAILABLE)
      }
      return connectOneServer(freshConfig, serverName, 'Hot-load')
    }))
    agentToolRegistry.register(new McpRestartTool(async (serverName) => {
      return connectOneServer(workspace.getAgentConfig(), serverName, 'Agent reconnect')
    }))
    agentToolRegistry.register(new McpUninstallTool((serverName) => {
      mgr.disconnect(serverName).catch(() => {})
    }))

    // Connect the servers already configured at start.
    if (config.mcp?.servers?.length) {
      try {
        const mcpRegistrations = (this.settings.get('mcpServers') as McpServerRegistration[] | undefined) ?? []
        const registeredNames = new Set(mcpRegistrations.map((r) => r.name))

        const connectPromise = Promise.allSettled(
          config.mcp.servers.map(async (serverCfg) => {
            // Skip servers not registered in Settings — unless they have a source
            // field (agent-installed via mcp_install or manually configured)
            if (!registeredNames.has(serverCfg.name) && !serverCfg.source) {
              console.log(`[BackgroundAgent][MCP] Skipping "${serverCfg.name}" — not registered in Settings`)
              return { name: serverCfg.name, skipped: true, attempted: false, connected: false }
            }
            try {
              const outcome = await connectOneServer(config, serverCfg.name, 'Initial connect')
              return { name: serverCfg.name, skipped: false, attempted: true, connected: outcome.toolsDiscovered > 0 }
            } catch (err) {
              console.error(`[BackgroundAgent][MCP] connect failed for "${serverCfg.name}": ${safeErrorString(err)}`)
              return { name: serverCfg.name, skipped: false, attempted: true, connected: false }
            }
          })
        )

        // Per-agent MCP connect budget: a single hung server must not stall
        // agent start (worst case previously 120s timeout x 3 retries). Past
        // the deadline the agent proceeds degraded — unconnected servers'
        // tools stay unavailable and auto-restart recovers in the background.
        const { timedOut, value: results } = await withDeadline(connectPromise, MCP_CONNECT_BUDGET_MS, () => {
          console.error(`[BackgroundAgent][MCP] Connect budget (${MCP_CONNECT_BUDGET_MS}ms) exceeded for ${basename(filePath, '.adf')} — starting degraded; pending MCP servers will keep connecting in the background`)
          try { workspace.insertLog('error', 'mcp', 'connect_timeout', null, `MCP connect budget exceeded after ${MCP_CONNECT_BUDGET_MS}ms — agent started degraded; pending servers recover in background`) } catch { /* ignore */ }
        })
        const settledResults = timedOut || !results ? [] : results

        let configChanged = false
        // Collect names of servers that connected or attempted (vs skipped/unregistered)
        const connectedServerNames = new Set<string>()
        const attemptedServerNames = new Set<string>()
        if (timedOut) {
          // Deadline hit: treat every registered server as "attempted" so the
          // disable-loop below does not persistently turn off tools for
          // servers that may still connect late or via auto-restart.
          for (const serverCfg of config.mcp.servers) {
            if (registeredNames.has(serverCfg.name) || serverCfg.source) attemptedServerNames.add(serverCfg.name)
          }
        }
        for (const result of settledResults) {
          if (result.status !== 'fulfilled' || result.value.skipped) continue
          if (result.value.attempted) attemptedServerNames.add(result.value.name)
          if (result.value.connected) connectedServerNames.add(result.value.name)
        }

        // Disable tools only from skipped (unregistered) servers — NOT from servers
        // that attempted connection but failed (e.g. timeout, auth error)
        for (const decl of config.tools) {
          if (!decl.name.startsWith('mcp_')) continue
          const serverName = config.mcp!.servers.find((s) => decl.name.startsWith(`mcp_${s.name}_`))?.name
          if (serverName && !connectedServerNames.has(serverName) && !attemptedServerNames.has(serverName) && decl.enabled) {
            decl.enabled = false
            configChanged = true
          }
        }

        if (configChanged) {
          workspace.setAgentConfig(config)
        }

        if (timedOut) {
          console.warn(`[BackgroundAgent] MCP setup degraded for ${basename(filePath, '.adf')} — connect budget exceeded, continuing without ${config.mcp.servers.length - connectedServerNames.size} unconnected server(s)`)
        } else {
          console.log(`[BackgroundAgent] MCP servers connected for ${basename(filePath, '.adf')}`)
        }
      } catch (mcpError) {
        // Setup-level failure (not a single server): the manager + scratch dir
        // stay alive — they are owned by the assembled lifecycle resources below
        // and remain available for mcp_install hot-load. Per-server connect
        // failures are already isolated inside connectOneServer.
        console.error(`[BackgroundAgent] MCP setup failed for ${basename(filePath, '.adf')}:`, mcpError)
      }
    }

    const sysGetConfigTool = agentToolRegistry.get('sys_get_config') as SysGetConfigTool | undefined
    sysGetConfigTool?.setToolDiscoveryProvider((ws) => buildToolDiscovery(ws.getAgentConfig(), agentToolRegistry))

    // --- Channel Adapter Setup ---
    let adapterManager: ChannelAdapterManager | null = null
    const adapterRegistrations = withBuiltInAdapterRegistrations(this.settings.get('adapters') as AdapterRegistration[] | undefined)
    if (adapterRegistrations.length > 0) {
      const adapterMgr = new ChannelAdapterManager()
      adapterMgr.on('log', (adapterType, entry) => {
        const level = entry.level === 'system' ? 'info' : entry.level
        try { workspace.insertLog(level, 'adapter', null, adapterType, entry.message) } catch { /* ignore */ }
      })
      adapterMgr.on('status-changed', (adapterType, status, error) => {
        if (status === 'error') {
          try { workspace.insertLog('error', 'adapter', 'status', adapterType, error ?? 'Adapter entered error state') } catch { /* ignore */ }
        }
      })

      // Adapters are independent of one another — start them in parallel.
      // Failures degrade to adapter-error status; the agent still starts.
      const configuredAdapters = config.adapters ?? {}
      await Promise.allSettled(adapterRegistrations.map(async (registration) => {
        const adapterType = registration.type
        const adapterConfig = getEnabledAgentAdapterConfig(configuredAdapters, adapterType)
        if (!adapterConfig) return

        // Envelope-sealed credentials that this process cannot unlock resolve
        // to null — the adapter would fail fast and never recover. Mark it
        // errored with a clear message instead of attempting.
        if (envelopesLocked && adapterCredentialsLocked(workspace, adapterType, derivedKey ?? null, registration.env)) {
          console.error(`[BackgroundAgent][Adapter] Skipping "${adapterType}" for ${basename(filePath, '.adf')} — envelope-sealed credentials are locked`)
          try { workspace.insertLog('error', 'adapter', 'credentials_locked', adapterType, 'Envelope-sealed credentials are locked in this process — adapter not started') } catch { /* ignore */ }
          await adapterMgr.startAdapter(adapterType, () => createLockedCredentialsAdapter(adapterType), adapterConfig, workspace, derivedKey, registration.env)
          return
        }

        // Resolve npm package
        const installed = registration.npmPackage ? this.adapterPackageResolver.getInstalled(registration.npmPackage) : null

        // Try in-tree built-in adapter first, then fall back to npm package
        let createFn: CreateAdapterFn | null = null
        try {
          createFn = await loadBuiltInAdapter(adapterType)
          if (!createFn && installed) {
            const mod = require(join(installed.installPath, 'node_modules', registration.npmPackage!))
            createFn = mod.createAdapter ?? mod.default?.createAdapter
          }
        } catch (err) {
          console.error(`[BackgroundAgent][Adapter] Failed to load "${adapterType}":`, err)
          return
        }

        if (!createFn) {
          console.warn(`[BackgroundAgent][Adapter] No createAdapter() found for "${adapterType}"`)
          return
        }

        try {
          const started = await adapterMgr.startAdapter(
            adapterType, createFn, adapterConfig, workspace, derivedKey, registration.env
          )
          if (started) {
            console.log(`[BackgroundAgent][Adapter] Started "${adapterType}" for ${basename(filePath, '.adf')}`)
          }
        } catch (err) {
          console.error(`[BackgroundAgent][Adapter] Failed to start "${adapterType}" for ${basename(filePath, '.adf')}: ${safeErrorString(err)}`)
          try { workspace.insertLog('error', 'adapter', 'start_failed', adapterType, safeErrorString(err).slice(0, 200)) } catch { /* ignore */ }
        }
      }))

      adapterManager = adapterMgr
    }

    streamBindingManager.loadDeclarations(config.stream_bindings ?? [])

    // Shared with the daemon and the Studio foreground — bus, taps,
    // agent.loaded/unloaded, and the adapter/MCP umbilical bridges all come
    // from runtime/umbilical-lifecycle.ts. Listed FIRST so its start runs
    // before every other resource and its stop runs last.
    const umbilical = createUmbilicalResources({
      agentId: config.id,
      workspace,
      filePath,
      config,
      codeSandboxService: this.codeSandboxService,
      adfCallHandler,
      adapterManager,
      mcpManager,
      onTapRegisterError: (err) => {
        console.error(`[BackgroundAgent] Failed to register umbilical taps for ${basename(filePath, '.adf')}: ${safeErrorString(err)}`)
        try { workspace.insertLog('error', 'runtime', 'tap_register_failed', null, safeErrorString(err).slice(0, 200)) } catch { /* non-fatal */ }
      },
    })

    const ownedMcpManager = mcpManager
    const ownedAdapterManager = adapterManager
    const ownedScratchDir = scratchDir
    const resources: LifecycleResource[] = [
      ...umbilical.resources,
      {
        name: 'code-sandbox',
        // Derived ids (`<agentId>:lambda:<file>:<fn>[:<invocation>]`, `:mw:`,
        // `:fn:`, `:tap:`) are reaped by prefix — cold lambdas mint a sandbox
        // id per invocation, so an exact-id destroy would leave them running.
        stop: () => {
          this.codeSandboxService?.destroyForAgent(filePath)
          this.codeSandboxService?.destroyForAgent(config.id)
        },
      },
      {
        name: 'compute-registration',
        stop: async () => {
          if (!this.podmanService || !config.compute?.enabled) return
          this.podmanService.unregisterAgent(config.id)
          await this.podmanService.stopIsolated(config.name, config.id).catch(() => {})
        },
      },
      {
        name: 'stream-bindings',
        stop: () => { streamBindingManager.stopAll('agent_stopped') },
      },
      {
        name: 'scratch-directory',
        stop: () => { removeScratchDir(ownedScratchDir) },
      },
      {
        name: 'channel-adapters',
        stop: async () => {
          ownedAdapterManager?.removeAllListeners()
          await ownedAdapterManager?.stopAll()
        },
      },
      {
        name: 'mcp-clients',
        stop: async () => {
          ownedMcpManager?.removeAllListeners()
          await ownedMcpManager?.disconnectAll()
        },
      },
    ]

    const systemScopeHandler = adfCallHandler && this.codeSandboxService
      ? new SystemScopeHandler(workspace, this.codeSandboxService, adfCallHandler, filePath)
      : null
    const assembledAgent = assembleAgent({
      profile: 'studioBackground',
      workspace,
      config,
      provider,
      registry: agentToolRegistry,
      session,
      basePrompt: this.basePrompt,
      toolPrompts: this.toolPrompts,
      compactionPrompt: this.compactionPrompt,
      adfCallHandler,
      systemScopeHandler,
      mcpManager,
      adapterManager,
      codeSandboxService: this.codeSandboxService,
      streamBindingManager,
      getTapManager: () => umbilical.lifecycle.getTapManager(),
      scratchDir,
      resources,
      ownsWorkspace: true,
    })

    // Compatibility aliases remain available to IPC and mesh consumers while
    // ownership and lifecycle live exclusively on the assembled handle.
    const managed: BackgroundManagedAgent = {
      assembledAgent,
      hostAttachment: null,
      filePath,
      workspace: assembledAgent.workspace,
      session: assembledAgent.session,
      executor: assembledAgent.executor,
      triggerEvaluator: assembledAgent.triggerEvaluator,
      config,
      state: 'idle',
      toolRegistry: assembledAgent.registry,
      accumulatedText: '',
      mcpManager: assembledAgent.mcpManager,
      adapterManager: assembledAgent.adapterManager,
      adfCallHandler: assembledAgent.adfCallHandler,
      scratchDir: assembledAgent.scratchDir,
      tapManager: assembledAgent.tapManager,
      streamBindingManager: assembledAgent.streamBindingManager,
    }

    // Arm connectOneServer's live-executor fan-out now that the managed handle
    // exists: mcp_install / mcp_restart closures fire after start and must push
    // freshly-discovered tools into this executor.
    liveManaged = managed

    // Late MCP connects (background retry after a failed initial connect, or
    // auto-restart after a drop) must register their tools exactly like
    // initial success — parity with the Studio foreground listener.
    // syncDiscoveredMcpTools is idempotent, so re-discovery of an
    // already-registered server does not duplicate.
    if (mcpManager) {
      const lateMcpManager = mcpManager
      lateMcpManager.on('tools-discovered', (serverName, tools) => {
        // The whole body is guarded: a throw here would propagate through
        // emit into the MCP retry promise and surface as an unhandledRejection.
        try {
          // After extraction to foreground this managed record is detached and
          // its config goes stale — persisting it would clobber config changes
          // made in the foreground. The foreground listener owns resync then.
          if (this.agents.get(filePath) !== managed) return
          const serverCfg = managed.config.mcp?.servers?.find((s) => s.name === serverName)
          if (!serverCfg) return
          if (syncDiscoveredMcpTools(managed.config, serverCfg, tools, agentToolRegistry, lateMcpManager)) {
            try { workspace.setAgentConfig(managed.config) } catch { /* best effort */ }
            managed.executor.updateConfig(managed.config)
            managed.triggerEvaluator.updateConfig(managed.config)
            managed.adfCallHandler?.updateConfig(managed.config)
          }
          console.log(`[BackgroundAgent][MCP] Registered ${tools.length} tools for "${serverName}" after late connect`)
        } catch (err) {
          console.error(`[BackgroundAgent][MCP] Late tools-discovered handling failed for "${serverName}": ${safeErrorString(err)}`)
        }
      })
    }

    managed.hostAttachment = assembledAgent.attachHost({
      beforeDispatch: () => {
        if (!this.agents.has(filePath)) throw new Error(`Background agent is no longer attached: ${filePath}`)
        this.touchActivity(filePath)
        this.rehydrateSessionIfEmpty(managed)
      },
      onTriggerError: (error, dispatch) => {
        if (!this.agents.has(filePath) || managed.executor.getState() === 'stopped') return
        const eventType = 'event' in dispatch ? dispatch.event.type : dispatch.events[0]?.type ?? 'batch'
        console.error(`[BackgroundAgent] Agent ${basename(filePath, '.adf')} execution error: ${safeErrorString(error)}`)
        try { workspace.insertLog('error', 'runtime', 'trigger_error', eventType, safeErrorString(error).slice(0, 200)) } catch { /* non-fatal */ }
        managed.state = 'error'
      },
      onStateOff: () => this.requestAgentOff(filePath),
      onConfigChanged: (updatedConfig) => {
        const previousName = managed.config.name
        managed.config = updatedConfig
        this.onAgentConfigChanged?.(filePath, updatedConfig)
        if (updatedConfig.name !== previousName) this.onAgentRenamed?.(filePath, updatedConfig.name)
        this.reconcileAgentAdapters(adapterManager, updatedConfig, workspace, derivedKey)
      },
      onAutostartChild: async (childPath) => this.startAgent(childPath),
      onAdapterInbound: (adapterType) => {
        this.emit('adapter_inbound', { filePath, type: adapterType })
        const allMessages = [...workspace.getInbox('unread'), ...workspace.getInbox('read')]
        this.emit('inbox_updated', {
          filePath,
          inbox: {
            version: 1,
            messages: allMessages.map(m => ({
              id: m.id,
              from: m.sender,
              sender: m.sender,
              reply_to: m.reply_to,
              source: m.source,
              content: m.payload,
              payload: m.payload,
              type: (m.intent ?? 'broadcast') as const,
              direction: 'incoming' as const,
              status: m.status,
              timestamp: m.received_at,
              received_at: m.received_at,
              sent_at: m.sent_at,
              trace_id: m.trace_id,
              parent_id: m.parent_id,
              replyTo: m.parent_id,
              intent: m.intent,
              attachments: m.attachments,
              source_meta: m.source_meta
            }))
          }
        })
      },
      onEvent: (event) => {
        if (!this.agents.has(filePath)) return
        if (event.type === 'state_changed') {
          const payload = event.payload as { state: string }
          managed.state = toDisplayState(payload.state)
          this.emitEvent({
            type: 'agent_state_changed',
            payload: { filePath, state: managed.state },
            timestamp: Date.now()
          })
        }
        if (event.type === 'text_delta') {
          managed.accumulatedText += (event.payload as { delta: string }).delta
        }
        if (event.type === 'tool_call_start') {
          this.flushAccumulatedText(managed)
          this.emitEvent({
            type: 'tool_call_start',
            payload: { filePath, ...(event.payload as Record<string, unknown>) },
            timestamp: event.timestamp
          })
        }
        if (event.type === 'tool_call_result' || event.type === 'ask_request' || event.type === 'tool_approval_request' ||
            event.type === 'response_metadata' || event.type === 'error' || event.type === 'turn_complete') {
          this.emitEvent({
            type: event.type,
            payload: { filePath, ...(event.payload as Record<string, unknown>) },
            timestamp: event.timestamp
          })
        }
        if (event.type === 'adf_file_created') {
          const payload = event.payload as Record<string, unknown>
          this.emitEvent({
            type: 'adf_file_created',
            payload: { agentFilePath: filePath, filePath: payload.filePath },
            timestamp: event.timestamp
          })
        }
        if (event.type === 'turn_complete') this.flushAccumulatedText(managed)
      },
    })

    // Renderer-facing adapter status only — the umbilical adapter.*/mcp.*
    // bridges are lifecycle resources (see `umbilical` above).
    if (adapterManager) {
      adapterManager.on('status-changed', (type, status, error) => {
        this.emit('adapter_status_changed', { filePath, type, status, error })
      })
    }

    // Shutdown race: stopAll may have snapshotted (and cleared) the agents map
    // while this setup was in flight. Registering now would let the agent
    // escape teardown entirely — dispose it instead.
    if (RuntimeGate.tearingDown || this.stopAllInProgress) {
      managed.hostAttachment?.detach()
      managed.hostAttachment = null
      await assembledAgent.disposeAsync({ mode: 'immediate' })
      throw new Error(`Runtime teardown in progress — not registering agent ${basename(filePath, '.adf')}`)
    }

    this.agents.set(filePath, managed)
    // Seed the idle clock at registration — see touchActivity call in the
    // transfer path for why an unseeded entry is immediately sweep-eligible.
    this.touchActivity(filePath)
    try {
      await assembledAgent.start()
      // Taps register inside the umbilical resource's start().
      managed.tapManager = assembledAgent.tapManager
    } catch (error) {
      managed.hostAttachment?.detach()
      managed.hostAttachment = null
      this.agents.delete(filePath)
      this.lastActivityTime.delete(filePath)
      await assembledAgent.disposeAsync({ mode: 'immediate' })
      throw error
    }
    return managed
  }

  private flushAccumulatedText(managed: BackgroundManagedAgent): void {
    // Accumulated text is no longer written to uiLog - the loop table handles this
    // via AgentSession. Just clear the accumulator.
    managed.accumulatedText = ''
  }

  /** Mark an agent as recently active (called on turn start/message receive). */
  private touchActivity(filePath: string): void {
    this.lastActivityTime.set(filePath, Date.now())
  }

  /**
   * Periodic sweep: for agents idle beyond IDLE_MEMORY_THRESHOLD_MS,
   * release their in-memory session history, freeing memory.
   * This is a soft cleanup -- the agent stays running and can still receive
   * triggers. The loop table already holds the full history (flushed at turn
   * end), so the session re-hydrates on the next trigger and the agent wakes
   * with the same context a restart would give it. Truncating instead
   * (the old compact(30)) silently cut the LLM context to 30 messages.
   */
  private sweepIdleAgents(): void {
    if (this.agents.size < 5) return // Not worth sweeping with few agents
    const now = Date.now()
    for (const [filePath, managed] of this.agents) {
      const lastActive = this.lastActivityTime.get(filePath) ?? 0
      if (now - lastActive < IDLE_MEMORY_THRESHOLD_MS) continue
      // Gate on the EXECUTOR's internal state, not managed.state: managed.state
      // holds display states (toDisplayState maps thinking/tool_use → 'active'),
      // so comparing it against executor-internal names never matched and the
      // sweep could reset a session mid-turn. The in-flight LLM response then
      // landed in the emptied session and every subsequent request silently ran
      // on a truncated context while the loop table kept the full history.
      // lastActivityTime alone must never authorize a release: it is touched
      // once per dispatch at turn start, and executor-internal re-entries
      // (error-recovery retries, queued-trigger drains) bypass it entirely.
      // Only a truly between-turns executor is safe: awaiting_approval/
      // awaiting_ask/suspended still hold a live turn whose messages must
      // survive.
      const executorState = managed.executor.getState()
      if (executorState !== 'idle' && executorState !== 'stopped' && executorState !== 'error') continue
      // The executor reports 'idle' during pre-thinking awaits inside an
      // accepted dispatch (top-of-turn auto-compact, provider validation) —
      // the lifecycle's in-flight set covers that whole span for turns entered
      // through dispatch(), and the executor's own turn counter covers the
      // re-entrant turns (interrupt restart, queued-trigger drain) that are
      // scheduled on process.nextTick and never reach dispatch() at all.
      if (managed.executor.isTurnActive()) continue
      if (managed.assembledAgent.hasInFlightDispatch()) continue
      // Undelivered code-authored context (loop_inject) lives only in memory —
      // unkeyed entries are never replayed from the loop, so a release here
      // drops them outright. Wait for the next turn to deliver them.
      if (managed.session.hasPendingContextInjections()) continue

      // Release large session histories to free memory
      const messageCount = managed.session.getMessages().length
      if (messageCount > 50) {
        managed.session.flushToLoop()
        // flushToLoop swallows transaction failures and KEEPS its buffer for a
        // later retry; reset() would wipe that buffer and lose the rows for
        // good. A failed flush means the loop table does NOT hold the full
        // history, so releasing the session would truncate context too.
        if (managed.session.hasPendingWrites()) continue
        managed.session.reset()
        // Leave a trace — a released session is invisible in the loop table,
        // and a silent release is indistinguishable from a context-loss bug.
        try {
          managed.workspace.insertLog('info', 'runtime', 'session_released', null,
            `Idle sweep released ${messageCount} in-memory messages (idle ${Math.round((now - lastActive) / 60000)}m); loop table retains full history, rehydrates on next dispatch`)
        } catch { /* non-fatal */ }
      }
      // SQLite auto-persists, no explicit save scheduling needed
    }
  }

  /** Restore the in-memory session from the loop table after an idle-sweep
   *  reset. No-op unless the session is empty while the loop has history. */
  private rehydrateSessionIfEmpty(managed: BackgroundManagedAgent): void {
    if (managed.session.getMessages().length > 0) return
    const loop = managed.workspace.getLoop()
    if (loop.length === 0) return
    managed.session.restoreMessages(loop.map(e => ({ role: e.role, content: e.content_json, created_at: e.created_at, seq: e.seq })))
  }

  private emitEvent(event: BackgroundAgentEvent): void {
    // Mirror start-lifecycle events into pendingStarts so a renderer that
    // mounts mid-boot can seed its spinners from getPendingStarts().
    const fp = event.payload.filePath
    if (event.type === 'agent_starting') this.pendingStarts.add(fp)
    else if (event.type === 'agent_started' || event.type === 'agent_start_failed' || event.type === 'agent_stopped') {
      this.pendingStarts.delete(fp)
    }
    this.emit('background_agent_event', event)
  }

  /** Clean up the idle sweep timer when the manager is destroyed */
  dispose(): void {
    if (this.idleSweepTimer) {
      clearInterval(this.idleSweepTimer)
      this.idleSweepTimer = null
    }
  }
}
