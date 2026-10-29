import { AdfCallHandler } from './adf-call-handler'
import { SystemScopeHandler } from './system-scope-handler'
import { assembleAgent, type AssembledAgent } from './assemble-agent'
import { join } from 'path'
import { ToolRegistry } from '../tools/tool-registry'
import { registerBuiltInTools } from '../tools/built-in/register-built-in-tools'
import {
  ComputeExecTool,
  FsTransferTool,
  SysCodeTool,
  NpmInstallTool,
  NpmUninstallTool,
  SysLambdaTool,
  SysFetchTool,
  SysGetConfigTool,
  StreamBindTool,
  StreamUnbindTool,
  StreamBindingsTool,
  McpInstallTool,
  McpRestartTool,
  McpUninstallTool,
  buildToolDiscovery,
  type McpConnectOutcome,
} from '../tools/built-in'
import { StreamBindingManager } from './stream-binding-manager'
import { registerMcpConnector } from './mcp-connectors'
import { createUmbilicalResources } from './umbilical-lifecycle'
import { isolatedContainerName, containerWorkspacePath, containerAgentHome } from '../services/podman.service'
import { resolveHostEnv } from '../services/host-exec.service'
import type { WsConnectionManager } from '../services/ws-connection-manager'
import type { PodmanService } from '../services/podman.service'
import type { CodeSandboxService } from './code-sandbox'
import type { SandboxPackagesService } from '../services/sandbox-packages.service'
import type { LLMProvider } from '../providers/provider.interface'
import type { AgentExecutor } from './agent-executor'
import type { AdfWorkspace } from '../adf/adf-workspace'
import type { AgentConfig, McpServerConfig, McpToolInfo, ModelConfig } from '../../shared/types/adf-v02.types'
import { buildComputeCapabilities, liveComputeCapabilities, type ComputeCapabilityInputs } from '../tools/built-in/compute-capabilities'
import type { RuntimeSettingsStore } from './runtime-service'
import { McpClientManager } from '../services/mcp-client-manager'
import { createScratchDir, removeScratchDir } from '../utils/scratch-dir'
import { PackageResolver } from '../services/mcp-package-resolver'
import { captureEnvSchema, resolveMcpEnvVars, resolveMcpSpawnConfig } from '../services/mcp-spawn-utils'
import type { UvxPackageResolver } from '../services/uvx-package-resolver'
import type { UvManager } from '../services/uv-manager'
import { PodmanStdioTransport } from '../services/podman-stdio-transport'
import { prepareMcpContainer, ComputeUnavailableError } from '../services/mcp-container-ready'
import { containerLinkedFileReader } from '../services/mcp-linked-files'
import { shouldContainerize, shouldIsolate, isServerForceShared, hostDenialReason, type ComputeSettings } from '../services/container-routing'
import { resolveContainerCommand } from '../services/container-command-resolver'
import { syncDiscoveredMcpTools, resyncServerTools, diffMcpServerNames } from '../services/mcp-tool-sync'
import type { McpServerRegistration } from '../../shared/types/ipc.types'
import { pinServerConfigToRegistration } from '../../shared/utils/mcp-config'
import { ChannelAdapterManager } from '../services/channel-adapter-manager'
import type { AdapterRegistration, ChannelAdapter, CreateAdapterFn } from '../../shared/types/channel-adapter.types'
import { getEnabledAgentAdapterConfig, withBuiltInAdapterRegistrations } from '../../shared/constants/adapter-registry'
import { loadBuiltInAdapter } from '../adapters/built-in-loaders'
import { withDeadline } from '../utils/concurrency'
import { createHeadlessMcpAuthPreflight, type McpAuthPreflightRunner } from '../services/mcp-auth-preflight'
import { materializeCredentialFiles, writeBackCredentialFiles, containerCredentialTarget, type CredentialFileTarget } from '../services/mcp-credential-files'
import { AgentKeystoreOAuthStore, resolveOAuthStoreForConnect } from '../services/mcp-oauth-store'
import { buildOAuthProviderFactory, gateInteractiveOAuthSignIn, MCP_OAUTH_AUTHORIZE_APPROVAL } from '../services/mcp-oauth-connect'
import { runMcpHttpOAuthFlow, type McpHttpOAuthIO } from '../services/mcp-http-oauth'
import { canonicalizeServerUrl, type McpOAuthStore } from '../services/mcp-oauth.types'
import { ensureCoreToolDeclarations } from './core-tool-declarations'
import { emitAgentConfigChanged, emitAgentDerivedKeyChanged } from './agent-runtime-signals'

/**
 * Per-agent budget for connecting all MCP servers. A hung server previously
 * stalled agent start for up to 120s x 3 retries; past this budget the agent
 * starts degraded and the MCP auto-restart machinery recovers in background.
 */
const MCP_CONNECT_BUDGET_MS = 25_000

export interface AgentRuntimeBuilderOptions {
  settings?: RuntimeSettingsStore
  codeSandboxService?: CodeSandboxService | null
  /** Backs npm_install / npm_uninstall. Absent = those tools are not offered. */
  sandboxPackagesService?: SandboxPackagesService | null
  podmanService?: PodmanService | null
  wsConnectionManager?: WsConnectionManager | null
  mcpPackageResolver?: PackageResolver
  adapterPackageResolver?: PackageResolver
  uvxPackageResolver?: UvxPackageResolver | null
  uvManager?: UvManager | null
  basePrompt?: string
  toolPrompts?: Record<string, string>
  compactionPrompt?: string
  /**
   * Interactive-auth preflight for agent-installed MCP servers. Defaults to
   * the headless runner (best-effort browser open + wait for the auth
   * subcommand to exit); hosts with a UI can inject an interactive runner.
   */
  mcpAuthPreflight?: McpAuthPreflightRunner
  /**
   * Appended to the locked-credentials-envelope error so headless hosts can
   * name their concrete recovery path (the daemon points at its public-key
   * file and the Studio trusted-daemon-keys setting).
   */
  credentialEnvelopeLockedHint?: string
  /**
   * App-level MCP OAuth token store (the daemon's counterpart of Studio's
   * `mcpOauthCredentials`). When set, a token signed in at app level is sealed
   * into the agent before an http+oauth connect (Studio's capture-on-attach),
   * and an interactive sign-in stores into it first. Absent: the agent
   * keystore is the only store.
   */
  mcpOAuthAppStore?: McpOAuthStore | null
  /** Interactive HTTP-OAuth flow runner. Tests inject a fake; defaults to runMcpHttpOAuthFlow. */
  mcpHttpOAuthFlow?: typeof runMcpHttpOAuthFlow
}

export interface BuildAgentRuntimeOptions {
  workspace: AdfWorkspace
  filePath: string | null
  config: AgentConfig
  provider: LLMProvider
  restoreLoop?: boolean
  createProviderForModel?: (model: ModelConfig) => LLMProvider
  /**
   * Legacy-password derived key when the host already holds one (an agent
   * unlocked before start). Later unlocks go through applyDerivedKey.
   */
  derivedKey?: Buffer | null
  /**
   * Prompt settings as the host read them for this start (Studio reads them
   * at every AGENT_START, so a settings change applies to the next start).
   * Absent: the prompts the builder was constructed with.
   */
  prompts?: AgentRuntimePrompts
}

/** The three prompt settings an agent is assembled with. */
export interface AgentRuntimePrompts {
  basePrompt: string
  /** The settings' app system prompt, read each turn (an edit applies at the next turn). */
  basePromptSource?: () => unknown
  toolPrompts: Record<string, string>
  compactionPrompt?: string
}

/** What applyDerivedKey restarted so its credentials take effect. */
export interface DerivedKeyApplyResult {
  /** False when the agent was not built by this builder (nothing to update). */
  applied: boolean
  /** Channel adapters restarted with credentials that needed the key. */
  adaptersRestarted: string[]
  /** MCP servers reconnected with credentials that needed the key. */
  mcpReconnected: string[]
}

/** Mutable cell the per-agent closures read, so an unlock reaches every consumer. */
interface DerivedKeyRef {
  current: Buffer | null
}

/** Per-agent state the builder keeps for post-build operations. */
interface BuiltAgentState {
  workspace: AdfWorkspace
  label: string
  keyRef: DerivedKeyRef
  mcpManager: McpClientManager | null
  adapterManager: ChannelAdapterManager | null
  connectMcpServer: (serverName: string, reason: string) => Promise<McpConnectOutcome>
}

/**
 * `interactive`: an agent call that may raise the OAuth sign-in now.
 * `deferSignIn`: an http+oauth server left without a token is marked
 * `needs_sign_in` and signed in on the agent's next turn instead.
 */
interface McpConnectOpts {
  interactive: boolean
  deferSignIn?: boolean
  /** Interactive beside a turn (deferred sign-in): approvals use restoreState. */
  outsideTurn?: boolean
}

/** Whether an OAuth token is stored after prepareHttpOAuth. */
type OAuthReadiness = 'signed_in' | 'no_token' | 'unknown'

/** Input of an `mcp_oauth_authorize` request. */
interface AuthorizeInput {
  server: string
  url: string
  authorize_url: string
}

interface PrepareHttpOAuthParams {
  serverCfg: McpServerConfig
  url: string
  registration: McpServerRegistration | undefined
  workspace: AdfWorkspace
  keyRef: DerivedKeyRef
  executor: AgentExecutor | null
  signIns: Set<AbortController>
  /** Raised outside a turn: each approval restores the executor state. */
  restoreState: boolean
}

/** The agent's MCP wiring, as registerMcpTools returns it. */
interface McpRuntime {
  manager: McpClientManager | null
  scratchDir: string | null
  connect: (freshConfig: AgentConfig, serverName: string, reason: string, opts: McpConnectOpts) => Promise<McpConnectOutcome>
  reconcile: (nextConfig: AgentConfig) => Promise<void>
  abortInteractiveSignIns: () => void
  /** Raise the sign-ins deferred to this agent's next LLM turn (host beforeDispatch, not awaited). */
  runDeferredSignIns: () => Promise<void>
}

