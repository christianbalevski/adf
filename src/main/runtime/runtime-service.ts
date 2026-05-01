import { EventEmitter } from 'node:events'
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { basename, join } from 'node:path'
import { AdfDatabase } from '../adf/adf-database'
import { AdfWorkspace } from '../adf/adf-workspace'
import { encrypt } from '../crypto/identity-crypto'
import { buildConfigSummary, isConfigReviewed, markConfigReviewed } from '../services/agent-review'
import type { LLMProvider } from '../providers/provider.interface'
import type {
  AgentConfig,
  AdfProviderConfig,
  AdfLogEntry,
  FileProtectionLevel,
  InboxMessage,
  InboxStatus,
  LoopEntry,
  LoopTokenUsage,
  MetaProtectionLevel,
  McpServerConfig,
  McpServerState,
  OutboxMessage,
  OutboxStatus,
  Timer,
  TaskEntry,
  TaskStatus,
  TimerSchedule,
  TriggerConfig,
} from '../../shared/types/adf-v02.types'
import type { AdapterInstanceConfig, AdapterState } from '../../shared/types/channel-adapter.types'
import type { AgentConfigSummary, AgentExecutionEvent } from '../../shared/types/ipc.types'
import type { AgentState } from './agent-executor'
import {
  type AdfBatchDispatch,
  type AdfEventDispatch,
  createDispatch,
  createEvent,
} from '../../shared/types/adf-event.types'
import { parseLoopToDisplay } from '../../shared/utils/loop-parser'
import {
  createHeadlessAgent,
  createHeadlessAgentFromWorkspace,
  type CreateHeadlessAgentOptions,
  type HeadlessAgent,
} from './headless'
import type { AgentRuntimeBuilder } from './agent-runtime-builder'
import { RuntimeGate } from './runtime-gate'

export interface RuntimeSettingsStore {
  get(key: string): unknown
  set?(key: string, value: unknown): void
}

export type RuntimeProviderFactory = (
  config: AgentConfig,
  filePath: string | null,
) => LLMProvider | Promise<LLMProvider>

export interface RuntimeServiceOptions {
  settings?: RuntimeSettingsStore
  providerFactory?: RuntimeProviderFactory
  basePrompt?: string
  toolPrompts?: Record<string, string>
  compactionPrompt?: string
  agentRuntimeBuilder?: AgentRuntimeBuilder
  /** Defaults to true for opened .adf files. Ephemeral createAgent calls bypass review. */
  enforceReviewGate?: boolean
}

export interface RuntimeLoadAgentOptions {
  provider?: LLMProvider
  enforceReviewGate?: boolean
}

export interface RuntimeCreateAgentOptions extends CreateHeadlessAgentOptions {
  id?: string
}

export interface RuntimeAgentRef {
  id: string
  filePath: string | null
  config: AgentConfig
}

export interface RuntimeAgentSummary {
  id: string
  filePath: string | null
  name: string
  handle?: string
  autostart: boolean
}

export interface RuntimeAgentStatus extends RuntimeAgentSummary {
  runtimeState: AgentState
  targetState: string | null
  loopCount: number
}

export interface RuntimeAgentStartResult {
  ref: RuntimeAgentRef
  loaded: boolean
  startupTriggered: boolean
}

export interface RuntimeAgentLoopPage {
  agentId: string
  total: number
  limit: number
  offset: number
  entries: LoopEntry[]
}

export interface RuntimeAgentFileContent {
  agentId: string
  path: string
  mime_type: string | null
  size: number
  protection: string
  authorized: boolean
  created_at: string
  updated_at: string
  encoding: 'utf-8' | 'base64'
  content?: string
  content_base64?: string
}

export interface RuntimeAgentLogsOptions {
  limit?: number
  origin?: string
  event?: string
}

export interface RuntimeAgentTasksOptions {
  status?: TaskStatus
  limit?: number
}

export interface RuntimeUsageTotals {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
}

export interface RuntimeAgentUsageByModel extends RuntimeUsageTotals {
  model: string
  rows: number
}

export interface RuntimeAgentUsage {
  agentId: string
  source: 'adf_loop'
  note: string
  loopRows: number
  usageRows: number
  totals: RuntimeUsageTotals
  byModel: RuntimeAgentUsageByModel[]
}

export interface RuntimeTaskResolveOptions {
  action: 'approve' | 'deny' | 'pending_approval'
  reason?: string
  modifiedArgs?: Record<string, unknown>
}

export interface RuntimeTimerMutationOptions {
  id?: number
  mode: 'once_at' | 'once_delay' | 'interval' | 'cron'
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

export interface RuntimeAgentAdaptersDiagnostics {
  agentId: string
  configured: Array<{ type: string; enabled: boolean; config: Record<string, unknown> }>
  states: AdapterState[]
}

export interface RuntimeAgentMcpDiagnostics {
  agentId: string
  configured: Array<{ name: string; transport?: string; command?: string; args?: string[]; toolCount: number }>
  states: McpServerState[]
}

export interface RuntimeAgentTriggersDiagnostics {
  agentId: string
  displayState: string | null
  configured: Array<{ type: string; enabled: boolean; targetCount: number; targets: TriggerConfig['targets'] }>
}

export interface RuntimeAgentEvent {
  agentId: string
  filePath: string | null
  event: AgentExecutionEvent
}

export interface RuntimeAgentLoadedEvent {
  agentId: string
  filePath: string | null
  ref: RuntimeAgentRef
  agent: HeadlessAgent
}

export interface RuntimeAgentUnloadedEvent {
  agentId: string
  filePath: string | null
}

export interface RuntimeReviewInfo {
  agentId: string
  filePath: string
  reviewed: boolean
  summary: AgentConfigSummary
}

export interface RuntimeAutostartOptions {
  maxDepth?: number
}

export interface RuntimeAutostartStarted {
  agentId: string
  filePath: string
  name: string
  startupTriggered: boolean
}

export type RuntimeAutostartSkipReason =
  | 'already_loaded'
  | 'not_autostart'
  | 'password_protected'
  | 'unreviewed'

export interface RuntimeAutostartSkipped {
  filePath: string
  name: string
  reason: RuntimeAutostartSkipReason
  agentId?: string
}

export interface RuntimeAutostartFailed {
  filePath: string
  name: string
  error: string
}

export interface RuntimeAutostartReport {
  scanned: number
  started: RuntimeAutostartStarted[]
  skipped: RuntimeAutostartSkipped[]
  failed: RuntimeAutostartFailed[]
}

interface ManagedRuntimeAgent {
  id: string
  filePath: string | null
  config: AgentConfig
  agent: HeadlessAgent
  eventListener: (event: AgentExecutionEvent) => void
  derivedKey: Buffer | null
}

export class RuntimeReviewRequiredError extends Error {
  readonly code = 'AGENT_REVIEW_REQUIRED'
  constructor(readonly agentId: string, readonly filePath: string) {
    super('Agent must be reviewed before loading into the runtime.')
    this.name = 'RuntimeReviewRequiredError'
  }
}

export class RuntimeService extends EventEmitter {
  private readonly settings?: RuntimeSettingsStore
  private readonly providerFactory?: RuntimeProviderFactory
  private readonly basePrompt: string
  private readonly toolPrompts: Record<string, string>
  private readonly compactionPrompt?: string
  private readonly agentRuntimeBuilder?: AgentRuntimeBuilder
  private readonly enforceReviewGate: boolean
  private readonly agents = new Map<string, ManagedRuntimeAgent>()
  private readonly filePathToAgentId = new Map<string, string>()

