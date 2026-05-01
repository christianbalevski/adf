import { AgentExecutor } from './agent-executor'
import { AgentSession } from './agent-session'
import { AdfCallHandler } from './adf-call-handler'
import { SystemScopeHandler } from './system-scope-handler'
import { TriggerEvaluator } from './trigger-evaluator'
import { RuntimeGate } from './runtime-gate'
import { join } from 'path'
import { ToolRegistry } from '../tools/tool-registry'
import { registerBuiltInTools } from '../tools/built-in/register-built-in-tools'
import {
  CreateAdfTool,
  ComputeExecTool,
  FsTransferTool,
  SysCodeTool,
  SysLambdaTool,
  SysFetchTool,
  SysGetConfigTool,
  SysUpdateConfigTool,
  StreamBindTool,
  StreamUnbindTool,
  StreamBindingsTool,
  buildToolDiscovery,
} from '../tools/built-in'
import { StreamBindingManager } from './stream-binding-manager'
import { isolatedContainerName, containerWorkspacePath } from '../services/podman.service'
import { resolveHostEnv } from '../services/host-exec.service'
import type { WsConnectionManager } from '../services/ws-connection-manager'
import type { PodmanService } from '../services/podman.service'
import type { CodeSandboxService } from './code-sandbox'
import type { LLMProvider } from '../providers/provider.interface'
import type { AdfWorkspace } from '../adf/adf-workspace'
import type { AgentConfig, McpToolInfo } from '../../shared/types/adf-v02.types'
import type { ComputeCapabilities } from '../tools/built-in/compute-target'
import type { HeadlessAgent } from './headless'
import type { RuntimeSettingsStore } from './runtime-service'
import type { AdfBatchDispatch, AdfEventDispatch } from '../../shared/types/adf-event.types'
import { McpClientManager } from '../services/mcp-client-manager'
import { createScratchDir, removeScratchDir } from '../utils/scratch-dir'
import { PackageResolver } from '../services/mcp-package-resolver'
import { captureEnvSchema, resolveMcpEnvVars, resolveMcpSpawnConfig } from '../services/mcp-spawn-utils'
import type { UvxPackageResolver } from '../services/uvx-package-resolver'
import type { UvManager } from '../services/uv-manager'
import { PodmanStdioTransport } from '../services/podman-stdio-transport'
import { shouldContainerize, shouldIsolate, isServerForceShared, type ComputeSettings } from '../services/container-routing'
import { resolveContainerCommand } from '../services/container-command-resolver'
import { syncDiscoveredMcpTools } from '../services/mcp-tool-sync'
import type { McpServerRegistration } from '../../shared/types/ipc.types'
import { ChannelAdapterManager } from '../services/channel-adapter-manager'
import type { AdapterRegistration, CreateAdapterFn } from '../../shared/types/channel-adapter.types'
import { getEnabledAgentAdapterConfig, withBuiltInAdapterRegistrations } from '../../shared/constants/adapter-registry'

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
  }

  async build(opts: BuildAgentRuntimeOptions): Promise<HeadlessAgent> {
    const { workspace, filePath, config, provider } = opts
    const agentId = filePath ?? config.id
    const session = new AgentSession(workspace)

    if (opts.restoreLoop) {
      const existingLoop = workspace.getLoop()
      if (existingLoop.length > 0) {
        session.restoreMessages(existingLoop.map(e => ({ role: e.role, content: e.content_json })))
      }
    }

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
    const computeStartup = this.registerComputeTools(registry, config)
    const mcpRuntime = await this.registerMcpTools(registry, workspace, config, filePath ?? config.id)
    const adapterRuntime = await this.registerChannelAdapters(workspace, config)
    const streamBindingManager = this.registerStreamBindingTools(registry, workspace, config, agentId, filePath ?? config.id)
    this.wireFetchMiddleware(registry, workspace, agentId, adfCallHandler)
    const sysGetConfigTool = registry.get('sys_get_config') as SysGetConfigTool | undefined
    sysGetConfigTool?.setToolDiscoveryProvider((ws) => buildToolDiscovery(ws.getAgentConfig(), registry))

    const executor = new AgentExecutor(
      config,
      provider,
      registry,
      session,
      this.basePrompt,
      this.toolPrompts,
      this.compactionPrompt,
    )

    if (this.codeSandboxService && adfCallHandler) {
      executor.setSystemScopeHandler(
        new SystemScopeHandler(workspace, this.codeSandboxService, adfCallHandler, agentId),
      )
    }

    const triggerEvaluator = this.wireTriggerEvaluator({
      workspace,
      config,
      executor,
      registry,
      adfCallHandler,
      adapterManager: adapterRuntime.manager,
      filePath,
    })

    let disposed = false
    const cleanup = async (awaitAsync: boolean) => {
      if (disposed) return
      disposed = true
      executor.removeAllListeners()
      triggerEvaluator.dispose()
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
      if (this.podmanService && config.compute?.enabled) {
        cleanupPromises.push(this.stopIsolatedAfterStartup(config, computeStartup))
      }
      if (awaitAsync) {
        await Promise.allSettled(cleanupPromises)
      } else {
        cleanupPromises.forEach(p => p.catch(() => {}))
      }
      removeScratchDir(mcpRuntime.scratchDir)
      if (this.codeSandboxService) {
        try { this.codeSandboxService.destroy(agentId) } catch { /* best effort */ }
      }
      try { workspace.dispose() } catch { /* idempotent */ }
    }
    const dispose = () => { void cleanup(false) }
    const disposeAsync = () => cleanup(true)

    return {
      executor,
      session,
      workspace,
      registry,
      adfCallHandler,
      adapterManager: adapterRuntime.manager,
      codeSandboxService: this.codeSandboxService,
      triggerEvaluator,
      mcpManager: mcpRuntime.manager,
      dispose,
      disposeAsync,
    }
  }

  private wireTriggerEvaluator(opts: {
    workspace: AdfWorkspace
    config: AgentConfig
    executor: AgentExecutor
    registry: ToolRegistry
    adfCallHandler: AdfCallHandler | null
    adapterManager: ChannelAdapterManager | null
    filePath: string | null
  }): TriggerEvaluator {
    const { workspace, config, executor, registry, adfCallHandler, adapterManager, filePath } = opts
    const triggerEvaluator = new TriggerEvaluator(config)
    triggerEvaluator.setDisplayState(config.start_in_state ?? 'idle')
    triggerEvaluator.setWorkspace(workspace)
    triggerEvaluator.startTimerPolling(workspace)

    triggerEvaluator.on('trigger', async (dispatch: AdfEventDispatch | AdfBatchDispatch) => {
      if (RuntimeGate.stopped) return
      const eventType = 'event' in dispatch ? dispatch.event.type : dispatch.events[0]?.type ?? 'batch'
      try {
        await executor.executeTurn(dispatch)
      } catch (err) {
        try {
          workspace.insertLog(
            'error',
            'runtime',
            'trigger_error',
            eventType,
            String(err instanceof Error ? err.message : err).slice(0, 200),
          )
        } catch { /* non-fatal */ }
      }
    })

    executor.on('event', (event) => {
      if (event.type === 'state_changed') {
        const payload = event.payload as { state?: string }
        if (payload.state) triggerEvaluator.setDisplayState(payload.state)
      }
    })

    workspace.setOnLogCallback((level, origin, event, target, message) => {
      triggerEvaluator.onLog(level, origin, event, target, message)
    })

    executor.onToolCallIntercepted = (tool, args, taskId, origin, systemScopeHandled) => {
      triggerEvaluator.onToolCall(tool, args, taskId, origin, systemScopeHandled)
    }
    executor.onTaskCreated = (task) => {
      triggerEvaluator.onTaskCreate(task)
    }
    executor.onTaskCompleted = (taskId, tool, status, result, error, sideEffects) => {
      triggerEvaluator.onTaskComplete(taskId, tool, status, result, error)
      this.applyStateTransitionSideEffect(executor, tool, status, result, sideEffects)
    }
    executor.onLlmCall = (data) => {
      triggerEvaluator.onLlmCall(data)
    }

    if (adfCallHandler) {
      adfCallHandler.onTaskCompleted = (taskId, tool, status, result, error, sideEffects) => {
        triggerEvaluator.onTaskComplete(taskId, tool, status, result, error)
        this.applyStateTransitionSideEffect(executor, tool, status, result, sideEffects)
      }
      adfCallHandler.onLambdaToolEndTurn = (tool, resultContent) => {
        this.applyStateTransitionSideEffect(executor, tool, 'completed', resultContent, { endTurn: true })
      }
      adfCallHandler.onHilApproved = (taskId, approved, modifiedArgs) => {
        executor.resolveHilTask(taskId, approved, modifiedArgs)
      }
      adfCallHandler.onLlmCall = (data) => {
        triggerEvaluator.onLlmCall(data)
      }
    }

    const sysUpdateTool = registry.get('sys_update_config') as SysUpdateConfigTool | undefined
    if (sysUpdateTool) {
      sysUpdateTool.onConfigChanged = (updatedConfig) => {
        executor.updateConfig(updatedConfig)
        triggerEvaluator.updateConfig(updatedConfig)
        adfCallHandler?.updateConfig(updatedConfig)
      }
    }

    const createAdfTool = registry.get('sys_create_adf') as CreateAdfTool | undefined
    if (createAdfTool) {
      createAdfTool.onAutostartChild = async () => false
    }

    if (adapterManager) {
      adapterManager.on('inbound', (adapterType, adapterMsg, meta) => {
        const sender = `${adapterType}:${adapterMsg.sender}`
        triggerEvaluator.onInbox(sender, adapterMsg.payload, {
          source: adapterType,
          messageId: meta.inboxId,
          parentId: meta.parentId,
          sourceMeta: adapterMsg.sourceMeta,
        })
      })
    }

    return triggerEvaluator
  }

  private applyStateTransitionSideEffect(
    executor: AgentExecutor,
    tool: string,
    status: string,
    result: string | undefined,
    sideEffects?: { endTurn?: boolean },
  ): void {
    if (!sideEffects?.endTurn || tool !== 'sys_set_state' || status !== 'completed' || !result) return
    try {
      const parsed = JSON.parse(result)
      if (parsed.target_state) executor.applyDeferredStateTransition(parsed.target_state)
    } catch { /* ignore parse errors */ }
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
      resolveIdentity: (purpose: string) => {
        const row = opts.workspace.getIdentityRow(purpose)
        if (!row?.code_access) return null
        return opts.workspace.getIdentityDecrypted(purpose, null)
      },
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

  private registerComputeTools(registry: ToolRegistry, config: AgentConfig): Promise<void>[] {
    const agentHostAllowed = !!config.compute?.host_access
    const runtimeHostAllowed = this.getComputeRoutingSettings().hostAccessEnabled
    const hostInfo = agentHostAllowed && runtimeHostAllowed ? describeHostEnv() : undefined

    const caps: ComputeCapabilities = {
      hasIsolated: !!(config.compute?.enabled && this.podmanService),
      hasShared: !!this.podmanService,
      hasHost: agentHostAllowed,
      isolatedContainerName: config.compute?.enabled ? isolatedContainerName(config.name, config.id) : undefined,
      agentId: config.id,
      hostInfo,
    }

    const startup: Promise<void>[] = []
    if (caps.hasIsolated && this.podmanService) {
      const p = this.podmanService.ensureIsolatedRunning(config.name, config.id)
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
  ): Promise<{ manager: McpClientManager | null; scratchDir: string | null }> {
    if (!config.mcp?.servers?.length) return { manager: null, scratchDir: null }

    const scratchDir = createScratchDir(filePathOrId)
    const manager = new McpClientManager(scratchDir)

    manager.on('log', (serverName, entry) => {
      const level = entry.stream === 'stderr' ? 'warn' : 'info'
      try { workspace.insertLog(level, 'mcp', entry.stream, serverName, entry.message) } catch { /* ignore */ }
    })
    manager.on('status-changed', (serverName, status, error) => {
      if (status === 'error') {
        try { workspace.insertLog('error', 'mcp', 'status', serverName, error ?? 'MCP server entered error state') } catch { /* ignore */ }
      }
    })

    try {
      const registrations = this.getMcpRegistrations()
      const registeredNames = new Set(registrations.map(r => r.name))
      const needsUv = config.mcp.servers.some(server => server.pypi_package || server.command === 'uvx')
      let uvBinPath: string | undefined
      if (needsUv && this.uvManager) {
        try { uvBinPath = await this.uvManager.ensureUv() } catch (err) {
          console.warn('[AgentRuntimeBuilder][MCP] Failed to resolve uv binary:', err)
        }
      }

      const results = await Promise.allSettled(
        config.mcp.servers.map(async (serverCfg) => {
          if (!registeredNames.has(serverCfg.name) && !serverCfg.source) {
            console.log(`[AgentRuntimeBuilder][MCP] Skipping "${serverCfg.name}" — not registered in Settings`)
            return { serverCfg, tools: null as McpToolInfo[] | null, skipped: true }
          }

          const connCfg = { ...serverCfg }
          const registration = registrations.find(r => r.name === connCfg.name)
          if (registration?.toolCallTimeout) {
            connCfg.tool_call_timeout_ms = registration.toolCallTimeout * 1000
          }
          if (registration?.url && connCfg.transport === 'http') connCfg.url = registration.url
          if (registration?.headers?.length) {
            const appHeaders: Record<string, string> = {}
            for (const { key, value } of registration.headers) {
              if (key && value) appHeaders[key] = value
            }
            if (Object.keys(appHeaders).length) connCfg.headers = { ...connCfg.headers, ...appHeaders }
          }
          if (registration?.headerEnv?.length) {
            connCfg.header_env = [
              ...(connCfg.header_env ?? []),
              ...registration.headerEnv
                .filter((entry) => entry.key && entry.value)
                .map((entry) => ({ header: entry.key, env: entry.value, required: true }))
            ]
          }
          if (registration?.bearerTokenEnvVar) {
            connCfg.bearer_token_env_var = registration.bearerTokenEnvVar
          }

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

          let connectOptions: import('../services/mcp-client-manager').McpConnectOptions | undefined
          if (connCfg.transport === 'http') {
            // Remote HTTP MCP servers are connected directly; process/container routing is stdio-only.
          } else if (this.podmanService && shouldContainerize(connCfg.name, serverCfg, config, this.getComputeRoutingSettings())) {
            const containerCmd = resolveContainerCommand(serverCfg)
            const isolated = shouldIsolate(config) && !isServerForceShared(serverCfg)
            try {
              if (isolated) {
                await this.podmanService.ensureIsolatedRunning(config.name, config.id)
              } else {
                await this.podmanService.ensureRunning()
              }
            } catch {
              // Fall back to host resolution below if Podman is unavailable.
            }

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
                }),
              }
            }
          }

          if (!connectOptions && connCfg.transport !== 'http') {
            const spawn = resolveMcpSpawnConfig(connCfg, {
              npmResolver: this.mcpPackageResolver,
              uvxResolver: this.uvxPackageResolver ?? undefined,
              uvBinPath,
            })
            if (spawn.command) connCfg.command = spawn.command
            if (spawn.args) connCfg.args = spawn.args
          }

          const tools = await manager.connect(connCfg, connectOptions)
          return { serverCfg, tools, skipped: false, appEnvKeys, agentEnvKeys }
        }),
      )

      let configChanged = false
      const connectedServerNames = new Set<string>()
      const attemptedServerNames = new Set<string>()

      for (const result of results) {
        if (result.status !== 'fulfilled' || result.value.skipped) continue
        attemptedServerNames.add(result.value.serverCfg.name)
        if (!result.value.tools) continue

        const { serverCfg, tools, appEnvKeys, agentEnvKeys } = result.value
        connectedServerNames.add(serverCfg.name)
        if (syncDiscoveredMcpTools(config, serverCfg, tools, registry, manager)) {
          configChanged = true
        }

        const nextSchema = captureEnvSchema(serverCfg, appEnvKeys ?? [], agentEnvKeys ?? [])
        if (nextSchema) {
          serverCfg.env_schema = nextSchema
          configChanged = true
        }

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
    return {
      hostAccessEnabled: raw?.hostAccessEnabled === true,
      hostApproved: Array.isArray(raw?.hostApproved)
        ? raw.hostApproved.filter((value): value is string => typeof value === 'string')
        : [],
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

    const configuredAdapters = config.adapters ?? {}
    for (const registration of registrations) {
      const adapterType = registration.type
      const adapterConfig = getEnabledAgentAdapterConfig(configuredAdapters, adapterType)
      if (!adapterConfig) continue

      const createFn = await this.resolveAdapterFactory(adapterType, registration)
      if (!createFn) continue

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
    }

    if (manager.getRunningTypes().length === 0) {
      manager.removeAllListeners()
      return { manager: null }
    }
    return { manager }
  }

  private async resolveAdapterFactory(
    adapterType: string,
    registration: AdapterRegistration,
  ): Promise<CreateAdapterFn | null> {
    try {
      if (adapterType === 'telegram') {
        const mod = await import('../adapters/telegram/index')
        return mod.createAdapter
      }
      if (adapterType === 'email') {
        const mod = await import('../adapters/email/index')
        return mod.createAdapter
      }
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
    })
  }
}

function describeHostEnv(): string {
  try {
    const env = resolveHostEnv()
    return `Host environment (target='host'): ${env.osLabel} ${env.release}, shell: ${env.shell.label} (${env.shell.family}). Adjust commands to match the host OS and shell when targeting 'host'.`
  } catch {
    return 'Host environment (target=\'host\'): details unavailable.'
  }
}