/**
 * Builds a fully wired headless agent runtime.
 *
 * This is daemon-first extraction of the runtime setup that Studio currently
 * performs inside BackgroundAgentManager. Studio keeps its existing path for
 * now; the daemon uses this builder so parity can grow without renderer/IPC
 * churn.
 */
export class AgentRuntimeBuilder {
  private readonly settings?: RuntimeSettingsStore
  private readonly codeSandboxService: CodeSandboxService | null
  private readonly sandboxPackagesService: SandboxPackagesService | null
  private readonly podmanService: PodmanService | null
  private readonly wsConnectionManager: WsConnectionManager | null
  private readonly mcpPackageResolver: PackageResolver
  private readonly adapterPackageResolver: PackageResolver
  private readonly uvxPackageResolver: UvxPackageResolver | null
  private readonly uvManager: UvManager | null
  private readonly basePrompt: string
  private readonly toolPrompts: Record<string, string>
  private readonly compactionPrompt?: string
  private readonly mcpAuthPreflight: McpAuthPreflightRunner
  private readonly credentialEnvelopeLockedHint?: string
  private readonly mcpOAuthAppStore: McpOAuthStore | null
  private readonly mcpHttpOAuthFlow: typeof runMcpHttpOAuthFlow
  /** Keyed by the assembled handle the builder returned. */
  private readonly builtAgents = new WeakMap<object, BuiltAgentState>()
  /** The same states keyed by workspace, for calls that only carry the workspace. */
  private readonly builtByWorkspace = new WeakMap<AdfWorkspace, BuiltAgentState>()

  constructor(opts: AgentRuntimeBuilderOptions = {}) {
    this.settings = opts.settings
    this.codeSandboxService = opts.codeSandboxService ?? null
    this.sandboxPackagesService = opts.sandboxPackagesService ?? null
    this.podmanService = opts.podmanService ?? null
    this.wsConnectionManager = opts.wsConnectionManager ?? null
    this.mcpPackageResolver = opts.mcpPackageResolver ?? new PackageResolver('mcp-servers')
    this.adapterPackageResolver = opts.adapterPackageResolver ?? new PackageResolver('channel-adapters')
    this.uvxPackageResolver = opts.uvxPackageResolver ?? null
    this.uvManager = opts.uvManager ?? null
    this.basePrompt = opts.basePrompt ?? ''
    this.toolPrompts = opts.toolPrompts ?? {}
    this.compactionPrompt = opts.compactionPrompt
    this.mcpAuthPreflight = opts.mcpAuthPreflight ?? createHeadlessMcpAuthPreflight()
    this.credentialEnvelopeLockedHint = opts.credentialEnvelopeLockedHint
    this.mcpOAuthAppStore = opts.mcpOAuthAppStore ?? null
    this.mcpHttpOAuthFlow = opts.mcpHttpOAuthFlow ?? runMcpHttpOAuthFlow
  }

  async build(opts: BuildAgentRuntimeOptions): Promise<AssembledAgent<'daemon'>> {
    const { workspace, filePath, config, provider } = opts
    const agentId = filePath ?? config.id
    const label = filePath ?? config.id
    // Every credential read below goes through this cell: an unlock after
    // start (applyDerivedKey) reaches MCP, adapters and AdfCallHandler alike.
    const keyRef: DerivedKeyRef = { current: opts.derivedKey ?? null }
    if (keyRef.current) emitAgentDerivedKeyChanged(workspace, keyRef.current)

    // Inbox and stream-binding declarations, in the running config and the
    // file — the same shared helper both Studio hosts call.
    ensureCoreToolDeclarations(config, workspace, filePath ?? config.id)
    // Backward compat, running config only (as Studio): container_exec →
    // compute_exec. AdfDatabase migrates the stored declaration on open.
    const legacyComputeDecl = config.tools.find(t => t.name === 'container_exec')
    if (legacyComputeDecl) legacyComputeDecl.name = 'compute_exec'

    const registry = new ToolRegistry()
    registerBuiltInTools(registry)

    const adfCallHandler = this.createAdfCallHandler({
      workspace,
      config,
      provider,
      registry,
      createProviderForModel: opts.createProviderForModel,
      keyRef,
    })

    this.registerCodeTools(registry, config, agentId, adfCallHandler)
    const computeStartup = this.registerComputeTools(registry, workspace, config, filePath)
    // `assembled` is created further down; the MCP install/restart closures fan
    // a freshly-synced config out to the live executor once it exists (a no-op
    // during the initial connect, which runs before assembly).
    let assembled: AssembledAgent<'daemon'> | undefined
    const mcpRuntime = await this.registerMcpTools(
      registry,
      workspace,
      config,
      label,
      adfCallHandler,
      () => assembled ?? null,
      keyRef,
    )
    const adapterRuntime = await this.registerChannelAdapters(workspace, config, keyRef)
    // StreamBindingManager is keyed by the stable agent id (config.id) —
    // parity with the Studio background path, and the id the podman compute
    // registry tracks.
    const streamBindingManager = this.registerStreamBindingTools(registry, workspace, config, config.id, filePath ?? config.id)
    this.wireFetchMiddleware(registry, workspace, agentId, adfCallHandler)
    const sysGetConfigTool = registry.get('sys_get_config') as SysGetConfigTool | undefined
    sysGetConfigTool?.setToolDiscoveryProvider((ws) => buildToolDiscovery(ws.getAgentConfig(), registry))

    let disposed = false
    const cleanup = async () => {
      if (disposed) return
      disposed = true
      const cleanupPromises: Promise<unknown>[] = [...computeStartup]
      // An interactive OAuth sign-in still waiting on its browser callback
      // closes its loopback listener now instead of at its own timeout.
      mcpRuntime.abortInteractiveSignIns()
      if (mcpRuntime.manager) {
        const mgr = mcpRuntime.manager
        mgr.removeAllListeners()
        cleanupPromises.push(mgr.disconnectAll())
      }
      if (adapterRuntime.manager) {
        const mgr = adapterRuntime.manager
        mgr.removeAllListeners()
        cleanupPromises.push(mgr.stopAll())
      }
      streamBindingManager?.stopAll('agent_stopped')
      if (this.podmanService) {
        // Parity with Studio background teardown: drop this agent from the
        // compute environment's active set so the daemon never leaks
        // activeAgentIds across load/unload cycles.
        try { this.podmanService.unregisterAgent(config.id) } catch { /* best effort */ }
        if (config.compute?.enabled) {
          cleanupPromises.push(this.stopIsolatedAfterStartup(config, computeStartup))
        }
      }
      await Promise.allSettled(cleanupPromises)
      removeScratchDir(mcpRuntime.scratchDir)
      if (this.codeSandboxService) {
        // Reap by prefix: lambdas, middleware and taps live in derived sandbox
        // ids (`<agentId>:lambda:<file>:<fn>[:<invocation>]`), and cold lambdas
        // mint a fresh one per invocation — destroying only `agentId` leaks them.
        try { this.codeSandboxService.destroyForAgent(agentId) } catch { /* best effort */ }
        try { this.codeSandboxService.destroyForAgent(config.id) } catch { /* best effort */ }
      }
    }

    const systemScopeHandler = this.codeSandboxService && adfCallHandler
      ? new SystemScopeHandler(workspace, this.codeSandboxService, adfCallHandler, agentId)
      : null

    // Umbilical bus + taps + agent.loaded/unloaded + adapter/MCP bridges.
    // Shared with both Studio hosts (runtime/umbilical-lifecycle.ts) so all
    // three produce the same ordered event stream. Listed FIRST so its start
    // runs before every other resource and its stop runs last.
    const umbilical = createUmbilicalResources({
      agentId: config.id,
      workspace,
      filePath,
      config,
      codeSandboxService: this.codeSandboxService,
      adfCallHandler,
      adapterManager: adapterRuntime.manager,
      mcpManager: mcpRuntime.manager,
    })

    try {
      assembled = assembleAgent({
        profile: 'daemon',
        workspace,
        config,
        provider,
        registry,
        ...(this.settings ? { effectiveRuntime: { settings: this.settings } } : {}),
        restoreLoop: opts.restoreLoop,
        basePrompt: opts.prompts ? opts.prompts.basePrompt : this.basePrompt,
        basePromptSource: opts.prompts?.basePromptSource,
        toolPrompts: opts.prompts ? opts.prompts.toolPrompts : this.toolPrompts,
        compactionPrompt: opts.prompts ? opts.prompts.compactionPrompt : this.compactionPrompt,
        adfCallHandler,
        systemScopeHandler,
        adapterManager: adapterRuntime.manager,
        codeSandboxService: this.codeSandboxService,
        mcpManager: mcpRuntime.manager,
        streamBindingManager,
        // The umbilical lifecycle creates the TapManager in its start(), so the
        // handle reads it late — parity with both Studio hosts.
        getTapManager: () => umbilical.lifecycle.getTapManager(),
        scratchDir: mcpRuntime.scratchDir,
        resources: [
          ...umbilical.resources,
          { name: 'daemon-runtime-resources', stop: cleanup },
        ],
        host: {
          // A sign-in deferred from a config write while no turn ran is
          // raised with the agent's next LLM turn (agent scope only: timers
          // and lambdas never raise it). Not awaited: the turn proceeds and
          // the server stays needs_sign_in until the request resolves.
          beforeDispatch: (dispatch) => {
            if (dispatch.scope === 'agent') void mcpRuntime.runDeferredSignIns()
          },
          onTriggerError: (error, dispatch) => {
            const eventType = 'event' in dispatch ? dispatch.event.type : dispatch.events[0]?.type ?? 'batch'
            try {
              workspace.insertLog(
                'error',
                'runtime',
                'trigger_error',
                eventType,
                String(error instanceof Error ? error.message : error).slice(0, 200),
              )
            } catch { /* non-fatal */ }
          },
          // Fires for every config change routed through applyConfigChange:
          // the agent's own sys_update_config / loop_manage and the daemon's
          // config writes (RuntimeService.setAgentConfig). The Studio hosts do
          // the same four things in their onConfigChanged and the Agents-screen
          // save: mesh copy, MCP reconcile, adapter reconcile (file rename is
          // RuntimeService's).
          onConfigChanged: async (updatedConfig) => {
            emitAgentConfigChanged(workspace, updatedConfig)
            // Fire-and-forget like Studio: a container spawn must never block
            // the tool return or the config save; failures are logged inside.
            void mcpRuntime.reconcile(updatedConfig).catch((err) =>
              console.error(`[AgentRuntimeBuilder][MCP] Config reconcile failed for ${label}:`, err instanceof Error ? err.message : err))
            if (!adapterRuntime.manager) return
            await adapterRuntime.manager.reconcile({
              registrations: this.getAdapterRegistrations(),
              adaptersConfig: updatedConfig.adapters,
              workspace,
              derivedKey: keyRef.current,
              // Same locked-credentials gate as the initial start: an adapter
              // (re-)enabled while its sealed credentials are locked gets the
              // stub, which restartLockedAdapters replaces after unlock. The
              // real factory would fail on a null credential and never be
              // retried once the identity becomes ready.
              resolveFactory: (type, reg) => this.resolveAdapterFactoryUnlessLocked(type, reg, workspace, keyRef.current),
            })
          },
          onAutostartChild: async () => false,
        },
      })
      // Late MCP connects (background retry after a failed initial connect, or
      // auto-restart after a drop) must register their tools exactly like
      // initial success — parity with the Studio foreground listener.
      // syncDiscoveredMcpTools is idempotent, so re-discovery of an
      // already-registered server does not duplicate.
      //
      // CRITICAL: read the config FRESH at event time via resyncServerTools. The
      // captured `config` is a start-time snapshot; every post-start change
      // (sys_update_config, UI enable/visible toggles, "Always approve") lands in
      // the workspace on a NEW object (getAgentConfig JSON.parses a fresh copy),
      // never in this closure. Syncing+persisting the stale snapshot on a reconnect
      // reverted those changes — e.g. a tool absorbed into the shell
      // (enabled:true, visible:false) flipped back, or an enabled tool clobbered to
      // disabled, so the UI showed it enabled while the executor/shell gate read
      // the clobbered declaration and rejected the call as "not enabled".
      if (mcpRuntime.manager) {
        const lateMcpManager = mcpRuntime.manager
        lateMcpManager.on('tools-discovered', (serverName, tools) => {
          // The whole body is guarded: a throw here would propagate through
          // emit into the MCP retry promise and surface as an
          // unhandledRejection in the daemon.
          try {
            resyncServerTools({
              getFreshConfig: () => workspace.getAgentConfig(),
              serverName,
              tools,
              registry,
              manager: lateMcpManager,
              persist: (fresh) => { try { workspace.setAgentConfig(fresh) } catch { /* best effort */ } },
              fanOut: (fresh) => {
                // A6: route through the assembled choke point so loopPool.reconcile
                // runs and rawConfig stays fresh — a hand-rolled executor/trigger/
                // callHandler updateConfig left side loops on stale derived config.
                // notifyHost:false — this is a reconnect resync, not an edit.
                if (assembled) assembled.applyConfigChange(fresh, { notifyHost: false })
                else adfCallHandler?.updateConfig(fresh)
              },
            })
            console.log(`[AgentRuntimeBuilder][MCP] Registered ${tools.length} tools for "${serverName}" after late connect`)
          } catch (err) {
            console.error(`[AgentRuntimeBuilder][MCP] Late tools-discovered handling failed for "${serverName}":`, err)
          }
        })
      }
      await assembled.start()
      const state: BuiltAgentState = {
        workspace,
        label,
        keyRef,
        mcpManager: mcpRuntime.manager,
        adapterManager: adapterRuntime.manager,
        connectMcpServer: (serverName, reason) => mcpRuntime.connect(workspace.getAgentConfig(), serverName, reason, { interactive: false }),
      }
      this.builtAgents.set(assembled, state)
      this.builtByWorkspace.set(workspace, state)
      return assembled
    } catch (error) {
      await cleanup()
      try { workspace.dispose() } catch { /* idempotent */ }
      throw error
    }
  }

