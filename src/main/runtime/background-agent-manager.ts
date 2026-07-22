import { EventEmitter } from 'events'
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
import { SysCodeTool, SysLambdaTool, SysGetConfigTool, SysFetchTool, FsTransferTool, ComputeExecTool, StreamBindTool, StreamUnbindTool, StreamBindingsTool, buildToolDiscovery } from '../tools/built-in'
import { registerBuiltInTools } from '../tools/built-in/register-built-in-tools'
import { StreamBindingManager } from './stream-binding-manager'
import type { ComputeCapabilities } from '../tools/built-in/compute-target'
import { AdfCallHandler } from './adf-call-handler'
import { TapManager } from './tap-manager'
import { ensureWorkspaceUmbilicalBus, destroyUmbilicalBus } from './umbilical-bus'
import { emitUmbilicalEvent } from './emit-umbilical'
import { withSource } from './execution-context'
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
import type { SettingsService } from '../services/settings.service'
import type { AgentConfig } from '../../shared/types/adf-v02.types'
import type { AgentState, BackgroundAgentStatus, BackgroundAgentEvent, McpServerRegistration, AdapterRegistration } from '../../shared/types/ipc.types'
import type { CreateAdapterFn } from '../../shared/types/channel-adapter.types'
import { loadBuiltInAdapter } from '../adapters/built-in-loaders'

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

interface BackgroundManagedAgent {
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
  private agents: Map<string, BackgroundManagedAgent> = new Map()
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

  hasAgent(filePath: string): boolean {
    return this.agents.has(filePath)
  }

  /**
   * Get the executor for a background agent (used for ask/approval resolution).
   */
  getExecutor(filePath: string): AgentExecutor | null {
    return this.agents.get(filePath)?.executor ?? null
  }

  /**
   * "Always approve" a tool for a background agent: drop its HIL gate
   * (enabled, un-restricted) so future calls run without asking, persist the
   * config, propagate to the live executor/trigger/call-handler + mesh cache,
   * then approve the pending request. Mirrors the foreground path in AgentLoop.
   */
  alwaysApproveTool(filePath: string, requestId: string, toolName: string): boolean {
    const managed = this.agents.get(filePath)
    if (!managed) return false
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
    const managed = this.agents.get(filePath)
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
    const managed = this.agents.get(filePath)
    if (managed) this.rehydrateSessionIfEmpty(managed)
  }

  /**
   * Check whether a background agent's current turn was triggered by an incoming message.
   */
  getIsMessageTriggered(filePath: string): boolean {
    const managed = this.agents.get(filePath)
    return managed?.executor.isMessageTriggered ?? false
  }

  /**
   * Enumerate all running agent file paths for mesh registration.
   */
  getAllAgentFilePaths(): string[] {
    return Array.from(this.agents.keys())
  }

