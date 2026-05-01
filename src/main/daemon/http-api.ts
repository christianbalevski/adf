import { readFileSync } from 'node:fs'
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify'
import { nanoid } from 'nanoid'
import {
  RuntimeReviewRequiredError,
  type RuntimeService,
} from '../runtime/runtime-service'
import {
  ADF_EVENT_TYPES,
  type AdfBatchDispatch,
  type AdfEvent,
  type AdfEventDispatch,
} from '../../shared/types/adf-event.types'
import { getChatGptAuthManager } from '../providers/chatgpt-subscription/auth-manager'
import { getTokenCounterService } from '../services/token-counter.service'
import { getTokenUsageService } from '../services/token-usage.service'
import type { ComputeEnvInfo } from '../services/podman.service'
import type { DaemonEventBus, DaemonEventEnvelope } from './event-bus'
import type { AgentConfig, AdfProviderConfig, CodeExecutionPackage, FileProtectionLevel, McpInstalledPackage, McpServerConfig, MetaProtectionLevel, TaskStatus, WsConnectionInfo } from '../../shared/types/adf-v02.types'
import type { McpServerRegistration, ProviderConfig } from '../../shared/types/ipc.types'
import type { AdapterInstanceConfig, AdapterRegistration } from '../../shared/types/channel-adapter.types'
import { withBuiltInAdapterRegistrations } from '../../shared/constants/adapter-registry'
import { getLanAddresses } from '../utils/network'

export interface DaemonHttpApiOptions {
  logger?: boolean
  computeService?: DaemonComputeService
  settingsStore?: DaemonSettingsStore
  eventBus?: DaemonEventBus
  wsService?: DaemonWsService
  networkService?: DaemonNetworkService
  mcpPackageService?: DaemonPackageService
  mcpPythonPackageService?: DaemonPythonPackageService
  adapterPackageService?: DaemonPackageService
  sandboxPackageService?: DaemonSandboxPackageService
}

export interface DaemonComputeService {
  getStatus(): ComputeEnvInfo
  listContainers(): Promise<Array<{ name: string; status: string; running: boolean }>>
  ensureRunning(): Promise<void>
  stop(): Promise<void>
  stopAll?(): Promise<void>
  destroy?(): Promise<void>
  startContainer?(name: string): Promise<boolean>
  stopContainer?(name: string): Promise<boolean>
  destroyContainer?(name: string): Promise<boolean>
  getContainerDetail?(name: string): Promise<Record<string, unknown>>
  getExecLog?(name?: string): Array<Record<string, unknown>>
  setup?(step: 'install' | 'machine_init' | 'machine_start' | 'check', installCommand?: string): Promise<Record<string, unknown>>
}

export interface DaemonSettingsStore {
  filePath?: string
  get(key: string): unknown
  set?(key: string, value: unknown): void
  getAll?(): Record<string, unknown>
  update?(values: Record<string, unknown>): void
}

export interface DaemonWsService {
  getConnections(agentFilePath?: string, filter?: { direction?: 'inbound' | 'outbound' }): WsConnectionInfo[]
}

export interface DaemonNetworkService {
  getStatus(): Record<string, unknown>
  enableMesh?(): Promise<Record<string, unknown>> | Record<string, unknown>
  disableMesh?(): Promise<Record<string, unknown>> | Record<string, unknown>
  getRecentTools?(limit?: number): Record<string, unknown>
  getServerStatus?(): Record<string, unknown>
  startServer?(): Promise<Record<string, unknown>> | Record<string, unknown>
  stopServer?(): Promise<Record<string, unknown>> | Record<string, unknown>
  restartServer?(): Promise<Record<string, unknown>> | Record<string, unknown>
  getLanAddresses?(): string[]
  getDiscoveredRuntimes?(): Promise<unknown[]> | unknown[]
}

export interface DaemonPackageService {
  install(packageName: string, onProgress?: (message: string) => void): Promise<McpInstalledPackage>
  uninstall(packageName: string): Promise<void>
  listInstalled(): McpInstalledPackage[]
}

export interface DaemonPythonPackageService {
  install(packageName: string, version?: string, onProgress?: (message: string) => void): Promise<McpInstalledPackage>
  uninstall(packageName: string): Promise<void>
  listInstalled(): McpInstalledPackage[]
}

export interface DaemonSandboxPackageEntry {
  name: string
  version: string
  installedAt: number
  size_mb: number
  installedBy?: string
}

export interface DaemonSandboxPackageService {
  install(name: string, version?: string, onProgress?: (message: string) => void, agentName?: string): Promise<{ name: string; version: string; size_mb: number; already_installed: boolean }>
  uninstall(name: string): boolean
  checkMissing(packages: CodeExecutionPackage[]): CodeExecutionPackage[]
  getInstalledModules(): string[]
  getInstalledPackages(): DaemonSandboxPackageEntry[]
  getBasePath(): string
}

interface AgentIdParams {
  id: string
}

interface SettingsKeyParams {
  key: string
}

interface SettingsPutBody {
  value?: unknown
}

interface PackageNameQuery {
  package?: string
}

interface ContainerNameParams {
  name: string
}

interface ComputeExecLogQuery {
  name?: string
}

interface ComputeSetupBody {
  step?: 'install' | 'machine_init' | 'machine_start' | 'check'
  installCommand?: string
}

interface NetworkRecentToolsQuery {
  limit?: string
}

interface LoopQuery {
  limit?: string
  offset?: string
}

interface LogsQuery {
  limit?: string
  origin?: string
  event?: string
}

interface ResourceStatusQuery {
  status?: string
}

interface TasksQuery {
  status?: string
  limit?: string
}

interface TaskIdParams extends AgentIdParams {
  taskId: string
}

interface TimerIdParams extends AgentIdParams {
  timerId: string
}

interface AskIdParams extends AgentIdParams {
  requestId: string
}

interface MetaKeyParams extends AgentIdParams {
  key: string
}

interface IdentityPurposeParams extends AgentIdParams {
  purpose: string
}

interface ProviderParams extends AgentIdParams {
  providerId: string
}

interface McpServerParams extends AgentIdParams {
  serverName: string
}

interface AdapterParams extends AgentIdParams {
  adapterType: string
}

interface TableParams extends AgentIdParams {
  table: string
}

interface TaskResolveBody {
  action?: 'approve' | 'deny' | 'pending_approval'
  reason?: string
  modifiedArgs?: Record<string, unknown>
  modified_args?: Record<string, unknown>
}

interface AskRespondBody {
  answer?: string
}

interface SuspendRespondBody {
  resume?: boolean
}

interface FileContentQuery {
  path?: string
}

interface TableQuery {
  limit?: string
  offset?: string
}

interface EventsQuery {
  agentId?: string
  since?: string
}

interface ModelsQuery {
  provider?: string
  agentId?: string
}

interface IdentityListQuery {
  prefix?: string
}

interface McpCredentialQuery {
  npmPackage?: string
}

interface McpDetachQuery {
  credentialNamespace?: string
}

interface LoadAgentBody {
  filePath?: string
  /** Direct local loads bypass review by default; set true for stricter clients. */
  requireReview?: boolean
}

interface AutostartBody {
  trackedDirs?: string[]
  maxDepth?: number
}

interface ChatBody {
  text?: string
}

interface TriggerBody {
  dispatch?: unknown
}

interface ContentBody {
  content?: string
}

interface FileWriteBody {
  content?: string
  content_base64?: string
  contentBase64?: string
  mimeType?: string
  mime_type?: string
  protection?: FileProtectionLevel
}

interface FileRenameBody {
  oldPath?: string
  newPath?: string
}

interface FolderRenameBody {
  oldPrefix?: string
  newPrefix?: string
}

interface FileProtectionBody {
  path?: string
  protection?: FileProtectionLevel
}

interface FileAuthorizedBody {
  path?: string
  authorized?: boolean
}

interface MetaSetBody {
  value?: string
  protection?: MetaProtectionLevel
}

interface MetaProtectionBody {
  protection?: MetaProtectionLevel
}

interface IdentityValueBody {
  value?: string
}

interface IdentityCodeAccessBody {
  codeAccess?: boolean
  code_access?: boolean
}

interface IdentityPasswordBody {
  password?: string
}

interface IdentityChangePasswordBody {
  newPassword?: string
  new_password?: string
}

interface ProviderAttachBody {
  provider?: AdfProviderConfig
}

interface McpCredentialBody {
  npmPackage?: string
  envKey?: string
  value?: string
}

interface McpAttachBody {
  server?: McpServerConfig
  serverConfig?: McpServerConfig
}

interface AdapterCredentialBody {
  adapterType?: string
  envKey?: string
  value?: string
}

interface AdapterAttachBody {
  adapterType?: string
  config?: AdapterInstanceConfig
}

interface TokenCountBody {
  text?: string
  texts?: string[]
  provider?: string
  model?: string
  agentId?: string
}

interface PackageInstallBody {
  package?: string
  name?: string
  version?: string
  agentName?: string
}

interface SandboxCheckBody {
  packages?: CodeExecutionPackage[]
}

interface TimerMutationBody {
  id?: number
  mode?: 'once_at' | 'once_delay' | 'interval' | 'cron'
  at?: number
  delay_ms?: number
  every_ms?: number
  start_at?: number
  end_at?: number
  max_runs?: number
  cron?: string
  scope?: string[]
  lambda?: string
  warm?: boolean
  payload?: string
  locked?: boolean
}