  private createAdfCallHandler(opts: {
    workspace: AdfWorkspace
    config: AgentConfig
    provider: LLMProvider
    registry: ToolRegistry
    createProviderForModel?: (model: ModelConfig) => LLMProvider
    keyRef: DerivedKeyRef
  }): AdfCallHandler | null {
    if (!this.codeSandboxService) return null

    const { config } = opts
    // Keep the RPC bridge available for live configuration. In particular,
    // `sys_update_config` can add pre_llm_hook to an agent that originally had
    // no code-related declaration; the next turn must execute it, not fail due
    // to a construction-time omission. The bridge itself grants no tool.

    return new AdfCallHandler({
      toolRegistry: opts.registry,
      workspace: opts.workspace,
      config,
      provider: opts.provider,
      createProviderForModel: opts.createProviderForModel,
      // ONLY reads from adf_identity — code_access + spec-D13 key-material guard.
      resolveIdentity: (purpose: string) => opts.workspace.getIdentityForCode(purpose, opts.keyRef.current),
      getSigningKey: () => opts.workspace.getSigningKeys(opts.keyRef.current)?.privateKey ?? null,
    })
  }

  private registerCodeTools(
    registry: ToolRegistry,
    config: AgentConfig,
    agentId: string,
    adfCallHandler: AdfCallHandler | null,
  ): void {
    const sandbox = this.codeSandboxService
    if (!sandbox) return
    // Registered while declared, including declarations added later on the
    // running agent (ToolRegistry.provideDeclared).
    registry.provideDeclared('sys_code', () => new SysCodeTool(
      sandbox,
      agentId,
      adfCallHandler ?? undefined,
      config.limits?.execution_timeout_ms,
    ), config.tools)
    // Normal sys_lambda access remains declaration-dependent. A hook that is
    // added live uses its private registry/backend instead of this shared path.
    if (adfCallHandler) {
      registry.provideDeclared('sys_lambda', () => new SysLambdaTool(
        sandbox,
        adfCallHandler,
        agentId,
        config.limits?.execution_timeout_ms,
      ), config.tools)
    }
    const packages = this.sandboxPackagesService
    if (packages) {
      registry.provideDeclared('npm_install', () => new NpmInstallTool(packages), config.tools)
      registry.provideDeclared('npm_uninstall', () => new NpmUninstallTool(), config.tools)
    }
  }

  private registerComputeTools(registry: ToolRegistry, workspace: AdfWorkspace, config: AgentConfig, filePath: string | null): Promise<void>[] {
    const inputs = (): ComputeCapabilityInputs => ({
      podmanService: this.podmanService,
      computeSettings: this.settings?.get('compute'),
      runtimeHostAllowed: this.getComputeRoutingSettings().hostAccessEnabled,
      describeHost: describeHostEnv,
    })
    const caps = buildComputeCapabilities(config, inputs())
    // Live: a compute change the agent makes mid-run applies on its next call.
    const liveCaps = liveComputeCapabilities(caps, () => workspace.getAgentConfig(), inputs, filePath ?? undefined)

    const startup: Promise<void>[] = []
    if (caps.hasIsolated && this.podmanService) {
      const p = this.podmanService.ensureIsolatedRunning(config.name, config.id, config.compute?.packages?.pip, filePath ?? undefined, config.compute?.browser !== false)
        .then(() => this.podmanService?.ensureWorkspace(caps.isolatedContainerName!, '/workspace'))
        .then(() => undefined)
      p.catch((err) => {
        console.warn(`[Compute] Isolated container for ${config.name} is not ready:`, err instanceof Error ? err.message : err)
      })
      startup.push(p)
    }

    registry.register(new FsTransferTool(this.podmanService, liveCaps))
    registry.register(new ComputeExecTool(this.podmanService, liveCaps, config.limits?.execution_timeout_ms))
    return startup
  }

  private registerStreamBindingTools(
    registry: ToolRegistry,
    workspace: AdfWorkspace,
    config: AgentConfig,
    agentId: string,
    agentFilePath: string,
  ): StreamBindingManager {
    const manager = new StreamBindingManager(agentId, config.name, agentFilePath, config.stream_bind, this.wsConnectionManager, this.podmanService, workspace)
    registry.register(new StreamBindTool(manager))
    registry.register(new StreamUnbindTool(manager))
    registry.register(new StreamBindingsTool(manager))
    manager.loadDeclarations(config.stream_bindings ?? [])
    return manager
  }

  private async stopIsolatedAfterStartup(config: AgentConfig, startup: Promise<void>[]): Promise<void> {
    await Promise.allSettled(startup)
    await this.podmanService?.stopIsolated(config.name, config.id)
  }

