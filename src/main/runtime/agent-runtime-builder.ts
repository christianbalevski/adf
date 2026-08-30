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
import { createUmbilicalResources } from './umbilical-lifecycle'
import { isolatedContainerName, containerWorkspacePath, containerAgentHome } from '../services/podman.service'
import { resolveHostEnv } from '../services/host-exec.service'
import type { WsConnectionManager } from '../services/ws-connection-manager'
import type { PodmanService } from '../services/podman.service'
import type { CodeSandboxService } from './code-sandbox'
import type { LLMProvider } from '../providers/provider.interface'
import type { AdfWorkspace } from '../adf/adf-workspace'
import type { AgentConfig } from '../../shared/types/adf-v02.types'
import type { ComputeCapabilities } from '../tools/built-in/compute-target'
import type { RuntimeSettingsStore } from './runtime-service'
import { McpClientManager } from '../services/mcp-client-manager'
import { createScratchDir, removeScratchDir } from '../utils/scratch-dir'
import { PackageResolver } from '../services/mcp-package-resolver'
import { captureEnvSchema, resolveMcpEnvVars, resolveMcpSpawnConfig } from '../services/mcp-spawn-utils'
import type { UvxPackageResolver } from '../services/uvx-package-resolver'
import type { UvManager } from '../services/uv-manager'
import { PodmanStdioTransport } from '../services/podman-stdio-transport'
import { shouldContainerize, shouldIsolate, isServerForceShared, type ComputeSettings } from '../services/container-routing'
import { resolveContainerCommand } from '../services/container-command-resolver'
import { resolveAgentComputeTargetSelection } from '../services/execution-target-settings'
import { syncDiscoveredMcpTools, resyncServerTools } from '../services/mcp-tool-sync'
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
import { buildOAuthProviderFactory } from '../services/mcp-oauth-connect'

/**
 * Per-agent budget for connecting all MCP servers. A hung server previously
 * stalled agent start for up to 120s x 3 retries; past this budget the agent
 * starts degraded and the MCP auto-restart machinery recovers in background.
 */
const MCP_CONNECT_BUDGET_MS = 25_000

export interface AgentRuntimeBuilderOptions {
  settings?: RuntimeSettingsStore
  codeSandboxService?: CodeSandboxService | null
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
}

export interface BuildAgentRuntimeOptions {
  workspace: AdfWorkspace
  filePath: string | null
  config: AgentConfig
  provider: LLMProvider
  restoreLoop?: boolean
  createProviderForModel?: (modelId: string) => LLMProvider
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

  constructor(opts: AgentRuntimeBuilderOptions = {}) {
    this.settings = opts.settings
    this.codeSandboxService = opts.codeSandboxService ?? null
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
  }