  /**
   * Start an agent from an .adf file (sidebar/directory toggle).
   * Opens the SQLite database, creates workspace/session/executor, and starts running.
   */
  async startAgent(filePath: string, derivedKey?: Buffer | null): Promise<boolean> {
    if (this.agents.has(filePath)) return true

    try {
      const workspace = AdfWorkspace.open(filePath)
      // Unlock envelope-sealed keys/credentials for this workspace instance (spec D10)
      unlockWorkspaceEnvelopes(workspace)
      const config = workspace.getAgentConfig()

      const session = new AgentSession(workspace)
      const existingLoop = workspace.getLoop()
      if (existingLoop.length > 0) {
        session.restoreMessages(existingLoop.map(e => ({ role: e.role, content: e.content_json, created_at: e.created_at })))
      }

      await this.setupManagedAgent(filePath, config as AgentConfig, workspace, session, derivedKey)

      // Owner hold persisted in adf_meta: a manually-started held agent comes
      // up held (resumable from the fleet map). The executor constructor also
      // reads this key, but set it explicitly so the ordering is unambiguous.
      // The held gate in the executor suppresses the startup turn below.
      if (workspace.getMeta('held') === '1') {
        this.agents.get(filePath)?.executor.setHeld(true)
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
    const managed = this.agents.get(filePath)
    if (!managed) return false

    // Claim teardown before awaiting so concurrent stop entry points cannot
    // emit duplicate stop events or retain a second owner for this handle.
    this.agents.delete(filePath)

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
   * Stop all background agents (app shutdown).
   */
  async stopAll(): Promise<void> {
    // Stop idle sweep timer first to prevent any interaction during shutdown
    if (this.idleSweepTimer) {
      clearInterval(this.idleSweepTimer)
      this.idleSweepTimer = null
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

    for (const filePath of uniqueFiles) {
      await this.tryAutostart(filePath)
    }
  }

  /**
   * Start an agent if its config has autostart enabled and it passes the
   * gates (not already running, not password-protected, reviewed).
   * Used by the boot scan and by the tracked-dir watcher when a new .adf
   * file appears. Returns true if the agent was started.
   */
  async tryAutostart(filePath: string): Promise<boolean> {
    if (this.agents.has(filePath)) return false
    const name = basename(filePath, '.adf')

    const peek = AdfDatabase.peekBootStatus(filePath)
    if (!peek || !peek.autostart) return false

    if (peek.hasEncryptedIdentity) {
      console.warn(`[BackgroundAgent] Skipping autostart for ${name} — password-protected`)
      return false
    }

    // Review gate: no review, or changed reviewed config, means no autostart.
    const reviewWorkspace = AdfWorkspace.open(filePath)
    let reviewed = false
    let held = false
    try {
      reviewed = isConfigReviewed(this.settings.get('reviewedAgents'), reviewWorkspace.getAgentConfig())
      held = reviewWorkspace.getMeta('held') === '1'
    } finally {
      reviewWorkspace.close()
    }
    if (!reviewed) {
      console.warn(`[BackgroundAgent] Skipping autostart for ${name} — not yet reviewed`)
      return false
    }
    if (held) {
      console.warn(`[BackgroundAgent] Skipping autostart for ${name} — held by owner`)
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
        managed.config = updatedConfig
        this.onAgentConfigChanged?.(filePath, updatedConfig)
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
    return managed
  }

  private attachMcpUmbilicalListeners(agentId: string, filePath: string, mcpManager: McpClientManager | null): void {
    if (!mcpManager) return
    mcpManager.on('status-changed', (name, status, error) => {
      withSource('system:mcp', agentId, () => {
        emitUmbilicalEvent({
          event_type: 'mcp.status.changed',
          payload: { filePath, name, status, error }
        })
      })
    })
    mcpManager.on('tools-discovered', (name, tools) => {
      withSource('system:mcp', agentId, () => {
        emitUmbilicalEvent({
          event_type: 'mcp.tools.discovered',
          payload: { filePath, name, toolCount: tools.length }
        })
      })
    })
    mcpManager.on('log', (name, entry) => {
      withSource('system:mcp', agentId, () => {
        emitUmbilicalEvent({
          event_type: 'mcp.log',
          timestamp: entry.timestamp,
          payload: { filePath, name, entry }
        })
      })
    })
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
    derivedKey?: Buffer | null
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
      const targetSelection = resolveAgentComputeTargetSelection(computeSettings, config.compute)
      const bgComputeCaps: ComputeCapabilities = {
        hasIsolated: !!(config.compute?.enabled && this.podmanService),
        hasShared: !!this.podmanService,
        hasHost: !!config.compute?.host_access && runtimeHostAllowed,
        ...targetSelection,
        isolatedContainerName: config.compute?.enabled ? isolatedContainerName(config.name, config.id) : undefined,
        agentId: config.id,
      }

      if (bgComputeCaps.hasIsolated && this.podmanService) {
        this.podmanService.ensureIsolatedRunning(config.name, config.id, config.compute?.packages?.pip)
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

    // Connect MCP servers
    let mcpManager: McpClientManager | null = null
    let scratchDir: string | null = null
    if (config.mcp?.servers?.length) {
      scratchDir = createScratchDir(filePath)
      const mgr = new McpClientManager(scratchDir)
      mgr.on('log', (serverName, entry) => {
        const level = entry.stream === 'stderr' ? 'warn' : 'info'
        try { workspace.insertLog(level, 'mcp', entry.stream, serverName, entry.message) } catch { /* ignore */ }
      })
      mgr.on('status-changed', (serverName, status, error) => {
        if (status === 'error') {
          try { workspace.insertLog('error', 'mcp', 'status', serverName, error ?? 'MCP server entered error state') } catch { /* ignore */ }
        }
      })
      try {
        // Load Settings registrations to filter unregistered servers
        const mcpRegistrations = (this.settings.get('mcpServers') as McpServerRegistration[] | undefined) ?? []
        const registeredNames = new Set(mcpRegistrations.map((r) => r.name))

        // Pre-resolve uv binary path once for all servers that need it
        const needsUv = config.mcp.servers.some((s) => s.pypi_package || s.command === 'uvx')
        let uvBinPath: string | undefined
        if (needsUv && this.uvManager) {
          try { uvBinPath = await this.uvManager.ensureUv() } catch (e) {
            console.warn('[BackgroundAgent][MCP] Failed to resolve uv binary:', e)
          }
        }

        const results = await Promise.allSettled(
          config.mcp.servers.map(async (serverCfg) => {
            // Skip servers not registered in Settings — unless they have a source
            // field (agent-installed via mcp_install or manually configured)
            if (!registeredNames.has(serverCfg.name) && !serverCfg.source) {
              console.log(`[BackgroundAgent][MCP] Skipping "${serverCfg.name}" — not registered in Settings`)
              return { serverCfg, tools: null as import('../../shared/types/adf-v02.types').McpToolInfo[] | null, skipped: true }
            }

            // Build a connection config — never mutate the original serverCfg
            // to avoid leaking decrypted secrets back into persisted config
            const connCfg = { ...serverCfg }

            // Wire per-server timeout from Settings registration
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

            // Merge app-wide credentials from Settings registration (env key/value pairs)
            const appEnvKeys: string[] = []
            if (reg?.env?.length) {
              const appEnv: Record<string, string> = {}
              for (const { key, value } of reg.env) {
                if (key && value) { appEnv[key] = value; appEnvKeys.push(key) }
              }
              if (Object.keys(appEnv).length) {
                connCfg.env = { ...connCfg.env, ...appEnv }
              }
            }

            // Resolve env vars from identity keystore (per-agent credentials)
            const resolvedEnv = resolveMcpEnvVars(connCfg, (k) => workspace.getIdentityDecrypted(k, derivedKey ?? null))
            const agentEnvKeys = Object.keys(resolvedEnv)
            if (agentEnvKeys.length) {
              connCfg.env = { ...connCfg.env, ...resolvedEnv }
            }

            // Compute environment routing: container vs host
            const computeSettings = (this.settings.get('compute') ?? { hostAccessEnabled: false, hostApproved: [] }) as ComputeSettings
            let connectOptions: import('../services/mcp-client-manager').McpConnectOptions | undefined
            if (connCfg.transport === 'http') {
              console.log(`[BackgroundAgent][MCP] Connecting "${connCfg.name}" (http): url=${connCfg.url}`)
            } else if (this.podmanService && shouldContainerize(connCfg.name, serverCfg, config, computeSettings)) {
              // Container path: resolve commands for in-container execution
              const { resolveContainerCommand } = await import('../services/container-command-resolver')
              const containerCmd = resolveContainerCommand(serverCfg)
              const isolated = shouldIsolate(config) && !isServerForceShared(serverCfg)
              try {
                if (isolated) {
                  await this.podmanService.ensureIsolatedRunning(config.name, config.id, config.compute?.packages?.pip)
                } else {
                  await this.podmanService.ensureRunning()
                }
              } catch { /* fall through to host */ }
              const { isolatedContainerName } = await import('../services/podman.service')
              const podmanBin = await this.podmanService.findPodman()
              const containerName = isolated ? isolatedContainerName(config.name, config.id) : 'adf-mcp'
              try { await this.podmanService.ensureWorkspace(containerName, containerWorkspacePath(isolated, config.id)) } catch { /* ignore */ }
              if (podmanBin) {
                connectOptions = {
                  externalTransport: new PodmanStdioTransport({
                    podmanBin,
                    containerName,
                    command: containerCmd.command,
                    args: containerCmd.args,
                    env: connCfg.env,
                    cwd: containerWorkspacePath(isolated, config.id),
                  })
                }
              }
            } else {
              // Host path: resolve commands using host-installed packages
              const spawn = resolveMcpSpawnConfig(connCfg, { npmResolver: this.mcpPackageResolver, uvxResolver: this.uvxPackageResolver ?? undefined, uvBinPath })
              if (spawn.command) connCfg.command = spawn.command
              if (spawn.args) connCfg.args = spawn.args
            }

            const tools = await mgr.connect(connCfg, connectOptions)
            return { serverCfg, tools, skipped: false, appEnvKeys, agentEnvKeys }
          })
        )

        let configChanged = false

        // Collect names of servers that connected or attempted (vs skipped/unregistered)
        const connectedServerNames = new Set<string>()
        const attemptedServerNames = new Set<string>()
        for (const result of results) {
          if (result.status !== 'fulfilled') continue
          if (result.value.skipped) continue
          attemptedServerNames.add(result.value.serverCfg.name)
          if (!result.value.tools) continue
          const { serverCfg, tools, appEnvKeys, agentEnvKeys } = result.value
          connectedServerNames.add(serverCfg.name)

          if (syncDiscoveredMcpTools(config, serverCfg, tools, agentToolRegistry, mgr)) {
            configChanged = true
          }

          const nextSchema = captureEnvSchema(serverCfg, appEnvKeys ?? [], agentEnvKeys ?? [])
          if (nextSchema) {
            serverCfg.env_schema = nextSchema
            configChanged = true
          }

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

        mcpManager = mgr
        console.log(`[BackgroundAgent] MCP servers connected for ${basename(filePath, '.adf')}`)
      } catch (mcpError) {
        console.error(`[BackgroundAgent] MCP setup failed for ${basename(filePath, '.adf')}:`, mcpError)
        await mgr.disconnectAll()
        removeScratchDir(scratchDir)
        scratchDir = null
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

      const configuredAdapters = config.adapters ?? {}
      for (const registration of adapterRegistrations) {
        const adapterType = registration.type
        const adapterConfig = getEnabledAgentAdapterConfig(configuredAdapters, adapterType)
        if (!adapterConfig) continue

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
          continue
        }

        if (!createFn) {
          console.warn(`[BackgroundAgent][Adapter] No createAdapter() found for "${adapterType}"`)
          continue
        }

        const started = await adapterMgr.startAdapter(
          adapterType, createFn, adapterConfig, workspace, derivedKey, registration.env
        )
        if (started) {
          console.log(`[BackgroundAgent][Adapter] Started "${adapterType}" for ${basename(filePath, '.adf')}`)
        }
      }

      adapterManager = adapterMgr
    }

    const bus = ensureWorkspaceUmbilicalBus(config.id, workspace)
    let tapManager: TapManager | null = null
    const taps = config.umbilical_taps ?? []
    if (taps.length > 0 && this.codeSandboxService && adfCallHandler) {
      tapManager = new TapManager(config.id, workspace, bus, this.codeSandboxService, adfCallHandler)
      await tapManager.register(taps)
    }
    streamBindingManager.loadDeclarations(config.stream_bindings ?? [])

    const ownedMcpManager = mcpManager
    const ownedAdapterManager = adapterManager
    const ownedTapManager = tapManager
    const ownedScratchDir = scratchDir
    const resources: LifecycleResource[] = [
      {
        name: 'code-sandbox',
        stop: () => { this.codeSandboxService?.destroy(filePath) },
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
        name: 'umbilical',
        start: () => withSource('system:lifecycle', config.id, () => {
          emitUmbilicalEvent({
            event_type: 'agent.loaded',
            payload: { filePath, name: config.name, handle: config.handle, autostart: config.autostart ?? false }
          })
        }),
        stop: () => {
          withSource('system:lifecycle', config.id, () => {
            emitUmbilicalEvent({ event_type: 'agent.unloaded', payload: { filePath } })
          })
          destroyUmbilicalBus(config.id)
        },
      },
      {
        name: 'taps',
        stop: () => { ownedTapManager?.dispose() },
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
      tapManager,
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
        managed.config = updatedConfig
        this.onAgentConfigChanged?.(filePath, updatedConfig)
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

    if (adapterManager) {
      adapterManager.on('status-changed', (type, status, error) => {
        this.emit('adapter_status_changed', { filePath, type, status, error })
        withSource('system:adapter', config.id, () => {
          emitUmbilicalEvent({ event_type: 'adapter.status.changed', payload: { filePath, type, status, error } })
        })
      })
      adapterManager.on('log', (type, entry) => {
        withSource('system:adapter', config.id, () => {
          emitUmbilicalEvent({ event_type: 'adapter.log', timestamp: entry.timestamp, payload: { filePath, type, entry } })
        })
      })
    }
    this.attachMcpUmbilicalListeners(config.id, filePath, mcpManager)

    this.agents.set(filePath, managed)
    try {
      await assembledAgent.start()
    } catch (error) {
      managed.hostAttachment?.detach()
      managed.hostAttachment = null
      this.agents.delete(filePath)
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
      if (managed.state === 'thinking' || managed.state === 'tool_use') continue

      // Release large session histories to free memory
      const messageCount = managed.session.getMessages().length
      if (messageCount > 50) {
        managed.session.flushToLoop()
        managed.session.reset()
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
    managed.session.restoreMessages(loop.map(e => ({ role: e.role, content: e.content_json, created_at: e.created_at })))
  }

  private emitEvent(event: BackgroundAgentEvent): void {
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