interface ReviewQuery {
  filePath?: string
}

interface ReviewAcceptBody {
  filePath?: string
}

let cachedOpenApiSpec: unknown | null = null

function getOpenApiSpec(): unknown {
  if (!cachedOpenApiSpec) {
    cachedOpenApiSpec = JSON.parse(
      readFileSync(new URL('../../../docs/daemon/openapi.json', import.meta.url), 'utf-8'),
    )
  }
  return cachedOpenApiSpec
}

export function createDaemonHttpApi(
  runtime: RuntimeService,
  opts: DaemonHttpApiOptions = {},
): FastifyInstance {
  const server = Fastify({ logger: opts.logger ?? false })

  server.get('/openapi.json', async () => getOpenApiSpec())

  server.get('/health', async () => ({ ok: true }))

  server.get<{ Querystring: EventsQuery }>('/events', async (request, reply) => {
    if (!opts.eventBus) return unavailable(reply, 'Event bus is not configured.')
    const since = parseOptionalInteger(request.query.since)
    if (request.query.since !== undefined && since === undefined) {
      return badRequest(reply, 'since must be an integer')
    }

    reply.hijack()
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    reply.raw.write(': connected\n\n')

    const agentId = request.query.agentId
    const send = (event: DaemonEventEnvelope) => {
      if (agentId && event.agentId !== agentId) return
      writeSseEvent(reply.raw, event)
    }

    for (const event of opts.eventBus.getSince(since ?? 0, agentId)) {
      send(event)
    }

    const unsubscribe = opts.eventBus.subscribe(send)
    const heartbeat = setInterval(() => {
      if (!reply.raw.destroyed) reply.raw.write(`: heartbeat ${Date.now()}\n\n`)
    }, 30_000)

    const cleanup = () => {
      clearInterval(heartbeat)
      unsubscribe()
    }
    request.raw.once('close', cleanup)
    reply.raw.once('close', cleanup)
  })

  server.get('/settings', async (request, reply) => {
    if (!opts.settingsStore) return unavailable(reply, 'Settings store is not configured.')
    return {
      filePath: opts.settingsStore.filePath ?? null,
      settings: opts.settingsStore.getAll?.() ?? null,
    }
  })

  server.patch<{ Body: Record<string, unknown> }>('/settings', async (request, reply) => {
    if (!opts.settingsStore) return unavailable(reply, 'Settings store is not configured.')
    if (!opts.settingsStore.update) return methodNotAllowed(reply, 'Settings store is read-only.')
    const patch = request.body
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return badRequest(reply, 'Request body must be a JSON object.')
    }
    opts.settingsStore.update(patch)
    return {
      filePath: opts.settingsStore.filePath ?? null,
      settings: opts.settingsStore.getAll?.() ?? null,
    }
  })

  server.get<{ Params: SettingsKeyParams }>('/settings/:key', async (request, reply) => {
    if (!opts.settingsStore) return unavailable(reply, 'Settings store is not configured.')
    return {
      key: request.params.key,
      value: opts.settingsStore.get(request.params.key) ?? null,
    }
  })

  server.put<{ Params: SettingsKeyParams; Body: SettingsPutBody }>('/settings/:key', async (request, reply) => {
    if (!opts.settingsStore) return unavailable(reply, 'Settings store is not configured.')
    if (!opts.settingsStore.set) return methodNotAllowed(reply, 'Settings store is read-only.')
    if (!request.body || !Object.prototype.hasOwnProperty.call(request.body, 'value')) {
      return badRequest(reply, 'Request body must contain a value field.')
    }
    opts.settingsStore.set(request.params.key, request.body.value)
    return {
      key: request.params.key,
      value: opts.settingsStore.get(request.params.key) ?? null,
    }
  })

  server.get('/compute/status', async (request, reply) => {
    if (!opts.computeService) return unavailable(reply, 'Compute service is not configured.')
    return opts.computeService.getStatus()
  })

  server.get('/compute/containers', async (request, reply) => {
    if (!opts.computeService) return unavailable(reply, 'Compute service is not configured.')
    return { containers: await opts.computeService.listContainers() }
  })

  server.post('/compute/start', async (request, reply) => {
    if (!opts.computeService) return unavailable(reply, 'Compute service is not configured.')
    try {
      await opts.computeService.ensureRunning()
      return opts.computeService.getStatus()
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.post('/compute/stop', async (request, reply) => {
    if (!opts.computeService) return unavailable(reply, 'Compute service is not configured.')
    try {
      if (opts.computeService.stopAll) await opts.computeService.stopAll()
      else await opts.computeService.stop()
      return opts.computeService.getStatus()
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.post('/compute/destroy', async (request, reply) => {
    if (!opts.computeService) return unavailable(reply, 'Compute service is not configured.')
    if (!opts.computeService.destroy) return methodNotAllowed(reply, 'Compute destroy is not configured.')
    try {
      await opts.computeService.destroy()
      return { success: true, status: opts.computeService.getStatus() }
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.post<{ Body: ComputeSetupBody }>('/compute/setup', async (request, reply) => {
    if (!opts.computeService) return unavailable(reply, 'Compute service is not configured.')
    if (!opts.computeService.setup) return methodNotAllowed(reply, 'Compute setup is not configured.')
    const step = request.body?.step
    if (!step || !['install', 'machine_init', 'machine_start', 'check'].includes(step)) {
      return badRequest(reply, 'step must be one of: install, machine_init, machine_start, check')
    }
    try {
      return await opts.computeService.setup(step, request.body?.installCommand)
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.get<{ Querystring: ComputeExecLogQuery }>('/compute/exec-log', async (request, reply) => {
    if (!opts.computeService) return unavailable(reply, 'Compute service is not configured.')
    if (!opts.computeService.getExecLog) return methodNotAllowed(reply, 'Compute exec log is not configured.')
    return { entries: opts.computeService.getExecLog(request.query.name) }
  })

  server.get<{ Params: ContainerNameParams }>('/compute/containers/:name', async (request, reply) => {
    if (!opts.computeService) return unavailable(reply, 'Compute service is not configured.')
    if (!opts.computeService.getContainerDetail) return methodNotAllowed(reply, 'Compute container detail is not configured.')
    try {
      return { success: true, ...(await opts.computeService.getContainerDetail(request.params.name)) }
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.post<{ Params: ContainerNameParams }>('/compute/containers/:name/start', async (request, reply) => {
    if (!opts.computeService) return unavailable(reply, 'Compute service is not configured.')
    if (!opts.computeService.startContainer) return methodNotAllowed(reply, 'Compute container start is not configured.')
    try {
      return { success: await opts.computeService.startContainer(request.params.name) }
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.post<{ Params: ContainerNameParams }>('/compute/containers/:name/stop', async (request, reply) => {
    if (!opts.computeService) return unavailable(reply, 'Compute service is not configured.')
    if (!opts.computeService.stopContainer) return methodNotAllowed(reply, 'Compute container stop is not configured.')
    try {
      return { success: await opts.computeService.stopContainer(request.params.name) }
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.post<{ Params: ContainerNameParams }>('/compute/containers/:name/destroy', async (request, reply) => {
    if (!opts.computeService) return unavailable(reply, 'Compute service is not configured.')
    if (!opts.computeService.destroyContainer) return methodNotAllowed(reply, 'Compute container destroy is not configured.')
    try {
      return { success: await opts.computeService.destroyContainer(request.params.name) }
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.get('/admin/mcp/packages', async (request, reply) => {
    if (!opts.mcpPackageService && !opts.mcpPythonPackageService) return unavailable(reply, 'MCP package services are not configured.')
    return {
      packages: [
        ...(opts.mcpPackageService?.listInstalled() ?? []),
        ...(opts.mcpPythonPackageService?.listInstalled() ?? []),
      ],
    }
  })

  server.post<{ Body: PackageInstallBody }>('/admin/mcp/packages/npm', async (request, reply) => {
    if (!opts.mcpPackageService) return unavailable(reply, 'MCP npm package service is not configured.')
    const packageName = request.body?.package ?? request.body?.name
    if (!packageName) return badRequest(reply, 'package is required')
    try {
      return { success: true, installed: await opts.mcpPackageService.install(packageName) }
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.delete<{ Querystring: PackageNameQuery }>('/admin/mcp/packages/npm', async (request, reply) => {
    if (!opts.mcpPackageService) return unavailable(reply, 'MCP npm package service is not configured.')
    if (!request.query.package) return badRequest(reply, 'package is required')
    try {
      await opts.mcpPackageService.uninstall(request.query.package)
      return { success: true }
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.post<{ Body: PackageInstallBody }>('/admin/mcp/packages/python', async (request, reply) => {
    if (!opts.mcpPythonPackageService) return unavailable(reply, 'MCP Python package service is not configured.')
    const packageName = request.body?.package ?? request.body?.name
    if (!packageName) return badRequest(reply, 'package is required')
    try {
      return { success: true, installed: await opts.mcpPythonPackageService.install(packageName, request.body?.version) }
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.delete<{ Querystring: PackageNameQuery }>('/admin/mcp/packages/python', async (request, reply) => {
    if (!opts.mcpPythonPackageService) return unavailable(reply, 'MCP Python package service is not configured.')
    if (!request.query.package) return badRequest(reply, 'package is required')
    try {
      await opts.mcpPythonPackageService.uninstall(request.query.package)
      return { success: true }
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.get('/admin/adapters/packages', async (request, reply) => {
    if (!opts.adapterPackageService) return unavailable(reply, 'Adapter package service is not configured.')
    return { packages: opts.adapterPackageService.listInstalled() }
  })

  server.post<{ Body: PackageInstallBody }>('/admin/adapters/packages', async (request, reply) => {
    if (!opts.adapterPackageService) return unavailable(reply, 'Adapter package service is not configured.')
    const packageName = request.body?.package ?? request.body?.name
    if (!packageName) return badRequest(reply, 'package is required')
    try {
      return { success: true, installed: await opts.adapterPackageService.install(packageName) }
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.delete<{ Querystring: PackageNameQuery }>('/admin/adapters/packages', async (request, reply) => {
    if (!opts.adapterPackageService) return unavailable(reply, 'Adapter package service is not configured.')
    if (!request.query.package) return badRequest(reply, 'package is required')
    try {
      await opts.adapterPackageService.uninstall(request.query.package)
      return { success: true }
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.get('/admin/sandbox/packages', async (request, reply) => {
    if (!opts.sandboxPackageService) return unavailable(reply, 'Sandbox package service is not configured.')
    return {
      basePath: opts.sandboxPackageService.getBasePath(),
      modules: opts.sandboxPackageService.getInstalledModules(),
      packages: opts.sandboxPackageService.getInstalledPackages(),
    }
  })

  server.post<{ Body: PackageInstallBody }>('/admin/sandbox/packages', async (request, reply) => {
    if (!opts.sandboxPackageService) return unavailable(reply, 'Sandbox package service is not configured.')
    const packageName = request.body?.package ?? request.body?.name
    if (!packageName) return badRequest(reply, 'package is required')
    try {
      return {
        success: true,
        installed: await opts.sandboxPackageService.install(packageName, request.body?.version, undefined, request.body?.agentName),
      }
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.delete<{ Querystring: { name?: string; package?: string } }>('/admin/sandbox/packages', async (request, reply) => {
    if (!opts.sandboxPackageService) return unavailable(reply, 'Sandbox package service is not configured.')
    const packageName = request.query.name ?? request.query.package
    if (!packageName) return badRequest(reply, 'name is required')
    return { success: opts.sandboxPackageService.uninstall(packageName) }
  })

  server.post<{ Body: SandboxCheckBody }>('/admin/sandbox/packages/check', async (request, reply) => {
    if (!opts.sandboxPackageService) return unavailable(reply, 'Sandbox package service is not configured.')
    const packages = request.body?.packages
    if (!Array.isArray(packages)) return badRequest(reply, 'packages array is required')
    if (!packages.every(packageEntry => isRecord(packageEntry) && typeof packageEntry.name === 'string' && typeof packageEntry.version === 'string')) {
      return badRequest(reply, 'packages entries must include name and version strings')
    }
    return { success: true, missing: opts.sandboxPackageService.checkMissing(packages) }
  })

  server.get('/diagnostics', async () => {
    const agents = runtime.listAgents()
    return {
      daemon: {
        uptime: process.uptime(),
        pid: process.pid,
      },
      agents: agents.map(agent => ({
        ...agent,
        status: runtime.getAgentStatus(agent.id),
        adapters: runtime.getAgentAdaptersDiagnostics(agent.id).states.map(state => ({
          type: state.type,
          status: state.status,
          error: state.error,
        })),
        mcp: runtime.getAgentMcpDiagnostics(agent.id).states.map(state => ({
          name: state.name,
          status: state.status,
          error: state.error,
          toolCount: state.toolCount,
        })),
        ws: {
          configured: runtime.getAgent(agent.id)?.config.ws_connections?.length ?? 0,
          active: agent.filePath && opts.wsService
            ? opts.wsService.getConnections(agent.filePath).length
            : 0,
        },
      })),
    }
  })

  server.get('/runtime', async () => {
    const agents = runtime.listAgents()
    return {
      daemon: {
        uptime: process.uptime(),
        pid: process.pid,
      },
      settings: buildRuntimeSettingsDiagnostics(opts.settingsStore),
      providers: buildProviderDiagnostics(runtime, opts.settingsStore),
      auth: await buildAuthDiagnostics(opts.settingsStore),
      mcp: buildMcpSettingsDiagnostics(opts.settingsStore),
      adapters: buildAdapterSettingsDiagnostics(opts.settingsStore),
      network: buildNetworkDiagnostics(runtime, opts),
      compute: opts.computeService?.getStatus() ?? null,
      agents: agents.map(agent => ({
        id: agent.id,
        handle: agent.handle,
        name: agent.name,
        filePath: agent.filePath,
        status: runtime.getAgentStatus(agent.id),
      })),
    }
  })

  server.get('/runtime/providers', async () => buildProviderDiagnostics(runtime, opts.settingsStore))

  server.get('/runtime/auth', async () => buildAuthDiagnostics(opts.settingsStore))

  server.get('/runtime/settings', async () => buildRuntimeSettingsDiagnostics(opts.settingsStore))

  server.get('/runtime/mcp', async () => buildMcpSettingsDiagnostics(opts.settingsStore))

  server.get('/runtime/adapters', async () => buildAdapterSettingsDiagnostics(opts.settingsStore))

  server.get('/runtime/network', async () => buildNetworkDiagnostics(runtime, opts))

  server.get('/network', async () => buildNetworkDiagnostics(runtime, opts))

  server.get('/network/mesh', async (request, reply) => {
    if (!opts.networkService) return unavailable(reply, 'Network service is not configured.')
    return opts.networkService.getStatus()
  })

  server.post('/network/mesh/enable', async (request, reply) => {
    if (!opts.networkService) return unavailable(reply, 'Network service is not configured.')
    if (!opts.networkService.enableMesh) return methodNotAllowed(reply, 'Mesh enable is not configured.')
    try {
      return await opts.networkService.enableMesh()
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.post('/network/mesh/disable', async (request, reply) => {
    if (!opts.networkService) return unavailable(reply, 'Network service is not configured.')
    if (!opts.networkService.disableMesh) return methodNotAllowed(reply, 'Mesh disable is not configured.')
    try {
      return await opts.networkService.disableMesh()
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.get<{ Querystring: NetworkRecentToolsQuery }>('/network/mesh/recent-tools', async (request, reply) => {
    if (!opts.networkService) return unavailable(reply, 'Network service is not configured.')
    if (!opts.networkService.getRecentTools) return methodNotAllowed(reply, 'Recent mesh tools are not configured.')
    const limit = parseOptionalInteger(request.query.limit)
    if (request.query.limit !== undefined && limit === undefined) return badRequest(reply, 'limit must be an integer')
    return { tools: opts.networkService.getRecentTools(limit) }
  })

  server.get('/network/mesh/lan-addresses', async (request, reply) => {
    if (!opts.networkService) return unavailable(reply, 'Network service is not configured.')
    return { addresses: opts.networkService.getLanAddresses?.() ?? getLanAddresses() }
  })

  server.get('/network/mesh/discovered-runtimes', async (request, reply) => {
    if (!opts.networkService) return unavailable(reply, 'Network service is not configured.')
    return { runtimes: await opts.networkService.getDiscoveredRuntimes?.() ?? [] }
  })

  server.get('/network/server', async (request, reply) => {
    if (!opts.networkService) return unavailable(reply, 'Network service is not configured.')
    if (!opts.networkService.getServerStatus) return methodNotAllowed(reply, 'Mesh server status is not configured.')
    return opts.networkService.getServerStatus()
  })

  server.post('/network/server/start', async (request, reply) => {
    if (!opts.networkService) return unavailable(reply, 'Network service is not configured.')
    if (!opts.networkService.startServer) return methodNotAllowed(reply, 'Mesh server start is not configured.')
    try {
      return await opts.networkService.startServer()
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.post('/network/server/stop', async (request, reply) => {
    if (!opts.networkService) return unavailable(reply, 'Network service is not configured.')
    if (!opts.networkService.stopServer) return methodNotAllowed(reply, 'Mesh server stop is not configured.')
    try {
      return await opts.networkService.stopServer()
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.post('/network/server/restart', async (request, reply) => {
    if (!opts.networkService) return unavailable(reply, 'Network service is not configured.')
    if (!opts.networkService.restartServer) return methodNotAllowed(reply, 'Mesh server restart is not configured.')
    try {
      return await opts.networkService.restartServer()
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.get('/runtime/usage', async () => buildRuntimeUsageDiagnostics())

  server.get<{ Querystring: ModelsQuery }>('/runtime/models', async (request, reply) => {
    if (!request.query.provider) return badRequest(reply, 'provider is required')
    return listProviderModels(runtime, opts.settingsStore, request.query.provider, request.query.agentId)
  })

  server.post<{ Body: TokenCountBody }>('/runtime/token-count', async (request, reply) => {
    const text = request.body?.text
    if (typeof text !== 'string') return badRequest(reply, 'text is required')
    const defaults = resolveTokenCountDefaults(runtime, request.body)
    const tokenCounter = getTokenCounterService()
    return {
      count: tokenCounter.countTokens(text, defaults.provider, defaults.model),
      provider: defaults.provider,
      model: defaults.model,
    }
  })

  server.post<{ Body: TokenCountBody }>('/runtime/token-count/batch', async (request, reply) => {
    const texts = request.body?.texts
    if (!Array.isArray(texts) || !texts.every(text => typeof text === 'string')) {
      return badRequest(reply, 'texts array is required')
    }
    const defaults = resolveTokenCountDefaults(runtime, request.body)
    const tokenCounter = getTokenCounterService()
    const counts: number[] = []
    for (let i = 0; i < texts.length; i += 10) {
      const batch = texts.slice(i, i + 10)
      for (const text of batch) counts.push(tokenCounter.countTokens(text, defaults.provider, defaults.model))
      if (i + 10 < texts.length) await new Promise<void>(resolve => setImmediate(resolve))
    }
    return {
      counts,
      provider: defaults.provider,
      model: defaults.model,
    }
  })

  server.get('/auth/chatgpt/status', async () => getChatGptAuthManager().getAuthStatus())

  server.post('/auth/chatgpt/start', async () => {
    const flow = await getChatGptAuthManager().startAuthFlowDetached()
    flow.completion
      .then(() => console.log('[ADF Daemon] ChatGPT auth completed.'))
      .catch(err => console.error('[ADF Daemon] ChatGPT auth failed:', err))
    return {
      started: true,
      authUrl: flow.authUrl,
      callbackPort: flow.callbackPort,
    }
  })

  server.post('/auth/chatgpt/logout', async () => {
    getChatGptAuthManager().logout()
    return { success: true }
  })

  server.get('/agents', async () => runtime.listAgents())

  server.get<{ Params: AgentIdParams }>('/agents/:id', async (request, reply) => {
    const agent = runtime.getAgent(request.params.id)
    if (!agent) return notFound(reply, `Unknown agent "${request.params.id}"`)
    return agent
  })

  server.get<{ Params: AgentIdParams }>('/agents/:id/status', async (request, reply) => {
    const status = runtime.getAgentStatus(request.params.id)
    if (!status) return notFound(reply, `Unknown agent "${request.params.id}"`)
    return status
  })

  server.get<{ Params: AgentIdParams; Querystring: LoopQuery }>('/agents/:id/loop', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    const limit = parseOptionalInteger(request.query.limit)
    const offset = parseOptionalInteger(request.query.offset)
    if (request.query.limit !== undefined && limit === undefined) return badRequest(reply, 'limit must be an integer')
    if (request.query.offset !== undefined && offset === undefined) return badRequest(reply, 'offset must be an integer')
    return runtime.getAgentLoop(request.params.id, { limit, offset })
  })

  server.get<{ Params: AgentIdParams; Querystring: LogsQuery }>('/agents/:id/logs', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    const limit = parseOptionalInteger(request.query.limit)
    if (request.query.limit !== undefined && limit === undefined) return badRequest(reply, 'limit must be an integer')
    return {
      agentId: request.params.id,
      logs: runtime.getAgentLogs(request.params.id, {
        limit,
        origin: request.query.origin,
        event: request.query.event,
      }),
    }
  })

  server.get<{ Params: AgentIdParams; Querystring: { afterId?: string } }>('/agents/:id/logs/after', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    const afterId = parseOptionalInteger(request.query.afterId)
    if (afterId === undefined) return badRequest(reply, 'afterId must be an integer')
    return runtime.getAgentLogsAfterId(request.params.id, afterId)
  })

  server.delete<{ Params: AgentIdParams }>('/agents/:id/logs', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    try {
      return runtime.clearAgentLogs(request.params.id)
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.get<{ Params: AgentIdParams }>('/agents/:id/tables', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    return runtime.listAgentLocalTables(request.params.id)
  })

  server.get<{ Params: TableParams; Querystring: TableQuery }>('/agents/:id/tables/:table', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    const limit = parseOptionalInteger(request.query.limit)
    const offset = parseOptionalInteger(request.query.offset)
    if (request.query.limit !== undefined && limit === undefined) return badRequest(reply, 'limit must be an integer')
    if (request.query.offset !== undefined && offset === undefined) return badRequest(reply, 'offset must be an integer')
    try {
      return runtime.queryAgentLocalTable(request.params.id, request.params.table, { limit, offset })
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.delete<{ Params: TableParams }>('/agents/:id/tables/:table', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    try {
      return runtime.dropAgentLocalTable(request.params.id, request.params.table)
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.get<{ Params: AgentIdParams }>('/agents/:id/config', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    return runtime.getAgentConfig(request.params.id)
  })

  server.put<{ Params: AgentIdParams; Body: AgentConfig }>('/agents/:id/config', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    if (!isRecord(request.body)) return badRequest(reply, 'Request body must be an agent config object.')
    try {
      return await runtime.setAgentConfig(request.params.id, request.body as AgentConfig)
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.get<{ Params: AgentIdParams }>('/agents/:id/document', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    return runtime.getAgentDocument(request.params.id)
  })

  server.put<{ Params: AgentIdParams; Body: ContentBody }>('/agents/:id/document', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    if (typeof request.body?.content !== 'string') return badRequest(reply, 'content is required')
    try {
      return runtime.setAgentDocument(request.params.id, request.body.content)
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.get<{ Params: AgentIdParams }>('/agents/:id/mind', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    return runtime.getAgentMind(request.params.id)
  })

  server.put<{ Params: AgentIdParams; Body: ContentBody }>('/agents/:id/mind', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    if (typeof request.body?.content !== 'string') return badRequest(reply, 'content is required')
    try {
      return runtime.setAgentMind(request.params.id, request.body.content)
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.get<{ Params: AgentIdParams; Querystring: LoopQuery }>('/agents/:id/chat', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    const limit = parseOptionalInteger(request.query.limit)
    if (request.query.limit !== undefined && limit === undefined) return badRequest(reply, 'limit must be an integer')
    return runtime.getAgentChat(request.params.id, limit)
  })

  server.delete<{ Params: AgentIdParams }>('/agents/:id/chat', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    try {
      return runtime.clearAgentChat(request.params.id)
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.get<{ Params: AgentIdParams }>('/agents/:id/files', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    return runtime.getAgentFiles(request.params.id)
  })

  server.get<{ Params: AgentIdParams; Querystring: FileContentQuery }>('/agents/:id/files/content', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    const path = request.query.path
    if (!path) return badRequest(reply, 'path is required')
    const file = runtime.getAgentFile(request.params.id, path)
    if (!file) return notFound(reply, `Unknown file "${path}"`)
    return file
  })

  server.put<{ Params: AgentIdParams; Querystring: FileContentQuery; Body: FileWriteBody }>('/agents/:id/files/content', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    const path = request.query.path
    if (!path) return badRequest(reply, 'path is required')
    const contentBase64 = request.body?.content_base64 ?? request.body?.contentBase64
    if (typeof request.body?.content !== 'string' && typeof contentBase64 !== 'string') {
      return badRequest(reply, 'content or content_base64 is required')
    }
    try {
      return runtime.writeAgentFile(request.params.id, path, {
        content: request.body.content,
        contentBase64,
        mimeType: request.body.mimeType ?? request.body.mime_type,
        protection: request.body.protection,
      })
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.delete<{ Params: AgentIdParams; Querystring: FileContentQuery }>('/agents/:id/files/content', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    const path = request.query.path
    if (!path) return badRequest(reply, 'path is required')
    try {
      return runtime.deleteAgentFile(request.params.id, path)
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.post<{ Params: AgentIdParams; Body: FileRenameBody }>('/agents/:id/files/rename', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    if (!request.body?.oldPath || !request.body?.newPath) return badRequest(reply, 'oldPath and newPath are required')
    try {
      return runtime.renameAgentFile(request.params.id, request.body.oldPath, request.body.newPath)
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.post<{ Params: AgentIdParams; Body: FolderRenameBody }>('/agents/:id/files/rename-folder', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    if (!request.body?.oldPrefix || !request.body?.newPrefix) return badRequest(reply, 'oldPrefix and newPrefix are required')
    try {
      return runtime.renameAgentFolder(request.params.id, request.body.oldPrefix, request.body.newPrefix)
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.patch<{ Params: AgentIdParams; Body: FileProtectionBody }>('/agents/:id/files/protection', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    if (!request.body?.path || !isFileProtection(request.body.protection)) return badRequest(reply, 'path and valid protection are required')
    try {
      return runtime.setAgentFileProtection(request.params.id, request.body.path, request.body.protection)
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.patch<{ Params: AgentIdParams; Body: FileAuthorizedBody }>('/agents/:id/files/authorized', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    if (!request.body?.path || typeof request.body.authorized !== 'boolean') return badRequest(reply, 'path and authorized are required')
    try {
      return runtime.setAgentFileAuthorized(request.params.id, request.body.path, request.body.authorized)
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.get<{ Params: AgentIdParams; Querystring: ResourceStatusQuery }>('/agents/:id/inbox', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    const status = request.query.status
    if (status !== undefined && !isInboxStatus(status)) {
      return badRequest(reply, 'status must be one of: unread, read, archived')
    }
    return runtime.getAgentInbox(request.params.id, status)
  })

  server.delete<{ Params: AgentIdParams }>('/agents/:id/inbox', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    try {
      return runtime.clearAgentInbox(request.params.id)
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.get<{ Params: AgentIdParams; Querystring: ResourceStatusQuery }>('/agents/:id/outbox', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    const status = request.query.status
    if (status !== undefined && !isOutboxStatus(status)) {
      return badRequest(reply, 'status must be one of: pending, sent, delivered, failed')
    }
    return runtime.getAgentOutbox(request.params.id, status)
  })

  server.get<{ Params: AgentIdParams }>('/agents/:id/timers', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    return runtime.getAgentTimers(request.params.id)
  })

  server.post<{ Params: AgentIdParams; Body: TimerMutationBody }>('/agents/:id/timers', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    if (!request.body?.mode) return badRequest(reply, 'mode is required')
    try {
      return await runtime.addAgentTimer(request.params.id, request.body as TimerMutationBody & { mode: NonNullable<TimerMutationBody['mode']> })
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.put<{ Params: TimerIdParams; Body: TimerMutationBody }>('/agents/:id/timers/:timerId', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    const id = parseOptionalInteger(request.params.timerId)
    if (id === undefined) return badRequest(reply, 'timerId must be an integer')
    if (!request.body?.mode) return badRequest(reply, 'mode is required')
    try {
      return await runtime.updateAgentTimer(request.params.id, { ...request.body, id } as TimerMutationBody & { id: number; mode: NonNullable<TimerMutationBody['mode']> })
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.delete<{ Params: TimerIdParams }>('/agents/:id/timers/:timerId', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    const id = parseOptionalInteger(request.params.timerId)
    if (id === undefined) return badRequest(reply, 'timerId must be an integer')
    try {
      return runtime.deleteAgentTimer(request.params.id, id)
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.get<{ Params: AgentIdParams }>('/agents/:id/meta', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    return runtime.getAgentMeta(request.params.id)
  })

  server.put<{ Params: MetaKeyParams; Body: MetaSetBody }>('/agents/:id/meta/:key', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    if (typeof request.body?.value !== 'string') return badRequest(reply, 'value is required')
    if (request.body.protection !== undefined && !isMetaProtection(request.body.protection)) return badRequest(reply, 'Invalid protection')
    try {
      return runtime.setAgentMeta(request.params.id, request.params.key, request.body.value, request.body.protection)
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.delete<{ Params: MetaKeyParams }>('/agents/:id/meta/:key', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    try {
      return runtime.deleteAgentMeta(request.params.id, request.params.key)
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.patch<{ Params: MetaKeyParams; Body: MetaProtectionBody }>('/agents/:id/meta/:key/protection', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    if (!isMetaProtection(request.body?.protection)) return badRequest(reply, 'Valid protection is required')
    try {
      return runtime.setAgentMetaProtection(request.params.id, request.params.key, request.body.protection)
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.get<{ Params: AgentIdParams }>('/agents/:id/usage', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    return runtime.getAgentUsage(request.params.id)
  })

  server.get<{ Params: AgentIdParams; Querystring: TasksQuery }>('/agents/:id/tasks', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    const status = request.query.status
    if (status !== undefined && !isTaskStatus(status)) {
      return badRequest(reply, 'status must be one of: pending, pending_approval, running, completed, failed, denied, cancelled')
    }
    const limit = parseOptionalInteger(request.query.limit)
    if (request.query.limit !== undefined && limit === undefined) return badRequest(reply, 'limit must be an integer')
    return runtime.getAgentTasks(request.params.id, { status, limit })
  })

  server.get<{ Params: TaskIdParams }>('/agents/:id/tasks/:taskId', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    const task = runtime.getAgentTask(request.params.id, request.params.taskId)
    if (!task) return notFound(reply, `Unknown task "${request.params.taskId}"`)
    return task
  })

  server.post<{ Params: TaskIdParams; Body: TaskResolveBody }>('/agents/:id/tasks/:taskId/resolve', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    const action = request.body?.action
    if (!action || !isTaskResolveAction(action)) {
      return badRequest(reply, 'action must be one of: approve, deny, pending_approval')
    }
    try {
      return await runtime.resolveAgentTask(request.params.id, request.params.taskId, {
        action,
        reason: request.body?.reason,
        modifiedArgs: request.body?.modifiedArgs ?? request.body?.modified_args,
      })
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.get<{ Params: AgentIdParams }>('/agents/:id/asks', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    return runtime.getAgentAsks(request.params.id)
  })

  server.post<{ Params: AskIdParams; Body: AskRespondBody }>('/agents/:id/asks/:requestId/respond', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    const answer = request.body?.answer
    if (typeof answer !== 'string') return badRequest(reply, 'answer is required')
    try {
      return runtime.answerAgentAsk(request.params.id, request.params.requestId, answer)
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.post<{ Params: AgentIdParams; Body: SuspendRespondBody }>('/agents/:id/suspend/respond', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    if (typeof request.body?.resume !== 'boolean') return badRequest(reply, 'resume boolean is required')
    try {
      return runtime.resolveAgentSuspend(request.params.id, request.body.resume)
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.get<{ Params: AgentIdParams }>('/agents/:id/identities', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    return runtime.getAgentIdentities(request.params.id)
  })

  server.get<{ Params: AgentIdParams; Querystring: IdentityListQuery }>('/agents/:id/identity', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    return runtime.getAgentIdentityPurposes(request.params.id, request.query.prefix)
  })

  server.get<{ Params: AgentIdParams }>('/agents/:id/identity/entries', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    return runtime.getAgentIdentities(request.params.id)
  })

  server.get<{ Params: AgentIdParams }>('/agents/:id/identity/password', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    return runtime.getAgentIdentityPassword(request.params.id)
  })

  server.post<{ Params: AgentIdParams; Body: IdentityPasswordBody }>('/agents/:id/identity/password/unlock', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    if (typeof request.body?.password !== 'string') return badRequest(reply, 'password is required')
    try {
      return runtime.unlockAgentIdentityPassword(request.params.id, request.body.password)
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.put<{ Params: AgentIdParams; Body: IdentityPasswordBody }>('/agents/:id/identity/password', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    if (typeof request.body?.password !== 'string') return badRequest(reply, 'password is required')
    try {
      return runtime.setAgentIdentityPassword(request.params.id, request.body.password)
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.delete<{ Params: AgentIdParams }>('/agents/:id/identity/password', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    try {
      return runtime.removeAgentIdentityPassword(request.params.id)
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.post<{ Params: AgentIdParams; Body: IdentityChangePasswordBody }>('/agents/:id/identity/password/change', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    const newPassword = request.body?.newPassword ?? request.body?.new_password
    if (typeof newPassword !== 'string') return badRequest(reply, 'newPassword is required')
    try {
      return runtime.changeAgentIdentityPassword(request.params.id, newPassword)
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.post<{ Params: AgentIdParams }>('/agents/:id/identity/wipe', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    return runtime.wipeAgentIdentity(request.params.id)
  })

  server.get<{ Params: AgentIdParams }>('/agents/:id/identity/did', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    return runtime.getAgentDid(request.params.id)
  })

  server.post<{ Params: AgentIdParams }>('/agents/:id/identity/generate-keys', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    try {
      return runtime.generateAgentIdentityKeys(request.params.id)
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.delete<{ Params: AgentIdParams; Querystring: IdentityListQuery }>('/agents/:id/identity-prefix', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    if (!request.query.prefix) return badRequest(reply, 'prefix is required')
    return runtime.deleteAgentIdentityByPrefix(request.params.id, request.query.prefix)
  })

  server.get<{ Params: IdentityPurposeParams }>('/agents/:id/identity/:purpose', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    return runtime.getAgentIdentity(request.params.id, request.params.purpose)
  })

  server.put<{ Params: IdentityPurposeParams; Body: IdentityValueBody }>('/agents/:id/identity/:purpose', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    if (typeof request.body?.value !== 'string') return badRequest(reply, 'value is required')
    try {
      return runtime.setAgentIdentity(request.params.id, request.params.purpose, request.body.value)
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.delete<{ Params: IdentityPurposeParams }>('/agents/:id/identity/:purpose', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    return runtime.deleteAgentIdentity(request.params.id, request.params.purpose)
  })

  server.patch<{ Params: IdentityPurposeParams; Body: IdentityCodeAccessBody }>('/agents/:id/identity/:purpose/code-access', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    const codeAccess = request.body?.codeAccess ?? request.body?.code_access
    if (typeof codeAccess !== 'boolean') return badRequest(reply, 'codeAccess boolean is required')
    return runtime.setAgentIdentityCodeAccess(request.params.id, request.params.purpose, codeAccess)
  })

  server.put<{ Params: ProviderParams; Body: IdentityValueBody }>('/agents/:id/providers/:providerId/credential', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    if (typeof request.body?.value !== 'string') return badRequest(reply, 'value is required')
    try {
      return runtime.setAgentProviderCredential(request.params.id, request.params.providerId, request.body.value)
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.get<{ Params: ProviderParams }>('/agents/:id/providers/:providerId/credentials', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    return runtime.getAgentProviderCredentials(request.params.id, request.params.providerId)
  })

  server.post<{ Params: AgentIdParams; Body: ProviderAttachBody }>('/agents/:id/providers', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    if (!isRecord(request.body?.provider) || typeof request.body.provider.id !== 'string') {
      return badRequest(reply, 'provider with id is required')
    }
    try {
      return await runtime.attachAgentProvider(request.params.id, request.body.provider as unknown as AdfProviderConfig)
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.delete<{ Params: ProviderParams }>('/agents/:id/providers/:providerId', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    try {
      return await runtime.detachAgentProvider(request.params.id, request.params.providerId)
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.put<{ Params: AgentIdParams; Body: McpCredentialBody }>('/agents/:id/mcp/credentials', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    const { npmPackage, envKey, value } = request.body ?? {}
    if (typeof npmPackage !== 'string') return badRequest(reply, 'npmPackage is required')
    if (typeof envKey !== 'string') return badRequest(reply, 'envKey is required')
    if (typeof value !== 'string') return badRequest(reply, 'value is required')
    try {
      return runtime.setAgentMcpCredential(request.params.id, npmPackage, envKey, value)
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.get<{ Params: AgentIdParams; Querystring: McpCredentialQuery }>('/agents/:id/mcp/credentials', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    if (!request.query.npmPackage) return badRequest(reply, 'npmPackage is required')
    return runtime.getAgentMcpCredentials(request.params.id, request.query.npmPackage)
  })

  server.post<{ Params: AgentIdParams; Body: McpAttachBody }>('/agents/:id/mcp/servers', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    const serverConfig = request.body?.server ?? request.body?.serverConfig
    if (!isRecord(serverConfig) || typeof serverConfig.name !== 'string' || (serverConfig.transport !== 'stdio' && serverConfig.transport !== 'http')) {
      return badRequest(reply, 'server with name and transport is required')
    }
    try {
      return await runtime.attachAgentMcpServer(request.params.id, serverConfig as unknown as McpServerConfig)
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.delete<{ Params: McpServerParams; Querystring: McpDetachQuery }>('/agents/:id/mcp/servers/:serverName', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    try {
      return await runtime.detachAgentMcpServer(request.params.id, request.params.serverName, request.query.credentialNamespace)
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.put<{ Params: AgentIdParams; Body: AdapterCredentialBody }>('/agents/:id/adapters/credentials', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    const { adapterType, envKey, value } = request.body ?? {}
    if (typeof adapterType !== 'string') return badRequest(reply, 'adapterType is required')
    if (typeof envKey !== 'string') return badRequest(reply, 'envKey is required')
    if (typeof value !== 'string') return badRequest(reply, 'value is required')
    try {
      return runtime.setAgentAdapterCredential(request.params.id, adapterType, envKey, value)
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.get<{ Params: AgentIdParams; Querystring: { adapterType?: string } }>('/agents/:id/adapters/credentials', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    if (!request.query.adapterType) return badRequest(reply, 'adapterType is required')
    return runtime.getAgentAdapterCredentials(request.params.id, request.query.adapterType)
  })

  server.post<{ Params: AgentIdParams; Body: AdapterAttachBody }>('/agents/:id/adapters', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    if (typeof request.body?.adapterType !== 'string') return badRequest(reply, 'adapterType is required')
    if (!isRecord(request.body.config)) return badRequest(reply, 'config is required')
    try {
      return await runtime.attachAgentAdapter(request.params.id, request.body.adapterType, request.body.config as unknown as AdapterInstanceConfig)
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.delete<{ Params: AdapterParams }>('/agents/:id/adapters/:adapterType', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    try {
      return await runtime.detachAgentAdapter(request.params.id, request.params.adapterType)
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.get<{ Params: AgentIdParams }>('/agents/:id/runtime', async (request, reply) => {
    const agent = runtime.getAgent(request.params.id)
    if (!agent) return notFound(reply, `Unknown agent "${request.params.id}"`)
    return {
      agentId: agent.id,
      status: runtime.getAgentStatus(request.params.id),
      adapters: runtime.getAgentAdaptersDiagnostics(request.params.id),
      mcp: runtime.getAgentMcpDiagnostics(request.params.id),
      triggers: runtime.getAgentTriggersDiagnostics(request.params.id),
      ws: {
        configured: agent.config.ws_connections ?? [],
        active: agent.filePath && opts.wsService
          ? opts.wsService.getConnections(agent.filePath)
          : [],
      },
    }
  })

  server.get<{ Params: AgentIdParams }>('/agents/:id/runtime/adapters', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    return runtime.getAgentAdaptersDiagnostics(request.params.id)
  })

  server.get<{ Params: AgentIdParams }>('/agents/:id/runtime/mcp', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    return runtime.getAgentMcpDiagnostics(request.params.id)
  })

  server.get<{ Params: AgentIdParams }>('/agents/:id/runtime/triggers', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    return runtime.getAgentTriggersDiagnostics(request.params.id)
  })

  server.get<{ Params: AgentIdParams }>('/agents/:id/runtime/ws', async (request, reply) => {
    const agent = runtime.getAgent(request.params.id)
    if (!agent) return notFound(reply, `Unknown agent "${request.params.id}"`)
    const active = agent.filePath && opts.wsService
      ? opts.wsService.getConnections(agent.filePath)
      : []
    return {
      agentId: agent.id,
      configured: agent.config.ws_connections ?? [],
      active,
      recentLogs: runtime.getAgentLogs(request.params.id, { origin: 'websocket', limit: 50 }),
    }
  })

  server.get<{ Params: AgentIdParams }>('/agents/:id/adapters', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    return runtime.getAgentAdaptersDiagnostics(request.params.id)
  })

  server.get<{ Params: AgentIdParams }>('/agents/:id/mcp', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    return runtime.getAgentMcpDiagnostics(request.params.id)
  })

  server.get<{ Params: AgentIdParams }>('/agents/:id/triggers', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    return runtime.getAgentTriggersDiagnostics(request.params.id)
  })

  server.get<{ Params: AgentIdParams }>('/agents/:id/ws', async (request, reply) => {
    const agent = runtime.getAgent(request.params.id)
    if (!agent) return notFound(reply, `Unknown agent "${request.params.id}"`)
    const active = agent.filePath && opts.wsService
      ? opts.wsService.getConnections(agent.filePath)
      : []
    return {
      agentId: request.params.id,
      configured: agent.config.ws_connections ?? [],
      active,
      recentLogs: runtime.getAgentLogs(request.params.id, { origin: 'websocket', limit: 50 }),
    }
  })

  server.post<{ Body: LoadAgentBody }>('/agents/load', async (request, reply) => {
    const filePath = request.body?.filePath
    if (!filePath) return badRequest(reply, 'filePath is required')
    try {
      return await runtime.loadAgent(filePath, { enforceReviewGate: request.body?.requireReview === true })
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.get<{ Querystring: ReviewQuery }>('/agents/review', async (request, reply) => {
    const filePath = request.query.filePath
    if (!filePath) return badRequest(reply, 'filePath is required')
    try {
      return runtime.getReviewInfo(filePath)
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.post<{ Body: ReviewAcceptBody }>('/agents/review/accept', async (request, reply) => {
    const filePath = request.body?.filePath
    if (!filePath) return badRequest(reply, 'filePath is required')
    try {
      return runtime.acceptReview(filePath)
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.post<{ Body: AutostartBody }>('/agents/autostart', async (request, reply) => {
    const trackedDirs = request.body?.trackedDirs
    if (!Array.isArray(trackedDirs)) return badRequest(reply, 'trackedDirs must be an array')
    try {
      return await runtime.autostartFromDirectories(trackedDirs, { maxDepth: request.body?.maxDepth })
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.post<{ Params: AgentIdParams }>('/agents/:id/start', async (request, reply) => {
    try {
      const result = await runtime.startOrLoadAgent(request.params.id)
      return {
        success: true,
        loaded: result.loaded,
        startupTriggered: result.startupTriggered,
        agent: runtime.getAgentStatus(result.ref.id),
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('unknown agent')) {
        return notFound(reply, `Unknown agent "${request.params.id}"`)
      }
      return handleRuntimeError(reply, err)
    }
  })

  server.post<{ Params: AgentIdParams }>('/agents/:id/stop', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    try {
      await runtime.stopAgent(request.params.id)
      return { success: true }
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.post<{ Params: AgentIdParams }>('/agents/:id/unload', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    try {
      await runtime.stopAgent(request.params.id)
      return { success: true }
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.post<{ Params: AgentIdParams }>('/agents/:id/abort', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    try {
      await runtime.abortAgent(request.params.id)
      return { success: true }
    } catch (err) {
      return handleRuntimeError(reply, err)
    }
  })

  server.post<{ Params: AgentIdParams; Body: ChatBody }>('/agents/:id/chat', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    const text = request.body?.text
    if (!text) return badRequest(reply, 'text is required')

    const turnId = `turn_${nanoid(12)}`
    queueTurn(turnId, () => runtime.sendChat(request.params.id, text))
    return reply.code(202).send({ accepted: true, turnId })
  })

  server.post<{ Params: AgentIdParams; Body: TriggerBody }>('/agents/:id/trigger', async (request, reply) => {
    if (!runtime.getAgent(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    const normalized = normalizeTriggerDispatch(request.body)
    if (!normalized.ok) return badRequest(reply, normalized.error)

    const turnId = `trigger_${nanoid(12)}`
    queueTurn(turnId, () => runtime.trigger(request.params.id, normalized.dispatch))
    return reply.code(202).send({ accepted: true, turnId })
  })

  return server
}

function queueTurn(turnId: string, run: () => Promise<void>): void {
  process.nextTick(() => {
    run().catch(err => {
      console.error(`[DaemonHttpApi] Turn ${turnId} failed:`, err)
    })
  })
}

function normalizeTriggerDispatch(body: unknown): {
  ok: true
  dispatch: AdfEventDispatch | AdfBatchDispatch
} | {
  ok: false
  error: string
} {
  if (!isRecord(body)) return { ok: false, error: 'Request body must be a JSON object.' }
  const candidate = isRecord(body.dispatch) ? body.dispatch : body
  if (Array.isArray(candidate.events)) return normalizeBatchDispatch(candidate)
  return normalizeSingleDispatch(candidate)
}

function normalizeSingleDispatch(input: Record<string, unknown>): {
  ok: true
  dispatch: AdfEventDispatch
} | {
  ok: false
  error: string
} {
  const rawEvent = isRecord(input.event) ? input.event : input
  const event = normalizeEvent(rawEvent)
  if (!event.ok) return event

  const target = isRecord(input.target) ? input.target : input
  const scope = target.scope ?? 'agent'
  if (!isTriggerScope(scope)) return { ok: false, error: 'scope must be one of: agent, system' }

  return {
    ok: true,
    dispatch: {
      event: event.event,
      scope,
      ...(typeof target.lambda === 'string' ? { lambda: target.lambda } : {}),
      ...(typeof target.command === 'string' ? { command: target.command } : {}),
      ...(typeof target.warm === 'boolean' ? { warm: target.warm } : {}),
    },
  }
}

function normalizeBatchDispatch(input: Record<string, unknown>): {
  ok: true
  dispatch: AdfBatchDispatch
} | {
  ok: false
  error: string
} {
  if (!Array.isArray(input.events) || input.events.length === 0) {
    return { ok: false, error: 'events must be a non-empty array.' }
  }

  const events: AdfEvent[] = []
  for (const rawEvent of input.events) {
    if (!isRecord(rawEvent)) return { ok: false, error: 'Each batch event must be a JSON object.' }
    const event = normalizeEvent(rawEvent)
    if (!event.ok) return event
    events.push(event.event)
  }

  const target = isRecord(input.target) ? input.target : input
  const scope = target.scope ?? 'agent'
  if (!isTriggerScope(scope)) return { ok: false, error: 'scope must be one of: agent, system' }

  return {
    ok: true,
    dispatch: {
      events,
      count: typeof input.count === 'number' ? input.count : events.length,
      scope,
      ...(typeof target.lambda === 'string' ? { lambda: target.lambda } : {}),
      ...(typeof target.command === 'string' ? { command: target.command } : {}),
      ...(typeof target.warm === 'boolean' ? { warm: target.warm } : {}),
    },
  }
}

function normalizeEvent(rawEvent: Record<string, unknown>): {
  ok: true
  event: AdfEvent
} | {
  ok: false
  error: string
} {
  const type = rawEvent.type
  if (!isAdfEventType(type)) {
    return { ok: false, error: `event.type must be one of: ${ADF_EVENT_TYPES.join(', ')}` }
  }
  if (type !== 'startup' && !Object.prototype.hasOwnProperty.call(rawEvent, 'data')) {
    return { ok: false, error: 'event.data is required. Use null for events with no payload.' }
  }

  return {
    ok: true,
    event: {
      id: typeof rawEvent.id === 'string' ? rawEvent.id : `event_${nanoid(12)}`,
      type,
      source: typeof rawEvent.source === 'string' ? rawEvent.source : 'daemon:http',
      time: typeof rawEvent.time === 'string' ? rawEvent.time : new Date().toISOString(),
      data: (Object.prototype.hasOwnProperty.call(rawEvent, 'data') ? rawEvent.data : undefined) as AdfEvent['data'],
      ...(typeof rawEvent.correlationId === 'string' ? { correlationId: rawEvent.correlationId } : {}),
    },
  }
}

function badRequest(reply: FastifyReply, error: string) {
  return reply.code(400).send({ error })
}

function notFound(reply: FastifyReply, error: string) {
  return reply.code(404).send({ error })
}

function unavailable(reply: FastifyReply, error: string) {
  return reply.code(503).send({ error })
}

function methodNotAllowed(reply: FastifyReply, error: string) {
  return reply.code(405).send({ error })
}

function buildRuntimeUsageDiagnostics() {
  const usage = getTokenUsageService().getUsageData()
  const totals = createUsageTotals()
  const byProvider = new Map<string, ReturnType<typeof createProviderUsageBucket>>()
  const byModel = new Map<string, ReturnType<typeof createModelUsageBucket>>()

  for (const [date, providers] of Object.entries(usage)) {
    for (const [provider, models] of Object.entries(providers)) {
      let providerBucket = byProvider.get(provider)
      if (!providerBucket) {
        providerBucket = createProviderUsageBucket(provider)
        byProvider.set(provider, providerBucket)
      }

      for (const [model, modelUsage] of Object.entries(models)) {
        addUsage(totals, modelUsage.input, modelUsage.output)
        addUsage(providerBucket, modelUsage.input, modelUsage.output)

        const modelKey = `${provider}\u0000${model}`
        let modelBucket = byModel.get(modelKey)
        if (!modelBucket) {
          modelBucket = createModelUsageBucket(provider, model)
          byModel.set(modelKey, modelBucket)
        }
        modelBucket.days.add(date)
        addUsage(modelBucket, modelUsage.input, modelUsage.output)
      }
    }
  }

  return {
    source: 'token-usage-service',
    note: 'Aggregated provider/model totals recorded by the runtime. These totals are not attributed per agent.',
    totals,
    byProvider: Array.from(byProvider.values()).sort((a, b) => b.total - a.total),
    byModel: Array.from(byModel.values())
      .map(bucket => ({ ...bucket, days: bucket.days.size }))
      .sort((a, b) => b.total - a.total),
    usage,
  }
}

function resolveTokenCountDefaults(runtime: RuntimeService, body?: TokenCountBody): { provider: string; model: string } {
  if (body?.provider || body?.model) {
    return { provider: body.provider ?? 'anthropic', model: body.model ?? '' }
  }
  if (body?.agentId) {
    const agent = runtime.getAgent(body.agentId)
    if (agent) {
      return {
        provider: agent.config.model.provider || 'anthropic',
        model: agent.config.model.model_id || '',
      }
    }
  }
  return { provider: 'anthropic', model: '' }
}

async function listProviderModels(
  runtime: RuntimeService,
  settingsStore: DaemonSettingsStore | undefined,
  providerId: string,
  agentId?: string,
): Promise<{ provider: string; models: string[]; error?: string }> {
  const cfg = resolveModelListProviderConfig(runtime, settingsStore, providerId, agentId)
  if (!cfg) return { provider: providerId, models: [], error: `Provider "${providerId}" not found.` }

  if (cfg.type === 'chatgpt-subscription') {
    const { CHATGPT_SUBSCRIPTION_MODELS } = await import('../providers/chatgpt-subscription')
    return { provider: providerId, models: [...CHATGPT_SUBSCRIPTION_MODELS] }
  }

  if (cfg.type === 'anthropic') {
    if (!cfg.apiKey) return { provider: providerId, models: [], error: 'Anthropic API key not configured.' }
    try {
      const response = await fetch('https://api.anthropic.com/v1/models', {
        headers: {
          'x-api-key': cfg.apiKey,
          'anthropic-version': '2023-06-01',
        },
        signal: AbortSignal.timeout(5000),
      })
      if (!response.ok) return { provider: providerId, models: [], error: `Anthropic API returned ${response.status}` }
      const json = await response.json() as { data?: { id: string; type?: string }[] }
      return {
        provider: providerId,
        models: (json.data ?? []).filter(model => !model.type || model.type === 'model').map(model => model.id),
      }
    } catch (err) {
      return { provider: providerId, models: [], error: err instanceof Error ? err.message : String(err) }
    }
  }

  try {
    const baseUrl = cfg.type === 'openai' ? 'https://api.openai.com/v1' : cfg.baseUrl
    if (!baseUrl) return { provider: providerId, models: [], error: 'Provider baseUrl is not configured.' }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
      headers,
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) return { provider: providerId, models: [], error: `Server returned ${response.status}` }
    const json = await response.json() as { data?: { id: string }[] }
    return { provider: providerId, models: (json.data ?? []).map(model => model.id) }
  } catch (err) {
    return { provider: providerId, models: [], error: err instanceof Error ? err.message : String(err) }
  }
}

function resolveModelListProviderConfig(
  runtime: RuntimeService,
  settingsStore: DaemonSettingsStore | undefined,
  providerId: string,
  agentId?: string,
): { type: string; baseUrl: string; apiKey?: string } | null {
  const appProvider = getProviderRegistrations(settingsStore).find(provider => provider.id === providerId)
  if (appProvider) return appProvider

  if (!agentId) return null
  try {
    const agentProvider = runtime.getAgent(agentId)?.config.providers?.find(provider => provider.id === providerId)
    if (!agentProvider) return null
    const credentials = runtime.getAgentProviderCredentials(agentId, providerId).credentials
    return {
      ...agentProvider,
      apiKey: credentials.apiKey ?? '',
    }
  } catch {
    return null
  }
}

function createUsageTotals() {
  return { input: 0, output: 0, total: 0 }
}

function createProviderUsageBucket(provider: string) {
  return { provider, ...createUsageTotals() }
}

function createModelUsageBucket(provider: string, model: string) {
  return { provider, model, days: new Set<string>(), ...createUsageTotals() }
}

function addUsage(target: ReturnType<typeof createUsageTotals>, input: number, output: number): void {
  target.input += input
  target.output += output
  target.total = target.input + target.output
}

function buildRuntimeSettingsDiagnostics(settingsStore?: DaemonSettingsStore) {
  if (!settingsStore) {
    return {
      configured: false,
      filePath: null,
      trackedDirectories: [],
      maxDirectoryScanDepth: null,
      autoCompactThreshold: null,
      promptOverrides: {
        globalSystemPrompt: false,
        compactionPrompt: false,
        toolPrompts: 0,
      },
      packageCounts: {
        sandboxPackages: 0,
        mcpServers: 0,
        adapters: 0,
        providers: 0,
      },
    }
  }

  const all = settingsStore.getAll?.() ?? {}
  const toolPrompts = all.toolPrompts && typeof all.toolPrompts === 'object' && !Array.isArray(all.toolPrompts)
    ? Object.keys(all.toolPrompts).length
    : 0
  return {
    configured: true,
    filePath: settingsStore.filePath ?? null,
    trackedDirectories: asStringArray(all.trackedDirectories),
    maxDirectoryScanDepth: typeof all.maxDirectoryScanDepth === 'number' ? all.maxDirectoryScanDepth : null,
    autoCompactThreshold: typeof all.autoCompactThreshold === 'number' ? all.autoCompactThreshold : null,
    promptOverrides: {
      globalSystemPrompt: typeof all.globalSystemPrompt === 'string' && all.globalSystemPrompt.length > 0,
      compactionPrompt: typeof all.compactionPrompt === 'string' && all.compactionPrompt.length > 0,
      toolPrompts,
    },
    packageCounts: {
      sandboxPackages: Array.isArray(all.sandboxPackages) ? all.sandboxPackages.length : 0,
      mcpServers: getMcpRegistrations(settingsStore).length,
      adapters: getAdapterRegistrations(settingsStore).length,
      providers: getProviderRegistrations(settingsStore).length,
    },
  }
}

function buildProviderDiagnostics(runtime: RuntimeService, settingsStore?: DaemonSettingsStore) {
  const appProviders = getProviderRegistrations(settingsStore)
  const appProviderIds = new Set(appProviders.map(provider => provider.id))
  return {
    providers: appProviders.map(sanitizeProvider),
    agentUsage: runtime.listAgents().map(agent => {
      const ref = runtime.getAgent(agent.id)
      const config = ref?.config
      const providerId = config?.model.provider ?? ''
      const agentProvider = config?.providers?.find(provider => provider.id === providerId)
      return {
        agentId: agent.id,
        handle: agent.handle,
        name: agent.name,
        providerId,
        modelId: config?.model.model_id ?? '',
        source: agentProvider ? 'agent' : appProviderIds.has(providerId) ? 'app' : 'missing',
        credentialStorage: agentProvider
          ? 'agent'
          : appProviders.find(provider => provider.id === providerId)?.credentialStorage ?? null,
      }
    }),
  }
}

async function buildAuthDiagnostics(settingsStore?: DaemonSettingsStore) {
  const providers = getProviderRegistrations(settingsStore)
  return {
    chatgpt: await getChatGptAuthManager().getAuthStatus(),
    providers: providers.map(provider => ({
      id: provider.id,
      type: provider.type,
      name: provider.name,
      credentialStorage: provider.credentialStorage ?? 'app',
      hasApiKey: typeof provider.apiKey === 'string' && provider.apiKey.length > 0,
    })),
  }
}

function buildMcpSettingsDiagnostics(settingsStore?: DaemonSettingsStore) {
  const servers = getMcpRegistrations(settingsStore)
  return {
    servers: servers.map(server => ({
      id: server.id,
      name: server.name,
      type: server.type ?? 'npm',
      npmPackage: server.npmPackage,
      pypiPackage: server.pypiPackage,
      command: server.command,
      args: server.args,
      url: server.url,
      managed: server.managed ?? false,
      version: server.version,
      credentialStorage: server.credentialStorage ?? 'app',
      env: sanitizeEnv(server.env),
      headers: sanitizeEnv(server.headers),
      headerEnv: server.headerEnv?.map(entry => ({ header: entry.key, env: entry.value })) ?? [],
      bearerTokenEnvVar: server.bearerTokenEnvVar ?? null,
      toolCallTimeout: server.toolCallTimeout ?? null,
    })),
  }
}

function buildAdapterSettingsDiagnostics(settingsStore?: DaemonSettingsStore) {
  const adapters = getAdapterRegistrations(settingsStore)
  return {
    adapters: adapters.map(adapter => ({
      id: adapter.id,
      type: adapter.type,
      npmPackage: adapter.npmPackage,
      managed: adapter.managed ?? false,
      version: adapter.version,
      credentialStorage: adapter.credentialStorage ?? 'app',
      env: sanitizeEnv(adapter.env),
    })),
  }
}

function buildNetworkDiagnostics(runtime: RuntimeService, opts: DaemonHttpApiOptions) {
  const settings = opts.settingsStore?.getAll?.() ?? {}
  const connections = opts.wsService?.getConnections() ?? []
  return {
    host: getLanAddresses(),
    mesh: {
      enabledSetting: settings.meshEnabled !== false,
      lan: !!settings.meshLan,
      port: typeof settings.meshPort === 'number' ? settings.meshPort : 7295,
      status: opts.networkService?.getStatus() ?? null,
    },
    websocket: {
      activeConnections: connections.length,
      inboundConnections: connections.filter(conn => conn.direction === 'inbound').length,
      outboundConnections: connections.filter(conn => conn.direction === 'outbound').length,
    },
    agents: runtime.listAgents().map(agent => {
      const ref = runtime.getAgent(agent.id)
      return {
        agentId: agent.id,
        handle: agent.handle,
        name: agent.name,
        filePath: agent.filePath,
        receive: ref?.config.messaging?.receive ?? false,
        sendMode: ref?.config.messaging?.mode ?? null,
        network: ref?.config.messaging?.network ?? null,
        wsConnectionsConfigured: ref?.config.ws_connections?.length ?? 0,
        servingRoutes: ref?.config.serving?.api?.length ?? 0,
        publicServingEnabled: ref?.config.serving?.public?.enabled ?? false,
      }
    }),
  }
}

function getProviderRegistrations(settingsStore?: DaemonSettingsStore): ProviderConfig[] {
  const providers = settingsStore?.get('providers')
  return Array.isArray(providers) ? providers.filter(isRecord) as unknown as ProviderConfig[] : []
}

function getMcpRegistrations(settingsStore?: DaemonSettingsStore): McpServerRegistration[] {
  const servers = settingsStore?.get('mcpServers')
  return Array.isArray(servers) ? servers.filter(isRecord) as unknown as McpServerRegistration[] : []
}

function getAdapterRegistrations(settingsStore?: DaemonSettingsStore): AdapterRegistration[] {
  const adapters = settingsStore?.get('adapters')
  const registrations = Array.isArray(adapters) ? adapters.filter(isRecord) as unknown as AdapterRegistration[] : []
  return withBuiltInAdapterRegistrations(registrations)
}

function sanitizeProvider(provider: ProviderConfig) {
  return {
    id: provider.id,
    type: provider.type,
    name: provider.name,
    baseUrl: provider.baseUrl,
    defaultModel: provider.defaultModel,
    requestDelayMs: provider.requestDelayMs ?? 0,
    credentialStorage: provider.credentialStorage ?? 'app',
    hasApiKey: typeof provider.apiKey === 'string' && provider.apiKey.length > 0,
    params: provider.params?.map(param => ({ key: param.key, hasValue: param.value.length > 0 })) ?? [],
  }
}

function sanitizeEnv(env?: Array<{ key: string; value: string }>) {
  return (env ?? []).map(entry => ({ key: entry.key, hasValue: entry.value.length > 0 }))
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function parseOptionalInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) return undefined
  return parsed
}

function isInboxStatus(value: string): value is 'unread' | 'read' | 'archived' {
  return value === 'unread' || value === 'read' || value === 'archived'
}

function isOutboxStatus(value: string): value is 'pending' | 'sent' | 'delivered' | 'failed' {
  return value === 'pending' || value === 'sent' || value === 'delivered' || value === 'failed'
}

function isFileProtection(value: unknown): value is FileProtectionLevel {
  return value === 'read_only' || value === 'no_delete' || value === 'none'
}

function isMetaProtection(value: unknown): value is MetaProtectionLevel {
  return value === 'none' || value === 'readonly' || value === 'increment'
}

function isTriggerScope(value: unknown): value is 'agent' | 'system' {
  return value === 'agent' || value === 'system'
}

function isAdfEventType(value: unknown): value is AdfEvent['type'] {
  return typeof value === 'string' && (ADF_EVENT_TYPES as readonly string[]).includes(value)
}

function isTaskStatus(value: string): value is TaskStatus {
  return value === 'pending'
    || value === 'pending_approval'
    || value === 'running'
    || value === 'completed'
    || value === 'failed'
    || value === 'denied'
    || value === 'cancelled'
}

function isTaskResolveAction(value: string): value is 'approve' | 'deny' | 'pending_approval' {
  return value === 'approve' || value === 'deny' || value === 'pending_approval'
}

function handleRuntimeError(reply: FastifyReply, err: unknown) {
  if (err instanceof RuntimeReviewRequiredError) {
    return reply.code(403).send({
      error: err.message,
      code: err.code,
      agentId: err.agentId,
      filePath: err.filePath,
    })
  }

  return reply.code(500).send({
    error: err instanceof Error ? err.message : String(err),
  })
}

function writeSseEvent(stream: NodeJS.WritableStream, event: DaemonEventEnvelope): void {
  stream.write(`id: ${event.seq}\n`)
  stream.write(`event: ${event.type}\n`)
  stream.write(`data: ${JSON.stringify(event)}\n\n`)
}
