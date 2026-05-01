import { EventEmitter } from 'events'
import { basename, join } from 'path'
import { deriveHandle } from '../utils/handle'
import { nanoid } from 'nanoid'
import { AgentExecutor } from './agent-executor'
import { AgentSession } from './agent-session'
import { TriggerEvaluator } from './trigger-evaluator'
import { AdfWorkspace } from '../adf/adf-workspace'
import { AdfDatabase } from '../adf/adf-database'
import { isConfigReviewed } from '../services/agent-review'
import { ToolRegistry } from '../tools/tool-registry'
import { SysCodeTool, SysLambdaTool, SysGetConfigTool, SysUpdateConfigTool, SysFetchTool, CreateAdfTool, FsTransferTool, ComputeExecTool, StreamBindTool, StreamUnbindTool, StreamBindingsTool, buildToolDiscovery } from '../tools/built-in'
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
import { getEnabledAgentAdapterConfig, withBuiltInAdapterRegistrations } from '../../shared/constants/adapter-registry'
import type { SettingsService } from '../services/settings.service'
import type { AgentConfig } from '../../shared/types/adf-v02.types'
import type { AgentState, BackgroundAgentStatus, BackgroundAgentEvent, McpServerRegistration, AdapterRegistration } from '../../shared/types/ipc.types'
import type { CreateAdapterFn } from '../../shared/types/channel-adapter.types'
import { createEvent, createDispatch, type AdfEventDispatch, type AdfBatchDispatch } from '../../shared/types/adf-event.types'

