import { EventEmitter } from 'node:events'
import { mcpConnectorFor } from './mcp-connectors'
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { basename, join } from 'node:path'
import { AdfDatabase } from '../adf/adf-database'
import { AdfWorkspace } from '../adf/adf-workspace'
import { resolveDefaultProvider } from '../adf/apply-default-provider'
import { templateFilePath } from '../adf/agent-templates'
import { canProvisionWorkspaceIdentity, ensureWorkspaceIdentity, unlockWorkspaceEnvelopes } from './identity-provisioner'
import { encrypt } from '../crypto/identity-crypto'
import { envelopeFromAlgo } from '../crypto/envelope-crypto'
import { buildConfigSummary, isConfigReviewed, markConfigReviewed } from '../services/agent-review'
import { withDeadline } from '../utils/concurrency'
import type { LLMProvider } from '../providers/provider.interface'
import { providerSelectionChanged } from '../providers/provider-selection'
import type {
  AgentConfig,
  AgentState as AdfAgentState,
  AdfProviderConfig,
  AdfLogEntry,
  FileProtectionLevel,
  InboxMessage,
  InboxStatus,
  LoopConfig,
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
import type { AgentConfigSummary, AgentExecutionEvent, ProviderConfig } from '../../shared/types/ipc.types'
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
import { CREDENTIALS_UNLOCK_HINT, detectLockedEnvelopes, type AgentRuntimeBuilder } from './agent-runtime-builder'
import type { AssembledAgentBase, HostAttachment } from './assemble-agent'
import { LoopPoolError, stripLoopNameMarker } from './loop-pool'
import { LOOP_AUTOSTART_MESSAGE, type LoopDeleteResult, type LoopInfo, type LoopSendResult } from '../adf/loop-pool.types'
import { LoopConfigSchema } from '../adf/adf-schema'
import { MAIN_LOOP, listAvailableLoopTools, validateLoopToolList } from '../adf/derive-loop-config'
import { DEFAULT_NEW_LOOP_TOOLS } from '../../shared/types/adf-v02.types'
import type { AgentProfileName } from './agent-capability-profiles'
import { RuntimeGate } from './runtime-gate'
import { withSource } from './execution-context'
import { emitUmbilicalEvent } from './emit-umbilical'
import { getUmbilicalReplayBuffer } from './umbilical-replay-buffer'
import { issueOwnerAttestation } from '../services/attestation.service'
import { mapWithConcurrency } from '../utils/concurrency'
import { buildToolDiscovery, type ToolDiscoveryEntry } from '../tools/built-in/sys-get-config.tool'

/** Max agents loading concurrently during autostart. */
const AUTOSTART_CONCURRENCY = 5

/** `degraded` text for an agent whose sealed envelopes this process cannot open. */
function lockedCredentialsReason(filePath: string, locked: string[]): string {
  return `daemon cannot unlock credentials for ${filePath} — sealed envelopes remain locked (${locked.join(', ')}). ` +
    `Envelope-sealed adapter/MCP credentials will resolve to null. ${CREDENTIALS_UNLOCK_HINT} ` +
    'Loaded agents re-check automatically once it is ready.'
}

/** MCP servers whose per-agent credentials live in the keystore (`mcp:<pkg|name>:*`). */
function mcpServersWithSealedCredentials(workspace: AdfWorkspace): string[] {
  try {
    const servers = workspace.getAgentConfig().mcp?.servers ?? []
    return servers
      .filter(server => [server.npm_package, server.pypi_package, server.name]
        .some(key => key && workspace.listIdentityPurposes(`mcp:${key}:`).length > 0))
      .map(server => server.name)
  } catch {
    return []
  }
}

/** Outcome of re-checking one degraded agent's sealed credentials. */
export interface RuntimeCredentialRefresh {
  agentId: string
  filePath: string | null
  /** True when every envelope is open now and `degraded` was cleared. */
  unlocked: boolean
  /** Envelopes still sealed (empty when unlocked). */
  stillLocked: string[]
  /** Channel adapters restarted with their real credentials. */
  adaptersRestarted: string[]
  /** MCP servers with sealed per-agent credentials that connected without them; restart the agent to reconnect them. */
  mcpRestartNeeded: string[]
}

/** One loop that left an auth `error` after a provider sign-in. */
export interface RuntimeAuthRecovery {
  agentId: string
  filePath: string | null
  loop: string
  notice: string
}

export interface RuntimeSettingsStore {
  get(key: string): unknown
  set?(key: string, value: unknown): void
  /** Present on the full SettingsService; headless/daemon stores may omit it. */
  getOwnerIdentity?(): {
    getOwnerDid(): string
    getRuntimeDid(): string
    getOwnerSigningKey(): Buffer | null
    getRuntimeSigningKey(): Buffer | null
  }
}

/**
 * The loaded file a provider is built for. Lets a factory honor the agent's
 * own `config.providers[]` entry and adf_identity key (resolveAgentProviderConfig)
 * — the same resolution Studio applies — instead of app settings alone.
 */
export interface RuntimeProviderContext {
  workspace: AdfWorkspace
  derivedKey: Buffer | null
}

export type RuntimeProviderFactory = (
  config: AgentConfig,
  filePath: string | null,
  context?: RuntimeProviderContext,
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
  /** Set when the agent loaded but cannot function fully (e.g. envelope-sealed credentials remain locked). */
  degraded?: string
}

export interface RuntimeAgentStartResult {
  ref: RuntimeAgentRef
  loaded: boolean
  startupTriggered: boolean
}

export interface RuntimeAgentLoopPage {
  agentId: string
  /** Cognition loop the page was read from (`main` when not requested). */
  loop: string
  total: number
  limit: number
  offset: number
  entries: LoopEntry[]
}

/** A caller-visible loop API failure; `statusCode` is the HTTP status to answer with. */
export class RuntimeLoopError extends Error {
  constructor(message: string, readonly statusCode: 400 | 404 | 409 | 502, readonly code?: string) {
    super(message)
    this.name = 'RuntimeLoopError'
  }
}

/**
 * What the owner may know about one stored identity value over HTTP: never
 * the value. `length` is null for key material (`crypto:*`) and for values
 * this process cannot read (locked).
 */
export interface RuntimeIdentityMeta {
  purpose: string
  present: boolean
  /** 'sealed' = envelope-encrypted, 'password' = whole-file password (legacy), null = absent. */
  storage: 'sealed' | 'plain' | 'password' | null
  sealed: boolean
  /** Stored but not readable in this process (envelope / password locked). */
  locked: boolean
  length: number | null
  code_access: boolean
}

/** Credential writes from the owner: `replace` discards a locked sealed value (see setIdentityValue). */
export interface RuntimeCredentialWriteOptions {
  replace?: boolean
}

/** 409 code of a credential write refused because its envelope is locked here. */
export const CREDENTIALS_LOCKED_CODE = 'credentials_locked'

/** One cognition loop as the owner sees it: live status plus its declaration. */
export interface RuntimeAgentLoopInfo extends LoopInfo {
  /** The side loop's declaration; `null` for main (its config is the agent's). */
  config: LoopConfig | null
  /** Rows in this loop's `adf_loop` stream. */
  entryCount: number
  /** Tools the loop's executor actually holds; `null` for main or a loop with no live runtime. */
  effectiveTools: string[] | null
}

/** Owner-supplied loop declaration; absent fields take the `loop_manage` defaults. */
export interface RuntimeLoopCreateInput {
  name: string
  goal: string
  enabled?: boolean
  autostart?: boolean
  autonomous?: boolean
  model?: LoopConfig['model']
  compact_threshold?: number | null
  tools?: string[]
}

/** `null` on `model` / `compact_threshold` removes the override (the loop inherits main's). */
export type RuntimeLoopPatch = Partial<Omit<LoopConfig, 'name' | 'model' | 'compact_threshold'>> & {
  model?: LoopConfig['model'] | null
  compact_threshold?: LoopConfig['compact_threshold'] | null
}

export interface RuntimeAgentAsk {
  requestId: string
  question: string
  /** The loop whose turn is waiting on the answer. */
  loop: string
}

export interface RuntimeLoopCreateResult {
  agentId: string
  loop: RuntimeAgentLoopInfo
  effectiveTools: string[]
  /** Requested tools the host has disabled: carried by name, not granted yet. */
  excludedTools: string[]
  /** The autostart kickoff, when one was sent. */
  kickoff: LoopSendResult | null
}

export interface RuntimeLoopUpdateResult {
  agentId: string
  loop: RuntimeAgentLoopInfo
  updated: string[]
  excludedTools: string[]
}

export interface RuntimeLoopDeleteResult extends LoopDeleteResult {
  agentId: string
  name: string
}

const LOOP_PATCH_FIELDS = ['goal', 'enabled', 'autostart', 'autonomous', 'model', 'compact_threshold', 'tools'] as const
const LOOP_CLEARABLE_FIELDS = new Set<string>(['model', 'compact_threshold'])

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

/** A task row as the owner API returns it. pending_approval rows carry the
 *  live "Always approve" affordance; the server re-checks on the call. */
export type RuntimeTaskEntry = TaskEntry & {
  canAlwaysApprove?: boolean
  alwaysApproveBlockedReason?: string
}

const NO_LIVE_APPROVAL_REASON = 'No live approval request is waiting on this task (approve or deny it instead)'

/** Display states an agent can be moved to (adf-v02 `AGENT_STATES`). */
export type AdfDisplayState = AdfAgentState

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
  /** Cognition loop an agent-scope wake dispatches to. Create only; absent = main. */
  loop?: string
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
  agent: RuntimeAgent
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

type RuntimeAgent = HeadlessAgent | AssembledAgentBase<AgentProfileName>

interface ManagedRuntimeAgent {
  id: string
  filePath: string | null
  config: AgentConfig
  agent: RuntimeAgent
  hostAttachment: HostAttachment
  derivedKey: Buffer | null
  /** Reason the agent is degraded (e.g. locked credential envelopes), if any. */
  degraded?: string
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
  /**
   * In-flight loads keyed by canonical (realpath) file path. Claimed
   * synchronously at the top of loadAgent so concurrent callers (boot scan,
   * watcher, API, child autostart) await the same load instead of building
   * two full agent instances for one file.
   */
  private readonly inFlightLoads = new Map<string, Promise<RuntimeAgentRef>>()

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

    // Double-start TOCTOU guard: claim an in-flight slot SYNCHRONOUSLY before
    // any await so concurrent loads of the same file converge on one build.
    const pending = this.inFlightLoads.get(canonicalPath)
    if (pending) return pending

    const load = this.doLoadAgent(canonicalPath, opts)
    this.inFlightLoads.set(canonicalPath, load)
    try {
      return await load
    } finally {
      this.inFlightLoads.delete(canonicalPath)
    }
  }

  private async doLoadAgent(canonicalPath: string, opts: RuntimeLoadAgentOptions): Promise<RuntimeAgentRef> {
    const shouldEnforceReview = opts.enforceReviewGate ?? this.enforceReviewGate
    this.assertReviewGate(canonicalPath, shouldEnforceReview)

    const workspace = AdfWorkspace.open(canonicalPath)
    try {
      // Unlock envelope-sealed keys/credentials for this workspace instance (spec D10)
      unlockWorkspaceEnvelopes(workspace)
      // B1 interim hardening: in the daemon the identity hooks may never have
      // been registered, making the unlock a silent no-op. Detect envelopes
      // that remain sealed so the agent is loudly marked degraded instead of
      // starting adapters/MCP with credentials that resolve to null.
      const lockedEnvelopes = detectLockedEnvelopes(workspace)
      const degradedReason = lockedEnvelopes.length > 0
        ? lockedCredentialsReason(canonicalPath, lockedEnvelopes)
        : null
      if (degradedReason) {
        console.error(`[RuntimeService] ${degradedReason}`)
        try { workspace.insertLog('error', 'runtime', 'credentials_locked', null, degradedReason.slice(0, 500)) } catch { /* non-fatal */ }
      }
      const config = workspace.getAgentConfig() as AgentConfig
      const provider = await this.resolveProvider(config, canonicalPath, opts.provider, workspace)
      const agent = await this.buildLoadedAgent(workspace, canonicalPath, config, provider)
      const ref = this.registerAgent(agent, canonicalPath, config)
      if (degradedReason) {
        const managed = this.resolveAgent(ref.id)
        if (managed) managed.degraded = degradedReason
        const degradedEvent = {
          type: 'error' as const,
          payload: { error: degradedReason, code: 'CREDENTIALS_LOCKED' },
          timestamp: Date.now(),
        }
        this.emit('agent-event', {
          agentId: ref.id,
          filePath: canonicalPath,
          event: degradedEvent,
        } satisfies RuntimeAgentEvent)
        // The daemon no longer forwards raw runtime events onto the umbilical
        // (`agent.event` is retired). This synthetic error has no executor
        // counterpart, so it publishes the typed `agent.error` directly.
        withSource('system:lifecycle', ref.id, () => {
          emitUmbilicalEvent({
            event_type: 'agent.error',
            agentId: ref.id,
            timestamp: degradedEvent.timestamp,
            payload: { filePath: canonicalPath, event: degradedEvent },
          })
        })
      }
      return ref
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

  async unloadAgent(agentId: string, opts: { mode?: 'graceful' | 'immediate' } = {}): Promise<void> {
    const managed = this.resolveAgent(agentId)
    if (!managed) return
    managed.hostAttachment.detach()
    if (managed.agent.disposeAsync) await managed.agent.disposeAsync({ mode: opts.mode ?? 'graceful' })
    else managed.agent.dispose()
    this.agents.delete(managed.id)
    if (managed.filePath) this.filePathToAgentId.delete(managed.filePath)
    // Emit only after dispose settles: consumers (e.g. the daemon's sweep
    // skip-set) treat this event as "the workspace is closed" — emitting
    // before dispose let them touch a workspace that was still open.
    this.emit('agent-unloaded', {
      agentId: managed.id,
      filePath: managed.filePath,
    } satisfies RuntimeAgentUnloadedEvent)
  }

  /**
   * Shutdown-facing stop: permanently closes the runtime gate (resume()
   * becomes a no-op until process exit), waits for in-flight loads to settle
   * so no agent finishes starting behind the teardown's back, then unloads
   * every registered agent. Per-agent failures are logged, never thrown.
   *
   * `agentTimeoutMs` bounds each unload (daemon shutdown semantics): a wedged
   * agent is abandoned after the deadline so shutdown always completes.
   */
  async shutdownAll(opts: { mode?: 'graceful' | 'immediate'; agentTimeoutMs?: number } = {}): Promise<void> {
    RuntimeGate.beginTeardown()
    // In-flight loads observe the teardown flag in registerAgent and dispose
    // themselves; await them so their teardown completes inside shutdown.
    await Promise.allSettled(Array.from(this.inFlightLoads.values()))
    const mode = opts.mode ?? 'immediate'
    await Promise.all(
      Array.from(this.agents.keys()).map(async (agentId) => {
        try {
          const unload = this.unloadAgent(agentId, { mode })
          if (opts.agentTimeoutMs != null) {
            await withDeadline(unload, opts.agentTimeoutMs, () => {
              console.error(`[RuntimeService] Timed out unloading agent ${agentId} after ${opts.agentTimeoutMs}ms — continuing shutdown`)
            })
          } else {
            await unload
          }
        } catch (err) {
          console.error(`[RuntimeService] Failed to unload agent ${agentId}:`, err)
        }
      }),
    )
  }

  /**
   * Re-run the envelope unlock (the same hook the load path uses) for every
   * loaded agent that is `degraded` on sealed credentials. Called when the
   * owner identity becomes ready and on the daemon's periodic re-check, so an
   * agent loaded before `adf identity restore/unlock` (or before Studio added
   * a slot) recovers without a reload. The unlock is synchronous DB work on
   * the agent's root workspace — no loop rows are touched, so it cannot
   * interleave with a turn. Each cleared agent is logged (console + adf_logs)
   * and announced as `agent.credentials.unlocked`; locked-credentials stub
   * adapters are restarted with the real factory; MCP servers that connected
   * without their sealed env are reported as needing an agent restart.
   */
  async refreshAgentCredentials(reason: string): Promise<RuntimeCredentialRefresh[]> {
    const results: RuntimeCredentialRefresh[] = []
    for (const managed of Array.from(this.agents.values())) {
      if (!managed.degraded || this.agents.get(managed.id) !== managed) continue
      const workspace = managed.agent.workspace
      const label = managed.filePath ?? managed.id
      unlockWorkspaceEnvelopes(workspace)
      const stillLocked = detectLockedEnvelopes(workspace)
      if (stillLocked.length > 0) {
        const next = lockedCredentialsReason(label, stillLocked)
        if (next !== managed.degraded) {
          managed.degraded = next
          console.warn(`[RuntimeService] ${next}`)
          try { workspace.insertLog('warn', 'runtime', 'credentials_locked', null, next.slice(0, 500)) } catch { /* non-fatal */ }
        }
        results.push({ agentId: managed.id, filePath: managed.filePath, unlocked: false, stillLocked, adaptersRestarted: [], mcpRestartNeeded: [] })
        continue
      }

      managed.degraded = undefined
      // Values the owner stored (or replaced) while locked were written
      // plain: seal them now that the envelope is open (Studio parity with
      // ensureWorkspaceIdentity's migration pass).
      try {
        const sealed = workspace.sealPlainRowsIntoEnvelopes()
        if (sealed > 0) console.log(`[RuntimeService] Sealed ${sealed} credential(s) stored while ${label} was locked`)
      } catch (err) {
        console.error(`[RuntimeService] Sealing plain credentials failed for ${label}:`, err)
      }
      let adaptersRestarted: string[] = []
      const adapterManager = managed.agent.adapterManager
      if (this.agentRuntimeBuilder && adapterManager) {
        try {
          adaptersRestarted = await this.agentRuntimeBuilder.restartLockedAdapters(adapterManager, workspace)
        } catch (err) {
          console.error(`[RuntimeService] Adapter restart after credential unlock failed for ${label}:`, err)
        }
      }
      const mcpRestartNeeded = mcpServersWithSealedCredentials(workspace)
      const message = `Credentials unlocked for ${managed.config.name} (${reason}); degraded cleared.` +
        (adaptersRestarted.length ? ` Restarted adapters: ${adaptersRestarted.join(', ')}.` : '') +
        (mcpRestartNeeded.length
          ? ` MCP servers ${mcpRestartNeeded.join(', ')} connected without their sealed credentials — restart the agent to reconnect them.`
          : '')
      console.log(`[RuntimeService] ${message}`)
      try { workspace.insertLog('info', 'runtime', 'credentials_unlocked', null, message.slice(0, 500)) } catch { /* non-fatal */ }
      withSource('system:lifecycle', managed.id, () => {
        emitUmbilicalEvent({
          event_type: 'agent.credentials.unlocked',
          agentId: managed.id,
          payload: { filePath: managed.filePath, reason, adaptersRestarted, mcpRestartNeeded, message },
        })
      })
      results.push({ agentId: managed.id, filePath: managed.filePath, unlocked: true, stillLocked: [], adaptersRestarted, mcpRestartNeeded })
    }
    return results
  }

  /** True when any loaded agent is degraded on sealed credentials. */
  hasDegradedAgents(): boolean {
    for (const managed of this.agents.values()) if (managed.degraded) return true
    return false
  }

  /**
   * A subscription sign-in completed: every loop (main + side) of every
   * loaded agent that sits in `error` on an auth failure from a provider of
   * `providerType` leaves it via the executor's own exit (setState('idle')).
   * No turn is re-run; the next trigger works normally. Other error reasons
   * and other provider types are left alone. Each recovery is logged and
   * announced (`agent.recovered`).
   */
  recoverAuthErroredAgents(providerType: string, signInLabel: string): RuntimeAuthRecovery[] {
    const recovered: RuntimeAuthRecovery[] = []
    const notice = `recovered after ${signInLabel} sign-in`
    for (const managed of this.agents.values()) {
      const executors: Array<{ loop: string; executor: RuntimeAgent['executor'] }> = [
        { loop: MAIN_LOOP, executor: managed.agent.executor },
        ...managed.agent.loopPool.getRuntimes().map(runtime => ({ loop: runtime.name, executor: runtime.executor })),
      ]
      for (const { loop, executor } of executors) {
        if (executor.getErrorReason() !== 'auth') continue
        if (executor.getProvider()?.providerType !== providerType) continue
        const loopNotice = `${managed.config.name}${loop === MAIN_LOOP ? '' : ` (loop ${loop})`} ${notice}`
        const ok = withSource('system:lifecycle', managed.id, () => executor.recoverFromAuthError(loopNotice))
        if (!ok) continue
        console.log(`[RuntimeService] ${loopNotice}`)
        recovered.push({ agentId: managed.id, filePath: managed.filePath, loop, notice: loopNotice })
      }
    }
    return recovered
  }

  /**
   * Run a dispatch on one of this agent's cognition loops. `loop` (or the
   * dispatch's own `loop`) selects the executor; absent means main, so every
   * pre-loops caller is unchanged. Rejects when the loop is unknown or
   * disabled: this path serves a request, and a request gets an answer.
   */
  async trigger(agentId: string, dispatch: AdfEventDispatch | AdfBatchDispatch, loop?: string): Promise<void> {
    await this.requireAgent(agentId).agent.dispatchTo(loop, dispatch)
  }

  async sendChat(agentId: string, text: string, loop = 'main'): Promise<void> {
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
      loop,
    )
  }

  async startAgent(agentId: string): Promise<boolean> {
    RuntimeGate.resume()
    const managed = this.requireAgent(agentId)
    // Studio parity: dispatch the startup turn fire-and-forget instead of
    // blocking the caller on the agent's entire first LLM turn
    // (BackgroundAgentManager fires it via process.nextTick and does not await).
    const startup = managed.agent.dispatchStartup()
    startup.catch((err) => {
      console.error(`[RuntimeService] Startup turn error for ${managed.id}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
    })
    // dispatchStartup resolves false within microtasks when no startup turn is
    // needed; when a turn dispatches it resolves only after the whole turn
    // completes. Race against a macrotask: still-pending means a startup turn
    // was accepted and is running in the background.
    const raced = await Promise.race([
      startup.then(
        (dispatched) => ({ status: 'resolved' as const, dispatched }),
        (err) => ({ status: 'rejected' as const, err }),
      ),
      new Promise<{ status: 'pending' }>((resolve) => setImmediate(() => resolve({ status: 'pending' }))),
    ])
    if (raced.status === 'rejected') throw raced.err
    return raced.status === 'resolved' ? raced.dispatched : true
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

  /** Abort the current turn of one loop (default main) without unloading. */
  async abortAgent(agentId: string, loop?: string): Promise<void> {
    const managed = this.requireAgent(agentId)
    const loopName = this.requireLoopName(managed, loop)
    if (loopName === MAIN_LOOP) {
      managed.agent.executor.abort()
      return
    }
    const runtime = managed.agent.loopPool.getRuntime(loopName)
    if (!runtime) throw new RuntimeLoopError(`Loop "${loopName}" has no running executor (it is disabled or stopping).`, 409)
    runtime.executor.abort()
  }

  /**
   * Interrupt one loop's running turn (default main) and leave its executor
   * idle and still accepting work — Studio's fleet-map teardown. Unlike
   * abortAgent this never stops the executor. No-op when nothing is running.
   */
  interruptAgent(agentId: string, loop?: string): { interrupted: boolean; loop: string } {
    const managed = this.requireAgent(agentId)
    const loopName = this.requireLoopName(managed, loop)
    const executor = loopName === MAIN_LOOP
      ? managed.agent.executor
      : managed.agent.loopPool.getRuntime(loopName)?.executor
    if (!executor) throw new RuntimeLoopError(`Loop "${loopName}" has no running executor (it is disabled or stopping).`, 409)
    const state = executor.getState()
    if (state === 'stopped' || state === 'error') throw new RuntimeLoopError(`Cannot interrupt: loop "${loopName}" is ${state}.`, 409)
    if (!executor.isTurnActive()) return { interrupted: false, loop: loopName }
    executor.endTurnAndSetState('idle')
    return { interrupted: true, loop: loopName }
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

    type AutostartOutcome =
      | { kind: 'started'; entry: RuntimeAutostartStarted }
      | { kind: 'skipped'; entry: RuntimeAutostartSkipped }
      | { kind: 'failed'; entry: RuntimeAutostartFailed }

    const evaluate = async (filePath: string): Promise<AutostartOutcome> => {
      const name = basename(filePath, '.adf')

      if (this.filePathToAgentId.has(filePath)) {
        return {
          kind: 'skipped',
          entry: { filePath, name, reason: 'already_loaded', agentId: this.filePathToAgentId.get(filePath) },
        }
      }

      const bootResult = AdfDatabase.peekBootStatusDetailed(filePath)
      const boot = bootResult.status
      if (!boot) {
        return {
          kind: 'failed',
          entry: {
            filePath,
            name,
            error: bootResult.error
              ? `Unable to read ADF boot status: ${bootResult.error}`
              : 'Unable to read ADF boot status.',
          },
        }
      }

      if (!boot.autostart) {
        return { kind: 'skipped', entry: { filePath, name, reason: 'not_autostart', agentId: boot.agentId } }
      }

      if (boot.hasEncryptedIdentity) {
        return { kind: 'skipped', entry: { filePath, name, reason: 'password_protected', agentId: boot.agentId } }
      }

      // Review check happens exactly once, from the config the boot peek
      // already parsed in the same readonly open.
      const reviewed = isConfigReviewed(this.settings?.get('reviewedAgents'), bootResult.config)
      if (!reviewed) {
        return { kind: 'skipped', entry: { filePath, name, reason: 'unreviewed', agentId: boot.agentId } }
      }

      try {
        // Review verified above — disable loadAgent's own gate so the file is
        // opened exactly once more (the real open): 2 opens per candidate.
        const ref = await this.loadAgent(filePath, { enforceReviewGate: false })
        // startAgent dispatches the startup turn fire-and-forget, so the
        // report is emitted once loads complete — not after first LLM turns.
        const startupTriggered = await this.startAgent(ref.id)
        return { kind: 'started', entry: { agentId: ref.id, filePath, name: ref.config.name, startupTriggered } }
      } catch (err) {
        if (err instanceof RuntimeReviewRequiredError) {
          return { kind: 'skipped', entry: { filePath, name, reason: 'unreviewed', agentId: err.agentId } }
        }
        return {
          kind: 'failed',
          entry: { filePath, name, error: err instanceof Error ? err.message : String(err) },
        }
      }
    }

    // Bounded parallel start — serial per-agent I/O was the dominant cost of
    // daemon boot. Result order matches file order, so report order is stable.
    const results = await mapWithConcurrency(files, AUTOSTART_CONCURRENCY, evaluate)
    for (let i = 0; i < results.length; i++) {
      const result = results[i]
      const outcome: AutostartOutcome = result.status === 'fulfilled'
        ? result.value
        : {
            kind: 'failed',
            entry: {
              filePath: files[i],
              name: basename(files[i], '.adf'),
              error: result.reason instanceof Error ? result.reason.message : String(result.reason),
            },
          }
      if (outcome.kind === 'started') report.started.push(outcome.entry)
      else if (outcome.kind === 'skipped') report.skipped.push(outcome.entry)
      else report.failed.push(outcome.entry)
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

  getAgentLoop(agentId: string, opts: { limit?: number; offset?: number; loop?: string } = {}): RuntimeAgentLoopPage {
    const managed = this.requireAgent(agentId)
    const loop = this.requireLoopName(managed, opts.loop)
    const workspace = managed.agent.workspace.forLoop(loop)
    const total = workspace.getLoopCount()
    const limit = clampInteger(opts.limit ?? 50, 1, 500)
    const offset = opts.offset === undefined
      ? Math.max(0, total - limit)
      : clampInteger(opts.offset, 0, Math.max(0, total))
    const entries = workspace.getLoopPaginated(limit, offset)
    return { agentId: managed.id, loop, total, limit, offset, entries }
  }

  // --- Cognition loops (docs/design/agent-loops-mvp.md) ----------------------
  //
  // Every mutation goes through the agent's LoopPool — the one path that
  // validates, attenuates, persists and archives — never through a raw config
  // write. Validation mirrors `loop_manage` so the owner gets the same rules
  // (and the same sentences) the agent does.

  listAgentLoops(agentId: string): { agentId: string; loops: RuntimeAgentLoopInfo[] } {
    const managed = this.requireAgent(agentId)
    return {
      agentId: managed.id,
      loops: managed.agent.loopPool.listLoops().map(info => this.toLoopInfo(managed, info)),
    }
  }

  getAgentLoopInfo(agentId: string, name: string): RuntimeAgentLoopInfo {
    const managed = this.requireAgent(agentId)
    const loop = this.requireLoopName(managed, name)
    return this.loopInfoByName(managed, loop)
  }

  async createAgentLoop(agentId: string, input: RuntimeLoopCreateInput): Promise<RuntimeLoopCreateResult> {
    const managed = this.requireAgent(agentId)
    const pool = managed.agent.loopPool
    if (!input || typeof input.name !== 'string') throw new RuntimeLoopError('name is required', 400)
    if (input.name === MAIN_LOOP) throw new RuntimeLoopError('"main" is the implicit host loop and cannot be created.', 409)
    if (pool.hasLoop(input.name)) throw new RuntimeLoopError(`A loop named "${input.name}" already exists.`, 409)
    const host = managed.agent.workspace.getAgentConfig()
    const available = new Set(listAvailableLoopTools(host))
    const candidate = {
      name: input.name,
      goal: input.goal,
      enabled: input.enabled ?? true,
      autostart: input.autostart ?? true,
      ...(input.autonomous !== undefined ? { autonomous: input.autonomous } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.compact_threshold !== undefined ? { compact_threshold: input.compact_threshold } : {}),
      tools: input.tools ?? DEFAULT_NEW_LOOP_TOOLS.filter(name => available.has(name)),
    }
    const { config, disabled } = this.validateLoopDeclaration(host, candidate)
    const created = await this.withLoopErrors(() => pool.createLoop(config))
    managed.config = managed.agent.workspace.getAgentConfig()

    let kickoff: LoopSendResult | null = null
    if (config.enabled && config.autostart) {
      kickoff = await this.withLoopErrors(() => pool.sendToLoop(MAIN_LOOP, config.name, LOOP_AUTOSTART_MESSAGE, true))
    }
    return {
      agentId: managed.id,
      loop: this.loopInfoByName(managed, config.name),
      effectiveTools: created.effectiveTools,
      excludedTools: disabled,
      kickoff,
    }
  }

  async updateAgentLoop(agentId: string, name: string, patch: RuntimeLoopPatch): Promise<RuntimeLoopUpdateResult> {
    const managed = this.requireAgent(agentId)
    const pool = managed.agent.loopPool
    if (name === MAIN_LOOP) {
      throw new RuntimeLoopError('main is the implicit host loop — change its instructions, model or tools through the agent config.', 409)
    }
    const existing = pool.getLoop(name)
    if (!existing) throw new RuntimeLoopError(`No inner loop named "${name}".`, 404)
    const incoming = (patch ?? {}) as Record<string, unknown>
    if (typeof incoming.name === 'string' && incoming.name !== name) {
      throw new RuntimeLoopError('Loops cannot be renamed — the name binds the executor to its stream.', 400)
    }
    const outgoing: Record<string, unknown> = {}
    const cleared: string[] = []
    for (const field of LOOP_PATCH_FIELDS) {
      if (incoming[field] === null && LOOP_CLEARABLE_FIELDS.has(field)) cleared.push(field)
      else if (incoming[field] !== undefined) outgoing[field] = incoming[field]
    }
    const updated = [...Object.keys(outgoing), ...cleared]
    if (updated.length === 0) {
      throw new RuntimeLoopError(`Nothing to update — name at least one of: ${LOOP_PATCH_FIELDS.join(', ')}.`, 400)
    }
    const host = managed.agent.workspace.getAgentConfig()
    const candidate: Record<string, unknown> = { ...existing, ...outgoing, name }
    for (const field of cleared) delete candidate[field]
    const { config, disabled } = this.validateLoopDeclaration(host, candidate)
    const validated = config as unknown as Record<string, unknown>
    const validatedPatch: Record<string, unknown> = {}
    for (const field of updated) validatedPatch[field] = validated[field]
    await this.withLoopErrors(() => pool.updateLoop(name, validatedPatch as Partial<LoopConfig>))
    managed.config = managed.agent.workspace.getAgentConfig()
    return { agentId: managed.id, loop: this.loopInfoByName(managed, name), updated, excludedTools: disabled }
  }

  async deleteAgentLoop(agentId: string, name: string): Promise<RuntimeLoopDeleteResult> {
    const managed = this.requireAgent(agentId)
    const pool = managed.agent.loopPool
    if (name === MAIN_LOOP) throw new RuntimeLoopError('main is the agent itself and cannot be deleted.', 409)
    if (!pool.getLoop(name)) throw new RuntimeLoopError(`No inner loop named "${name}".`, 404)
    const result = await this.withLoopErrors(() => pool.deleteLoop(name))
    managed.config = managed.agent.workspace.getAgentConfig()
    return { agentId: managed.id, name, ...result }
  }

  private requireLoopName(managed: ManagedRuntimeAgent, loop: string | undefined): string {
    const name = loop || MAIN_LOOP
    if (!managed.agent.loopPool.hasLoop(name)) {
      throw new RuntimeLoopError(`No loop named "${name}" on this agent.`, 404)
    }
    return name
  }

  private loopInfoByName(managed: ManagedRuntimeAgent, name: string): RuntimeAgentLoopInfo {
    const info = managed.agent.loopPool.listLoops().find(l => l.name === name)
    if (!info) throw new RuntimeLoopError(`No loop named "${name}" on this agent.`, 404)
    return this.toLoopInfo(managed, info)
  }

  private toLoopInfo(managed: ManagedRuntimeAgent, info: LoopInfo): RuntimeAgentLoopInfo {
    const pool = managed.agent.loopPool
    const runtime = info.isMain ? undefined : pool.getRuntime(info.name)
    return {
      ...info,
      config: info.isMain ? null : pool.getLoop(info.name) ?? null,
      entryCount: managed.agent.workspace.forLoop(info.name).getLoopCount(),
      effectiveTools: runtime ? runtime.derived.tools.filter(t => t.enabled).map(t => t.name) : null,
    }
  }

  /** `loop_manage`'s validation: schema, then the host-relative tool check. */
  private validateLoopDeclaration(host: AgentConfig, candidate: Record<string, unknown>): { config: LoopConfig; disabled: string[] } {
    const parsed = LoopConfigSchema.safeParse(candidate)
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ')
      throw new RuntimeLoopError(`Invalid loop config — ${issues}`, 400)
    }
    const config = parsed.data as unknown as LoopConfig
    const requested = config.tools ?? []
    if (requested.length === 0) return { config, disabled: [] }
    const { unknown, disabled, prohibited } = validateLoopToolList(host, requested)
    if (unknown.length > 0 || prohibited.length > 0) {
      const parts: string[] = []
      if (unknown.length > 0) parts.push(`no such tool on this agent: ${unknown.join(', ')}`)
      if (prohibited.length > 0) parts.push(`never grantable to a loop: ${prohibited.join(', ')}`)
      throw new RuntimeLoopError(
        `Cannot grant those tools — ${parts.join('; ')}. Available: ${listAvailableLoopTools(host).join(', ') || '(none)'}.`,
        400,
      )
    }
    return { config, disabled }
  }

  /** Pool refusals are deliberate, caller-safe sentences: answer them as conflicts. */
  private async withLoopErrors<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (err) {
      if (err instanceof LoopPoolError) throw new RuntimeLoopError(err.message, 409)
      throw err
    }
  }

  getAgentConfig(agentId: string): { agentId: string; config: AgentConfig } {
    const managed = this.requireAgent(agentId)
    return { agentId: managed.id, config: managed.config }
  }

  async setAgentConfig(agentId: string, config: AgentConfig): Promise<{ agentId: string; success: true; config: AgentConfig }> {
    const managed = this.requireAgent(agentId)
    const previousConfig = managed.config
    // Derived-config-only marker: strip before the save, so an imported .adf
    // cannot persist one that binds main's executor to a side loop's guards.
    stripLoopNameMarker(config)
    managed.agent.workspace.setAgentConfig(config)
    managed.config = config
    // The assembled agent's single config-change choke point — re-derives every
    // side loop, reconciles the pool, refreshes the pool's raw-config snapshot
    // and re-syncs main's loop tool registration. The hand-rolled
    // executor/evaluator/handler fan-out this replaces did none of those, so a
    // headless config save left side loops running on revoked grants and the
    // next loop_manage write reverted the save (review C2).
    managed.agent.applyConfigChange(config)

    if (providerSelectionChanged(previousConfig, config) && this.providerFactory) {
      const provider = await this.providerFactory(config, managed.filePath, {
        workspace: managed.agent.workspace,
        derivedKey: managed.derivedKey,
      })
      managed.agent.executor.updateProvider(provider)
    }

    return { agentId: managed.id, success: true, config }
  }

  /**
   * The agent's tool catalog: every built-in tool main's registry holds, every
   * MCP tool its servers advertise, and every declared tool, each with its
   * declared state (enabled / visible / restricted / locked), source and
   * description. The same list `sys_get_config` gives the agent (read-only;
   * change tools with PUT /config).
   */
  getAgentTools(agentId: string): { agentId: string; tools: ToolDiscoveryEntry[] } {
    const managed = this.requireAgent(agentId)
    return { agentId: managed.id, tools: buildToolDiscovery(managed.config, managed.agent.registry ?? null) }
  }

  /**
   * Set the agent's display state (same surface as the fleet map's state set).
   *
   * Always routed through the executor so the normal `state_changed` event
   * fires — that event is what syncs `TriggerEvaluator.setDisplayState`, so
   * the evaluator remains the single owner of wake behavior. `idle` /
   * `hibernate` use `endTurnAndSetState` (mid-turn teardown, same as the fleet
   * map); the rest use the generic deferred transition, which is also what
   * gives `off` its hard-abort semantics.
   *
   * The state is not persisted into the .adf config; it mirrors the live
   * fleet-map semantics (IPC MESH_SET_AGENT_STATE).
   */
  setAgentDisplayState(agentId: string, state: AdfDisplayState): { agentId: string; success: true; state: AdfDisplayState } {
    const managed = this.requireAgent(agentId)
    const executorState = managed.agent.executor.getState()
    if (executorState === 'stopped' || executorState === 'error') {
      throw new Error(`Cannot set state while agent is "${executorState}"`)
    }
    if (state === 'idle' || state === 'hibernate') {
      managed.agent.executor.endTurnAndSetState(state)
    } else {
      managed.agent.executor.applyDeferredStateTransition(state)
    }
    return { agentId: managed.id, success: true, state }
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

  getAgentChat(agentId: string, limit = 200, loop?: string): { agentId: string; loop: string; chatHistory: { version: number; uiLog: unknown[]; llmMessages: unknown[]; total: number; earlierCount: number } | null } {
    const managed = this.requireAgent(agentId)
    const loopName = this.requireLoopName(managed, loop)
    const workspace = managed.agent.workspace.forLoop(loopName)
    const total = workspace.getLoopCount()
    if (total === 0) return { agentId: managed.id, loop: loopName, chatHistory: null }
    const clampedLimit = clampInteger(limit, 1, 500)
    const offset = Math.max(0, total - clampedLimit)
    const loopEntries = offset > 0
      ? workspace.getLoopPaginated(clampedLimit, offset)
      : workspace.getLoop()
    return {
      agentId: managed.id,
      loop: loopName,
      chatHistory: {
        version: 1,
        uiLog: parseLoopToDisplay(loopEntries),
        llmMessages: [],
        // Truncation must be detectable by remote clients — a silent tail
        // window is indistinguishable from a cleared loop.
        total,
        earlierCount: offset,
      },
    }
  }

  async clearAgentChat(agentId: string, loop?: string): Promise<{ agentId: string; loop: string; success: true }> {
    const managed = this.requireAgent(agentId)
    const loopName = this.requireLoopName(managed, loop)
    if (loopName !== MAIN_LOOP) {
      // Same reset Studio's clear does for an inner-loop tab (IPC DOC_CLEAR_CHAT).
      const runtime = managed.agent.loopPool.getRuntime(loopName)
      await managed.agent.workspace.forLoop(loopName).clearLoop({
        onCommitted: () => {
          runtime?.session.reset()
          runtime?.executor.resetContextState()
        }
      })
      return { agentId: managed.id, loop: loopName, success: true }
    }
    // The session reset rides the clear's onCommitted hook: it runs in the same
    // tick as the loop-table COMMIT, so a turn dispatched while clearLoop was
    // awaiting its backup/compression cannot land between the wipe and the
    // reset (which would truncate a live turn mid-flight).
    await managed.agent.workspace.clearLoop({
      onCommitted: () => {
        managed.agent.session.reset()
        // Same reset the Studio clear (ipc) and mesh resetAgentSession do:
        // without it the injected-file snapshot and context dedup hashes
        // survive the wipe and the cleared loop never re-receives mind/soul/
        // README context.
        managed.agent.executor.resetContextState()
      }
    })
    return { agentId: managed.id, loop: MAIN_LOOP, success: true }
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
    if (opts.contentBase64 !== undefined) {
      withSource('system:runtime-api', managed.id, () => {
        managed.agent.workspace.writeFileBuffer(path, Buffer.from(opts.contentBase64!, 'base64'), opts.mimeType)
      })
    } else {
      const content = opts.content ?? ''
      withSource('system:runtime-api', managed.id, () => {
        managed.agent.workspace.writeFile(path, content, opts.protection)
      })
    }
    return { agentId: managed.id, success: true }
  }

  deleteAgentFile(agentId: string, path: string): { agentId: string; success: boolean } {
    const managed = this.requireAgent(agentId)
    return {
      agentId: managed.id,
      success: withSource('system:runtime-api', managed.id, () => managed.agent.workspace.deleteFile(path)),
    }
  }

  renameAgentFile(agentId: string, oldPath: string, newPath: string): { agentId: string; success: boolean } {
    const managed = this.requireAgent(agentId)
    return {
      agentId: managed.id,
      success: withSource('system:runtime-api', managed.id, () => managed.agent.workspace.renameInternalFile(oldPath, newPath)),
    }
  }

  renameAgentFolder(agentId: string, oldPrefix: string, newPrefix: string): { agentId: string; success: true; count: number } {
    const managed = this.requireAgent(agentId)
    const count = withSource('system:runtime-api', managed.id, () => managed.agent.workspace.renameFolder(oldPrefix, newPrefix))
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
    // Absent = main. An unknown loop would persist a timer that fires into a
    // stream that does not exist (same rule as Studio's timer add).
    const loop = opts.loop ? this.requireLoopName(managed, opts.loop) : undefined
    const timer = await buildTimerMutation(opts)
    const id = managed.agent.workspace.addTimer(timer.schedule, timer.nextWakeAt, opts.payload, opts.scope ?? ['agent'], opts.lambda, opts.warm, opts.locked, loop)
    return { agentId: managed.id, success: true, id }
  }

  async updateAgentTimer(agentId: string, opts: RuntimeTimerMutationOptions & { id: number }): Promise<{ agentId: string; success: boolean }> {
    const managed = this.requireAgent(agentId)
    // `loop` present = move the timer to that loop (main = the default, stored as none).
    const loop = opts.loop !== undefined ? this.requireLoopName(managed, opts.loop) : undefined
    const timer = await buildTimerMutation(opts)
    const success = managed.agent.workspace.updateTimer(opts.id, timer.schedule, timer.nextWakeAt, opts.payload, opts.scope ?? ['agent'], opts.lambda, opts.warm, opts.locked)
    if (success && loop !== undefined) managed.agent.workspace.setTimerLoop(opts.id, loop === MAIN_LOOP ? null : loop)
    return { agentId: managed.id, success }
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
      note: 'Sums token usage persisted on loop rows, including compaction summary rows. It does not include model_invoke or other provider calls that did not create loop rows. input already includes cacheRead and cacheWrite; total = input + output.',
      loopRows: entries.length,
      usageRows,
      totals,
      byModel: Array.from(byModel.values()).sort((a, b) => b.total - a.total),
    }
  }

  getAgentTasks(agentId: string, opts: RuntimeAgentTasksOptions = {}): { agentId: string; tasks: RuntimeTaskEntry[] } {
    const managed = this.requireAgent(agentId)
    const tasks = opts.status
      ? managed.agent.workspace.getTasksByStatus(opts.status)
      : managed.agent.workspace.getAllTasks(clampInteger(opts.limit ?? 200, 1, 1000))
    return { agentId: managed.id, tasks: tasks.map(task => this.withApprovalAffordance(managed, task)) }
  }

  getAgentTask(agentId: string, taskId: string): { agentId: string; task: RuntimeTaskEntry } | null {
    const managed = this.requireAgent(agentId)
    const task = managed.agent.workspace.getTask(taskId)
    return task ? { agentId: managed.id, task: this.withApprovalAffordance(managed, task) } : null
  }

  /**
   * The executor (main or an inner loop) whose pending HIL map holds this
   * request. Task ids are globally unique (`task_<nanoid>`), so the first hit
   * is the only one.
   */
  private approvalHolder(managed: ManagedRuntimeAgent, taskId: string): { loop: string; executor: ManagedRuntimeAgent['agent']['executor'] } | undefined {
    return this.askExecutors(managed).find(entry => entry.executor.getPendingApprovalMeta(taskId) !== undefined)
  }

  /** pending_approval rows gain the live "Always approve" affordance
   *  (Studio's ApprovalControls) — derived from the executor holding the
   *  request, never persisted. A row no executor is waiting on (deferred
   *  on_tool_call task, pre-restart leftover) can only be resolved. */
  private withApprovalAffordance(managed: ManagedRuntimeAgent, task: TaskEntry): RuntimeTaskEntry {
    if (task.status !== 'pending_approval') return task
    const meta = this.approvalHolder(managed, task.id)?.executor.getPendingApprovalMeta(task.id)
    if (!meta) return { ...task, canAlwaysApprove: false, alwaysApproveBlockedReason: NO_LIVE_APPROVAL_REASON }
    const locked = managed.config.tools?.find(t => t.name === task.tool)?.locked === true
    if (meta.canAlwaysApprove === false || locked) {
      return { ...task, canAlwaysApprove: false, alwaysApproveBlockedReason: meta.alwaysApproveBlockedReason ?? 'Tool declaration is locked' }
    }
    return { ...task, canAlwaysApprove: true }
  }

  /**
   * "Always approve" (Studio's Approve ▸ Always approve): drop the HIL gate on
   * the HOST tool declaration (enabled, un-restricted), persist + propagate it
   * through setAgentConfig (the same path PUT /config takes), then approve the
   * pending request. The tool name comes from the pending request, never the
   * client. Refused (409) for protection overrides, synthetic one-shot
   * approvals and locked declarations — the backend is the authority, the UI
   * only hides the option.
   */
  async alwaysApproveAgentTask(agentId: string, taskId: string): Promise<{
    agentId: string
    taskId: string
    loop: string
    tool: string
    resolution: unknown
    task: RuntimeTaskEntry | null
  }> {
    const managed = this.requireAgent(agentId)
    const task = managed.agent.workspace.getTask(taskId)
    if (!task) throw new RuntimeLoopError(`Unknown task "${taskId}"`, 404)
    if (task.status !== 'pending_approval') {
      throw new RuntimeLoopError(`Task "${taskId}" is in status "${task.status}" - only pending_approval tasks can be always-approved`, 409)
    }
    const holder = this.approvalHolder(managed, taskId)
    const meta = holder?.executor.getPendingApprovalMeta(taskId)
    if (!holder || !meta) throw new RuntimeLoopError(`Task "${taskId}": ${NO_LIVE_APPROVAL_REASON}`, 409)
    const toolName = holder.executor.getPendingApprovals().find(a => a.requestId === taskId)?.name ?? task.tool

    const config = managed.config
    const decl = config.tools?.find(t => t.name === toolName)
    if (meta.canAlwaysApprove === false || decl?.locked === true) {
      throw new RuntimeLoopError(meta.alwaysApproveBlockedReason ?? 'Tool declaration is locked', 409)
    }

    const tools = config.tools ? [...config.tools] : []
    const idx = tools.findIndex(t => t.name === toolName)
    if (idx >= 0) tools[idx] = { ...tools[idx], enabled: true, restricted: false }
    else tools.push({ name: toolName, enabled: true, visible: true, restricted: false })
    await this.setAgentConfig(managed.id, { ...config, tools })

    const resolved = await this.resolveAgentTask(managed.id, taskId, { action: 'approve' })
    return { agentId: managed.id, taskId, loop: holder.loop, tool: toolName, resolution: resolved.resolution, task: resolved.task }
  }

  /**
   * "Approve all": every pending GATED approval (reason 'restricted') on the
   * agent's executors — or only `loop`'s. Protection overrides are never
   * included; the executor enforces that filter itself.
   */
  approveAllAgentTasks(agentId: string, loop?: string): { agentId: string; loop?: string; approved: number; skippedProtection: number } {
    const managed = this.requireAgent(agentId)
    const executors = this.askExecutors(managed)
    let targets = executors
    if (loop !== undefined) {
      const loopName = this.requireLoopName(managed, loop)
      targets = executors.filter(entry => entry.loop === loopName)
      if (targets.length === 0) throw new RuntimeLoopError(`Loop "${loopName}" has no running executor (it is disabled or stopping).`, 409)
    }
    let approved = 0
    let skippedProtection = 0
    for (const { executor } of targets) {
      const result = executor.approveAllGatedHilTasks()
      approved += result.approved
      skippedProtection += result.skippedProtection
    }
    return { agentId: managed.id, ...(loop !== undefined ? { loop: targets[0].loop } : {}), approved, skippedProtection }
  }

  async resolveAgentTask(agentId: string, taskId: string, opts: RuntimeTaskResolveOptions): Promise<{
    agentId: string
    taskId: string
    resolution: unknown
    task: RuntimeTaskEntry | null
  }> {
    const managed = this.requireAgent(agentId)
    const input = {
      task_id: taskId,
      action: opts.action,
      reason: opts.reason,
      modified_args: opts.modifiedArgs,
    }

    // The main call handler's onHilApproved is bound to MAIN's executor, so a
    // request parked by an inner loop's executor must be answered on that
    // executor directly (same status writes as handleTaskResolve).
    const holder = this.approvalHolder(managed, taskId)
    let resolution: unknown
    if (holder && holder.loop !== MAIN_LOOP) {
      const workspace = managed.agent.workspace
      if (opts.action === 'approve') {
        workspace.updateTaskStatus(taskId, 'running')
        holder.executor.resolveHilTask(taskId, true, opts.modifiedArgs)
        resolution = { task_id: taskId, status: 'approved' }
      } else if (opts.action === 'deny') {
        const reason = opts.reason ?? 'Denied'
        workspace.updateTaskStatus(taskId, 'denied', undefined, reason)
        holder.executor.resolveHilTask(taskId, false, undefined, opts.reason)
        resolution = { task_id: taskId, status: 'denied', reason }
      } else {
        workspace.updateTaskStatus(taskId, 'pending_approval')
        resolution = { task_id: taskId, status: 'pending_approval' }
      }
    } else if (managed.agent.adfCallHandler) {
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
        // Reason rides along as feedback: the agent reads it in the tool error.
        managed.agent.executor.resolveHilTask(taskId, false, undefined, opts.reason)
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
      task: this.getAgentTask(managed.id, taskId)?.task ?? null,
    }
  }

  /** Main's executor plus every running inner loop's: asks can come from any loop. */
  private askExecutors(managed: ManagedRuntimeAgent): Array<{ loop: string; executor: ManagedRuntimeAgent['agent']['executor'] }> {
    const out: Array<{ loop: string; executor: ManagedRuntimeAgent['agent']['executor'] }> = [{ loop: MAIN_LOOP, executor: managed.agent.executor }]
    for (const info of managed.agent.loopPool.listLoops()) {
      if (info.name === MAIN_LOOP) continue
      const runtime = managed.agent.loopPool.getRuntime(info.name)
      if (runtime) out.push({ loop: info.name, executor: runtime.executor })
    }
    return out
  }

  getAgentAsks(agentId: string): { agentId: string; asks: RuntimeAgentAsk[] } {
    const managed = this.requireAgent(agentId)
    const asks = this.askExecutors(managed).flatMap(({ loop, executor }) => executor.getPendingAsks().map(ask => ({ ...ask, loop })))
    return { agentId: managed.id, asks }
  }

  /** Request ids are per executor, so `loop` disambiguates; absent = the first loop holding that id. */
  answerAgentAsk(agentId: string, requestId: string, answer: string, loop?: string): { agentId: string; requestId: string; loop: string; answered: boolean } {
    const managed = this.requireAgent(agentId)
    const holder = this.askExecutors(managed).find(entry =>
      (loop === undefined || entry.loop === loop) && entry.executor.getPendingAsks().some(ask => ask.requestId === requestId))
    if (!holder) throw new Error(`Ask request "${requestId}" not found${loop ? ` in loop "${loop}"` : ''}`)
    holder.executor.resolveAsk(requestId, answer)
    return { agentId: managed.id, requestId, loop: holder.loop, answered: true }
  }

  /**
   * One loop's per-request context breakdown (Studio's context modal; daemon
   * GET /agents/:id/context). `breakdown` is null when that loop has no live
   * executor (disabled, never woken, idle-swept) or it is half-initialized.
   */
  getAgentContextBreakdown(agentId: string, loop?: string): { agentId: string; loop: string; config: AgentConfig; breakdown: import('../../shared/types/ipc.types').ContextBreakdown | null } {
    const managed = this.requireAgent(agentId)
    const loopName = this.requireLoopName(managed, loop)
    const executor = loopName === MAIN_LOOP ? managed.agent.executor : managed.agent.loopPool.getRuntime(loopName)?.executor
    return {
      agentId: managed.id,
      loop: loopName,
      config: managed.agent.workspace.getAgentConfig(),
      breakdown: executor?.getContextBreakdown() ?? null,
    }
  }

  /** Compact one loop's history now (Studio's /compact). Refused mid-turn. */
  async compactAgentLoop(agentId: string, loop?: string): Promise<{ agentId: string; loop: string; success: true }> {
    const managed = this.requireAgent(agentId)
    const loopName = this.requireLoopName(managed, loop)
    const executor = loopName === MAIN_LOOP ? managed.agent.executor : managed.agent.loopPool.getRuntime(loopName)?.executor
    if (!executor) throw new RuntimeLoopError(`Loop "${loopName}" has no running executor (it is disabled or stopping).`, 409)
    const result = await executor.compactNow(`manual: owner /compact${loopName === MAIN_LOOP ? '' : ` (${loopName})`}`)
    if (!result.success) {
      const error = result.error ?? 'Compaction failed.'
      // A summariser/provider failure is upstream, not a state conflict.
      throw new RuntimeLoopError(error, error.startsWith('Compaction failed:') ? 502 : 409)
    }
    return { agentId: managed.id, loop: loopName, success: true }
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

  /** Metadata only: stored values (and all key material) never leave the process. */
  getAgentIdentity(agentId: string, purpose: string): { agentId: string } & RuntimeIdentityMeta {
    const managed = this.requireAgent(agentId)
    return { agentId: managed.id, ...this.describeIdentity(managed, purpose) }
  }

  setAgentIdentity(agentId: string, purpose: string, value: string, opts: RuntimeCredentialWriteOptions = {}): { agentId: string; purpose: string; success: true; replaced?: boolean } {
    const managed = this.requireAgent(agentId)
    const replaced = this.setIdentityValue(managed, purpose, value, opts)
    return { agentId: managed.id, purpose, success: true, ...(replaced ? { replaced } : {}) }
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
    // The provider was built while the agent's own key was unreadable (and so
    // resolved fail-closed); rebuild it now that the key opens.
    this.rebuildProviderAfterUnlock(managed)
    return { agentId: managed.id, success: true }
  }

  private rebuildProviderAfterUnlock(managed: ManagedRuntimeAgent): void {
    if (!this.providerFactory) return
    void Promise.resolve(this.providerFactory(managed.config, managed.filePath, {
      workspace: managed.agent.workspace,
      derivedKey: managed.derivedKey,
    })).then(
      provider => managed.agent.executor.updateProvider(provider),
      err => console.warn(`[RuntimeService] Provider rebuild after unlock failed for ${managed.id}:`, err),
    )
  }

  /** @deprecated Whole-file password creation is removed; the method stays so daemon callers fail loudly. */
  setAgentIdentityPassword(_agentId: string, _password: string): { agentId: string; success: true } {
    throw new Error('Whole-file passwords are no longer supported — use a share password instead.')
  }

  removeAgentIdentityPassword(agentId: string): { agentId: string; success: true } {
    const managed = this.requireAgent(agentId)
    if (!managed.derivedKey) throw new Error('Identity keystore is locked')
    managed.agent.workspace.removePassword(managed.derivedKey)
    managed.derivedKey = null
    return { agentId: managed.id, success: true }
  }

  /** @deprecated Re-keying is continued use of the removed whole-file password mechanism. Remove the password instead. */
  changeAgentIdentityPassword(_agentId: string, _newPassword: string): { agentId: string; success: true } {
    throw new Error('Whole-file passwords are no longer supported — remove the password and use a share password instead.')
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
    const workspace = managed.agent.workspace
    // A key-less file goes through the host's full provisioning (envelopes,
    // sealed key, owner/runtime stamps, attestations), never a plain key the
    // owner never certified. A host without the owner key refuses instead.
    if (!managed.derivedKey && workspace.getIdentityRow('crypto:signing:private_key') === null) {
      if (!canProvisionWorkspaceIdentity()) {
        throw new Error('No owner identity on this host — create or restore it first (`adf identity`), then generate keys.')
      }
      ensureWorkspaceIdentity(workspace)
      const provisioned = workspace.getDid()
      if (provisioned) return { agentId: managed.id, success: true, did: provisioned }
    }
    const result = workspace.generateIdentityKeys(managed.derivedKey)
    // Fresh agent DID under this app's ownership → issue delegation attestations.
    const ownerIdentity = this.settings?.getOwnerIdentity?.()
    if (ownerIdentity) {
      try {
        issueOwnerAttestation(managed.agent.workspace, {
          ownerDid: ownerIdentity.getOwnerDid(),
          ownerPrivateKey: ownerIdentity.getOwnerSigningKey(),
          runtimeDid: ownerIdentity.getRuntimeDid(),
          runtimePrivateKey: ownerIdentity.getRuntimeSigningKey()
        })
      } catch (err) {
        console.warn('[RuntimeService] Attestation issuance failed:', err)
      }
    }
    return { agentId: managed.id, success: true, did: result.did }
  }

  setAgentProviderCredential(agentId: string, providerId: string, value: string, opts: RuntimeCredentialWriteOptions = {}): { agentId: string; providerId: string; success: true; replaced?: boolean } {
    const managed = this.requireAgent(agentId)
    const replaced = this.setIdentityValue(managed, `provider:${providerId}:apiKey`, value, opts)
    return { agentId: managed.id, providerId, success: true, ...(replaced ? { replaced } : {}) }
  }

  /** Metadata only (see RuntimeIdentityMeta), keyed by credential name (`apiKey`). */
  getAgentProviderCredentials(agentId: string, providerId: string): {
    agentId: string
    providerId: string
    credentials: Record<string, RuntimeIdentityMeta>
    providerConfig?: Pick<AdfProviderConfig, 'defaultModel' | 'params' | 'requestDelayMs'>
  } {
    const managed = this.requireAgent(agentId)
    const providerConfig = managed.config.providers?.find(provider => provider.id === providerId)
    return {
      agentId: managed.id,
      providerId,
      credentials: this.describeCredentials(managed, `provider:${providerId}:`),
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

  setAgentMcpCredential(agentId: string, npmPackage: string, envKey: string, value: string, opts: RuntimeCredentialWriteOptions = {}): { agentId: string; npmPackage: string; envKey: string; success: true; replaced?: boolean } {
    const managed = this.requireAgent(agentId)
    const replaced = this.setIdentityValue(managed, `mcp:${npmPackage}:${envKey}`, value, opts)
    return { agentId: managed.id, npmPackage, envKey, success: true, ...(replaced ? { replaced } : {}) }
  }

  /** Metadata only (see RuntimeIdentityMeta), keyed by env key. */
  getAgentMcpCredentials(agentId: string, npmPackage: string): { agentId: string; npmPackage: string; credentials: Record<string, RuntimeIdentityMeta> } {
    const managed = this.requireAgent(agentId)
    return {
      agentId: managed.id,
      npmPackage,
      credentials: this.describeCredentials(managed, `mcp:${npmPackage}:`),
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

  setAgentAdapterCredential(agentId: string, adapterType: string, envKey: string, value: string, opts: RuntimeCredentialWriteOptions = {}): { agentId: string; adapterType: string; envKey: string; success: true; replaced?: boolean } {
    const managed = this.requireAgent(agentId)
    const replaced = this.setIdentityValue(managed, `adapter:${adapterType}:${envKey}`, value, opts)
    return { agentId: managed.id, adapterType, envKey, success: true, ...(replaced ? { replaced } : {}) }
  }

  /** Metadata only (see RuntimeIdentityMeta), keyed by env key. */
  getAgentAdapterCredentials(agentId: string, adapterType: string): { agentId: string; adapterType: string; credentials: Record<string, RuntimeIdentityMeta> } {
    const managed = this.requireAgent(agentId)
    return {
      agentId: managed.id,
      adapterType,
      credentials: this.describeCredentials(managed, `adapter:${adapterType}:`),
    }
  }

  /**
   * An agent provider's API key, for in-process use only (the daemon's model
   * listing calls the provider with it). Never returned over HTTP.
   */
  readAgentProviderApiKey(agentId: string, providerId: string): string | undefined {
    const managed = this.requireAgent(agentId)
    return managed.agent.workspace.getIdentityDecrypted(`provider:${providerId}:apiKey`, managed.derivedKey) ?? undefined
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

  /**
   * (Re)connect one configured MCP server of a running agent now: after an
   * attach (the daemon does not reconcile MCP servers on config change), or
   * to restart a failed one. Same path as the agent's mcp_restart tool.
   */
  async restartAgentMcpServer(agentId: string, serverName: string): Promise<{ agentId: string; serverName: string; success: boolean; toolsDiscovered: number; location?: string; error?: string; hostDenied?: string; stderrTail?: string[] }> {
    const managed = this.requireAgent(agentId)
    if (!managed.config.mcp?.servers?.some(server => server.name === serverName)) {
      throw new RuntimeLoopError(`Agent has no MCP server "${serverName}".`, 404)
    }
    const connect = mcpConnectorFor(managed.agent.mcpManager)
    if (!connect) throw new RuntimeLoopError('The agent is not running here: start it, and its MCP servers connect.', 409)
    const outcome = await connect(serverName, 'Owner restart')
    return { agentId: managed.id, serverName, success: outcome.toolsDiscovered > 0 && !outcome.error, ...outcome }
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

  /**
   * Catch-up read over the agent's in-memory umbilical replay window.
   *
   * The window is opt-in (`umbilical.log.enabled`) and lives only in the
   * runtime process, so "replay off" and "agent running without a buffer" are
   * both normal states, not errors — remote observers probe this endpoint to
   * decide whether tailing is available at all. Both answer
   * `{ events: [], last_seq: null, log_enabled: false }`.
   *
   * `oldest_seq` is what makes the window safe to tail: a client whose cursor
   * predates it (`since_seq < oldest_seq - 1`) has fallen off the back and must
   * re-snapshot rather than assume it saw everything.
   *
   * The buffer is found through the per-agent registry the umbilical lifecycle
   * resource populates, so every host that uses `createUmbilicalResources`
   * (daemon via AgentRuntimeBuilder, Studio background, Studio foreground) is
   * served identically. Headless agents wire no umbilical resources and
   * therefore always report `log_enabled: false`.
   */
  getAgentUmbilicalEvents(agentId: string, opts: { sinceSeq?: number; limit?: number } = {}): {
    agentId: string
    events: Array<{ seq: number; event_type: string; timestamp: number; source: string; payload: unknown; truncated: boolean }>
    last_seq: number | null
    log_enabled: boolean
    oldest_seq?: number
  } {
    const managed = this.requireAgent(agentId)
    const buffer = getUmbilicalReplayBuffer(managed.id)
    if (!buffer) return { agentId: managed.id, events: [], last_seq: null, log_enabled: false }

    const sinceSeq = clampInteger(opts.sinceSeq ?? 0, 0, Number.MAX_SAFE_INTEGER)
    const limit = clampInteger(opts.limit ?? 500, 1, 2000)
    const events = buffer.getSince(sinceSeq, limit).map(record => ({
      seq: record.seq,
      event_type: record.event_type,
      timestamp: record.timestamp,
      source: record.source,
      payload: record.payload,
      truncated: record.truncated,
    }))
    const range = buffer.range()
    return {
      agentId: managed.id,
      events,
      last_seq: events.length > 0 ? events[events.length - 1].seq : sinceSeq || null,
      log_enabled: true,
      ...(range ? { oldest_seq: range.oldest_seq } : {}),
    }
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

  private registerAgent(agent: RuntimeAgent, filePath: string | null, config: AgentConfig, idOverride?: string): RuntimeAgentRef {
    // Shutdown race: an agent whose build completes after teardown began must
    // not register (it would escape the teardown's agent snapshot and keep
    // dispatching turns). Dispose it instead.
    if (RuntimeGate.tearingDown) {
      void agent.disposeAsync({ mode: 'immediate' }).catch(() => { /* best effort */ })
      throw new Error('RuntimeService: runtime teardown in progress — agent not registered.')
    }
    const id = idOverride ?? config.id
    if (this.agents.has(id)) {
      void agent.disposeAsync({ mode: 'immediate' })
      return this.toRef(this.requireAgent(id))
    }

    const hostAttachment = agent.attachHost({
      onEvent: (event) => {
        this.emit('agent-event', { agentId: id, filePath, event } satisfies RuntimeAgentEvent)
      },
    })
    const managed: ManagedRuntimeAgent = {
      id,
      filePath,
      config,
      agent,
      derivedKey: null,
      hostAttachment,
    }
    this.wireCreateAdfCallbacks(managed)
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
      getDefaultProvider?: () => ProviderConfig | undefined
      getStudioTemplate?: () => { filePath: string } | undefined
    } | undefined
    if (!createAdfTool) return

    createAdfTool.onChildCreated = (_childPath, childConfig) => {
      if (!this.settings?.set) return
      this.settings.set('reviewedAgents', markConfigReviewed(this.settings.get('reviewedAgents'), childConfig))
    }
    createAdfTool.onAutostartChild = async (childPath) => this.startCreatedChildAgent(childPath)
    createAdfTool.getDefaultProvider = () => {
      const providers = (this.settings?.get('providers') as ProviderConfig[] | undefined) ?? []
      return resolveDefaultProvider(providers, this.settings?.get('defaultProviderId') as string | undefined)
    }
    createAdfTool.getStudioTemplate = () => {
      // The template children start from is a file in <userData>/templates,
      // named by settings.childTemplateId. No id means the code defaults. The
      // daemon never generates the shipped ones (Studio does), so a missing
      // file means the code defaults too.
      const id = this.settings?.get('childTemplateId')
      if (typeof id !== 'string' || id === '') return undefined
      const file = templateFilePath(id)
      return existsSync(file) ? { filePath: file } : undefined
    }
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

  /**
   * Owner credential write (HTTP credential routes). Returns true when a
   * locked sealed value was discarded (`replace`).
   *
   * While the covering envelope is locked here a plain write is refused
   * (409 credentials_locked): it would destroy a sealed value, or store a
   * new one unsealed. `replace: true` is the owner's explicit override: the
   * locked sealed row is deleted, the new value stored plain and sealed on
   * the next unlock (sealPlainRowsIntoEnvelopes), and the replace logged to
   * the agent's adf_logs. Agent code never reaches this (set_identity /
   * shell export write through AdfWorkspace.setIdentity, which keeps
   * refusing).
   */
  private setIdentityValue(managed: ManagedRuntimeAgent, purpose: string, value: string, opts: RuntimeCredentialWriteOptions = {}): boolean {
    const workspace = managed.agent.workspace
    if (workspace.isPasswordProtected() && !managed.derivedKey) {
      throw new Error('Identity keystore is locked')
    }
    if (managed.derivedKey) {
      const { ciphertext, iv } = encrypt(Buffer.from(value, 'utf-8'), managed.derivedKey)
      const kdfParamsJson = workspace.getDatabase().getIdentity('crypto:kdf:params')
      workspace.getDatabase().setIdentityRaw(
        purpose,
        ciphertext,
        'aes-256-gcm',
        iv,
        kdfParamsJson,
      )
      return false
    }
    if (purpose.startsWith('crypto:')) {
      // Key material is managed by provisioning, never replaced by an owner write.
      if (opts.replace) throw new RuntimeLoopError(`"${purpose}" is key material and cannot be replaced over the API.`, 400)
      workspace.setIdentity(purpose, value)
      return false
    }
    const state = workspace.getEnvelopeState('credentials')
    const envelopeLocked = state === 'locked' || state === 'foreign'
    const row = workspace.getIdentityRow(purpose)
    const rowEnvelope = row ? envelopeFromAlgo(row.encryption_algo) : null
    const rowLocked = rowEnvelope !== null && workspace.getEnvelopeState(rowEnvelope) !== 'unlocked'
    if (!envelopeLocked && !rowLocked) {
      workspace.setIdentity(purpose, value)
      return false
    }
    if (!opts.replace) {
      throw new RuntimeLoopError(
        rowLocked
          ? `This agent's saved "${purpose}" is sealed and its credentials envelope is ${state} on this daemon, so it can't be read or overwritten. ${CREDENTIALS_UNLOCK_HINT} Or replace it (replace: true): the old value is discarded.`
          : `The credentials envelope of this agent is ${state} on this daemon — refusing to store "${purpose}" unsealed. ${CREDENTIALS_UNLOCK_HINT} Or store it anyway (replace: true): it is sealed once the envelope unlocks.`,
        409,
        CREDENTIALS_LOCKED_CODE,
      )
    }
    const codeAccess = row?.code_access ?? false
    if (rowLocked) workspace.deleteIdentity(purpose)
    workspace.setIdentity(purpose, value, codeAccess)
    const message = rowLocked
      ? `Owner replaced locked sealed credential "${purpose}" (the old value was discarded unread); the new value is stored unsealed until the credentials envelope unlocks.`
      : `Owner stored credential "${purpose}" while the credentials envelope is ${state}; it is stored unsealed until the envelope unlocks.`
    console.warn(`[RuntimeService] ${managed.config.name}: ${message}`)
    // Straight to adf_logs (not the agent's log-level filter): an owner override is always recorded.
    try { workspace.getDatabase().insertLog('warn', 'runtime', 'credential_replaced', purpose, message) } catch { /* non-fatal */ }
    return rowLocked
  }

  private describeIdentity(managed: ManagedRuntimeAgent, purpose: string): RuntimeIdentityMeta {
    const workspace = managed.agent.workspace
    const row = workspace.getIdentityRow(purpose)
    if (!row) return { purpose, present: false, storage: null, sealed: false, locked: false, length: null, code_access: false }
    const envelope = envelopeFromAlgo(row.encryption_algo)
    const storage = envelope ? 'sealed' : row.encryption_algo === 'plain' ? 'plain' : 'password'
    const locked = envelope ? workspace.getEnvelopeState(envelope) !== 'unlocked' : storage === 'password' && !managed.derivedKey
    let length: number | null = null
    if (!locked && !purpose.startsWith('crypto:')) {
      try { length = workspace.getIdentityDecrypted(purpose, managed.derivedKey)?.length ?? null } catch { length = null }
    }
    return { purpose, present: true, storage, sealed: envelope !== null, locked, length, code_access: row.code_access }
  }

  private describeCredentials(managed: ManagedRuntimeAgent, prefix: string): Record<string, RuntimeIdentityMeta> {
    const credentials: Record<string, RuntimeIdentityMeta> = {}
    for (const purpose of managed.agent.workspace.listIdentityPurposes(prefix)) {
      credentials[purpose.slice(prefix.length)] = this.describeIdentity(managed, purpose)
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
      ...(managed.degraded ? { degraded: managed.degraded } : {}),
    }
  }

  private async resolveProvider(
    config: AgentConfig,
    filePath: string,
    override: LLMProvider | undefined,
    workspace: AdfWorkspace,
  ): Promise<LLMProvider> {
    if (override) return override
    if (!this.providerFactory) {
      throw new Error('RuntimeService: loadAgent requires a provider or providerFactory.')
    }
    // No derived key at load: the legacy password lock is opened later via
    // unlock; envelope-sealed keys are already open (unlockWorkspaceEnvelopes).
    return this.providerFactory(config, filePath, { workspace, derivedKey: null })
  }

  private async buildLoadedAgent(
    workspace: AdfWorkspace,
    filePath: string,
    config: AgentConfig,
    provider: LLMProvider,
  ): Promise<RuntimeAgent> {
    if (this.agentRuntimeBuilder) {
      return await this.agentRuntimeBuilder.build({
        workspace,
        filePath,
        config,
        provider,
        restoreLoop: true,
        createProviderForModel: (model) => {
          if (!this.providerFactory) return provider
          const resolved = this.providerFactory({ ...config, model }, filePath, { workspace, derivedKey: null })
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

  /** The .adf files an autostart scan of `dirs` would consider (same walk, same depth rule). */
  scanAdfFiles(dirs: string[], maxDepth = 5): string[] {
    return this.collectAdfFiles(dirs, maxDepth)
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
  // `input` is already cache-inclusive (AI SDK v6 reports inputTokens.total),
  // so cache buckets are a breakdown of input, not an addition to it.
  target.total = target.input + target.output
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