  async build(opts: BuildAgentRuntimeOptions): Promise<AssembledAgent<'daemon'>> {
    const { workspace, filePath, config, provider } = opts
    const agentId = filePath ?? config.id

    this.ensureCoreToolDeclarations(config, workspace)

    const registry = new ToolRegistry()
    registerBuiltInTools(registry)

    const adfCallHandler = this.createAdfCallHandler({
      workspace,
      config,
      provider,
      registry,
      createProviderForModel: opts.createProviderForModel,
    })

    this.registerCodeTools(registry, config, agentId, adfCallHandler)
    const computeStartup = this.registerComputeTools(registry, config, filePath)
    // `assembled` is created further down; the MCP install/restart closures fan
    // a freshly-synced config out to the live executor once it exists (a no-op
    // during the initial connect, which runs before assembly).
    let assembled: AssembledAgent<'daemon'> | undefined
    const mcpRuntime = await this.registerMcpTools(
      registry,
      workspace,
      config,
      filePath ?? config.id,
      adfCallHandler,
      () => assembled ?? null,
    )
    const adapterRuntime = await this.registerChannelAdapters(workspace, config)
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
        restoreLoop: opts.restoreLoop,
        basePrompt: this.basePrompt,
        toolPrompts: this.toolPrompts,
        compactionPrompt: this.compactionPrompt,
        adfCallHandler,
        systemScopeHandler,
        adapterManager: adapterRuntime.manager,
        codeSandboxService: this.codeSandboxService,
        mcpManager: mcpRuntime.manager,
        streamBindingManager,
        scratchDir: mcpRuntime.scratchDir,
        resources: [
          ...umbilical.resources,
          { name: 'daemon-runtime-resources', stop: cleanup },
        ],
        host: {
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
          onConfigChanged: async (updatedConfig) => {
            if (!adapterRuntime.manager) return
            await adapterRuntime.manager.reconcile({
              registrations: this.getAdapterRegistrations(),
              adaptersConfig: updatedConfig.adapters,
              workspace,
              derivedKey: null,
              resolveFactory: (type, reg) => this.resolveAdapterFactory(type, reg),
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
      return assembled
    } catch (error) {
      await cleanup()
      try { workspace.dispose() } catch { /* idempotent */ }
      throw error
    }
  }

  private ensureCoreToolDeclarations(config: AgentConfig, workspace: AdfWorkspace): void {
    let changed = false
    const toolNames = new Set(config.tools.map(t => t.name))
    for (const toolName of ['msg_list', 'msg_read', 'msg_update']) {
      if (!toolNames.has(toolName)) {
        config.tools.push({ name: toolName, enabled: true, visible: true })
        changed = true
      }
    }
    for (const toolName of ['stream_bind', 'stream_unbind', 'stream_bindings']) {
      if (!toolNames.has(toolName)) {
        config.tools.push({ name: toolName, enabled: false })
        changed = true
      }
    }

    const legacyDecl = config.tools.find(t => t.name === 'container_exec')
    if (legacyDecl) {
      legacyDecl.name = 'compute_exec'
      changed = true
    }

    if (changed) workspace.setAgentConfig(config)
  }

  private createAdfCallHandler(opts: {
    workspace: AdfWorkspace
    config: AgentConfig
    provider: LLMProvider
    registry: ToolRegistry
    createProviderForModel?: (modelId: string) => LLMProvider
  }): AdfCallHandler | null {
    if (!this.codeSandboxService) return null

    const { config } = opts
    const hasSystemLambda = Object.values(config.triggers ?? {}).some(
      (tc: any) => tc?.enabled && tc?.targets?.some((t: any) => t.scope === 'system' && t.lambda),
    )
    const hasApiRoutes = (config.serving?.api?.length ?? 0) > 0
    const hasMiddleware = !!(
      config.security?.middleware?.inbox?.length ||
      config.security?.middleware?.outbox?.length ||
      config.security?.fetch_middleware?.length ||
      config.serving?.api?.some(r => r.middleware?.length)
    )
    const hasCodeTools = config.tools.some(t => t.name === 'sys_code' || t.name === 'sys_lambda')
    if (!hasSystemLambda && !hasApiRoutes && !hasMiddleware && !hasCodeTools) return null

    return new AdfCallHandler({
      toolRegistry: opts.registry,
      workspace: opts.workspace,
      config,
      provider: opts.provider,
      createProviderForModel: opts.createProviderForModel,
      // ONLY reads from adf_identity — code_access + spec-D13 key-material guard.
      resolveIdentity: (purpose: string) => opts.workspace.getIdentityForCode(purpose, null),
      getSigningKey: () => opts.workspace.getSigningKeys(null)?.privateKey ?? null,
    })
  }

  private registerCodeTools(
    registry: ToolRegistry,
    config: AgentConfig,
    agentId: string,
    adfCallHandler: AdfCallHandler | null,
  ): void {
    if (!this.codeSandboxService) return
    if (config.tools.some(t => t.name === 'sys_code')) {
      registry.register(new SysCodeTool(
        this.codeSandboxService,
        agentId,
        adfCallHandler ?? undefined,
        config.limits?.execution_timeout_ms,
      ))
    }
    if (adfCallHandler && config.tools.some(t => t.name === 'sys_lambda')) {
      registry.register(new SysLambdaTool(
        this.codeSandboxService,
        adfCallHandler,
        agentId,
        config.limits?.execution_timeout_ms,
      ))
    }
  }

  private registerComputeTools(registry: ToolRegistry, config: AgentConfig, filePath: string | null): Promise<void>[] {
    const agentHostAllowed = !!config.compute?.host_access
    const computeSettings = this.settings?.get('compute')
    const runtimeHostAllowed = this.getComputeRoutingSettings().hostAccessEnabled
    const hostInfo = agentHostAllowed && runtimeHostAllowed ? describeHostEnv() : undefined
    const targetSelection = resolveAgentComputeTargetSelection(computeSettings, config.compute)

    const caps: ComputeCapabilities = {
      hasIsolated: !!(config.compute?.enabled && this.podmanService),
      hasShared: !!this.podmanService,
      hasHost: agentHostAllowed && runtimeHostAllowed,
      ...targetSelection,
      isolatedContainerName: config.compute?.enabled ? isolatedContainerName(config.name, config.id) : undefined,
      browserDisplay: config.compute?.browser !== false,
      agentId: config.id,
      hostInfo,
    }

    const startup: Promise<void>[] = []
    if (caps.hasIsolated && this.podmanService) {
      const p = this.podmanService.ensureIsolatedRunning(config.name, config.id, config.compute?.packages?.pip, filePath ?? undefined, config.compute?.browser !== false)
        .then(() => this.podmanService?.ensureWorkspace(caps.isolatedContainerName!, '/workspace'))
        .then(() => undefined)
      p.catch(() => {})
      startup.push(p)
    }

    registry.register(new FsTransferTool(this.podmanService, caps))
    registry.register(new ComputeExecTool(this.podmanService, caps, config.limits?.execution_timeout_ms))
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
  ): Promise<{ manager: McpClientManager | null; scratchDir: string | null }> {
    // Create the manager unconditionally (parity with the Studio foreground and
    // background paths): mcp_install must be able to connect a server even when
    // the agent started with zero configured servers.
    const scratchDir = createScratchDir(filePathOrId)
    // OAuth (http) connect: attach + silently refresh the agent-sealed token.
    // No interactive step in this runtime — an absent token surfaces the
    // terminal "sign in from Settings" status, a locked envelope surfaces the
    // keystore's actionable hint (both propagate as the server's error). Reads
    // use derivedKey=null, matching materializeCredentialFiles here.
    const oauthProviderFactory = buildOAuthProviderFactory((cfg) =>
      resolveOAuthStoreForConnect({ agentStore: new AgentKeystoreOAuthStore(workspace, cfg.name, null) }),
    )
    const manager = new McpClientManager(scratchDir, oauthProviderFactory)

    manager.on('log', (serverName, entry) => {
      const level = entry.stream === 'stderr' ? 'warn' : 'info'
      try { workspace.insertLog(level, 'mcp', entry.stream, serverName, entry.message) } catch { /* ignore */ }
    })
    manager.on('status-changed', (serverName, status, error) => {
      if (status === 'error') {
        try { workspace.insertLog('error', 'mcp', 'status', serverName, error ?? 'MCP server entered error state') } catch { /* ignore */ }
      }
    })

    // Connect ONE already-configured server, sync its discovered tools, persist,
    // and fan the fresh config out to the live executor. Shared by the initial
    // connect loop and the mcp_install / mcp_restart closures. `freshConfig` is
    // the caller's responsibility — the closures pass workspace.getAgentConfig()
    // so post-start config changes are never clobbered by a start-time snapshot.
    const connectOneServer = async (
      freshConfig: AgentConfig,
      serverName: string,
      reason: string,
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

      const resolvedEnv = resolveMcpEnvVars(connCfg, key => workspace.getIdentityDecrypted(key, null))
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
      const willContainerize = connCfg.transport !== 'http'
        && shouldContainerize(connCfg.name, connCfg, freshConfig, this.getComputeRoutingSettings())
      if (connCfg.transport === 'http') {
        location = 'remote http'
      } else if (this.podmanService && willContainerize) {
        // connCfg (pinned to the registration for Settings-managed servers) —
        // never the agent-writable serverCfg — so a tampered .adf command/args
        // can't reach the container spawn.
        const containerCmd = resolveContainerCommand(connCfg)
        const isolated = shouldIsolate(freshConfig) && !isServerForceShared(connCfg)
        location = isolated ? 'isolated container' : 'shared container'
        try {
          if (isolated) {
            await this.podmanService.ensureIsolatedRunning(freshConfig.name, freshConfig.id, freshConfig.compute?.packages?.pip)
          } else {
            await this.podmanService.ensureRunning()
          }
        } catch (containerErr) {
          // Fail plainly — never silently fall back to host execution when
          // routing decided this server must be containerized.
          const detail = containerErr instanceof Error ? containerErr.message : String(containerErr)
          throw new Error(`MCP container for "${connCfg.name}" is not ready: ${detail} Once the compute environment is fixed, call mcp_restart("${connCfg.name}") to reconnect.`)
        }

        const podmanBin = await this.podmanService.findPodman()
        if (!podmanBin) throw new Error(`Podman is unavailable for MCP server "${connCfg.name}" — install it (https://podman.io/docs/installation) or start the compute environment in ADF Studio → Settings → Compute, then call mcp_restart("${connCfg.name}").`)
        const containerName = isolated ? isolatedContainerName(freshConfig.name, freshConfig.id) : 'adf-mcp'
        try { await this.podmanService.ensureWorkspace(containerName, containerWorkspacePath(isolated, freshConfig.id)) } catch { /* ignore */ }
        try { await this.podmanService.ensureWorkspace(containerName, containerAgentHome(isolated, freshConfig.id)) } catch { /* ignore */ }
        // Materialize keystore-held credential files into the container before spawn.
        await materializeCredentialFiles(
          { getDecrypted: (p) => workspace.getIdentityDecrypted(p, null), hasRow: (p) => workspace.getIdentityRow(p) !== null, envelopeLockedHint: this.credentialEnvelopeLockedHint },
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
          }
        }
      }

      if (!connectOptions && connCfg.transport !== 'http') {
        // Host credential materialization ONLY when routing actually chose
        // host — a container-intended server (e.g. builder constructed
        // without a podman service) must never write credentials to host.
        if (!willContainerize) {
          await materializeCredentialFiles(
            { getDecrypted: (p) => workspace.getIdentityDecrypted(p, null), hasRow: (p) => workspace.getIdentityRow(p) !== null, envelopeLockedHint: this.credentialEnvelopeLockedHint },
            connCfg,
            { kind: 'host' },
          )
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
        const state = manager.getServerState(serverName)
        const stderrTail = state?.logs.filter(l => l.stream === 'stderr').slice(-5).map(l => l.message)
        return { toolsDiscovered: 0, location, error: state?.error, stderrTail: stderrTail?.length ? stderrTail : undefined }
      }

      const changed = syncDiscoveredMcpTools(freshConfig, serverCfg, tools, registry, manager)
      const nextSchema = captureEnvSchema(serverCfg, appEnvKeys, agentEnvKeys)
      if (nextSchema) serverCfg.env_schema = nextSchema
      if (changed || nextSchema) workspace.setAgentConfig(freshConfig)
      const assembled = getAssembled()
      assembled?.executor.updateConfig(freshConfig)
      assembled?.triggerEvaluator.updateConfig(freshConfig)
      adfCallHandler?.updateConfig(freshConfig)
      return { toolsDiscovered: tools.length, location }
    }

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
        const resolvedEnv = resolveMcpEnvVars(cfg, key => workspace.getIdentityDecrypted(key, null))
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
          await (isolated
            ? this.podmanService.ensureIsolatedRunning(freshConfig.name, freshConfig.id, freshConfig.compute?.packages?.pip)
            : this.podmanService.ensureRunning())
          const podmanBin = await this.podmanService.findPodman()
          if (!podmanBin) throw new Error(`Podman is unavailable for MCP server "${cfg.name}" — install it (https://podman.io/docs/installation) or start the compute environment in ADF Studio → Settings → Compute, then call mcp_restart("${cfg.name}").`)
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
        const credStore = { getDecrypted: (p: string) => workspace.getIdentityDecrypted(p, null), hasRow: (p: string) => workspace.getIdentityRow(p) !== null, envelopeLockedHint: this.credentialEnvelopeLockedHint }
        // Host credential target ONLY when routing chose host — a
        // container-intended server without a podman service must not
        // materialize or capture credentials on the host.
        const credTarget: CredentialFileTarget | null = container && podmanSvc
          ? containerCredentialTarget(podmanSvc, container.containerName, container.home ?? '/root')
          : (!willContainerize ? { kind: 'host' } : null)
        if (credTarget) await materializeCredentialFiles(credStore, cfg, credTarget)
        await this.mcpAuthPreflight(cfg, { authArgs: installOptions.authArgs, resolvedEnv, uvBinPath, container, authPort: installOptions.authPort })
        // Auth succeeded: capture files the flow stored (tokens) into the keystore.
        if (credTarget) await writeBackCredentialFiles({ setIdentitySealed: (p, v) => workspace.setIdentitySealed(p, v) }, cfg, credTarget, new Date().toISOString(), (m) => { console.log(m); try { workspace.insertLog('info', 'mcp', 'credential_writeback', cfg.name, m.slice(0, 500)) } catch { /* non-fatal */ } })
      }
      return connectOneServer(freshConfig, serverName, 'Hot-load')
    }, () => this.getMcpRegistrations()))
    registry.register(new McpRestartTool(async (serverName) => {
      return connectOneServer(workspace.getAgentConfig(), serverName, 'Agent reconnect')
    }))
    registry.register(new McpUninstallTool((serverName) => {
      manager.disconnect(serverName).catch(() => {})
    }))