  constructor(opts: RuntimeServiceOptions = {}) {
    super()
    this.settings = opts.settings
    this.providerFactory = opts.providerFactory
    this.basePrompt = opts.basePrompt ?? ''
    this.toolPrompts = opts.toolPrompts ?? {}
    this.compactionPrompt = opts.compactionPrompt
    this.agentRuntimeBuilder = opts.agentRuntimeBuilder
    this.enforceReviewGate = opts.enforceReviewGate ?? true
  }

  async loadAgent(filePath: string, opts: RuntimeLoadAgentOptions = {}): Promise<RuntimeAgentRef> {
    const canonicalPath = this.canonicalFilePath(filePath)
    const existingId = this.filePathToAgentId.get(canonicalPath)
    if (existingId) return this.toRef(this.requireAgent(existingId))

    const shouldEnforceReview = opts.enforceReviewGate ?? this.enforceReviewGate
    this.assertReviewGate(canonicalPath, shouldEnforceReview)

    const workspace = AdfWorkspace.open(canonicalPath)
    try {
      const config = workspace.getAgentConfig() as AgentConfig
      const provider = await this.resolveProvider(config, canonicalPath, opts.provider)
      const agent = await this.buildLoadedAgent(workspace, canonicalPath, config, provider)
      return this.registerAgent(agent, canonicalPath, config)
    } catch (err) {
      try { workspace.dispose() } catch { /* best effort */ }
      throw err
    }
  }

  createAgent(opts: RuntimeCreateAgentOptions): RuntimeAgentRef {
    const agent = createHeadlessAgent({
      ...opts,
      basePrompt: opts.basePrompt ?? this.basePrompt,
      toolPrompts: opts.toolPrompts ?? this.toolPrompts,
      compactionPrompt: opts.compactionPrompt ?? this.compactionPrompt,
    })
    const config = agent.workspace.getAgentConfig() as AgentConfig
    return this.registerAgent(agent, opts.filePath ? this.canonicalFilePath(opts.filePath) : null, config, opts.id)
  }

  async unloadAgent(agentId: string): Promise<void> {
    const managed = this.resolveAgent(agentId)
    if (!managed) return
    this.emit('agent-unloaded', {
      agentId: managed.id,
      filePath: managed.filePath,
    } satisfies RuntimeAgentUnloadedEvent)
    managed.agent.executor.off('event', managed.eventListener)
    if (managed.agent.disposeAsync) await managed.agent.disposeAsync()
    else managed.agent.dispose()
    this.agents.delete(managed.id)
    if (managed.filePath) this.filePathToAgentId.delete(managed.filePath)
  }

  async trigger(agentId: string, dispatch: AdfEventDispatch | AdfBatchDispatch): Promise<void> {
    await this.requireAgent(agentId).agent.executor.executeTurn(dispatch)
  }

  async sendChat(agentId: string, text: string): Promise<void> {
    await this.trigger(
      agentId,
      createDispatch(
        createEvent({
          type: 'chat',
          source: 'user',
          data: {
            message: {
              seq: Date.now(),
              role: 'user',
              content_json: [{ type: 'text', text }],
              created_at: Date.now(),
            },
          },
        }),
        { scope: 'agent' },
      ),
    )
  }

  async startAgent(agentId: string): Promise<boolean> {
    RuntimeGate.resume()
    const managed = this.requireAgent(agentId)
    const startState = managed.config.start_in_state ?? 'active'
    if (startState !== 'active') return false

    await this.trigger(
      agentId,
      createDispatch(
        createEvent({ type: 'startup', source: 'system', data: undefined }),
        { scope: 'agent' },
      ),
    )
    return true
  }

  async startOrLoadAgent(identifier: string): Promise<RuntimeAgentStartResult> {
    let managed = this.resolveAgent(identifier)
    let loaded = false

    if (!managed) {
      const filePath = this.findAgentFile(identifier)
      if (!filePath) throw new Error(`RuntimeService: unknown agent "${identifier}"`)
      const ref = await this.loadAgent(filePath)
      managed = this.requireAgent(ref.id)
      loaded = true
    }

    const startupTriggered = await this.startAgent(managed.id)
    return {
      ref: this.toRef(managed),
      loaded,
      startupTriggered,
    }
  }

  async stopAgent(agentId: string): Promise<void> {
    await this.unloadAgent(agentId)
  }

  async abortAgent(agentId: string): Promise<void> {
    const managed = this.requireAgent(agentId)
    managed.agent.executor.abort()
  }