/** Map executor internal states to display states for the UI. */
function toDisplayState(executorState: string): AgentState {
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
      codeSandboxService: this.codeSandboxService
    }
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
      const config = workspace.getAgentConfig()

      const session = new AgentSession(workspace)
      const existingLoop = workspace.getLoop()
      if (existingLoop.length > 0) {
        session.restoreMessages(existingLoop.map(e => ({ role: e.role, content: e.content_json })))
      }

      await this.setupManagedAgent(filePath, config as AgentConfig, workspace, session, derivedKey)

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
      const startState = config.start_in_state ?? 'active'
      if (startState === 'active') {
        const managed = this.agents.get(filePath)
        if (managed) {
          process.nextTick(() => {
            managed.executor.executeTurn(createDispatch(createEvent({ type: 'startup' as const, source: 'system', data: undefined }), { scope: 'agent' })).catch((error) => {
              console.error(`[BackgroundAgent] Start turn error: ${safeErrorString(error)}`)
              managed.state = 'error'
            })
          })
        }
      }

      return true
    } catch (err) {
      console.error(`[BackgroundAgent] Failed to start ${filePath}: ${safeErrorString(err)}`)
      return false
    }
  }

  /**
   * Transition a foreground agent to background when the user switches files.
   *
   * When an existing executor is provided, it is adopted as-is so an in-progress
   * turn continues running in the background. If not provided, a new executor is
   * created (fallback — should not happen in normal flow).
   */
  async transitionToBackground(
    filePath: string,
    config: AgentConfig,
    session: AgentSession,
    workspace: AdfWorkspace,
    existingExecutor?: AgentExecutor,
    existingTriggerEvaluator?: TriggerEvaluator,
    existingToolRegistry?: ToolRegistry,
    mcpManager?: McpClientManager | null,
    adapterManager?: ChannelAdapterManager | null,
    adfCallHandler?: AdfCallHandler | null,
    scratchDir?: string | null,
    streamBindingManager?: StreamBindingManager | null
  ): Promise<void> {
    if (this.agents.has(filePath)) return

    let initialState: AgentState = 'idle'

    if (existingExecutor) {
      // Adopt the running executor — preserves in-progress turn
      const managed = this.adoptExistingAgent(
        filePath, config, workspace, session,
        existingExecutor, existingTriggerEvaluator!, existingToolRegistry!,
        mcpManager, adapterManager, adfCallHandler, scratchDir, streamBindingManager
      )
      initialState = managed.state
    } else {
      await this.setupManagedAgent(filePath, config, workspace, session)
    }

    this.emitEvent({
      type: 'agent_started',
      payload: { filePath, state: initialState, handle: config.handle || deriveHandle(filePath) },
      timestamp: Date.now()
    })

    console.log(`[BackgroundAgent] Transitioned ${basename(filePath, '.adf')} to background (state: ${initialState})`)
  }

  /**
   * Extract a background agent's workspace, session, executor, and tool registry
   * so they can be reused as a foreground agent. The executor is NOT aborted —
   * any in-progress turn continues running. Event listeners are removed so the
   * foreground AGENT_START can attach its own.
   */
  extractBackgroundAgent(filePath: string): {
    workspace: AdfWorkspace
    session: AgentSession
    executor: AgentExecutor
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

    // Remove all event listeners from executor — foreground will re-attach its own.
    // This prevents duplicate event forwarding from stale listeners.
    managed.executor.removeAllListeners('event')

    // Capture display state before disposing trigger evaluator
    const displayState = managed.triggerEvaluator.getDisplayState()

    // Dispose trigger evaluator to prevent double-firing when foreground creates a new one
    managed.triggerEvaluator.dispose()

    // Dispose the background TapManager — foreground will create its own against the same bus.
    // Bus itself stays in the registry since the agent is still running, just under foreground.
    if (managed.tapManager) {
      try { managed.tapManager.dispose() } catch { /* best-effort */ }
      managed.tapManager = null
    }

    // Remove from map but do NOT close workspace/session/executor
    this.agents.delete(filePath)

    this.emitEvent({
      type: 'agent_stopped',
      payload: { filePath },
      timestamp: Date.now()
    })

    console.log(`[BackgroundAgent] Extracted ${basename(filePath, '.adf')} for foreground use`)
    return {
      workspace: managed.workspace,
      session: managed.session,
      executor: managed.executor,
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

    // Each step is independently try-caught so a corrupt DB never prevents shutdown.
    try { this.flushAccumulatedText(managed) } catch { /* ignore */ }
    try { managed.triggerEvaluator.dispose() } catch { /* ignore */ }
    try { managed.executor.abort() } catch { /* ignore */ }
    try { if (managed.mcpManager) { managed.mcpManager.removeAllListeners(); await managed.mcpManager.disconnectAll(); managed.mcpManager = null } } catch { /* ignore */ }
    try { removeScratchDir(managed.scratchDir); managed.scratchDir = null } catch { /* ignore */ }
    try { if (managed.adapterManager) { managed.adapterManager.removeAllListeners(); await managed.adapterManager.stopAll(); managed.adapterManager = null } } catch { /* ignore */ }
    try { if (managed.streamBindingManager) { managed.streamBindingManager.stopAll('agent_stopped'); managed.streamBindingManager = null } } catch { /* ignore */ }
    try {
      withSource('system:lifecycle', managed.config.id, () => {
        emitUmbilicalEvent({ event_type: 'agent.unloaded', payload: { filePath } })
      })
    } catch { /* ignore */ }
    try { if (managed.tapManager) { managed.tapManager.dispose(); managed.tapManager = null } } catch { /* ignore */ }
    try { destroyUmbilicalBus(managed.config.id) } catch { /* ignore */ }
    try { if (this.codeSandboxService) this.codeSandboxService.destroy(filePath) } catch { /* ignore */ }
    try { if (this.podmanService && managed.config.compute?.enabled) this.podmanService.unregisterAgent(managed.config.id) } catch { /* ignore */ }
    try { if (this.podmanService && managed.config.compute?.enabled) this.podmanService.stopIsolated(managed.config.name, managed.config.id).catch(() => {}) } catch { /* ignore */ }
    try { managed.workspace.close() } catch { /* ignore */ }

    this.agents.delete(filePath)

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

    if (this.codeSandboxService) {
      this.codeSandboxService.destroyAll()
    }

    for (const [fp, managed] of this.agents) {
      try { managed.triggerEvaluator.dispose() } catch { /* ignore */ }
      try { managed.executor.abort() } catch { /* ignore */ }
      try { if (managed.mcpManager) { managed.mcpManager.removeAllListeners(); await managed.mcpManager.disconnectAll(); managed.mcpManager = null } } catch { /* ignore */ }
      try { removeScratchDir(managed.scratchDir); managed.scratchDir = null } catch { /* ignore */ }
      try { if (managed.adapterManager) { managed.adapterManager.removeAllListeners(); await managed.adapterManager.stopAll(); managed.adapterManager = null } } catch { /* ignore */ }
      try { if (managed.streamBindingManager) { managed.streamBindingManager.stopAll('agent_stopped'); managed.streamBindingManager = null } } catch { /* ignore */ }
      try { managed.workspace.close() } catch (e) { console.error(`[BackgroundAgent] close error for ${fp}:`, e) }
    }
    this.agents.clear()

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
      if (this.agents.has(filePath)) continue
      const name = basename(filePath, '.adf')

      const peek = AdfDatabase.peekBootStatus(filePath)
      if (!peek || !peek.autostart) continue

      if (peek.hasEncryptedIdentity) {
        console.warn(`[BackgroundAgent] Skipping autostart for ${name} — password-protected`)
        continue
      }

      // Review gate: no review, or changed reviewed config, means no autostart.
      const reviewWorkspace = AdfWorkspace.open(filePath)
      let reviewed = false
      try {
        reviewed = isConfigReviewed(this.settings.get('reviewedAgents'), reviewWorkspace.getAgentConfig())
      } finally {
        reviewWorkspace.close()
      }
      if (!reviewed) {
        console.warn(`[BackgroundAgent] Skipping autostart for ${name} — not yet reviewed`)
        continue
      }

      try {
        await this.startAgent(filePath)
        console.log(`[BackgroundAgent] Autostarted ${name}`)
      } catch (err) {
        console.warn(`[BackgroundAgent] Failed to autostart ${name}: ${safeErrorString(err)}`)
      }
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

  /**
   * Adopt an existing foreground executor and trigger evaluator as a background agent.
   * The executor keeps running (its in-progress turn is not interrupted).
   * We attach our own event listener for state tracking.
   *
   * The old event listener from AGENT_START is still attached but becomes a no-op:
   * - It only forwards to renderer if currentFilePath matches (no longer true)
   */
  private adoptExistingAgent(
    filePath: string,
    config: AgentConfig,
    workspace: AdfWorkspace,
    session: AgentSession,
    executor: AgentExecutor,
    triggerEvaluator: TriggerEvaluator,
    toolRegistry: ToolRegistry,
    mcpManager?: McpClientManager | null,
    adapterManager?: ChannelAdapterManager | null,
    adfCallHandler?: AdfCallHandler | null,
    scratchDir?: string | null,
    streamBindingManager?: StreamBindingManager | null
  ): BackgroundManagedAgent {
    const currentState = executor.getState()

    const managed: BackgroundManagedAgent = {
      filePath,
      workspace,
      session,
      executor,
      triggerEvaluator,
      config,
      state: toDisplayState(currentState),
      toolRegistry,
      accumulatedText: '',
      mcpManager: mcpManager ?? null,
      adapterManager: adapterManager ?? null,
      adfCallHandler: adfCallHandler ?? null,
      scratchDir: scratchDir ?? null,
      tapManager: null,
      streamBindingManager: streamBindingManager ?? null
    }

    // Umbilical bus + taps — must exist for emitUmbilicalEvent to reach agent sandbox.
    {
      const bus = ensureWorkspaceUmbilicalBus(config.id, workspace)
      const taps = config.umbilical_taps ?? []
      if (taps.length > 0 && this.codeSandboxService && adfCallHandler) {
        const tm = new TapManager(config.id, workspace, bus, this.codeSandboxService, adfCallHandler)
        tm.register(taps).catch(err => {
          console.error(`[BackgroundAgent] Tap registration failed for ${config.id}:`, err)
        })
        managed.tapManager = tm
      }
    }

    // Replace stale foreground listeners with background-scoped ones.
    // The foreground listeners have closures over the module-level agentExecutor
    // variable (now null after cleanupCurrentFile), so they silently drop triggers.
    // Also remove 'event' listeners — otherwise stale events still get sent to
    // the renderer and show up in whichever agent is in the foreground.
    triggerEvaluator.removeAllListeners('trigger')
    triggerEvaluator.removeAllListeners('event')
    triggerEvaluator.on('trigger', async (dispatch: AdfEventDispatch | AdfBatchDispatch) => {
      if (RuntimeGate.stopped) return
      if (!this.agents.has(filePath)) return
      const agentDisplayName = basename(filePath, '.adf')
      const eventType = 'event' in dispatch ? dispatch.event.type : dispatch.events[0]?.type ?? 'batch'
      if (process.env.NODE_ENV !== 'production') console.log(`[BackgroundAgent] Trigger fired for ${agentDisplayName}: type=${eventType}`)
      this.touchActivity(filePath)
      try {
        await executor.executeTurn(dispatch)
      } catch (error) {
        if (!this.agents.has(filePath) || executor.getState() === 'stopped') return
        console.error(`[BackgroundAgent] Agent ${agentDisplayName} execution error: ${safeErrorString(error)}`)
        managed.state = 'error'
      }
    })

    // Attach listener for state changes
    // Loop entries are written directly by AgentSession via workspace.appendToLoop()
    executor.on('event', (event) => {
      // Guard: stop processing after extraction to foreground
      if (!this.agents.has(filePath)) return

      if (event.type === 'state_changed') {
        const payload = event.payload as { state: string }
        managed.state = toDisplayState(payload.state)

        // Propagate display state to trigger evaluator for state gating
        if (managed.triggerEvaluator) {
          managed.triggerEvaluator.setDisplayState(payload.state)
        }

        this.emitEvent({
          type: 'agent_state_changed',
          payload: { filePath, state: managed.state },
          timestamp: Date.now()
        })

        // Hard off: trigger centralized teardown when the agent transitions to 'off'.
        if (payload.state === 'off') {
          this.requestAgentOff(filePath)
        }
      }

      // Accumulate text for display purposes
      if (event.type === 'text_delta') {
        const payload = event.payload as { delta: string }
        managed.accumulatedText += payload.delta
      }

      if (event.type === 'tool_call_start') {
        this.flushAccumulatedText(managed)
        this.emitEvent({
          type: 'tool_call_start',
          payload: { filePath, ...(event.payload as Record<string, unknown>) },
          timestamp: event.timestamp
        })
      }

      if (event.type === 'tool_call_result') {
        this.emitEvent({
          type: 'tool_call_result',
          payload: { filePath, ...(event.payload as Record<string, unknown>) },
          timestamp: event.timestamp
        })
      }

      if (event.type === 'ask_request' || event.type === 'tool_approval_request') {
        this.emitEvent({
          type: event.type,
          payload: { filePath, ...(event.payload as Record<string, unknown>) },
          timestamp: event.timestamp
        })
      }

      // Refresh tracked directories when a background agent creates a new ADF file
      if (event.type === 'adf_file_created') {
        const eventPayload = event.payload as Record<string, unknown>
        this.emitEvent({
          type: 'adf_file_created',
          payload: { agentFilePath: filePath, filePath: eventPayload.filePath },
          timestamp: event.timestamp
        })
      }

      if (event.type === 'turn_complete') {
        this.flushAccumulatedText(managed)
        // SQLite auto-persists, no explicit save needed
      }
    })

    // Re-wire task lifecycle callbacks to point to the adopted trigger evaluator
    executor.onToolCallIntercepted = (tool, args, taskId, origin, systemScopeHandled) => {
      triggerEvaluator.onToolCall(tool, args, taskId, origin, systemScopeHandled)
    }
    executor.onTaskCreated = (task) => {
      triggerEvaluator.onTaskCreate(task)
    }
    executor.onTaskCompleted = (taskId, tool, status, result, error, sideEffects) => {
      triggerEvaluator.onTaskComplete(taskId, tool, status, result, error)
      if (sideEffects?.endTurn && tool === 'sys_set_state' && status === 'completed' && result) {
        try {
          const parsed = JSON.parse(result)
          if (parsed.target_state) executor.applyDeferredStateTransition(parsed.target_state)
        } catch { /* ignore parse errors */ }
      }
    }
    executor.onLlmCall = (data) => {
      triggerEvaluator.onLlmCall(data)
    }

    // Re-wire adfCallHandler callbacks. The previous wiring (foreground IPC) holds
    // closures over disposed objects — without rewiring, lambda-initiated state
    // transitions silently drop on agents that were once foreground.
    if (adfCallHandler) {
      adfCallHandler.onTaskCompleted = (taskId, tool, status, result, error, sideEffects) => {
        triggerEvaluator.onTaskComplete(taskId, tool, status, result, error)
        if (sideEffects?.endTurn && tool === 'sys_set_state' && status === 'completed' && result) {
          try {
            const parsed = JSON.parse(result)
            if (parsed.target_state) executor.applyDeferredStateTransition(parsed.target_state)
          } catch { /* ignore parse errors */ }
        }
      }
      adfCallHandler.onLambdaToolEndTurn = (tool, resultContent) => {
        if (tool !== 'sys_set_state') return
        try {
          const parsed = JSON.parse(resultContent)
          if (parsed.target_state) executor.applyDeferredStateTransition(parsed.target_state)
        } catch { /* ignore parse errors */ }
      }
      adfCallHandler.onHilApproved = (taskId, approved, modifiedArgs) => {
        executor.resolveHilTask(taskId, approved, modifiedArgs)
      }
      adfCallHandler.onLlmCall = (data) => {
        triggerEvaluator.onLlmCall(data)
      }
    }

    // Wire sys_update_config propagation callback
    const sysUpdateTool = toolRegistry.get('sys_update_config') as SysUpdateConfigTool | undefined
    if (sysUpdateTool) {
      sysUpdateTool.onConfigChanged = (updatedConfig) => {
        executor.updateConfig(updatedConfig)
        triggerEvaluator.updateConfig(updatedConfig)
        adfCallHandler?.updateConfig(updatedConfig)
        this.onAgentConfigChanged?.(filePath, updatedConfig)
      }
    }

    // Wire sys_create_adf autostart callback
    const createAdfTool = toolRegistry.get('sys_create_adf') as CreateAdfTool | undefined
    if (createAdfTool) {
      createAdfTool.onAutostartChild = async (childPath) => this.startAgent(childPath)
    }

    // Re-wire adapter inbound events from stale foreground listeners to background.
    // The foreground 'inbound' listener uses module-level triggerEvaluator (now null).
    if (adapterManager) {
      adapterManager.removeAllListeners('inbound')
      adapterManager.removeAllListeners('status-changed')
      adapterManager.on('inbound', (adapterType: string, adapterMsg: any, meta: any) => {
        const unread = workspace.getInbox('unread')
        const read = workspace.getInbox('read')
        const allMessages = [...unread, ...read]

        this.emit('inbox_updated', {
          filePath,
          inbox: {
            version: 1,
            messages: allMessages.map((m: any) => ({
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

        const sender = `${adapterType}:${adapterMsg.sender}`
        triggerEvaluator.onInbox(sender, adapterMsg.payload, {
          source: adapterType,
          messageId: meta.inboxId,
          parentId: meta.parentId,
          sourceMeta: adapterMsg.sourceMeta
        })
      })

      adapterManager.on('status-changed', (type: string, status: string, error?: string) => {
        this.emit('adapter_status_changed', { filePath, type, status, error })
        withSource('system:adapter', config.id, () => {
          emitUmbilicalEvent({
            event_type: 'adapter.status.changed',
            payload: { filePath, type, status, error }
          })
        })
      })
      adapterManager.on('log', (type, entry) => {
        withSource('system:adapter', config.id, () => {
          emitUmbilicalEvent({
            event_type: 'adapter.log',
            timestamp: entry.timestamp,
            payload: { filePath, type, entry }
          })
        })
      })
    }
    this.attachMcpUmbilicalListeners(config.id, filePath, managed.mcpManager)

    this.agents.set(filePath, managed)
    withSource('system:lifecycle', config.id, () => {
      emitUmbilicalEvent({
        event_type: 'agent.loaded',
        payload: { filePath, name: config.name, handle: config.handle, autostart: config.autostart ?? false }
      })
    })
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
        resolveIdentity: (purpose: string) => {
          // ONLY reads from adf_identity — never falls back to app-level settings.
          const row = workspace.getIdentityRow(purpose)
          if (!row) return null
          if (!row.code_access) return null
          return workspace.getIdentityDecrypted(purpose, derivedKey ?? null)
        }
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
      const bgComputeCaps: ComputeCapabilities = {
        hasIsolated: !!(config.compute?.enabled && this.podmanService),
        hasShared: !!this.podmanService,
        hasHost: !!config.compute?.host_access,
        isolatedContainerName: config.compute?.enabled ? isolatedContainerName(config.name, config.id) : undefined,
        agentId: config.id,
      }

      if (bgComputeCaps.hasIsolated && this.podmanService) {
        this.podmanService.ensureIsolatedRunning(config.name, config.id)
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
                  await this.podmanService.ensureIsolatedRunning(config.name, config.id)
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

        // Try in-tree adapter first (e.g., telegram), then npm package
        let createFn: CreateAdapterFn | null = null
        try {
          if (adapterType === 'telegram') {
            const mod = await import('../adapters/telegram/index')
            createFn = mod.createAdapter
          } else if (adapterType === 'email') {
            const mod = await import('../adapters/email/index')
            createFn = mod.createAdapter
          } else if (installed) {
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

    const executor = new AgentExecutor(
      config,
      provider,
      agentToolRegistry,
      session,
      this.basePrompt,
      this.toolPrompts,
      this.compactionPrompt
    )

    // Set up system scope handler if adf handler is available
    if (adfCallHandler && this.codeSandboxService) {
      executor.setSystemScopeHandler(
        new SystemScopeHandler(workspace, this.codeSandboxService, adfCallHandler, filePath)
      )
    }

    const managed: BackgroundManagedAgent = {
      filePath,
      workspace,
      session,
      executor,
      triggerEvaluator: null!,
      config,
      state: 'idle',
      toolRegistry: agentToolRegistry,
      accumulatedText: '',
      mcpManager,
      adapterManager,
      adfCallHandler,
      scratchDir,
      tapManager: null,
      streamBindingManager
    }

    // Umbilical bus + taps for setupManagedAgent path
    {
      const bus = ensureWorkspaceUmbilicalBus(config.id, workspace)
      const taps = config.umbilical_taps ?? []
      if (taps.length > 0 && this.codeSandboxService && adfCallHandler) {
        const tm = new TapManager(config.id, workspace, bus, this.codeSandboxService, adfCallHandler)
        await tm.register(taps)
        managed.tapManager = tm
      }
      streamBindingManager.loadDeclarations(config.stream_bindings ?? [])
    }

    // Listen for state changes
    // Loop entries are written directly by AgentSession via workspace.appendToLoop()
    executor.on('event', (event) => {
      if (event.type === 'state_changed') {
        const payload = event.payload as { state: string }
        managed.state = toDisplayState(payload.state)

        // Propagate display state to trigger evaluator for state gating
        if (managed.triggerEvaluator) {
          managed.triggerEvaluator.setDisplayState(payload.state)
        }

        this.emitEvent({
          type: 'agent_state_changed',
          payload: { filePath, state: managed.state },
          timestamp: Date.now()
        })

        // Hard off: trigger centralized teardown when the agent transitions to 'off'.
        // Covers LLM-initiated, lambda-initiated, HIL-initiated, and mid-turn deferred paths.
        if (payload.state === 'off') {
          this.requestAgentOff(filePath)
        }
      }

      // Accumulate text for display purposes
      if (event.type === 'text_delta') {
        const payload = event.payload as { delta: string }
        managed.accumulatedText += payload.delta
      }

      if (event.type === 'tool_call_start') {
        this.flushAccumulatedText(managed)
        this.emitEvent({
          type: 'tool_call_start',
          payload: { filePath, ...(event.payload as Record<string, unknown>) },
          timestamp: event.timestamp
        })
      }

      if (event.type === 'tool_call_result') {
        this.emitEvent({
          type: 'tool_call_result',
          payload: { filePath, ...(event.payload as Record<string, unknown>) },
          timestamp: event.timestamp
        })
      }

      if (event.type === 'ask_request' || event.type === 'tool_approval_request') {
        this.emitEvent({
          type: event.type,
          payload: { filePath, ...(event.payload as Record<string, unknown>) },
          timestamp: event.timestamp
        })
      }

      // Refresh tracked directories when a background agent creates a new ADF file
      if (event.type === 'adf_file_created') {
        const eventPayload = event.payload as Record<string, unknown>
        this.emitEvent({
          type: 'adf_file_created',
          payload: { agentFilePath: filePath, filePath: eventPayload.filePath },
          timestamp: event.timestamp
        })
      }

      if (event.type === 'turn_complete') {
        this.flushAccumulatedText(managed)
        // SQLite auto-persists, no explicit save needed
      }
    })

    // Set up trigger evaluator
    const triggerEvaluator = new TriggerEvaluator(config)
    triggerEvaluator.setDisplayState(config.start_in_state ?? 'idle')
    triggerEvaluator.on('trigger', async (dispatch: AdfEventDispatch | AdfBatchDispatch) => {
      if (RuntimeGate.stopped) return
      if (!this.agents.has(filePath)) return
      const agentDisplayName = basename(filePath, '.adf')
      const eventType = 'event' in dispatch ? dispatch.event.type : dispatch.events[0]?.type ?? 'batch'
      if (process.env.NODE_ENV !== 'production') console.log(`[BackgroundAgent] Trigger fired for ${agentDisplayName}: type=${eventType}`)
      this.touchActivity(filePath)
      try {
        await executor.executeTurn(dispatch)
      } catch (error) {
        // If the agent was intentionally stopped (abort), don't treat as error
        if (!this.agents.has(filePath) || executor.getState() === 'stopped') return
        console.error(`[BackgroundAgent] Agent ${agentDisplayName} execution error: ${safeErrorString(error)}`)
        try { workspace.insertLog('error', 'runtime', 'trigger_error', eventType, safeErrorString(error).slice(0, 200)) } catch { /* non-fatal */ }
        managed.state = 'error'
      }
    })
    triggerEvaluator.startTimerPolling(workspace)
    triggerEvaluator.setWorkspace(workspace)
    managed.triggerEvaluator = triggerEvaluator

    // Wire on_logs trigger
    workspace.setOnLogCallback((level, origin, event, target, message) => {
      triggerEvaluator.onLog(level, origin, event, target, message)
    })

    // Wire task lifecycle callbacks
    executor.onToolCallIntercepted = (tool, args, taskId, origin, systemScopeHandled) => {
      triggerEvaluator.onToolCall(tool, args, taskId, origin, systemScopeHandled)
    }
    executor.onTaskCreated = (task) => {
      triggerEvaluator.onTaskCreate(task)
    }
    executor.onTaskCompleted = (taskId, tool, status, result, error, sideEffects) => {
      triggerEvaluator.onTaskComplete(taskId, tool, status, result, error)
      if (sideEffects?.endTurn && tool === 'sys_set_state' && status === 'completed' && result) {
        try {
          const parsed = JSON.parse(result)
          if (parsed.target_state) executor.applyDeferredStateTransition(parsed.target_state)
        } catch { /* ignore parse errors */ }
      }
    }
    executor.onLlmCall = (data) => {
      triggerEvaluator.onLlmCall(data)
    }
    if (adfCallHandler) {
      adfCallHandler.onTaskCompleted = (taskId, tool, status, result, error, sideEffects) => {
        triggerEvaluator.onTaskComplete(taskId, tool, status, result, error)
        if (sideEffects?.endTurn && tool === 'sys_set_state' && status === 'completed' && result) {
          try {
            const parsed = JSON.parse(result)
            if (parsed.target_state) executor.applyDeferredStateTransition(parsed.target_state)
          } catch { /* ignore parse errors */ }
        }
      }
      adfCallHandler.onLambdaToolEndTurn = (tool, resultContent) => {
        if (tool !== 'sys_set_state') return
        try {
          const parsed = JSON.parse(resultContent)
          if (parsed.target_state) executor.applyDeferredStateTransition(parsed.target_state)
        } catch { /* ignore parse errors */ }
      }
      adfCallHandler.onHilApproved = (taskId, approved, modifiedArgs) => {
        executor.resolveHilTask(taskId, approved, modifiedArgs)
      }
      adfCallHandler.onLlmCall = (data) => {
        triggerEvaluator.onLlmCall(data)
      }
    }

    // Wire sys_update_config propagation callback
    const sysUpdateTool = agentToolRegistry.get('sys_update_config') as SysUpdateConfigTool | undefined
    if (sysUpdateTool) {
      sysUpdateTool.onConfigChanged = (updatedConfig) => {
        executor.updateConfig(updatedConfig)
        triggerEvaluator.updateConfig(updatedConfig)
        adfCallHandler?.updateConfig(updatedConfig)
        this.onAgentConfigChanged?.(filePath, updatedConfig)
      }
    }

    // Wire sys_create_adf autostart callback
    const createAdfTool = agentToolRegistry.get('sys_create_adf') as CreateAdfTool | undefined
    if (createAdfTool) {
      createAdfTool.onAutostartChild = async (childPath) => this.startAgent(childPath)
    }

    // Wire adapter inbound events to trigger evaluator + renderer
    if (adapterManager) {
      adapterManager.on('inbound', (adapterType, adapterMsg, meta) => {
        const unread = workspace.getInbox('unread')
        const read = workspace.getInbox('read')
        const allMessages = [...unread, ...read]

        // Emit inbox update for renderer (IPC layer forwards to window)
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

        // Fire on_inbox trigger with the adapter's source (e.g. 'telegram')
        const sender = `${adapterType}:${adapterMsg.sender}`
        triggerEvaluator.onInbox(sender, adapterMsg.payload, {
          source: adapterType,
          messageId: meta.inboxId,
          parentId: meta.parentId,
          sourceMeta: adapterMsg.sourceMeta
        })
      })

      adapterManager.on('status-changed', (type, status, error) => {
        this.emit('adapter_status_changed', { filePath, type, status, error })
        withSource('system:adapter', config.id, () => {
          emitUmbilicalEvent({
            event_type: 'adapter.status.changed',
            payload: { filePath, type, status, error }
          })
        })
      })
      adapterManager.on('log', (type, entry) => {
        withSource('system:adapter', config.id, () => {
          emitUmbilicalEvent({
            event_type: 'adapter.log',
            timestamp: entry.timestamp,
            payload: { filePath, type, entry }
          })
        })
      })
    }
    this.attachMcpUmbilicalListeners(config.id, filePath, mcpManager)

    this.agents.set(filePath, managed)
    withSource('system:lifecycle', config.id, () => {
      emitUmbilicalEvent({
        event_type: 'agent.loaded',
        payload: { filePath, name: config.name, handle: config.handle, autostart: config.autostart ?? false }
      })
    })
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
   * compact their session history if it's large, freeing memory.
   * This is a soft cleanup -- the agent stays running and can still receive triggers.
   */
  private sweepIdleAgents(): void {
    if (this.agents.size < 5) return // Not worth sweeping with few agents
    const now = Date.now()
    for (const [filePath, managed] of this.agents) {
      const lastActive = this.lastActivityTime.get(filePath) ?? 0
      if (now - lastActive < IDLE_MEMORY_THRESHOLD_MS) continue
      if (managed.state === 'thinking' || managed.state === 'tool_use') continue

      // Compact large session histories to free memory
      const messageCount = managed.session.getMessages().length
      if (messageCount > 50) {
        managed.session.compact(30)
      }
      // SQLite auto-persists, no explicit save scheduling needed
    }
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