    if (!config.mcp?.servers?.length) return { manager, scratchDir }

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
            const outcome = await connectOneServer(config, serverCfg.name, 'Initial connect')
            return { name: serverCfg.name, skipped: false, attempted: true, connected: outcome.toolsDiscovered > 0 }
          } catch (err) {
            console.error(`[AgentRuntimeBuilder][MCP] connect failed for "${serverCfg.name}":`, err)
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

      for (const declaration of config.tools) {
        if (!declaration.name.startsWith('mcp_')) continue
        const serverName = config.mcp.servers.find(server => declaration.name.startsWith(`mcp_${server.name}_`))?.name
        if (serverName && !connectedServerNames.has(serverName) && !attemptedServerNames.has(serverName) && declaration.enabled) {
          declaration.enabled = false
          configChanged = true
        }
      }

      if (configChanged) workspace.setAgentConfig(config)
      return { manager, scratchDir }
    } catch (err) {
      console.error(`[AgentRuntimeBuilder][MCP] setup failed:`, err)
      await manager.disconnectAll().catch(() => {})
      removeScratchDir(scratchDir)
      return { manager: null, scratchDir: null }
    }
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
    }
  }

  private async registerChannelAdapters(
    workspace: AdfWorkspace,
    config: AgentConfig,
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
      if (envelopesLocked && adapterCredentialsLocked(workspace, adapterType, null, registration.env)) {
        console.error(`[AgentRuntimeBuilder][Adapter] Skipping "${adapterType}" for ${config.name} — envelope-sealed credentials are locked`)
        try { workspace.insertLog('error', 'adapter', 'credentials_locked', adapterType, 'Envelope-sealed credentials are locked in this process — adapter not started') } catch { /* ignore */ }
        await manager.startAdapter(adapterType, () => createLockedCredentialsAdapter(adapterType), adapterConfig, workspace, null, registration.env)
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
          null,
          registration.env,
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
 * of them decrypts to null (envelope-sealed rows this process cannot unlock)
 * and no app-level env fallback covers it. Starting such an adapter would
 * fail fast and never recover.
 */
export function adapterCredentialsLocked(
  workspace: AdfWorkspace,
  adapterType: string,
  derivedKey: Buffer | null,
  appEnv?: { key: string; value: string }[],
): boolean {
  if (appEnv?.some(entry => entry.key && entry.value)) return false
  try {
    const purposes = workspace.listIdentityPurposes(`adapter:${adapterType}:`)
    if (purposes.length === 0) return false
    return purposes.every(purpose => workspace.getIdentityDecrypted(purpose, derivedKey) === null)
  } catch {
    return false
  }
}

/**
 * Stub adapter whose start() rejects with a clear "credentials locked"
 * message: startAdapter records the error status/log without ever attempting
 * a real connection.
 */
export function createLockedCredentialsAdapter(adapterType: string): ChannelAdapter {
  const error = `credentials locked — envelope-sealed credentials for "${adapterType}" cannot be decrypted in this process. Start Studio once or configure daemon identity.`
  return {
    start: async () => { throw new Error(error) },
    stop: async () => {},
    send: async () => ({ success: false, error }),
    canDeliver: () => false,
    status: () => 'error',
  }
}