  async autostartFromDirectories(
    trackedDirs: string[],
    opts: RuntimeAutostartOptions = {},
  ): Promise<RuntimeAutostartReport> {
    RuntimeGate.resume()
    const files = this.collectAdfFiles(trackedDirs, opts.maxDepth ?? 5)
    const report: RuntimeAutostartReport = {
      scanned: files.length,
      started: [],
      skipped: [],
      failed: [],
    }

    for (const filePath of files) {
      const name = basename(filePath, '.adf')

      if (this.filePathToAgentId.has(filePath)) {
        report.skipped.push({
          filePath,
          name,
          reason: 'already_loaded',
          agentId: this.filePathToAgentId.get(filePath),
        })
        continue
      }

      const bootResult = AdfDatabase.peekBootStatusDetailed(filePath)
      const boot = bootResult.status
      if (!boot) {
        report.failed.push({
          filePath,
          name,
          error: bootResult.error
            ? `Unable to read ADF boot status: ${bootResult.error}`
            : 'Unable to read ADF boot status.',
        })
        continue
      }

      if (!boot.autostart) {
        report.skipped.push({ filePath, name, reason: 'not_autostart', agentId: boot.agentId })
        continue
      }

      if (boot.hasEncryptedIdentity) {
        report.skipped.push({ filePath, name, reason: 'password_protected', agentId: boot.agentId })
        continue
      }

      if (!this.isFileConfigReviewed(filePath)) {
        report.skipped.push({ filePath, name, reason: 'unreviewed', agentId: boot.agentId })
        continue
      }

      try {
        const ref = await this.loadAgent(filePath)
        const startupTriggered = await this.startAgent(ref.id)
        report.started.push({ agentId: ref.id, filePath, name: ref.config.name, startupTriggered })
      } catch (err) {
        if (err instanceof RuntimeReviewRequiredError) {
          report.skipped.push({ filePath, name, reason: 'unreviewed', agentId: err.agentId })
        } else {
          report.failed.push({
            filePath,
            name,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
    }

    return report
  }

  getReviewInfo(filePath: string): RuntimeReviewInfo {
    const canonicalPath = this.canonicalFilePath(filePath)
    const workspace = AdfWorkspace.open(canonicalPath)
    try {
      const config = workspace.getAgentConfig() as AgentConfig
      const ownerDid = (this.settings?.get('ownerDid') as string | undefined) ?? null
      return {
        agentId: config.id,
        filePath: canonicalPath,
        reviewed: isConfigReviewed(this.settings?.get('reviewedAgents'), config),
        summary: buildConfigSummary(config, ownerDid),
      }
    } finally {
      workspace.dispose()
    }
  }

  acceptReview(filePath: string): RuntimeReviewInfo {
    if (!this.settings?.set) {
      throw new Error('RuntimeService: settings store is read-only; cannot accept agent review.')
    }

    const canonicalPath = this.canonicalFilePath(filePath)
    const workspace = AdfWorkspace.open(canonicalPath)
    try {
      const config = workspace.getAgentConfig() as AgentConfig
      this.settings.set('reviewedAgents', markConfigReviewed(this.settings.get('reviewedAgents'), config))
      const ownerDid = (this.settings?.get('ownerDid') as string | undefined) ?? null
      return {
        agentId: config.id,
        filePath: canonicalPath,
        reviewed: true,
        summary: buildConfigSummary(config, ownerDid),
      }
    } finally {
      workspace.dispose()
    }
  }

  getAgent(agentId: string): RuntimeAgentRef | undefined {
    const managed = this.resolveAgent(agentId)
    return managed ? this.toRef(managed) : undefined
  }

  getAgentStatus(agentId: string): RuntimeAgentStatus | undefined {
    const managed = this.resolveAgent(agentId)
    if (!managed) return undefined
    return this.toStatus(managed)
  }

  getAgentLoop(agentId: string, opts: { limit?: number; offset?: number } = {}): RuntimeAgentLoopPage {
    const managed = this.requireAgent(agentId)
    const total = managed.agent.workspace.getLoopCount()
    const limit = clampInteger(opts.limit ?? 50, 1, 500)
    const offset = opts.offset === undefined
      ? Math.max(0, total - limit)
      : clampInteger(opts.offset, 0, Math.max(0, total))
    const entries = managed.agent.workspace.getLoopPaginated(limit, offset)
    return { agentId: managed.id, total, limit, offset, entries }
  }

  getAgentConfig(agentId: string): { agentId: string; config: AgentConfig } {
    const managed = this.requireAgent(agentId)
    return { agentId: managed.id, config: managed.config }
  }

  async setAgentConfig(agentId: string, config: AgentConfig): Promise<{ agentId: string; success: true; config: AgentConfig }> {
    const managed = this.requireAgent(agentId)
    const previousConfig = managed.config
    managed.agent.workspace.setAgentConfig(config)
    managed.config = config
    managed.agent.executor.updateConfig(config)
    managed.agent.triggerEvaluator?.updateConfig(config)
    managed.agent.adfCallHandler?.updateConfig(config)

    const providerChanged =
      previousConfig.model.provider !== config.model.provider ||
      previousConfig.model.model_id !== config.model.model_id ||
      JSON.stringify(previousConfig.model.params) !== JSON.stringify(config.model.params)
    if (providerChanged && this.providerFactory) {
      const provider = await this.providerFactory(config, managed.filePath)
      managed.agent.executor.updateProvider(provider)
    }

    return { agentId: managed.id, success: true, config }
  }

  getAgentDocument(agentId: string): { agentId: string; content: string } {
    const managed = this.requireAgent(agentId)
    return { agentId: managed.id, content: managed.agent.workspace.readDocument() }
  }

  setAgentDocument(agentId: string, content: string): { agentId: string; success: true } {
    const managed = this.requireAgent(agentId)
    const previousContent = managed.agent.workspace.readDocument()
    managed.agent.workspace.writeDocument(content)
    managed.agent.triggerEvaluator?.onDocumentEdit(content, previousContent)
    return { agentId: managed.id, success: true }
  }

  getAgentMind(agentId: string): { agentId: string; content: string } {
    const managed = this.requireAgent(agentId)
    return { agentId: managed.id, content: managed.agent.workspace.readMind() }
  }

  setAgentMind(agentId: string, content: string): { agentId: string; success: true } {
    const managed = this.requireAgent(agentId)
    managed.agent.workspace.writeMind(content)
    return { agentId: managed.id, success: true }
  }

  getAgentChat(agentId: string, limit = 200): { agentId: string; chatHistory: { version: number; uiLog: unknown[]; llmMessages: unknown[] } | null } {
    const managed = this.requireAgent(agentId)
    const total = managed.agent.workspace.getLoopCount()
    if (total === 0) return { agentId: managed.id, chatHistory: null }
    const clampedLimit = clampInteger(limit, 1, 500)
    const offset = Math.max(0, total - clampedLimit)
    const loopEntries = offset > 0
      ? managed.agent.workspace.getLoopPaginated(clampedLimit, offset)
      : managed.agent.workspace.getLoop()
    return {
      agentId: managed.id,
      chatHistory: {
        version: 1,
        uiLog: parseLoopToDisplay(loopEntries),
        llmMessages: [],
      },
    }
  }

  clearAgentChat(agentId: string): { agentId: string; success: true } {
    const managed = this.requireAgent(agentId)
    managed.agent.workspace.clearLoop()
    managed.agent.session.reset()
    return { agentId: managed.id, success: true }
  }

  getAgentFiles(agentId: string): { agentId: string; files: ReturnType<AdfWorkspace['listFiles']> } {
    const managed = this.requireAgent(agentId)
    return { agentId: managed.id, files: managed.agent.workspace.listFiles() }
  }

  getAgentFile(agentId: string, path: string): RuntimeAgentFileContent | null {
    const managed = this.requireAgent(agentId)
    const meta = managed.agent.workspace.getFileMeta(path)
    const content = managed.agent.workspace.readFileBuffer(path)
    if (!meta || !content) return null
    const textLike = isTextLike(meta.mime_type, path)
    return {
      agentId: managed.id,
      path: meta.path,
      mime_type: meta.mime_type,
      size: meta.size,
      protection: meta.protection,
      authorized: meta.authorized,
      created_at: meta.created_at,
      updated_at: meta.updated_at,
      encoding: textLike ? 'utf-8' : 'base64',
      ...(textLike
        ? { content: content.toString('utf-8') }
        : { content_base64: content.toString('base64') }),
    }
  }

  writeAgentFile(agentId: string, path: string, opts: { content?: string; contentBase64?: string; mimeType?: string; protection?: FileProtectionLevel }): { agentId: string; success: true } {
    const managed = this.requireAgent(agentId)
    const previousContent = managed.agent.workspace.readFile(path) ?? undefined
    if (opts.contentBase64 !== undefined) {
      managed.agent.workspace.writeFileBuffer(path, Buffer.from(opts.contentBase64, 'base64'), opts.mimeType)
    } else {
      const content = opts.content ?? ''
      managed.agent.workspace.writeFile(path, content, opts.protection)
      managed.agent.triggerEvaluator?.onFileChange(path, previousContent === undefined ? 'created' : 'modified', content, previousContent)
    }
    return { agentId: managed.id, success: true }
  }

  deleteAgentFile(agentId: string, path: string): { agentId: string; success: boolean } {
    const managed = this.requireAgent(agentId)
    return { agentId: managed.id, success: managed.agent.workspace.deleteFile(path) }
  }

  renameAgentFile(agentId: string, oldPath: string, newPath: string): { agentId: string; success: boolean } {
    const managed = this.requireAgent(agentId)
    return { agentId: managed.id, success: managed.agent.workspace.renameInternalFile(oldPath, newPath) }
  }

  renameAgentFolder(agentId: string, oldPrefix: string, newPrefix: string): { agentId: string; success: true; count: number } {
    const managed = this.requireAgent(agentId)
    const count = managed.agent.workspace.renameFolder(oldPrefix, newPrefix)
    return { agentId: managed.id, success: true, count }
  }

  setAgentFileProtection(agentId: string, path: string, protection: FileProtectionLevel): { agentId: string; success: boolean } {
    const managed = this.requireAgent(agentId)
    return { agentId: managed.id, success: managed.agent.workspace.setFileProtection(path, protection) }
  }

  setAgentFileAuthorized(agentId: string, path: string, authorized: boolean): { agentId: string; success: boolean } {
    const managed = this.requireAgent(agentId)
    return { agentId: managed.id, success: managed.agent.workspace.setFileAuthorized(path, authorized) }
  }

  getAgentInbox(agentId: string, status?: InboxStatus): { agentId: string; messages: InboxMessage[] } {
    const managed = this.requireAgent(agentId)
    return { agentId: managed.id, messages: managed.agent.workspace.getInbox(status) }
  }

  clearAgentInbox(agentId: string): { agentId: string; success: true; deleted: number } {
    const managed = this.requireAgent(agentId)
    const result = managed.agent.workspace.deleteInboxByFilter({})
    return { agentId: managed.id, success: true, deleted: result.deleted }
  }

  getAgentOutbox(agentId: string, status?: OutboxStatus): { agentId: string; messages: OutboxMessage[] } {
    const managed = this.requireAgent(agentId)
    return { agentId: managed.id, messages: managed.agent.workspace.getOutbox(status) }
  }

  getAgentTimers(agentId: string): { agentId: string; timers: Timer[] } {
    const managed = this.requireAgent(agentId)
    return { agentId: managed.id, timers: managed.agent.workspace.getTimers() }
  }

  async addAgentTimer(agentId: string, opts: RuntimeTimerMutationOptions): Promise<{ agentId: string; success: true; id: number }> {
    const managed = this.requireAgent(agentId)
    const timer = await buildTimerMutation(opts)
    const id = managed.agent.workspace.addTimer(timer.schedule, timer.nextWakeAt, opts.payload, opts.scope ?? ['agent'], opts.lambda, opts.warm, opts.locked)
    return { agentId: managed.id, success: true, id }
  }

  async updateAgentTimer(agentId: string, opts: RuntimeTimerMutationOptions & { id: number }): Promise<{ agentId: string; success: boolean }> {
    const managed = this.requireAgent(agentId)
    const timer = await buildTimerMutation(opts)
    return {
      agentId: managed.id,
      success: managed.agent.workspace.updateTimer(opts.id, timer.schedule, timer.nextWakeAt, opts.payload, opts.scope ?? ['agent'], opts.lambda, opts.warm, opts.locked),
    }
  }

  deleteAgentTimer(agentId: string, id: number): { agentId: string; success: boolean } {
    const managed = this.requireAgent(agentId)
    return { agentId: managed.id, success: managed.agent.workspace.deleteTimer(id) }
  }

  getAgentMeta(agentId: string): { agentId: string; entries: Array<{ key: string; value: string; protection: MetaProtectionLevel }> } {
    const managed = this.requireAgent(agentId)
    return { agentId: managed.id, entries: managed.agent.workspace.getAllMeta() }
  }

  setAgentMeta(agentId: string, key: string, value: string, protection?: MetaProtectionLevel): { agentId: string; success: true } {
    const managed = this.requireAgent(agentId)
    managed.agent.workspace.setMeta(key, value, protection)
    return { agentId: managed.id, success: true }
  }

  deleteAgentMeta(agentId: string, key: string): { agentId: string; success: boolean } {
    const managed = this.requireAgent(agentId)
    return { agentId: managed.id, success: managed.agent.workspace.deleteMeta(key) }
  }

  setAgentMetaProtection(agentId: string, key: string, protection: MetaProtectionLevel): { agentId: string; success: boolean } {
    const managed = this.requireAgent(agentId)
    return { agentId: managed.id, success: managed.agent.workspace.setMetaProtection(key, protection) }
  }

  getAgentUsage(agentId: string): RuntimeAgentUsage {
    const managed = this.requireAgent(agentId)
    const entries = managed.agent.workspace.getLoop()
    const totals = createUsageTotals()
    const byModel = new Map<string, RuntimeAgentUsageByModel>()
    let usageRows = 0

    for (const entry of entries) {
      if (!entry.tokens) continue
      usageRows++
      addUsage(totals, entry.tokens)
      const model = entry.model ?? 'unknown'
      let bucket = byModel.get(model)
      if (!bucket) {
        bucket = { model, rows: 0, ...createUsageTotals() }
        byModel.set(model, bucket)
      }
      bucket.rows++
      addUsage(bucket, entry.tokens)
    }

    return {
      agentId: managed.id,
      source: 'adf_loop',
      note: 'Includes token usage persisted on loop rows. It does not include model_invoke, compaction, or provider calls that did not create loop rows.',
      loopRows: entries.length,
      usageRows,
      totals,
      byModel: Array.from(byModel.values()).sort((a, b) => b.total - a.total),
    }
  }

  getAgentTasks(agentId: string, opts: RuntimeAgentTasksOptions = {}): { agentId: string; tasks: TaskEntry[] } {
    const managed = this.requireAgent(agentId)
    const tasks = opts.status
      ? managed.agent.workspace.getTasksByStatus(opts.status)
      : managed.agent.workspace.getAllTasks(clampInteger(opts.limit ?? 200, 1, 1000))
    return { agentId: managed.id, tasks }
  }

  getAgentTask(agentId: string, taskId: string): { agentId: string; task: TaskEntry } | null {
    const managed = this.requireAgent(agentId)
    const task = managed.agent.workspace.getTask(taskId)
    return task ? { agentId: managed.id, task } : null
  }

  async resolveAgentTask(agentId: string, taskId: string, opts: RuntimeTaskResolveOptions): Promise<{
    agentId: string
    taskId: string
    resolution: unknown
    task: TaskEntry | null
  }> {
    const managed = this.requireAgent(agentId)
    const input = {
      task_id: taskId,
      action: opts.action,
      reason: opts.reason,
      modified_args: opts.modifiedArgs,
    }

    let resolution: unknown
    if (managed.agent.adfCallHandler) {
      const result = await managed.agent.adfCallHandler.resolveTask(input)
      if (result.error) throw new Error(result.error)
      resolution = parseMaybeJson(result.result)
    } else {
      const task = managed.agent.workspace.getTask(taskId)
      if (!task) throw new Error(`Task "${taskId}" not found`)
      if (task.status !== 'pending' && task.status !== 'pending_approval') {
        throw new Error(`Task "${taskId}" is in status "${task.status}" - can only resolve pending or pending_approval tasks`)
      }
      if (!task.executor_managed) {
        throw new Error(`Task "${taskId}" requires code execution support to resolve`)
      }
      if (opts.action === 'approve') {
        managed.agent.workspace.updateTaskStatus(taskId, 'running')
        managed.agent.executor.resolveHilTask(taskId, true, opts.modifiedArgs)
        resolution = { task_id: taskId, status: 'approved' }
      } else if (opts.action === 'deny') {
        const reason = opts.reason ?? 'Denied'
        managed.agent.workspace.updateTaskStatus(taskId, 'denied', undefined, reason)
        managed.agent.executor.resolveHilTask(taskId, false)
        resolution = { task_id: taskId, status: 'denied', reason }
      } else {
        managed.agent.workspace.updateTaskStatus(taskId, 'pending_approval')
        resolution = { task_id: taskId, status: 'pending_approval' }
      }
    }

    return {
      agentId: managed.id,
      taskId,
      resolution,
      task: managed.agent.workspace.getTask(taskId),
    }
  }

  getAgentAsks(agentId: string): { agentId: string; asks: Array<{ requestId: string; question: string }> } {
    const managed = this.requireAgent(agentId)
    return { agentId: managed.id, asks: managed.agent.executor.getPendingAsks() }
  }

  answerAgentAsk(agentId: string, requestId: string, answer: string): { agentId: string; requestId: string; answered: boolean } {
    const managed = this.requireAgent(agentId)
    const exists = managed.agent.executor.getPendingAsks().some(ask => ask.requestId === requestId)
    if (!exists) throw new Error(`Ask request "${requestId}" not found`)
    managed.agent.executor.resolveAsk(requestId, answer)
    return { agentId: managed.id, requestId, answered: true }
  }

  resolveAgentSuspend(agentId: string, resume: boolean): { agentId: string; resume: boolean; resolved: boolean } {
    const managed = this.requireAgent(agentId)
    if (!managed.agent.executor.hasPendingSuspend()) throw new Error('No pending suspend request')
    managed.agent.executor.resolveSuspend(resume)
    return { agentId: managed.id, resume, resolved: true }
  }

  getAgentIdentities(agentId: string): {
    agentId: string
    identities: Array<{ purpose: string; encrypted: boolean; code_access: boolean }>
  } {
    const managed = this.requireAgent(agentId)
    return { agentId: managed.id, identities: managed.agent.workspace.listIdentityEntries() }
  }

  getAgentIdentityPurposes(agentId: string, prefix?: string): { agentId: string; purposes: string[] } {
    const managed = this.requireAgent(agentId)
    return { agentId: managed.id, purposes: managed.agent.workspace.listIdentityPurposes(prefix) }
  }

  getAgentIdentity(agentId: string, purpose: string): { agentId: string; purpose: string; value: string | null } {
    const managed = this.requireAgent(agentId)
    return {
      agentId: managed.id,
      purpose,
      value: managed.agent.workspace.getIdentityDecrypted(purpose, managed.derivedKey),
    }
  }

  setAgentIdentity(agentId: string, purpose: string, value: string): { agentId: string; purpose: string; success: true } {
    const managed = this.requireAgent(agentId)
    this.setIdentityValue(managed, purpose, value)
    return { agentId: managed.id, purpose, success: true }
  }

  deleteAgentIdentity(agentId: string, purpose: string): { agentId: string; purpose: string; success: boolean } {
    const managed = this.requireAgent(agentId)
    return { agentId: managed.id, purpose, success: managed.agent.workspace.deleteIdentity(purpose) }
  }

  deleteAgentIdentityByPrefix(agentId: string, prefix: string): { agentId: string; prefix: string; deleted: number } {
    const managed = this.requireAgent(agentId)
    return { agentId: managed.id, prefix, deleted: managed.agent.workspace.deleteIdentityByPrefix(prefix) }
  }

  setAgentIdentityCodeAccess(agentId: string, purpose: string, codeAccess: boolean): { agentId: string; purpose: string; success: boolean } {
    const managed = this.requireAgent(agentId)
    return { agentId: managed.id, purpose, success: managed.agent.workspace.setIdentityCodeAccess(purpose, codeAccess) }
  }

  getAgentIdentityPassword(agentId: string): { agentId: string; needsPassword: boolean; unlocked: boolean } {
    const managed = this.requireAgent(agentId)
    return {
      agentId: managed.id,
      needsPassword: managed.agent.workspace.isPasswordProtected(),
      unlocked: managed.derivedKey !== null,
    }
  }

  unlockAgentIdentityPassword(agentId: string, password: string): { agentId: string; success: true } {
    const managed = this.requireAgent(agentId)
    managed.derivedKey = managed.agent.workspace.unlockWithPassword(password)
    return { agentId: managed.id, success: true }
  }

  setAgentIdentityPassword(agentId: string, password: string): { agentId: string; success: true } {
    const managed = this.requireAgent(agentId)
    managed.derivedKey = managed.agent.workspace.setPassword(password)
    return { agentId: managed.id, success: true }
  }

  removeAgentIdentityPassword(agentId: string): { agentId: string; success: true } {
    const managed = this.requireAgent(agentId)
    if (!managed.derivedKey) throw new Error('Identity keystore is locked')
    managed.agent.workspace.removePassword(managed.derivedKey)
    managed.derivedKey = null
    return { agentId: managed.id, success: true }
  }

  changeAgentIdentityPassword(agentId: string, newPassword: string): { agentId: string; success: true } {
    const managed = this.requireAgent(agentId)
    if (!managed.derivedKey) throw new Error('Identity keystore is locked')
    managed.derivedKey = managed.agent.workspace.changePassword(managed.derivedKey, newPassword)
    return { agentId: managed.id, success: true }
  }

  wipeAgentIdentity(agentId: string): { agentId: string; success: true } {
    const managed = this.requireAgent(agentId)
    managed.agent.workspace.wipeAllIdentity()
    managed.derivedKey = null
    return { agentId: managed.id, success: true }
  }

  getAgentDid(agentId: string): { agentId: string; did: string | null } {
    const managed = this.requireAgent(agentId)
    return { agentId: managed.id, did: managed.agent.workspace.getDid() }
  }

  generateAgentIdentityKeys(agentId: string): { agentId: string; success: true; did: string } {
    const managed = this.requireAgent(agentId)
    const result = managed.agent.workspace.generateIdentityKeys(managed.derivedKey)
    return { agentId: managed.id, success: true, did: result.did }
  }

  setAgentProviderCredential(agentId: string, providerId: string, value: string): { agentId: string; providerId: string; success: true } {
    const managed = this.requireAgent(agentId)
    this.setIdentityValue(managed, `provider:${providerId}:apiKey`, value)
    return { agentId: managed.id, providerId, success: true }
  }

  getAgentProviderCredentials(agentId: string, providerId: string): {
    agentId: string
    providerId: string
    credentials: Record<string, string>
    providerConfig?: Pick<AdfProviderConfig, 'defaultModel' | 'params' | 'requestDelayMs'>
  } {
    const managed = this.requireAgent(agentId)
    const providerConfig = managed.config.providers?.find(provider => provider.id === providerId)
    return {
      agentId: managed.id,
      providerId,
      credentials: this.readCredentialMap(managed, `provider:${providerId}:`),
      ...(providerConfig
        ? { providerConfig: {
            defaultModel: providerConfig.defaultModel,
            params: providerConfig.params,
            requestDelayMs: providerConfig.requestDelayMs,
          } }
        : {}),
    }
  }

  async attachAgentProvider(agentId: string, provider: AdfProviderConfig): Promise<{ agentId: string; providerId: string; success: true; alreadyAttached: boolean; config: AgentConfig }> {
    const managed = this.requireAgent(agentId)
    const providers = [...(managed.config.providers ?? [])]
    const existingIdx = providers.findIndex(existing => existing.id === provider.id)
    const alreadyAttached = existingIdx >= 0
    if (alreadyAttached) providers[existingIdx] = { ...providers[existingIdx], ...provider }
    else providers.push(provider)
    const result = await this.setAgentConfig(managed.id, { ...managed.config, providers })
    return { agentId: managed.id, providerId: provider.id, success: true, alreadyAttached, config: result.config }
  }

  async detachAgentProvider(agentId: string, providerId: string): Promise<{ agentId: string; providerId: string; success: true; deletedCredentials: number; config: AgentConfig }> {
    const managed = this.requireAgent(agentId)
    const providers = (managed.config.providers ?? []).filter(provider => provider.id !== providerId)
    const nextConfig = { ...managed.config, providers }
    if (providers.length === 0) delete nextConfig.providers
    const result = await this.setAgentConfig(managed.id, nextConfig)
    const deletedCredentials = managed.agent.workspace.deleteIdentityByPrefix(`provider:${providerId}:`)
    return { agentId: managed.id, providerId, success: true, deletedCredentials, config: result.config }
  }

  setAgentMcpCredential(agentId: string, npmPackage: string, envKey: string, value: string): { agentId: string; npmPackage: string; envKey: string; success: true } {
    const managed = this.requireAgent(agentId)
    this.setIdentityValue(managed, `mcp:${npmPackage}:${envKey}`, value)
    return { agentId: managed.id, npmPackage, envKey, success: true }
  }

  getAgentMcpCredentials(agentId: string, npmPackage: string): { agentId: string; npmPackage: string; credentials: Record<string, string> } {
    const managed = this.requireAgent(agentId)
    return {
      agentId: managed.id,
      npmPackage,
      credentials: this.readCredentialMap(managed, `mcp:${npmPackage}:`),
    }
  }

  async attachAgentMcpServer(agentId: string, server: McpServerConfig): Promise<{ agentId: string; serverName: string; success: true; alreadyAttached: boolean; config: AgentConfig }> {
    const managed = this.requireAgent(agentId)
    const servers = [...(managed.config.mcp?.servers ?? [])]
    const alreadyAttached = servers.some(existing => existing.name === server.name)
    if (!alreadyAttached) servers.push(server)
    const result = await this.setAgentConfig(managed.id, {
      ...managed.config,
      mcp: { ...(managed.config.mcp ?? {}), servers },
    })
    return { agentId: managed.id, serverName: server.name, success: true, alreadyAttached, config: result.config }
  }

  async detachAgentMcpServer(agentId: string, serverName: string, credentialNamespace = serverName): Promise<{ agentId: string; serverName: string; success: true; deletedCredentials: number; config: AgentConfig }> {
    const managed = this.requireAgent(agentId)
    const servers = (managed.config.mcp?.servers ?? []).filter(server => server.name !== serverName)
    const result = await this.setAgentConfig(managed.id, {
      ...managed.config,
      mcp: { ...(managed.config.mcp ?? {}), servers },
    })
    const deletedCredentials = managed.agent.workspace.deleteIdentityByPrefix(`mcp:${credentialNamespace}:`)
    return { agentId: managed.id, serverName, success: true, deletedCredentials, config: result.config }
  }

  setAgentAdapterCredential(agentId: string, adapterType: string, envKey: string, value: string): { agentId: string; adapterType: string; envKey: string; success: true } {
    const managed = this.requireAgent(agentId)
    this.setIdentityValue(managed, `adapter:${adapterType}:${envKey}`, value)
    return { agentId: managed.id, adapterType, envKey, success: true }
  }

  getAgentAdapterCredentials(agentId: string, adapterType: string): { agentId: string; adapterType: string; credentials: Record<string, string> } {
    const managed = this.requireAgent(agentId)
    return {
      agentId: managed.id,
      adapterType,
      credentials: this.readCredentialMap(managed, `adapter:${adapterType}:`),
    }
  }

  async attachAgentAdapter(agentId: string, adapterType: string, config: AdapterInstanceConfig): Promise<{ agentId: string; adapterType: string; success: true; alreadyAttached: boolean; config: AgentConfig }> {
    const managed = this.requireAgent(agentId)
    const adapters = { ...(managed.config.adapters ?? {}) }
    const alreadyAttached = adapters[adapterType] !== undefined
    adapters[adapterType] = config
    const result = await this.setAgentConfig(managed.id, { ...managed.config, adapters })
    return { agentId: managed.id, adapterType, success: true, alreadyAttached, config: result.config }
  }

  async detachAgentAdapter(agentId: string, adapterType: string): Promise<{ agentId: string; adapterType: string; success: true; deletedCredentials: number; config: AgentConfig }> {
    const managed = this.requireAgent(agentId)
    const adapters = { ...(managed.config.adapters ?? {}) }
    delete adapters[adapterType]
    const nextConfig = { ...managed.config, adapters }
    if (Object.keys(adapters).length === 0) delete nextConfig.adapters
    const result = await this.setAgentConfig(managed.id, nextConfig)
    const deletedCredentials = managed.agent.workspace.deleteIdentityByPrefix(`adapter:${adapterType}:`)
    return { agentId: managed.id, adapterType, success: true, deletedCredentials, config: result.config }
  }

  getAgentLogs(agentId: string, opts: RuntimeAgentLogsOptions = {}): AdfLogEntry[] {
    const managed = this.requireAgent(agentId)
    const limit = clampInteger(opts.limit ?? 50, 1, 500)
    let logs = managed.agent.workspace.getLogs(limit) as AdfLogEntry[]
    if (opts.origin) logs = logs.filter(log => log.origin === opts.origin)
    if (opts.event) logs = logs.filter(log => log.event === opts.event)
    return logs
  }

  getAgentLogsAfterId(agentId: string, afterId: number): { agentId: string; logs: AdfLogEntry[] } {
    const managed = this.requireAgent(agentId)
    return { agentId: managed.id, logs: managed.agent.workspace.getLogsAfterId(afterId) as AdfLogEntry[] }
  }

  clearAgentLogs(agentId: string): { agentId: string; success: true } {
    const managed = this.requireAgent(agentId)
    managed.agent.workspace.clearLogs()
    return { agentId: managed.id, success: true }
  }

  listAgentLocalTables(agentId: string): { agentId: string; tables: Array<{ name: string; row_count: number }> } {
    const managed = this.requireAgent(agentId)
    return { agentId: managed.id, tables: managed.agent.workspace.listLocalTables() }
  }

  queryAgentLocalTable(agentId: string, table: string, opts: { limit?: number; offset?: number } = {}): { agentId: string; columns: string[]; rows: Record<string, unknown>[] } {
    const managed = this.requireAgent(agentId)
    assertLocalTableName(table, true)
    const limit = clampInteger(opts.limit ?? 100, 1, 1000)
    const offset = clampInteger(opts.offset ?? 0, 0, Number.MAX_SAFE_INTEGER)
    const rows = managed.agent.workspace.querySQL(`SELECT * FROM "${table}" LIMIT ? OFFSET ?`, [limit, offset]) as Record<string, unknown>[]
    return { agentId: managed.id, columns: rows.length > 0 ? Object.keys(rows[0]) : [], rows }
  }

  dropAgentLocalTable(agentId: string, table: string): { agentId: string; success: boolean } {
    const managed = this.requireAgent(agentId)
    assertLocalTableName(table, false)
    return { agentId: managed.id, success: managed.agent.workspace.dropLocalTable(table) }
  }

  getAgentAdaptersDiagnostics(agentId: string): RuntimeAgentAdaptersDiagnostics {
    const managed = this.requireAgent(agentId)
    return {
      agentId: managed.id,
      configured: Object.entries(managed.config.adapters ?? {}).map(([type, config]) => ({
        type,
        enabled: config.enabled,
        config: config as unknown as Record<string, unknown>,
      })),
      states: managed.agent.adapterManager?.getStates() ?? [],
    }
  }

  getAgentMcpDiagnostics(agentId: string): RuntimeAgentMcpDiagnostics {
    const managed = this.requireAgent(agentId)
    return {
      agentId: managed.id,
      configured: (managed.config.mcp?.servers ?? []).map(server => ({
        name: server.name,
        transport: server.transport,
        command: server.command,
        args: server.args,
        toolCount: server.available_tools?.length ?? 0,
      })),
      states: managed.agent.mcpManager?.getServerStates() ?? [],
    }
  }

  getAgentTriggersDiagnostics(agentId: string): RuntimeAgentTriggersDiagnostics {
    const managed = this.requireAgent(agentId)
    return {
      agentId: managed.id,
      displayState: managed.agent.triggerEvaluator?.getDisplayState() ?? null,
      configured: Object.entries(managed.config.triggers ?? {}).map(([type, trigger]) => ({
        type,
        enabled: trigger?.enabled ?? false,
        targetCount: trigger?.targets?.length ?? 0,
        targets: trigger?.targets ?? [],
      })),
    }
  }

  listAgents(): RuntimeAgentSummary[] {
    return Array.from(this.agents.values()).map(managed => this.toSummary(managed))
  }

  override on(event: 'agent-event', listener: (event: RuntimeAgentEvent) => void): this
  override on(event: 'agent-loaded', listener: (event: RuntimeAgentLoadedEvent) => void): this
  override on(event: 'agent-unloaded', listener: (event: RuntimeAgentUnloadedEvent) => void): this
  override on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener)
  }

  private registerAgent(agent: HeadlessAgent, filePath: string | null, config: AgentConfig, idOverride?: string): RuntimeAgentRef {
    const id = idOverride ?? config.id
    if (this.agents.has(id)) {
      agent.dispose()
      return this.toRef(this.requireAgent(id))
    }

    const managed: ManagedRuntimeAgent = {
      id,
      filePath,
      config,
      agent,
      derivedKey: null,
      eventListener: (event) => {
        this.emit('agent-event', { agentId: id, filePath, event } satisfies RuntimeAgentEvent)
      },
    }
    this.wireCreateAdfCallbacks(managed)
    agent.executor.on('event', managed.eventListener)
    this.agents.set(id, managed)
    if (filePath) this.filePathToAgentId.set(filePath, id)
    const ref = this.toRef(managed)
    this.emit('agent-loaded', {
      agentId: id,
      filePath,
      ref,
      agent,
    } satisfies RuntimeAgentLoadedEvent)
    return ref
  }

  private requireAgent(agentId: string): ManagedRuntimeAgent {
    const managed = this.resolveAgent(agentId)
    if (!managed) throw new Error(`RuntimeService: unknown agent "${agentId}"`)
    return managed
  }

  private wireCreateAdfCallbacks(managed: ManagedRuntimeAgent): void {
    const createAdfTool = managed.agent.registry.get('sys_create_adf') as {
      onAutostartChild?: (filePath: string) => Promise<boolean>
      onChildCreated?: (filePath: string, config: AgentConfig) => void
    } | undefined
    if (!createAdfTool) return

    createAdfTool.onChildCreated = (_childPath, childConfig) => {
      if (!this.settings?.set) return
      this.settings.set('reviewedAgents', markConfigReviewed(this.settings.get('reviewedAgents'), childConfig))
    }
    createAdfTool.onAutostartChild = async (childPath) => this.startCreatedChildAgent(childPath)
  }

  private async startCreatedChildAgent(childPath: string): Promise<boolean> {
    const canonicalPath = this.canonicalFilePath(childPath)
    const existingId = this.filePathToAgentId.get(canonicalPath)
    let managed = existingId ? this.requireAgent(existingId) : this.resolveAgent(childPath)
    if (!managed) {
      const ref = await this.loadAgent(canonicalPath, { enforceReviewGate: false })
      managed = this.requireAgent(ref.id)
    }
    return this.startAgent(managed.id)
  }

  private setIdentityValue(managed: ManagedRuntimeAgent, purpose: string, value: string): void {
    if (managed.agent.workspace.isPasswordProtected() && !managed.derivedKey) {
      throw new Error('Identity keystore is locked')
    }
    if (managed.derivedKey) {
      const { ciphertext, iv } = encrypt(Buffer.from(value, 'utf-8'), managed.derivedKey)
      const kdfParamsJson = managed.agent.workspace.getDatabase().getIdentity('crypto:kdf:params')
      managed.agent.workspace.getDatabase().setIdentityRaw(
        purpose,
        ciphertext,
        'aes-256-gcm',
        iv,
        kdfParamsJson,
      )
    } else {
      managed.agent.workspace.setIdentity(purpose, value)
    }
  }

  private readCredentialMap(managed: ManagedRuntimeAgent, prefix: string): Record<string, string> {
    const credentials: Record<string, string> = {}
    const purposes = managed.agent.workspace.listIdentityPurposes(prefix)
    for (const purpose of purposes) {
      const value = managed.agent.workspace.getIdentityDecrypted(purpose, managed.derivedKey)
      if (value !== null) credentials[purpose.slice(prefix.length)] = value
    }
    return credentials
  }

  private resolveAgent(identifier: string): ManagedRuntimeAgent | undefined {
    const byId = this.agents.get(identifier)
    if (byId) return byId
    for (const agent of this.agents.values()) {
      if (agent.config.handle === identifier || agent.config.name === identifier) return agent
    }
    return undefined
  }

  private toRef(managed: ManagedRuntimeAgent): RuntimeAgentRef {
    return {
      id: managed.id,
      filePath: managed.filePath,
      config: managed.config,
    }
  }

  private toSummary(managed: ManagedRuntimeAgent): RuntimeAgentSummary {
    return {
      id: managed.id,
      filePath: managed.filePath,
      name: managed.config.name,
      handle: managed.config.handle,
      autostart: managed.config.autostart ?? false,
    }
  }

  private toStatus(managed: ManagedRuntimeAgent): RuntimeAgentStatus {
    return {
      ...this.toSummary(managed),
      runtimeState: managed.agent.executor.getState(),
      targetState: managed.agent.executor.getLastTargetState(),
      loopCount: managed.agent.workspace.getLoopCount(),
    }
  }

  private async resolveProvider(config: AgentConfig, filePath: string, override?: LLMProvider): Promise<LLMProvider> {
    if (override) return override
    if (!this.providerFactory) {
      throw new Error('RuntimeService: loadAgent requires a provider or providerFactory.')
    }
    return this.providerFactory(config, filePath)
  }

  private async buildLoadedAgent(
    workspace: AdfWorkspace,
    filePath: string,
    config: AgentConfig,
    provider: LLMProvider,
  ): Promise<HeadlessAgent> {
    if (this.agentRuntimeBuilder) {
      return await this.agentRuntimeBuilder.build({
        workspace,
        filePath,
        config,
        provider,
        restoreLoop: true,
        createProviderForModel: (modelId: string) => {
          if (!this.providerFactory) return provider
          const resolved = this.providerFactory({ ...config, model: { ...config.model, model_id: modelId } }, filePath)
          if (isPromiseLike(resolved)) {
            throw new Error('RuntimeService: model_invoke providerFactory must be synchronous.')
          }
          return resolved
        },
      })
    }

    return createHeadlessAgentFromWorkspace(workspace, {
      provider,
      basePrompt: this.basePrompt,
      toolPrompts: this.toolPrompts,
      compactionPrompt: this.compactionPrompt,
      restoreLoop: true,
    })
  }

  private assertReviewGate(filePath: string, enforce: boolean): void {
    if (!enforce) return
    const boot = AdfDatabase.peekBootStatus(filePath)
    if (!boot) return

    if (!this.isFileConfigReviewed(filePath)) {
      throw new RuntimeReviewRequiredError(boot.agentId, filePath)
    }
  }

  private isFileConfigReviewed(filePath: string): boolean {
    const workspace = AdfWorkspace.open(filePath)
    try {
      const config = workspace.getAgentConfig() as AgentConfig
      return isConfigReviewed(this.settings?.get('reviewedAgents'), config)
    } finally {
      workspace.dispose()
    }
  }

  private collectAdfFiles(trackedDirs: string[], maxDepth: number): string[] {
    const seen = new Set<string>()
    const results: string[] = []

    const collect = (dir: string, depth: number): void => {
      if (depth > maxDepth) return
      let entries: Array<{ name: string; isFile(): boolean; isDirectory(): boolean }>
      try {
        entries = readdirSync(dir, { withFileTypes: true }) as Array<{ name: string; isFile(): boolean; isDirectory(): boolean }>
      } catch {
        return
      }

      for (const entry of entries) {
        const full = join(dir, entry.name)
        if (entry.isFile() && entry.name.endsWith('.adf')) {
          let resolved: string
          try { resolved = realpathSync(full) } catch { resolved = full }
          if (!seen.has(resolved)) {
            seen.add(resolved)
            results.push(resolved)
          }
        } else if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
          collect(full, depth + 1)
        }
      }
    }

    for (const dir of trackedDirs) collect(dir, 0)
    return results
  }

  private findAgentFile(identifier: string): string | null {
    if (identifier.endsWith('.adf') && existsSync(identifier)) {
      return this.canonicalFilePath(identifier)
    }

    const trackedDirs = asStringArray(this.settings?.get('trackedDirectories'))
    if (trackedDirs.length === 0) return null
    const maxDepthSetting = this.settings?.get('maxDirectoryScanDepth')
    const maxDepth = typeof maxDepthSetting === 'number' ? maxDepthSetting : 5
    const matches: Array<{ filePath: string; config: AgentConfig }> = []

    for (const filePath of this.collectAdfFiles(trackedDirs, maxDepth)) {
      const config = this.peekAgentConfig(filePath)
      if (config && matchesAgentIdentifier(config, identifier)) {
        matches.push({ filePath, config })
      }
    }

    if (matches.length > 1) {
      const details = matches
        .map(match => `${match.config.name}${match.config.handle ? ` (${match.config.handle})` : ''}: ${match.filePath}`)
        .join(', ')
      throw new Error(`RuntimeService: agent identifier "${identifier}" matched multiple files: ${details}`)
    }

    return matches[0]?.filePath ?? null
  }

  private peekAgentConfig(filePath: string): AgentConfig | null {
    let workspace: AdfWorkspace | null = null
    try {
      workspace = AdfWorkspace.open(filePath)
      return workspace.getAgentConfig() as AgentConfig
    } catch {
      return null
    } finally {
      workspace?.dispose()
    }
  }

  private canonicalFilePath(filePath: string): string {
    try { return realpathSync(filePath) } catch { return filePath }
  }
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.floor(value)))
}

