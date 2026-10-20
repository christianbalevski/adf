import { EventEmitter } from 'node:events'
import type { LoopMedia } from '../../shared/types/media.types'
import { mcpConnectorFor } from './mcp-connectors'
import { existsSync, readdirSync, realpathSync, renameSync, statSync } from 'node:fs'
import { readdir, realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { AdfDatabase } from '../adf/adf-database'
import { AdfWorkspace } from '../adf/adf-workspace'
import { resolveDefaultProvider } from '../adf/apply-default-provider'
import { templateFilePath } from '../adf/agent-templates'
import { canProvisionWorkspaceIdentity, ensureWorkspaceIdentity, unlockWorkspaceEnvelopes } from './identity-provisioner'
import { encrypt } from '../crypto/identity-crypto'
import { envelopeFromAlgo } from '../crypto/envelope-crypto'
import { lockedCredentialWrite, replaceLockedCredential, type LockedCredential } from '../services/locked-credential'
import { buildConfigSummary, deriveReviewIdentity, isConfigReviewed, markConfigReviewed } from '../services/agent-review'
import { withDeadline } from '../utils/concurrency'
import type { LLMProvider } from '../providers/provider.interface'
import { providerSelectionChanged } from '../providers/provider-selection'
import {
  agentProviderKeySource,
  providerNeedsApiKey,
  resolveAgentProviderConfig,
  type ProviderSettingsStore,
} from '../providers/provider-factory'
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
import { resolveStartInState } from '../../shared/types/adf-v02.types'
import type { AdapterInstanceConfig, AdapterState } from '../../shared/types/channel-adapter.types'
import type { AgentConfigSummary, AgentExecutionEvent, AgentState as DisplayAgentState, ProviderConfig } from '../../shared/types/ipc.types'
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
import { CREDENTIALS_UNLOCK_HINT, detectLockedEnvelopes, type AgentRuntimePrompts, type AgentRuntimeBuilder } from './agent-runtime-builder'
import { emitAgentDerivedKeyChanged } from './agent-runtime-signals'
import { applyBackgroundEvent, type BackgroundMappingState } from './background-event-mapping'
import { deriveHandle } from '../utils/handle'
import { toDisplayState } from './display-state'
import type { AgentHostBindings, AgentStopMode, AssembledAgentBase, HostAttachment } from './assemble-agent'
import { LoopPoolError, stripLoopNameMarker } from './loop-pool'
import { LOOP_AUTOSTART_MESSAGE, type LoopDeleteResult, type LoopInfo, type LoopSendResult } from '../adf/loop-pool.types'
import { LoopConfigSchema } from '../adf/adf-schema'
import { MAIN_LOOP, listAvailableLoopTools, validateLoopToolList } from '../adf/derive-loop-config'
import { DEFAULT_NEW_LOOP_TOOLS } from '../../shared/types/adf-v02.types'
import type { AgentProfileName } from './agent-capability-profiles'
import { RuntimeGate } from './runtime-gate'
import { currentAgentId, currentTurnId, withSource } from './execution-context'
import { emitUmbilicalEvent } from './emit-umbilical'
import { getUmbilicalReplayBuffer } from './umbilical-replay-buffer'
import { issueOwnerAttestation, readAdfAttestations, verifyAttestation } from '../services/attestation.service'
import { mapWithConcurrency } from '../utils/concurrency'
import { buildToolDiscovery, type ToolDiscoveryEntry } from '../tools/built-in/sys-get-config.tool'
import { AGENT_LEASED_CODE, processAgentLeases, type AgentLeaseRegistry } from './agent-lease'
import { DocumentHost, type OpenDocument } from './document-host'
import {
  configRevision, configRevisionOf, currentResourceWriter, runAsApiWrite, documentRevision, fileRevision, fileRevisionKey, observeRevision,
  existsAlready, staleRevision, staleRevisionMessage, type ResourceRevision,
} from './resource-revisions'
import type { ContentBlock } from '../../shared/types/provider.types'
import { agentFileNameProblem } from '../../shared/utils/agent-file-name'
import { summarizeLoopUsage, type RuntimeAgentUsageByModel, type RuntimeUsageTotals } from './loop-usage'

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
    getOwnerEncPrivateKey?(): Buffer | null
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
  /**
   * Fallback prompts. Each start reads `globalSystemPrompt`, `toolPrompts`
   * and `compactionPrompt` from `settings` (as Studio does at AGENT_START);
   * these apply only while the store has no value for the key.
   */
  basePrompt?: string
  toolPrompts?: Record<string, string>
  compactionPrompt?: string
  agentRuntimeBuilder?: AgentRuntimeBuilder
  /** Defaults to true for opened .adf files. Ephemeral createAgent calls bypass review. */
  enforceReviewGate?: boolean
  /** Cross-process agent lease (agent-lease.ts). Defaults to the process registry; null disables it. */
  agentLeases?: AgentLeaseRegistry | null
  /** Open documents: the holder TTL used while no session check is set (default DOCUMENT_HOLD_TTL_MS). */
  documentHoldTtlMs?: number
}

export interface RuntimeLoadAgentOptions {
  provider?: LLMProvider
  enforceReviewGate?: boolean
  /**
   * Legacy-password derived key the caller already holds (a file unlocked
   * before its start). Every consumer reads it from the first connect, as in
   * Studio; without it the agent starts locked until
   * unlockAgentIdentityPassword.
   */
  derivedKey?: Buffer | null
}

/** 409 code of a load refused because another loaded file has the same `config.id`. */
export const DUPLICATE_AGENT_ID_CODE = 'duplicate_agent_id'

/** 409 code of a runtime action (turn, approval, loop change) on an open document that is not running. */
export const AGENT_NOT_RUNNING_CODE = 'agent_not_running'

/** Who holds an open document: a client session (W2-B passes its session id). */
export interface RuntimeDocumentHoldOptions {
  holder: string
}

/**
 * An open document (design D4) as clients see it: Studio's FILE_OPEN answer.
 * `running` is embedded's `agentWasRunning`.
 */
export interface RuntimeOpenDocumentInfo {
  agentId: string
  filePath: string
  name: string
  running: boolean
  /** Password-protected (legacy whole-file password) and not unlocked: the client prompts. */
  needsPassword: boolean
  holders: number
  /** This open renamed the agent after its file (Studio's FILE_OPEN does the same). */
  nameChangedFrom?: string
  /** Another runtime runs the file: it opened read-only (no open step wrote it) and writes are refused. The sentence names the holder. */
  readOnly?: string
}

/** 'document-opened' / 'document-closed': an open document came or went. */
export interface RuntimeDocumentEvent {
  agentId: string
  filePath: string
  /** closed: why (released, deleted, shutdown). Holder ids are never in events. */
  reason?: 'released' | 'deleted' | 'shutdown'
}

/**
 * Host identity steps on open (Studio's FILE_OPEN): the lazy legacy-DID
 * restamp, then ensureWorkspaceIdentity with keys minted only for a reviewed
 * file. The daemon passes its owner identity here (http-api.ts); without it a
 * document only gets the envelope unlock every load does.
 */
export interface RuntimeDocumentOpenHooks {
  onOpen?(workspace: AdfWorkspace, ctx: { filePath: string; reviewed: boolean }): void
  /**
   * The sentence naming another live runtime that holds the file's agent
   * lease, or null. Such a file opens read-only: no open step writes it.
   */
  leasedElsewhere?(filePath: string): Promise<string | null>
}