  private async registerMcpTools(
    registry: ToolRegistry,
    workspace: AdfWorkspace,
    config: AgentConfig,
    filePathOrId: string,
    adfCallHandler: AdfCallHandler | null,
    getAssembled: () => AssembledAgent<'daemon'> | null,
    keyRef: DerivedKeyRef,
  ): Promise<McpRuntime> {
    // Create the manager unconditionally (parity with the Studio foreground and
    // background paths): mcp_install must be able to connect a server even when
    // the agent started with zero configured servers.
    const scratchDir = createScratchDir(filePathOrId)
    // OAuth (http) connect: attach + silently refresh the agent-sealed token.
    // The connect itself never opens a browser: an absent token surfaces the
    // terminal "sign in from Settings" status, a locked envelope surfaces the
    // keystore's actionable hint (both propagate as the server's error). The
    // interactive sign-in runs BEFORE the connect, from an agent call only
    // (prepareHttpOAuth). Reads use the agent's current derived key.
    const oauthProviderFactory = buildOAuthProviderFactory((cfg) =>
      resolveOAuthStoreForConnect({ agentStore: new AgentKeystoreOAuthStore(workspace, cfg.name, keyRef.current) }),
    )
    const manager = new McpClientManager(scratchDir, oauthProviderFactory)
    // Interactive sign-ins in flight, aborted at teardown; one per server.
    const signIns = new Set<AbortController>()
    const signInsByServer = new Map<string, Promise<OAuthReadiness>>()
    // Servers whose sign-in waits for the next turn (deferSignIn).
    const deferredSignIns = new Set<string>()
    let deferredRun: Promise<void> | null = null

    manager.on('log', (serverName, entry) => {
      const level = entry.stream === 'stderr' ? 'warn' : 'info'
      try { workspace.insertLog(level, 'mcp', entry.stream, serverName, entry.message) } catch { /* ignore */ }
    })
    manager.on('status-changed', (serverName, status, error) => {
      if (status === 'error') {
        try { workspace.insertLog('error', 'mcp', 'status', serverName, error ?? 'MCP server entered error state') } catch { /* ignore */ }
      }
    })

    const credentialStore = () => ({
      getDecrypted: (p: string) => workspace.getIdentityDecrypted(p, keyRef.current),
      hasRow: (p: string) => workspace.getIdentityRow(p) !== null,
      envelopeLockedHint: this.credentialEnvelopeLockedHint,
    })

    // Connect ONE already-configured server, sync its discovered tools, persist,
    // and fan the fresh config out to the live executor. Shared by the initial
    // connect loop, the mcp_install / mcp_restart closures, the owner restart
    // and the config reconcile. `freshConfig` is the caller's responsibility —
    // the closures pass workspace.getAgentConfig() so post-start config changes
    // are never clobbered by a start-time snapshot. `interactive` is true only
    // for calls an agent loop drives (Studio gates its interactive OAuth on the
    // same thing: a live executor during a hot install/restart/reconcile).
    /**
     * Persist one server's tool sync onto a fresh read of the file's config:
     * the connect awaited, and a config write made meanwhile (a client's save
     * or a tool toggle during the start window, design §6.1 row 24) must not
     * be overwritten with the caller's copy. The sync runs again on that read,
     * so only what the discovery changes moves over.
     */
    const persistServerSync = (serverName: string, tools: McpToolInfo[], envSchema: McpServerConfig['env_schema'] | null | undefined): void => {
      const onDisk = workspace.getAgentConfig()
      const server = onDisk.mcp?.servers?.find(s => s.name === serverName)
      if (!server) return
      syncDiscoveredMcpTools(onDisk, server, tools, registry, manager)
      if (envSchema) server.env_schema = envSchema
      workspace.setAgentConfig(onDisk)
    }

    const connectOneServer = async (
      freshConfig: AgentConfig,
      serverName: string,
      reason: string,
      connectOpts: McpConnectOpts,
    ): Promise<McpConnectOutcome> => {
      const serverCfg = freshConfig.mcp?.servers?.find(s => s.name === serverName)
      if (!serverCfg) throw new Error(`Server "${serverName}" not found.`)

      const registrations = this.getMcpRegistrations()
      const registration = registrations.find(r => r.name === serverCfg.name)
      // SECURITY: for a Settings-registered server, the executable identity
      // (command/args/package/source/run_location/timeout/headers/...) comes
      // from the registration, never the agent-writable .adf copy — see
      // pinServerConfigToRegistration. The Settings "Runs on" toggle therefore
      // also governs Settings-managed servers even when the attach-time .adf
      // snapshot predates a location change.
      const connCfg = registration
        ? pinServerConfigToRegistration(serverCfg, registration)
        : { ...serverCfg }

      const appEnvKeys: string[] = []
      if (registration?.env?.length) {
        const appEnv: Record<string, string> = {}
        for (const { key, value } of registration.env) {
          if (key && value) { appEnv[key] = value; appEnvKeys.push(key) }
        }
        if (Object.keys(appEnv).length) connCfg.env = { ...connCfg.env, ...appEnv }
      }

      const resolvedEnv = resolveMcpEnvVars(connCfg, key => workspace.getIdentityDecrypted(key, keyRef.current))
      const agentEnvKeys = Object.keys(resolvedEnv)
      if (agentEnvKeys.length) {
        connCfg.env = { ...connCfg.env, ...resolvedEnv }
      }

      let uvBinPath: string | undefined
      if (connCfg.transport !== 'http' && (connCfg.pypi_package || connCfg.command === 'uvx')) {
        try { uvBinPath = await this.uvManager?.ensureUv() } catch { /* uv not available */ }
      }

      let connectOptions: import('../services/mcp-client-manager').McpConnectOptions | undefined
      let location: McpConnectOutcome['location'] = 'host'
      let hostDenied: string | undefined
      const computeSettings = this.getComputeRoutingSettings()
      const willContainerize = connCfg.transport !== 'http'
        && shouldContainerize(connCfg.name, connCfg, freshConfig, computeSettings)
      let oauthReadiness: OAuthReadiness | null = null
      if (connCfg.transport === 'http') {
        location = 'remote http'
        if (connCfg.oauth && connCfg.url) {
          oauthReadiness = await this.prepareHttpOAuth({
            serverCfg: connCfg,
            url: connCfg.url,
            registration,
            workspace,
            keyRef,
            executor: connectOpts.interactive ? getAssembled()?.executor ?? null : null,
            signIns,
            inFlight: signInsByServer,
            restoreState: connectOpts.outsideTurn === true,
          })
        }
      } else if (this.podmanService && willContainerize) {
        // connCfg (pinned to the registration for Settings-managed servers) —
        // never the agent-writable serverCfg — so a tampered .adf command/args
        // can't reach the container spawn.
        const containerCmd = resolveContainerCommand(connCfg)
        const isolated = shouldIsolate(freshConfig) && !isServerForceShared(connCfg)
        location = isolated ? 'isolated container' : 'shared container'
        // Why a host-preferring server runs in a container (Studio foreground
        // parity: mcp_install / mcp_restart report it to the agent).
        hostDenied = hostDenialReason(connCfg.name, connCfg, freshConfig, computeSettings) ?? undefined
        // Fail plainly — never silently fall back to host execution when
        // routing decided this server must be containerized.
        const podman = this.podmanService
        const podmanBin = await prepareMcpContainer(podman, connCfg.name, () => isolated
          ? podman.ensureIsolatedRunning(freshConfig.name, freshConfig.id, freshConfig.compute?.packages?.pip)
          : podman.ensureRunning(),
        ).catch((err: unknown) => {
          if (err instanceof ComputeUnavailableError) manager.markFailed(serverCfg, err.message, 'needs_compute')
          throw err
        })
        const containerName = isolated ? isolatedContainerName(freshConfig.name, freshConfig.id) : 'adf-mcp'
        try { await this.podmanService.ensureWorkspace(containerName, containerWorkspacePath(isolated, freshConfig.id)) } catch { /* ignore */ }
        try { await this.podmanService.ensureWorkspace(containerName, containerAgentHome(isolated, freshConfig.id)) } catch { /* ignore */ }
        // Materialize keystore-held credential files into the container before spawn.
        await materializeCredentialFiles(
          credentialStore(),
          connCfg,
          containerCredentialTarget(this.podmanService, containerName, containerAgentHome(isolated, freshConfig.id)),
        )
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
              // Agent-scoped HOME first — an explicit serverCfg.env.HOME still wins.
              env: { HOME: containerAgentHome(isolated, freshConfig.id), ...connCfg.env, ...browserEnv },
              cwd: containerWorkspacePath(isolated, freshConfig.id),
            }),
            linkedFileReader: containerLinkedFileReader(this.podmanService, containerName, containerWorkspacePath(isolated, freshConfig.id)),
          }
        }
      }

      if (!connectOptions && connCfg.transport !== 'http') {
        // Host credential materialization ONLY when routing actually chose
        // host — a container-intended server (e.g. builder constructed
        // without a podman service) must never write credentials to host.
        if (!willContainerize) {
          await materializeCredentialFiles(credentialStore(), connCfg, { kind: 'host' })
        }
        const spawn = resolveMcpSpawnConfig(connCfg, {
          npmResolver: this.mcpPackageResolver,
          uvxResolver: this.uvxPackageResolver ?? undefined,
          uvBinPath,
        })
        if (spawn.command) connCfg.command = spawn.command
        if (spawn.args) connCfg.args = spawn.args
      }

      console.log(`[AgentRuntimeBuilder][MCP] ${reason}: connecting "${serverName}" (${location})`)
      const tools = await manager.connect(connCfg, connectOptions)
      if (!tools) {
        if (connectOpts.deferSignIn && oauthReadiness === 'no_token') {
          // No turn to raise the sign-in in (a config write to an idle or off
          // agent): it is raised before the agent's next turn. Visible as the
          // server status and in adf_logs until then.
          deferredSignIns.add(serverName)
          const message = `Sign-in required for "${serverName}": the OAuth sign-in is requested with this agent's next turn, or when the agent calls mcp_restart("${serverName}").`
          manager.markNeedsSignIn(serverCfg, message)
          console.warn(`[AgentRuntimeBuilder][MCP] ${message}`)
          try { workspace.insertLog('warn', 'mcp', 'oauth_signin_pending', serverName, message) } catch { /* non-fatal */ }
        }
        const state = manager.getServerState(serverName)
        const stderrTail = state?.logs.filter(l => l.stream === 'stderr').slice(-5).map(l => l.message)
        return { toolsDiscovered: 0, location, hostDenied, error: state?.error, stderrTail: stderrTail?.length ? stderrTail : undefined }
      }
      deferredSignIns.delete(serverName)

      const changed = syncDiscoveredMcpTools(freshConfig, serverCfg, tools, registry, manager)
      const nextSchema = captureEnvSchema(serverCfg, appEnvKeys, agentEnvKeys)
      if (nextSchema) serverCfg.env_schema = nextSchema
      if (changed || nextSchema) persistServerSync(serverName, tools, nextSchema)
      const assembled = getAssembled()
      // Through the assembled choke point (as the late resync below), so side
      // loops re-derive their MCP declarations too. notifyHost:false — a tool
      // sync is not an edit and must not re-enter the reconcile. The file's
      // config, not the caller's copy: a config write made during the connect
      // is already on the running agent and must not be reverted.
      const applied = workspace.getAgentConfig()
      if (assembled) assembled.applyConfigChange(applied, { notifyHost: false })
      else adfCallHandler?.updateConfig(applied)
      return { toolsDiscovered: tools.length, location, hostDenied }
    }

    // --- Live MCP reconcile ----------------------------------------------------
    // Connect servers newly added to the config and disconnect removed ones
    // WITHOUT restarting the agent (Studio foreground reconcileMcpServers). The
    // host's onConfigChanged drives it for both an agent's sys_update_config and
    // the daemon's config writes. `previousReconciled` is the diff's "before"
    // side: the workspace already holds the new config when either fires.
    let previousReconciled: AgentConfig = config
    const reconcile = async (nextConfig: AgentConfig): Promise<void> => {
      const prev = previousReconciled
      previousReconciled = nextConfig
      const { added, removed } = diffMcpServerNames(prev, nextConfig)
      if (added.length === 0 && removed.length === 0) return

      const registeredNames = new Set(this.getMcpRegistrations().map(r => r.name))
      for (const name of added) {
        const serverCfg = nextConfig.mcp?.servers?.find(s => s.name === name)
        if (!serverCfg) continue
        // Same skip rule as the start-up connect loop.
        if (!registeredNames.has(name) && !serverCfg.source) {
          console.log(`[AgentRuntimeBuilder][MCP] Reconcile: skipping "${name}" — not registered in Settings`)
          continue
        }
        // mcp_install writes the server into the file and connects it itself;
        // the next config change then lists it as added. Reconnecting a live
        // server would only drop its tools for the length of a restart.
        const live = manager.getServerState(name)?.status
        if (live === 'connected' || live === 'connecting') continue
        try {
          // Interactive only while a turn runs (the agent's own
          // sys_update_config). A daemon config write to an idle or off agent
          // must not leave it in awaiting_approval with no turn to resume.
          const interactive = getAssembled()?.executor.isTurnActive() ?? false
          const result = await connectOneServer(nextConfig, name, 'Attached', { interactive, deferSignIn: !interactive })
          if (result.toolsDiscovered > 0) {
            console.log(`[AgentRuntimeBuilder][MCP] Reconcile: connected "${name}" — ${result.toolsDiscovered} tools now available to agent`)
          } else if (result.error) {
            // The manager already holds this failure (status error + reason).
            console.error(`[AgentRuntimeBuilder][MCP] Reconcile: "${name}" failed to connect — no tools available to agent: ${result.error}`)
          } else {
            console.warn(`[AgentRuntimeBuilder][MCP] Reconcile: "${name}" connected with no tools (may need credentials or a later reconnect)`)
          }
        } catch (err) {
          // One server's failure must not abort the others or the config save.
          // Recorded on the manager, so the server's status says why.
          const message = err instanceof Error ? err.message : String(err)
          console.error(`[AgentRuntimeBuilder][MCP] Reconcile: connect failed for "${name}":`, message)
          // A needs_compute failure was already recorded where it was thrown.
          if (!(err instanceof ComputeUnavailableError)) manager.markFailed(serverCfg, message)
        }
      }

      for (const name of removed) {
        try {
          await manager.disconnect(name)
        } catch (err) {
          console.warn(`[AgentRuntimeBuilder][MCP] Reconcile: disconnect failed for "${name}":`, err instanceof Error ? err.message : err)
        }
        deferredSignIns.delete(name)
        // The removed server's tools stop reaching the model.
        const toolPrefix = `mcp_${name}_`
        for (const tool of registry.getAll()) {
          if (tool.name.startsWith(toolPrefix)) registry.unregister(tool.name)
        }
        console.log(`[AgentRuntimeBuilder][MCP] Reconcile: disconnected "${name}" (removed from config)`)
      }
    }

    const runtime: McpRuntime = {
      manager,
      scratchDir,
      connect: connectOneServer,
      reconcile,
      abortInteractiveSignIns: () => {
        for (const controller of signIns) controller.abort()
        signIns.clear()
      },
      runDeferredSignIns: () => {
        // Single flight; nobody waits on it. Its approvals run beside the
        // turn (restoreState) and never touch the executor state mid-turn.
        if (deferredRun) return deferredRun
        if (deferredSignIns.size === 0) return Promise.resolve()
        if (!getAssembled()?.executor) return Promise.resolve()
        const names = [...deferredSignIns]
        deferredSignIns.clear()
        deferredRun = (async () => {
          for (const name of names) {
            const fresh = workspace.getAgentConfig()
            if (!fresh.mcp?.servers?.some(s => s.name === name)) continue
            try {
              await connectOneServer(fresh, name, 'Sign-in with next turn', { interactive: true, outsideTurn: true })
            } catch (err) {
              console.error(`[AgentRuntimeBuilder][MCP] Deferred sign-in failed for "${name}":`, err instanceof Error ? err.message : err)
            }
          }
        })().finally(() => { deferredRun = null })
        return deferredRun
      },
    }

    // The owner's restart / connect-after-attach (POST /agents/:id/mcp/servers/:name/restart).
    // Not interactive: Studio's owner restart reuses the stored connection and never prompts.
    registerMcpConnector(manager, (serverName, reason = 'Owner restart') => connectOneServer(workspace.getAgentConfig(), serverName, reason, { interactive: false }))

    // Register the MCP management tools UNCONDITIONALLY — declared/enabled
    // gating happens per-call in the shell/executor, not at registration time.
    // Gating registration on the start-time config leaves the registry stale
    // when a tool is enabled later (the bug this fixes for headless agents).
    registry.register(new McpInstallTool(async (serverName, installOptions) => {
      const freshConfig = workspace.getAgentConfig()
      const serverCfg = freshConfig.mcp?.servers?.find(s => s.name === serverName)
      if (!serverCfg) return
      // Interactive OAuth preflight before the real connect. The headless
      // default opens the auth URL best-effort, logs it, and waits for the
      // auth subcommand to exit — failing plainly with the URL on timeout.
      if (installOptions?.auth && serverCfg.transport !== 'http') {
        // SECURITY: pin the executable identity to the Settings registration
        // (if any) so a tampered .adf command/args can't run under auth.
        const authReg = this.getMcpRegistrations().find(r => r.name === serverName)
        const cfg = authReg ? pinServerConfigToRegistration(serverCfg, authReg) : serverCfg
        const resolvedEnv = resolveMcpEnvVars(cfg, key => workspace.getIdentityDecrypted(key, keyRef.current))
        let uvBinPath: string | undefined
        if (cfg.pypi_package || cfg.command === 'uvx') {
          try { uvBinPath = await this.uvManager?.ensureUv() } catch { /* uv not available */ }
        }
        // Mirror the connect path's routing: containerized servers run the
        // auth subcommand INSIDE their container so tokens persist where the
        // server will run. ensure* failures propagate — fail plainly.
        let container: import('../services/mcp-auth-preflight').ContainerAuthTarget | undefined
        const willContainerize = shouldContainerize(cfg.name, cfg, freshConfig, this.getComputeRoutingSettings())
        if (this.podmanService && willContainerize) {
          const isolated = shouldIsolate(freshConfig) && !isServerForceShared(cfg)
          const podman = this.podmanService
          const podmanBin = await prepareMcpContainer(podman, cfg.name, () => isolated
            ? podman.ensureIsolatedRunning(freshConfig.name, freshConfig.id, freshConfig.compute?.packages?.pip)
            : podman.ensureRunning())
          const cc = resolveContainerCommand(cfg)
          container = {
            podmanBin,
            containerName: isolated ? isolatedContainerName(freshConfig.name, freshConfig.id) : 'adf-mcp',
            command: cc.command,
            args: cc.args,
            home: containerAgentHome(isolated, freshConfig.id),
          }
          // The auth subcommand writes tokens into $HOME — make sure it exists.
          try { await this.podmanService.ensureWorkspace(container.containerName, container.home!) } catch { /* preflight itself will surface real failures */ }
        }
        const podmanSvc = this.podmanService
        // Host credential target ONLY when routing chose host — a
        // container-intended server without a podman service must not
        // materialize or capture credentials on the host.
        const credTarget: CredentialFileTarget | null = container && podmanSvc
          ? containerCredentialTarget(podmanSvc, container.containerName, container.home ?? '/root')
          : (!willContainerize ? { kind: 'host' } : null)
        if (credTarget) await materializeCredentialFiles(credentialStore(), cfg, credTarget)
        await this.mcpAuthPreflight(cfg, { authArgs: installOptions.authArgs, resolvedEnv, uvBinPath, container, authPort: installOptions.authPort })
        // Auth succeeded: capture files the flow stored (tokens) into the keystore.
        if (credTarget) await writeBackCredentialFiles({ setIdentitySealed: (p, v) => workspace.setIdentitySealed(p, v) }, cfg, credTarget, new Date().toISOString(), (m) => { console.log(m); try { workspace.insertLog('info', 'mcp', 'credential_writeback', cfg.name, m.slice(0, 500)) } catch { /* non-fatal */ } })
      }
      return connectOneServer(freshConfig, serverName, 'Hot-load', { interactive: true })
    }, () => this.getMcpRegistrations()))
    registry.register(new McpRestartTool(async (serverName) => {
      return connectOneServer(workspace.getAgentConfig(), serverName, 'Agent reconnect', { interactive: true })
    }))
    registry.register(new McpUninstallTool((serverName) => {
      manager.disconnect(serverName).catch(() => {})
    }))

    if (!config.mcp?.servers?.length) return runtime

    try {
      const registrations = this.getMcpRegistrations()
      const registeredNames = new Set(registrations.map(r => r.name))

      const connectPromise = Promise.allSettled(
        config.mcp.servers.map(async (serverCfg) => {
          if (!registeredNames.has(serverCfg.name) && !serverCfg.source) {
            console.log(`[AgentRuntimeBuilder][MCP] Skipping "${serverCfg.name}" — not registered in Settings`)
            return { name: serverCfg.name, skipped: true, attempted: false, connected: false }
          }
          try {
            const outcome = await connectOneServer(config, serverCfg.name, 'Initial connect', { interactive: false })
            return { name: serverCfg.name, skipped: false, attempted: true, connected: outcome.toolsDiscovered > 0 }
          } catch (err) {
            console.error(`[AgentRuntimeBuilder][MCP] connect failed for "${serverCfg.name}":`, err)
            if (!(err instanceof ComputeUnavailableError)) manager.markFailed(serverCfg, err instanceof Error ? err.message : String(err))
            return { name: serverCfg.name, skipped: false, attempted: true, connected: false }
          }
        }),
      )

      // Per-agent MCP connect budget: a single hung server must not stall
      // agent start (worst case previously 120s timeout x 3 retries). Past
      // the deadline the agent proceeds degraded — unconnected servers'
      // tools stay unavailable and auto-restart recovers in the background.
      const { timedOut, value: results } = await withDeadline(connectPromise, MCP_CONNECT_BUDGET_MS, () => {
        console.error(`[AgentRuntimeBuilder][MCP] Connect budget (${MCP_CONNECT_BUDGET_MS}ms) exceeded for ${config.name} — starting degraded; pending MCP servers will keep connecting in the background`)
        try { workspace.insertLog('error', 'mcp', 'connect_timeout', null, `MCP connect budget exceeded after ${MCP_CONNECT_BUDGET_MS}ms — agent started degraded; pending servers recover in background`) } catch { /* ignore */ }
      })
      const settledResults = timedOut || !results ? [] : results

      let configChanged = false
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

      const disabled = new Set<string>()
      for (const declaration of config.tools) {
        if (!declaration.name.startsWith('mcp_')) continue
        const serverName = config.mcp.servers.find(server => declaration.name.startsWith(`mcp_${server.name}_`))?.name
        if (serverName && !connectedServerNames.has(serverName) && !attemptedServerNames.has(serverName) && declaration.enabled) {
          declaration.enabled = false
          disabled.add(declaration.name)
          configChanged = true
        }
      }

      // Onto a fresh read, as Studio's foreground start syncs MCP tools: the
      // start-time config must not overwrite a config write made while the
      // servers connected (the start window, design §6.1 row 24).
      if (configChanged) {
        const fresh = workspace.getAgentConfig()
        for (const declaration of fresh.tools ?? []) if (disabled.has(declaration.name)) declaration.enabled = false
        workspace.setAgentConfig(fresh)
      }
    } catch (err) {
      // Setup-level failure (not a single server): keep the manager and its
      // scratch dir — parity with both Studio hosts — so mcp_install can
      // still hot-load. Per-server failures are already isolated above.
      console.error(`[AgentRuntimeBuilder][MCP] setup failed for ${config.name} — keeping the MCP manager for later installs:`, err)
      try { workspace.insertLog('error', 'mcp', 'setup_failed', null, String(err instanceof Error ? err.message : err).slice(0, 200)) } catch { /* ignore */ }
    }
    return runtime
  }

  /**
   * Interactive HTTP-OAuth sign-in for an http+oauth server, before its
   * connect (Studio foreground captureAttachedOAuthToken, background
   * maybeGateBackgroundOAuthSignIn).
   *
   * 1. Capture-on-attach: with an app-level store, a token signed in there is
   *    sealed into this agent first, so the silent connect finds it.
   * 2. With a live executor (an agent's mcp_install / mcp_restart, or a
   *    reconcile after its config write) and no stored token: the shared
   *    consent gate raises the same `mcp_oauth_signin` HIL request as Studio.
   * 3. On approval the flow runs here, with this process's loopback callback.
   *    Where Studio opens the browser itself, the daemon raises a second HIL
   *    request, `mcp_oauth_authorize`, whose input carries the authorize URL;
   *    the client opens it. It stays pending until the callback lands or the
   *    flow ends: approving means "opened" and re-raises it, denying cancels
   *    the flow, and the runtime ends it with settleHilTask (`completed`,
   *    never an approval).
   *
   * No executor (initial connect, owner restart): never prompts. Never throws:
   * every failure leaves the connect to fail plainly with the sign-in status.
   * One sign-in per server at a time: a concurrent call for the same server
   * waits for the one in flight, then connects with whatever it stored.
   */
  private async prepareHttpOAuth(params: PrepareHttpOAuthParams & { inFlight: Map<string, Promise<OAuthReadiness>> }): Promise<OAuthReadiness> {
    // A non-interactive caller (initial connect, owner restart) never prompts
    // and never waits on an interactive sign-in in flight.
    if (!params.executor) return this.prepareHttpOAuthOnce(params)
    const key = `${params.serverCfg.name} ${canonicalizeServerUrl(params.url)}`
    const pending = params.inFlight.get(key)
    if (pending) return pending
    const run = this.prepareHttpOAuthOnce(params).finally(() => { params.inFlight.delete(key) })
    params.inFlight.set(key, run)
    return run
  }

  private async prepareHttpOAuthOnce(params: PrepareHttpOAuthParams): Promise<OAuthReadiness> {
    const { serverCfg, url, workspace, executor } = params
    const serverName = serverCfg.name
    const agentStore = new AgentKeystoreOAuthStore(workspace, serverName, params.keyRef.current)
    const appStore = this.mcpOAuthAppStore
    const log = (level: 'info' | 'warn', message: string): void => {
      ;(level === 'warn' ? console.warn : console.log)(`[AgentRuntimeBuilder][MCP] ${message}`)
      try { workspace.insertLog(level, 'mcp', 'oauth_signin', serverName, message.slice(0, 500)) } catch { /* non-fatal */ }
    }

    if (appStore) {
      try {
        await copyOAuthRecord(appStore, agentStore, url)
      } catch (err) {
        log('warn', `OAuth capture-on-attach failed for "${serverName}": ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    const reg = params.registration as { oauthClientId?: string; oauthScopes?: string[] } | undefined
    const gateExecutor = executor && params.restoreState
      ? { requestApproval: (n: string, i: unknown, o?: { canAlwaysApprove?: boolean }) => executor.requestApproval(n, i, { ...o, restoreState: true }) }
      : executor
    try {
      await gateInteractiveOAuthSignIn({
        server: { name: serverName, url },
        executor: gateExecutor,
        isAlreadySignedIn: async () => !!(await agentStore.get(url))?.tokens,
        runInteractiveFlow: () => this.runInteractiveOAuthFlow({
          serverName,
          url,
          clientId: reg?.oauthClientId,
          scopes: reg?.oauthScopes,
          executor: executor!,
          agentStore,
          appStore,
          signIns: params.signIns,
          restoreState: params.restoreState,
          log,
        }),
        log,
      })
    } catch (err) {
      log('warn', `OAuth sign-in failed for "${serverName}": ${err instanceof Error ? err.message : String(err)}`)
    }
    try {
      return (await agentStore.get(url))?.tokens ? 'signed_in' : 'no_token'
    } catch {
      return 'unknown' // locked keystore: the connect reports it
    }
  }

  private async runInteractiveOAuthFlow(params: {
    serverName: string
    url: string
    clientId?: string
    scopes?: string[]
    executor: AgentExecutor
    agentStore: AgentKeystoreOAuthStore
    appStore: McpOAuthStore | null
    signIns: Set<AbortController>
    restoreState: boolean
    log: (level: 'info' | 'warn', message: string) => void
  }): Promise<boolean> {
    const { serverName, url, executor, agentStore, appStore, log } = params
    const controller = new AbortController()
    params.signIns.add(controller)
    // The pending authorize request, if any. Its input object is the
    // identity the settle looks it up by.
    let authorizeInput: AuthorizeInput | null = null
    let finished = false
    // Approve ("opened") re-raises the request once so the URL stays on screen;
    // a second approve only acknowledges, so an auto-approver cannot cycle.
    let reraised = false
    const raise = (input: AuthorizeInput): void => {
      authorizeInput = input
      void executor.requestApproval(MCP_OAUTH_AUTHORIZE_APPROVAL, input, { canAlwaysApprove: false, restoreState: params.restoreState })
        .then((approved) => {
          // Settled by the runtime (callback landed, flow ended, superseded):
          // a newer request or nothing is pending now.
          if (finished || authorizeInput !== input) return
          if (approved) {
            // "Opened": the page is open, the flow still waits for its callback.
            log('info', `OAuth authorization page for "${serverName}" opened — waiting for the callback.`)
            if (reraised) {
              authorizeInput = null
              return
            }
            reraised = true
            raise({ ...input })
          } else if (!controller.signal.aborted) {
            // Denied, or drained by agent teardown: stop waiting.
            controller.abort()
          }
        }, () => { if (!finished && authorizeInput === input && !controller.signal.aborted) controller.abort() })
    }
    const io: McpHttpOAuthIO = {
      openUrl: (authorizeUrl) => {
        // One authorize request per flow: a repeated redirect replaces it.
        const previous = authorizeInput
        authorizeInput = null
        reraised = false
        if (previous) settlePendingApproval(executor, previous, 'Superseded by a new authorization URL')
        log('info', `OAuth sign-in for "${serverName}" approved — authorization URL raised as a "${MCP_OAUTH_AUTHORIZE_APPROVAL}" request; open it to continue.`)
        raise({ server: serverName, url, authorize_url: authorizeUrl })
      },
      log: (message) => console.log(message),
    }
    let flow: { authorized: boolean; error?: string }
    try {
      flow = await this.mcpHttpOAuthFlow(url, appStore ?? agentStore, io, {
        clientId: params.clientId,
        scopes: params.scopes,
        signal: controller.signal,
      })
    } catch (err) {
      flow = { authorized: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      params.signIns.delete(controller)
    }
    // The authorize request ends with the flow: the callback landed, or the
    // flow stopped without it. A request someone denied is already gone.
    finished = true
    if (authorizeInput) settlePendingApproval(executor, authorizeInput, flow.authorized ? 'Authorization completed' : `Authorization did not complete: ${flow.error ?? 'unknown'}`)
    if (!flow.authorized) {
      log('warn', `OAuth sign-in for "${serverName}" did not complete: ${flow.error ?? 'unknown'}`)
      return false
    }
    // Seal the app-level token into this agent so the silent connect finds it
    // (and it travels with the .adf). Without an app store it is already there.
    if (appStore) await copyOAuthRecord(appStore, agentStore, url)
    log('info', `OAuth sign-in for "${serverName}" complete — token sealed into the agent.`)
    return true
  }

  private getMcpRegistrations(): McpServerRegistration[] {
    return (this.settings?.get('mcpServers') as McpServerRegistration[] | undefined) ?? []
  }

  private getComputeRoutingSettings(): ComputeSettings {
    const raw = this.settings?.get('compute') as Record<string, unknown> | undefined
    // hostApprovedSources is the per-package squat guard for host-approved
    // NAMES (see hostApprovalMatches) — dropping it here would degrade every
    // approval to legacy name-only trust in the daemon path, letting a server
    // config squat an approved name with a different package.
    const rawSources = raw?.hostApprovedSources
    let hostApprovedSources: Record<string, string> | undefined
    if (rawSources && typeof rawSources === 'object' && !Array.isArray(rawSources)) {
      hostApprovedSources = {}
      for (const [name, source] of Object.entries(rawSources as Record<string, unknown>)) {
        if (typeof source === 'string') hostApprovedSources[name] = source
      }
    }
    return {
      hostAccessEnabled: raw?.hostAccessEnabled === true,
      hostApproved: Array.isArray(raw?.hostApproved)
        ? raw.hostApproved.filter((value): value is string => typeof value === 'string')
        : [],
      ...(hostApprovedSources ? { hostApprovedSources } : {}),
      ...(raw?.mcpOnHost === true ? { mcpOnHost: true } : {}),
    }
  }

  private async registerChannelAdapters(
    workspace: AdfWorkspace,
    config: AgentConfig,
    keyRef: DerivedKeyRef,
  ): Promise<{ manager: ChannelAdapterManager | null }> {
    const registrations = this.getAdapterRegistrations()
    if (registrations.length === 0) return { manager: null }

    const manager = new ChannelAdapterManager()

    manager.on('log', (adapterType, entry) => {
      const level = entry.level === 'system' ? 'info' : entry.level
      try { workspace.insertLog(level, 'adapter', null, adapterType, entry.message) } catch { /* ignore */ }
    })
    manager.on('status-changed', (adapterType, status, error) => {
      if (status === 'error') {
        try { workspace.insertLog('error', 'adapter', 'status', adapterType, error ?? 'Adapter entered error state') } catch { /* ignore */ }
      }
    })

    // Adapters are independent of one another — start them in parallel.
    // Failures degrade to adapter-error status; the agent still starts.
    const configuredAdapters = config.adapters ?? {}
    const envelopesLocked = detectLockedEnvelopes(workspace).length > 0
    await Promise.allSettled(registrations.map(async (registration) => {
      const adapterType = registration.type
      const adapterConfig = getEnabledAgentAdapterConfig(configuredAdapters, adapterType)
      if (!adapterConfig) return

      // Envelope-sealed credentials that this process cannot unlock resolve to
      // null — the adapter would fail fast and never recover. Mark it errored
      // with a clear message instead of attempting.
      if (envelopesLocked && adapterCredentialsLocked(workspace, adapterType, keyRef.current)) {
        console.error(`[AgentRuntimeBuilder][Adapter] Skipping "${adapterType}" for ${config.name} — envelope-sealed credentials are locked`)
        try { workspace.insertLog('error', 'adapter', 'credentials_locked', adapterType, 'Envelope-sealed credentials are locked in this process — adapter not started') } catch { /* ignore */ }
        await manager.startAdapter(adapterType, () => createLockedCredentialsAdapter(adapterType), adapterConfig, workspace, keyRef.current)
        return
      }

      const createFn = await this.resolveAdapterFactory(adapterType, registration)
      if (!createFn) return

      try {
        const started = await manager.startAdapter(
          adapterType,
          createFn,
          adapterConfig,
          workspace,
          keyRef.current,
        )
        if (started) {
          console.log(`[AgentRuntimeBuilder][Adapter] Started "${adapterType}" for ${config.name}`)
        }
      } catch (err) {
        console.error(`[AgentRuntimeBuilder][Adapter] Failed to start "${adapterType}" for ${config.name}:`, err)
        try { workspace.insertLog('error', 'adapter', 'start_failed', adapterType, String(err instanceof Error ? err.message : err).slice(0, 200)) } catch { /* ignore */ }
      }
    }))

    // Keep the manager alive even with zero running adapters: the agent may
    // enable an adapter later via config, and reconcile() needs a live manager
    // (and its inbound wiring) to start it without an app restart.
    return { manager }
  }

  /**
   * After sealed credentials unlock: replace every locked-credentials stub
   * adapter with the real one (stop the stub, then reconcile starts the
   * enabled adapter with its registered factory). Returns the types restarted.
   */
  async restartLockedAdapters(manager: ChannelAdapterManager, workspace: AdfWorkspace): Promise<string[]> {
    const locked = manager.getStates()
      .filter(state => state.status === 'error' && state.error?.startsWith(LOCKED_ADAPTER_ERROR_PREFIX))
      .map(state => state.type)
    if (locked.length === 0) return []
    for (const type of locked) await manager.stopAdapter(type)
    await manager.reconcile({
      registrations: this.getAdapterRegistrations(),
      adaptersConfig: workspace.getAgentConfig().adapters,
      workspace,
      derivedKey: this.builtByWorkspace.get(workspace)?.keyRef.current ?? null,
      resolveFactory: (type, reg) => this.resolveAdapterFactory(type, reg),
    })
    return locked
  }

  /**
   * The owner unlocked (Buffer) or locked (null) the agent's legacy-password
   * keystore after it started. Studio holds the key before a start (FILE_OPEN
   * asks for the password), so its consumers read it from the first connect;
   * the daemon loads first and unlocks later, so this updates the key every
   * builder-created consumer reads (MCP env, credential files and OAuth store,
   * channel adapters, AdfCallHandler identity and signing), hands it to the
   * mesh registration, and restarts the consumers that could not read their
   * credentials without it. The provider is RuntimeService's to rebuild.
   * Every restart is logged to the console and the agent's adf_logs.
   */
  async applyDerivedKey(agent: object, derivedKey: Buffer | null): Promise<DerivedKeyApplyResult> {
    const state = this.builtAgents.get(agent)
    if (!state) return { applied: false, adaptersRestarted: [], mcpReconnected: [] }
    const previous = state.keyRef.current
    state.keyRef.current = derivedKey
    emitAgentDerivedKeyChanged(state.workspace, derivedKey)
    if (!derivedKey) {
      // Password removed or identity wiped: running adapters that read their
      // credentials through the old key (they have stored credentials) were
      // started with it in their context; restart those without it. An
      // adapter with no stored credential never used the key and keeps
      // running. After a wipe no credential is left, so nothing restarts (as
      // in Studio); an adapter that needs one fails at its next start.
      const adaptersRestarted = previous ? await this.restartAdaptersWithKey(state, null) : []
      return { applied: true, adaptersRestarted, mcpReconnected: [] }
    }

    const { workspace, label } = state
    // A credential row this unlock opened: unreadable with the old key, readable now.
    const opened = (purpose: string): boolean => {
      try {
        return workspace.getIdentityDecrypted(purpose, previous) === null
          && workspace.getIdentityDecrypted(purpose, derivedKey) !== null
      } catch {
        return false
      }
    }
    const config = workspace.getAgentConfig()

    const adaptersRestarted: string[] = []
    if (state.adapterManager) {
      const registrations = this.getAdapterRegistrations()
      for (const registration of registrations) {
        const type = registration.type
        if (!getEnabledAgentAdapterConfig(config.adapters ?? {}, type)) continue
        if (!workspace.listIdentityPurposes(`adapter:${type}:`).some(opened)) continue
        try { await state.adapterManager.stopAdapter(type) } catch { /* reconcile retries the start */ }
        adaptersRestarted.push(type)
      }
      if (adaptersRestarted.length > 0) {
        try {
          await state.adapterManager.reconcile({
            registrations,
            adaptersConfig: config.adapters,
            workspace,
            derivedKey,
            resolveFactory: (type, reg) => this.resolveAdapterFactoryUnlessLocked(type, reg, workspace, derivedKey),
          })
        } catch (err) {
          console.error(`[AgentRuntimeBuilder][Adapter] Restart after unlock failed for ${label}:`, err)
        }
      }
    }

    const mcpReconnected: string[] = []
    const registeredNames = new Set(this.getMcpRegistrations().map(r => r.name))
    for (const server of config.mcp?.servers ?? []) {
      if (!registeredNames.has(server.name) && !server.source) continue
      const keys = [server.npm_package, server.pypi_package, server.name].filter((k): k is string => !!k)
      if (!keys.some(key => workspace.listIdentityPurposes(`mcp:${key}:`).some(opened))) continue
      try {
        await state.connectMcpServer(server.name, 'Credentials unlocked')
        mcpReconnected.push(server.name)
      } catch (err) {
        console.error(`[AgentRuntimeBuilder][MCP] Reconnect after unlock failed for "${server.name}" (${label}):`, err instanceof Error ? err.message : err)
      }
    }

    const message = `Keystore unlocked for ${config.name}.` +
      (adaptersRestarted.length ? ` Restarted adapters: ${adaptersRestarted.join(', ')}.` : '') +
      (mcpReconnected.length ? ` Reconnected MCP servers: ${mcpReconnected.join(', ')}.` : '')
    console.log(`[AgentRuntimeBuilder] ${message}`)
    try { workspace.insertLog('info', 'runtime', 'keystore_unlocked', null, message.slice(0, 500)) } catch { /* non-fatal */ }
    return { applied: true, adaptersRestarted, mcpReconnected }
  }

  /**
   * Restart the running adapters of the agent that have stored credentials
   * (`adapter:<type>:*`, the rows they read through the key) with
   * `derivedKey` in their context (an adapter keeps the key it started
   * with). Logged to the console and adf_logs. Returns the types restarted.
   */
  private async restartAdaptersWithKey(state: BuiltAgentState, derivedKey: Buffer | null): Promise<string[]> {
    const manager = state.adapterManager
    if (!manager) return []
    const { workspace, label } = state
    const usesKey = (type: string): boolean => workspace.listIdentityPurposes(`adapter:${type}:`).some(p => p.startsWith(`adapter:${type}:`))
    const running = manager.getStates().map(s => s.type).filter(usesKey)
    if (running.length === 0) return []
    for (const type of running) {
      try { await manager.stopAdapter(type) } catch { /* reconcile retries the start */ }
    }
    try {
      await manager.reconcile({
        registrations: this.getAdapterRegistrations(),
        adaptersConfig: workspace.getAgentConfig().adapters,
        workspace,
        derivedKey,
        resolveFactory: (type, reg) => this.resolveAdapterFactoryUnlessLocked(type, reg, workspace, derivedKey),
      })
    } catch (err) {
      console.error(`[AgentRuntimeBuilder][Adapter] Restart after the keystore key changed failed for ${label}:`, err)
    }
    const message = `Keystore key dropped for ${label}. Restarted adapters without it: ${running.join(', ')}.`
    console.log(`[AgentRuntimeBuilder] ${message}`)
    try { workspace.insertLog('info', 'runtime', 'keystore_key_dropped', null, message.slice(0, 500)) } catch { /* non-fatal */ }
    return running
  }

  /** resolveAdapterFactory, but the locked-credentials stub while this adapter's sealed credentials cannot be read. */
  private async resolveAdapterFactoryUnlessLocked(
    adapterType: string,
    registration: AdapterRegistration,
    workspace: AdfWorkspace,
    derivedKey: Buffer | null,
  ): Promise<CreateAdapterFn | null> {
    if (detectLockedEnvelopes(workspace).length > 0 && adapterCredentialsLocked(workspace, adapterType, derivedKey)) {
      try { workspace.insertLog('error', 'adapter', 'credentials_locked', adapterType, 'Envelope-sealed credentials are locked in this process — adapter not started') } catch { /* ignore */ }
      return () => createLockedCredentialsAdapter(adapterType)
    }
    return this.resolveAdapterFactory(adapterType, registration)
  }

  private async resolveAdapterFactory(
    adapterType: string,
    registration: AdapterRegistration,
  ): Promise<CreateAdapterFn | null> {
    try {
      const builtIn = await loadBuiltInAdapter(adapterType)
      if (builtIn) return builtIn

      const installed = registration.npmPackage
        ? this.adapterPackageResolver.getInstalled(registration.npmPackage)
        : null
      if (installed && registration.npmPackage) {
        const mod = require(join(installed.installPath, 'node_modules', registration.npmPackage))
        return mod.createAdapter ?? mod.default?.createAdapter ?? null
      }
    } catch (err) {
      console.error(`[AgentRuntimeBuilder][Adapter] Failed to load "${adapterType}":`, err)
      return null
    }
    console.warn(`[AgentRuntimeBuilder][Adapter] No createAdapter() found for "${adapterType}"`)
    return null
  }

  private getAdapterRegistrations(): AdapterRegistration[] {
    return withBuiltInAdapterRegistrations(this.settings?.get('adapters') as AdapterRegistration[] | undefined)
  }

  private wireFetchMiddleware(
    registry: ToolRegistry,
    workspace: AdfWorkspace,
    agentId: string,
    adfCallHandler: AdfCallHandler | null,
  ): void {
    if (!this.codeSandboxService || !adfCallHandler) return
    const fetchTool = registry.get('sys_fetch') as SysFetchTool | undefined
    fetchTool?.setMiddlewareDeps?.({
      codeSandboxService: this.codeSandboxService,
      adfCallHandler,
      agentId,
      getSecurityConfig: () => workspace.getAgentConfig().security,
      // The daemon control API is ALWAYS blocked on loopback; the agent's own
      // served mesh origin (/agents/{handle}/) is ALWAYS allowed — even when
      // allow_local_fetch is false.
      getFetchGuardContext: () => {
        const meshPort = Number(this.settings?.get('meshPort')) || 7295
        const handle = workspace.getAgentConfig().handle
        const daemonPort = Number(process.env.ADF_DAEMON_PORT) || 7385
        return { daemonPort, ownOrigin: handle ? { port: meshPort, pathPrefix: `/agents/${handle}/` } : undefined }
      },
    })
  }
}

export function describeHostEnv(): string {
  try {
    const env = resolveHostEnv()
    return `Host environment (target='host'): ${env.osLabel} ${env.release}, shell: ${env.shell.label} (${env.shell.family}). Adjust commands to match the host OS and shell when targeting 'host'.`
  } catch {
    return 'Host environment (target=\'host\'): details unavailable.'
  }
}

/**
 * B1 interim hardening: names of envelopes that are still sealed after the
 * unlock attempt. 'locked'/'foreign' both mean this process cannot read the
 * rows they cover — credentials would silently resolve to null.
 */
export function detectLockedEnvelopes(workspace: AdfWorkspace): string[] {
  try {
    if (!workspace.hasEnvelopes()) return []
    const locked: string[] = []
    for (const name of ['identity', 'credentials'] as const) {
      const state = workspace.getEnvelopeState(name)
      if (state === 'locked' || state === 'foreign') locked.push(`${name}: ${state}`)
    }
    return locked
  } catch {
    // Best-effort detection — never block the load on introspection failure.
    return []
  }
}

/**
 * True when the adapter's per-agent keystore credentials exist but every one
 * of them decrypts to null (envelope-sealed rows this process cannot unlock).
 * Adapter credentials live only in the agent's identity, so there is no
 * fallback: starting such an adapter would fail fast and never recover.
 */
export function adapterCredentialsLocked(
  workspace: AdfWorkspace,
  adapterType: string,
  derivedKey: Buffer | null,
): boolean {
  try {
    const purposes = workspace.listIdentityPurposes(`adapter:${adapterType}:`)
    if (purposes.length === 0) return false
    return purposes.every(purpose => workspace.getIdentityDecrypted(purpose, derivedKey) === null)
  } catch {
    return false
  }
}

/** Error prefix of the locked-credentials stub adapter (recognized for restart after unlock). */
export const LOCKED_ADAPTER_ERROR_PREFIX = 'credentials locked'

/** What the owner does to unlock sealed credentials on a daemon. */
export const CREDENTIALS_UNLOCK_HINT =
  'Make the owner identity available: `adf identity restore` (seed phrase) or `adf identity unlock` (passphrase file), or /identity in the TUI.'

/**
 * Stub adapter whose start() rejects with a clear "credentials locked"
 * message: startAdapter records the error status/log without ever attempting
 * a real connection.
 */
export function createLockedCredentialsAdapter(adapterType: string): ChannelAdapter {
  const error = `${LOCKED_ADAPTER_ERROR_PREFIX} — envelope-sealed credentials for "${adapterType}" cannot be decrypted in this process. ${CREDENTIALS_UNLOCK_HINT} The adapter restarts automatically once they unlock.`
  return {
    start: async () => { throw new Error(error) },
    stop: async () => {},
    send: async () => ({ success: false, error }),
    canDeliver: () => false,
    status: () => 'error',
  }
}

/**
 * Seal an app-level OAuth record into the agent keystore, stamped with the
 * canonical server URL (the agent store is keyed by server NAME and refuses a
 * token minted for another endpoint). Same contract as captureOAuthToAgent,
 * for any McpOAuthStore. Returns false when the app store holds nothing.
 */
async function copyOAuthRecord(appStore: McpOAuthStore, agentStore: AgentKeystoreOAuthStore, serverUrl: string): Promise<boolean> {
  const record = await appStore.get(serverUrl)
  if (!record) return false
  await agentStore.save(serverUrl, { ...record, serverUrl: canonicalizeServerUrl(serverUrl) })
  return true
}

/** Settle the still-pending HIL request whose input is `input` (no human decision; no-op when gone). */
function settlePendingApproval(executor: AgentExecutor, input: unknown, note: string): void {
  try {
    const pending = executor.getPendingApprovals().find(request => request.input === input)
    if (pending) executor.settleHilTask(pending.requestId, note)
  } catch { /* executor already torn down */ }
}