function createUsageTotals(): RuntimeUsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
}

function addUsage(target: RuntimeUsageTotals, usage: LoopTokenUsage): void {
  target.input += usage.input ?? 0
  target.output += usage.output ?? 0
  target.cacheRead += usage.cache_read ?? 0
  target.cacheWrite += usage.cache_write ?? 0
  target.total = target.input + target.output + target.cacheRead + target.cacheWrite
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return !!value && typeof (value as { then?: unknown }).then === 'function'
}

function parseMaybeJson(value: string | undefined): unknown {
  if (value === undefined) return undefined
  try { return JSON.parse(value) } catch { return value }
}

async function buildTimerMutation(opts: RuntimeTimerMutationOptions): Promise<{ schedule: TimerSchedule; nextWakeAt: number }> {
  const now = Date.now()
  let schedule: TimerSchedule
  let nextWakeAt: number

  switch (opts.mode) {
    case 'once_at':
      if (!opts.at || opts.at <= now) throw new Error('Timestamp must be in the future')
      schedule = { mode: 'once', at: opts.at }
      nextWakeAt = opts.at
      break
    case 'once_delay':
      if (!opts.delay_ms || opts.delay_ms <= 0) throw new Error('Delay must be positive')
      schedule = { mode: 'once', at: now + opts.delay_ms }
      nextWakeAt = now + opts.delay_ms
      break
    case 'interval':
      if (!opts.every_ms || opts.every_ms <= 0) throw new Error('Interval must be positive')
      nextWakeAt = opts.start_at ?? (now + opts.every_ms)
      if (nextWakeAt <= now) throw new Error('start_at must be in the future')
      schedule = {
        mode: 'interval',
        every_ms: opts.every_ms,
        ...(opts.start_at ? { start_at: opts.start_at } : {}),
        ...(opts.end_at ? { end_at: opts.end_at } : {}),
        ...(opts.max_runs ? { max_runs: opts.max_runs } : {}),
      }
      break
    case 'cron': {
      if (!opts.cron) throw new Error('Cron expression required')
      const { CronExpressionParser } = await import('cron-parser')
      const interval = CronExpressionParser.parse(opts.cron, { currentDate: new Date(now) })
      nextWakeAt = interval.next().getTime()
      schedule = {
        mode: 'cron',
        cron: opts.cron,
        ...(opts.end_at ? { end_at: opts.end_at } : {}),
        ...(opts.max_runs ? { max_runs: opts.max_runs } : {}),
      }
      break
    }
    default:
      throw new Error('Invalid mode')
  }

  return { schedule, nextWakeAt }
}

function assertLocalTableName(table: string, allowAudit: boolean): void {
  const valid = /^local_[A-Za-z0-9_]+$/.test(table) || (allowAudit && table === 'adf_audit')
  if (!valid) throw new Error('Invalid table name')
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function matchesAgentIdentifier(config: AgentConfig, identifier: string): boolean {
  const normalized = identifier.toLowerCase()
  return config.id === identifier
    || config.id.toLowerCase() === normalized
    || config.name.toLowerCase() === normalized
    || (config.handle?.toLowerCase() === normalized)
}

function isTextLike(mimeType: string | null | undefined, path: string): boolean {
  const mime = (mimeType ?? '').toLowerCase()
  if (mime.startsWith('text/')) return true
  if (mime.includes('json') || mime.includes('xml') || mime.includes('javascript') || mime.includes('typescript')) return true
  return /\.(md|txt|json|jsonl|yaml|yml|toml|csv|ts|tsx|js|jsx|css|html|xml)$/i.test(path)
}