/** Holders are client session ids (W2-B mints them with randomUUID). */
export const DOCUMENT_HOLDER_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Without a session check, a holder that has not held anything for this long is released (D5's 60 s session expiry). */
export const DOCUMENT_HOLD_TTL_MS = 60_000

/** A running agent or an open document, by id, handle or name (the /agents/:id resource routes). */
export interface RuntimeAgentTargetRef extends RuntimeAgentRef {
  running: boolean
}

/** The workspace a resource route acts on, for daemon routes outside RuntimeService. */
export interface RuntimeAgentWorkspace {
  agentId: string
  filePath: string | null
  workspace: AdfWorkspace
  /** Legacy-password derived key while unlocked; null otherwise. Never leaves the process. */
  derivedKey: Buffer | null
  running: boolean
}

/** Status of a running agent or an open document (`running: false`, runtimeState `stopped`). */
export interface RuntimeTargetStatus extends RuntimeAgentStatus {
  running: boolean
  /** A running agent's session id (Studio's AGENT_START answers it, the reuse path included). */
  sessionId?: string
  /**
   * A running agent's side loops and their display states (LoopPool.sideLoopStates):
   * what embedded's re-attach answers, and what a client that starts
   * watching mid-stream needs before each loop's next `state_changed`.
   */
  loopStates?: Record<string, DisplayAgentState>
  /**
   * A running agent's effective media per loop (main and live side loops):
   * what its connector carries narrowed by the agent's toggles, and why the
   * rest is refused. Studio's composer gates attachments on it.
   */
  media?: Record<string, LoopMedia>
}

/** Studio's DOC_GET_HEADER: what the header shows, read in one call. */
export interface RuntimeAgentHeader {
  agentId: string
  document: string
  agentConfig: AgentConfig
  statusText: string
}

/** Studio's DOC_GET_BATCH: the header plus the last 200 display entries of main and the token figures. */
export interface RuntimeAgentBatch extends RuntimeAgentHeader {
  /** W3-F: the revisions of `agentConfig` and `document`, the base of the client's next save (a file switch reads them; the header, read every turn end, does not hash). */
  configRevision: number
  documentRevision: number
  lastTokens: LoopTokenUsage | undefined
  contextBaseline: unknown
  chat: { version: number; uiLog: unknown[]; llmMessages: unknown[]; earlierCount: number; total: number }
}

/** Studio's DOC_GET_CHAT_OLDER: a keyset page of display entries before a seq. */
export interface RuntimeAgentChatPage {
  agentId: string
  loop: string
  uiLog: unknown[]
  earlierCount: number
}

/**
 * Host lifecycle events, emitted as `'agent-lifecycle'` beside the raw
 * executor events (`'agent-event'`). Names and payloads are the background
 * agent manager's (BackgroundAgentEvent), so a client maps both hosts the
 * same way (design D5 `host` frames).
 *
 * - `agent_starting` → `agent_started` | `agent_start_failed`: one load.
 *   Concurrent loads of one file share one build and one pair of events.
 *   `agent_started` carries `nameChangedFrom` when the load renamed the
 *   agent after its file.
 * - `agent_stopping` → `agent_stopped`: one unload; `agent_stopped` carries
 *   `error` when the teardown failed (the agent is unloaded regardless).
 * - `agent_state_changed`: main's display state; `agent_loops_changed`: the
 *   number of inner loops mid-turn (background-event-mapping.ts).
 * - `trigger_error`: a trigger- or timer-dispatched turn failed. It follows an
 *   `error` agent event and `agent_state_changed` `error` (Studio's two hosts).
 * - `startup_failed`: the startup turn (startAgent) failed.
 */
export type RuntimeLifecycleEventType =
  | 'agent_starting'
  | 'agent_started'
  | 'agent_start_failed'
  | 'agent_stopping'
  | 'agent_stopped'
  | 'agent_loops_changed'
  | 'agent_state_changed'
  | 'trigger_error'
  | 'startup_failed'

export interface RuntimeLifecycleEvent {
  /** Null only on `agent_starting` / `agent_start_failed` before the file's id was read. */
  agentId: string | null
  filePath: string | null
  type: RuntimeLifecycleEventType
  /** Always carries `filePath`; see RuntimeLifecycleEventType for the rest. */
  payload: Record<string, unknown>
  timestamp: number
}

/** The agent file moved while loaded (rekeyAgentPath). */
export interface RuntimeAgentPathChangedEvent {
  agentId: string
  oldFilePath: string
  filePath: string
}

/** An agent file was renamed to follow its agent's name (syncAgentFileToName). */
export interface RuntimeAgentFileRenamedEvent {
  agentId: string | null
  oldFilePath: string
  filePath: string
}

/** syncAgentFileToName outcome; Studio's FILE_RENAME / DOC_SET_AGENT_CONFIG shape. */
export interface RuntimeFileRenameResult {
  /** The new path, when the file was renamed now. */
  filePath?: string
  /** True when the agent is loaded: the rename happens when it unloads. */
  deferred?: boolean
  /** Why nothing was renamed, when something was asked for. */
  error?: string
}

/** preflightProvider outcome: Studio's AGENT_START provider gate. */
export type RuntimeProviderPreflight =
  | {
      ok: true
      /**
       * The agent's own provider key is stored but locked here (password or
       * envelope): not checked, and never reported as a missing key. The
       * sentence says how to unlock it.
       */
      credentialsLocked?: string
    }
  | {
      ok: false
      /** provider_missing: no such provider here; provider_unconfigured: it needs a key it does not have. */
      code?: 'provider_missing' | 'provider_unconfigured'
      error: string
    }

/** A loaded agent's assembled handle, for daemon routes that need more than RuntimeService exposes. */
export interface RuntimeLoadedAgent {
  agentId: string
  filePath: string | null
  agent: RuntimeAgent
  workspace: AdfWorkspace
  /** Legacy-password derived key while the file is unlocked; null otherwise. Never leaves the process. */
  derivedKey: Buffer | null
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

/** A loaded file-backed agent as `listLiveAgents()` returns it. */
export interface RuntimeLiveAgent {
  agentId: string
  filePath: string
  /** The executor's raw state (`thinking`, `idle`, ...). */
  executorState: string
  workspace: AdfWorkspace
  getContextGauge(): { tokens: number; threshold: number } | undefined
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
  /** `details`: extra fields for the HTTP error body (e.g. `candidates`). */
  constructor(message: string, readonly statusCode: 400 | 403 | 404 | 409 | 502, readonly code?: string, readonly details?: Record<string, unknown>) {
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

/**
 * 409 `credentials_locked` for an owner write to a locked credentials
 * envelope (services/locked-credential.ts). The body carries `purpose`,
 * `sealed` (a value is stored sealed: a replace discards it unread) and
 * `envelopeState`, so a client chooses without reading the message.
 */
export function credentialsLockedError(locked: LockedCredential): RuntimeLoopError {
  return new RuntimeLoopError(
    locked.sealed
      ? `This agent's saved "${locked.purpose}" is sealed and its credentials envelope is ${locked.envelopeState} on this daemon, so it can't be read or overwritten. ${CREDENTIALS_UNLOCK_HINT} Or replace it (replace: true): the old value is discarded.`
      : `The credentials envelope of this agent is ${locked.envelopeState} on this daemon — refusing to store "${locked.purpose}" unsealed. ${CREDENTIALS_UNLOCK_HINT} Or store it anyway (replace: true): it is sealed once the envelope unlocks.`,
    409,
    CREDENTIALS_LOCKED_CODE,
    { purpose: locked.purpose, sealed: locked.sealed, envelopeState: locked.envelopeState },
  )
}

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
  /** W3-F: the file's revision, the base of the client's next write. */
  revision: number
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

export type { RuntimeUsageTotals, RuntimeAgentUsageByModel } from './loop-usage'

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
  /**
   * `trigger_message` of a chat whose sending client already shows it (POST
   * /agents/:id/chat `echoed` with X-ADF-Client-Session): that session id.
   * Every other client still gets the event.
   */
  echoOrigin?: string
  /**
   * Turn bookkeeping (design D5): the turn the event belongs to, the
   * `turnId` of the chat that started it (POST /agents/:id/chat) or else
   * the executor's own id; the umbilical envelope's `turn_id` for the same
   * event. Absent for events outside a turn.
   */
  turnId?: string
  /**
   * On `error` and on a `turn_complete` that was not interrupted: the chats
   * this turn answered besides its own (interrupted turns it replayed,
   * queued chats delivered into it); the umbilical `absorbed_turn_ids`.
   */
  absorbedTurnIds?: string[]
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
  /** POST /agents/review/accept: the fields the accept locked against the agent's own edits. */
  lockedFields?: string[]
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
  | 'leased_elsewhere'

export interface RuntimeAutostartSkipped {
  filePath: string
  name: string
  reason: RuntimeAutostartSkipReason
  agentId?: string
  /** leased_elsewhere: which process runs it and what to do. */
  message?: string
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

export type RuntimeAgent = HeadlessAgent | AssembledAgentBase<AgentProfileName>

/** One agent's legacy-password derived key, shared by its record and its build's closures. */
interface DerivedKeyCell {
  current: Buffer | null
}

interface ManagedRuntimeAgent {
  id: string
  filePath: string | null
  config: AgentConfig
  agent: RuntimeAgent
  hostAttachment: HostAttachment
  /** Reads and writes `keyCell.current`. */
  derivedKey: Buffer | null
  keyCell: DerivedKeyCell
  /** Display-state fold for agent_state_changed / agent_loops_changed. */
  display: BackgroundMappingState
  /** Reason the agent is degraded (e.g. locked credential envelopes), if any. */
  degraded?: string
  /** The file's config stamp when `config` was last checked against it (syncManagedConfig). */
  configSeen?: { writes: number; dataVersion: number }
}

/**
 * What a resource method acts on (design D4): a running agent, or an open
 * document that is not running. Both carry the one workspace and key cell
 * of the file; `managed` is set while a runtime runs on it.
 */
interface AgentTarget {
  id: string
  filePath: string | null
  workspace: AdfWorkspace
  keyCell: DerivedKeyCell
  managed: ManagedRuntimeAgent | null
  doc: OpenDocument | null
  readonly config: AgentConfig
}

export class RuntimeReviewRequiredError extends Error {
  readonly code = 'AGENT_REVIEW_REQUIRED'
  constructor(readonly agentId: string, readonly filePath: string) {
    super('Agent must be reviewed before loading into the runtime.')
    this.name = 'RuntimeReviewRequiredError'
  }
}

/** Echo origins kept for chats whose turn has not started yet. */
const ECHO_ORIGINS_KEPT = 256

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
  private readonly agentLeases: AgentLeaseRegistry | null
  /** Agents whose self-off teardown is running (re-entrancy guard, as Studio's handleAgentOff). */
  private readonly offInProgress = new Set<string>()
  /** Renames waiting for the agent at that (canonical) path to unload: path → new name. */
  private readonly pendingRenames = new Map<string, string>()
  /** Unloads in progress, so concurrent stops of one agent share one teardown. */
  private readonly unloads = new Map<string, Promise<void>>()
  /** Open documents (D4): files open for editing, with or without a runtime on them. */
  private readonly documents = new DocumentHost()
  /** Opens in progress, by canonical path, so concurrent opens of one file share one workspace. */
  private readonly inFlightOpens = new Map<string, Promise<OpenDocument>>()
  private documentOpenHooks: RuntimeDocumentOpenHooks = {}
  private holderCheck: ((holder: string) => boolean) | null = null
  /** Documents whose workspace is closed for a move (withDocumentMoved): every use answers 409 file_moving. */
  private readonly movingDocs = new Set<OpenDocument>()
  /** holder → when it last held a document (the TTL of holders without a session check). */
  private readonly holderSeen = new Map<string, number>()
  private holderSweep: ReturnType<typeof setInterval> | null = null
  private readonly documentHoldTtlMs: number

  constructor(opts: RuntimeServiceOptions = {}) {
    super()
    this.settings = opts.settings
    this.providerFactory = opts.providerFactory
    this.basePrompt = opts.basePrompt ?? ''
    this.toolPrompts = opts.toolPrompts ?? {}
    this.compactionPrompt = opts.compactionPrompt
    this.agentRuntimeBuilder = opts.agentRuntimeBuilder
    this.enforceReviewGate = opts.enforceReviewGate ?? true
    this.agentLeases = opts.agentLeases === undefined ? processAgentLeases() : opts.agentLeases
    this.documentHoldTtlMs = opts.documentHoldTtlMs ?? DOCUMENT_HOLD_TTL_MS
    this.agentLeases?.addHostedPathsProbe(() => [...this.filePathToAgentId.keys(), ...this.inFlightLoads.keys()])
  }

  async loadAgent(filePath: string, opts: RuntimeLoadAgentOptions = {}): Promise<RuntimeAgentRef> {
    const canonicalPath = this.canonicalFilePath(filePath)
    const existingId = this.filePathToAgentId.get(canonicalPath)
    if (existingId) return this.toRef(this.requireAgent(existingId))

    // Double-start TOCTOU guard: claim an in-flight slot SYNCHRONOUSLY before
    // any await so concurrent loads of the same file converge on one build.
    const pending = this.inFlightLoads.get(canonicalPath)
    if (pending) return pending

    // The body starts a microtask later, after the slot is claimed: an
    // 'agent-lifecycle' listener that loads the same file from inside
    // agent_starting joins this load instead of starting a second one.
    const load = Promise.resolve().then(() => this.doLoadAgent(canonicalPath, opts))
    this.inFlightLoads.set(canonicalPath, load)
    try {
      return await load
    } finally {
      this.inFlightLoads.delete(canonicalPath)
      // Releases the lease when the load failed (the agent is not registered).
      await this.agentLeases?.reconcile()
    }
  }

  /**
   * Resolves true once a load of `filePath` in flight has finished (or
   * failed), at once when none is; false when it is still loading after
   * `timeoutMs`. A path-addressed write waits for it, so it lands on the
   * loaded agent instead of under its build (design §6.1 row 24).
   */
  async waitForLoad(filePath: string, timeoutMs = 30_000): Promise<boolean> {
    const pending = this.inFlightLoads.get(this.canonicalFilePath(filePath))
    if (!pending) return true
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs) })
    try {
      return await Promise.race([pending.then(() => true, () => true), timedOut])
    } finally {
      clearTimeout(timer)
    }
  }

  private async doLoadAgent(canonicalPath: string, opts: RuntimeLoadAgentOptions): Promise<RuntimeAgentRef> {
    const shouldEnforceReview = opts.enforceReviewGate ?? this.enforceReviewGate
    this.assertReviewGate(canonicalPath, shouldEnforceReview)

    // Background-agent-manager parity: announced before the lease, so every
    // load the review gate admitted ends in agent_started or agent_start_failed.
    this.emitLifecycle(null, canonicalPath, 'agent_starting', {})
    const progress: { agentId: string | null } = { agentId: null }
    try {
      return await this.openAndRegister(canonicalPath, opts, progress)
    } catch (err) {
      this.emitLifecycle(progress.agentId, canonicalPath, 'agent_start_failed', {
        error: err instanceof Error ? err.message : String(err),
        ...(err instanceof RuntimeLoopError && err.code ? { code: err.code } : {}),
      })
      throw err
    }
  }

  private async openAndRegister(canonicalPath: string, opts: RuntimeLoadAgentOptions, progress: { agentId: string | null }): Promise<RuntimeAgentRef> {
    const moving = this.documents.get(canonicalPath)
    if (moving) this.assertNotMoving(moving)
    // AdfWorkspace.open creates a missing database: a load never makes a file.
    else if (!existsSync(canonicalPath)) throw new RuntimeLoopError(`No agent file at ${canonicalPath}`, 404, 'not_found')
    const lease = await this.agentLeases?.acquire(canonicalPath, { agentId: this.documents.get(canonicalPath)?.agentId ?? null })
    if (lease && !lease.ok) {
      throw new RuntimeLoopError(lease.message, 409, AGENT_LEASED_CODE, { holder: lease.record.holder })
    }

    // A start on an open document assembles on its workspace and key cell
    // (D4): one handle on the file, and the key unlocked before the start
    // reaches every consumer from the first connect, as Studio's captured key.
    const doc = this.documents.get(canonicalPath) ?? null
    const workspace = doc ? doc.workspace : AdfWorkspace.open(canonicalPath)
    const writesBefore = doc?.configWrites ?? 0
    let built: RuntimeAgent | null = null
    let registered = false
    try {
      // Before any step writes the file: a second file with a loaded agent's
      // id would otherwise start its MCP servers and adapters only to be
      // refused. The lease was taken before the file was read: it names the
      // agent now, as Studio's start does, and a copy of an agent another
      // runtime runs (same id, another file) is refused (W5-D3).
      const fileConfig = workspace.getAgentConfig() as AgentConfig
      progress.agentId = fileConfig.id
      this.assertNoDuplicateId(fileConfig.id, canonicalPath)
      if (lease?.ok) {
        const idLease = await this.agentLeases?.noteAgentId(canonicalPath, fileConfig.id)
        if (idLease && !idLease.ok) throw new RuntimeLoopError(idLease.message, 409, AGENT_LEASED_CODE, { holder: idLease.record.holder })
      }
      // Opened read-only while another runtime ran it: this start holds the
      // lease now, so the open steps it skipped run first (the name they
      // adopt from the file is the one this start reports).
      let previousName: string | null = null
      if (doc?.readOnly) {
        console.log(`[RuntimeService] ${canonicalPath} is no longer run by another runtime: the document is writable`)
        const opened = this.runDocumentOpenSteps(workspace, canonicalPath)
        doc.config = opened.config
        previousName = opened.nameChangedFrom
        delete doc.readOnly
      }
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
      let config = workspace.getAgentConfig() as AgentConfig
      previousName = this.adoptFileName(workspace, config, canonicalPath) ?? previousName
      const keyCell: DerivedKeyCell = doc ? doc.keyCell : { current: opts.derivedKey ?? null }
      if (doc && !keyCell.current && opts.derivedKey) keyCell.current = opts.derivedKey
      const provider = await this.resolveProvider(config, canonicalPath, opts.provider, workspace, keyCell.current)
      built = await this.buildLoadedAgent(workspace, canonicalPath, config, provider, keyCell)
      // The document keeps the workspace when the runtime stops.
      if (this.documents.get(canonicalPath) === doc && doc) built.setWorkspaceOwnership(false)
      // Studio's pickFresherConfig at install (config-freshness.ts): a config
      // write through the document while the build awaited reached the file
      // but no executor. The running agent adopts the file's config.
      if (doc && doc.configWrites !== writesBefore) {
        const fresh = workspace.getAgentConfig() as AgentConfig
        console.log(`[RuntimeService] ${fresh.name}: adopting the config written while it was starting`)
        built.applyConfigChange(fresh)
        config = fresh
      }
      const ref = this.registerAgent(built, canonicalPath, config, undefined, keyCell)
      built = null // registered: unloadAgent owns it from here
      registered = true
      if (lease?.ok && lease.unprotected) {
        // The lease dir is unusable: the agent runs, and the user is told.
        const event = { type: 'error' as const, payload: { error: lease.unprotected, code: 'LEASES_UNAVAILABLE' }, timestamp: Date.now() }
        this.emit('agent-event', { agentId: ref.id, filePath: canonicalPath, event } satisfies RuntimeAgentEvent)
        withSource('system:lifecycle', ref.id, () => {
          emitUmbilicalEvent({ event_type: 'agent.error', agentId: ref.id, timestamp: event.timestamp, payload: { filePath: canonicalPath, event } })
        })
      }
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
      // Same tick as the host attach in registerAgent, after the start's own
      // error events (BAM order): no executor event can be forwarded before it.
      // The startup turn is startAgent's, which callers run after this resolves.
      this.emitLifecycle(ref.id, canonicalPath, 'agent_started', {
        state: resolveStartInState(config),
        handle: config.handle || deriveHandle(canonicalPath),
        ...(previousName !== null ? { nameChangedFrom: previousName } : {}),
      })
      return ref
    } catch (err) {
      if (built) await disposeRuntimeAgent(built, 'immediate') // owns the workspace unless a document holds it
      else if (!doc) try { workspace.dispose() } catch { /* best effort */ }
      throw err
    } finally {
      if (doc) this.settleDocumentAfterStart(doc, registered)
    }
  }

  /**
   * After a start on an open document. A failed build may have closed the
   * workspace (AgentRuntimeBuilder disposes it on failure): the document
   * reopens its file. A document released while the start ran is closed now,
   * or handed to the runtime that started.
   */
  private settleDocumentAfterStart(doc: OpenDocument, registered: boolean): void {
    if (this.documents.get(doc.filePath) !== doc) return
    const managedId = this.filePathToAgentId.get(doc.filePath)
    const managed = managedId ? this.agents.get(managedId) : undefined
    if (doc.holders.size === 0) {
      this.documents.remove(doc)
      if (registered && managed) {
        managed.agent.setWorkspaceOwnership(true)
      } else {
        try { doc.workspace.dispose() } catch { /* best effort */ }
      }
      console.log(`[RuntimeService] Closed document ${doc.filePath} (released while it was starting)`)
      this.emitSafely('document-closed', { agentId: doc.agentId, filePath: doc.filePath, reason: 'released' } satisfies RuntimeDocumentEvent)
      return
    }
    if (!registered && !isWorkspaceOpen(doc.workspace)) {
      console.warn(`[RuntimeService] ${doc.filePath}: the failed start closed the document's workspace; reopening it`)
      doc.workspace = AdfWorkspace.open(doc.filePath)
      unlockWorkspaceEnvelopes(doc.workspace)
    }
    try { doc.config = doc.workspace.getAgentConfig() as AgentConfig } catch { /* keep the last one */ }
  }

  /**
   * Refuse a second agent with a loaded agent's id: two files with one
   * `config.id` (a copied file) cannot be told apart by id-addressed routes,
   * the mesh or the review list.
   */
  private assertNoDuplicateId(agentId: string, filePath: string | null): void {
    const loaded = this.agents.get(agentId)
    if (loaded) {
      if (loaded.filePath !== null && loaded.filePath === filePath) return // the same file, open as a document
      const where = loaded.filePath ?? 'an in-memory agent'
      throw new RuntimeLoopError(
        `${filePath ?? 'This agent'} has the same agent id (${agentId}) as ${where}, which is already loaded. ` +
          'Stop that agent first, or clone this file (POST /files/clone) and load the clone, which gets an id of its own.',
        409,
        DUPLICATE_AGENT_ID_CODE,
        { agentId, filePath, loadedFilePath: loaded.filePath },
      )
    }
    const open = filePath ? this.documents.withId(agentId, filePath) : undefined
    if (open) {
      throw new RuntimeLoopError(
        `${filePath} has the same agent id (${agentId}) as ${open.filePath}, which is open. ` +
          'Close that file first, or clone this file (POST /files/clone) and open the clone, which gets an id of its own.',
        409,
        DUPLICATE_AGENT_ID_CODE,
        { agentId, filePath, loadedFilePath: open.filePath },
      )
    }
  }

  /**
   * Studio parity (FILE_OPEN, background start): an agent is named after its
   * file, exactly as Studio does it. A rename waiting for this file is the
   * one exception (Studio's FILE_OPEN keeps the pending name). Returns the
   * name it replaced, or null. Logged to the console and the agent's adf_logs.
   */
  private adoptFileName(workspace: AdfWorkspace, config: AgentConfig, filePath: string): string | null {
    const name = this.pendingRenames.get(filePath) ?? basename(filePath, '.adf')
    if (config.name === name) return null
    const previous = config.name
    const message = `Agent name "${previous}" changed to "${name}" to match its file name`
    console.log(`[RuntimeService] ${filePath}: ${message}`)
    config.name = name
    workspace.setAgentConfig(config)
    try { workspace.insertLog('info', 'runtime', 'name_from_file', null, message.slice(0, 500)) } catch { /* non-fatal */ }
    return previous
  }

  /**
   * No agent lease here: createHeadlessAgent creates a brand-new file (or an
   * in-memory agent), so no other process can be running it yet; the harness
   * is the only caller.
   */
  createAgent(opts: RuntimeCreateAgentOptions): RuntimeAgentRef {
    const prompts = this.currentPrompts()
    const agent = createHeadlessAgent({
      ...opts,
      basePrompt: opts.basePrompt ?? prompts.basePrompt,
      toolPrompts: opts.toolPrompts ?? prompts.toolPrompts,
      compactionPrompt: opts.compactionPrompt ?? prompts.compactionPrompt,
    })
    const config = agent.workspace.getAgentConfig() as AgentConfig
    const filePath = opts.filePath ? this.canonicalFilePath(opts.filePath) : null
    let ref: RuntimeAgentRef
    try {
      ref = this.registerAgent(agent, filePath, config, opts.id)
    } catch (err) {
      void disposeRuntimeAgent(agent, 'immediate')
      throw err
    }
    this.emitLifecycle(ref.id, filePath, 'agent_started', {
      state: resolveStartInState(config),
      handle: config.handle || (filePath ? deriveHandle(filePath) : undefined),
    })
    return ref
  }

  /**
   * Stop and unload one agent. Concurrent calls for one agent share one
   * teardown (an owner stop racing the agent's own `off`).
   */
  async unloadAgent(agentId: string, opts: { mode?: AgentStopMode } = {}): Promise<void> {
    const managed = this.resolveAgent(agentId)
    if (!managed) return
    const pending = this.unloads.get(managed.id)
    if (pending) return pending
    const unload = this.doUnloadAgent(managed, opts.mode ?? 'graceful')
    this.unloads.set(managed.id, unload)
    try {
      await unload
    } finally {
      this.unloads.delete(managed.id)
    }
  }

  private async doUnloadAgent(managed: ManagedRuntimeAgent, mode: AgentStopMode): Promise<void> {
    this.emitLifecycle(managed.id, managed.filePath, 'agent_stopping', {})
    managed.hostAttachment.detach()
    let disposeError: unknown = null
    try {
      await disposeRuntimeAgent(managed.agent, mode, true)
    } catch (err) {
      // Unloaded anyway: an agent left registered after a failed dispose
      // could never be stopped or loaded again. Some of its resources may
      // still be running; the error says so.
      disposeError = err
      console.error(`[RuntimeService] Stopping ${managed.filePath ?? managed.id} failed; it is unloaded anyway:`, err)
    }
    this.agents.delete(managed.id)
    if (managed.filePath) this.filePathToAgentId.delete(managed.filePath)
    // Stop keeps a held document open on the same workspace (D4).
    const doc = this.documents.get(managed.filePath)
    if (doc) {
      try { doc.config = doc.workspace.getAgentConfig() as AgentConfig } catch { /* keep the last one */ }
      console.log(`[RuntimeService] ${managed.config.name} stopped; ${managed.filePath} stays open (${doc.holders.size} holder${doc.holders.size === 1 ? '' : 's'})`)
    }
    // The deferred rename runs before the lease is released, so no other
    // process can open the file while it moves (synchronous: nothing between
    // the map removal above and the rename can release the lease). Skipped
    // when the dispose failed: the file may still be open.
    const renamed = managed.filePath && !disposeError ? this.applyPendingRename(managed.id, managed.filePath) : null
    await this.agentLeases?.reconcile()
    // Emit only after dispose settles: consumers (e.g. the daemon's sweep
    // skip-set) treat this event as "the workspace is closed" — emitting
    // before dispose let them touch a workspace that was still open.
    this.emitSafely('agent-unloaded', {
      agentId: managed.id,
      filePath: managed.filePath,
    } satisfies RuntimeAgentUnloadedEvent)
    this.emitLifecycle(managed.id, managed.filePath, 'agent_stopped', disposeError
      ? { error: disposeError instanceof Error ? disposeError.message : String(disposeError) }
      : {})
    if (renamed) this.emitSafely('agent-file-renamed', renamed)
    if (disposeError) throw disposeError
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
    await Promise.allSettled(Array.from(this.inFlightOpens.values()))
    for (const doc of this.documents.list()) this.closeOpenDocument(doc, 'shutdown')
    if (this.holderSweep) { clearInterval(this.holderSweep); this.holderSweep = null }
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
    // Open documents that are not running: their envelopes open now too, so
    // the credential routes read them unlocked without a reopen.
    for (const doc of this.documents.list()) {
      if (this.managedAt(doc.filePath) || detectLockedEnvelopes(doc.workspace).length === 0) continue
      unlockWorkspaceEnvelopes(doc.workspace)
      if (detectLockedEnvelopes(doc.workspace).length === 0) console.log(`[RuntimeService] Credentials of the open document ${doc.filePath} unlocked (${reason})`)
    }
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
      // A provider built while its sealed key was locked is the stub: build the real one.
      if (lockedKeyProviders.has(managed.agent.executor.getProvider() as LLMProvider)) this.rebuildProviderAfterUnlock(managed)
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

  /**
   * Credential reload hook (POST /client/reload-credentials): Studio moved
   * credentials into this daemon's stores without a restart (mode-switch
   * handover). Re-runs the envelope unlock of every degraded agent, and
   * brings loops that failed on a subscription's auth out of `error` for
   * each provider whose session is now here (`signedIn`).
   */
  async reloadCredentials(reason: string, signedIn: Array<{ providerType: string; label: string }> = []): Promise<{ credentials: RuntimeCredentialRefresh[]; recovered: RuntimeAuthRecovery[] }> {
    const credentials = await this.refreshAgentCredentials(reason)
    const recovered = signedIn.flatMap(({ providerType, label }) => this.recoverAuthErroredAgents(providerType, label))
    return { credentials, recovered }
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

  /**
   * `opts.turnId`: correlation id stamped as `turn_id` on the turn's events
   * (AdfEventDispatch.turnId). `opts.content`: the message's content blocks
   * (text, images, audio, video; Studio's AGENT_INVOKE `content`), used
   * instead of `text` when given. `opts.echoOrigin`: the client session that
   * already shows the message (Studio's AGENT_INVOKE); the turn's
   * `trigger_message` carries it as `echoOrigin`, so only that session skips
   * it. Needs `opts.turnId`.
   */
  /**
   * Refuse chat content the loop's model cannot take (a modality turned off,
   * or one its provider does not carry): 400 `media_unsupported`. Run before
   * accepting the chat, so the sender sees why instead of a reply that never
   * saw the attachment.
   */
  assertChatMedia(agentId: string, loop: string | undefined, content: ContentBlock[] | undefined): void {
    if (!content?.length) return
    const managed = this.requireAgent(agentId)
    const name = loop || MAIN_LOOP
    const executor = name === MAIN_LOOP ? managed.agent.executor : managed.agent.loopPool.getRuntime(name)?.executor
    const error = executor?.mediaInputError(content)
    if (error) throw new RuntimeLoopError(error, 400, 'media_unsupported')
  }

  async sendChat(agentId: string, text: string, loop = 'main', opts: { turnId?: string; content?: ContentBlock[]; echoOrigin?: string } = {}): Promise<void> {
    const contentJson: ContentBlock[] = opts.content && opts.content.length > 0 ? opts.content : [{ type: 'text', text }]
    const dispatch = createDispatch(
      createEvent({
        type: 'chat',
        source: 'user',
        data: {
          message: {
            seq: Date.now(),
            role: 'user',
            content_json: contentJson,
            created_at: Date.now(),
          },
        },
      }),
      { scope: 'agent' },
    )
    if (opts.turnId && opts.echoOrigin) this.noteEchoOrigin(opts.turnId, { session: opts.echoOrigin, agentId: this.requireAgent(agentId).id, loop: loop || MAIN_LOOP })
    await this.trigger(agentId, opts.turnId ? { ...dispatch, turnId: opts.turnId } : dispatch, loop)
  }

  /** Chat dispatches whose sender already shows the message: turnId → the client session, and where it runs. Oldest dropped past ECHO_ORIGINS_KEPT. */
  private readonly echoOrigins = new Map<string, { session: string; agentId: string; loop: string }>()

  private noteEchoOrigin(turnId: string, origin: { session: string; agentId: string; loop: string }): void {
    this.echoOrigins.set(turnId, origin)
    while (this.echoOrigins.size > ECHO_ORIGINS_KEPT) this.echoOrigins.delete(this.echoOrigins.keys().next().value!)
  }

  /**
   * The session that sent the chat a `trigger_message` announces — keyed by
   * the turnId of the dispatch that event announces (a queued chat delivered
   * into a running turn announces its own id, not the running turn's). When a
   * turn ends, origins of the dispatches it settled (its own and the ones it
   * absorbed) that were never announced — a skipped trigger on interrupt
   * restart — are dropped so they cannot mask a later event; a stop or off
   * drops the loop's rest (queued chats it discards).
   */
  private takeEchoOrigin(managed: ManagedRuntimeAgent, event: AgentExecutionEvent): string | undefined {
    if (this.echoOrigins.size === 0) return undefined
    const loop = event.loop ?? MAIN_LOOP
    if (event.type === 'state_changed') {
      const state = (event.payload as { state?: unknown } | undefined)?.state
      if (state !== 'stopped' && state !== 'off') return undefined
      for (const [turnId, origin] of this.echoOrigins) if (origin.agentId === managed.id && origin.loop === loop) this.echoOrigins.delete(turnId)
      return undefined
    }
    if (event.type !== 'trigger_message' && event.type !== 'turn_complete' && event.type !== 'error') return undefined
    const executor = loop === MAIN_LOOP ? managed.agent.executor : managed.agent.loopPool.getRuntime(loop)?.executor
    if (!executor) return undefined
    if (event.type !== 'trigger_message') {
      const running = executor.getRunningTurnId()
      if (running) this.echoOrigins.delete(running)
      for (const id of executor.getAbsorbedTurnIds()) this.echoOrigins.delete(id)
      return undefined
    }
    const turnId = executor.getAnnouncingTurnId()
    if (!turnId) return undefined
    const origin = this.echoOrigins.get(turnId)
    if (origin !== undefined) this.echoOrigins.delete(turnId)
    return origin?.session
  }

  /**
   * `opts.hasUserMessage`: a chat is queued behind this start (Studio's
   * AGENT_START from the home composer), so the startup turn skips the
   * active-state greeting, as Studio's foreground start does.
   */
  async startAgent(agentId: string, opts: { hasUserMessage?: boolean } = {}): Promise<boolean> {
    RuntimeGate.resume()
    const managed = this.requireAgent(agentId)
    // A start that raced a stop (the agent is stopping or already torn down)
    // starts nothing: say so instead of answering success without a startup.
    const lifecycle = managed.agent.getLifecycleState()
    if (lifecycle !== 'running') {
      throw new RuntimeLoopError(`Cannot start ${managed.id}: the agent is ${lifecycle}. Start it again.`, 409, 'agent_not_running')
    }
    // Studio parity: dispatch the startup turn fire-and-forget instead of
    // blocking the caller on the agent's entire first LLM turn
    // (BackgroundAgentManager fires it via process.nextTick and does not await).
    const startup = managed.agent.dispatchStartup(opts.hasUserMessage ? { hasUserMessage: true } : undefined)
    startup.catch((err) => {
      console.error(`[RuntimeService] Startup turn error for ${managed.id}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
      if (this.agents.get(managed.id) !== managed) return
      this.emitLifecycle(managed.id, managed.filePath, 'startup_failed', { error: err instanceof Error ? err.message : String(err) })
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

  async startOrLoadAgent(identifier: string, opts: { hasUserMessage?: boolean } = {}): Promise<RuntimeAgentStartResult> {
    let managed = this.resolveAgent(identifier)
    let loaded = false

    if (!managed) {
      // An open document starts on its own workspace (D4).
      const filePath = this.documents.resolve(identifier)?.filePath ?? this.findAgentFile(identifier)
      if (!filePath) throw new Error(`RuntimeService: unknown agent "${identifier}"`)
      const ref = await this.loadAgent(filePath)
      managed = this.requireAgent(ref.id)
      loaded = true
    }

    const startupTriggered = await this.startAgent(managed.id, opts)
    return {
      ref: this.toRef(managed),
      loaded,
      startupTriggered,
    }
  }

  /** The running agent's session id (Studio's AGENT_START answers it); undefined when it does not run. */
  getAgentSessionId(agentId: string): string | undefined {
    return this.resolveAgent(agentId)?.agent.session.getSessionId()
  }

  /** Stop and unload; a held document stays open on the same workspace (D4). A document that is not running: no-op. */
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
    const files = await this.scanAdfFilesAsync(trackedDirs, opts.maxDepth ?? 5)
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
        if (err instanceof RuntimeLoopError && err.code === AGENT_LEASED_CODE) {
          console.warn(`[RuntimeService] Autostart skipped: ${err.message}`)
          return { kind: 'skipped', entry: { filePath, name, reason: 'leased_elsewhere', agentId: boot.agentId, message: err.message } }
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

  private buildReviewSummary(workspace: AdfWorkspace, config: AgentConfig): AgentConfigSummary {
    const owner = this.settings?.getOwnerIdentity?.()
    const settingsDid = (key: string): string => {
      const value = this.settings?.get(key)
      return typeof value === 'string' ? value : ''
    }
    const agentDid = workspace.getDid()
    const ownerAttestation = readAdfAttestations(workspace)
      .find((attestation) => attestation.role === 'owner' && verifyAttestation(attestation, agentDid ? { expectedSubject: agentDid } : undefined))
    return buildConfigSummary(config, deriveReviewIdentity({
      agentDid,
      fileOwnerDid: ownerAttestation?.issuer ?? workspace.getMeta('adf_owner_did') ?? null,
      fileRuntimeDid: workspace.getMeta('adf_runtime_did') ?? null,
      localOwnerDid: owner?.getOwnerDid() ?? settingsDid('ownerDid'),
      localRuntimeDid: owner?.getRuntimeDid() ?? settingsDid('runtimeDid'),
      identityEnvelope: workspace.getEnvelopeState('identity'),
      credentialsEnvelope: workspace.getEnvelopeState('credentials'),
      sharePasswordSet: (workspace.readEnvelopeSlots('credentials') ?? []).some((slot) => slot.type === 'password'),
      filePasswordProtected: workspace.isPasswordProtected(),
      ownerKeyAvailable: owner?.getOwnerEncPrivateKey?.() != null,
    }))
  }

  getReviewInfo(filePath: string): RuntimeReviewInfo {
    return this.withAgentFile(filePath, (workspace, canonicalPath) => {
      const config = workspace.getAgentConfig() as AgentConfig
      return {
        agentId: config.id,
        filePath: canonicalPath,
        reviewed: isConfigReviewed(this.settings?.get('reviewedAgents'), config),
        summary: this.buildReviewSummary(workspace, config),
      }
    })
  }

  acceptReview(filePath: string): RuntimeReviewInfo {
    if (!this.settings?.set) {
      throw new Error('RuntimeService: settings store is read-only; cannot accept agent review.')
    }
    return this.withAgentFile(filePath, (workspace, canonicalPath) => {
      const config = workspace.getAgentConfig() as AgentConfig
      this.settings!.set!('reviewedAgents', markConfigReviewed(this.settings!.get('reviewedAgents'), config))
      return {
        agentId: config.id,
        filePath: canonicalPath,
        reviewed: true,
        summary: this.buildReviewSummary(workspace, config),
      }
    })
  }

  /**
   * Run `fn` on the workspace of an agent file: the running agent's or the
   * open document's when the file is open here (one handle per file), else a
   * temporary one opened for the call (envelopes unlocked) and closed after.
   * `keyCell` is the file's derived-key cell when it is open, null otherwise.
   */
  withAgentFile<T>(filePath: string, fn: (workspace: AdfWorkspace, canonicalPath: string, keyCell: DerivedKeyCell | null) => T): T {
    const canonicalPath = this.canonicalFilePath(filePath)
    const open = this.targetAtPath(canonicalPath)
    if (open) return fn(open.workspace, canonicalPath, open.keyCell)
    if (!existsSync(canonicalPath)) throw new RuntimeLoopError(`No agent file at ${canonicalPath}`, 404, 'not_found')
    const workspace = AdfWorkspace.open(canonicalPath)
    try {
      unlockWorkspaceEnvelopes(workspace)
      return fn(workspace, canonicalPath, null)
    } finally {
      workspace.dispose()
    }
  }

  // --- Open documents (design D4) --------------------------------------------
  //
  // A document is an .adf opened without a runtime: every /agents/:id
  // resource method works on it, none of its timers, triggers or adapters
  // run, the mesh does not see it and autostart does not count it as loaded.
  // Start assembles on its workspace; stop keeps it open while it is held.
  //
  // Lease (W0-C): an open document takes no agent lease. Opening is not
  // running, exactly as embedded Studio's FILE_OPEN takes none, so a file
  // open in one runtime never blocks another runtime from starting it. A
  // start on the document takes the lease as every load does. What the lease
  // protects (one runtime writing a file while another runs it) is kept by
  // the HTTP layer: a write through an open document is refused (409
  // agent_leased) while another live runtime holds the file's lease, as
  // W1-E's writes to closed files are.

  /** Studio's FILE_OPEN identity steps for each newly opened document (the daemon passes its owner identity). */
  setDocumentOpenHooks(hooks: RuntimeDocumentOpenHooks): void {
    this.documentOpenHooks = hooks
  }

  /**
   * W2-B: whether a holder is still a live client session. The holder sweep
   * then releases every holder it does not know; without it a holder expires
   * DOCUMENT_HOLD_TTL_MS after its last hold.
   */
  setDocumentHolderCheck(isLive: ((holder: string) => boolean) | null): void {
    this.holderCheck = isLive
  }

  /** The settings store the runtime reads (review routes fall back to it when the HTTP API has none). */
  getSettingsStore(): RuntimeSettingsStore | undefined {
    return this.settings
  }

  /** The lease registry the loads use (null when leases are off), for the HTTP layer's write check. */
  get agentLeaseRegistry(): AgentLeaseRegistry | null {
    return this.agentLeases
  }

  /**
   * Open `filePath` as a document held by `opts.holder` (a client session),
   * or add the holder to the document already open. A running agent's file
   * becomes a document on the runtime's own workspace. Nothing is started,
   * registered with the mesh or leased. A password-protected file reuses a
   * key this holder unlocked before (Studio's derivedKeyCache); otherwise
   * `needsPassword` tells the client to prompt.
   */
  async openDocument(filePath: string, opts: RuntimeDocumentHoldOptions): Promise<RuntimeOpenDocumentInfo> {
    const holder = requireHolder(opts?.holder)
    const canonicalPath = this.canonicalFilePath(filePath)
    // A load in flight finishes first, so the document joins its workspace.
    const loading = this.inFlightLoads.get(canonicalPath)
    if (loading) await loading.catch(() => {})
    let nameChangedFrom: string | null = null
    let doc = this.documents.get(canonicalPath)
    if (doc) this.assertNotMoving(doc)
    if (doc?.readOnly) {
      nameChangedFrom = await this.recheckReadOnly(doc)
      // The await may have seen it closed or moving.
      doc = this.documents.get(canonicalPath)
      if (doc) this.assertNotMoving(doc)
    }
    if (!doc) {
      const pending = this.inFlightOpens.get(canonicalPath)
      if (pending) {
        doc = await pending
      } else {
        const opening = Promise.resolve().then(() => this.createDocument(canonicalPath))
        const shared = opening.then(r => r.doc)
        shared.catch(() => { /* the opener reports it */ })
        this.inFlightOpens.set(canonicalPath, shared)
        try {
          const created = await opening
          doc = created.doc
          nameChangedFrom = created.nameChangedFrom
        } finally {
          this.inFlightOpens.delete(canonicalPath)
        }
      }
    }
    const first = doc.holders.size === 0
    doc.holders.add(holder)
    this.holderSeen.set(holder, Date.now())
    this.ensureHolderSweep()
    if (doc.workspace.isPasswordProtected() && !doc.keyCell.current) this.restoreCachedKey(doc, holder)
    console.log(`[RuntimeService] ${first ? 'Opened' : 'Holding'} document ${canonicalPath} for ${holder}`)
    if (first) this.emitSafely('document-opened', { agentId: doc.agentId, filePath: doc.filePath } satisfies RuntimeDocumentEvent)
    return { ...this.documentInfo(doc), ...(nameChangedFrom !== null ? { nameChangedFrom } : {}) }
  }

  private async createDocument(canonicalPath: string): Promise<{ doc: OpenDocument; nameChangedFrom: string | null }> {
    const managedId = this.filePathToAgentId.get(canonicalPath)
    const managed = managedId ? this.agents.get(managedId) : undefined
    if (managed) {
      // Running here: the document is the runtime's workspace; stop keeps it.
      managed.agent.setWorkspaceOwnership(false)
      const doc: OpenDocument = {
        agentId: managed.id,
        filePath: canonicalPath,
        workspace: managed.agent.workspace,
        keyCell: managed.keyCell,
        config: managed.agent.workspace.getAgentConfig() as AgentConfig,
        holders: new Set(),
        openedAt: Date.now(),
        configWrites: 0,
      }
      this.documents.add(doc)
      return { doc, nameChangedFrom: null }
    }
    if (!existsSync(canonicalPath)) throw new RuntimeLoopError(`No agent file at ${canonicalPath}`, 404, 'not_found')
    const leasedBy = (await this.documentOpenHooks.leasedElsewhere?.(canonicalPath)) ?? null
    const workspace = AdfWorkspace.open(canonicalPath)
    try {
      let fresh: AgentConfig
      let nameChangedFrom: string | null = null
      if (leasedBy) {
        // Another runtime runs it: none of the open steps below runs (they
        // write the file: envelope re-wraps, restamp, keys, the name).
        console.log(`[RuntimeService] Opened ${canonicalPath} read-only: ${leasedBy}`)
        fresh = workspace.getAgentConfig() as AgentConfig
        this.assertNoDuplicateId(fresh.id, canonicalPath)
      } else {
        ({ config: fresh, nameChangedFrom } = this.runDocumentOpenSteps(workspace, canonicalPath))
      }
      const doc: OpenDocument = {
        agentId: fresh.id,
        filePath: canonicalPath,
        workspace,
        keyCell: { current: null },
        config: fresh,
        holders: new Set(),
        openedAt: Date.now(),
        configWrites: 0,
        ...(leasedBy ? { readOnly: leasedBy } : {}),
      }
      this.documents.add(doc)
      return { doc, nameChangedFrom }
    } catch (err) {
      try { workspace.dispose() } catch { /* best effort */ }
      throw err
    }
  }

  /** The open steps that write the file (skipped while another runtime runs it). */
  private runDocumentOpenSteps(workspace: AdfWorkspace, canonicalPath: string): { config: AgentConfig; nameChangedFrom: string | null } {
    unlockWorkspaceEnvelopes(workspace)
    const config = workspace.getAgentConfig() as AgentConfig
    this.assertNoDuplicateId(config.id, canonicalPath)
    const reviewed = isConfigReviewed(this.settings?.get('reviewedAgents'), config)
    try {
      this.documentOpenHooks.onOpen?.(workspace, { filePath: canonicalPath, reviewed })
    } catch (err) {
      console.warn(`[RuntimeService] Identity steps on open failed for ${canonicalPath}:`, err)
    }
    const fresh = workspace.getAgentConfig() as AgentConfig
    const nameChangedFrom = this.adoptFileName(workspace, fresh, canonicalPath)
    this.surfaceFileProviders(fresh)
    this.sweepOrphanedWal(dirname(canonicalPath))
    return { config: fresh, nameChangedFrom }
  }

  /**
   * A document opened read-only asks the lease again on each open: once the
   * other runtime has let the file go, the skipped open steps run and the
   * document is writable. Returns the name it adopted from the file, if any.
   */
  private async recheckReadOnly(doc: OpenDocument): Promise<string | null> {
    if (this.managedAt(doc.filePath)) return null
    const leasedBy = (await this.documentOpenHooks.leasedElsewhere?.(doc.filePath)) ?? null
    if (!doc.readOnly || this.documents.get(doc.filePath) !== doc || this.movingDocs.has(doc)) return null
    if (leasedBy) {
      doc.readOnly = leasedBy
      return null
    }
    console.log(`[RuntimeService] ${doc.filePath} is no longer run by another runtime: the document is writable`)
    const { config, nameChangedFrom } = this.runDocumentOpenSteps(doc.workspace, doc.filePath)
    doc.config = config
    delete doc.readOnly
    return nameChangedFrom
  }

  /**
   * Studio's FILE_OPEN surfaces an agent's own providers in app settings
   * (no key; `credentialStorage: 'agent'`) so the provider pickers list them.
   */
  private surfaceFileProviders(config: AgentConfig): void {
    if (!config.providers?.length || !this.settings?.set) return
    const appProviders = [...((this.settings.get('providers') as ProviderConfig[] | undefined) ?? [])]
    const known = new Set(appProviders.map(p => p.id))
    const added = config.providers.filter(p => !known.has(p.id))
    if (added.length === 0) return
    for (const entry of added) appProviders.push({ ...(entry as unknown as ProviderConfig), apiKey: '', credentialStorage: 'agent' } as ProviderConfig)
    this.settings.set('providers', appProviders)
    console.log(`[RuntimeService] Added ${config.name}'s own provider${added.length === 1 ? '' : 's'} to settings: ${added.map(p => p.id).join(', ')}`)
  }

  /** Studio's FILE_OPEN orphan sweep of the folder, deferred off the request (sidecars of open files are skipped). */
  private sweepOrphanedWal(dir: string): void {
    setTimeout(() => {
      try { AdfDatabase.cleanupOrphanedWalFiles(dir, AdfDatabase.openFilePaths()) } catch { /* best effort */ }
    }, 0).unref?.()
  }

  /** A key this holder unlocked the file with before, if it still opens the file. */
  private restoreCachedKey(doc: OpenDocument, holder: string): void {
    const cached = this.documents.cachedKey(holder, doc.filePath)
    if (!cached) return
    if (!doc.workspace.verifyDerivedKey(cached)) {
      this.documents.forgetKey(doc.filePath)
      console.log(`[RuntimeService] ${doc.filePath}: the remembered file-password key no longer opens it; the password is asked again`)
      return
    }
    doc.keyCell.current = cached
    console.log(`[RuntimeService] ${doc.filePath}: unlocked with the key ${holder} unlocked it with before`)
    const managed = this.managedAt(doc.filePath)
    if (managed) {
      this.rebuildProviderAfterUnlock(managed)
      this.propagateDerivedKey(managed)
    }
  }

  /**
   * Release `holder`'s hold on a document (by id, handle, name or path). The
   * last release closes it, unless a runtime runs on it: the runtime then owns
   * the workspace and the document is gone. The holder remembers an unlocked
   * key for its next open.
   */
  async releaseDocument(identifier: string, holder: string): Promise<{ agentId: string; filePath: string; released: boolean; closed: boolean }> {
    const doc = this.documentFor(identifier)
    if (!doc) throw new RuntimeLoopError(`No open document "${identifier}"`, 404, 'not_found')
    const released = doc.holders.delete(holder)
    let closed = false
    if (doc.holders.size === 0) closed = this.closeOpenDocument(doc, 'released')
    if (released) console.log(`[RuntimeService] ${holder} released ${doc.filePath}${closed ? ' (closed)' : ''}`)
    return { agentId: doc.agentId, filePath: doc.filePath, released, closed }
  }

  /**
   * A client session ended (W2-B's expiry hook): every document it holds is
   * released and the keys it unlocked are forgotten. Returns the agent ids
   * of the documents it held.
   */
  async releaseDocumentHolder(holder: string): Promise<string[]> {
    const held = this.documents.heldBy(holder)
    for (const doc of held) {
      doc.holders.delete(holder)
      if (doc.holders.size === 0) this.closeOpenDocument(doc, 'released')
    }
    this.documents.dropHolder(holder)
    this.holderSeen.delete(holder)
    if (held.length > 0) console.log(`[RuntimeService] ${holder} ended; released ${held.map(d => d.filePath).join(', ')}`)
    return held.map(d => d.agentId)
  }

  /**
   * Release holders that are gone: with a session check (W2-B's
   * setDocumentHolderCheck), every holder it does not know; without one, holders that
   * held nothing for documentHoldTtlMs. A document pinned by a client that
   * never releases it closes this way. Returns the released holders.
   */
  async sweepDocumentHolders(now = Date.now()): Promise<string[]> {
    const holders = new Set(this.documents.list().flatMap(doc => [...doc.holders]))
    const check = this.holderCheck
    const gone = [...holders].filter(holder => check ? !check(holder) : now - (this.holderSeen.get(holder) ?? 0) >= this.documentHoldTtlMs)
    for (const holder of gone) {
      console.log(`[RuntimeService] Holder ${holder} is no longer a live session; releasing its documents`)
      await this.releaseDocumentHolder(holder)
    }
    if (this.documents.list().length === 0 && this.holderSweep) {
      clearInterval(this.holderSweep)
      this.holderSweep = null
    }
    return gone
  }

  /**
   * A request from `holder` (its X-ADF-Client-Session header) on this
   * document: the holder is in use, so the sweep's idle clock restarts. A
   * holder that does not hold the document is not refreshed.
   */
  touchDocumentHolder(holder: string, identifier: string): boolean {
    const doc = this.documentFor(identifier)
    if (!doc?.holders.has(holder)) return false
    this.holderSeen.set(holder, Date.now())
    return true
  }

  private ensureHolderSweep(): void {
    if (this.holderSweep) return
    this.holderSweep = setInterval(() => { void this.sweepDocumentHolders() }, Math.max(1000, Math.min(15_000, this.documentHoldTtlMs / 4)))
    this.holderSweep.unref?.()
  }

  /**
   * Close a document for every holder (its file is being deleted). A runtime
   * on it keeps running on the workspace. False when the file is not open.
   */
  closeDocument(filePath: string, reason: 'deleted' | 'released' = 'deleted'): boolean {
    const doc = this.documents.get(this.loadedDocumentPath(filePath))
    if (!doc) return false
    doc.holders.clear()
    return this.closeOpenDocument(doc, reason)
  }

  /**
   * A move of an open document's file that the caller performs (accept-
   * relocate): the document's workspace is closed for it and reopened where
   * the file went (`movedTo`, else the old path), keeping its holders and key.
   * Without an open document `move` just runs. Refused while a runtime runs
   * on the file: it cannot move under a live executor.
   */
  async withDocumentMoved<T>(filePath: string, move: () => Promise<{ value: T; movedTo: string | null }>): Promise<T> {
    const doc = this.documents.get(this.loadedDocumentPath(filePath))
    if (!doc) return (await move()).value
    if (this.managedAt(doc.filePath) || this.inFlightLoads.has(doc.filePath)) {
      throw new RuntimeLoopError(`${doc.config.name} is running; its file cannot move now.`, 409, 'agent_running')
    }
    // Until it reopens, every route, start or open of it answers 409 file_moving
    // (its workspace is closed; the file is at neither path for a while).
    this.movingDocs.add(doc)
    try { doc.workspace.checkpoint() } catch { /* the close checkpoints too */ }
    try { doc.workspace.close() } catch (err) { console.warn(`[RuntimeService] Closing ${doc.filePath} for its move failed:`, err) }
    let movedTo: string | null = null
    try {
      const result = await move()
      movedTo = result.movedTo
      return result.value
    } finally {
      this.movingDocs.delete(doc)
      const at = movedTo ? this.canonicalFilePath(movedTo) : doc.filePath
      const stillOpen = this.documents.get(doc.filePath) === doc
      if (stillOpen && at !== doc.filePath) this.documents.rekey(doc.filePath, at)
      if (stillOpen) try {
        if (!existsSync(at)) throw new Error(`no file at ${at}`) // never create one by reopening
        doc.workspace = AdfWorkspace.open(at)
        unlockWorkspaceEnvelopes(doc.workspace)
        doc.config = doc.workspace.getAgentConfig() as AgentConfig
        if (at !== filePath) console.log(`[RuntimeService] Document moved: ${filePath} → ${at}`)
      } catch (err) {
        console.error(`[RuntimeService] Reopening ${at} after its move failed; the document is closed:`, err)
        this.documents.remove(doc)
        this.emitSafely('document-closed', { agentId: doc.agentId, filePath: at, reason: 'released' } satisfies RuntimeDocumentEvent)
      }
    }
  }

  /** True when the document closed now; false when a start in flight closes it later, or a runtime took it. */
  private closeOpenDocument(doc: OpenDocument, reason: RuntimeDocumentEvent['reason']): boolean {
    if (this.inFlightLoads.has(doc.filePath)) return false // settleDocumentAfterStart closes or hands it over
    this.documents.remove(doc)
    const managed = this.managedAt(doc.filePath)
    if (this.movingDocs.has(doc)) {
      // Its workspace is closed for the move; withDocumentMoved does not reopen a removed document.
      console.log(`[RuntimeService] ${doc.filePath} was released while it moved; it stays closed`)
    } else if (managed) {
      managed.agent.setWorkspaceOwnership(true)
      console.log(`[RuntimeService] ${doc.filePath} is no longer open; ${managed.config.name} keeps running`)
    } else {
      try { doc.workspace.dispose() } catch (err) { console.warn(`[RuntimeService] Closing ${doc.filePath} failed:`, err) }
      // A rename asked for while it ran and was applied at stop could not
      // move an open file; it moves now.
      const pendingName = this.pendingRenames.get(doc.filePath)
      if (pendingName !== undefined) {
        const renamed = this.applyPendingRename(doc.agentId, doc.filePath)
        if (renamed) this.emitSafely('agent-file-renamed', renamed)
      }
    }
    this.emitSafely('document-closed', { agentId: doc.agentId, filePath: doc.filePath, reason } satisfies RuntimeDocumentEvent)
    return !managed
  }

  /** One open document, by id, handle, name or path. */
  getOpenDocument(identifier: string): RuntimeOpenDocumentInfo | undefined {
    const doc = this.documentFor(identifier)
    return doc ? this.documentInfo(doc) : undefined
  }

  listOpenDocuments(): RuntimeOpenDocumentInfo[] {
    return this.documents.list().map(doc => this.documentInfo(doc))
  }

  /** True while the file of this open document (id, handle, name or path) is being moved. */
  isFileMoving(identifier: string): boolean {
    const doc = this.documentFor(identifier)
    return !!doc && this.movingDocs.has(doc)
  }

  private assertNotMoving(doc: OpenDocument): void {
    if (!this.movingDocs.has(doc)) return
    throw new RuntimeLoopError(`${doc.config.name}'s file is being moved; try again in a moment.`, 409, 'file_moving', { agentId: doc.agentId, filePath: doc.filePath })
  }

  /** The holders of a document (W2-B lists a session's documents from its own side). */
  documentHolders(identifier: string): string[] {
    return [...(this.documentFor(identifier)?.holders ?? [])]
  }

  private documentInfo(doc: OpenDocument): RuntimeOpenDocumentInfo {
    return {
      agentId: doc.agentId,
      filePath: doc.filePath,
      name: this.managedAt(doc.filePath)?.config.name ?? doc.config.name,
      running: this.managedAt(doc.filePath) !== undefined,
      needsPassword: !this.movingDocs.has(doc) && doc.workspace.isPasswordProtected() && !doc.keyCell.current,
      holders: doc.holders.size,
      ...(doc.readOnly ? { readOnly: doc.readOnly } : {}),
    }
  }

  private documentFor(identifier: string): OpenDocument | undefined {
    if (identifier.endsWith('.adf')) {
      const byPath = this.documents.get(this.loadedDocumentPath(identifier))
      if (byPath) return byPath
    }
    return this.documents.resolve(identifier)
  }

  /** The key under which `filePath` is open as a document, comparing spellings like loadedPathFor. */
  private loadedDocumentPath(filePath: string): string {
    const canonical = this.canonicalFilePath(filePath)
    if (this.documents.get(canonical)) return canonical
    const key = pathKey(canonical)
    for (const doc of this.documents.list()) if (pathKey(doc.filePath) === key) return doc.filePath
    return canonical
  }

  private managedAt(filePath: string): ManagedRuntimeAgent | undefined {
    const id = this.filePathToAgentId.get(filePath)
    return id ? this.agents.get(id) : undefined
  }

  /** A running agent or an open document (D4), by id, handle or name. */
  getAgentOrDocument(identifier: string): RuntimeAgentTargetRef | undefined {
    const target = this.resolveTarget(identifier)
    return target ? { id: target.id, filePath: target.filePath, config: target.config, running: target.managed !== null } : undefined
  }

  /** The workspace the resource routes act on (running agent or open document); the key never leaves the process. */
  getAgentWorkspace(identifier: string): RuntimeAgentWorkspace | undefined {
    const target = this.resolveTarget(identifier)
    return target ? this.toWorkspaceRef(target) : undefined
  }

  /** The same, for the file at `filePath` (canonical compare), when it is open here. */
  getAgentWorkspaceByPath(filePath: string): RuntimeAgentWorkspace | undefined {
    const target = this.targetAtPath(this.canonicalFilePath(filePath))
    return target ? this.toWorkspaceRef(target) : undefined
  }

  private toWorkspaceRef(target: AgentTarget): RuntimeAgentWorkspace {
    return { agentId: target.id, filePath: target.filePath, workspace: target.workspace, derivedKey: target.keyCell.current, running: target.managed !== null }
  }

  /** Status of a running agent, or of an open document (runtimeState `stopped`). */
  getAgentOrDocumentStatus(identifier: string): RuntimeTargetStatus | undefined {
    const target = this.resolveTarget(identifier)
    if (!target) return undefined
    if (target.managed) {
      const agent = target.managed.agent
      const media: Record<string, LoopMedia> = { [MAIN_LOOP]: agent.executor.getLoopMedia() }
      for (const runtime of agent.loopPool.getRuntimes()) media[runtime.name] = runtime.executor.getLoopMedia()
      return { ...this.toStatus(target.managed), running: true, sessionId: agent.session.getSessionId(), loopStates: agent.loopPool.sideLoopStates(), media }
    }
    const config = target.config
    return {
      id: target.id,
      filePath: target.filePath,
      name: config.name,
      handle: config.handle,
      autostart: config.autostart ?? false,
      runtimeState: 'stopped',
      targetState: null,
      loopCount: target.workspace.getLoopCount(),
      running: false,
    }
  }

  /** Studio's DOC_GET_HEADER. */
  getAgentHeader(agentId: string): RuntimeAgentHeader {
    const target = this.requireTarget(agentId)
    return {
      agentId: target.id,
      document: target.workspace.readDocument(),
      agentConfig: target.workspace.getAgentConfig() as AgentConfig,
      statusText: target.workspace.getMeta('status') ?? '',
    }
  }

  /** Studio's DOC_GET_BATCH: header, token figures and main's last 200 display entries in one read. */
  getAgentBatch(agentId: string): RuntimeAgentBatch {
    const target = this.requireTarget(agentId)
    const workspace = target.workspace
    // A running agent's buffered loop writes first, so the page has mid-turn entries.
    try { target.managed?.agent.session.flushToLoop?.() } catch { /* best effort */ }
    const total = workspace.getLoopCount()
    const offset = Math.max(0, total - CHAT_DISPLAY_LIMIT)
    const entries = offset > 0 ? workspace.getLoopPaginated(CHAT_DISPLAY_LIMIT, offset) : workspace.getLoop()
    return {
      ...this.getAgentHeader(target.id),
      configRevision: configRevision(workspace).revision,
      documentRevision: documentRevision(workspace).revision,
      // lastTokens is the newest assistant row's billing breakdown; the gauge
      // shows contextBaseline (after a compaction the two disagree, and the
      // baseline wins), as Studio's DOC_GET_BATCH.
      lastTokens: workspace.getLastAssistantTokens(),
      contextBaseline: workspace.getContextBaseline() ?? null,
      chat: { version: 1, uiLog: parseLoopToDisplay(entries), llmMessages: [], earlierCount: offset, total },
    }
  }

  /** Studio's FILE_SAVE: fold the WAL into the .adf (SQLite persists every write anyway). */
  checkpointAgent(agentId: string): { agentId: string; success: true } {
    const target = this.requireTarget(agentId)
    target.workspace.checkpoint()
    return { agentId: target.id, success: true }
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
    const target = this.requireTarget(agentId)
    const loop = this.targetLoopName(target, opts.loop)
    const workspace = target.workspace.forLoop(loop)
    const total = workspace.getLoopCount()
    const limit = clampInteger(opts.limit ?? 50, 1, 500)
    const offset = opts.offset === undefined
      ? Math.max(0, total - limit)
      : clampInteger(opts.offset, 0, Math.max(0, total))
    const entries = workspace.getLoopPaginated(limit, offset)
    return { agentId: target.id, loop, total, limit, offset, entries }
  }

  // --- Cognition loops (docs/design/agent-loops-mvp.md) ----------------------
  //
  // Every mutation goes through the agent's LoopPool — the one path that
  // validates, attenuates, persists and archives — never through a raw config
  // write. Validation mirrors `loop_manage` so the owner gets the same rules
  // (and the same sentences) the agent does.

  listAgentLoops(agentId: string): { agentId: string; loops: RuntimeAgentLoopInfo[] } {
    const target = this.requireTarget(agentId)
    const managed = target.managed
    if (!managed) return { agentId: target.id, loops: this.documentLoops(target) }
    return {
      agentId: managed.id,
      loops: managed.agent.loopPool.listLoops().map(info => this.toLoopInfo(managed, info)),
    }
  }

  getAgentLoopInfo(agentId: string, name: string): RuntimeAgentLoopInfo {
    const target = this.requireTarget(agentId)
    if (!target.managed) {
      const loop = this.targetLoopName(target, name)
      return this.documentLoops(target).find(l => l.name === loop)!
    }
    const loop = this.requireLoopName(target.managed, name)
    return this.loopInfoByName(target.managed, loop)
  }

  /** Main and the declared loops of an open document: nothing runs, so every loop is idle with no live tools. */
  private documentLoops(target: AgentTarget): RuntimeAgentLoopInfo[] {
    const config = target.config
    const main: RuntimeAgentLoopInfo = {
      name: MAIN_LOOP,
      goal: summarizeMainGoal(config.instructions ?? ''),
      status: 'idle',
      enabled: true,
      isMain: true,
      config: null,
      entryCount: target.workspace.forLoop(MAIN_LOOP).getLoopCount(),
      effectiveTools: null,
    }
    const side = (config.loops ?? []).map<RuntimeAgentLoopInfo>(loop => ({
      name: loop.name,
      goal: loop.goal,
      status: 'idle',
      enabled: loop.enabled !== false,
      isMain: false,
      config: loop,
      entryCount: target.workspace.forLoop(loop.name).getLoopCount(),
      effectiveTools: null,
    }))
    return [main, ...side]
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

  getAgentConfig(agentId: string): { agentId: string; config: AgentConfig; revision: number } {
    const target = this.requireTarget(agentId)
    if (target.managed) {
      // One read: the revision is that of the content handed out, so a save
      // with it as baseRevision never lands over a change it did not see.
      const config = this.syncManagedConfig(target.managed, { reread: true })
      return { agentId: target.id, config, revision: configRevisionOf(target.workspace, config).revision }
    }
    const revision = configRevision(target.workspace).revision
    // An open document's config is the file's (another handle may have written it).
    const doc = target.doc!
    doc.config = doc.workspace.getAgentConfig() as AgentConfig
    return { agentId: target.id, config: doc.config, revision }
  }

  /**
   * Save the agent's config. On a running agent: through its config-change
   * choke point. On an open document: to the file only (nothing runs), and
   * the file follows a name change now (Studio's DOC_SET_AGENT_CONFIG →
   * syncAgentFileToName; `filePath` is the new path). A write that lands
   * while a start on the document is building is adopted by that start.
   *
   * `baseRevision` (W3-F): save only over that revision of the config; any
   * other current revision refuses the save with `409 stale_revision`.
   * Without it the save replaces whatever is there (last write wins).
   */
  async setAgentConfig(agentId: string, config: AgentConfig, opts: { baseRevision?: number } = {}): Promise<{ agentId: string; success: true; config: AgentConfig; revision: number; filePath?: string; renameDeferred?: boolean; renameError?: string }> {
    const target = this.requireTarget(agentId)
    this.assertBaseRevision('config', configRevision(target.workspace), opts.baseRevision, null)
    if (!target.managed) {
      const doc = target.doc!
      stripLoopNameMarker(config)
      doc.workspace.setAgentConfig(config)
      doc.config = config
      doc.configWrites++
      const revision = configRevision(doc.workspace, currentResourceWriter()).revision
      const rename = this.syncAgentFileToName(doc.filePath, config.name)
      return {
        agentId: target.id,
        success: true,
        config,
        revision,
        ...(rename.filePath ? { filePath: rename.filePath } : {}),
        ...(rename.deferred ? { renameDeferred: true } : {}),
        ...(rename.error ? { renameError: rename.error } : {}),
      }
    }
    const managed = target.managed
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
    // Taken before the change fans out, so its config_changed frame names this write's writer.
    const revision = configRevision(managed.agent.workspace, currentResourceWriter()).revision
    managed.agent.applyConfigChange(config)

    if (providerSelectionChanged(previousConfig, config) && this.providerFactory) {
      const provider = await this.agentProvider(config, managed.filePath, managed.agent.workspace, managed.derivedKey)
      managed.agent.executor.updateProvider(provider)
    }

    return { agentId: managed.id, success: true, config, revision }
  }

  /**
   * W3-F: refuse a write whose base revision is not the resource's current
   * one (409 stale_revision, with the current revision, its writer, size and
   * hash). No base: nothing to check.
   */
  private assertBaseRevision(resource: string, current: ResourceRevision, base: number | undefined, size: number | null): void {
    const stale = staleRevision(resource, current, base, size)
    if (stale) throw new RuntimeLoopError(staleRevisionMessage(stale), 409, 'stale_revision', { ...stale })
  }

  /**
   * The agent's tool catalog: every built-in tool main's registry holds, every
   * MCP tool its servers advertise, and every declared tool, each with its
   * declared state (enabled / visible / restricted / locked), source and
   * description. The same list `sys_get_config` gives the agent (read-only;
   * change tools with PUT /config).
   */
  getAgentTools(agentId: string): { agentId: string; tools: ToolDiscoveryEntry[] } {
    const target = this.requireTarget(agentId)
    // An open document has no registry: its declared tools only.
    return { agentId: target.id, tools: buildToolDiscovery(target.config, target.managed?.agent.registry ?? null) }
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

  getAgentDocument(agentId: string): { agentId: string; content: string; revision: number } {
    const target = this.requireTarget(agentId)
    const content = target.workspace.readDocument()
    return { agentId: target.id, content, revision: documentRevision(target.workspace).revision }
  }

  setAgentDocument(agentId: string, content: string, opts: { baseRevision?: number } = {}): { agentId: string; success: true; revision: number } {
    const target = this.requireTarget(agentId)
    const previousContent = target.workspace.readDocument()
    this.assertBaseRevision('document', documentRevision(target.workspace), opts.baseRevision, Buffer.byteLength(previousContent, 'utf-8'))
    target.workspace.writeDocument(content)
    const revision = documentRevision(target.workspace, currentResourceWriter()).revision
    // Only a running agent has triggers to fire (an open document runs none).
    target.managed?.agent.triggerEvaluator?.onDocumentEdit(content, previousContent)
    return { agentId: target.id, success: true, revision }
  }

  getAgentMind(agentId: string): { agentId: string; content: string; revision: number } {
    const target = this.requireTarget(agentId)
    return { agentId: target.id, content: target.workspace.readMind(), revision: fileRevision(target.workspace, 'mind.md').revision }
  }

  setAgentMind(agentId: string, content: string, opts: { baseRevision?: number } = {}): { agentId: string; success: true; revision: number } {
    const target = this.requireTarget(agentId)
    this.assertBaseRevision('mind.md', fileRevision(target.workspace, 'mind.md'), opts.baseRevision, target.workspace.getFileMeta('mind.md')?.size ?? null)
    target.workspace.writeMind(content)
    return { agentId: target.id, success: true, revision: fileRevision(target.workspace, 'mind.md', currentResourceWriter()).revision }
  }

  getAgentChat(agentId: string, limit = 200, loop?: string): { agentId: string; loop: string; chatHistory: { version: number; uiLog: unknown[]; llmMessages: unknown[]; total: number; earlierCount: number } | null } {
    const target = this.requireTarget(agentId)
    const loopName = this.targetLoopName(target, loop)
    const workspace = target.workspace.forLoop(loopName)
    const total = workspace.getLoopCount()
    if (total === 0) return { agentId: target.id, loop: loopName, chatHistory: null }
    const clampedLimit = clampInteger(limit, 1, 500)
    const offset = Math.max(0, total - clampedLimit)
    const loopEntries = offset > 0
      ? workspace.getLoopPaginated(clampedLimit, offset)
      : workspace.getLoop()
    return {
      agentId: target.id,
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

  /**
   * Studio's DOC_GET_CHAT_OLDER: the display entries of one loop older than
   * `beforeSeq` (keyset, stable while the agent appends, unlike offsets).
   * `earlierCount` is how many rows of that loop come before the page.
   */
  getAgentChatBefore(agentId: string, beforeSeq: number, opts: { limit?: number; loop?: string } = {}): RuntimeAgentChatPage {
    const target = this.requireTarget(agentId)
    const loopName = this.targetLoopName(target, opts.loop)
    const limit = clampInteger(opts.limit ?? CHAT_DISPLAY_LIMIT, 1, 500)
    // Within this loop's stream: seq is global, so an unscoped page would interleave sibling loops.
    const workspace = target.workspace.forLoop(loopName)
    const entries = workspace.getLoopBefore(beforeSeq, limit)
    const earlierCount = entries.length > 0 ? workspace.getLoopCountBefore(entries[0].seq) : 0
    return { agentId: target.id, loop: loopName, uiLog: parseLoopToDisplay(entries), earlierCount }
  }

  async clearAgentChat(agentId: string, loop?: string): Promise<{ agentId: string; loop: string; success: true }> {
    const target = this.requireTarget(agentId)
    if (!target.managed) {
      // Nothing runs: the rows go, there is no session to reset.
      const loopName = this.targetLoopName(target, loop)
      await target.workspace.forLoop(loopName).clearLoop()
      return { agentId: target.id, loop: loopName, success: true }
    }
    const managed = target.managed
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
    const target = this.requireTarget(agentId)
    return { agentId: target.id, files: target.workspace.listFiles() }
  }

  getAgentFile(agentId: string, path: string): RuntimeAgentFileContent | null {
    const target = this.requireTarget(agentId)
    const meta = target.workspace.getFileMeta(path)
    const content = target.workspace.readFileBuffer(path)
    if (!meta || !content) return null
    const textLike = isTextLike(meta.mime_type, path)
    return {
      agentId: target.id,
      // The bytes just read, hashed once (no second read).
      revision: observeRevision(target.workspace, fileRevisionKey(path), content).revision,
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

  writeAgentFile(agentId: string, path: string, opts: { content?: string; contentBase64?: string; mimeType?: string; protection?: FileProtectionLevel; baseRevision?: number; mustNotExist?: boolean }): { agentId: string; success: true; revision: number } {
    const target = this.requireTarget(agentId)
    const current = fileRevision(target.workspace, path)
    const size = target.workspace.getFileMeta(path)?.size ?? null
    // W3-F: a create refuses to replace a file someone else made meanwhile.
    const exists = opts.mustNotExist ? existsAlready(path, current, size) : null
    if (exists) throw new RuntimeLoopError(staleRevisionMessage(exists), 409, 'stale_revision', { ...exists })
    this.assertBaseRevision(path, current, opts.baseRevision, size)
    if (opts.contentBase64 !== undefined) {
      runAsApiWrite(target.id, () => {
        target.workspace.writeFileBuffer(path, Buffer.from(opts.contentBase64!, 'base64'), opts.mimeType)
      })
    } else {
      const content = opts.content ?? ''
      runAsApiWrite(target.id, () => {
        target.workspace.writeFile(path, content, opts.protection)
      })
    }
    return { agentId: target.id, success: true, revision: fileRevision(target.workspace, path, currentResourceWriter()).revision }
  }

  deleteAgentFile(agentId: string, path: string): { agentId: string; success: boolean } {
    const target = this.requireTarget(agentId)
    return {
      agentId: target.id,
      success: runAsApiWrite(target.id, () => target.workspace.deleteFile(path)),
    }
  }

  renameAgentFile(agentId: string, oldPath: string, newPath: string): { agentId: string; success: boolean } {
    const target = this.requireTarget(agentId)
    return {
      agentId: target.id,
      success: runAsApiWrite(target.id, () => target.workspace.renameInternalFile(oldPath, newPath)),
    }
  }

  renameAgentFolder(agentId: string, oldPrefix: string, newPrefix: string): { agentId: string; success: true; count: number } {
    const target = this.requireTarget(agentId)
    const count = runAsApiWrite(target.id, () => target.workspace.renameFolder(oldPrefix, newPrefix))
    return { agentId: target.id, success: true, count }
  }

  setAgentFileProtection(agentId: string, path: string, protection: FileProtectionLevel): { agentId: string; success: boolean } {
    const target = this.requireTarget(agentId)
    return { agentId: target.id, success: target.workspace.setFileProtection(path, protection) }
  }

  setAgentFileAuthorized(agentId: string, path: string, authorized: boolean): { agentId: string; success: boolean } {
    const target = this.requireTarget(agentId)
    return { agentId: target.id, success: target.workspace.setFileAuthorized(path, authorized) }
  }

  getAgentInbox(agentId: string, status?: InboxStatus): { agentId: string; messages: InboxMessage[] } {
    const target = this.requireTarget(agentId)
    return { agentId: target.id, messages: target.workspace.getInbox(status) }
  }

  clearAgentInbox(agentId: string): { agentId: string; success: true; deleted: number } {
    const target = this.requireTarget(agentId)
    const result = target.workspace.deleteInboxByFilter({})
    return { agentId: target.id, success: true, deleted: result.deleted }
  }

  getAgentOutbox(agentId: string, status?: OutboxStatus): { agentId: string; messages: OutboxMessage[] } {
    const target = this.requireTarget(agentId)
    return { agentId: target.id, messages: target.workspace.getOutbox(status) }
  }

  getAgentTimers(agentId: string): { agentId: string; timers: Timer[] } {
    const target = this.requireTarget(agentId)
    return { agentId: target.id, timers: target.workspace.getTimers() }
  }

  async addAgentTimer(agentId: string, opts: RuntimeTimerMutationOptions): Promise<{ agentId: string; success: true; id: number }> {
    const target = this.requireTarget(agentId)
    // Absent = main. An unknown loop would persist a timer that fires into a
    // stream that does not exist (same rule as Studio's timer add).
    const loop = opts.loop ? this.targetLoopName(target, opts.loop) : undefined
    const timer = await buildTimerMutation(opts)
    const id = target.workspace.addTimer(timer.schedule, timer.nextWakeAt, opts.payload, opts.scope ?? ['agent'], opts.lambda, opts.warm, opts.locked, loop)
    return { agentId: target.id, success: true, id }
  }

  async updateAgentTimer(agentId: string, opts: RuntimeTimerMutationOptions & { id: number }): Promise<{ agentId: string; success: boolean }> {
    const target = this.requireTarget(agentId)
    // `loop` present = move the timer to that loop (main = the default, stored as none).
    const loop = opts.loop !== undefined ? this.targetLoopName(target, opts.loop) : undefined
    const timer = await buildTimerMutation(opts)
    const success = target.workspace.updateTimer(opts.id, timer.schedule, timer.nextWakeAt, opts.payload, opts.scope ?? ['agent'], opts.lambda, opts.warm, opts.locked)
    if (success && loop !== undefined) target.workspace.setTimerLoop(opts.id, loop === MAIN_LOOP ? null : loop)
    return { agentId: target.id, success }
  }

  deleteAgentTimer(agentId: string, id: number): { agentId: string; success: boolean } {
    const target = this.requireTarget(agentId)
    return { agentId: target.id, success: target.workspace.deleteTimer(id) }
  }

  getAgentMeta(agentId: string): { agentId: string; entries: Array<{ key: string; value: string; protection: MetaProtectionLevel }> } {
    const target = this.requireTarget(agentId)
    return { agentId: target.id, entries: target.workspace.getAllMeta() }
  }

  setAgentMeta(agentId: string, key: string, value: string, protection?: MetaProtectionLevel): { agentId: string; success: true } {
    const target = this.requireTarget(agentId)
    target.workspace.setMeta(key, value, protection)
    return { agentId: target.id, success: true }
  }

  deleteAgentMeta(agentId: string, key: string): { agentId: string; success: boolean } {
    const target = this.requireTarget(agentId)
    return { agentId: target.id, success: target.workspace.deleteMeta(key) }
  }

  setAgentMetaProtection(agentId: string, key: string, protection: MetaProtectionLevel): { agentId: string; success: boolean } {
    const target = this.requireTarget(agentId)
    return { agentId: target.id, success: target.workspace.setMetaProtection(key, protection) }
  }

  getAgentUsage(agentId: string): RuntimeAgentUsage {
    const target = this.requireTarget(agentId)
    const { loopRows, usageRows, totals, byModel } = summarizeLoopUsage(target.workspace.getLoop())
    return {
      agentId: target.id,
      source: 'adf_loop',
      note: 'Sums token usage persisted on loop rows, including compaction summary rows. It does not include model_invoke or other provider calls that did not create loop rows. input already includes cacheRead and cacheWrite; total = input + output.',
      loopRows,
      usageRows,
      totals,
      byModel,
    }
  }

  getAgentTasks(agentId: string, opts: RuntimeAgentTasksOptions = {}): { agentId: string; tasks: RuntimeTaskEntry[] } {
    const target = this.requireTarget(agentId)
    const tasks = opts.status
      ? target.workspace.getTasksByStatus(opts.status)
      : target.workspace.getAllTasks(clampInteger(opts.limit ?? 200, 1, 1000))
    return { agentId: target.id, tasks: tasks.map(task => this.withApprovalAffordance(target.managed, target.config, task)) }
  }

  getAgentTask(agentId: string, taskId: string): { agentId: string; task: RuntimeTaskEntry } | null {
    const target = this.requireTarget(agentId)
    const task = target.workspace.getTask(taskId)
    return task ? { agentId: target.id, task: this.withApprovalAffordance(target.managed, target.config, task) } : null
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
  private withApprovalAffordance(managed: ManagedRuntimeAgent | null, config: AgentConfig, task: TaskEntry): RuntimeTaskEntry {
    if (task.status !== 'pending_approval') return task
    // An open document runs no executor: nothing waits on the request.
    const meta = managed ? this.approvalHolder(managed, task.id)?.executor.getPendingApprovalMeta(task.id) : undefined
    if (!meta) return { ...task, canAlwaysApprove: false, alwaysApproveBlockedReason: NO_LIVE_APPROVAL_REASON }
    const locked = config.tools?.find(t => t.name === task.tool)?.locked === true
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
    const target = this.requireTarget(agentId)
    // An open document asks nothing: no executor runs.
    if (!target.managed) return { agentId: target.id, asks: [] }
    const managed = target.managed
    const asks = this.askExecutors(managed).flatMap(({ loop, executor }) => executor.getPendingAsks().map(ask => ({ ...ask, loop })))
    return { agentId: managed.id, asks }
  }

  /** Request ids are per executor, so `loop` disambiguates; absent = the first loop holding that id. */
  answerAgentAsk(agentId: string, requestId: string, answer: string, loop?: string): { agentId: string; requestId: string; loop: string; answered: boolean } {
    const managed = this.requireAgent(agentId)
    const holder = this.askExecutors(managed).find(entry =>
      (loop === undefined || entry.loop === loop) && entry.executor.getPendingAsks().some(ask => ask.requestId === requestId))
    if (!holder) throw new RuntimeLoopError(`Ask request "${requestId}" not found${loop ? ` in loop "${loop}"` : ''} (already answered, or never asked).`, 404, 'ask_not_found')
    holder.executor.resolveAsk(requestId, answer)
    return { agentId: managed.id, requestId, loop: holder.loop, answered: true }
  }

  /**
   * One loop's per-request context breakdown (Studio's context modal; daemon
   * GET /agents/:id/context). `breakdown` is null when that loop has no live
   * executor (disabled, never woken, idle-swept) or it is half-initialized.
   */
  getAgentContextBreakdown(agentId: string, loop?: string): { agentId: string; loop: string; config: AgentConfig; breakdown: import('../../shared/types/ipc.types').ContextBreakdown | null } {
    const target = this.requireTarget(agentId)
    const loopName = this.targetLoopName(target, loop)
    // An open document has no executor to measure: breakdown null (as a loop that is not running).
    if (!target.managed) return { agentId: target.id, loop: loopName, config: target.workspace.getAgentConfig(), breakdown: null }
    const managed = target.managed
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
    const target = this.requireTarget(agentId)
    return { agentId: target.id, identities: target.workspace.listIdentityEntries() }
  }

  getAgentIdentityPurposes(agentId: string, prefix?: string): { agentId: string; purposes: string[] } {
    const target = this.requireTarget(agentId)
    return { agentId: target.id, purposes: target.workspace.listIdentityPurposes(prefix) }
  }

  /** Metadata only: stored values (and all key material) never leave the process. */
  getAgentIdentity(agentId: string, purpose: string): { agentId: string } & RuntimeIdentityMeta {
    const target = this.requireTarget(agentId)
    return { agentId: target.id, ...this.describeIdentity(target, purpose) }
  }

  setAgentIdentity(agentId: string, purpose: string, value: string, opts: RuntimeCredentialWriteOptions = {}): { agentId: string; purpose: string; success: true; replaced?: boolean } {
    const target = this.requireTarget(agentId)
    const replaced = this.setIdentityValue(target, purpose, value, opts)
    return { agentId: target.id, purpose, success: true, ...(replaced ? { replaced } : {}) }
  }

  deleteAgentIdentity(agentId: string, purpose: string): { agentId: string; purpose: string; success: boolean } {
    const target = this.requireTarget(agentId)
    return { agentId: target.id, purpose, success: target.workspace.deleteIdentity(purpose) }
  }

  deleteAgentIdentityByPrefix(agentId: string, prefix: string): { agentId: string; prefix: string; deleted: number } {
    const target = this.requireTarget(agentId)
    return { agentId: target.id, prefix, deleted: target.workspace.deleteIdentityByPrefix(prefix) }
  }

  setAgentIdentityCodeAccess(agentId: string, purpose: string, codeAccess: boolean): { agentId: string; purpose: string; success: boolean } {
    const target = this.requireTarget(agentId)
    return { agentId: target.id, purpose, success: target.workspace.setIdentityCodeAccess(purpose, codeAccess) }
  }

  getAgentIdentityPassword(agentId: string): { agentId: string; needsPassword: boolean; unlocked: boolean } {
    const target = this.requireTarget(agentId)
    return {
      agentId: target.id,
      needsPassword: target.workspace.isPasswordProtected(),
      unlocked: target.keyCell.current !== null,
    }
  }

  /**
   * Unlock the legacy whole-file password. The key lives in the file's one
   * key cell, so a document and the runtime started on it share it (Studio's
   * foreground key survives stop and start while the file stays open), and
   * every session holding the document remembers it for its next open.
   */
  unlockAgentIdentityPassword(agentId: string, password: string, opts: { holder?: string } = {}): { agentId: string; success: true } {
    const target = this.requireTarget(agentId)
    if (!target.workspace.isPasswordProtected()) {
      throw new RuntimeLoopError(`${target.config.name} has no file password to unlock.`, 409, 'not_password_protected')
    }
    try {
      target.keyCell.current = target.workspace.unlockWithPassword(password)
    } catch (err) {
      // Only a failed authentication of the decrypt is a wrong password; anything else is a real error.
      if (isAuthFailure(err)) throw new RuntimeLoopError('Wrong password', 403, 'wrong_password')
      throw err
    }
    console.log(`[RuntimeService] Keystore of ${target.config.name} unlocked with its file password`)
    // Only the session that typed the password remembers the key for its next open (D4).
    if (opts.holder && target.filePath) this.documents.rememberKey(opts.holder, target.filePath, target.keyCell.current)
    const managed = target.managed
    if (managed) {
      // The provider was built while the agent's own key was unreadable (and so
      // resolved fail-closed); rebuild it now that the key opens.
      this.rebuildProviderAfterUnlock(managed)
      this.propagateDerivedKey(managed)
    }
    return { agentId: target.id, success: true }
  }

  /**
   * Hand the agent's current derived key (null after a lock) to every other
   * consumer, as Studio holds it from the start: MCP env, credential files and
   * OAuth store, channel adapters, AdfCallHandler identity and signing, and
   * the mesh registration (AgentRuntimeBuilder.applyDerivedKey, which restarts
   * the adapters and MCP servers that needed the key and logs each restart).
   * The restarts run in the background; the route answers at once.
   */
  private propagateDerivedKey(managed: ManagedRuntimeAgent): void {
    const key = managed.derivedKey
    const workspace = managed.agent.workspace
    const builder = this.agentRuntimeBuilder
    // Not built by the builder (headless): the mesh registration is the only other consumer.
    if (!builder) {
      emitAgentDerivedKeyChanged(workspace, key)
      return
    }
    void builder.applyDerivedKey(managed.agent, key).then(
      (result) => { if (!result.applied) emitAgentDerivedKeyChanged(workspace, key) },
      (err) => console.error(`[RuntimeService] Applying the derived key of ${managed.config.name} failed:`, err),
    )
  }

  private rebuildProviderAfterUnlock(managed: ManagedRuntimeAgent): void {
    if (!this.providerFactory) return
    void this.agentProvider(managed.config, managed.filePath, managed.agent.workspace, managed.derivedKey).then(
      (provider) => {
        const replacesStub = lockedKeyProviders.has(managed.agent.executor.getProvider() as LLMProvider)
        managed.agent.executor.updateProvider(provider)
        if (replacesStub && !lockedKeyProviders.has(provider)) {
          console.log(`[RuntimeService] ${managed.config.name}: provider key unlocked; the provider uses it from the next turn`)
        }
      },
      err => console.warn(`[RuntimeService] Provider rebuild after unlock failed for ${managed.id}:`, err),
    )
  }

  /** @deprecated Whole-file password creation is removed; the method stays so daemon callers fail loudly. */
  setAgentIdentityPassword(_agentId: string, _password: string): { agentId: string; success: true } {
    throw new RuntimeLoopError('Whole-file passwords are no longer supported — use a share password instead.', 400, 'not_supported')
  }

  removeAgentIdentityPassword(agentId: string): { agentId: string; success: true } {
    const target = this.requireTarget(agentId)
    if (!target.keyCell.current) {
      throw new RuntimeLoopError('This agent’s identity keystore is locked with its file password. Unlock it first (POST /agents/{id}/identity/password/unlock).', 409, CREDENTIALS_LOCKED_CODE)
    }
    target.workspace.removePassword(target.keyCell.current)
    this.dropDerivedKey(target)
    return { agentId: target.id, success: true }
  }

  /** The legacy password of an open file was removed elsewhere (review claim): its key is dropped everywhere. */
  forgetFileDerivedKey(filePath: string): void {
    const target = this.targetAtPath(this.canonicalFilePath(filePath))
    if (target) this.dropDerivedKey(target)
    else this.documents.forgetKey(this.canonicalFilePath(filePath))
  }

  /** The file's key is no longer needed or valid: cleared in its cell, forgotten by every holder, handed to the runtime's consumers. */
  private dropDerivedKey(target: AgentTarget): void {
    target.keyCell.current = null
    if (target.filePath) this.documents.forgetKey(target.filePath)
    if (target.managed) this.propagateDerivedKey(target.managed)
  }

  /** @deprecated Re-keying is continued use of the removed whole-file password mechanism. Remove the password instead. */
  changeAgentIdentityPassword(_agentId: string, _newPassword: string): { agentId: string; success: true } {
    throw new RuntimeLoopError('Whole-file passwords are no longer supported — remove the password and use a share password instead.', 400, 'not_supported')
  }

  wipeAgentIdentity(agentId: string): { agentId: string; success: true } {
    const target = this.requireTarget(agentId)
    target.workspace.wipeAllIdentity()
    this.dropDerivedKey(target)
    return { agentId: target.id, success: true }
  }

  getAgentDid(agentId: string): { agentId: string; did: string | null } {
    const target = this.requireTarget(agentId)
    return { agentId: target.id, did: target.workspace.getDid() }
  }

  generateAgentIdentityKeys(agentId: string): { agentId: string; success: true; did: string } {
    const target = this.requireTarget(agentId)
    const workspace = target.workspace
    // A key-less file goes through the host's full provisioning (envelopes,
    // sealed key, owner/runtime stamps, attestations), never a plain key the
    // owner never certified. A host without the owner key refuses instead.
    if (!target.keyCell.current && workspace.getIdentityRow('crypto:signing:private_key') === null) {
      if (!canProvisionWorkspaceIdentity()) {
        throw new Error('No owner identity on this host — create or restore it first (`adf identity`), then generate keys.')
      }
      ensureWorkspaceIdentity(workspace)
      const provisioned = workspace.getDid()
      if (provisioned) return { agentId: target.id, success: true, did: provisioned }
    }
    const result = workspace.generateIdentityKeys(target.keyCell.current)
    // Fresh agent DID under this app's ownership → issue delegation attestations.
    const ownerIdentity = this.settings?.getOwnerIdentity?.()
    if (ownerIdentity) {
      try {
        issueOwnerAttestation(target.workspace, {
          ownerDid: ownerIdentity.getOwnerDid(),
          ownerPrivateKey: ownerIdentity.getOwnerSigningKey(),
          runtimeDid: ownerIdentity.getRuntimeDid(),
          runtimePrivateKey: ownerIdentity.getRuntimeSigningKey()
        })
      } catch (err) {
        console.warn('[RuntimeService] Attestation issuance failed:', err)
      }
    }
    return { agentId: target.id, success: true, did: result.did }
  }

  setAgentProviderCredential(agentId: string, providerId: string, value: string, opts: RuntimeCredentialWriteOptions = {}): { agentId: string; providerId: string; success: true; replaced?: boolean } {
    const target = this.requireTarget(agentId)
    const replaced = this.setIdentityValue(target, `provider:${providerId}:apiKey`, value, opts)
    return { agentId: target.id, providerId, success: true, ...(replaced ? { replaced } : {}) }
  }

  /** Metadata only (see RuntimeIdentityMeta), keyed by credential name (`apiKey`). */
  getAgentProviderCredentials(agentId: string, providerId: string): {
    agentId: string
    providerId: string
    credentials: Record<string, RuntimeIdentityMeta>
    providerConfig?: Pick<AdfProviderConfig, 'defaultModel' | 'params' | 'requestDelayMs'>
  } {
    const target = this.requireTarget(agentId)
    const providerConfig = target.config.providers?.find(provider => provider.id === providerId)
    return {
      agentId: target.id,
      providerId,
      credentials: this.describeCredentials(target, `provider:${providerId}:`),
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
    const target = this.requireTarget(agentId)
    const providers = [...(target.config.providers ?? [])]
    const existingIdx = providers.findIndex(existing => existing.id === provider.id)
    const alreadyAttached = existingIdx >= 0
    if (alreadyAttached) providers[existingIdx] = { ...providers[existingIdx], ...provider }
    else providers.push(provider)
    const result = await this.setAgentConfig(target.id, { ...target.config, providers })
    return { agentId: target.id, providerId: provider.id, success: true, alreadyAttached, config: result.config }
  }

  async detachAgentProvider(agentId: string, providerId: string): Promise<{ agentId: string; providerId: string; success: true; deletedCredentials: number; config: AgentConfig }> {
    const target = this.requireTarget(agentId)
    const providers = (target.config.providers ?? []).filter(provider => provider.id !== providerId)
    const nextConfig: AgentConfig = { ...target.config, providers }
    if (providers.length === 0) delete nextConfig.providers
    const result = await this.setAgentConfig(target.id, nextConfig)
    const deletedCredentials = target.workspace.deleteIdentityByPrefix(`provider:${providerId}:`)
    return { agentId: target.id, providerId, success: true, deletedCredentials, config: result.config }
  }

  setAgentMcpCredential(agentId: string, npmPackage: string, envKey: string, value: string, opts: RuntimeCredentialWriteOptions = {}): { agentId: string; npmPackage: string; envKey: string; success: true; replaced?: boolean } {
    const target = this.requireTarget(agentId)
    const replaced = this.setIdentityValue(target, `mcp:${npmPackage}:${envKey}`, value, opts)
    return { agentId: target.id, npmPackage, envKey, success: true, ...(replaced ? { replaced } : {}) }
  }

  /** Metadata only (see RuntimeIdentityMeta), keyed by env key. */
  getAgentMcpCredentials(agentId: string, npmPackage: string): { agentId: string; npmPackage: string; credentials: Record<string, RuntimeIdentityMeta> } {
    const target = this.requireTarget(agentId)
    return {
      agentId: target.id,
      npmPackage,
      credentials: this.describeCredentials(target, `mcp:${npmPackage}:`),
    }
  }

  async attachAgentMcpServer(agentId: string, server: McpServerConfig): Promise<{ agentId: string; serverName: string; success: true; alreadyAttached: boolean; config: AgentConfig }> {
    const target = this.requireTarget(agentId)
    const servers = [...(target.config.mcp?.servers ?? [])]
    const alreadyAttached = servers.some(existing => existing.name === server.name)
    if (!alreadyAttached) servers.push(server)
    const result = await this.setAgentConfig(target.id, {
      ...target.config,
      mcp: { ...(target.config.mcp ?? {}), servers },
    })
    return { agentId: target.id, serverName: server.name, success: true, alreadyAttached, config: result.config }
  }

  async detachAgentMcpServer(agentId: string, serverName: string, credentialNamespace = serverName): Promise<{ agentId: string; serverName: string; success: true; deletedCredentials: number; config: AgentConfig }> {
    const target = this.requireTarget(agentId)
    const servers = (target.config.mcp?.servers ?? []).filter(server => server.name !== serverName)
    const result = await this.setAgentConfig(target.id, {
      ...target.config,
      mcp: { ...(target.config.mcp ?? {}), servers },
    })
    const deletedCredentials = target.workspace.deleteIdentityByPrefix(`mcp:${credentialNamespace}:`)
    return { agentId: target.id, serverName, success: true, deletedCredentials, config: result.config }
  }

  setAgentAdapterCredential(agentId: string, adapterType: string, envKey: string, value: string, opts: RuntimeCredentialWriteOptions = {}): { agentId: string; adapterType: string; envKey: string; success: true; replaced?: boolean } {
    const target = this.requireTarget(agentId)
    const replaced = this.setIdentityValue(target, `adapter:${adapterType}:${envKey}`, value, opts)
    return { agentId: target.id, adapterType, envKey, success: true, ...(replaced ? { replaced } : {}) }
  }

  /** Metadata only (see RuntimeIdentityMeta), keyed by env key. */
  getAgentAdapterCredentials(agentId: string, adapterType: string): { agentId: string; adapterType: string; credentials: Record<string, RuntimeIdentityMeta> } {
    const target = this.requireTarget(agentId)
    return {
      agentId: target.id,
      adapterType,
      credentials: this.describeCredentials(target, `adapter:${adapterType}:`),
    }
  }

  /**
   * An agent provider's API key, for in-process use only (the daemon's model
   * listing calls the provider with it). Never returned over HTTP.
   */
  readAgentProviderApiKey(agentId: string, providerId: string): string | undefined {
    const target = this.requireTarget(agentId)
    return target.workspace.getIdentityDecrypted(`provider:${providerId}:apiKey`, target.keyCell.current) ?? undefined
  }

  async attachAgentAdapter(agentId: string, adapterType: string, config: AdapterInstanceConfig): Promise<{ agentId: string; adapterType: string; success: true; alreadyAttached: boolean; config: AgentConfig }> {
    const target = this.requireTarget(agentId)
    const adapters = { ...(target.config.adapters ?? {}) }
    const alreadyAttached = adapters[adapterType] !== undefined
    adapters[adapterType] = config
    const result = await this.setAgentConfig(target.id, { ...target.config, adapters })
    return { agentId: target.id, adapterType, success: true, alreadyAttached, config: result.config }
  }

  async detachAgentAdapter(agentId: string, adapterType: string): Promise<{ agentId: string; adapterType: string; success: true; deletedCredentials: number; config: AgentConfig }> {
    const target = this.requireTarget(agentId)
    const adapters = { ...(target.config.adapters ?? {}) }
    delete adapters[adapterType]
    const nextConfig: AgentConfig = { ...target.config, adapters }
    if (Object.keys(adapters).length === 0) delete nextConfig.adapters
    const result = await this.setAgentConfig(target.id, nextConfig)
    const deletedCredentials = target.workspace.deleteIdentityByPrefix(`adapter:${adapterType}:`)
    return { agentId: target.id, adapterType, success: true, deletedCredentials, config: result.config }
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
    const target = this.requireTarget(agentId)
    const limit = clampInteger(opts.limit ?? 50, 1, 500)
    let logs = target.workspace.getLogs(limit) as AdfLogEntry[]
    if (opts.origin) logs = logs.filter(log => log.origin === opts.origin)
    if (opts.event) logs = logs.filter(log => log.event === opts.event)
    return logs
  }

  getAgentLogsAfterId(agentId: string, afterId: number): { agentId: string; logs: AdfLogEntry[] } {
    const target = this.requireTarget(agentId)
    return { agentId: target.id, logs: target.workspace.getLogsAfterId(afterId) as AdfLogEntry[] }
  }

  clearAgentLogs(agentId: string): { agentId: string; success: true } {
    const target = this.requireTarget(agentId)
    target.workspace.clearLogs()
    return { agentId: target.id, success: true }
  }

  listAgentLocalTables(agentId: string): { agentId: string; tables: Array<{ name: string; row_count: number }> } {
    const target = this.requireTarget(agentId)
    return { agentId: target.id, tables: target.workspace.listLocalTables() }
  }

  queryAgentLocalTable(agentId: string, table: string, opts: { limit?: number; offset?: number } = {}): { agentId: string; columns: string[]; rows: Record<string, unknown>[] } {
    const target = this.requireTarget(agentId)
    assertLocalTableName(table, true)
    const limit = clampInteger(opts.limit ?? 100, 1, 1000)
    const offset = clampInteger(opts.offset ?? 0, 0, Number.MAX_SAFE_INTEGER)
    const rows = target.workspace.querySQL(`SELECT * FROM "${table}" LIMIT ? OFFSET ?`, [limit, offset]) as Record<string, unknown>[]
    return { agentId: target.id, columns: rows.length > 0 ? Object.keys(rows[0]) : [], rows }
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
    const target = this.requireTarget(agentId)
    // An open document runs no umbilical: nothing to replay.
    const buffer = target.managed ? getUmbilicalReplayBuffer(target.id) : undefined
    if (!buffer) return { agentId: target.id, events: [], last_seq: null, log_enabled: false }

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
      agentId: target.id,
      events,
      last_seq: events.length > 0 ? events[events.length - 1].seq : sinceSeq || null,
      log_enabled: true,
      ...(range ? { oldest_seq: range.oldest_seq } : {}),
    }
  }

  dropAgentLocalTable(agentId: string, table: string): { agentId: string; success: boolean } {
    const target = this.requireTarget(agentId)
    assertLocalTableName(table, false)
    return { agentId: target.id, success: target.workspace.dropLocalTable(table) }
  }

  getAgentAdaptersDiagnostics(agentId: string): RuntimeAgentAdaptersDiagnostics {
    const target = this.requireTarget(agentId)
    return {
      agentId: target.id,
      configured: Object.entries(target.config.adapters ?? {}).map(([type, config]) => ({
        type,
        enabled: config.enabled,
        config: config as unknown as Record<string, unknown>,
      })),
      states: target.managed?.agent.adapterManager?.getStates() ?? [],
    }
  }

  getAgentMcpDiagnostics(agentId: string): RuntimeAgentMcpDiagnostics {
    const target = this.requireTarget(agentId)
    return {
      agentId: target.id,
      configured: (target.config.mcp?.servers ?? []).map(server => ({
        name: server.name,
        transport: server.transport,
        command: server.command,
        args: server.args,
        toolCount: server.available_tools?.length ?? 0,
      })),
      states: target.managed?.agent.mcpManager?.getServerStates() ?? [],
    }
  }

  getAgentTriggersDiagnostics(agentId: string): RuntimeAgentTriggersDiagnostics {
    const target = this.requireTarget(agentId)
    return {
      agentId: target.id,
      displayState: target.managed?.agent.triggerEvaluator?.getDisplayState() ?? null,
      configured: Object.entries(target.config.triggers ?? {}).map(([type, trigger]) => ({
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

  /**
   * Loaded file-backed agents with their live executor state, context gauge
   * and open workspace. Agent vitals reads a running agent out of this
   * workspace instead of reopening its file.
   */
  listLiveAgents(): RuntimeLiveAgent[] {
    const out: RuntimeLiveAgent[] = []
    for (const managed of this.agents.values()) {
      if (!managed.filePath) continue
      const executor = managed.agent.executor
      out.push({
        agentId: managed.id,
        filePath: managed.filePath,
        executorState: executor.getState(),
        workspace: managed.agent.workspace,
        getContextGauge: () => executor.getContextGauge(),
      })
    }
    return out
  }

  /**
   * A loaded agent's assembled handle and derived key, by id, handle or name,
   * for daemon routes that act on parts RuntimeService does not wrap. The key
   * is for in-process use only and never leaves the process.
   */
  getLoadedAgent(agentId: string): RuntimeLoadedAgent | undefined {
    const managed = this.resolveAgent(agentId)
    if (!managed) return undefined
    return {
      agentId: managed.id,
      filePath: managed.filePath,
      agent: managed.agent,
      workspace: managed.agent.workspace,
      derivedKey: managed.derivedKey,
    }
  }

  /**
   * Studio's AGENT_START provider gate, for a client-initiated start (autostart
   * skips it, as Studio's background starts do): `provider_missing` when the
   * agent names a provider this runtime does not have, `provider_unconfigured`
   * when the provider's network check fails and its type needs a key it does
   * not have. A failing check of a provider that has its key carries no code.
   * `identifier` is a loaded agent's id, handle or name, or a file (path or
   * tracked-directory match) that is not loaded yet.
   */
  async preflightProvider(identifier: string): Promise<RuntimeProviderPreflight> {
    if (!this.providerFactory) return { ok: true } // the caller supplies the provider
    const loadedPath = identifier.endsWith('.adf') ? this.loadedPathFor(identifier) : undefined
    const managed = loadedPath ? this.agents.get(this.filePathToAgentId.get(loadedPath)!) : this.resolveAgent(identifier)
    // An open document: its workspace and the key unlocked on it (the start uses both).
    const doc = managed ? undefined : this.documentFor(identifier)
    let workspace: AdfWorkspace
    let filePath: string | null
    let derivedKey: Buffer | null = null
    if (managed) {
      workspace = managed.agent.workspace
      filePath = managed.filePath
      derivedKey = managed.derivedKey
    } else if (doc) {
      this.assertReviewGate(doc.filePath, this.enforceReviewGate)
      workspace = doc.workspace
      filePath = doc.filePath
      derivedKey = doc.keyCell.current
    } else {
      filePath = this.findAgentFile(identifier)
      if (!filePath) throw new Error(`RuntimeService: unknown agent "${identifier}"`)
      // The load's review gate first (403): an unreviewed file's provider
      // entry must not make this daemon call the endpoint it names.
      this.assertReviewGate(filePath, this.enforceReviewGate)
      workspace = AdfWorkspace.open(filePath)
    }
    try {
      // The agent's own provider key may be envelope-sealed (the load path's unlock).
      if (!managed && !doc) unlockWorkspaceEnvelopes(workspace)
      const config = workspace.getAgentConfig() as AgentConfig
      const store = this.providerSettings()
      // The agent has its own key but it cannot be opened here (password or
      // envelope locked): not a missing key. The agent loads and unlocks
      // later (unlockAgentIdentityPassword, owner identity); the start goes on.
      const credentialsLocked = this.lockedProviderKeyMessage(config, workspace, derivedKey)
      if (credentialsLocked) return { ok: true, credentialsLocked }
      let provider: LLMProvider
      try {
        provider = await this.providerFactory(config, filePath, { workspace, derivedKey })
      } catch (err) {
        return { ok: false, code: 'provider_missing', error: err instanceof Error ? err.message : String(err) }
      }
      const validation = await provider.validateConfig()
      if (validation.valid) return { ok: true }
      const local = resolveAgentProviderConfig(config, workspace, derivedKey, store) ?? store.getProvider(config.model.provider)
      const needsKey = !!local && !local.apiKey && providerNeedsApiKey(local.type)
      return {
        ok: false,
        error: validation.error || 'Provider not configured',
        ...(needsKey ? { code: 'provider_unconfigured' as const } : {}),
      }
    } finally {
      if (!managed && !doc) try { workspace.dispose() } catch { /* best effort */ }
    }
  }

  /**
   * The file of a loaded agent moved from `oldPath` to `newPath` (a rename
   * done by the caller). The agent keeps running: the path indexes, a pending
   * name-follows-file rename and the agent lease move to the new path, and
   * 'agent-path-changed' is emitted (the mesh registration is keyed by path).
   * Returns null when no loaded agent has `oldPath`.
   */
  async rekeyAgentPath(oldPath: string, newPath: string): Promise<RuntimeAgentRef | null> {
    const oldKey = this.loadedPathFor(oldPath)
    if (!oldKey) return null
    const agentId = this.filePathToAgentId.get(oldKey)!
    const managed = this.requireAgent(agentId)
    const newCanonical = this.canonicalFilePath(newPath)
    if (newCanonical === oldKey) return this.toRef(managed)
    const holder = this.loadedPathFor(newCanonical)
    if (holder && holder !== oldKey) {
      throw new RuntimeLoopError(`${newCanonical} is already loaded as another agent.`, 409, 'path_in_use')
    }
    // Path maps first, then the lease (agent-lease.ts rekey reads them through the hosted-paths probe).
    this.filePathToAgentId.delete(oldKey)
    this.filePathToAgentId.set(newCanonical, agentId)
    managed.filePath = newCanonical
    // A document on this runtime follows (same workspace), with every holder's remembered key.
    this.documents.rekey(oldKey, newCanonical)
    const pendingName = this.pendingRenames.get(oldKey)
    if (pendingName !== undefined) {
      this.pendingRenames.delete(oldKey)
      if (basename(newCanonical, '.adf') !== pendingName) this.pendingRenames.set(newCanonical, pendingName)
    }
    console.log(`[RuntimeService] ${managed.config.name} moved: ${oldKey} → ${newCanonical}`)
    const lease = await this.agentLeases?.rekey(oldKey, newCanonical)
    if (lease && !lease.ok) {
      // It keeps running, but unprotected: say so where the user looks.
      const event = { type: 'error' as const, payload: { error: lease.message, code: lease.code }, timestamp: Date.now() }
      this.emit('agent-event', { agentId, filePath: newCanonical, event } satisfies RuntimeAgentEvent)
    }
    this.emit('agent-path-changed', { agentId, oldFilePath: oldKey, filePath: newCanonical } satisfies RuntimeAgentPathChangedEvent)
    return this.toRef(managed)
  }

  /**
   * Studio's syncAgentFileToName: the file follows the agent's name. A loaded
   * agent's file is renamed when it unloads (SQLite cannot move under a live
   * executor); a file that is not loaded is renamed now. Each rename emits
   * 'agent-file-renamed'. Called for every running-config name change
   * (host onConfigChanged); W1-E's rename route calls it too.
   */
  syncAgentFileToName(filePath: string, name: string): RuntimeFileRenameResult {
    const canonicalPath = this.canonicalFilePath(filePath)
    const trimmed = (name ?? '').trim()
    if (!isValidAgentFileName(trimmed)) {
      console.warn(`[RuntimeService] Agent name "${name}" is not a valid file name; keeping ${basename(canonicalPath)}`)
      return { error: `"${name}" is not a valid file name.` }
    }
    if (basename(canonicalPath, '.adf') === trimmed) {
      this.pendingRenames.delete(canonicalPath)
      return {}
    }
    if (this.isPathLoaded(canonicalPath)) {
      if (this.pendingRenames.get(canonicalPath) !== trimmed) {
        console.log(`[RuntimeService] ${basename(canonicalPath)} will be renamed to "${trimmed}.adf" when the agent stops`)
      }
      this.pendingRenames.set(canonicalPath, trimmed)
      return { deferred: true }
    }
    const result = this.renameAgentFileNow(canonicalPath, trimmed)
    if (result.filePath) {
      this.emitSafely('agent-file-renamed', { agentId: null, oldFilePath: canonicalPath, filePath: result.filePath } satisfies RuntimeAgentFileRenamedEvent)
    }
    return result
  }

  /** The new name a loaded agent's file takes when it unloads, if one is pending. */
  getPendingRename(filePath: string): string | undefined {
    return this.pendingRenames.get(this.canonicalFilePath(filePath))
  }

  /**
   * Drop a pending rename without the name checks syncAgentFileToName runs
   * (a file being deleted may have a name that is not a valid new name, e.g.
   * `:` on POSIX). Returns the dropped name.
   */
  cancelPendingRename(filePath: string): string | undefined {
    const key = this.canonicalFilePath(filePath)
    const name = this.pendingRenames.get(key)
    this.pendingRenames.delete(key)
    return name
  }

  /** Renames the file of an agent that just unloaded, if a rename waits; the caller emits the event. */
  private applyPendingRename(agentId: string, filePath: string): RuntimeAgentFileRenamedEvent | null {
    const name = this.pendingRenames.get(filePath)
    if (name === undefined || this.isPathLoaded(filePath)) return null
    this.pendingRenames.delete(filePath)
    const result = this.renameAgentFileNow(filePath, name)
    if (result.error) {
      console.warn(`[RuntimeService] Deferred rename of ${basename(filePath)} to "${name}.adf" failed: ${result.error}`)
      return null
    }
    return result.filePath ? { agentId, oldFilePath: filePath, filePath: result.filePath } : null
  }

  /**
   * Studio's performAdfRename for a file no runtime runs. An open document is
   * closed for the move and reopened at the new path (envelopes unlocked
   * again, key cell and holders kept), as Studio does with its open file.
   */
  private renameAgentFileNow(filePath: string, newName: string): RuntimeFileRenameResult {
    const newPath = join(dirname(filePath), `${newName}.adf`)
    // On a case-insensitive volume a case-only rename's target "exists": it is the source itself.
    const caseOnly = newPath !== filePath && sameInode(filePath, newPath)
    if (newPath !== filePath && !caseOnly && existsSync(newPath)) return { error: `A file named "${newName}.adf" already exists.` }
    const doc = this.documents.get(filePath)
    if (doc) {
      try { doc.workspace.checkpoint() } catch { /* the close checkpoints too */ }
      try { doc.workspace.close() } catch (err) { console.warn(`[RuntimeService] Closing ${basename(filePath)} for its rename failed:`, err) }
    }
    const result = this.moveAndRenameFile(filePath, newPath, newName, caseOnly)
    if (doc) {
      const at = result.filePath ?? filePath
      if (result.filePath) this.documents.rekey(filePath, at)
      try {
        doc.workspace = AdfWorkspace.open(at)
        unlockWorkspaceEnvelopes(doc.workspace)
        doc.config = doc.workspace.getAgentConfig() as AgentConfig
      } catch (err) {
        // The file cannot be reopened: the document is gone, and the holders are told.
        console.error(`[RuntimeService] Reopening ${at} after its rename failed; the document is closed:`, err)
        this.documents.remove(doc)
        this.emitSafely('document-closed', { agentId: doc.agentId, filePath: at, reason: 'released' } satisfies RuntimeDocumentEvent)
      }
    }
    return result
  }

  private moveAndRenameFile(filePath: string, newPath: string, newName: string, caseOnly: boolean): RuntimeFileRenameResult {
    try {
      if (newPath !== filePath) {
        // Merge WAL frames into the main file before moving it; sidecars that
        // survive (another process holds the file) abort the rename, since a
        // base file moved away from live sidecars loses their frames.
        if (existsSync(`${filePath}-wal`) || existsSync(`${filePath}-shm`)) {
          try {
            const checkpoint = AdfWorkspace.open(filePath)
            checkpoint.checkpoint()
            checkpoint.close()
          } catch (err) {
            console.warn(`[RuntimeService] Pre-rename checkpoint of ${basename(filePath)} failed:`, err)
          }
        }
        if (existsSync(`${filePath}-wal`) || existsSync(`${filePath}-shm`)) {
          return { error: 'WAL sidecars could not be checkpointed — rename aborted to avoid losing unflushed data.' }
        }
        if (caseOnly) {
          // Through a temporary name, so the new spelling sticks on every case-insensitive filesystem.
          const temp = `${filePath}.${process.pid}-${Date.now()}.renaming`
          renameSync(filePath, temp)
          renameSync(temp, newPath)
        } else {
          renameSync(filePath, newPath)
        }
      }
      const workspace = AdfWorkspace.open(newPath)
      try {
        const config = workspace.getAgentConfig()
        config.name = newName
        workspace.setAgentConfig(config)
      } finally {
        workspace.close()
      }
      this.pendingRenames.delete(filePath)
      console.log(`[RuntimeService] Renamed ${filePath} → ${newPath}`)
      return { filePath: newPath }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** The canonical key under which `filePath` is loaded (or loading), if it is. */
  private loadedPathFor(filePath: string): string | undefined {
    const canonical = this.canonicalFilePath(filePath)
    if (this.filePathToAgentId.has(canonical)) return canonical
    // A file already moved away no longer resolves to its realpath: compare spellings.
    const key = pathKey(canonical)
    for (const loaded of this.filePathToAgentId.keys()) if (pathKey(loaded) === key) return loaded
    return undefined
  }

  private isPathLoaded(canonicalPath: string): boolean {
    return this.filePathToAgentId.has(canonicalPath) || this.inFlightLoads.has(canonicalPath)
  }

  /** The settings store as the provider resolution reads it. */
  private providerSettings(): ProviderSettingsStore {
    const settings = this.settings as (RuntimeSettingsStore & Partial<ProviderSettingsStore>) | undefined
    return {
      getProvider: (id) => settings?.getProvider
        ? settings.getProvider(id)
        : ((settings?.get('providers') as ProviderConfig[] | undefined) ?? []).find(provider => provider.id === id),
    }
  }

  override on(event: 'agent-event', listener: (event: RuntimeAgentEvent) => void): this
  override on(event: 'agent-lifecycle', listener: (event: RuntimeLifecycleEvent) => void): this
  override on(event: 'agent-loaded', listener: (event: RuntimeAgentLoadedEvent) => void): this
  override on(event: 'agent-unloaded', listener: (event: RuntimeAgentUnloadedEvent) => void): this
  override on(event: 'agent-path-changed', listener: (event: RuntimeAgentPathChangedEvent) => void): this
  override on(event: 'agent-file-renamed', listener: (event: RuntimeAgentFileRenamedEvent) => void): this
  override on(event: 'document-opened' | 'document-closed', listener: (event: RuntimeDocumentEvent) => void): this
  override on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener)
  }

  /**
   * Throws (the caller disposes `agent`) during teardown and when another
   * loaded agent has the same id (409 duplicate_agent_id).
   */
  private registerAgent(
    agent: RuntimeAgent,
    filePath: string | null,
    config: AgentConfig,
    idOverride?: string,
    keyCell: DerivedKeyCell = { current: null },
  ): RuntimeAgentRef {
    // Shutdown race: an agent whose build completes after teardown began must
    // not register (it would escape the teardown's agent snapshot and keep
    // dispatching turns).
    if (RuntimeGate.tearingDown) {
      throw new Error('RuntimeService: runtime teardown in progress — agent not registered.')
    }
    const id = idOverride ?? config.id
    // Two files with one id that loaded concurrently both passed the check
    // before their builds; the second to finish is refused here.
    this.assertNoDuplicateId(id, filePath)

    const managed: ManagedRuntimeAgent = {
      id,
      filePath,
      config,
      agent,
      keyCell,
      get derivedKey() { return keyCell.current },
      set derivedKey(key: Buffer | null) { keyCell.current = key },
      display: {
        state: toDisplayState(agent.executor.getState()),
        loopStates: new Map(),
        activeLoops: 0,
        accumulatedText: '',
      },
      hostAttachment: { detach: () => {} },
    }
    managed.hostAttachment = agent.attachHost(this.hostBindings(managed))
    this.wireCreateAdfCallbacks(managed)
    this.agents.set(id, managed)
    if (filePath) this.filePathToAgentId.set(filePath, id)
    const ref = this.toRef(managed)
    // Per listener: a failing one (mesh registration) must not turn into a
    // load failure that disposes a registered agent.
    this.emitSafely('agent-loaded', {
      agentId: id,
      filePath,
      ref,
      agent,
    } satisfies RuntimeAgentLoadedEvent)
    return ref
  }

  /**
   * The host side of one agent (Studio's foreground/background host bindings):
   * raw executor and trigger events out as 'agent-event', display state,
   * trigger errors and lifecycle out as 'agent-lifecycle', the agent's own
   * `off`, and config changes. Paths are read from `managed` at event time, so
   * rekeyAgentPath needs no re-attach.
   */
  private hostBindings(managed: ManagedRuntimeAgent): AgentHostBindings {
    return {
      onEvent: (event) => {
        // Read before the executor's own umbilical emit takes the absorbed ids (agent-executor.ts emitEvent).
        const turn = this.turnStampOf(managed, event)
        const echoOrigin = this.takeEchoOrigin(managed, event)
        this.emit('agent-event', { agentId: managed.id, filePath: managed.filePath, event, ...turn, ...(echoOrigin ? { echoOrigin } : {}) } satisfies RuntimeAgentEvent)
        if (event.type === 'state_changed') this.foldDisplayState(managed, event)
      },
      // `trigger_message` and the like: Studio sends them on AGENT_EVENT too.
      onTriggerEvent: (event) => {
        this.emit('agent-event', { agentId: managed.id, filePath: managed.filePath, event } satisfies RuntimeAgentEvent)
      },
      onTriggerError: (error, dispatch) => this.onTriggerError(managed, error, dispatch),
      onStateOff: () => this.handleAgentOff(managed),
      onConfigChanged: (updatedConfig) => {
        // The agent's own writes (sys_update_config, loop_manage) land here too.
        managed.config = updatedConfig
        if (managed.filePath) this.syncAgentFileToName(managed.filePath, updatedConfig.name)
      },
    }
  }

  /**
   * `turnId` and `absorbedTurnIds` of an executor event, by the umbilical's
   * rules (emit-umbilical.ts, agent-executor.ts emitEvent): the turn of the
   * async context when the context is this agent's; absorbed ids on `error`
   * and on a `turn_complete` that was not interrupted (an interrupted turn's
   * ids ride on to the replay).
   */
  private turnStampOf(managed: ManagedRuntimeAgent, event: AgentExecutionEvent): Pick<RuntimeAgentEvent, 'turnId' | 'absorbedTurnIds'> {
    const turnId = currentAgentId() === managed.id ? currentTurnId() : undefined
    let absorbedTurnIds: string[] | undefined
    const interrupted = (event.payload as { interrupted?: unknown } | undefined)?.interrupted === true
    if (event.type === 'error' || (event.type === 'turn_complete' && !interrupted)) {
      const loop = event.loop ?? MAIN_LOOP
      const executor = loop === MAIN_LOOP ? managed.agent.executor : managed.agent.loopPool.getRuntime(loop)?.executor
      const ids = executor?.getAbsorbedTurnIds() ?? []
      if (ids.length > 0) absorbedTurnIds = [...ids]
    }
    return { ...(turnId ? { turnId } : {}), ...(absorbedTurnIds ? { absorbedTurnIds } : {}) }
  }

  /** Main's display state and the inner-loop count, through the background mapping (BAM parity). */
  private foldDisplayState(managed: ManagedRuntimeAgent, event: AgentExecutionEvent): void {
    applyBackgroundEvent(managed.display, managed.filePath ?? managed.id, event, (mapped) => {
      if (mapped.type !== 'agent_state_changed' && mapped.type !== 'agent_loops_changed') return
      const { filePath: _filePath, ...payload } = mapped.payload as Record<string, unknown>
      this.emitLifecycle(managed.id, managed.filePath, mapped.type, payload)
    })
  }

  private onTriggerError(managed: ManagedRuntimeAgent, error: unknown, dispatch: AdfEventDispatch | AdfBatchDispatch): void {
    if (this.agents.get(managed.id) !== managed || managed.agent.executor.getState() === 'stopped') return
    const eventType = 'event' in dispatch ? dispatch.event.type : dispatch.events[0]?.type ?? 'batch'
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[RuntimeService] Trigger error for ${managed.filePath ?? managed.id} (${eventType}): ${message}`)
    // The daemon builder's own host binding writes adf_logs; other agents have none.
    if (managed.agent.profile !== 'daemon') {
      try { managed.agent.workspace.insertLog('error', 'runtime', 'trigger_error', eventType, message.slice(0, 200)) } catch { /* non-fatal */ }
    }
    // What Studio's hosts show: the foreground sends an `error` AGENT_EVENT,
    // the background manager puts the agent's display state in `error`.
    const errorEvent: AgentExecutionEvent = { type: 'error', payload: { error: message }, timestamp: Date.now() }
    this.emitSafely('agent-event', { agentId: managed.id, filePath: managed.filePath, event: errorEvent } satisfies RuntimeAgentEvent)
    if (managed.display.state !== 'error') {
      managed.display.state = 'error'
      this.emitLifecycle(managed.id, managed.filePath, 'agent_state_changed', { state: 'error' })
    }
    this.emitLifecycle(managed.id, managed.filePath, 'trigger_error', { error: message, eventType })
  }

  /**
   * The agent set its own display state to `off` (a tool, a lambda, an
   * approval, the owner's state change): stop and unload it, as Studio's
   * handleAgentOff does. The mesh registration goes with the unload.
   */
  private handleAgentOff(managed: ManagedRuntimeAgent): void {
    if (this.offInProgress.has(managed.id) || this.agents.get(managed.id) !== managed) return
    this.offInProgress.add(managed.id)
    console.log(`[RuntimeService] ${managed.config.name} switched itself off: stopping it`)
    // A microtask later, so the `off` state_changed this fires inside still
    // reaches onEvent (and clients) before the host detaches.
    void Promise.resolve()
      .then(() => this.unloadAgent(managed.id, { mode: 'owner-off' }))
      .catch((err) => console.error(`[RuntimeService] Stopping ${managed.config.name} after off failed:`, err))
      .finally(() => this.offInProgress.delete(managed.id))
  }

  private emitLifecycle(
    agentId: string | null,
    filePath: string | null,
    type: RuntimeLifecycleEventType,
    payload: Record<string, unknown>,
  ): void {
    const event: RuntimeLifecycleEvent = { agentId, filePath, type, payload: { filePath, ...payload }, timestamp: Date.now() }
    this.emitSafely('agent-lifecycle', event)
  }

  /** Emit to each listener on its own: one that throws neither reaches the caller nor stops the rest. */
  private emitSafely(name: string, event: unknown): void {
    for (const listener of this.rawListeners(name)) {
      try {
        (listener as (event: unknown) => void)(event)
      } catch (err) {
        console.error(`[RuntimeService] A ${name} listener failed:`, err)
      }
    }
  }


  /** A running agent. An open document that is not running is a 409 agent_not_running (a runtime action on it). */
  private requireAgent(agentId: string): ManagedRuntimeAgent {
    const managed = this.resolveAgent(agentId)
    if (managed) return managed
    const doc = this.documents.resolve(agentId)
    if (doc) {
      throw new RuntimeLoopError(
        `${doc.config.name} is open but not running. Start it first (POST /agents/${doc.agentId}/start).`,
        409,
        AGENT_NOT_RUNNING_CODE,
        { agentId: doc.agentId, filePath: doc.filePath },
      )
    }
    throw new Error(`RuntimeService: unknown agent "${agentId}"`)
  }

  /** A running agent first, else an open document (D4), by id, handle or name. */
  private resolveTarget(identifier: string): AgentTarget | undefined {
    const managed = this.resolveAgent(identifier)
    if (managed) return this.runningTarget(managed)
    const doc = this.documents.resolve(identifier)
    return doc ? this.documentTarget(doc) : undefined
  }

  private requireTarget(identifier: string): AgentTarget {
    const target = this.resolveTarget(identifier)
    if (!target) throw new Error(`RuntimeService: unknown agent "${identifier}"`)
    return target
  }

  /** The running agent or open document of a canonical file path. */
  private targetAtPath(canonicalPath: string): AgentTarget | undefined {
    const loadedKey = this.loadedPathFor(canonicalPath)
    const managed = loadedKey ? this.managedAt(loadedKey) : undefined
    if (managed) return this.runningTarget(managed)
    const doc = this.documents.get(this.loadedDocumentPath(canonicalPath))
    return doc ? this.documentTarget(doc) : undefined
  }

  private runningTarget(managed: ManagedRuntimeAgent): AgentTarget {
    const config = (): AgentConfig => this.syncManagedConfig(managed)
    return {
      id: managed.id,
      filePath: managed.filePath,
      workspace: managed.agent.workspace,
      keyCell: managed.keyCell,
      managed,
      doc: this.documents.get(managed.filePath) ?? null,
      get config() { return config() },
    }
  }

  /**
   * A running agent's config as its file holds it. A tool that writes the
   * file itself (mcp_install, mcp_uninstall, npm_install, npm_uninstall) does
   * not pass through onConfigChanged, nor does another process writing the
   * file (the CLI, embedded Studio), so the cached copy can be behind the
   * file: handed out with the file's revision, a client saved it back over
   * the change (an installed MCP server missing from Studio, then gone from
   * the file). Those tools apply their own runtime effects (connect,
   * disconnect, tool resync); only the cached copy follows here.
   *
   * Every `target.config` read of a running agent lands here, so the file is
   * read only when its stamp moved: a config write through this connection
   * (configWriteCount) or a commit by another one (`PRAGMA data_version`).
   * An unchanged file costs two counter reads, no table read. `reread`
   * reads it regardless (getAgentConfig, which hands out a revision too).
   */
  private syncManagedConfig(managed: ManagedRuntimeAgent, opts: { reread?: boolean } = {}): AgentConfig {
    const workspace = managed.agent.workspace
    const dataVersion = workspace.dataVersion()
    const seen = managed.configSeen
    if (!opts.reread && seen && seen.writes === workspace.configWriteCount() && seen.dataVersion === dataVersion) return managed.config
    const onDisk = workspace.getAgentConfig() as AgentConfig
    if (JSON.stringify(onDisk) !== JSON.stringify(managed.config)) managed.config = onDisk
    // Counted after the read: a write the read itself made (getConfig's
    // merges) is in `onDisk`. data_version is the one from before the read,
    // so another connection's commit during it is read next time.
    managed.configSeen = { writes: workspace.configWriteCount(), dataVersion }
    return managed.config
  }

  private documentTarget(doc: OpenDocument): AgentTarget {
    this.assertNotMoving(doc)
    return {
      id: doc.agentId,
      filePath: doc.filePath,
      workspace: doc.workspace,
      keyCell: doc.keyCell,
      managed: null,
      doc,
      get config() { return doc.config },
    }
  }

  /**
   * A loop name on a running agent (its pool) or an open document (its
   * declared loops): absent = main; unknown = 404.
   */
  private targetLoopName(target: AgentTarget, loop: string | undefined): string {
    if (target.managed) return this.requireLoopName(target.managed, loop)
    const name = loop || MAIN_LOOP
    if (name !== MAIN_LOOP && !(target.config.loops ?? []).some(l => l.name === name)) {
      throw new RuntimeLoopError(`No loop named "${name}" on this agent.`, 404)
    }
    return name
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
  private setIdentityValue(target: AgentTarget, purpose: string, value: string, opts: RuntimeCredentialWriteOptions = {}): boolean {
    const workspace = target.workspace
    if (workspace.isPasswordProtected() && !target.keyCell.current) {
      // Legacy whole-file password: nothing can be written until it is unlocked.
      throw new RuntimeLoopError(
        'This agent’s identity keystore is locked with its file password. Unlock it first (POST /agents/{id}/identity/password/unlock), then save the credential.',
        409,
        CREDENTIALS_LOCKED_CODE,
      )
    }
    if (target.keyCell.current) {
      const { ciphertext, iv } = encrypt(Buffer.from(value, 'utf-8'), target.keyCell.current)
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
    const locked = lockedCredentialWrite(workspace, purpose)
    if (!locked) {
      workspace.setIdentity(purpose, value)
      return false
    }
    if (!opts.replace) throw credentialsLockedError(locked)
    replaceLockedCredential(workspace, locked, value, (line) => console.warn(`[RuntimeService] ${target.config.name}: ${line}`))
    return locked.sealed
  }

  private describeIdentity(target: AgentTarget, purpose: string): RuntimeIdentityMeta {
    const workspace = target.workspace
    const row = workspace.getIdentityRow(purpose)
    if (!row) return { purpose, present: false, storage: null, sealed: false, locked: false, length: null, code_access: false }
    const envelope = envelopeFromAlgo(row.encryption_algo)
    const storage = envelope ? 'sealed' : row.encryption_algo === 'plain' ? 'plain' : 'password'
    const locked = envelope ? workspace.getEnvelopeState(envelope) !== 'unlocked' : storage === 'password' && !target.keyCell.current
    let length: number | null = null
    if (!locked && !purpose.startsWith('crypto:')) {
      try { length = workspace.getIdentityDecrypted(purpose, target.keyCell.current)?.length ?? null } catch { length = null }
    }
    return { purpose, present: true, storage, sealed: envelope !== null, locked, length, code_access: row.code_access }
  }

  private describeCredentials(target: AgentTarget, prefix: string): Record<string, RuntimeIdentityMeta> {
    const credentials: Record<string, RuntimeIdentityMeta> = {}
    for (const purpose of target.workspace.listIdentityPurposes(prefix)) {
      credentials[purpose.slice(prefix.length)] = this.describeIdentity(target, purpose)
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
    derivedKey: Buffer | null,
  ): Promise<LLMProvider> {
    if (override) return override
    if (!this.providerFactory) {
      throw new Error('RuntimeService: loadAgent requires a provider or providerFactory.')
    }
    // Envelope-sealed keys are already open (unlockWorkspaceEnvelopes); the
    // legacy password key is the caller's, or arrives later through unlock.
    return this.agentProvider(config, filePath, workspace, derivedKey)
  }

  /**
   * The agent's provider. When the agent's own provider key is stored but
   * locked here (file password, or a sealed envelope this daemon cannot open
   * yet), a stub that fails every call with `credentials_locked` before any
   * request: the real provider would send an empty key and the executor
   * would blame Settings → Providers. An unlock rebuilds the real one
   * (unlockAgentIdentityPassword, refreshAgentCredentials).
   */
  private async agentProvider(config: AgentConfig, filePath: string | null, workspace: AdfWorkspace, derivedKey: Buffer | null): Promise<LLMProvider> {
    return this.lockedKeyStub(config, workspace, derivedKey) ?? this.providerFactory!(config, filePath, { workspace, derivedKey })
  }

  /** The credentials_locked stub when the agent's own provider key cannot be opened here, else null. */
  private lockedKeyStub(config: AgentConfig, workspace: AdfWorkspace, derivedKey: Buffer | null): LLMProvider | null {
    const message = this.lockedProviderKeyMessage(config, workspace, derivedKey)
    if (!message) return null
    const entry = config.providers!.find(p => p.id === config.model.provider)!
    console.warn(`[RuntimeService] ${message}`)
    return lockedKeyProvider(entry, config.model.model_id, message)
  }

  /** Why the agent's own provider key is locked here and how to unlock it; null when it is not. */
  private lockedProviderKeyMessage(config: AgentConfig, workspace: AdfWorkspace, derivedKey: Buffer | null): string | null {
    const entry = config.providers?.find(p => p.id === config.model.provider)
    if (!entry || agentProviderKeySource(entry, workspace, derivedKey, this.providerSettings()) !== 'locked') return null
    const provider = `"${entry.name || entry.id}"`
    return workspace.isPasswordProtected() && !derivedKey
      ? `${config.name}'s API key for its provider ${provider} is locked with the agent's file password, so no request was sent. ` +
        `Unlock it: POST /agents/${config.id}/identity/password/unlock with {"password": "…"}. The next turn uses the key.`
      : `${config.name}'s API key for its provider ${provider} is sealed and its credentials envelope is locked on this daemon, so no request was sent. ` +
        'Make the owner identity available (adf identity unlock, or adf identity restore); the agent re-checks and the next turn uses the key.'
  }

  private async buildLoadedAgent(
    workspace: AdfWorkspace,
    filePath: string,
    config: AgentConfig,
    provider: LLMProvider,
    keyCell: DerivedKeyCell,
  ): Promise<RuntimeAgent> {
    const prompts = this.currentPrompts()
    if (this.agentRuntimeBuilder) {
      return await this.agentRuntimeBuilder.build({
        workspace,
        filePath,
        config,
        provider,
        restoreLoop: true,
        derivedKey: keyCell.current,
        prompts,
        createProviderForModel: (model) => {
          if (!this.providerFactory) return provider
          // The key at call time: an unlock after start reaches model_invoke too.
          const modelConfig = { ...config, model }
          const stub = this.lockedKeyStub(modelConfig, workspace, keyCell.current)
          if (stub) return stub
          const resolved = this.providerFactory(modelConfig, filePath, { workspace, derivedKey: keyCell.current })
          if (isPromiseLike(resolved)) {
            throw new Error('RuntimeService: model_invoke providerFactory must be synchronous.')
          }
          return resolved
        },
      })
    }

    return createHeadlessAgentFromWorkspace(workspace, {
      provider,
      ...prompts,
      restoreLoop: true,
    })
  }

  /**
   * The prompt settings for a start, read now (Studio reads them at every
   * AGENT_START): the settings store's value, else the constructor's.
   */
  private currentPrompts(): AgentRuntimePrompts {
    const base = this.settings?.get('globalSystemPrompt')
    const tools = this.settings?.get('toolPrompts')
    const compaction = this.settings?.get('compactionPrompt')
    return {
      basePrompt: typeof base === 'string' ? base : this.basePrompt,
      toolPrompts: tools && typeof tools === 'object' && !Array.isArray(tools) ? tools as Record<string, string> : this.toolPrompts,
      compactionPrompt: typeof compaction === 'string' ? compaction : this.compactionPrompt,
    }
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

  /** HTTP and autostart scans yield during filesystem work; realpath batches stay bounded. */
  async scanAdfFilesAsync(dirs: string[], maxDepth = 5): Promise<string[]> {
    const seen = new Set<string>()
    const results: string[] = []
    const collect = async (dir: string, depth: number): Promise<void> => {
      if (depth > maxDepth) return
      let entries: import('node:fs').Dirent[]
      try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
      for (let offset = 0; offset < entries.length; offset += 32) {
        // Even a flat directory of irrelevant entries must yield to timers and requests.
        await new Promise<void>(resolve => setImmediate(resolve))
        const batch = entries.slice(offset, offset + 32)
        const paths = await Promise.all(batch.map(async entry => {
          if (!entry.isFile() || !entry.name.endsWith('.adf')) return null
          const full = join(dir, entry.name)
          try { return await realpath(full) } catch { return full }
        }))
        for (let index = 0; index < batch.length; index++) {
          const path = paths[index]
          const entry = batch[index]
          if (path !== null) {
            if (!seen.has(path)) { seen.add(path); results.push(path) }
          } else if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
            await collect(join(dir, entry.name), depth + 1)
          }
        }
      }
    }
    for (const dir of dirs) await collect(dir, 0)
    return results
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
      throw new RuntimeLoopError(
        `Agent identifier "${identifier}" matches ${matches.length} agent files: ${details}. Start it by file path instead.`,
        409,
        'ambiguous_agent',
        { candidates: matches.map(match => ({ name: match.config.name, handle: match.config.handle ?? null, filePath: match.filePath })) },
      )
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

/** Both paths name the same file (device + inode); false when either is missing. */
function sameInode(a: string, b: string): boolean {
  try {
    const x = statSync(a, { bigint: true })
    const y = statSync(b, { bigint: true })
    return x.dev === y.dev && x.ino === y.ino
  } catch {
    return false
  }
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.floor(value)))
}

/** Providers made by lockedKeyProvider (so an unlock knows it replaces one). */
const lockedKeyProviders = new WeakSet<LLMProvider>()

/**
 * A provider whose every call fails with `credentials_locked` before any
 * request. validateConfig answers valid: the executor's own preflight would
 * turn a failure into "check the API key in Settings → Providers".
 */
function lockedKeyProvider(entry: AdfProviderConfig, modelId: string, message: string): LLMProvider {
  const provider: LLMProvider = {
    name: entry.name || entry.id,
    providerId: entry.id,
    providerType: entry.type as LLMProvider['providerType'],
    modelId,
    async createMessage() {
      throw Object.assign(new Error(message), { code: CREDENTIALS_LOCKED_CODE })
    },
    async validateConfig() {
      return { valid: true }
    },
  }
  lockedKeyProviders.add(provider)
  return provider
}

/** Dispose an agent; `rethrow` false logs instead (cleanup of an agent that never registered). */
async function disposeRuntimeAgent(agent: RuntimeAgent, mode: AgentStopMode, rethrow = false): Promise<void> {
  try {
    await agent.disposeAsync({ mode })
  } catch (err) {
    if (rethrow) throw err
    console.error('[RuntimeService] Disposing an unregistered agent failed:', err)
  }
}

/**
 * Studio's rule for an agent file name (shared/utils/agent-file-name.ts),
 * plus no Windows device name, as the daemon's create and rename (W5-D2).
 * The copy here missed the backslash.
 */
function isValidAgentFileName(name: string): boolean {
  return agentFileNameProblem(name) === null
}

/** Path comparison key: case-insensitive where the file system usually is (as agent-lease.ts). */
function pathKey(filePath: string): string {
  return process.platform === 'linux' ? resolve(filePath) : resolve(filePath).toLowerCase()
}

/** Main's goal as a roster entry, as LoopPool.listLoops summarizes it: the first ~200 chars, flattened. */
function summarizeMainGoal(instructions: string): string {
  const flat = instructions.replace(/\s+/g, ' ').trim()
  return flat.length <= 200 ? flat : `${flat.slice(0, 199).trimEnd()}…`
}

/** Display entries a chat or batch read returns (Studio's LOOP_DISPLAY_LIMIT). */
const CHAT_DISPLAY_LIMIT = 200

function requireHolder(holder: unknown): string {
  if (typeof holder !== 'string' || !DOCUMENT_HOLDER_FORMAT.test(holder)) {
    throw new RuntimeLoopError('holder must be a client session id (a UUID)', 400, 'bad_request')
  }
  return holder
}

/** AES-GCM refused the key: the password does not open the file. */
function isAuthFailure(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /unable to authenticate|unsupported state|bad decrypt/i.test(message)
}

/** False once the workspace's database connection is closed (a failed build disposes it). */
function isWorkspaceOpen(workspace: AdfWorkspace): boolean {
  return (workspace.getDatabase() as unknown as { closed?: boolean }).closed !== true
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return !!value && typeof (value as { then?: unknown }).then === 'function'
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value
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
