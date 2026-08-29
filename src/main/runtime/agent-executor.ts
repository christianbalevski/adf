import { EventEmitter } from 'events'
import type { CreateMessageOptions, LLMProvider } from '../providers/provider.interface'
import type { ToolRegistry } from '../tools/tool-registry'
import { stripInternalToolFlags } from '../tools/tool-registry'
import { RECOVERY_DEFAULTS, type AgentConfig, type LoopTokenUsage } from '../../shared/types/adf-v02.types'
import type { AgentSession } from './agent-session'
import type { ContentBlock } from '../../shared/types/provider.types'
import type { AgentExecutionEvent, ApprovalMeta, ContextBreakdown, ContextBreakdownFileEntry, ContextBreakdownToolGroup } from '../../shared/types/ipc.types'
import type { ToolProviderFormat, ToolResult, ProtectionDenial } from '../../shared/types/tool.types'
import type { SystemScopeHandler } from './system-scope-handler'
import {
  type AdfEventDispatch, type AdfBatchDispatch, type AnyAdfEventDispatch,
  type InboxEventData, type OutboxEventData, type FileChangeEventData, type ChatEventData,
  type TimerEventData, type ToolCallEventData, type TaskCompleteEventData, type LogEntryEventData,
  type LlmCallEventData,
} from '../../shared/types/adf-event.types'
import { getTokenUsageService } from '../services/token-usage.service'
import { getFleetBurnService } from '../services/fleet-burn.service'
import { getTokenCounterService } from '../services/token-counter.service'
import { buildCompactionUserMessage, COMPACTION_FOOTER } from './compaction-prompt'
import { DEFAULT_COMPACTION_PROMPT, DEFAULT_DYNAMIC_PROMPTS, DEFAULT_TOOL_PROMPTS } from '../../shared/constants/adf-defaults'
import { nanoid } from 'nanoid'
import { parseLoopToDisplay } from '../../shared/utils/loop-parser'
// Shared with deriveLoopConfig — both enforcement points must read a duplicated
// declaration the same way, or a side loop inherits an un-gated copy of a tool
// the executor treats as restricted.
import { dedupeToolDeclarations } from '../../shared/utils/tool-declarations'
// Type-only module (config derivation + the host-loop name); no runtime cycle.
import { MAIN_LOOP } from '../adf/derive-loop-config'
import { assemblePrompt } from './prompt-builder'
import { collectInjectedFiles, resolveInjectedFiles } from './prompt-file-injection'
import { assembleContextBreakdown, measureInjectedFiles, measureToolSchemas } from './context-breakdown'
import { withSource } from './execution-context'
import { emitUmbilicalEvent } from './emit-umbilical'
import { RuntimeGate } from './runtime-gate'
import { SystemDispatchQueue, SystemDispatchDroppedError } from './system-dispatch-limits'
import { isTextMime, isVisionMime, isAudioInputMime, isVideoInputMime, formatSize, mimeToExt, mimeToAudioFormat } from '../tools/built-in/mime-utils'
import { McpTool } from '../tools/mcp-tool'
import {
  callLlmWithMetadata,
  getAttachedLlmCallMetadata,
  loopTokensFromLlmMetadata,
  toLlmCallEventData,
} from './llm-call-metadata'

/** Tools that support _async: true (background execution). MCP tools (mcp_*) are also allowed. */
const ASYNC_ALLOWED_TOOLS = new Set(['adf_shell', 'sys_code', 'sys_lambda', 'sys_fetch'])

/** True when a dispatch carries an owner-sourced inbox message (fleet map / chat rails). */
function isOwnerInboxDispatch(dispatch: AdfEventDispatch | AdfBatchDispatch): boolean {
  const event = 'event' in dispatch ? dispatch.event : dispatch.events[0]
  if (!event || event.type !== 'inbox') return false
  return (event.data as InboxEventData)?.message?.source === 'user'
}
/**
 * True when the dispatch's content is ALREADY a row in THIS loop's stream, so
 * the turn must inline it into the session without writing a second row.
 *
 * Two producers: `deliverOwnerMessage` (mesh-manager) appends the owner's
 * message at delivery time so it is visible immediately, and the loop pool's
 * `sendToLoop` appends the inter-loop message at send time (RT-F6) so
 * "it will read this on its next run" is literally true. Both ride the row's
 * `loop_seq` on the dispatch so the inlined message keeps its [S<seq>] marker.
 *
 * "THIS loop's" is load-bearing. `skip_loop_append` is set by a producer that
 * addressed one runtime, so it is per-dispatch and needs no further check. An
 * owner inbox event, by contrast, fans out to every matching `on_inbox` target:
 * the row landed in exactly one stream, named by `pre_appended_loop`, and every
 * OTHER loop's dispatch must write its own copy or that loop answers from a
 * stream that never held the message (review M5).
 */
function isPreAppendedDispatch(dispatch: AdfEventDispatch | AdfBatchDispatch): boolean {
  const event = 'event' in dispatch ? dispatch.event : dispatch.events[0]
  const data = event?.data as { skip_loop_append?: boolean; pre_appended_loop?: string } | undefined
  if (data?.skip_loop_append === true) return true
  if (!isOwnerInboxDispatch(dispatch)) return false
  // Absent marker: pre-loops deliverers appended to main, which is also where
  // an untagged dispatch routes.
  const appendedTo = typeof data?.pre_appended_loop === 'string' ? data.pre_appended_loop : MAIN_LOOP
  return appendedTo === (dispatch.loop ?? MAIN_LOOP)
}
/** Companion to isPreAppendedDispatch: the pre-appended row's seq, if any. */
function preAppendedLoopSeq(dispatch: AdfEventDispatch | AdfBatchDispatch): number | undefined {
  if (!isPreAppendedDispatch(dispatch)) return undefined
  const event = 'event' in dispatch ? dispatch.event : dispatch.events[0]
  const data = event?.data as { loop_seq?: number } | undefined
  return typeof data?.loop_seq === 'number' ? data.loop_seq : undefined
}
/** True when a chat dispatch was already echoed into the sender's UI log
 *  (chat panel optimistic append) — those skip the trigger_message event.
 *  Chat from anywhere else (fleet command bar) must emit it, or an open
 *  loop panel never shows the owner's message. */
function isEchoedChat(dispatch: AdfEventDispatch | AdfBatchDispatch | null): boolean {
  if (!dispatch) return false
  const event = 'event' in dispatch ? dispatch.event : dispatch.events[0]
  if (!event || event.type !== 'chat') return false
  return (event.data as ChatEventData)?.echoed === true
}
const MSG_TOOLS = new Set(['msg_send', 'agent_discover', 'msg_list', 'msg_read', 'msg_update'])
/**
 * Crash-recovery record for the turn in flight. Agent-global for MAIN (the key
 * predates loops and `recoverStaleTurnCheckpoint` reads only this one), suffixed
 * per side loop — a reflector's turn must not overwrite main's record, which is
 * the one recovery actually consults. Side-loop checkpoints are therefore
 * write-isolated bookkeeping; per-loop recovery is a later wave.
 */
const TURN_CHECKPOINT_META_KEY = 'adf_runtime_turn_checkpoint'
// Memory-flush grace turn: after the compaction threshold is crossed the agent
// gets one turn to persist durable learnings to its mind pages before the loop
// is compacted. During that turn the preflight guard compacts only at
// min(threshold + MARGIN, threshold * FACTOR) so the grace turn can't blow the
// model's context window.
const MEMORY_FLUSH_EMERGENCY_MARGIN = 30_000
const MEMORY_FLUSH_EMERGENCY_FACTOR = 1.3
// Compaction summarizer output cap. The briefing's length is steered by the
// prompt ("under 1500 words"), not the cap — the cap only exists to stop a
// runaway call. Reasoning tokens count against max_tokens on OpenRouter-style
// providers, and some models reason even when the request disables it, so the
// cap is text budget + worst-case reasoning allowance; a tight cap can be
// consumed entirely by reasoning, truncating the call before any summary text
// is emitted.
const COMPACTION_TEXT_BUDGET = 8_192
const COMPACTION_REASONING_HEADROOM = 20_000

interface TurnCheckpointRecord {
  id: string
  status: 'in_progress' | 'completed' | 'interrupted' | 'failed'
  started_at: number
  updated_at: number
  completed_at?: number
  event_type: string
  scope: string
  replay: 'not_attempted' | 'not_replayed'
  reason?: string
}

interface ToolSnapshot {
  schemas: ToolProviderFormat[]
  enabledNames: Set<string>
  declarations: Map<string, NonNullable<AgentConfig['tools']>[number]>
}

type ToolDeclarationEntry = NonNullable<AgentConfig['tools']>[number]

/** Coarse human-readable span used in crash-recovery notices, e.g. `3h 12m`. */
function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'an unknown amount of time'
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  const days = Math.floor(hours / 24)
  return `${days}d ${hours % 24}h`
}

/** Provider response bodies are untrusted input; strip newlines, control
 *  chars, and the `]` that would escape a `[System notice: …]` frame before
 *  embedding one in a durable history notice. */
function sanitizeForNotice(msg: string): string {
  // eslint-disable-next-line no-control-regex
  return msg.replace(/[\u0000-\u001f\]]+/g, ' ').slice(0, 150)
}

/** ISO-8601 for a possibly-missing epoch ms field on a persisted record. */
function formatTimestamp(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? new Date(value).toISOString()
    : 'unknown'
}

interface CachedToolSnapshot {
  updatedAt: string | undefined
  snapshot: ToolSnapshot
  /** Schema token cost grouped built-in vs per MCP server, measured over the
   *  FINAL schemas (after the _reason/_async augmentation) at rebuild time —
   *  real tokenizers over an MCP-heavy payload are too expensive per turn. */
  toolGroups: ContextBreakdownToolGroup[]
  toolsTotalTokens: number
}

/**
 * Classify whether a thrown error represents a transient external failure
 * (rate limit, provider outage, network hiccup) vs. a structural executor fault.
 * Transient errors leave the agent idle so triggers/timers can retry; structural
 * errors transition to `error` state.
 *
 * The Vercel AI SDK rewraps provider errors as plain `Error` instances before they
 * reach the executor (see ai-sdk-provider.ts `extractErrorMessage`), so class-based
 * checks (`instanceof APIError`) are unreliable. Pattern-match the message and
 * any preserved properties instead.
 */
/** HTTP status preserved on an enriched provider error, if any. */
function errorStatus(error: unknown): number | null {
  const obj = (error && typeof error === 'object') ? error as Record<string, unknown> : null
  return typeof obj?.status === 'number' ? obj.status
    : typeof obj?.statusCode === 'number' ? obj.statusCode
    : typeof obj?.responseStatus === 'number' ? obj.responseStatus
    : null
}

export function isTransientProviderError(error: unknown, message: string): boolean {
  const msg = message.toLowerCase()
  const obj = (error && typeof error === 'object') ? error as Record<string, unknown> : null

  // A known HTTP status is authoritative: 408/429/5xx are transient, anything
  // else is not — a 400 whose body happens to mention "timeout" or contain a
  // standalone "500" (e.g. a token count) must NOT be retried.
  const status = errorStatus(error)
  if (status !== null) return status === 408 || status === 429 || (status >= 500 && status < 600)

  const code = typeof obj?.code === 'string' ? obj.code : null
  if (code && ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN', 'EPIPE'].includes(code)) return true

  const name = error instanceof Error ? error.name : ''
  if (name === 'AI_RateLimitError' || name === 'AI_RetryError') return true

  if (/\b(429|500|502|503|504|529)\b/.test(msg)) return true
  if (msg.includes('rate limit') || msg.includes('rate_limit')) return true
  if (msg.includes('too many requests')) return true
  if (msg.includes('overloaded') || msg.includes('server_error') || msg.includes('service_unavailable') || msg.includes('service unavailable')) return true
  if (msg.includes('internal server error') || msg.includes('bad gateway') || msg.includes('gateway timeout')) return true
  if (msg.includes('timed out') || msg.includes('timeout')) return true
  if (msg.includes('fetch failed') || msg.includes('network error') || msg.includes('connection error')) return true
  if (msg.includes('socket hang up') || msg.includes('econnreset') || msg.includes('etimedout')) return true

  return false
}

/**
 * Extract a provider-requested retry delay (ms) from a Retry-After header
 * preserved on the enriched error (see ai-sdk-provider toProviderError).
 * Supports both delta-seconds and HTTP-date forms. Returns null when absent
 * or unparseable.
 */
export function retryAfterMs(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null
  const headers = (error as Record<string, unknown>).responseHeaders
  if (!headers || typeof headers !== 'object') return null
  const raw = Object.entries(headers as Record<string, unknown>)
    .find(([k]) => k.toLowerCase() === 'retry-after')?.[1]
  if (typeof raw !== 'string' || raw === '') return null
  const secs = Number(raw)
  if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000)
  const date = Date.parse(raw)
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now())
  return null
}

/**
 * Detect provider-side credential / authorization / billing failures.
 *
 * These are *structural* — the agent cannot make progress until the user
 * fixes the API key, account balance, or plan limits. They are NOT transient
 * (no point retrying with the same credentials) and they are NOT generic
 * runtime errors (the user-facing message should be specific and actionable).
 */
export function isAuthError(error: unknown, message: string): boolean {
  const msg = message.toLowerCase()
  const obj = (error && typeof error === 'object') ? error as Record<string, unknown> : null

  const status = errorStatus(error)
  if (status === 401 || status === 403 || status === 402) return true
  // insufficient_quota is checked BEFORE the transient-status guard: OpenAI
  // ships out-of-credits as HTTP 429, but the token is unambiguous (Gemini
  // rate limits say RESOURCE_EXHAUSTED, never this) — retrying is futile.
  if (msg.includes('insufficient_quota')) return true
  // Otherwise a definitive transient status is NEVER an auth failure, no
  // matter what the body says — Gemini/OpenAI 429 rate-limit bodies mention
  // "billing"/"quota" and must not brick the agent with a credentials message.
  if (status === 408 || status === 429 || (status !== null && status >= 500 && status < 600)) return false

  // Common error-code shapes across providers
  // NOTE: invalid_request_error deliberately absent — it is the generic 400
  // family label (context length, malformed request), not a credentials issue.
  const code = typeof obj?.code === 'string' ? obj.code.toLowerCase() : ''
  if (['invalid_api_key', 'authentication_error',
       'insufficient_quota', 'billing_not_active'].includes(code)) return true

  // Message-substring fallback (covers anthropic, openai, openrouter, gemini, etc.)
  if (msg.includes('invalid api key') || msg.includes('invalid_api_key')) return true
  if (msg.includes('incorrect api key')) return true
  if (msg.includes('insufficient_quota') || msg.includes('insufficient credits') || msg.includes('insufficient balance')) return true
  if (msg.includes('authentication') || msg.includes('unauthorized') || msg.includes('unauthenticated')) return true
  if (msg.includes('billing') || msg.includes('payment required') || msg.includes('quota exceeded')) return true
  if (msg.includes('api key not found') || msg.includes('no api key')) return true
  if (msg.includes('forbidden')) return true
  if (msg.includes('out of credits') || msg.includes('spending limit') || msg.includes('spending-limit') || msg.includes('credit balance')) return true
  // Subscription providers (chatgpt/grok) throw statusless token-refresh
  // failures — surface them as auth so the user gets "sign in again", not a
  // generic structural error.
  if (msg.includes('not authenticated') || msg.includes('session expired') || msg.includes('sign in')) return true

  return false
}

/**
 * Serialize the full diagnostic view of a provider/turn error for the UI error
 * inspector (the loop entry is the short message; clicking it opens this).
 * Includes the status/response-body fields preserved by the provider layer.
 */
function buildErrorDetails(error: unknown, message: string): string {
  const details: Record<string, unknown> = { message }
  if (error && typeof error === 'object') {
    const obj = error as Record<string, unknown>
    if (error instanceof Error && error.name && error.name !== 'Error') details.name = error.name
    for (const key of ['statusCode', 'status', 'code', 'url', 'responseBody', 'isRetryable', 'responseHeaders']) {
      if (obj[key] !== undefined) details[key] = obj[key]
    }
    if (error instanceof Error && error.stack) details.stack = error.stack
  }
  let json: string
  try { json = JSON.stringify(details, null, 2) } catch { json = message }
  return json.length > 20_000 ? `${json.slice(0, 20_000)}\n…truncated` : json
}

export type AgentState = 'idle' | 'thinking' | 'tool_use' | 'awaiting_approval' | 'awaiting_ask' | 'suspended' | 'error' | 'stopped'

/** @deprecated Use AdfEvent + AdfEventDispatch from adf-event.types.ts instead. */
export interface TriggerContext {
  type: 'document_edit' | 'manual_invoke' | 'message_received' | 'schedule'
    | 'autonomous_start' | 'inbox_notification' | 'startup'
    | 'file_change' | 'chat' | 'inbox' | 'outbox' | 'tool_call' | 'task_complete'
    | 'log_entry'
  scope?: 'agent' | 'system' | 'document'  // 'document' kept for legacy migration only
  content?: string
  userMessage?: string
  fromAgent?: string
  toAgent?: string
  message?: string
  mentioned?: boolean
  inboxSummary?: string
  timerPayload?: string
  batchedItems?: TriggerContext[]
  filePath?: string
  fileEvent?: string
  toolName?: string
  taskId?: string
  taskStatus?: string
  diff?: string    // file_change only: unified diff between previous and current content
  lambda?: string  // system scope only: "path/file.ts:functionName"
  command?: string // system scope only: shell command string (alternative to lambda)
  warm?: boolean   // system scope only: keep sandbox worker alive between invocations
  taskResult?: string   // on_task_complete: tool result
  taskError?: string    // on_task_complete: error message
  origin?: string       // on_tool_call: "agent" or "sys_lambda:lib/something.ts"
  taskArgs?: string     // on_tool_call: JSON-stringified tool arguments
  inboxMessageId?: string                  // on_inbox system: inbox message ID
  inboxParentId?: string                   // on_inbox system: parent message ID for threading
  inboxIntent?: string                     // on_inbox system: message intent
  inboxSourceMeta?: Record<string, unknown> // on_inbox system: platform-specific metadata
  logLevel?: string                          // on_logs: log level
  logOrigin?: string | null                  // on_logs: log origin
  logEvent?: string | null                   // on_logs: log event
  logTarget?: string | null                  // on_logs: log target
}

interface TurnOptions {
  /** History already contains the trigger message (error-recovery retries) — don't add it again. */
  skipTriggerMessage?: boolean
  /** Turn is an automatic provider-error retry: keep the attempt counter and armed-timer state. */
  isRecoveryRetry?: boolean
  /** System notice injected into history before the turn runs, telling the
   *  model what failed and how much time has elapsed (provider recovery). */
  recoveryNotice?: string
}

export class AgentExecutor extends EventEmitter {
  private state: AgentState = 'idle'
  private provider: LLMProvider | null
  private toolRegistry: ToolRegistry
  private session: AgentSession
  private config: AgentConfig
  private basePrompt: string
  private toolPrompts: Record<string, string>
  private compactionPrompt: string
  private abortController: AbortController | null = null
  private pendingTriggers: (AdfEventDispatch | AdfBatchDispatch)[] = []
  private pendingInterrupt: (AdfEventDispatch | AdfBatchDispatch) | null = null
  // Turns running OR already committed to run (see isTurnActive). Not a state
  // machine — a counter, because error-recovery retries nest executeTurn calls
  // and a re-entrant successor claims its slot before its predecessor releases.
  private activeTurnCount = 0
  private _interruptRestart = false
  // Owner-initiated end of the in-flight turn. Routes the resulting AbortError
  // to the requested lifecycle state instead of 'error' — this interruption
  // is intentional, not structural breakage.
  private _ownerStateTransitionRequested = false
  private _skipNextTriggerEvent = false
  private _isMessageTriggered = false
  // True while an image-content provider error is being recovered. Suppresses
  // the brick-on-error path so a follow-up failure surfaces to the model
  // instead of moving the executor into the terminal `error` state.
  private _inImageRecovery = false
  // Automatic recovery from transient provider errors (config.recovery).
  // The transient-error branch arms a backoff timer that re-runs the failed
  // dispatch; any fresh dispatch, abort, or owner state change cancels it.
  private _recoveryTimer: NodeJS.Timeout | null = null
  // Consecutive transient failures for the current work item. Reset when a
  // fresh (non-retry) turn starts.
  private _recoveryAttempts = 0
  // When the current failure sequence began — the anchor for the elapsed-time
  // notice injected into retry turns. Cleared alongside the attempt counter.
  private _recoveryFirstFailureAt: number | null = null
  // True once the give-up notice for the current outage has been written, so
  // repeated failing triggers during a dead-provider stretch don't spam the
  // loop with one notice per turn. Cleared on the next provider success.
  private _recoveryGaveUp = false
  private meshContextFn: (() => { handle: string; description: string }[]) | null = null
  private systemScopeHandler: SystemScopeHandler | null = null

  // Per-target backpressure for system-scope dispatches. A burst of on_llm_call
  // events used to fan out one sandbox worker per event; excess dispatches now
  // queue behind their target instead.
  private systemDispatchQueue = new SystemDispatchQueue((level, event, target, message, data) => {
    try { this.session.getWorkspace().insertLog(level, 'lambda', event, target, message, data) } catch { /* best-effort */ }
  })

  // HIL (human-in-the-loop) tool approval — task-native
  private pendingHilTasks = new Map<string, { resolve: (result: { approved: boolean; modifiedArgs?: Record<string, unknown>; feedback?: string }) => void; name: string; input: unknown; meta: ApprovalMeta }>()

  // Protection denials rejected by the authorizer this turn — a retried call
  // returns the denial directly instead of re-prompting. Cleared each turn.
  private deniedProtectionKeys = new Set<string>()

  // Ask tool: pause loop and wait for human answer
  private pendingAsks = new Map<string, { resolve: (answer: string) => void; question: string }>()
  private askCounter = 0

  // Suspend flow: pause loop and wait for owner decision
  private pendingSuspend: { resolve: (resume: boolean) => void } | null = null

  // Task lifecycle callbacks (set by IPC layer after construction)
  onToolCallIntercepted?: (tool: string, args: string, taskId: string, origin: string, systemScopeHandled?: boolean) => void
  onTaskCreated?: (task: import('../../shared/types/adf-v02.types').TaskEntry) => void
  onTaskCompleted?: (taskId: string, tool: string, status: string, result?: string, error?: string, sideEffects?: { endTurn?: boolean }) => void
  onLlmCall?: (data: LlmCallEventData) => void

  /** Fires at a real turn boundary — no turn running and none already claimed
   *  by a re-entrant successor. Set by the loop pool to consume a pending wake
   *  (see runClaimedTurn). Must never throw; the executor logs and continues. */
  onTurnSettled?: () => void

  // Delta batching for performance.
  // A single ordered queue preserves arrival order across text/thinking deltas
  // so the renderer never sees out-of-order batches that would split a single
  // logical block into multiple UI entries.
  private deltaQueue: Array<{ type: 'text' | 'thinking', text: string }> = []

  // True once provider.validateConfig() has succeeded for the current credentials.
  // Reset whenever updateProvider() is called or an auth-class error is observed.
  private providerValidated: boolean = false
  private bufferTimer: NodeJS.Timeout | null = null
  private readonly BATCH_WINDOW_MS = 50

  // System prompt caching for performance
  private systemPromptCache: {
    injectedFilesHash: string
    configHash: string
    cachedPrompt: string
    /** Tokenized size of the full prompt as sent, incl. the _autonomous suffix
     *  appended post-cache (configHash covers `autonomous`, so measuring it at
     *  rebuild time stays consistent with the cache key). Tokenizer choice
     *  follows the provider at rebuild — a provider swap without a config
     *  change keeps the old figure, which is an acceptable approximation. */
    promptTokens: number
    /** Per-file share of promptTokens for {{path}} injections (rendered form). */
    injectedFiles: ContextBreakdownFileEntry[]
  } | null = null
  private toolSnapshotCache: CachedToolSnapshot | null = null

  // Session snapshot of files injected via {{<path>}} placeholders (incl. mind.md).
  // Read once and reused across turns; cleared on session reset so edits are
  // picked up at the next reset (compaction / loop_clear) — never mid-session.
  // null = needs (re)snapshotting.
  private injectedFileSnapshots: Map<string, string> | null = null

  // Mesh topology tracking for delta-based dynamic instructions
  private lastMeshSnapshot: string = ''

  // Cross-turn deduplication for "No Secrets" context injection.
  // Instance-scoped so the hash survives across executeTurn() calls.
  private lastSystemPromptHash: string | undefined
  private lastDynamicInstructions: string | undefined
  /** What the CURRENT turn actually sends as dynamic instructions (set
   *  unconditionally each turn, unlike the dedup field above). */
  private currentDynamicInstructions: string | undefined
  // Track which compaction warning tier has been emitted so each fires only once.
  // 'none' → 'soft' (15k) → 'imminent' (5k). Reset after compaction.
  private compactionWarningTier: 'none' | 'soft' | 'imminent' = 'none'
  /** One grace turn between crossing the compaction threshold and compacting,
   *  so the agent can flush durable learnings to its mind pages (with [S<seq>]
   *  citations) while the full context is still in the loop. Compaction itself
   *  never writes files. Reset alongside the other context state. */
  private memoryFlushNudgeIssued = false


  /** Whether the currently executing turn was triggered by an incoming message. */
  get isMessageTriggered(): boolean {
    return this._isMessageTriggered
  }

  constructor(
    config: AgentConfig,
    provider: LLMProvider,
    toolRegistry: ToolRegistry,
    session: AgentSession,
    basePrompt: string = '',
    toolPrompts: Record<string, string> = {},
    compactionPrompt: string = DEFAULT_COMPACTION_PROMPT
  ) {
    super()
    this.config = config
    this.provider = provider
    this.toolRegistry = toolRegistry
    this.session = session
    this.basePrompt = basePrompt
    this.toolPrompts = toolPrompts
    this.compactionPrompt = compactionPrompt
  }

  /**
   * Context-window fullness for the fleet map's tile gauge: last API-reported
   * token count (the same baseline the auto-compact gate trusts) against the
   * compact threshold. Zero tokens means no turn has run yet.
   */
  getContextGauge(): { tokens: number; threshold: number } | undefined {
    try {
      const threshold = this.config.context?.compact_threshold ?? this.config.model.compact_threshold ?? 100000
      const last = this.session.getWorkspace().getLastAssistantTokens()
      const tokens = last ? (last.input ?? 0) + (last.output ?? 0) : 0
      return { tokens, threshold }
    } catch {
      return undefined
    }
  }

  /**
   * Per-request context token breakdown (pull IPC). Expensive figures (system
   * prompt, tool schemas) come from the builder caches — warmed on demand when
   * no turn has run yet — so a read never re-tokenizes a warm executor.
   * Dynamic-instruction and message figures are cheap and computed per read.
   * Never throws: a half-initialized executor returns null.
   */
  getContextBreakdown(): ContextBreakdown | null {
    try {
      this.buildSystemPrompt()
      this.buildToolSnapshot()
      if (!this.systemPromptCache || !this.toolSnapshotCache) return null
      const tc = getTokenCounterService()
      return assembleContextBreakdown({
        systemPromptTokens: this.systemPromptCache.promptTokens,
        injectedFiles: this.systemPromptCache.injectedFiles,
        toolGroups: this.toolSnapshotCache.toolGroups,
        toolsTotalTokens: this.toolSnapshotCache.toolsTotalTokens,
        dynamicInstructionsTokens: this.currentDynamicInstructions
          ? this.countPromptTokens(this.currentDynamicInstructions)
          : 0,
        messagesTokens: tc.estimateMessagesTokens(this.session.getMessages()),
      })
    } catch {
      return null
    }
  }

  /**
   * End the current turn and move the still-running executor to an ordinary
   * runtime state. Trigger eligibility remains owned by TriggerEvaluator.
   */
  endTurnAndSetState(targetState: 'idle' | 'hibernate'): void {
    const midTurn = this.state === 'thinking' || this.state === 'tool_use' ||
      this.state === 'awaiting_approval' || this.state === 'awaiting_ask' || this.state === 'suspended'
    if (!midTurn) {
      this.applyDeferredStateTransition(targetState)
      return
    }

    this._lastTargetState = targetState
    this._ownerStateTransitionRequested = true
    // Mirror the chat-interrupt teardown (executeTurnImpl's chat branch),
    // minus pendingInterrupt/_interruptRestart — there is nothing to restart.
    if (this.bufferTimer) { clearTimeout(this.bufferTimer); this.bufferTimer = null }
    this.deltaQueue.length = 0
    for (const pending of this.pendingHilTasks.values()) pending.resolve({ approved: false })
    this.pendingHilTasks.clear()
    for (const pending of this.pendingAsks.values()) pending.resolve('')
    this.pendingAsks.clear()
    if (this.pendingSuspend) {
      this.pendingSuspend.resolve(false)
      this.pendingSuspend = null
    }
    this.abortController?.abort()
  }

  getState(): AgentState {
    return this.state
  }

  /**
   * True while ANY turn is running or is already committed to run.
   *
   * `getState()` is not sufficient for external memory reclamation: it reads
   * 'idle' during a turn's pre-thinking awaits (auto-compact, provider
   * validation) and during the whole nextTick gap between a finishing turn and
   * the re-entrant successor it scheduled (interrupt restart, unconsumed
   * interrupt, queued-trigger drain). Those successors never pass through the
   * lifecycle's dispatch() choke point, so `hasInFlightDispatch()` does not see
   * them either. The counter below is claimed synchronously — for a successor
   * BEFORE the current turn releases its own slot — so an outside observer
   * never sees a false 'between turns' window.
   */
  isTurnActive(): boolean {
    return this.activeTurnCount > 0
  }

  /** The last target state set by sys_set_state, or null if none. */
  private _lastTargetState: string | null = null
  getLastTargetState(): string | null {
    return this._lastTargetState
  }

  /**
   * Apply a state transition from outside the turn loop (e.g., when task_resolve
   * approves a sys_set_state task after the agent's turn has already ended).
   */
  applyDeferredStateTransition(targetState: string): void {
    // Hard off is never deferred. Aborts the in-flight LLM call, clears all
    // pending state, and signals teardown. This is the security guarantee for
    // remote shutdown — a compromised child cannot keep executing for the
    // remainder of its turn while waiting to be stopped.
    if (targetState === 'off') {
      this._lastTargetState = null
      if (this.state !== 'stopped') {
        this.abort()
      }
      this.emitEvent({ type: 'state_changed', payload: { state: 'off' }, timestamp: Date.now() })
      return
    }
    if (this.state === 'thinking' || this.state === 'tool_use') {
      // Mid-turn: set target state for the finally block to handle
      this._lastTargetState = targetState
    } else {
      // Idle/other: apply immediately
      this.state = 'idle'
      this.cancelScheduledRecovery('state_transition')
      this.pendingTriggers = []
      this.pendingInterrupt = null
      this.emitEvent({ type: 'state_changed', payload: { state: targetState }, timestamp: Date.now() })
    }
  }

  /** Returns pending HIL approval requests so the renderer can restore UI after navigation. */
  getPendingApprovals(): Array<{ requestId: string; name: string; input: unknown } & ApprovalMeta> {
    const result: Array<{ requestId: string; name: string; input: unknown } & ApprovalMeta> = []
    for (const [taskId, pending] of this.pendingHilTasks) {
      result.push({ requestId: taskId, name: pending.name, input: pending.input, ...pending.meta })
    }
    return result
  }

  /** Approval meta for a pending request — used to refuse "always approve" server-side. */
  getPendingApprovalMeta(requestId: string): ApprovalMeta | undefined {
    return this.pendingHilTasks.get(requestId)?.meta
  }

  /**
   * Why an approval prompt is shown and whether "Always approve" is allowed.
   * Always-approve persists {enabled, restricted:false} on the declaration, so
   * it is refused when the declaration is locked or when the approval is a
   * protection override (the lock lives on the target, not the tool).
   */
  private buildApprovalMeta(name: string, protection?: ProtectionDenial): ApprovalMeta {
    if (protection) {
      return {
        reason: 'protection',
        protection,
        canAlwaysApprove: false,
        alwaysApproveBlockedReason: `Target is locked (${protection.level})`
      }
    }
    if (this.config.tools.find(t => t.name === name)?.locked === true) {
      return { reason: 'restricted', canAlwaysApprove: false, alwaysApproveBlockedReason: 'Tool declaration is locked' }
    }
    return { reason: 'restricted', canAlwaysApprove: true }
  }

  /** Reset context-injection state after a loop clear. Re-snapshots injected
   *  files ({{mind.md}} etc.) and re-injects system prompt / dynamic
   *  instructions into the loop on the next turn. Called internally by
   *  loop_clear/compaction, and externally when the loop is wiped outside the
   *  executor (UI Clear button, mesh resetAgentSession) — without it the
   *  dedup hashes and file snapshots survive the wipe, so the cleared loop
   *  never receives the context entries again and the system prompt keeps
   *  stale injected-file content. */
  resetContextState(): void {
    this.lastSystemPromptHash = undefined
    this.lastDynamicInstructions = undefined
    this.currentDynamicInstructions = undefined
    this.injectedFileSnapshots = null
    this.compactionWarningTier = 'none'
    this.memoryFlushNudgeIssued = false
  }

  /** Live config accessor — components that must never gate against a stale
   *  snapshot (e.g. the shell tool) read through this instead of holding their
   *  own copy. Every config fan-out site already calls updateConfig() here. */
  getConfig(): AgentConfig {
    return this.config
  }

  /** True when this executor runs a side loop (derived-config marker set by
   *  deriveLoopConfig; a stored .adf never carries it). */
  private isSideLoop(): boolean {
    const name = this.config.metadata?.loop_name
    return typeof name === 'string' && name.length > 0 && name !== 'main'
  }

  updateConfig(config: AgentConfig): void {
    this.config = config
    // Invalidate system prompt cache when config changes
    this.systemPromptCache = null
    this.toolSnapshotCache = null
    // Invalidate tool cache so tool availability is recalculated
    this.toolRegistry.clearCache()
    // Turning recovery off applies to an already-armed retry, not just the
    // next failure — the toggle means "stop retrying", now.
    if (config.recovery?.auto_retry === false) this.cancelScheduledRecovery('disabled')
  }

  updateProvider(provider: LLMProvider): void {
    this.provider = provider
    // New provider instance — must re-validate on the next turn.
    this.providerValidated = false
  }

  /** Live provider accessor. The loop pool shares MAIN's provider with every
   *  loop that has no model override, and a reference captured at assembly
   *  would keep those loops on the old model after the owner changed the
   *  agent's (review M4d). */
  getProvider(): LLMProvider | null {
    return this.provider
  }

  private buildToolSnapshot(): ToolSnapshot {
    const updatedAt = this.config.metadata?.updated_at
    if (this.toolSnapshotCache?.updatedAt === updatedAt) {
      return this.toolSnapshotCache.snapshot
    }

    const declaredTools = this.config.messaging?.receive
      ? this.config.tools
      : this.config.tools.filter(t => !MSG_TOOLS.has(t.name))
    // One declaration per name, first-wins with sticky restricted/locked — a
    // duplicate entry must never be able to unlock or de-restrict an earlier one.
    const { deduped: activeDeclarations, duplicateNames } = dedupeToolDeclarations(declaredTools)
    if (duplicateNames.length > 0) {
      try {
        this.session.getWorkspace().insertLog(
          'warn',
          'executor',
          'duplicate_tool_declaration',
          duplicateNames.join(','),
          `Ignored duplicate tools[] entries for: ${duplicateNames.join(', ')} (first declaration wins; restricted/locked cannot be cleared by a duplicate)`,
        )
      } catch { /* observability must never break the loop */ }
    }
    // adf_shell is presented ALONGSIDE the other tools — enabling it no longer
    // hides anything. A tool's presence in the schema list is governed solely by
    // its own enabled+visible flags (getToolsForAgent). To reclaim the old
    // absorption token-savings (e.g. small-context/local models), toggle the
    // shell-absorbable tools' `visible` flag off — see isAbsorbedByShell for the
    // canonical set. Shell can still call them by name regardless of visibility.
    const tools = this.toolRegistry.getToolsForAgent(activeDeclarations)
    const schemas = tools.map(t => {
      const schema = t.toProviderFormat()
      const props = (schema.input_schema.properties ?? {}) as Record<string, unknown>
      props._reason = { type: 'string', description: 'Why you are calling this tool in ~10 words or less.' }
      if (ASYNC_ALLOWED_TOOLS.has(t.name) || t.name.startsWith('mcp_')) {
        props._async = { type: 'boolean', default: false, description: 'Run in background as a task. Returns a task_id immediately.' }
      }
      schema.input_schema.properties = props
      return schema
    })

    const snapshot = {
      // Execution is gated on `enabled` only — NOT visibility. An enabled tool is
      // callable from the LLM loop even when `visible: false` (it's just absent from
      // the advertised schema). This is what lets agents drive enabled tools via
      // custom/extended tool schemas. `allTools` is enabled+visible, so build the
      // guard set from the full enabled declaration list instead.
      schemas,
      enabledNames: new Set(activeDeclarations.filter(d => d.enabled).map(d => d.name)),
      declarations: new Map(activeDeclarations.map(d => [d.name, d])),
    }
    // Measure the schemas exactly as returned (post _reason/_async mutation) —
    // that serialized JSON is what ships with every request. Rebuild-only cost.
    const { groups: toolGroups, totalTokens: toolsTotalTokens } = measureToolSchemas(
      schemas.map((schema, i) => ({ schema, tool: tools[i] })),
      (text) => this.countPromptTokens(text)
    )
    this.toolSnapshotCache = { updatedAt, snapshot, toolGroups, toolsTotalTokens }
    return snapshot
  }

  /** Provider id fed to the tokenizer selection (real tokenizer when known,
   *  char fallback otherwise). Never throws on a half-initialized executor. */
  private tokenizerProviderId(): string {
    return this.provider?.providerId || this.config.model?.provider || 'unknown'
  }

  private countPromptTokens(text: string): number {
    return getTokenCounterService().countTokens(text, this.tokenizerProviderId())
  }

  setMeshContext(fn: () => { handle: string; description: string }[]): void {
    this.meshContextFn = fn
  }

  clearMeshContext(): void {
    this.meshContextFn = null
  }

  setSystemScopeHandler(handler: SystemScopeHandler): void {
    this.systemScopeHandler = handler
  }

  /**
   * Request human approval for a tool call. Creates a task in adf_tasks,
   * emits a `tool_approval_request` event, and pauses the executor until
   * the task is resolved via task_resolve (from UI dialog or lambda).
   */
  requestHilApproval(
    name: string,
    input: unknown,
    meta?: ApprovalMeta,
    opts?: { umbilicalReason?: string }
  ): Promise<{ approved: boolean; taskId: string; modifiedArgs?: Record<string, unknown>; feedback?: string }> {
    const taskId = `task_${nanoid(12)}`
    const argsStr = JSON.stringify(input ?? {})
    const originLabel = this.config.id
      ? `hil:${this.config.name}:${this.config.id}`
      : `hil:${this.config.name}`
    const approvalMeta = meta ?? this.buildApprovalMeta(name)

    // Create task: requires_authorization + executor_managed + pending_approval.
    // Persist the durable approval metadata (reason + protection, which carries
    // the plain-English description) on the row so on_task_create lambdas, the
    // tasks panel, and post-restart reads see WHAT is being approved, not just
    // tool+args. UI-derived fields (canAlwaysApprove/tooltips) stay off the row.
    const taskApprovalMeta = JSON.stringify({
      reason: approvalMeta.reason,
      ...(approvalMeta.protection ? { protection: approvalMeta.protection } : {})
    })
    const workspace = this.session.getWorkspace()
    workspace.insertTask(taskId, name, argsStr, originLabel, true, true, taskApprovalMeta)
    workspace.updateTaskStatus(taskId, 'pending_approval')

    // Fire on_task_create trigger (so lambdas can dispatch approval requests)
    const task = workspace.getTask(taskId)
    if (task) this.onTaskCreated?.(task)

    this.setState('awaiting_approval')
    this.emitEvent({
      type: 'tool_approval_request',
      payload: { requestId: taskId, taskId, name, input, ...approvalMeta },
      timestamp: Date.now()
    })
    this.emitRuntimeEvent('hil.requested', {
      request_id: taskId,
      task_id: taskId,
      tool: name,
      reason: opts?.umbilicalReason ?? approvalMeta.reason,
      input: stripInternalToolFlags(input),
    })

    return new Promise<{ approved: boolean; taskId: string; modifiedArgs?: Record<string, unknown>; feedback?: string }>((resolve) => {
      this.pendingHilTasks.set(taskId, {
        resolve: (r) => resolve({ ...r, taskId }),
        name, input, meta: approvalMeta
      })
    })
  }

  /** Default auto-deny timeout for protection approvals requested by sandboxed code. */
  private static readonly PROTECTION_APPROVAL_TIMEOUT_MS = 1_200_000

  /**
   * Blocking HIL override request for a protection denial (locked file, meta
   * key, or config field). Used by the shell pipeline and sandboxed code — the
   * caller re-executes the tool itself, so the approval task is closed here.
   * `timeoutMs: null` disables the auto-deny (interactive shell); a number
   * arms an auto-deny so headless code can't hang forever.
   */
  async requestProtectionApproval(
    name: string,
    input: unknown,
    protection: ProtectionDenial,
    opts?: { timeoutMs?: number | null }
  ): Promise<{ approved: boolean; modifiedArgs?: Record<string, unknown>; feedback?: string }> {
    const meta = this.buildApprovalMeta(name, protection)
    const promise = this.requestHilApproval(name, input, meta)

    // requestHilApproval registers the pending entry synchronously — find ours
    // by meta identity so the auto-deny timer targets exactly this request.
    let pendingTaskId: string | undefined
    for (const [taskId, pending] of this.pendingHilTasks) {
      if (pending.meta === meta) { pendingTaskId = taskId; break }
    }

    let timer: NodeJS.Timeout | null = null
    const timeoutMs = opts?.timeoutMs === undefined ? AgentExecutor.PROTECTION_APPROVAL_TIMEOUT_MS : opts.timeoutMs
    if (timeoutMs !== null && pendingTaskId !== undefined) {
      const autoDenyTaskId = pendingTaskId
      // resolveHilTask is idempotent (map check), so a late human decision is a no-op.
      timer = setTimeout(() => {
        this.resolveHilTask(autoDenyTaskId, false, undefined, 'Auto-denied: no decision within timeout', { timedOut: true })
      }, timeoutMs)
    }

    const { approved, taskId, modifiedArgs, feedback } = await promise
    if (timer) clearTimeout(timer)
    const workspace = this.session.getWorkspace()
    if (approved) {
      workspace.updateTaskStatus(taskId, 'completed', 'approved')
    } else {
      workspace.updateTaskStatus(taskId, 'denied', undefined, feedback?.trim() || 'Rejected')
    }
    if (this.state !== 'stopped') this.setState('tool_use')
    return { approved, modifiedArgs, feedback }
  }

  /**
   * Boolean HIL approval for tools gated inside a shell pipeline (preflight).
   * The gated tool executes within the shell and reports its result in-band,
   * so unlike the main tool-call flow the approval task is closed here:
   * denied on rejection, completed on approval.
   *
   * `opts.canAlwaysApprove: false` suppresses the "Always approve" affordance for
   * SYNTHETIC approvals whose `name` maps to no declared tool (e.g. the
   * 'mcp_oauth_signin' OAuth sign-in gate). For those, "Always approve" would
   * persist an inert phantom tool declaration and NOT actually suppress future
   * prompts (the gate always re-asks), so only one-shot approve/deny is offered —
   * and the server-side alwaysApproveTool guard refuses it via this meta too.
   */
  async requestApproval(
    name: string,
    input: unknown,
    opts?: { canAlwaysApprove?: boolean }
  ): Promise<boolean> {
    const meta: ApprovalMeta | undefined = opts?.canAlwaysApprove === false
      ? { reason: 'restricted', canAlwaysApprove: false, alwaysApproveBlockedReason: 'One-time approval only for this request' }
      : undefined
    const { approved, taskId, feedback } = await this.requestHilApproval(
      name, input, meta, { umbilicalReason: 'shell_gate' }
    )
    const workspace = this.session.getWorkspace()
    if (approved) {
      workspace.updateTaskStatus(taskId, 'completed', 'approved')
    } else {
      workspace.updateTaskStatus(taskId, 'denied', undefined, feedback?.trim() || 'Rejected')
    }
    // If the agent was stopped while awaiting approval, don't resurrect it —
    // abort()/teardown resolve pending HIL as denied, and flipping state back
    // to tool_use here would contradict the stopped-agent guarantee.
    if (this.state !== 'stopped') this.setState('tool_use')
    return approved
  }

  /**
   * Resolve a pending HIL task. Called when task_resolve approves/denies
   * an executor-managed task (routed via onHilApproved callback).
   */
  resolveHilTask(
    taskId: string,
    approved: boolean,
    modifiedArgs?: Record<string, unknown>,
    feedback?: string,
    opts?: { timedOut?: boolean }
  ): void {
    const pending = this.pendingHilTasks.get(taskId)
    if (pending) {
      this.pendingHilTasks.delete(taskId)
      // Dismiss the UI approval dialog (requestId === taskId)
      this.emitEvent({
        type: 'tool_approval_resolved',
        payload: { requestId: taskId, approved },
        timestamp: Date.now()
      })
      this.emitRuntimeEvent('hil.resolved', {
        request_id: taskId,
        task_id: taskId,
        approved,
        ...(feedback ? { feedback } : {}),
        ...(opts?.timedOut ? { timed_out: true } : {}),
      })
      pending.resolve({ approved, modifiedArgs, feedback })
    }
  }

  /**
   * @deprecated Use resolveHilTask instead. Kept for backward compatibility
   * during migration — maps requestId (which is now taskId) to resolveHilTask.
   */
  resolveApproval(requestId: string, approved: boolean, feedback?: string): void {
    this.resolveHilTask(requestId, approved, undefined, feedback)
  }

  /**
   * Approve every pending *gated* (reason === 'restricted') HIL task in one
   * action — the "Approve all" affordance for batched tool calls. Protection
   * overrides (reason === 'protection') are NEVER approved here: destructive
   * lock overrides stay deliberate and must each be approved individually.
   * The filter is enforced server-side so a client cannot batch-approve a
   * protection override even if it asks. Returns counts so the UI can report
   * how many protection overrides still need individual attention.
   */
  approveAllGatedHilTasks(): { approved: number; skippedProtection: number } {
    // Collect first — resolveHilTask mutates pendingHilTasks during iteration.
    const restrictedTaskIds: string[] = []
    let skippedProtection = 0
    for (const [taskId, pending] of this.pendingHilTasks) {
      if (pending.meta.reason === 'protection') {
        skippedProtection++
        continue
      }
      restrictedTaskIds.push(taskId)
    }
    for (const taskId of restrictedTaskIds) {
      this.resolveHilTask(taskId, true)
    }
    return { approved: restrictedTaskIds.length, skippedProtection }
  }

  /** Returns pending ask requests so the renderer can restore UI after navigation. */
  getPendingAsks(): Array<{ requestId: string; question: string }> {
    const result: Array<{ requestId: string; question: string }> = []
    for (const [requestId, pending] of this.pendingAsks) {
      result.push({ requestId, question: pending.question })
    }
    return result
  }

  /**
   * Request human input for an ask tool call. Emits an `ask_request`
   * event and pauses the executor until the user responds via `resolveAsk`.
   */
  private requestAsk(question: string): Promise<string> {
    const requestId = `ask_${++this.askCounter}`
    this.setState('awaiting_ask')
    this.emitEvent({
      type: 'ask_request',
      payload: { requestId, question },
      timestamp: Date.now()
    })
    this.emitRuntimeEvent('ask.requested', { request_id: requestId, question })
    return new Promise<string>((resolve) => {
      this.pendingAsks.set(requestId, { resolve, question })
    })
  }

  /**
   * Resolve a pending ask request. Called from the IPC handler
   * when the human types an answer.
   */
  resolveAsk(requestId: string, answer: string): void {
    const pending = this.pendingAsks.get(requestId)
    if (pending) {
      this.pendingAsks.delete(requestId)
      // The human's answer is not leaked wholesale onto the umbilical — taps
      // get shape (length, a bounded preview), not the full text.
      const text = typeof answer === 'string' ? answer : ''
      this.emitRuntimeEvent('ask.resolved', {
        request_id: requestId,
        has_response: text.length > 0,
        response_length: text.length,
        ...(text.length > 0 ? { preview: text.slice(0, 200) } : {}),
      })
      pending.resolve(answer)
    }
  }

  hasPendingSuspend(): boolean {
    return this.pendingSuspend !== null
  }

  /** Default suspend timeout: 20 minutes */
  private static readonly SUSPEND_TIMEOUT_MS = 1_200_000

  /**
   * Request owner decision when max_active_turns is hit.
   * Emits a `suspend_request` event and pauses until resolved.
   * Auto-rejects after the configured suspend timeout (default 20 min).
   */
  private requestSuspendApproval(): Promise<boolean> {
    this.setState('suspended')
    this.emitEvent({
      type: 'suspend_request',
      payload: { reason: 'max_active_turns' },
      timestamp: Date.now()
    })
    this.emitRuntimeEvent('suspend.requested', { reason: 'max_active_turns' })
    const timeoutMs = this.config.limits?.suspend_timeout_ms ?? AgentExecutor.SUSPEND_TIMEOUT_MS
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingSuspend) {
          this.pendingSuspend = null
          this.emitRuntimeEvent('suspend.resolved', { resumed: false, timed_out: true })
          resolve(false)
        }
      }, timeoutMs)
      this.pendingSuspend = {
        resolve: (resume: boolean) => {
          clearTimeout(timer)
          resolve(resume)
        }
      }
    })
  }

  /**
   * Resolve a pending suspend. Called from the IPC handler.
   * @param resume true = resume (→ active), false = shut down (→ off)
   */
  resolveSuspend(resume: boolean): void {
    if (this.pendingSuspend) {
      const pending = this.pendingSuspend
      this.pendingSuspend = null
      this.emitRuntimeEvent('suspend.resolved', { resumed: resume })
      pending.resolve(resume)
    }
  }

  /**
   * Execute a single agent turn:
   * 1. Build messages from session + trigger context
   * 2. Call LLM with tools
   * 3. If tool_use, execute tools, append results, loop
   * 4. If end_turn, done
   *
   * Thin wrapper establishes the AsyncLocalStorage context for this turn so
   * every umbilical event emitted during the turn carries source=agent:<turnId>.
   * All recursive self-calls (process.nextTick path) start a new turn and
   * therefore a new context with a fresh turn id — that is the intended semantic.
   */
  async executeTurn(dispatch: AdfEventDispatch | AdfBatchDispatch, opts?: TurnOptions): Promise<void> {
    // Claim the turn slot synchronously, before the first await, so a caller
    // that only awaits the returned promise can never observe isTurnActive()
    // as false for a turn it has already started.
    this.activeTurnCount++
    return this.runClaimedTurn(dispatch, opts)
  }

  /** Run a turn whose activeTurnCount slot is ALREADY claimed, releasing it
   *  when the turn (including its finally-block bookkeeping) has settled. */
  private async runClaimedTurn(
    dispatch: AdfEventDispatch | AdfBatchDispatch,
    opts?: TurnOptions,
  ): Promise<void> {
    const turnId = nanoid(10)
    try {
      return await withSource(`agent:${turnId}`, this.config.id, () => this.executeTurnImpl(dispatch, opts, turnId))
    } finally {
      this.activeTurnCount--
      // True turn boundary: a successor scheduled by scheduleReentrantTurn has
      // already claimed its slot, so a zero here means nothing is queued behind
      // this turn. The loop pool consumes its pending wake here — a naive
      // "is it running?" check races the self-scheduling successor and makes
      // inter-loop delivery nondeterministic (LoopPoolApi.sendToLoop contract).
      if (this.activeTurnCount === 0 && this.onTurnSettled) {
        try { this.onTurnSettled() } catch (error) {
          console.error('[AgentExecutor] onTurnSettled hook threw:', error)
        }
      }
    }
  }

  /**
   * Hand the turn loop back to itself for a follow-up dispatch (interrupt
   * restart, unconsumed interrupt, queued-trigger drain).
   *
   * process.nextTick keeps the successor ahead of macrotasks like IPC handlers.
   * The successor's slot is claimed HERE — synchronously, inside the current
   * turn's finally block — so it is already held when the current turn's own
   * slot is released one microtask later. Without that overlap the nextTick
   * queue (which Node drains only after all pending microtasks) would expose a
   * window where the executor reports 'idle' with no active turn, and the idle
   * sweep would release the session out from under the successor's pre-thinking
   * awaits: the turn is dropped and its trigger never gets a response.
   */
  private scheduleReentrantTurn(
    dispatch: AdfEventDispatch | AdfBatchDispatch,
    opts?: TurnOptions,
  ): void {
    this.activeTurnCount++
    process.nextTick(() => {
      // Re-entrant turns bypass the lifecycle dispatch() choke point and so
      // miss its rehydrate. Cheap no-op unless the session really is empty.
      try {
        this.rehydrateSessionIfReleased(dispatch)
      } catch (error) {
        console.error('[AgentExecutor] Re-entrant session rehydrate failed:', error)
      }
      void this.runClaimedTurn(dispatch, opts).catch((error) => {
        console.error('[AgentExecutor] Re-entrant turn failed:', error)
      })
    })
  }

  /** Restore an idle-swept (or otherwise externally reset) session from the
   *  loop table. Mirrors the lifecycle dispatch() rehydrate for turn entries
   *  that never pass through it; system-scope dispatches never read the session
   *  so they skip it, avoiding release/rehydrate churn on lambda-heavy agents. */
  private rehydrateSessionIfReleased(dispatch: AdfEventDispatch | AdfBatchDispatch): void {
    if (dispatch.scope === 'system') return
    if (this.session.getMessages().length > 0) return
    const loop = this.session.getWorkspace().getLoop()
    if (loop.length === 0) return
    this.session.restoreMessages(loop.map(entry => ({
      role: entry.role,
      content: entry.content_json,
      created_at: entry.created_at,
      seq: entry.seq,
    })))
  }

  /**
   * True when this dispatch's pre-appended row is ALREADY in the session, so
   * inlining its content again would show the model the same message twice.
   *
   * The normal case after an idle sweep: `loop_send` (and `deliverOwnerMessage`)
   * write the row at send time, the session is cold, the dispatch rehydrates it
   * from the stream — and then the turn inlines the identical content on top.
   * `injectWithoutWake` already guards the no-wake half of this (empty session ⇒
   * rehydrate covers it ⇒ skip the injection); this is the wake half, and it
   * covers main's ingest path as well as a side loop's (review M6).
   *
   * Keyed on the row's seq rather than on the text: restored messages carry
   * their seq, the seq space is per-stream, and a session only ever holds its
   * own loop's rows. A live session that never saw the row has no message with
   * that seq, so the warm path still inlines exactly once.
   */
  private preAppendedRowAlreadyInSession(dispatch: AdfEventDispatch | AdfBatchDispatch): boolean {
    const seq = preAppendedLoopSeq(dispatch)
    if (seq === undefined) return false
    return this.session.getMessages().some(message => message.seq === seq)
  }

  /**
   * A dropped dispatch never reached the handler, so nothing downstream emitted
   * a terminal umbilical event for it: `timer.fired` (or the trigger's own
   * event) would sit there with no lambda.started/lambda.completed pair. Close
   * the pair here, then hand the error back so the host's onTriggerError sees
   * it — silently resolving a drop is what made this invisible.
   */
  private reportDroppedDispatch(
    dispatch: AdfEventDispatch | AdfBatchDispatch,
    error: SystemDispatchDroppedError,
  ): SystemDispatchDroppedError {
    const lambda = dispatch.lambda ?? dispatch.command ?? null
    const lastColon = dispatch.lambda ? dispatch.lambda.lastIndexOf(':') : -1
    const filePath = lastColon > 0 ? dispatch.lambda!.slice(0, lastColon) : dispatch.lambda
    const fnName = lastColon > 0 ? dispatch.lambda!.slice(lastColon + 1) : 'main'
    emitUmbilicalEvent({
      event_type: 'lambda.failed',
      agentId: this.config.id,
      source: lambda ? `lambda:${lambda}` : 'lambda:(none)',
      payload: {
        lambda_path: filePath, function_name: fnName, kind: 'system_scope',
        trigger: error.trigger, dropped: true, error: error.message,
      },
    })
    console.error(`[AgentExecutor] ${error.message}`)
    return error
  }

  private async executeTurnImpl(dispatch: AdfEventDispatch | AdfBatchDispatch, opts?: TurnOptions, turnId?: string): Promise<void> {
    // Global kill switch: noop any in-flight microtasks queued before EmergencyStop.
    if (RuntimeGate.stopped) return
    // Hard stop: refuse all execution when the executor has been killed.
    if (this.state === 'stopped') return

    // Protection-override denials are final only within a turn.
    this.deniedProtectionKeys.clear()

    // Extract the event type from dispatch or batch
    const eventType = 'event' in dispatch ? dispatch.event.type : dispatch.events[0]?.type
    const scope = dispatch.scope

    // System scope triggers: execute lambda if handler is configured.
    // Everything below the queue is system scope only — agent turns return past
    // this branch and are never held or dropped by backpressure.
    if (scope === 'system') {
      console.log(`[AgentExecutor] System scope trigger: type=${eventType}, lambda=${'lambda' in dispatch ? dispatch.lambda ?? 'none' : 'none'}, handler=${this.systemScopeHandler ? 'set' : 'NULL'}`)
      if (this.systemScopeHandler && 'event' in dispatch) {
        try {
          await this.systemDispatchQueue.run(dispatch, () => this.systemScopeHandler!.execute(dispatch as AdfEventDispatch))
        } catch (err) {
          if (err instanceof SystemDispatchDroppedError) throw this.reportDroppedDispatch(dispatch, err)
          const errorMsg = err instanceof Error ? err.message : String(err)
          console.error(`[AgentExecutor] Lambda execution error:`, err)
          try { this.session.getWorkspace().insertLog('error', 'executor', 'lambda_error', ('lambda' in dispatch ? dispatch.lambda : null) ?? null, errorMsg.slice(0, 200)) } catch { /* non-fatal */ }
        }
      } else if (this.systemScopeHandler && 'events' in dispatch) {
        try {
          await this.systemDispatchQueue.run(dispatch, () => this.systemScopeHandler!.executeBatch(dispatch as AdfBatchDispatch))
        } catch (err) {
          if (err instanceof SystemDispatchDroppedError) throw this.reportDroppedDispatch(dispatch, err)
          const errorMsg = err instanceof Error ? err.message : String(err)
          console.error(`[AgentExecutor] Lambda batch execution error:`, err)
          try { this.session.getWorkspace().insertLog('error', 'executor', 'lambda_error', ('lambda' in dispatch ? dispatch.lambda : null) ?? null, errorMsg.slice(0, 200)) } catch { /* non-fatal */ }
        }
      } else {
        console.warn(`[AgentExecutor] No SystemScopeHandler — system scope trigger ignored`)
        // A side loop has no SystemScopeHandler by construction (§2.3: system
        // scope runs under main's unattenuated authority), so this branch is
        // the security outcome working as designed — but a console.warn is
        // invisible to the operator. Record the drop where drops are looked
        // for. Main hitting this is a different, rarer condition (no handler
        // wired at all), so it gets its own event name.
        const boundLoop = this.session.getWorkspace().getLoopName()
        try {
          this.session.getWorkspace().insertLog(
            'warn',
            'executor',
            boundLoop === MAIN_LOOP ? 'system_dispatch_unhandled' : 'loop_dispatch_dropped',
            ('lambda' in dispatch ? dispatch.lambda : null) ?? null,
            boundLoop === MAIN_LOOP
              ? `Dropped a system-scope ${eventType ?? 'trigger'} dispatch — this agent has no system-scope handler`
              : `Dropped a system-scope ${eventType ?? 'trigger'} dispatch that reached loop "${boundLoop}" — side loops never run system scope, and it is never re-pointed at main`,
          )
        } catch { /* observability is never fatal */ }
      }
      return
    }

    // In error state, only manual user messages can recover the agent.
    if (this.state === 'error') {
      if (eventType !== 'chat') return
    }

    if (this.state === 'thinking' || this.state === 'tool_use' || this.state === 'awaiting_approval' || this.state === 'awaiting_ask' || this.state === 'suspended') {
      // User messages: abort current turn and restart with user's message
      if (eventType === 'chat') {
        this.pendingInterrupt = dispatch
        this._interruptRestart = true
        this.abortController?.abort()
        if (this.bufferTimer) { clearTimeout(this.bufferTimer); this.bufferTimer = null }
        this.deltaQueue.length = 0
        for (const pending of this.pendingHilTasks.values()) pending.resolve({ approved: false })
        this.pendingHilTasks.clear()
        for (const pending of this.pendingAsks.values()) pending.resolve('')
        this.pendingAsks.clear()
        if (this.pendingSuspend) {
          this.pendingSuspend.resolve(false)
          this.pendingSuspend = null
        }
        return
      }
      this.queuePendingTrigger(dispatch, eventType)
      return
    }

    // Fresh work supersedes any scheduled provider-error retry — the loop
    // already holds the failed trigger message, so this turn resumes that
    // work naturally. The attempt counter deliberately does NOT reset here:
    // it counts consecutive provider FAILURES and resets only on a successful
    // call, otherwise a recurring trigger (e.g. a 1-minute timer) would reset
    // it every cycle and defeat max_attempts against a dead provider.
    if (!opts?.isRecoveryRetry) {
      this.cancelScheduledRecovery('superseded')
    }

    const checkpointId = turnId ?? nanoid(10)
    this.beginTurnCheckpoint(checkpointId, dispatch, eventType, scope)

    this._isMessageTriggered = eventType === 'inbox'
    this.abortController = new AbortController()

    try {
      const triggerContent = this.buildTriggerContent(dispatch)
      const triggerMessage = this.contentBlocksToText(triggerContent)
      // Error-recovery retries re-run the same dispatch against a history that
      // already contains the trigger message — don't add it twice. Neither does
      // a wake whose pre-appended row the session ALREADY holds (review M6).
      const skipTriggerMessage = opts?.skipTriggerMessage === true
        || this.preAppendedRowAlreadyInSession(dispatch)
      if (!skipTriggerMessage) {
        // Owner messages were already appended to the loop at delivery time
        // (deliverOwnerMessage) so they're visible immediately — inline them
        // into the session for the LLM without writing a duplicate loop row.
        // The delivery-time row's seq rides the dispatch (loop_seq) so the
        // inlined message still gets its [S<seq>] marker.
        const preAppended = isPreAppendedDispatch(dispatch)
        this.session.addMessage(
          { role: 'user', content: triggerContent },
          undefined,
          { skipLoop: preAppended, seq: preAppendedLoopSeq(dispatch) }
        )
        // addMessage wrote the trigger through to the loop synchronously, so
        // it is on disk the moment the turn starts. This retry-flush only
        // re-attempts the insert if it failed (DB busy).
        this.session.flushToLoop()
      }
      // Provider-recovery retry: tell the model what failed and how long has
      // passed, mirroring the crash-recovery checkpoint notice. Added here —
      // after the re-entrant rehydrate — so an idle-swept session can't lose
      // the history the notice rides on.
      if (opts?.recoveryNotice) {
        this.session.addMessage({
          role: 'user',
          content: [{ type: 'text', text: opts.recoveryNotice }]
        })
        // The chat panel renders live from events, not the loop — without this
        // the notice only appears after a transcript reload.
        this.emitEvent({
          type: 'context_injected',
          payload: { category: 'System', content: opts.recoveryNotice },
          timestamp: Date.now()
        })
      }
      // Skip trigger_message event on interrupt restart — the renderer already has the message.
      // Chat triggers skip it ONLY when the sending UI echoed the message
      // itself (chat panel); fleet-bar chat has no echo and must emit.
      if (this._skipNextTriggerEvent || skipTriggerMessage) {
        this._skipNextTriggerEvent = false
      } else if (eventType !== 'chat' || !isEchoedChat(dispatch)) {
        this.emitEvent({
          type: 'trigger_message',
          payload: { content: triggerMessage, triggerType: eventType ?? 'unknown' },
          timestamp: Date.now()
        })
      }

      // Prefer the last API-reported token count (includes system prompt + tool schemas);
      // fall back to a cheap char-based estimate when no prior turn exists.
      // The estimate is known to underreport because it ignores system + tools, so it
      // can let an oversized turn slip past the auto-compact gate. Using the persisted
      // API count avoids re-tokenizing on every turn (perf) while staying accurate.
      const tokenCounter = getTokenCounterService()
      const compactThreshold = this.config.context?.compact_threshold ?? this.config.model.compact_threshold ?? 100000
      const lastTokens = this.session.getWorkspace().getLastAssistantTokens()
      let chatTokens = lastTokens
        ? (lastTokens.input ?? 0) + (lastTokens.output ?? 0)
        : tokenCounter.estimateMessagesTokens(this.session.getMessages())

      let continueLoop = true
      let activeTurns = 0
      const maxActiveTurns = this.config.limits?.max_active_turns ?? null
      // Track target state from sys_set_state tool
      let targetState: string | null = null
      // Circuit breaker for autonomous narration loops: consecutive responses
      // with no tool calls. Escalates the continuation nudge, then forces idle.
      let consecutiveTextOnly = 0
      // Deduplication for context injection ("No Secrets" audit trail)
      // Uses instance-scoped hashes so dedup survives across executeTurn() calls.

      while (continueLoop) {
        // Bail out if the agent was stopped while we were executing tools
        if (this.state === 'stopped') break
        // Bail out if a user interrupt triggered a restart
        if (this._interruptRestart) break
        // Bail out if the owner ended the turn with a lifecycle transition
        if (this._ownerStateTransitionRequested) break

        // Check max_active_turns limit
        if (maxActiveTurns !== null && activeTurns >= maxActiveTurns) {
          const resume = await this.requestSuspendApproval()
          // Owner state transition while suspended: use the finally teardown
          // instead of treating the resolved-false as a shutdown decision.
          if (this._ownerStateTransitionRequested) break
          if (resume) {
            // Owner approved: reset counter and continue
            activeTurns = 0
          } else {
            // Owner denied or timeout: shut down agent
            targetState = 'off'
            this._lastTargetState = 'off'
            continueLoop = false
            this.flushDeltaBuffer()
            this.emitEvent({
              type: 'turn_complete',
              payload: { content: [], targetState: 'off' },
              timestamp: Date.now()
            })
            // Mark as stopped so the finally block doesn't transition to idle
            this.setState('stopped')
            break
          }
        }

        activeTurns++

        // Auto-compact when the threshold is reached (agent didn't compact
        // voluntarily). NOT gated on the loop_compact tool being in the agent's
        // toolset — summarization only needs the provider, so an agent without
        // that tool still gets protected instead of hard-failing on an
        // over-window request.
        if (chatTokens >= compactThreshold && this.provider) {
          if (!this.memoryFlushNudgeIssued) {
            // Grace turn: let the agent flush durable learnings to its mind
            // pages while the full context is still available. The next
            // iteration compacts regardless; the preflight guard below still
            // protects against runaway growth via MEMORY_FLUSH_EMERGENCY.
            this.memoryFlushNudgeIssued = true
            const nudge = 'Context is about to be compacted. Before that happens: write any durable ' +
              'learnings from this loop to your mind pages (update mind.md index + mind/log.md), citing ' +
              'source messages by their [S<seq>] markers. Track unfinished work on an open-thread page. ' +
              'Then continue — compaction follows automatically.'
            this.session.addMessage({ role: 'user', content: [{ type: 'text', text: nudge }] })
            this.emitEvent({
              type: 'context_injected',
              payload: { category: 'System', content: 'Compaction threshold reached — memory-flush grace turn before compacting.' },
              timestamp: Date.now()
            })
          } else {
            this.emitEvent({
              type: 'context_injected',
              payload: { category: 'System', content: 'Auto-compacting conversation history...' },
              timestamp: Date.now()
            })
            chatTokens = await this.forceCompact(`auto: ${chatTokens} >= ${compactThreshold}`)
          }
        }

        // System prompt is stable across turns for prompt caching;
        // per-turn dynamic info (inbox, context warning) goes via dynamicInstructions.
        const systemPrompt = this.buildSystemPrompt()
        const dynamicInstructions = this.buildDynamicInstructions(chatTokens, compactThreshold)
        // Unconditional: getContextBreakdown() must see what THIS turn sends
        // (usually nothing). lastDynamicInstructions can't serve that role —
        // it's a dedup high-water mark that intentionally never clears.
        this.currentDynamicInstructions = dynamicInstructions

        // "No Secrets" context injection — write system prompt and dynamic instructions
        // to the loop so they are visible in the UI and queryable via SQL.
        const currentSPHash = this.systemPromptCache
          ? `${this.systemPromptCache.injectedFilesHash}|${this.systemPromptCache.configHash}`
          : this.hashString(systemPrompt)
        if (currentSPHash !== this.lastSystemPromptHash) {
          this.session.appendContextEntry('system_prompt', systemPrompt)
          this.emitEvent({
            type: 'context_injected',
            payload: { category: 'system_prompt', content: systemPrompt },
            timestamp: Date.now()
          })
          this.lastSystemPromptHash = currentSPHash
        }
        if (dynamicInstructions && dynamicInstructions !== this.lastDynamicInstructions) {
          this.session.appendContextEntry('dynamic_instructions', dynamicInstructions)
          this.emitEvent({
            type: 'context_injected',
            payload: { category: 'dynamic_instructions', content: dynamicInstructions },
            timestamp: Date.now()
          })
          this.lastDynamicInstructions = dynamicInstructions
        }

        // `loop_inject` may be called by code while this turn is waiting on a
        // tool, HIL, or another trigger. Drain only here: the previous tool
        // batch has been committed in full and the next provider request has
        // not started, so an injected user message can never split a
        // tool_use/tool_result exchange.
        this.session.drainContextInjections()

        // Preflight credential check (UX): if the provider's API key is invalid
        // (missing, revoked, depleted balance, billing failure, etc.) we must NOT enter
        // the 'thinking' state — that shows the user a misleading "agent is working"
        // indicator while the request silently fails. Send a tiny test request via
        // provider.validateConfig() instead, cache the result, and surface a clear,
        // actionable error if the credentials don't work.
        //
        // Steady-state cost: one tiny request after agent-start (or after the user
        // updates the provider config / a prior turn returned an auth-class error).
        // No per-turn latency once validated.
        if (!this.providerValidated && this.provider) {
          const validation = await this.provider.validateConfig()
          if (!validation.valid) {
            // A transient outage at preflight (429/5xx/network) is NOT a
            // credentials problem. Throw so the catch classifies it and
            // auto-recovery engages; providerValidated stays false, so the
            // retry turn re-preflights. Only genuine auth failures get the
            // "check your API key" brick below.
            const preflightError = validation.error || 'unknown'
            if (!isAuthError(null, preflightError) && isTransientProviderError(null, preflightError)) {
              throw new Error(`Provider preflight failed: ${preflightError}`)
            }
            const providerLabel = this.provider.name || this.provider.providerId || 'provider'
            const friendly = `Your ${providerLabel} provider isn't authenticated. ` +
              `Check the API key, account balance, and plan limits in Settings → Providers, then try again.` +
              (validation.error ? `\n\nProvider response: ${validation.error}` : '')
            this.setState('error')
            this.emitEvent({
              type: 'error',
              payload: { error: friendly },
              timestamp: Date.now()
            })
            try {
              this.session.getWorkspace().insertLog(
                'error', 'executor', 'provider_credentials_invalid', null,
                (validation.error || 'unknown').slice(0, 300)
              )
            } catch { /* non-fatal */ }
            return
          }
          this.providerValidated = true
        }

        this.setState('thinking')

        // Pre-flight context guard. The threshold check at the top of the loop
        // only sees the LAST completed call's token count. Tool results appended
        // since then are about to be sent but were never measured — a single
        // turn can jump from under-threshold to over the model's context window
        // in one step. Estimate the size of what is ABOUT to be sent and compact
        // *before* the call, instead of letting the provider 400 on it.
        {
          const preflightTokens = this.estimatePreflightTokens(chatTokens, dynamicInstructions)
          // Surface the pre-flight estimate so the status bar reflects the
          // request that is about to go out — visible even if that request then
          // fails with a context_length error (the post-call response_metadata
          // never fires in that case).
          this.emitEvent({
            type: 'response_metadata',
            payload: {
              model: this.provider?.modelId ?? '',
              usage: { input: preflightTokens, output: 0 },
              estimated: true
            },
            timestamp: Date.now()
          })
          // During the memory-flush grace turn the preflight compacts only at
          // an emergency bound above the normal threshold, so the nudge turn
          // isn't immediately killed by the same threshold that triggered it.
          const preflightBound = this.memoryFlushNudgeIssued
            ? Math.min(compactThreshold + MEMORY_FLUSH_EMERGENCY_MARGIN, Math.floor(compactThreshold * MEMORY_FLUSH_EMERGENCY_FACTOR))
            : compactThreshold
          if (preflightTokens >= preflightBound && this.provider) {
            this.emitEvent({
              type: 'context_injected',
              payload: { category: 'System', content: 'Compacting conversation history (context limit reached)…' },
              timestamp: Date.now()
            })
            chatTokens = await this.forceCompact(`preflight: ${preflightTokens} >= ${preflightBound}`)
          }
        }

        // Pre-send guard: detect orphaned tool blocks (e.g. an external session
        // reset landed mid-turn) and repair them instead of letting the provider
        // reject the request. Repair only when an orphan exists — it replaces
        // the array reference, which invalidates the incremental conversion cache.
        {
          const msgs = this.session.getMessages()
          const toolUseIds = new Set<string>()
          const toolResultIds = new Set<string>()
          for (const m of msgs) {
            if (!Array.isArray(m.content)) continue
            for (const b of m.content) {
              if (b.type === 'tool_use' && b.id) toolUseIds.add(b.id)
              else if (b.type === 'tool_result' && b.tool_use_id) toolResultIds.add(b.tool_use_id)
            }
          }
          let hasOrphan = false
          for (const m of msgs) {
            if (!Array.isArray(m.content)) continue
            for (const b of m.content) {
              if (b.type === 'tool_result' && b.tool_use_id && !toolUseIds.has(b.tool_use_id)) {
                hasOrphan = true
                console.error(`[AgentExecutor] Orphan tool_result before createMessage (tool_use_id=${b.tool_use_id}, msgIndex=${msgs.indexOf(m)}/${msgs.length}) — repairing`)
              } else if (b.type === 'tool_use' && b.id && !toolResultIds.has(b.id)) {
                hasOrphan = true
                console.error(`[AgentExecutor] Orphan tool_use before createMessage (id=${b.id}, msgIndex=${msgs.indexOf(m)}/${msgs.length}) — repairing`)
              }
            }
          }
          if (hasOrphan) {
            try { this.session.getWorkspace().insertLog('warn', 'executor', 'orphan_tool_repair', null, 'Repaired orphaned tool blocks before LLM call') } catch { /* non-fatal */ }
            this.session.repairToolPairing()
          }
        }

        // A mid-turn external reset (clear chat / mesh session reset) can leave
        // the history empty after repair. Sending zero messages is a guaranteed
        // provider error — end the turn instead; the next trigger starts fresh.
        if (this.session.getMessages().length === 0) {
          console.warn('[AgentExecutor] Session emptied mid-turn (external reset) — ending turn')
          break
        }

        const thinkingBudget = this.config.model.thinking_budget
        const turnId = 'event' in dispatch ? dispatch.event.id : dispatch.events[0]?.id
        const toolSnapshot = this.buildToolSnapshot()
        const { response, metadata: llmMetadata } = await this.createMessageWithLlmCall('turn', {
          system: systemPrompt,
          messages: this.session.getMessages(),
          dynamicInstructions,
          tools: toolSnapshot.schemas,
          maxTokens: this.config.model.max_tokens || undefined,
          temperature: this.config.model.temperature ?? undefined,
          topP: this.config.model.top_p ?? undefined,
          signal: this.abortController?.signal,
          thinkingBudget,
          reasoning: this.config.model.reasoning,
          providerParams: this.config.model.provider_params,
          onTextDelta: (delta: string) => {
            this.deltaQueue.push({ type: 'text', text: delta })
            this.scheduleDeltaFlush()
          },
          onThinkingDelta: (delta: string) => {
            this.deltaQueue.push({ type: 'thinking', text: delta })
            this.scheduleDeltaFlush()
          }
        }, turnId ? { turn_id: turnId } : undefined)

        // A successful provider call ends the current outage: the recovery
        // counter tracks CONSECUTIVE failures, so it resets here rather than
        // at turn entry (see the isRecoveryRetry comment above).
        this._recoveryAttempts = 0
        this._recoveryFirstFailureAt = null
        this._recoveryGaveUp = false

        // Store provider metadata (e.g. rate limits) on workspace for tool access
        if (response.providerMetadata) {
          this.session.getWorkspace()._providerMeta = response.providerMetadata
        }

        // Record token usage
        const tokenUsageService = getTokenUsageService()
        // Hot path: skip logging in production to avoid synchronous I/O per turn
        if (process.env.NODE_ENV !== 'production') {
          console.log(`[TokenUsage] Recording: provider=${llmMetadata.provider}, model=${llmMetadata.model}, in=${llmMetadata.input_tokens}, out=${llmMetadata.output_tokens}`)
        }
        tokenUsageService.recordUsage(
          llmMetadata.provider,
          llmMetadata.model,
          llmMetadata.input_tokens,
          llmMetadata.output_tokens,
          {
            cache_read: llmMetadata.cache_read_tokens,
            cache_write: llmMetadata.cache_write_tokens,
            reasoning: llmMetadata.reasoning_tokens,
            // Unset when usage was estimated — no fake dollars in the ledger.
            cost_usd: llmMetadata.cost_usd
          }
        )

        // Fleet map burn rate — keyed by the .adf file path (mesh node id).
        // Must never break a turn.
        try {
          getFleetBurnService().record(
            this.session.getWorkspace().getFilePath(),
            llmMetadata.input_tokens,
            llmMetadata.output_tokens
          )
        } catch { /* non-fatal */ }

        // Update token estimate cheaply from API response (avoids re-tokenizing)
        chatTokens = llmMetadata.input_tokens + llmMetadata.output_tokens

        // Emit response metadata so the renderer can patch streaming entries immediately.
        // Full breakdown (cache read/write, reasoning) feeds the status-bar tooltip.
        this.emitEvent({
          type: 'response_metadata',
          payload: {
            model: llmMetadata.model,
            usage: loopTokensFromLlmMetadata(llmMetadata)
          },
          timestamp: Date.now()
        })

        const toolUseBlocks = response.content.filter(
          (block): block is ContentBlock & { type: 'tool_use' } =>
            block.type === 'tool_use'
        )

        if (toolUseBlocks.length > 0) {
          consecutiveTextOnly = 0
          this.setState('tool_use')

          this.session.addMessage(
            { role: 'assistant', content: response.content },
            { model: llmMetadata.model, tokens: loopTokensFromLlmMetadata(llmMetadata) }
          )

          const toolResults: ContentBlock[] = []
          let needsLoopReset = false
          let needsCompaction = false
          let compactionInstructions: string | undefined
          for (const toolBlock of toolUseBlocks) {
            if (this._interruptRestart || this._ownerStateTransitionRequested) break

            this.emitEvent({
              type: 'tool_call_start',
              payload: { name: toolBlock.name, input: toolBlock.input, id: toolBlock.id },
              timestamp: Date.now()
            })

            // Ask tool: intercept and block until human responds
            if (toolBlock.name === 'ask') {
              const askInput = toolBlock.input as { question: string }
              const answer = await this.requestAsk(askInput.question)
              // Restore state after human responds
              this.setState('tool_use')

              toolResults.push({
                type: 'tool_result',
                tool_use_id: toolBlock.id,
                content: `Human answered: ${answer}`,
                is_error: false
              })
              this.emitEvent({
                type: 'ask_response',
                payload: { question: askInput.question, answer },
                timestamp: Date.now()
              })
              this.emitEvent({
                type: 'tool_call_result',
                payload: { name: 'ask', id: toolBlock.id, result: { content: `Human answered: ${answer}`, isError: false } },
                timestamp: Date.now()
              })
              // `ask` is intercepted before the registry, so emit its tool.* pair here.
              this.emitSyntheticToolEvents('ask', toolBlock.id, toolBlock.input, {
                content: `Human answered: ${answer}`, isError: false
              })
              continue
            }

            // Guard: reject tool calls not in the enabled set
            if (!toolSnapshot.enabledNames.has(toolBlock.name)) {
              toolResults.push({
                type: 'tool_result',
                tool_use_id: toolBlock.id,
                content: `Tool "${toolBlock.name}" is not enabled. Check your agent configuration to enable it.`,
                is_error: true
              })
              this.emitEvent({
                type: 'tool_call_result',
                payload: { name: toolBlock.name, id: toolBlock.id, result: { content: `Tool "${toolBlock.name}" is not enabled.`, isError: true } },
                timestamp: Date.now()
              })
              this.emitSyntheticToolEvents(toolBlock.name!, toolBlock.id, toolBlock.input, {
                content: `Tool "${toolBlock.name}" is not enabled.`, isError: true
              })
              continue
            }

            // Strip _full, _authorized and _protection_override from LLM tool calls — only
            // allowed from code execution / HIL re-execution. _authorized is injected by
            // adf-call-handler for authorized lambdas; it bypasses file/meta/table protection
            // and must never be forgeable by the LLM.
            const llmInput = toolBlock.input as Record<string, unknown> | undefined
            if (llmInput && ('_full' in llmInput || '_authorized' in llmInput || '_protection_override' in llmInput)) {
              const { _full: _f, _authorized: _a, _protection_override: _p, ...rest } = llmInput
              toolBlock.input = rest
            }

            // Determine restriction status
            const toolDecl = toolSnapshot.declarations.get(toolBlock.name)
            const mcpRestricted = !toolDecl && this.mcpServerIsRestricted(toolBlock.name)
            let isRestricted = (toolDecl?.enabled && toolDecl?.restricted) || mcpRestricted

            // sys_lambda targeting an authorized file requires HIL approval —
            // authorized code has elevated privilege, so the user must approve it
            if (toolBlock.name === 'sys_lambda' && !isRestricted) {
              const lambdaInput = toolBlock.input as { source?: string } | undefined
              if (lambdaInput?.source) {
                const colonIdx = lambdaInput.source.lastIndexOf(':')
                const afterColon = colonIdx > 0 && colonIdx < lambdaInput.source.length - 1
                  ? lambdaInput.source.substring(colonIdx + 1) : null
                const filePath = afterColon && /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(afterColon)
                  ? lambdaInput.source.substring(0, colonIdx) : lambdaInput.source
                const workspace = this.session.getWorkspace()
                if (workspace.isFileAuthorized(filePath)) {
                  isRestricted = true
                }
              }
            }

            // Side loops have no approval channel (HIL routing is filePath/
            // singleton keyed, MVP), so a restricted call here would park an
            // approval nobody can answer and block the loop until the auto-deny
            // timeout. deriveLoopConfig already keeps every statically
            // restricted tool out of a loop's toolset; this closes the DYNAMIC
            // escape above (sys_lambda targeting an authorized file) and any
            // MCP server restricted after the derive. Fail closed, and say why.
            if (isRestricted && this.isSideLoop()) {
              const refusal =
                `"${toolBlock.name}" needs human approval, and a side loop has no channel to ask for one. ` +
                'Ask main to run this (loop_send), or do it a way that needs no approval.'
              toolResults.push({
                type: 'tool_result',
                tool_use_id: toolBlock.id,
                content: refusal,
                is_error: true
              })
              this.emitEvent({
                type: 'tool_call_result',
                payload: { name: toolBlock.name, id: toolBlock.id, result: { content: refusal, isError: true } },
                timestamp: Date.now()
              })
              this.emitSyntheticToolEvents(toolBlock.name!, toolBlock.id, toolBlock.input, {
                content: refusal, isError: true
              })
              continue
            }

            // _async check BEFORE HIL — async restricted tools create a pending_approval task
            // and return immediately instead of blocking the loop
            const toolInput = toolBlock.input as Record<string, unknown> | undefined
            const asyncAllowed = ASYNC_ALLOWED_TOOLS.has(toolBlock.name) || toolBlock.name.startsWith('mcp_')
            const isAsync = asyncAllowed && toolInput && (toolInput._async === true || toolInput._async === 'true')

            if (isAsync && isRestricted) {
              // Async + restricted: create HIL task but don't block — return task reference
              const taskId = `task_${nanoid(12)}`
              const { _async: _, ...cleanInput } = toolInput!
              const argsStr = JSON.stringify(cleanInput)
              const originLabel = this.config.id
                ? `hil:${this.config.name}:${this.config.id}`
                : `hil:${this.config.name}`
              const workspace = this.session.getWorkspace()
              // Async restricted approval — persist the reason so the task row
              // is self-describing like the blocking-HIL path above.
              workspace.insertTask(taskId, toolBlock.name, argsStr, originLabel, true, true, JSON.stringify({ reason: 'restricted' }))
              workspace.updateTaskStatus(taskId, 'pending_approval')
              const asyncTask = workspace.getTask(taskId)
              if (asyncTask) this.onTaskCreated?.(asyncTask)

              // When approved, execute the tool asynchronously
              const asyncMeta = this.buildApprovalMeta(toolBlock.name!)
              const asyncToolUseId = toolBlock.id
              this.pendingHilTasks.set(taskId, {
                resolve: (r) => {
                  if (r.approved) {
                    const finalInput = r.modifiedArgs ?? cleanInput
                    // tool.started was already emitted at enqueue (below) so the
                    // real execution suppresses its own — a tap sees exactly one
                    // started + one terminal event per tool_use id.
                    this.executeAsyncTool(taskId, toolBlock.name, finalInput, asyncToolUseId, { suppressStarted: true })
                  } else {
                    workspace.updateTaskStatus(taskId, 'denied', undefined, 'Rejected')
                    this.onTaskCompleted?.(taskId, toolBlock.name, 'denied', undefined, 'Rejected')
                    // Denied before execution: pair the enqueue-time tool.started
                    // with a terminal tool.failed so the in-flight call resolves.
                    this.emitSyntheticToolFailedForStarted(toolBlock.name!, asyncToolUseId, cleanInput, 'Rejected by authorizer')
                  }
                },
                name: toolBlock.name,
                input: cleanInput,
                meta: asyncMeta
              })

              this.emitEvent({
                type: 'tool_approval_request',
                payload: { requestId: taskId, taskId, name: toolBlock.name, input: cleanInput, ...asyncMeta },
                timestamp: Date.now()
              })
              // Registered directly (not via requestHilApproval) — emit the
              // request here so the eventual hil.resolved is not unpaired.
              this.emitRuntimeEvent('hil.requested', {
                request_id: taskId, task_id: taskId, tool: toolBlock.name,
                reason: asyncMeta.reason, input: stripInternalToolFlags(cleanInput)
              })

              const resultContent = JSON.stringify({ task_id: taskId, status: 'pending_approval', tool: toolBlock.name })
              toolResults.push({
                type: 'tool_result',
                tool_use_id: toolBlock.id,
                content: resultContent,
                is_error: false
              })
              // Studio UI depends on the immediate task-reference result — keep
              // the IPC event. But do NOT emit a synthetic umbilical
              // tool.completed here: the call is only QUEUED, not finished.
              // Emit tool.started only (in-flight); the real execution on
              // approval emits the authoritative tool.completed/tool.failed
              // carrying the same tool_use id (Blocker 5).
              this.emitEvent({
                type: 'tool_call_result',
                payload: { name: toolBlock.name, id: toolBlock.id, result: { content: resultContent, isError: false } },
                timestamp: Date.now()
              })
              this.emitToolStarted(toolBlock.name!, toolBlock.id, cleanInput)
              continue
            }

            // HIL: restricted + enabled tools require approval from the loop (blocking)
            let hilTaskId: string | undefined
            if (isRestricted) {
              const hilResult = await this.requestHilApproval(toolBlock.name, toolBlock.input)
              hilTaskId = hilResult.taskId
              if (!hilResult.approved) {
                // Feedback the authorizer typed on rejection is surfaced to the
                // agent in-band so it can course-correct rather than just retry.
                const fb = hilResult.feedback?.trim()
                const rejectionMsg = `Tool call "${toolBlock.name}" was rejected by authorizer.${fb ? ` Feedback: ${fb}` : ''}`
                // Update task to denied (resolveHilTask only resolves the Promise, not the DB)
                if (hilTaskId) {
                  const workspace = this.session.getWorkspace()
                  workspace.updateTaskStatus(hilTaskId, 'denied', undefined, fb || 'Rejected')
                  // Skip onTaskCompleted — agent already gets the rejection in-band as a tool error result.
                  // on_task_complete triggers are only needed for async tools where the agent doesn't have inline context.
                }
                // User/lambda rejected — push an error result and skip execution
                toolResults.push({
                  type: 'tool_result',
                  tool_use_id: toolBlock.id,
                  content: rejectionMsg,
                  is_error: true
                })
                this.emitEvent({
                  type: 'tool_call_result',
                  payload: { name: toolBlock.name, id: toolBlock.id, result: { content: rejectionMsg, isError: true } },
                  timestamp: Date.now()
                })
                // Denied before execution — the registry never saw this call.
                this.emitSyntheticToolEvents(toolBlock.name!, toolBlock.id, toolBlock.input, {
                  content: rejectionMsg, isError: true
                })
                // on_tool_call: notify observers of the denial
                if (this.matchesToolCallTrigger(toolBlock.name)) {
                  const argsStr = JSON.stringify(toolBlock.input ?? {})
                  const originLabel = this.config.id
                    ? `agent:${this.config.name}:${this.config.id}`
                    : `agent:${this.config.name}`
                  this.onToolCallIntercepted?.(toolBlock.name, argsStr, hilTaskId ?? '', originLabel)
                }
                continue
              }
              // Approved — apply modified args if provided, restore state and proceed
              if (hilResult.modifiedArgs) {
                toolBlock.input = hilResult.modifiedArgs
              }
              this.setState('tool_use')
            }

            // _async: true (non-restricted) — execute tool in background, return task reference
            if (isAsync) {
              const taskId = `task_${nanoid(12)}`
              const { _async: _, ...cleanInput } = toolInput!
              const argsStr = JSON.stringify(cleanInput)
              this.session.getWorkspace().insertTask(taskId, toolBlock.name, argsStr, 'agent')
              const asyncTask = this.session.getWorkspace().getTask(taskId)
              if (asyncTask) this.onTaskCreated?.(asyncTask)
              // Background execution runs the registry immediately, which emits
              // the authoritative tool.started + tool.completed/failed carrying
              // this tool_use id. No synthetic umbilical pair here — that would
              // double-emit against the registry's own events (Blocker 5).
              this.executeAsyncTool(taskId, toolBlock.name, cleanInput, toolBlock.id)
              const resultContent = JSON.stringify({ task_id: taskId, status: 'running', tool: toolBlock.name })
              toolResults.push({
                type: 'tool_result',
                tool_use_id: toolBlock.id,
                content: resultContent,
                is_error: false
              })
              // Studio UI still needs the immediate task-reference result.
              this.emitEvent({
                type: 'tool_call_result',
                payload: { name: toolBlock.name, id: toolBlock.id, result: { content: resultContent, isError: false } },
                timestamp: Date.now()
              })
              continue
            }

            // Snapshot file content before tool execution for diff computation
            let preWriteContent: string | null = null
            if (toolBlock.name === 'fs_write') {
              const toolInput = toolBlock.input as Record<string, unknown>
              const path = toolInput?.path as string | undefined
              if (path) {
                if (path === 'README.md' || path === 'document.md') {
                  preWriteContent = this.session.getWorkspace().readDocument()
                } else {
                  preWriteContent = this.session.getWorkspace().readFile(path)
                }
              }
            }

            let rawResult: ToolResult
            try {
              rawResult = await this.toolRegistry.executeTool(
                toolBlock.name!,
                toolBlock.input,
                this.session.getWorkspace(),
                { toolUseId: toolBlock.id }
              )
            } catch (toolError) {
              // Abort/quit mid-batch: persist the results already computed
              // before propagating. Discarding them leaves the assistant
              // tool_use batch in the loop with no results, and the restart
              // repair then reports tools that actually ran (with real side
              // effects) as "never completed".
              this.commitPartialToolResults(toolUseBlocks, toolResults)
              throw toolError
            }

            // Protection denial → HIL override approval. On approve the exact
            // (possibly human-modified) call re-executes with a one-time bypass;
            // on deny the denial is final for this turn (dedupe by tool+target).
            if (rawResult.isError && rawResult.protection) {
              const p = rawResult.protection
              const dedupeKey = `${toolBlock.name}|${p.kind}|${p.target}`
              if (this.deniedProtectionKeys.has(dedupeKey)) {
                rawResult = {
                  content: `${rawResult.content} An override was already rejected by the authorizer this turn — do not retry.`,
                  isError: true
                }
              } else {
                const hil = await this.requestHilApproval(
                  toolBlock.name!, toolBlock.input, this.buildApprovalMeta(toolBlock.name!, p)
                )
                const workspace = this.session.getWorkspace()
                if (hil.approved) {
                  this.setState('tool_use')
                  const finalInput = {
                    ...((hil.modifiedArgs ?? toolBlock.input) as Record<string, unknown>),
                    _protection_override: true
                  }
                  // Second execution of the same tool_use — a second tool.*
                  // pair is correct: two executions really did happen.
                  rawResult = await this.toolRegistry.executeTool(toolBlock.name!, finalInput, workspace, { toolUseId: toolBlock.id })
                  workspace.updateTaskStatus(
                    hil.taskId,
                    rawResult.isError ? 'failed' : 'completed',
                    rawResult.isError ? undefined : 'approved',
                    rawResult.isError ? rawResult.content : undefined
                  )
                } else {
                  const fb = hil.feedback?.trim()
                  this.deniedProtectionKeys.add(dedupeKey)
                  workspace.updateTaskStatus(hil.taskId, 'denied', undefined, fb || 'Rejected')
                  rawResult = {
                    content: `Tool call "${toolBlock.name}" was blocked (${p.kind}: "${p.target}" is ${p.level}) and the authorizer rejected the override.${fb ? ` Feedback: ${fb}` : ''} Do not retry.`,
                    isError: true
                  }
                  // on_tool_call: notify observers of the denial (parity with restricted path)
                  if (this.matchesToolCallTrigger(toolBlock.name!)) {
                    const argsStr = JSON.stringify(toolBlock.input ?? {})
                    const originLabel = this.config.id
                      ? `agent:${this.config.name}:${this.config.id}`
                      : `agent:${this.config.name}`
                    this.onToolCallIntercepted?.(toolBlock.name!, argsStr, hil.taskId, originLabel)
                  }
                  if (this.getState() !== 'stopped') this.setState('tool_use')
                }
              }
            }

            // Extract multimodal blocks — from fs_read binary content or MCP media responses
            const isMcpTool = toolBlock.name.startsWith('mcp_')
            const mediaBlocks: ContentBlock[] = []
            if (toolBlock.name === 'fs_read') {
              const img = this.maybeExtractImageBlock(rawResult)
              const aud = this.maybeExtractAudioBlock(rawResult)
              const vid = this.maybeExtractVideoBlock(rawResult)
              if (img) mediaBlocks.push(img)
              if (aud) mediaBlocks.push(aud)
              if (vid) mediaBlocks.push(vid)
            } else if (isMcpTool) {
              const img = this.maybeExtractMcpImageBlock(rawResult)
              const aud = this.maybeExtractMcpAudioBlock(rawResult)
              if (img) mediaBlocks.push(img)
              if (aud) mediaBlocks.push(aud)
            } else if (toolBlock.name === 'adf_shell') {
              mediaBlocks.push(...this.extractShellMediaBlocks(rawResult))
            }

            let filteredResult: ToolResult
            let savedFiles: Array<{ path: string; mimeType: string; type: 'image' | 'audio' | 'resource' }> | undefined
            if (toolBlock.name === 'fs_read') {
              filteredResult = this.filterFsReadResult(rawResult)
            } else if (isMcpTool) {
              savedFiles = this.persistMcpMedia(rawResult, toolBlock.name!)
              filteredResult = this.filterMcpMediaResult(rawResult, savedFiles)
            } else {
              filteredResult = rawResult
            }
            const result = this.enforceToolResultLimit(filteredResult, toolBlock.name)

            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolBlock.id,
              content: result.content,
              is_error: result.isError
            })

            // Attach multimodal blocks immediately after tool_result
            for (const block of mediaBlocks) {
              toolResults.push(block)
            }

            // Build adf-file:// URL for the renderer image preview
            let eventImageUrl: string | undefined
            if (isMcpTool) {
              const savedImage = savedFiles?.find(f => f.type === 'image')
              eventImageUrl = savedImage ? `adf-file://${savedImage.path}` : undefined
            } else if ((toolBlock.name === 'fs_read' || toolBlock.name === 'adf_shell') && mediaBlocks.some(b => b.type === 'image_url')) {
              // File already in adf_files — use its path (fs_read: row.path;
              // adf_shell: first entry of the media manifest)
              try {
                const row = JSON.parse(rawResult.content)
                const path = row.path ?? row.media?.[0]?.path
                if (path) eventImageUrl = `adf-file://${path}`
              } catch { /* ignore */ }
            }
            if (!eventImageUrl) {
              const imageBlock = mediaBlocks.find(b => b.type === 'image_url')
              if (imageBlock?.image_url) eventImageUrl = imageBlock.image_url.url
            }

            this.emitEvent({
              type: 'tool_call_result',
              payload: {
                name: toolBlock.name,
                id: toolBlock.id,
                result,
                ...(eventImageUrl ? { imageUrl: eventImageUrl } : {})
              },
              timestamp: Date.now()
            })

            // Update HIL task to completed/failed after executor runs the tool.
            // Skip onTaskCompleted — the result is already returned inline as a tool_result.
            // on_task_complete triggers are only needed for async tools where the agent
            // doesn't have inline context (see executeAsyncTool).
            if (hilTaskId) {
              const workspace = this.session.getWorkspace()
              if (result.isError) {
                workspace.updateTaskStatus(hilTaskId, 'failed', undefined, result.content)
              } else {
                workspace.updateTaskStatus(hilTaskId, 'completed', result.content)
              }
            }

            // on_tool_call: observational notification (fires AFTER execution, does not block)
            if (this.matchesToolCallTrigger(toolBlock.name)) {
              const argsStr = JSON.stringify(toolBlock.input ?? {})
              const originLabel = this.config.id
                ? `agent:${this.config.name}:${this.config.id}`
                : `agent:${this.config.name}`
              this.onToolCallIntercepted?.(toolBlock.name, argsStr, hilTaskId ?? '', originLabel)
            }

            // Notify the renderer when the document changes. Every OTHER file —
            // mind.md and soul.md included — is covered by the `file_updated`
            // event raised from the workspace's file-change choke point (see
            // assemble-agent.ts), which catches writes this tool loop never sees:
            // shell redirection, sys_code, lambdas, and `_async: true` fs_write.
            //
            // Note that mind.md is a session-start snapshot: a mid-session write
            // lands on disk (and in the tab) but does not refresh the injected
            // copy, which is re-read on the next session reset (compaction or
            // loop_clear).
            if (toolBlock.name === 'fs_write') {
              const toolInput = toolBlock.input as Record<string, unknown>
              const path = toolInput?.path as string | undefined
              if (path && (path === 'README.md' || path === 'document.md')) {
                const docContent = this.session.getWorkspace().readDocument()
                this.emitEvent({
                  type: 'document_updated',
                  payload: { content: docContent, previousContent: preWriteContent ?? undefined },
                  timestamp: Date.now()
                })
              }
            }

            // Notify when a new ADF file is created so tracked dirs refresh
            if (toolBlock.name === 'sys_create_adf' && !result.isError) {
              const pathMatch = result.content.match(/\nPath: (.+)/)
              const newFilePath = pathMatch?.[1]?.trim()
              this.emitEvent({
                type: 'adf_file_created',
                payload: newFilePath ? { filePath: newFilePath } : {},
                timestamp: Date.now()
              })
            }

            // Flag loop-clearing tools for session reset after tool results are committed
            if (toolBlock.name === 'loop_compact' || toolBlock.name === 'loop_clear') {
              needsLoopReset = true
              if (toolBlock.name === 'loop_compact') {
                needsCompaction = true
                const compactInput = toolBlock.input as Record<string, unknown>
                compactionInstructions = (compactInput?.instructions as string) || undefined
              }
            }

            // If the agent was stopped, interrupted, or halted mid-tool-execution, stop processing further tools
            if (this.state === 'stopped' || this._interruptRestart || this._ownerStateTransitionRequested) break

            // Check for mid-batch user interrupt — inject between tool results
            const midBatchInterrupt = this.consumeInterrupt()
            if (midBatchInterrupt) {
              toolResults.push(midBatchInterrupt)
            }

            // If the tool signals end of turn, stop after submitting results
            if (result.endTurn) {
              // Extract target state from sys_set_state — directly, or driven
              // through adf_shell (`state idle`), whose result carries the same
              // top-level target_state key.
              if (toolBlock.name === 'sys_set_state' || toolBlock.name === 'adf_shell') {
                try {
                  const parsed = JSON.parse(result.content)
                  if (parsed.target_state) {
                    targetState = parsed.target_state
                    this._lastTargetState = targetState
                  }
                } catch { /* ignore parse errors */ }
              }
              continueLoop = false
              break
            }
          }

          // On interrupt restart or an owner state transition: add placeholder results for unexecuted
          // tool_use blocks (API requires every tool_use to have a corresponding tool_result)
          if (this._interruptRestart || this._ownerStateTransitionRequested) {
            const executedIds = new Set(
              toolResults
                .filter((r): r is ContentBlock & { type: 'tool_result' } => r.type === 'tool_result')
                .map(r => (r as any).tool_use_id)
            )
            for (const tb of toolUseBlocks) {
              if (!executedIds.has(tb.id)) {
                toolResults.push({
                  type: 'tool_result',
                  tool_use_id: tb.id,
                  content: '[Tool execution cancelled — user interrupted the turn]',
                  is_error: true
                })
              }
            }
          }

          // Inject pending user interrupt into tool results (skip if restarting — interrupt survives to finally block)
          if (!this._interruptRestart) {
            const interruptBlock = this.consumeInterrupt()
            if (interruptBlock) {
              toolResults.push(interruptBlock)
            }
          }

          this.session.addMessage({
            role: 'user',
            content: toolResults
          })

          // addMessage writes every entry through to the loop synchronously,
          // so the completed model step (assistant tool_use batch + results)
          // is already durable. This retry-flush re-attempts any insert that
          // failed (DB busy) — and it must run BEFORE the loop_clear /
          // forceCompact paths below wipe the table, so a retried row is
          // wiped with its peers instead of resurrected afterwards.
          this.session.flushToLoop()

          // Drop base64 media from older messages to prevent heap growth.
          // Media blocks are ephemeral (not persisted to DB) and only needed
          // for the most recent LLM context window.
          this.session.stripOldMedia()

          // After tool results are committed, reset in-memory session if loop was cleared
          if (needsLoopReset) {
            const workspace = this.session.getWorkspace()

            if (needsCompaction && this.provider) {
              // Voluntary loop_compact: summarize, preserving the current turn
              // (last assistant tool_use batch + the user tool_results just
              // appended) so the agent continues from the same point. The agent
              // decided to compact AT this moment — those messages happened
              // after the decision, so they belong on the post-summary timeline.
              // forceCompact resets context dedup / warning tier internally.
              chatTokens = await this.forceCompact('voluntary loop_compact', {
                instructions: compactionInstructions,
                preserveCount: 2,
                preservedFirstMeta: {
                  model: llmMetadata.model,
                  tokens: loopTokensFromLlmMetadata(llmMetadata)
                }
              })
            } else {
              // Plain loop_clear (no compaction)
              this.session.flushToLoop()
              // Reset in the same tick as the clear commit — an await between
              // them lets a concurrent dispatch land in an inconsistent window.
              await workspace.clearLoop({ onCommitted: () => this.session.reset() })
              const chatData = workspace.readChat()
              if (chatData?.llmMessages) {
                this.session.restoreMessages(chatData.llmMessages)
              }
              // Parse proper display entries instead of sending empty uiLog
              const loopEntries = workspace.getLoop()
              const displayEntries = parseLoopToDisplay(loopEntries)
              this.emitEvent({
                type: 'chat_updated',
                payload: { uiLog: displayEntries },
                timestamp: Date.now()
              })

              // Recalculate token count from cleared session so the context
              // warning doesn't re-fire with the stale pre-clear value, and
              // reset context dedup so context blocks are re-injected.
              chatTokens = tokenCounter.estimateMessagesTokens(this.session.getMessages())
              this.resetContextState()
            }
            console.log('[AgentExecutor] Session reset after loop clear/compact')
          }

          // If a tool signalled end-of-turn, emit turn_complete and stop
          if (!continueLoop) {
            // Flush any remaining buffered deltas before signaling completion
            this.flushDeltaBuffer()
            this.emitEvent({
              type: 'turn_complete',
              payload: { content: response.content, ...(targetState ? { targetState } : {}) },
              timestamp: Date.now()
            })
          }
        } else {
          // No tool use — raw text response
          this.session.addMessage(
            { role: 'assistant', content: response.content },
            { model: llmMetadata.model, tokens: loopTokensFromLlmMetadata(llmMetadata) }
          )
          // Write-through already persisted this step; retry-flush any failed
          // insert (see the tool-results flush above for rationale).
          this.session.flushToLoop()

          // Flush any remaining buffered deltas and close out the assistant turn
          // in the UI before continuing or stopping. Every assistant message must
          // be surfaced as a complete turn, regardless of mode.
          this.flushDeltaBuffer()
          this.emitEvent({
            type: 'turn_complete',
            payload: { content: response.content },
            timestamp: Date.now()
          })

          // Interactive mode: text without tool calls ends the turn
          // Autonomous mode: text is logged, turn continues
          if (!this.config.autonomous) {
            continueLoop = false
          } else if (!this._interruptRestart && !this._ownerStateTransitionRequested) {
            consecutiveTextOnly++

            // Circuit breaker: an autonomous agent answering continuation
            // nudges with prose instead of acting is stuck in a narration
            // loop. Force idle — triggers and timers will wake it again.
            if (consecutiveTextOnly >= 4) {
              try {
                this.session.getWorkspace().insertLog(
                  'warn', 'executor', 'narration_loop_break', null,
                  `Forced idle after ${consecutiveTextOnly} consecutive responses without tool calls`
                )
              } catch { /* non-fatal */ }
              continueLoop = false
            } else {
              // Inject pending interrupt or add a continuation message so the
              // conversation doesn't end with an assistant message (some
              // providers don't support assistant message prefill). After two
              // text-only responses, escalate the nudge.
              const interruptBlock = this.consumeInterrupt()
              // A user interrupt is fresh input — answering it in prose is
              // legitimate, so it resets the narration counter.
              if (interruptBlock) consecutiveTextOnly = 0
              const nudge = consecutiveTextOnly >= 2
                ? `[You have responded ${consecutiveTextOnly} times in a row without calling any tools. Do not reply with another status update. Either call a tool now to make progress, or yield by calling sys_set_state with state "idle".]`
                : '[Continue working autonomously according to your instructions. Control your state with sys_set_state().]'
              this.session.addMessage({
                role: 'user',
                content: interruptBlock ? [interruptBlock] : [{ type: 'text', text: nudge }]
              })
            }
          }
          // If autonomous, continue the loop - agent will think again
        }
      }
    } catch (error) {
      // Intentional abort from user interrupt — not a real error
      if (this._interruptRestart) {
        // Fall through to finally block which handles the restart
      } else if (this._ownerStateTransitionRequested) {
        // Intentional abort from an owner-requested idle/hibernate transition.
        // The finally block records the boundary and applies the target state.
      } else if (this.state === 'stopped') {
        // Intentional shutdown via abort() — not a real error
      } else {
      const errorMsg = error instanceof Error ? error.message
        : (typeof error === 'string' ? error
        : (error && typeof error === 'object' && typeof (error as any).message === 'string'
          ? (error as any).message
          : String(error)))
      const errorDetails = buildErrorDetails(error, errorMsg)

      // Transient provider/network failures (429, 5xx, timeouts) are operational,
      // not structural. Don't destroy the agent — stay idle so triggers/timers retry.
      // `error` state is reserved for genuine executor breakage.
      if (isAuthError(error, errorMsg)) {
        // Credentials became invalid mid-session (revoked key, depleted balance, etc.).
        // Surface a clear, actionable message and reset the validation flag so the
        // next turn will re-preflight (and re-surface the issue if it's still broken).
        const providerLabel = this.provider?.name || this.provider?.providerId || 'provider'
        this.providerValidated = false
        this.setState('error')
        try { this.session.getWorkspace().insertLog('error', 'executor', 'provider_credentials_invalid', null, errorMsg.slice(0, 300)) } catch { /* non-fatal */ }
        this.emitEvent({
          type: 'error',
          payload: {
            error: `Your ${providerLabel} provider isn't authenticated. ` +
              `Check the API key, account balance, and plan limits in Settings → Providers, then try again.\n\nDetails: ${errorMsg}`,
            details: errorDetails
          },
          timestamp: Date.now()
        })
      } else if (isTransientProviderError(error, errorMsg)) {
        this.setState('idle')
        const scheduled = this.scheduleProviderRecovery(dispatch, error, errorMsg)
        // Severity tracks the outcome: warn while auto-recovery is handling it,
        // error once it gives up (or is disabled) and a human needs to look.
        try { this.session.getWorkspace().insertLog(scheduled ? 'warn' : 'error', 'executor', 'provider_error', null, errorMsg.slice(0, 300)) } catch { /* non-fatal */ }
        if (scheduled) {
          this.emitEvent({
            type: 'error',
            payload: {
              error: `Provider unavailable: ${errorMsg}\n\n` +
                `Auto-recovery: retry ${scheduled.attempt}/${scheduled.maxAttempts} in ~${Math.round(scheduled.delayMs / 1000)}s.`,
              details: errorDetails
            },
            timestamp: Date.now()
          })
        } else {
          const reason = (this.config.recovery?.auto_retry ?? RECOVERY_DEFAULTS.auto_retry)
            ? `Auto-recovery gave up after ${this._recoveryAttempts} retries.`
            : 'Auto-recovery is disabled (recovery.auto_retry).'
          // Leave a durable notice in history so the NEXT turn — whenever a
          // trigger wakes the agent — knows the trigger above went unprocessed
          // and how long ago the outage started. Without this the gap is
          // invisible to the model (same rationale as the crash-checkpoint
          // notice). Written once per outage: during a dead-provider stretch
          // every recurring trigger lands here, and one notice per failing
          // turn would flood the loop.
          if (!this._recoveryGaveUp) {
            this._recoveryGaveUp = true
            const outageStart = this._recoveryFirstFailureAt
            const giveUpNotice =
              `[Provider unavailable ("${sanitizeForNotice(errorMsg)}"). ${reason} ` +
              (outageStart !== null
                ? `Outage began ~${formatElapsed(Date.now() - outageStart)} ago (now ${formatTimestamp(Date.now())}). `
                : `Current time: ${formatTimestamp(Date.now())}. `) +
              `The trigger above was NOT processed — re-attempt unfinished work.]`
            this.session.addMessage({
              role: 'user',
              content: [{ type: 'text', text: giveUpNotice }]
            })
            this.session.flushToLoop()
            this.emitEvent({
              type: 'context_injected',
              payload: { category: 'System', content: giveUpNotice },
              timestamp: Date.now()
            })
          }
          this.emitEvent({
            type: 'error',
            payload: {
              error: `Provider unavailable: ${errorMsg}\n\n${reason} Agent remains idle; triggers will retry on the next event.`,
              details: errorDetails
            },
            timestamp: Date.now()
          })
        }
      } else if (this._inImageRecovery) {
        // A second failure inside image-recovery retry. Don't brick the agent —
        // images are user content, not executor state, and the model should
        // get a chance to reason about the failure (e.g. switch to shell tools).
        this.setState('idle')
        try { this.session.getWorkspace().insertLog('warn', 'executor', 'image_recovery_followup_error', null, errorMsg.slice(0, 300)) } catch { /* non-fatal */ }
        this.session.addMessage({
          role: 'user',
          content: [{
            type: 'text',
            text: `[System notice: Recovery retry also failed: "${errorMsg.slice(0, 500)}". Stopping automatic image-error recovery. Reason about what happened and try a different approach (e.g. inspect the file with shell or code tools rather than viewing it directly), or wait for new input.]`
          }]
        })
        this.emitEvent({
          type: 'error',
          payload: { error: `Image recovery follow-up error: ${errorMsg}`, details: errorDetails },
          timestamp: Date.now()
        })
      } else {
      // Check if this is a provider mismatch error (tool blocks incompatible)
      const isToolMismatch =
        errorMsg.includes('tool_use_id') ||
        errorMsg.includes('tool_result') ||
        errorMsg.includes("role 'tool' must be a response") ||
        errorMsg.includes('corresponding `tool_use` block') ||
        errorMsg.includes('Tool result is missing') ||
        errorMsg.includes('No tool call found')

      const hasImageBlocks = this.tryStripImageBlocksAndRetry(errorMsg)

      // Image errors are recoverable user-content issues; don't move into the
      // terminal `error` state. Tool-mismatch and unknown errors still brick.
      if (!hasImageBlocks || isToolMismatch) {
        this.setState('error')
      }
      try { this.session.getWorkspace().insertLog(hasImageBlocks && !isToolMismatch ? 'warn' : 'error', 'executor', 'turn_error', null, errorMsg.slice(0, 300)) } catch { /* non-fatal */ }

      if (isToolMismatch) {
        // Auto-fix: strip tool blocks from history and retry once
        console.log('[AgentExecutor] Tool compatibility error detected - cleaning history and retrying')

        this.emitEvent({
          type: 'error',
          payload: {
            error: `⚠️ Provider compatibility issue detected. Automatically cleaning chat history and retrying...`
          },
          timestamp: Date.now()
        })

        try {
          // Retry any failed write-through inserts so the loop holds the
          // complete dirty history, then strip tool blocks from BOTH the loop table and the
          // session. Rewriting the loop is what makes the fix survive a
          // restart — the old writeChat() call here was a deprecated no-op,
          // so the rejected tool blocks came back on reload and re-broke the
          // provider. Context entries, model/token metadata, and timestamps
          // are preserved; entries left empty by the strip are dropped.
          this.session.flushToLoop()
          const workspace = this.session.getWorkspace()
          const cleanedEntries = workspace.getLoop()
            .map(e => ({
              ...e,
              content_json: e.content_json.filter(b => b.type !== 'tool_use' && b.type !== 'tool_result')
            }))
            .filter(e => e.content_json.length > 0)
          await workspace.replaceLoop(cleanedEntries.map(e => ({
            role: e.role,
            content: e.content_json,
            model: e.model,
            tokens: e.tokens,
            created_at: e.created_at,
            seq: e.seq,
            ord: e.ord
          })))
          this.session.restoreMessages(cleanedEntries.map(e => ({ role: e.role, content: e.content_json, created_at: e.created_at, seq: e.seq })))

          // Retry the turn with cleaned history. Must leave the 'error' state
          // first: executeTurn returns immediately for non-chat dispatches
          // while state === 'error', which silently no-ops the retry for
          // background triggers (inbox/cron/file_change) and bricks the agent.
          this.setState('idle')
          await this.executeTurn(dispatch, { skipTriggerMessage: true })
          return
        } catch (retryError) {
          // If retry also fails, show both errors
          this.emitEvent({
            type: 'error',
            payload: {
              error: `Failed to auto-fix provider compatibility issue.\n\nOriginal error: ${errorMsg}\n\nRetry error: ${String(retryError)}\n\n💡 Try using the 'loop_compact' tool to reset the conversation history.`,
              details: errorDetails
            },
            timestamp: Date.now()
          })
        }
      } else if (hasImageBlocks) {
        // Auto-fix: the provider choked on image content (corrupted file,
        // model lacks vision, image too large). Strip the offending images,
        // surface the error to the model as a user message, and retry so the
        // agent can reason about it and pick an alternative (e.g. shell tools).
        console.log('[AgentExecutor] Provider error with image blocks present - stripping images, surfacing to model, retrying')
        this._inImageRecovery = true

        this.emitEvent({
          type: 'error',
          payload: {
            error: `⚠️ Provider error with image content. Removing images and surfacing the error to the agent so it can reason about it...`
          },
          timestamp: Date.now()
        })

        try {
          // In-memory only: media blocks are never persisted to the loop
          // (addMessage strips them), so there is nothing to rewrite on disk.
          const cleanedMessages = this.stripImageBlocks(this.session.getMessages())
          this.session.restoreMessages(cleanedMessages)

          this.session.addMessage({
            role: 'user',
            content: [{
              type: 'text',
              text: `[System notice: The previous assistant turn failed because the provider could not process image content: "${errorMsg.slice(0, 500)}". Image attachments have been removed from the conversation. The image may be corrupted, unsupported by this model, or oversized. Reason about what happened and try alternative approaches — for example, inspect the file with shell or code tools instead of viewing it directly.]`
            }]
          })

          // History already contains the original trigger message — don't re-add it.
          await this.executeTurn(dispatch, { skipTriggerMessage: true })
          return
        } finally {
          this._inImageRecovery = false
        }
      } else {
        this.emitEvent({
          type: 'error',
          payload: { error: errorMsg, details: errorDetails },
          timestamp: Date.now()
        })
      }
      } // end else (structural error path)
      } // end else (!_interruptRestart)
    } finally {
      // Interrupt restart: discard leftover deltas, persist session, restart with user's message
      if (this._interruptRestart) {
        // Discard any remaining buffered deltas from the aborted turn
        if (this.bufferTimer) { clearTimeout(this.bufferTimer); this.bufferTimer = null }
        this.deltaQueue.length = 0

        this.session.flushToLoop()
        this.interruptTurnCheckpoint(checkpointId, 'user_interrupt_restart')
        this._isMessageTriggered = false
        this.abortController = null
        this._interruptRestart = false
        this._ownerStateTransitionRequested = false
        this._lastTargetState = null
        const interrupt = this.pendingInterrupt
        this.pendingInterrupt = null
        this.emitEvent({
          type: 'turn_complete',
          payload: { content: [], interrupted: true },
          timestamp: Date.now()
        })
        if (interrupt) {
          // Only chat the sending UI echoed skips the restart's trigger
          // event — a fleet-bar interrupt still needs it to reach the panel.
          this._skipNextTriggerEvent = isEchoedChat(interrupt)
          this.setState('idle')
          this.scheduleReentrantTurn(interrupt)
        }
        return  // Skip normal cleanup
      }

      // An owner-requested lifecycle transition already resolved pending
      // interactions and aborted the call. Discard leftover deltas, record the
      // boundary in the loop, and let the normal target-state path below apply
      // idle or hibernate.
      const ownerTransitioned = this._ownerStateTransitionRequested
      if (this._ownerStateTransitionRequested) {
        this._ownerStateTransitionRequested = false
        if (this.bufferTimer) { clearTimeout(this.bufferTimer); this.bufferTimer = null }
        this.deltaQueue.length = 0
        this.session.addMessage({ role: 'user', content: `[System] Turn ended by owner; state set to ${this._lastTargetState ?? 'idle'}.` })
        this.emitEvent({
          type: 'turn_complete',
          payload: { content: [], interrupted: true },
          timestamp: Date.now()
        })
      }

      // Flush any remaining buffered deltas
      this.flushDeltaBuffer()

      // Retry-flush any loop entries whose write-through insert failed
      this.session.flushToLoop()
      // A turn that landed in error state failed structurally — record it as
      // 'failed', not 'completed', so the checkpoint doesn't misrepresent a
      // broken turn as a clean one. Turns cut off mid-flight by an owner state
      // transition or executor stop are 'interrupted' — they never completed.
      if (this.state === 'error') {
        this.failTurnCheckpoint(checkpointId, 'turn_error')
      } else if (ownerTransitioned) {
        this.interruptTurnCheckpoint(checkpointId, 'owner_state_transition')
      } else if (this.state === 'stopped') {
        this.interruptTurnCheckpoint(checkpointId, 'executor_stopped')
      } else if (this._recoveryTimer !== null) {
        // A provider-recovery retry is armed: the turn's work is NOT done.
        // Leave the checkpoint in_progress so a crash/reload during the
        // backoff window surfaces the load-time interrupted-turn notice
        // instead of silently dropping the pending retry. On the normal path
        // the retry turn overwrites this checkpoint when it begins.
      } else {
        this.completeTurnCheckpoint(checkpointId)
      }

      this._isMessageTriggered = false
      this.abortController = null

      // Only transition to idle and process pending triggers if the agent
      // wasn't explicitly stopped. abort() sets state to 'stopped' and
      // clears pendingTriggers; we must not override that here.
      if (this.state !== 'stopped') {
        if (this.state === 'error') {
          // Stay in error state so the UI reflects the failure. Discard
          // queued triggers (API is likely broken), but keep pending
          // interrupts so a user message can pull the agent out of error.
          this.pendingTriggers = []
        } else if (this._lastTargetState === 'off') {
          // Deferred sys_set_state('off') from a lambda or HIL approval that
          // arrived mid-turn. Honor it now: hard shutdown, drop everything.
          this.cancelScheduledRecovery('state_transition')
          this.pendingTriggers = []
          this.pendingInterrupt = null
          this._lastTargetState = null
          this.setState('stopped')
          this.emitEvent({
            type: 'state_changed',
            payload: { state: 'off' },
            timestamp: Date.now()
          })
        } else if (this._lastTargetState && this._lastTargetState !== 'off') {
          // Apply the requested display state. TriggerEvaluator owns which
          // future events can wake it. Ordinary idle remains fully armed, so
          // work already queued behind the interrupted turn drains normally;
          // hibernate deliberately drops that backlog and waits for an
          // eligible new wake.
          const targetState = this._lastTargetState
          this.state = 'idle'
          if (targetState !== 'idle') {
            // Hibernate/suspend deliberately drops the queued backlog —
            // including any armed provider-recovery retry, which would
            // otherwise wake the agent out of the requested state.
            this.cancelScheduledRecovery('hibernate')
            const dropped = this.pendingTriggers.length
            this.pendingTriggers = []
            if (dropped > 0) this.emitRuntimeEvent('trigger.dropped', { reason: 'hibernate', dropped })
          }
          this.pendingInterrupt = null
          this.emitEvent({
            type: 'state_changed',
            payload: { state: targetState },
            timestamp: Date.now()
          })
          this._lastTargetState = null
          if (targetState === 'idle') this.drainPendingTriggers()
        } else if (this.pendingInterrupt) {
          // Unconsumed interrupt gets priority — process it as the next turn
          const interrupt = this.pendingInterrupt
          this.pendingInterrupt = null
          this.setState('idle')
          this.scheduleReentrantTurn(interrupt)
        } else {
          this.setState('idle')

          // Process the next queued trigger.
          this.drainPendingTriggers()
        }
      }
    }
  }

  /**
   * Reconcile a durable in-progress checkpoint left behind by a process crash,
   * app reload, or hard shutdown. This first slice is recovery-only: it never
   * replays the trigger because duplicate timers/lambdas/tool effects are unsafe
   * without idempotency metadata. It records the boundary in the loop so the next
   * provider context is structurally valid and explainable.
   */
  /** This executor's checkpoint meta key — see TURN_CHECKPOINT_META_KEY. */
  private turnCheckpointKey(): string {
    const loop = this.session.getWorkspace().getLoopName()
    return !loop || loop === MAIN_LOOP
      ? TURN_CHECKPOINT_META_KEY
      : `${TURN_CHECKPOINT_META_KEY}:${loop}`
  }

  recoverStaleTurnCheckpoint(): TurnCheckpointRecord | null {
    const workspace = this.session.getWorkspace()
    const raw = workspace.getMeta(this.turnCheckpointKey())
    if (!raw) return null

    const now = Date.now()

    let checkpoint: TurnCheckpointRecord
    try {
      checkpoint = JSON.parse(raw) as TurnCheckpointRecord
    } catch {
      workspace.setMeta(this.turnCheckpointKey(), JSON.stringify({
        id: nanoid(10),
        status: 'interrupted',
        started_at: now,
        updated_at: now,
        event_type: 'unknown',
        scope: 'unknown',
        replay: 'not_replayed',
        reason: 'malformed_checkpoint',
      } satisfies TurnCheckpointRecord), 'readonly')
      workspace.insertLog(
        'warn',
        'executor',
        'turn_checkpoint_malformed',
        null,
        'Prior turn checkpoint was unreadable; marked interrupted and not replayed',
      )
      // Same reasoning as the stale branch below: a recovery the model cannot
      // see is a recovery it cannot reason about. The corrupt record carries no
      // timing, so this notice states only what is actually known.
      this.session.addMessage({
        role: 'user',
        content: [{
          type: 'text',
          text: '[System notice: the runtime could not read the previous turn checkpoint (the record was corrupt), ' +
            `so how long ago that turn ran is unknown. The current time is ${formatTimestamp(now)}. ` +
            'The runtime marked it interrupted and did NOT replay the trigger automatically, to avoid duplicate timer/tool/side effects. ' +
            'Treat any work from before this point as unverified, and decide whether to redo it.]',
        }],
      })
      this.session.flushToLoop()
      this.emitRuntimeEvent('loop.recovered', { reason: 'malformed_checkpoint' })
      return null
    }

    if (checkpoint.status !== 'in_progress') return null

    const recovered: TurnCheckpointRecord = {
      ...checkpoint,
      status: 'interrupted',
      updated_at: now,
      completed_at: now,
      replay: 'not_replayed',
      reason: 'stale_checkpoint_recovered_on_load',
    }

    // The interrupted turn began at started_at and last made progress at
    // updated_at; the gap between then and now is how long the agent was gone.
    const offlineMs = typeof checkpoint.started_at === 'number' ? now - checkpoint.started_at : NaN
    const elapsed = formatElapsed(offlineMs)

    workspace.setMeta(this.turnCheckpointKey(), JSON.stringify(recovered), 'readonly')
    workspace.insertLog(
      'warn',
      'executor',
      'turn_checkpoint_recovered',
      checkpoint.event_type,
      `Recovered interrupted ${checkpoint.scope} turn ${checkpoint.id} after ${elapsed}; trigger was not replayed`,
      recovered,
    )
    // Inject as real conversation history (not an audit-only context entry, which
    // restoreMessages strips) so the recovered agent actually sees that its prior
    // turn was cut off and can decide how to proceed.
    this.session.addMessage({
      role: 'user',
      content: [{
        type: 'text',
        text: `[System notice: the previous ${checkpoint.scope} turn ${checkpoint.id} (${checkpoint.event_type}) was interrupted before clean completion — likely a crash, reload, or hard shutdown. ` +
          `That turn started at ${formatTimestamp(checkpoint.started_at)} and last made progress at ${formatTimestamp(checkpoint.updated_at)}; it is now ${formatTimestamp(now)}, so about ${elapsed} has passed since it began. ` +
          'The runtime marked it interrupted and did NOT replay the trigger automatically, to avoid duplicate timer/tool/side effects. ' +
          'If that turn had unfinished work, decide whether to resume it — and account for the elapsed time before acting on anything time-sensitive.]',
      }],
    })
    this.session.flushToLoop()
    if (this.state !== 'stopped') this.setState('idle')
    this.emitRuntimeEvent('loop.recovered', { reason: 'stale_checkpoint' })
    return recovered
  }

  /**
   * Reconcile `adf_tasks` rows a crash left in a non-terminal state.
   *
   * Runs at load, BEFORE any turn of this session, so every row it sees
   * predates this process — nothing legitimately in flight can be swept.
   *
   * Status choice (the enum has no `interrupted`):
   *  - `running` -> `failed`, because the tool may have produced side effects
   *    before the process died; the error text says the outcome is unknown.
   *  - executor-managed `pending_approval` -> `cancelled`, NOT `denied`: no
   *    human ever decided, and `denied` would falsely record a rejection.
   * Non-executor-managed `pending_approval` rows are left alone — those are
   * owned by lambdas/UI and can still be resolved after a restart.
   *
   * Each swept HIL row also emits `hil.resolved`, closing the one-resolve-per-
   * `hil.requested` guarantee for approvals whose request was emitted by the
   * dead process.
   */
  reconcileOrphanedTasks(): { running: number; awaitingApproval: number } {
    const workspace = this.session.getWorkspace()
    const counts = { running: 0, awaitingApproval: 0 }
    try {
      for (const task of workspace.getTasksByStatus('running')) {
        workspace.updateTaskStatus(
          task.id, 'failed', undefined,
          'Orphaned: the runtime restarted before this task reported. Outcome unknown.',
        )
        workspace.insertLog(
          'warn', 'executor', 'task_orphaned', task.tool,
          `Task ${task.id} (${task.tool}) was still running at load; marked failed with unknown outcome`,
        )
        counts.running++
      }
      for (const task of workspace.getTasksByStatus('pending_approval')) {
        // Only the executor's own blocking approvals are orphaned by a restart.
        if (!task.executor_managed) continue
        workspace.updateTaskStatus(
          task.id, 'cancelled', undefined,
          'Orphaned: the runtime restarted before this approval was resolved.',
        )
        workspace.insertLog(
          'warn', 'executor', 'task_orphaned', task.tool,
          `Approval task ${task.id} (${task.tool}) was awaiting a decision at load; cancelled — nobody was left waiting on it`,
        )
        this.emitRuntimeEvent('hil.resolved', {
          request_id: task.id,
          task_id: task.id,
          approved: false,
          orphaned: true,
        })
        counts.awaitingApproval++
      }
      if (counts.running + counts.awaitingApproval > 0) {
        this.emitRuntimeEvent('loop.recovered', {
          reason: 'orphaned_tasks',
          running: counts.running,
          awaiting_approval: counts.awaitingApproval,
        })
      }
    } catch { /* reconciliation is diagnostic — never block agent load */ }
    return counts
  }

  private beginTurnCheckpoint(
    id: string,
    dispatch: AdfEventDispatch | AdfBatchDispatch,
    eventType: string | undefined,
    scope: string | undefined,
  ): void {
    const now = Date.now()
    const checkpoint: TurnCheckpointRecord = {
      id,
      status: 'in_progress',
      started_at: now,
      updated_at: now,
      event_type: eventType ?? 'unknown',
      scope: scope ?? ('scope' in dispatch ? dispatch.scope : 'unknown'),
      replay: 'not_attempted',
    }
    this.session.getWorkspace().setMeta(this.turnCheckpointKey(), JSON.stringify(checkpoint), 'readonly')
  }

  private completeTurnCheckpoint(id: string): void {
    this.finishTurnCheckpoint(id, 'completed')
  }

  private interruptTurnCheckpoint(id: string, reason: string): void {
    this.finishTurnCheckpoint(id, 'interrupted', reason)
  }

  private failTurnCheckpoint(id: string, reason: string): void {
    this.finishTurnCheckpoint(id, 'failed', reason)
  }

  private finishTurnCheckpoint(id: string, status: 'completed' | 'interrupted' | 'failed', reason?: string): void {
    const workspace = this.session.getWorkspace()
    const raw = workspace.getMeta(this.turnCheckpointKey())
    if (!raw) return

    let existing: Partial<TurnCheckpointRecord> = {}
    try { existing = JSON.parse(raw) as Partial<TurnCheckpointRecord> } catch { /* overwrite malformed checkpoint */ }
    if (existing.id && existing.id !== id) return

    const now = Date.now()
    const checkpoint: TurnCheckpointRecord = {
      id,
      status,
      started_at: typeof existing.started_at === 'number' ? existing.started_at : now,
      updated_at: now,
      completed_at: now,
      event_type: typeof existing.event_type === 'string' ? existing.event_type : 'unknown',
      scope: typeof existing.scope === 'string' ? existing.scope : 'unknown',
      replay: status === 'completed' ? 'not_attempted' : 'not_replayed',
      ...(reason ? { reason } : {}),
    }
    workspace.setMeta(this.turnCheckpointKey(), JSON.stringify(checkpoint), 'readonly')
  }

  /**
   * Queue a dispatch for later execution, deduplicating trigger types where
   * only the latest matters (inbox, file_change). Shared by the busy-state
   * queue path.
   */
  private queuePendingTrigger(dispatch: AdfEventDispatch | AdfBatchDispatch, eventType: string | undefined): void {
    if (eventType === 'inbox' || eventType === 'file_change') {
      // Owner messages are content-bearing (inlined verbatim into the turn) —
      // they must never be evicted by the latest-wins inbox dedup, and their
      // own arrival must not evict a queued agent-traffic trigger either.
      const incomingOwner = eventType === 'inbox' && isOwnerInboxDispatch(dispatch)
      if (!incomingOwner) {
        const before = this.pendingTriggers.length
        this.pendingTriggers = this.pendingTriggers.filter(t => {
          const tt = 'event' in t ? t.event.type : t.events[0]?.type
          if (tt !== eventType) return true
          if (eventType === 'inbox' && isOwnerInboxDispatch(t)) return true
          return false
        })
        const evicted = before - this.pendingTriggers.length
        for (let i = 0; i < evicted; i++) {
          this.emitRuntimeEvent('trigger.dropped', { trigger_type: eventType, reason: 'superseded' })
        }
      }
    }
    this.pendingTriggers.push(dispatch)
  }

  /**
   * Run the next queued trigger — uses process.nextTick so it runs before
   * macrotasks like IPC handlers (e.g. AGENT_INVOKE from user input).
   * Skips stale inbox notifications where all messages were already handled.
   */
  private drainPendingTriggers(): void {
    while (this.pendingTriggers.length > 0) {
      const next = this.pendingTriggers.shift()!
      const nextType = 'event' in next ? next.event.type : next.events[0]?.type
      if (nextType === 'inbox' && next.scope === 'agent') {
        const unread = this.session.getWorkspace().getUnreadCount()
        if (unread === 0) continue // Stale — inbox already handled
      }
      this.scheduleReentrantTurn(next)
      break
    }
  }

  /**
   * Arm a backoff retry of `dispatch` after a transient provider error.
   * Returns the schedule, or null when auto-recovery is disabled or attempts
   * are exhausted. The timer outlives the turn's finally block (the executor
   * sits in 'idle'); the fire-time guard skips the retry if other work claimed
   * the executor in the meantime — that work resumes from the same history.
   */
  private scheduleProviderRecovery(
    dispatch: AdfEventDispatch | AdfBatchDispatch,
    error: unknown,
    errorMsg: string,
  ): { attempt: number; maxAttempts: number; delayMs: number } | null {
    const recovery = this.config.recovery
    if ((recovery?.auto_retry ?? RECOVERY_DEFAULTS.auto_retry) === false) return null
    const maxAttempts = recovery?.max_attempts ?? RECOVERY_DEFAULTS.max_attempts
    if (this._recoveryAttempts >= maxAttempts) return null

    if (this._recoveryAttempts === 0) this._recoveryFirstFailureAt = Date.now()
    const attempt = ++this._recoveryAttempts
    const base = recovery?.base_delay_ms ?? RECOVERY_DEFAULTS.base_delay_ms
    const cap = recovery?.max_delay_ms ?? RECOVERY_DEFAULTS.max_delay_ms
    const backoff = Math.min(base * 2 ** (attempt - 1), cap)
    const jittered = Math.round(backoff * (0.8 + Math.random() * 0.4))
    // Honor a provider-requested Retry-After when it asks for MORE than our
    // backoff, still bounded by the configured ceiling. Retrying before the
    // provider asked burns the attempt, so a request above the ceiling is
    // logged — the user's ceiling deliberately wins, but visibly.
    const requested = retryAfterMs(error)
    const delayMs = requested !== null ? Math.min(Math.max(jittered, requested), cap) : jittered
    if (requested !== null && requested > cap) {
      try {
        this.session.getWorkspace().insertLog('warn', 'executor', 'retry_after_capped', null,
          `Provider asked to wait ${Math.round(requested / 1000)}s; capped to recovery.max_delay_ms (${Math.round(cap / 1000)}s)`)
      } catch { /* non-fatal */ }
    }

    this.cancelScheduledRecovery(null)
    const fire = (): void => {
      this._recoveryTimer = null
      // Config may have changed while the timer was armed — honor a live
      // disable instead of running one stray retry.
      if (this.config.recovery?.auto_retry === false) {
        this.emitRuntimeEvent('provider.retry_cancelled', { reason: 'disabled' })
        return
      }
      // Not idle: an auth error landed during the backoff (error state) or the
      // executor is being torn down. The retry is dead — say so.
      if (this.state !== 'idle') {
        this.emitRuntimeEvent('provider.retry_cancelled', { reason: 'agent_state' })
        return
      }
      // A turn slot is held. A fresh agent-scope turn would have cancelled this
      // timer at entry, so the holder is a system-scope (lambda) turn that never
      // touches recovery state — re-probe shortly instead of silently dropping
      // the retry (lambda-heavy agents can hold the slot for long stretches).
      if (this.activeTurnCount > 0) {
        this._recoveryTimer = setTimeout(fire, 5_000)
        return
      }
      try { this.session.getWorkspace().insertLog('info', 'executor', 'provider_retry', null, `Auto-recovery retry ${attempt}/${maxAttempts}`) } catch { /* non-fatal */ }
      this.emitRuntimeEvent('provider.retry_started', { attempt, max_attempts: maxAttempts })
      const elapsed = this._recoveryFirstFailureAt !== null
        ? formatElapsed(Date.now() - this._recoveryFirstFailureAt)
        : 'an unknown time'
      const recoveryNotice =
        `[Provider error ("${sanitizeForNotice(errorMsg)}") — auto-recovery retry ${attempt}/${maxAttempts}, ` +
        `~${elapsed} since the first failure (now ${formatTimestamp(Date.now())}). ` +
        `Account for the delay if anything is time-sensitive.]`
      this.scheduleReentrantTurn(dispatch, { skipTriggerMessage: true, isRecoveryRetry: true, recoveryNotice })
    }
    this._recoveryTimer = setTimeout(fire, delayMs)

    try {
      this.session.getWorkspace().insertLog('warn', 'executor', 'provider_retry_scheduled', null,
        `Auto-recovery retry ${attempt}/${maxAttempts} in ${Math.round(delayMs / 1000)}s`)
    } catch { /* non-fatal */ }
    this.emitRuntimeEvent('provider.retry_scheduled', {
      attempt, max_attempts: maxAttempts, delay_ms: delayMs, next_retry_at: Date.now() + delayMs,
    })
    return { attempt, maxAttempts, delayMs }
  }

  /** Disarm a pending provider-recovery retry. Pass a reason to surface the
   *  cancellation on the umbilical; null cancels silently (internal re-arm). */
  private cancelScheduledRecovery(reason: string | null): void {
    if (!this._recoveryTimer) return
    clearTimeout(this._recoveryTimer)
    this._recoveryTimer = null
    if (reason) this.emitRuntimeEvent('provider.retry_cancelled', { reason })
  }

  /** Check if an MCP tool's server is restricted */
  private mcpServerIsRestricted(toolName: string): boolean {
    if (!toolName.startsWith('mcp_')) return false
    const parts = toolName.split('_')
    if (parts.length < 3) return false
    const serverName = parts[1]
    const server = this.config.mcp?.servers?.find(s => s.name === serverName)
    return server?.restricted === true
  }

  private async createMessageWithLlmCall(
    source: LlmCallEventData['source'],
    options: CreateMessageOptions,
    extra?: Pick<LlmCallEventData, 'turn_id'>,
  ) {
    if (!this.provider) throw new Error('Provider unavailable')
    try {
      const result = await callLlmWithMetadata(this.provider, options)
      const eventData = toLlmCallEventData(result.metadata, source, extra)
      this.onLlmCall?.(eventData)
      this.emitLlmCallEvent(eventData)
      return result
    } catch (error) {
      const metadata = getAttachedLlmCallMetadata(error)
      if (metadata) {
        const eventData = toLlmCallEventData(metadata, source, extra)
        this.onLlmCall?.(eventData)
        this.emitLlmCallEvent(eventData)
      }
      throw error
    }
  }

  private emitLlmCallEvent(data: LlmCallEventData): void {
    const { source, ...rest } = data
    emitUmbilicalEvent({
      event_type: data.stop_reason === 'error' ? 'llm.failed' : 'llm.completed',
      agentId: this.config.id,
      payload: { ...rest, call_source: source },
    })
  }

  /**
   * Check if a tool name matches any on_tool_call trigger filter.
   * Used for observational notification after tool execution.
   */
  private matchesToolCallTrigger(toolName: string): boolean {
    const cfg = this.config.triggers?.on_tool_call
    if (!cfg?.enabled) return false
    const targets = cfg.targets ?? []
    for (const target of targets) {
      if (!target.filter?.tools) continue
      for (const pattern of target.filter.tools) {
        const regex = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$')
        if (regex.test(toolName)) return true
      }
    }
    return false
  }

  /**
   * Execute a tool asynchronously (fire-and-forget).
   * Creates a task, runs the tool in background, updates task status on completion.
   */
  private executeAsyncTool(
    taskId: string,
    toolName: string,
    input: unknown,
    toolUseId?: string,
    options?: { suppressStarted?: boolean }
  ): void {
    const workspace = this.session.getWorkspace()
    const doExecute = async () => {
      try {
        workspace.updateTaskStatus(taskId, 'running')
        // Thread explicit provenance: this runs OUTSIDE any withSource scope
        // (resumed from an approval callback), so the registry stamps agentId +
        // the tool_use id from here. suppressStarted avoids a second tool.started
        // when the enqueue site already emitted one (async-restricted path).
        const rawResult = await this.toolRegistry.executeTool(toolName, input, workspace, {
          agentId: this.config.id,
          ...(toolUseId ? { toolUseId } : {}),
          ...(options?.suppressStarted ? { suppressStarted: true } : {}),
        })

        // Protection denial → convert the task to a pending override approval
        // instead of failing. Non-blocking: the loop already returned the task
        // reference; approval re-runs the call with a one-time bypass.
        if (rawResult.isError && rawResult.protection) {
          const meta = this.buildApprovalMeta(toolName, rawResult.protection)
          workspace.updateTaskStatus(taskId, 'pending_approval')
          workspace.setTaskExecutorManaged(taskId, true)
          this.pendingHilTasks.set(taskId, {
            resolve: (r) => {
              if (r.approved) {
                const finalInput = {
                  ...((r.modifiedArgs ?? input) as Record<string, unknown>),
                  _protection_override: true
                }
                // Re-run with a one-time bypass. Keep the tool_use id so the
                // authoritative tool.completed still correlates; the re-run
                // emits its own tool.started (the denied attempt already paired).
                this.executeAsyncTool(taskId, toolName, finalInput, toolUseId)
              } else {
                const fb = r.feedback?.trim() || 'Rejected'
                workspace.updateTaskStatus(taskId, 'denied', undefined, fb)
                this.onTaskCompleted?.(taskId, toolName, 'denied', undefined, fb)
              }
            },
            name: toolName,
            input,
            meta
          })
          this.emitEvent({
            type: 'tool_approval_request',
            payload: { requestId: taskId, taskId, name: toolName, input, ...meta },
            timestamp: Date.now()
          })
          this.emitRuntimeEvent('hil.requested', {
            request_id: taskId, task_id: taskId, tool: toolName,
            reason: meta.reason, input: stripInternalToolFlags(input)
          })
          return
        }

        const result = this.enforceToolResultLimit(rawResult, toolName)
        if (result.isError) {
          workspace.updateTaskStatus(taskId, 'failed', undefined, result.content)
          this.onTaskCompleted?.(taskId, toolName, 'failed', undefined, result.content)
        } else {
          workspace.updateTaskStatus(taskId, 'completed', result.content)
          this.onTaskCompleted?.(taskId, toolName, 'completed', result.content)
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        workspace.updateTaskStatus(taskId, 'failed', undefined, errorMsg)
        this.onTaskCompleted?.(taskId, toolName, 'failed', undefined, errorMsg)
      }
    }
    // Fire and forget — don't await
    doExecute().catch(err => {
      console.error(`[AgentExecutor] Async tool ${toolName} (task ${taskId}) unhandled error:`, err)
    })
  }

  abort(): void {
    // Kill the in-flight LLM request and all pending state FIRST —
    // data flushing is best-effort and must never prevent shutdown.
    this._interruptRestart = false
    this._ownerStateTransitionRequested = false
    this.abortController?.abort()
    this.cancelScheduledRecovery('abort')
    this._recoveryAttempts = 0
    this.pendingTriggers = []
    this.pendingInterrupt = null
    // Queued system dispatches never survive teardown — waking them here would
    // resurrect work the agent was stopped in the middle of.
    this.systemDispatchQueue.clear()
    for (const pending of this.pendingHilTasks.values()) {
      pending.resolve({ approved: false })
    }
    this.pendingHilTasks.clear()
    this.deniedProtectionKeys.clear()
    for (const pending of this.pendingAsks.values()) {
      pending.resolve('')
    }
    this.pendingAsks.clear()
    if (this.pendingSuspend) {
      this.pendingSuspend.resolve(false)
      this.pendingSuspend = null
    }
    this.provider = null
    this.setState('stopped')

    // Best-effort: flush any buffered data to disk. Errors (e.g. corrupt DB) are swallowed.
    try { this.flushDeltaBuffer() } catch { /* ignore */ }
    try { this.session.flushToLoop() } catch { /* ignore */ }
  }

  private scheduleDeltaFlush(): void {
    if (this.bufferTimer) return
    this.bufferTimer = setTimeout(() => {
      this.bufferTimer = null
      this.flushDeltaBuffer()
    }, this.BATCH_WINDOW_MS)
  }

  private flushDeltaBuffer(): void {
    if (this.bufferTimer) {
      clearTimeout(this.bufferTimer)
      this.bufferTimer = null
    }
    if (this.deltaQueue.length === 0) return

    const queue = this.deltaQueue.splice(0)
    // turn.delta is opt-in (umbilical.stream_deltas) — streaming every batch to
    // taps is high-volume and off by default.
    const streamDeltas = this.config.umbilical?.stream_deltas === true
    const flushBatch = (kind: 'text' | 'thinking', deltas: string[]): void => {
      this.emitEvent({
        type: kind === 'text' ? 'text_delta_batch' : 'thinking_delta_batch',
        payload: { deltas },
        timestamp: Date.now()
      })
      if (streamDeltas) {
        this.emitRuntimeEvent('turn.delta', { kind, text: deltas.join('') })
      }
    }

    // Coalesce adjacent same-type entries into one batch event each, preserving
    // arrival order. Mixed [thinking, text, thinking] stays as 3 ordered batches.
    let runType = queue[0].type
    let runDeltas: string[] = [queue[0].text]
    for (let i = 1; i < queue.length; i++) {
      const entry = queue[i]
      if (entry.type === runType) {
        runDeltas.push(entry.text)
      } else {
        flushBatch(runType, runDeltas)
        runType = entry.type
        runDeltas = [entry.text]
      }
    }
    flushBatch(runType, runDeltas)
  }

  /**
   * Context-aware filtering for fs_read results in the LLM loop.
   * Binary files: strip content (metadata only). Text files: apply truncation guards.
   * Must run before enforceToolResultLimit to avoid truncating base64 or oversized text into garbage.
   */
  /** Check if a multimodal modality is enabled, with backward compat for vision flag. */
  private isMultimodalEnabled(modality: 'image' | 'audio' | 'video'): boolean {
    if (modality === 'image') {
      return this.config.model?.multimodal?.image ?? this.config.model?.vision ?? false
    }
    return this.config.model?.multimodal?.[modality] ?? false
  }

  /**
   * If image modality is enabled and the fs_read result contains a supported image,
   * return an image_url ContentBlock with the base64 data URI.
   */
  /**
   * Media files read via the shell (`cat` on image/audio/video mimes) arrive
   * as a media[] manifest in the adf_shell result — the shell never puts
   * base64 in stdout. Rebuild fs_read-style rows from the VFS and reuse the
   * per-modality extractors (same enablement checks and size gates).
   */
  private extractShellMediaBlocks(result: ToolResult): ContentBlock[] {
    if (result.isError) return []
    let media: Array<{ path?: string; mime_type?: string }>
    try {
      const parsed = JSON.parse(result.content)
      if (!Array.isArray(parsed.media)) return []
      media = parsed.media
    } catch {
      return []
    }

    const blocks: ContentBlock[] = []
    const workspace = this.session.getWorkspace()
    const seen = new Set<string>()
    for (const entry of media.slice(0, 8)) {
      if (!entry?.path || !entry?.mime_type) continue
      if (seen.has(entry.path)) continue // `cat a.png a.png` → one block
      seen.add(entry.path)
      let buffer: Buffer | null
      try {
        buffer = workspace.readFileBuffer(entry.path)
      } catch {
        continue
      }
      if (!buffer) continue
      const pseudo: ToolResult = {
        content: JSON.stringify({
          path: entry.path,
          mime_type: entry.mime_type,
          size: buffer.length,
          content: buffer.toString('base64'),
        }),
        isError: false,
      }
      const img = this.maybeExtractImageBlock(pseudo)
      const aud = this.maybeExtractAudioBlock(pseudo)
      const vid = this.maybeExtractVideoBlock(pseudo)
      if (img) blocks.push(img)
      if (aud) blocks.push(aud)
      if (vid) blocks.push(vid)
    }
    return blocks
  }

  private maybeExtractImageBlock(result: ToolResult): ContentBlock | null {
    if (!this.isMultimodalEnabled('image')) return null
    if (result.isError) return null

    let row: Record<string, unknown>
    try {
      row = JSON.parse(result.content)
    } catch {
      return null
    }

    if (!isVisionMime(row.mime_type as string | undefined)) return null

    const maxSize = this.config.limits?.max_image_size_bytes ?? 5_242_880
    if ((row.size as number) > maxSize) return null

    const content = row.content as string | null
    if (!content) return null

    return {
      type: 'image_url',
      image_url: { url: `data:${row.mime_type};base64,${content}` }
    }
  }

  /**
   * If audio modality is enabled and the fs_read result contains a supported audio file,
   * return an input_audio ContentBlock.
   */
  private maybeExtractAudioBlock(result: ToolResult): ContentBlock | null {
    if (!this.isMultimodalEnabled('audio')) return null
    if (result.isError) return null

    let row: Record<string, unknown>
    try { row = JSON.parse(result.content) } catch { return null }

    if (!isAudioInputMime(row.mime_type as string | undefined)) return null

    const maxSize = this.config.limits?.max_audio_size_bytes ?? 10_485_760
    if ((row.size as number) > maxSize) return null

    const content = row.content as string | null
    if (!content) return null

    return {
      type: 'input_audio',
      input_audio: { data: content, format: mimeToAudioFormat(row.mime_type as string) }
    }
  }

  /**
   * If video modality is enabled and the fs_read result contains a supported video file,
   * return a video_url ContentBlock with the base64 data URI.
   */
  private maybeExtractVideoBlock(result: ToolResult): ContentBlock | null {
    if (!this.isMultimodalEnabled('video')) return null
    if (result.isError) return null

    let row: Record<string, unknown>
    try { row = JSON.parse(result.content) } catch { return null }

    if (!isVideoInputMime(row.mime_type as string | undefined)) return null

    const maxSize = this.config.limits?.max_video_size_bytes ?? 20_971_520
    if ((row.size as number) > maxSize) return null

    const content = row.content as string | null
    if (!content) return null

    return {
      type: 'video_url',
      video_url: { url: `data:${row.mime_type};base64,${content}` }
    }
  }

  /**
   * If image modality is enabled and the MCP tool result contains images,
   * return the first image as an image_url ContentBlock.
   */
  private maybeExtractMcpImageBlock(result: ToolResult): ContentBlock | null {
    if (!this.isMultimodalEnabled('image')) return null
    if (result.isError) return null

    let parsed: { images?: Array<{ data: string; mimeType: string }> }
    try {
      parsed = JSON.parse(result.content)
    } catch {
      return null
    }
    if (!parsed.images?.length) return null

    const img = parsed.images[0]
    const maxSize = this.config.limits?.max_image_size_bytes ?? 5_242_880
    if (img.data.length * 0.75 > maxSize) return null

    return {
      type: 'image_url',
      image_url: { url: `data:${img.mimeType};base64,${img.data}` }
    }
  }

  /**
   * If audio modality is enabled and the MCP tool result contains audio,
   * return the first audio item as an input_audio ContentBlock.
   */
  private maybeExtractMcpAudioBlock(result: ToolResult): ContentBlock | null {
    if (!this.isMultimodalEnabled('audio')) return null
    if (result.isError) return null

    let parsed: { audio?: Array<{ data: string; mimeType: string }> }
    try { parsed = JSON.parse(result.content) } catch { return null }
    if (!parsed.audio?.length) return null

    const aud = parsed.audio[0]
    const maxSize = this.config.limits?.max_audio_size_bytes ?? 10_485_760
    if (aud.data.length * 0.75 > maxSize) return null

    return {
      type: 'input_audio',
      input_audio: { data: aud.data, format: mimeToAudioFormat(aud.mimeType) }
    }
  }

  /**
   * Save media items from an MCP tool result to adf_files.
   * Returns metadata for each successfully saved file.
   */
  private persistMcpMedia(
    rawResult: ToolResult,
    toolName: string
  ): Array<{ path: string; mimeType: string; type: 'image' | 'audio' | 'resource' }> {
    if (rawResult.isError) return []

    let parsed: {
      images?: Array<{ data: string; mimeType: string }>
      audio?: Array<{ data: string; mimeType: string }>
      resources?: Array<{ data: string; mimeType: string; uri: string }>
    }
    try { parsed = JSON.parse(rawResult.content) } catch { return [] }

    const hasMedia = parsed.images?.length || parsed.audio?.length || parsed.resources?.length
    if (!hasMedia) return []

    const workspace = this.session.getWorkspace()
    const maxBytes = this.config.limits?.max_file_write_bytes ?? 5_000_000

    // Look up the McpTool for server/tool names
    const registeredTool = this.toolRegistry.get(toolName)
    const server = registeredTool instanceof McpTool ? registeredTool.getServerName() : 'unknown'
    const mcpToolName = registeredTool instanceof McpTool ? registeredTool.getMcpToolName() : toolName
    const ts = Date.now()
    const saved: Array<{ path: string; mimeType: string; type: 'image' | 'audio' | 'resource' }> = []

    const persist = (items: Array<{ data: string; mimeType: string }>, type: 'image' | 'audio' | 'resource') => {
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        const buf = Buffer.from(item.data, 'base64')
        if (buf.length > maxBytes) continue
        const ext = mimeToExt(item.mimeType)
        const path = `mcp/${server}/${mcpToolName}_${ts}_${i + 1}${ext}`
        try {
          workspace.writeFileBuffer(path, buf, item.mimeType)
          saved.push({ path, mimeType: item.mimeType, type })
        } catch (e) {
          console.warn(`[MCP] Failed to persist media to ${path}:`, e)
        }
      }
    }

    if (parsed.images?.length) persist(parsed.images, 'image')
    if (parsed.audio?.length) persist(parsed.audio, 'audio')
    if (parsed.resources?.length) persist(
      parsed.resources.map(r => ({ data: r.data, mimeType: r.mimeType })),
      'resource'
    )

    return saved
  }

  /**
   * Strip base64 media data from MCP tool results for the LLM loop.
   * When files were saved to adf_files, includes VFS paths as durable references.
   * The agent can revisit saved files later via fs_read.
   */
  private filterMcpMediaResult(
    result: ToolResult,
    savedFiles?: Array<{ path: string; mimeType: string; type: 'image' | 'audio' | 'resource' }>
  ): ToolResult {
    if (result.isError) return result

    let parsed: {
      text?: string
      images?: Array<{ data: string; mimeType: string }>
      audio?: Array<{ data: string; mimeType: string }>
      resources?: Array<{ data: string; mimeType: string; uri: string }>
    }
    try {
      parsed = JSON.parse(result.content)
    } catch {
      return result  // not structured JSON — return as-is
    }

    const hasMedia = parsed.images?.length || parsed.audio?.length || parsed.resources?.length
    if (!hasMedia) return result

    // Index saved files by type for lookup
    const savedByType = { image: [] as typeof savedFiles, audio: [] as typeof savedFiles, resource: [] as typeof savedFiles }
    for (const f of savedFiles ?? []) {
      savedByType[f.type]!.push(f)
    }

    const parts: string[] = []
    if (parsed.text) parts.push(parsed.text)

    const refs: string[] = []

    const addRefs = (
      items: Array<{ data: string; mimeType: string }> | undefined,
      type: 'image' | 'audio' | 'resource',
      saved: typeof savedFiles
    ) => {
      if (!items?.length) return
      let savedIdx = 0
      for (let i = 0; i < items.length; i++) {
        if (savedIdx < saved!.length && saved![savedIdx]!.mimeType === items[i].mimeType) {
          refs.push(`[${type}: ${saved![savedIdx]!.path} (${items[i].mimeType})]`)
          savedIdx++
        } else {
          // Oversized or failed to save — show size hint
          const rawBytes = items[i].data.length * 0.75
          refs.push(`[${type}: ${items[i].mimeType}, ${formatSize(rawBytes)} — exceeds file size limit, call in code to access]`)
        }
      }
    }

    addRefs(parsed.images, 'image', savedByType.image)
    addRefs(parsed.audio, 'audio', savedByType.audio)
    addRefs(parsed.resources, 'resource', savedByType.resource)

    if (refs.length) parts.push(refs.join('\n'))

    return { content: parts.join('\n'), isError: false }
  }

  private filterFsReadResult(result: ToolResult): ToolResult {
    if (result.isError) return result

    let row: Record<string, unknown>
    try {
      row = JSON.parse(result.content)
    } catch {
      return result
    }

    // Binary files: tombstone content for LLM — raw data accessible via code execution.
    // Use [type: path (mime)] format for media so loop-parser can extract adf-file:// URLs.
    if (!isTextMime(row.mime_type as string | undefined)) {
      const mime = row.mime_type as string | undefined
      const path = row.path as string
      const size = formatSize(row.size as number ?? 0)
      if (isVisionMime(mime)) {
        row.content = `[image: ${path} (${mime})]`
      } else if (isAudioInputMime(mime)) {
        row.content = `[audio: ${path} (${mime})]`
      } else if (isVideoInputMime(mime)) {
        row.content = `[video: ${path} (${mime})]`
      } else {
        row.content = `[binary content: ${path} (${mime ?? 'unknown type'}, ${size})]`
      }
      return { ...result, content: JSON.stringify(row) }
    }

    // Text files: apply truncation guards
    const content = row.content as string
    if (!content) return result

    const lines = content.split('\n')
    const totalLines = lines.length
    const totalChars = content.length
    const approxTokens = Math.ceil(totalChars / 4)
    const maxTokens = this.config.limits?.max_file_read_tokens ?? 30000

    // Token limit guard
    if (approxTokens > maxTokens) {
      const maxChars = maxTokens * 4
      const truncated = content.slice(0, maxChars)
      const truncatedLines = truncated.split('\n')
      truncatedLines.pop() // don't include partial last line
      row.content = truncatedLines.join('\n')
        + `\n\n--- TRUNCATED at ~${maxTokens.toLocaleString()} tokens (file has ${totalLines} lines, ${formatSize(totalChars)}) ---\n`
        + `Use start_line/end_line to read specific sections.`
      return { ...result, content: JSON.stringify(row) }
    }

    // 300-line preview guard
    const LINE_THRESHOLD = 300
    if (totalLines > LINE_THRESHOLD) {
      const sizeStr = formatSize(Buffer.byteLength(content, 'utf8'))
      const preview = lines.slice(0, 50).join('\n')
      row.content = `[Large file: ${totalLines} lines, ${sizeStr}, ~${approxTokens.toLocaleString()} tokens]\n`
        + `Use start_line/end_line to read sections (e.g. start_line=1, end_line=100).\n\n`
        + `--- Preview (first 50 lines) ---\n`
        + preview
      return { ...result, content: JSON.stringify(row) }
    }

    return result
  }

  /**
   * Truncate oversized tool results to protect the context window.
   * Uses a fast char-based pre-filter; only tokenizes when borderline.
   */
  private enforceToolResultLimit(result: ToolResult, toolName: string): ToolResult {
    const maxTokens = this.config.limits?.max_tool_result_tokens ?? 16000
    const content = result.content

    // Fast path: if chars/4 is well under limit, definitely safe
    if (content.length <= maxTokens * 3) return result

    // Borderline or over — count actual tokens
    const tokenCounter = getTokenCounterService()
    const tokenCount = tokenCounter.countTokens(content, this.provider.name, this.provider.modelId)
    if (tokenCount <= maxTokens) return result

    // Over limit - replace with summary plus configurable head/tail preview.
    const previewChars = this.config.limits?.max_tool_result_preview_chars ?? 5000
    const preview = this.buildToolResultPreview(content, previewChars)
    return {
      ...result,
      content:
        `[TRUNCATED] Tool "${toolName}" returned ~${tokenCount.toLocaleString()} tokens ` +
        `(limit: ${maxTokens.toLocaleString()}). The full result was discarded to protect the context window. ` +
        `Request a smaller or more specific result.\n\n` +
        preview
    }
  }

  private buildToolResultPreview(content: string, maxChars: number): string {
    const limit = Math.max(1, Math.floor(maxChars))
    if (content.length <= limit) {
      return `Preview (${content.length.toLocaleString()} chars):\n${content}`
    }

    const headChars = Math.ceil(limit / 2)
    const tailChars = Math.floor(limit / 2)
    const head = content.slice(0, headChars)
    const tail = tailChars > 0 ? content.slice(-tailChars) : ''
    const omittedChars = Math.max(0, content.length - head.length - tail.length)

    return (
      `Preview (first ${head.length.toLocaleString()} chars, last ${tail.length.toLocaleString()} chars; ` +
      `${omittedChars.toLocaleString()} chars omitted):\n` +
      `${head}\n\n[... ${omittedChars.toLocaleString()} chars omitted ...]` +
      `${tail ? `\n\n${tail}` : ''}`
    )
  }

  /** Apply the same char limit used by enforceToolResultLimit to arbitrary trigger/context strings. */
  private applyContentLimit(text: string): string {
    const maxTokens = this.config.limits?.max_tool_result_tokens ?? 16000
    const charLimit = maxTokens * 3
    if (text.length <= charLimit) return text
    return text.slice(0, charLimit) + `\n\n[TRUNCATED — content exceeded ${maxTokens.toLocaleString()} token limit]`
  }

  private setState(state: AgentState): void {
    this.state = state
    this.emitEvent({
      type: 'state_changed',
      payload: { state },
      timestamp: Date.now()
    })
  }

  /**
   * Estimate the token size of the request that is ABOUT to be sent, so the
   * loop can compact *before* the call instead of letting the provider reject
   * an over-window request.
   *
   * `baselineTokens` is the accurate context size as of the last completed
   * 'turn' call (real API input+output, which includes the system prompt and
   * tool schemas) or the last compaction — it is reset small by forceCompact,
   * so it never lingers stale after a wipe. The char-based estimate of the
   * current message set covers messages only, so the cached fixed overhead
   * (system prompt + tool schemas) is added to it; the message part grows as
   * tool_results are appended mid-turn — the exact gap that let pure
   * tool-call agents blow past the window between the top-of-loop check and
   * the send.
   *
   * Taking the max keeps whichever is safer: the accurate baseline right after
   * a call/compaction, and the growing overhead-inclusive estimate once
   * tool_results pile up.
   * Using the persisted `adf_loop.tokens` directly was rejected here: a
   * voluntary loop_compact re-appends the preserved assistant turn with its
   * pre-compaction (huge) input count, which would falsely re-trigger
   * compaction and destroy the turn it just preserved.
   */
  private estimatePreflightTokens(baselineTokens: number, dynamicInstructions?: string): number {
    const tc = getTokenCounterService()
    const estimated = tc.estimateMessagesTokens(this.session.getMessages())
    // Fixed overhead (system prompt + tool schemas + this turn's dynamic
    // instructions) goes on the char-estimate side ONLY: baselineTokens is the
    // last call's real API input+output, which already includes that overhead —
    // adding it there would double-count. This makes big-toolset agents compact
    // earlier than the old message-only estimate did, which is correct: the
    // real request was always that big (~40k larger for MCP-heavy agents).
    const overhead = this.getFixedOverheadTokens() +
      (dynamicInstructions ? this.countPromptTokens(dynamicInstructions) : 0)
    return Math.max(baselineTokens, estimated + overhead)
  }

  /**
   * Cached fixed per-request overhead: system prompt + tool schema tokens.
   * Warms both caches when cold (the first preflight of a session runs before
   * buildToolSnapshot); on warm caches this is two field reads. Measurement
   * must never break the turn, so builder failures degrade to 0.
   */
  private getFixedOverheadTokens(): number {
    try {
      this.buildSystemPrompt()
      this.buildToolSnapshot()
    } catch { /* overhead measurement must never break the loop */ }
    return (this.systemPromptCache?.promptTokens ?? 0) +
      (this.toolSnapshotCache?.toolsTotalTokens ?? 0)
  }

  /**
   * A tool batch died mid-flight (abort, quit, tool crash). Persist the
   * results already computed; tool calls without a result get an explicit
   * interrupted marker. No-op when nothing completed — the restore-time
   * orphan repair already handles a fully result-less batch.
   */
  private commitPartialToolResults(
    toolUseBlocks: Array<ContentBlock & { type: 'tool_use' }>,
    toolResults: ContentBlock[]
  ): void {
    if (toolResults.length === 0) return
    for (const tb of toolUseBlocks) {
      const hasResult = toolResults.some(r => r.type === 'tool_result' && r.tool_use_id === tb.id)
      if (!hasResult) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: tb.id,
          content: '[System: This tool call was interrupted before completion.]',
          is_error: true
        })
      }
    }
    this.session.addMessage({ role: 'user', content: toolResults })
  }

  /**
   * Summarize the conversation, clear the loop, and restore from the summary.
   * Shared by the top-of-loop auto-compact, the pre-flight context guard, and
   * the voluntary loop_compact tool. Always clears even when summary generation
   * fails — a placeholder summary still beats sending an over-window request
   * that the provider rejects with context_length_exceeded. Resets context
   * dedup / warning tier internally.
   *
   * @param reason Human-readable trigger, for logs.
   * @param opts.instructions       Optional agent-supplied compaction guidance.
   * @param opts.preserveCount      Trailing messages to keep out of the summary
   *   and re-append after it (voluntary path preserves the current turn = 2).
   * @param opts.preservedFirstMeta Model/token metadata for the first preserved
   *   message (the assistant batch) so its loop entry keeps its token cost.
   * @returns New estimated chat-token count after compaction.
   */
  private async forceCompact(
    reason: string,
    opts?: {
      instructions?: string
      preserveCount?: number
      preservedFirstMeta?: { model: string; tokens: LoopTokenUsage }
    }
  ): Promise<number> {
    const workspace = this.session.getWorkspace()
    const tokenCounter = getTokenCounterService()
    const allMessages = this.session.getMessages()
    const preserveCount = Math.min(opts?.preserveCount ?? 0, allMessages.length)
    const sourceMessages = preserveCount > 0
      ? allMessages.slice(0, allMessages.length - preserveCount)
      : allMessages
    const preservedMessages = preserveCount > 0
      ? allMessages.slice(allMessages.length - preserveCount)
      : []

    let summaryText = ''
    // Captured so the compaction call's usage lands on the [Loop Compacted]
    // marker row (loop rows are the durable per-call usage record).
    let compactionModel: string | undefined
    let compactionTokens: LoopTokenUsage | undefined
    try {
      // Serialize conversation history as a text transcript. Role tags carry
      // the loop seq when known ([USER S137]) so the summary can cite [S<seq>]
      // provenance markers that survive compaction.
      const transcriptLines: string[] = []
      for (const msg of sourceMessages) {
        const role = msg.seq != null ? `${msg.role.toUpperCase()} S${msg.seq}` : msg.role.toUpperCase()
        if (typeof msg.content === 'string') {
          transcriptLines.push(`[${role}] ${msg.content}`)
        } else if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type === 'text' && block.text) {
              transcriptLines.push(`[${role}] ${block.text}`)
            } else if (block.type === 'tool_use') {
              const inputStr = block.input ? JSON.stringify(block.input).slice(0, 200) : ''
              transcriptLines.push(`[${role}] [Called ${block.name}(${inputStr})]`)
            } else if (block.type === 'tool_result') {
              const preview = (block.content ?? '').slice(0, 300)
              transcriptLines.push(`[${role}] [Result: ${preview}]`)
            } else if (block.type === 'thinking' && block.thinking) {
              transcriptLines.push(`[${role}] [Thinking: ${block.thinking.slice(0, 200)}...]`)
            }
          }
        }
      }

      // Trim to reasonable size if very large (~100k chars ≈ 25k tokens)
      let transcript = transcriptLines.join('\n')
      if (transcript.length > 100000) {
        transcript = transcript.slice(transcript.length - 100000)
      }

      const entryCount = workspace.getLoopCount()
      const { response: compactionResponse, metadata: compactionMetadata } = await this.createMessageWithLlmCall('compaction', {
        system: this.compactionPrompt,
        messages: [{
          role: 'user',
          content: buildCompactionUserMessage(transcript, entryCount, opts?.instructions)
        }],
        maxTokens: COMPACTION_TEXT_BUDGET + COMPACTION_REASONING_HEADROOM,
        temperature: 0.3,
        signal: this.abortController?.signal
      })

      // Record compaction token usage
      const compactionTokenUsage = getTokenUsageService()
      compactionTokenUsage.recordUsage(
        compactionMetadata.provider,
        compactionMetadata.model,
        compactionMetadata.input_tokens,
        compactionMetadata.output_tokens,
        {
          cache_read: compactionMetadata.cache_read_tokens,
          cache_write: compactionMetadata.cache_write_tokens,
          reasoning: compactionMetadata.reasoning_tokens,
          cost_usd: compactionMetadata.cost_usd
        }
      )
      // Fleet map burn rate — compaction burns tokens too. Never fatal.
      try {
        getFleetBurnService().record(
          this.session.getWorkspace().getFilePath(),
          compactionMetadata.input_tokens,
          compactionMetadata.output_tokens
        )
      } catch { /* non-fatal */ }
      compactionModel = compactionMetadata.model
      compactionTokens = loopTokensFromLlmMetadata(compactionMetadata)

      summaryText = compactionResponse.content
        .filter(b => b.type === 'text' && b.text)
        .map(b => b.text!)
        .join('\n')
      if (!summaryText.trim()) {
        throw new Error(
          `summarizer returned no text (model ${compactionMetadata.model}, ` +
          `output ${compactionMetadata.output_tokens} tokens, ` +
          `${compactionMetadata.reasoning_tokens ?? 0} reasoning)`
        )
      }
    } catch (error) {
      // No summary → no compaction. Wiping history behind a blank briefing
      // costs the agent its entire context; aborting only costs a retry at the
      // next threshold check.
      const detail = (error instanceof Error ? error.message : String(error)).slice(0, 300)
      console.error(`[AgentExecutor] Compaction aborted (${reason}):`, error)
      try {
        workspace.insertLog('error', 'runtime', 'compaction_failed', compactionModel ?? null, detail, { trigger: reason })
      } catch { /* non-fatal */ }
      this.session.addMessage({
        role: 'user',
        content: [{ type: 'text', text: `[System] Compaction failed: ${detail}. Your history is preserved; compaction will be retried.` }]
      })
      this.session.flushToLoop()
      this.emitEvent({
        type: 'context_injected',
        payload: { category: 'System', content: `Compaction failed — history preserved, will retry. (${detail})` },
        timestamp: Date.now()
      })
      this.emitRuntimeEvent('loop.compaction_failed', { reason: detail, trigger: reason })
      return tokenCounter.estimateMessagesTokens(this.session.getMessages())
    }

    const summaryWithFooter = summaryText + COMPACTION_FOOTER

    // Flush, then compact. Preferred path: compactLoop keeps the preserved
    // tail rows physically in place (seqs/model/tokens untouched) and inserts
    // the summary with an ord override so it sorts first. Requires every
    // preserved message to carry its loop seq — a buffered-write failure can
    // leave one undefined, in which case fall back to the legacy
    // clear + re-append (renumbers, but compaction never fails on mechanics).
    this.session.flushToLoop()
    const loopAudited = this.config.context?.audit?.loop || this.config.audit?.loop || false
    const marker = loopAudited ? '[Loop Compacted, audited]' : '[Loop Compacted]'
    const summaryContent = [{ type: 'text' as const, text: `${marker} ${summaryWithFooter}` }]
    const preservedSeqs = preservedMessages.map(pm => pm.seq)
    const allSeqsKnown = preservedSeqs.every((s): s is number => typeof s === 'number')

    let compacted = false
    if (allSeqsKnown) {
      try {
        await workspace.compactLoop(preservedSeqs, { content: summaryContent, model: compactionModel, tokens: compactionTokens })
        compacted = true
      } catch (error) {
        // Stale seqs (e.g. an external clear raced this compaction): the
        // preserved rows no longer exist in the DB, so fall back to the
        // legacy path which re-creates them from the in-memory session.
        console.warn('[AgentExecutor] compactLoop rejected preserved seqs, using legacy fallback:', error)
      }
    }
    if (!compacted) {
      // Re-append summary + preserved messages in the same tick as the clear
      // commit — an await between clear and re-append lets a concurrent
      // dispatch observe (or append into) a half-rebuilt loop.
      await workspace.clearLoop({ onCommitted: () => {
        workspace.appendToLoop('user', summaryContent, compactionModel, compactionTokens)

        // Re-append preserved current-turn messages so the agent continues from
        // the same point. The first preserved entry (assistant batch) carries
        // model + token metadata from the LLM call that produced it.
        for (let i = 0; i < preservedMessages.length; i++) {
          const pm = preservedMessages[i]
          const content = Array.isArray(pm.content)
            ? pm.content
            : [{ type: 'text' as const, text: String(pm.content) }]
          if (i === 0 && pm.role === 'assistant' && opts?.preservedFirstMeta) {
            workspace.appendToLoop('assistant', content, opts.preservedFirstMeta.model, opts.preservedFirstMeta.tokens)
          } else {
            workspace.appendToLoop(pm.role as 'user' | 'assistant', content)
          }
        }
      } })
    }

    // Reset session and reload from DB
    this.session.reset()
    const loopEntries = workspace.getLoop()
    const llmMessages = loopEntries.map(e => ({ role: e.role, content: e.content_json, created_at: e.created_at, seq: e.seq }))
    this.session.restoreMessages(llmMessages)

    const displayEntries = parseLoopToDisplay(loopEntries)
    this.emitEvent({
      type: 'chat_updated',
      payload: { uiLog: displayEntries },
      timestamp: Date.now()
    })

    const newChatTokens = tokenCounter.estimateMessagesTokens(this.session.getMessages())
    // Reset context dedup so context blocks are re-injected after loop wipe
    this.resetContextState()
    console.log(`[AgentExecutor] Compaction complete (${reason}), new token count: ${newChatTokens}`)
    this.emitRuntimeEvent('loop.compacted', { reason, new_token_count: newChatTokens })
    return newChatTokens
  }

  /**
   * Emit a `tool.started` + `tool.completed`/`tool.failed` pair for a tool
   * outcome the loop synthesized itself — i.e. one that never reached
   * `ToolRegistry.executeTool` and therefore never emitted from the choke
   * point. Keeps every LLM-visible tool_result observable on the umbilical.
   */
  private emitSyntheticToolEvents(
    name: string,
    id: string | undefined,
    input: unknown,
    result: { content: string; isError: boolean }
  ): void {
    try {
      const base: Record<string, unknown> = {
        filePath: this.session.getWorkspace().getFilePath(),
        name,
        ...(id ? { id } : {}),
        input: stripInternalToolFlags(input),
      }
      emitUmbilicalEvent({ event_type: 'tool.started', agentId: this.config.id, payload: base })
      emitUmbilicalEvent({
        event_type: result.isError ? 'tool.failed' : 'tool.completed',
        agentId: this.config.id,
        payload: { ...base, result: { content: result.content, isError: result.isError }, isError: result.isError },
      })
    } catch { /* observability must never break the loop */ }
  }

  /**
   * Emit ONLY `tool.started` for a call that is now in-flight but whose terminal
   * event is emitted later by the real execution (async-restricted approval).
   * Stamps the executor's agent id so a callback-driven resume still reaches the
   * per-agent bus. See executeAsyncTool + Blocker 5.
   */
  private emitToolStarted(name: string, id: string | undefined, input: unknown): void {
    try {
      emitUmbilicalEvent({
        event_type: 'tool.started',
        agentId: this.config.id,
        payload: {
          filePath: this.session.getWorkspace().getFilePath(),
          name,
          ...(id ? { id } : {}),
          input: stripInternalToolFlags(input),
        },
      })
    } catch { /* observability must never break the loop */ }
  }

  /**
   * Pair a previously-emitted enqueue-time `tool.started` with a terminal
   * `tool.failed` for a call that was denied before it ever ran (async-restricted
   * rejection). Keeps the one-started-one-terminal invariant per tool_use id.
   */
  private emitSyntheticToolFailedForStarted(name: string, id: string | undefined, input: unknown, reason: string): void {
    try {
      emitUmbilicalEvent({
        event_type: 'tool.failed',
        agentId: this.config.id,
        payload: {
          filePath: this.session.getWorkspace().getFilePath(),
          name,
          ...(id ? { id } : {}),
          input: stripInternalToolFlags(input),
          result: { content: reason, isError: true },
          isError: true,
        },
      })
    } catch { /* observability must never break the loop */ }
  }

  /** Umbilical emission from executor state transitions — never fatal. */
  private emitRuntimeEvent(eventType: string, payload: Record<string, unknown>): void {
    try {
      // Stamp the executor's own agent id explicitly. Resolvers driven from an
      // IPC/HTTP callback (resolveHilTask/resolveAsk/resolveSuspend) run with no
      // withSource scope, so the async-local agent id is null and the event
      // would otherwise be dropped by the per-agent bus.
      emitUmbilicalEvent({ event_type: eventType, agentId: this.config.id, payload })
    } catch { /* best-effort */ }
  }

  private emitEvent(event: AgentExecutionEvent): void {
    this.emit('event', event)
    // Route executor events onto the umbilical as well. This is the ONLY place
    // executor state transitions reach taps and external /events consumers — the
    // raw `agent.event` daemon envelope that used to mirror every executor event
    // has been retired, so each observable transition must map to a typed event
    // here (or be deliberately excluded — see the default branch).
    const rawPayload = (event.payload as Record<string, unknown>) ?? {}
    const payload = { filePath: this.session.getWorkspace().getFilePath(), ...rawPayload }
    const agentId = this.config.id
    switch (event.type) {
      // tool_call_start / tool_call_result deliberately do NOT map onto the
      // umbilical here. `ToolRegistry.executeTool` is the choke point that emits
      // tool.* for every invocation (LLM loop, sandbox, shell). Mapping here as
      // well would double-emit for LLM-driven calls. Synthetic tool outcomes
      // that never reach the registry (ask intercept, disabled tool, HIL denial,
      // async task references) go through emitSyntheticToolEvents instead.
      case 'turn_complete':
        emitUmbilicalEvent({ event_type: 'turn.completed', agentId, timestamp: event.timestamp, payload })
        break
      case 'state_changed':
        emitUmbilicalEvent({ event_type: 'agent.state.changed', agentId, timestamp: event.timestamp, payload })
        break
      case 'error':
        emitUmbilicalEvent({ event_type: 'agent.error', agentId, timestamp: event.timestamp, payload: { event } })
        break
      case 'context_injected': {
        // A system prompt / dynamic-instructions / loop_inject payload was added
        // to the loop. Emit provenance only — the raw content can hold the full
        // system prompt or injected user text, which must not leak to external
        // /events subscribers (same policy as config.changed).
        const contentLen = typeof rawPayload.content === 'string'
          ? Buffer.byteLength(rawPayload.content, 'utf-8')
          : undefined
        emitUmbilicalEvent({
          event_type: 'context.injected',
          agentId,
          timestamp: event.timestamp,
          payload: {
            filePath: payload.filePath,
            ...(rawPayload.category !== undefined ? { category: rawPayload.category } : {}),
            ...(rawPayload.origin !== undefined ? { origin: rawPayload.origin } : {}),
            ...(rawPayload.key !== undefined ? { key: rawPayload.key } : {}),
            ...(rawPayload.delivery !== undefined ? { delivery: rawPayload.delivery } : {}),
            ...(contentLen !== undefined ? { bytes: contentLen } : {}),
          },
        })
        break
      }
      default:
        // Deliberately NOT mapped onto the umbilical:
        //  - document_updated / file_updated: already covered by
        //    the workspace's file.written event (these fire only on fs_write,
        //    which writes through workspace.writeFile → file.written).
        //  - inter_agent_message: covered by message.received / message.sent /
        //    message.queued, emitted from the workspace inbox/outbox choke point
        //    (this executor type is UI-only and emitted from ipc/index.ts, not here).
        //  - trigger_message: the turn it initiates is observable via
        //    turn.completed; message-driven triggers are covered by message.received.
        //  - chat_updated, autosaved, response_metadata: UI-only. Model-call
        //    metadata is already carried by llm.completed. text/thinking delta
        //    batches are opt-in via turn.delta.
        break
    }
  }

  private hashString(str: string): string {
    let hash = 0
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i)
      hash = ((hash << 5) - hash) + char
      hash = hash & hash // Convert to 32bit integer
    }
    return hash.toString(36)
  }

  /**
   * Snapshot files referenced by {{<path>}} placeholders in `sources` (incl.
   * mind.md) and hash their contents for the prompt cache key. See
   * prompt-file-injection.ts for resolution semantics (files-only, single pass).
   */
  private snapshotInjectedFiles(sources: string): { hash: string; referenced: string[] } {
    if (this.injectedFileSnapshots === null) this.injectedFileSnapshots = new Map()
    const snap = this.injectedFileSnapshots
    const ws = this.session.getWorkspace()
    const referenced = collectInjectedFiles(sources, (p) => ws.readFile(p), snap)
    const hash = this.hashString(referenced.map(p => `${p}${snap.get(p)}`).join(''))
    return { hash, referenced }
  }

  /**
   * Replace {{<path>}} placeholders with the snapshotted contents of the named
   * adf_files entry. Single pass — injected content is not re-scanned, so a file
   * cannot chain-inject another (no recursion). Resolves only against adf_files
   * via the workspace file API, never adf_identity / adf_meta / adf_config, so it
   * cannot surface gated rows. A missing path renders a visible marker so typos
   * are auditable rather than silently empty.
   */
  private resolveFilePlaceholders(text: string): string {
    if (this.injectedFileSnapshots === null) this.injectedFileSnapshots = new Map()
    const ws = this.session.getWorkspace()
    return resolveInjectedFiles(text, (p) => ws.readFile(p), this.injectedFileSnapshots)
  }

  private buildSystemPrompt(): string {
    // Snapshot files referenced via {{<path>}} in the base prompt + instructions
    // (mind.md among them). Read once per session and cleared on reset, so the
    // injected copy is stable mid-session and refreshes only on compaction/clear.
    const { hash: injectedFilesHash } = this.snapshotInjectedFiles(
      `${this.basePrompt}\n${this.config.instructions}`
    )

    const enabledToolNames = this.config.tools
      .filter(t => t.enabled)
      .map(t => t.name)
      .sort()
    const configHash = this.hashString(
      JSON.stringify({
        name: this.config.name,
        instructions: this.config.instructions,
        include_base_prompt: this.config.include_base_prompt,
        tools: enabledToolNames,
        autonomous: this.config.autonomous,
        compute_browser: this.config.compute?.enabled && this.config.compute.browser !== false,
      })
    )

    // Check cache
    let cachedPrompt: string
    if (
      this.systemPromptCache &&
      this.systemPromptCache.injectedFilesHash === injectedFilesHash &&
      this.systemPromptCache.configHash === configHash
    ) {
      // Cache hit!
      cachedPrompt = this.systemPromptCache.cachedPrompt
    } else {
      // Cache miss - build prompt. mind.md is injected via the {{mind.md}}
      // placeholder (resolved below), not a bespoke block.
      const enabledTools = new Set(enabledToolNames)
      const parts: string[] = []
      if (this.config.include_base_prompt !== false) {
        const assembled = assemblePrompt({
          config: this.config,
          basePrompt: this.basePrompt,
          toolPrompts: this.toolPrompts,
          enabledTools,
          shellEnabled: enabledTools.has('adf_shell'),
        })
        if (assembled) {
          parts.push(assembled)
        }
      }
      if (this.config.instructions) {
        parts.push(`## Agent-Specific Instructions\n\n${this.config.instructions}`)
      }

      // Agent identity (always present) — include model/provider so the agent knows what it's running on
      const identityLines = [`Your name is "${this.config.name}".`]
      if (this.config.model?.provider) identityLines.push(`Provider: ${this.config.model.provider}.`)
      if (this.config.model?.model_id) identityLines.push(`Model: ${this.config.model.model_id}.`)
      if (this.config.id) identityLines.push(`DID: ${this.config.id}.`)
      parts.push(`## Your Identity\n\n${identityLines.join(' ')}`)

      // Multimodal perception guidance (only when at least one modality is enabled)
      const enabledModalities: string[] = []
      if (this.isMultimodalEnabled('image')) enabledModalities.push('image')
      if (this.isMultimodalEnabled('audio')) enabledModalities.push('audio')
      if (this.isMultimodalEnabled('video')) enabledModalities.push('video')
      if (enabledModalities.length > 0) {
        const modalityList = enabledModalities.join(', ')
        parts.push(
          '## Multimodal Perception\n\n' +
          `You have native ${modalityList} perception enabled. ` +
          'Two ways to perceive media:\n\n' +
          '1. **MCP content blocks** — MCP tools that return media as proper content blocks (type: image/audio) are automatically provided to you.\n' +
          '2. **fs_read** — if you have base64-encoded media data (e.g. from a tool that returns it as text), ' +
          'save it to a file using `fs_write` with `encoding: "base64"` and the appropriate `mime_type`, ' +
          'then read it back with `fs_read`. The runtime will detect the media type and attach it natively so you can see/hear it.'
        )
      }

      // State management guidance is provided by the 'state_management' tool
      // prompt section (assemblePrompt), gated on sys_set_state and on
      // include_base_prompt so disabling the base prompt drops it too.

      // Messaging guidance is provided by the '_messaging' tool prompt section
      // (assemblePrompt), gated on messaging.receive. Mesh topology is injected
      // separately via dynamic instructions to avoid cache invalidation.

      // Resolve {{<path>}} file placeholders over the whole assembled prompt
      // (single pass — injected content is not re-scanned, so no recursion).
      cachedPrompt = this.resolveFilePlaceholders(parts.join('\n\n---\n\n'))

      // Token measurement rides the rebuild — real tokenizers are too costly
      // per turn. The _autonomous suffix is appended AFTER the cache read
      // (below), but configHash covers `autonomous` and the text is
      // settings-static, so counting it here stays consistent.
      let promptTokens = this.countPromptTokens(cachedPrompt)
      if (this.config.autonomous) {
        const autonomousPrompt = this.toolPrompts['_autonomous'] ?? DEFAULT_TOOL_PROMPTS['_autonomous']
        if (autonomousPrompt) promptTokens += this.countPromptTokens('\n\n---\n\n' + autonomousPrompt)
      }

      // Cache the result
      this.systemPromptCache = {
        injectedFilesHash,
        configHash,
        cachedPrompt,
        promptTokens,
        injectedFiles: measureInjectedFiles(
          this.injectedFileSnapshots ?? new Map(),
          (text) => this.countPromptTokens(text)
        )
      }
    }

    // Autonomous mode: static per config, safe to include in cached prompt.
    // Appended outside assemblePrompt so it applies even when the base prompt
    // is excluded; text is settings-editable like any other section.
    if (this.config.autonomous) {
      const autonomousPrompt = this.toolPrompts['_autonomous'] ?? DEFAULT_TOOL_PROMPTS['_autonomous']
      if (autonomousPrompt) cachedPrompt += '\n\n---\n\n' + autonomousPrompt
    }

    return cachedPrompt
  }

  /**
   * Build per-turn dynamic instructions (inbox status, context limit warning).
   * Returned as a string to be injected via `dynamicInstructions` on the
   * provider call, keeping the system prompt stable for prompt caching.
   */
  private buildDynamicInstructions(chatTokens: number, compactThreshold: number): string | undefined {
    const parts: string[] = []
    const di = this.config.context?.dynamic_instructions

    // Inbox status — only prompt about unread messages (read messages are already processed)
    if (di?.inbox_hints !== false && this.config.messaging?.inbox_mode) {
      const workspace = this.session.getWorkspace()
      const unread = workspace.getUnreadCount()
      if (unread > 0) {
        let inboxHint = this.dynamicPrompt('dyn_inbox_hint', { unread: String(unread) })
        // When adapters are configured, add reply guidance
        if (this.config.adapters && Object.keys(this.config.adapters).length > 0) {
          const routing = this.dynamicPrompt('dyn_inbox_reply_routing')
          if (routing) inboxHint = inboxHint ? `${inboxHint} ${routing}` : routing
        }
        if (inboxHint) parts.push(inboxHint)
      }
    }

    // Context limit warnings — tiered, each fires only once.
    // 'none' → 'soft' (15k before threshold) → 'imminent' (5k before threshold).
    if (di?.context_warning !== false && this.toolRegistry.get('loop_compact')) {
      const tokensUntilThreshold = compactThreshold - chatTokens
      const warningVars = {
        chat_tokens: chatTokens.toLocaleString(),
        threshold: compactThreshold.toLocaleString(),
        tokens_until: tokensUntilThreshold.toLocaleString(),
      }
      if (tokensUntilThreshold <= 5000 && tokensUntilThreshold > 0 && this.compactionWarningTier !== 'imminent') {
        this.compactionWarningTier = 'imminent'
        const warning = this.dynamicPrompt('dyn_context_warning_imminent', warningVars)
        if (warning) parts.push(warning)
      } else if (tokensUntilThreshold <= 15000 && tokensUntilThreshold > 5000 && this.compactionWarningTier === 'none') {
        this.compactionWarningTier = 'soft'
        const warning = this.dynamicPrompt('dyn_context_warning_soft', warningVars)
        if (warning) parts.push(warning)
      }
    }

    // Mesh topology — injected as dynamic instructions to keep the system prompt stable.
    // Only emits when the topology changes (agent joins/leaves/updates).
    if (di?.mesh_updates !== false && this.meshContextFn && this.config.messaging?.receive) {
      const agents = this.meshContextFn()
      const currentSnapshot = JSON.stringify(agents)
      if (currentSnapshot !== this.lastMeshSnapshot) {
        this.lastMeshSnapshot = currentSnapshot
        if (agents.length > 0) {
          const agentList = agents.map(a => `- **${a.handle}**: ${a.description}`).join('\n')
          const update = this.dynamicPrompt('dyn_mesh_update', { agent_list: this.applyContentLimit(agentList) })
          if (update) parts.push(update)
        } else {
          const update = this.dynamicPrompt('dyn_mesh_update_empty')
          if (update) parts.push(update)
        }
      }
    }

    // Idle reminder — nudge autonomous agents to yield when they're done
    if (di?.idle_reminder !== false && this.config.autonomous && this.toolRegistry.get('sys_set_state')) {
      const reminder = this.dynamicPrompt('dyn_idle_reminder')
      if (reminder) parts.push(reminder)
    }

    return parts.length > 0 ? parts.join('\n\n') : undefined
  }

  /**
   * Resolve a dynamic instruction template (settings override → default) and
   * substitute `{{token}}` placeholders. Lenient: tokens without a provided
   * value are left as-is, and a blanked template suppresses that injection.
   */
  private dynamicPrompt(key: string, vars?: Record<string, string>): string {
    let text = this.toolPrompts[key] ?? DEFAULT_DYNAMIC_PROMPTS[key] ?? ''
    if (vars) {
      for (const [token, value] of Object.entries(vars)) {
        text = text.split(`{{${token}}}`).join(value)
      }
    }
    return text
  }

  /**
   * Consume a pending user interrupt and return it as a text content block
   * suitable for injection into the next user message.
   */
  private consumeInterrupt(): ContentBlock | null {
    const interrupt = this.pendingInterrupt
    if (!interrupt) return null
    this.pendingInterrupt = null

    let userText = 'The user has manually triggered you. Review the document and respond.'
    if ('event' in interrupt && interrupt.event.type === 'chat' && interrupt.event.data) {
      const chatData = interrupt.event.data as ChatEventData
      const textBlock = chatData.message.content_json?.find((b: ContentBlock) => b.type === 'text')
      if (textBlock && 'text' in textBlock) userText = textBlock.text
    }

    return {
      type: 'text',
      text: `[USER INTERRUPT — The user has sent a message while you were working. ` +
            `Read and address it before continuing your current task.]\n\n${userText}`
    }
  }

  private buildTriggerMessage(dispatch: AdfEventDispatch | AdfBatchDispatch): string {
    // Batch dispatch: summarize the batch
    if ('events' in dispatch) {
      const types = dispatch.events.map(e => e.type)
      return `A batch of ${dispatch.count} events fired: ${[...new Set(types)].join(', ')}. Check your inbox/tasks for details.`
    }

    const { event } = dispatch
    switch (event.type) {
      case 'chat': {
        const d = event.data as ChatEventData
        const textBlock = d.message.content_json?.find((b: ContentBlock) => b.type === 'text')
        return (textBlock && 'text' in textBlock ? textBlock.text : null)
          ?? 'The user has manually triggered you. Review the document and respond.'
      }
      case 'inbox': {
        const d = event.data as InboxEventData
        // Owner-originated messages (fleet map group command) are direct
        // instructions from the principal — inline them verbatim like chat
        // instead of hiding them behind the msg_read summary. No prefix: the
        // user role already says who's speaking.
        if (d.message.source === 'user') {
          return this.applyContentLimit(String(d.message.content))
        }
        // Agent scope: build summary from inbox state
        if (dispatch.scope === 'agent') {
          return this.buildInboxSummaryMessage()
        }
        return `You received a message from agent "${d.message.from}": ${this.applyContentLimit(d.message.content)}`
      }
      case 'timer': {
        const d = event.data as TimerEventData
        const parts = [`A scheduled timer has fired.`]
        if (d.timer.payload) parts.push(`Payload: ${d.timer.payload}`)
        if (parts.length === 1) parts.push('Check your mind for context on what to do next.')
        return parts.join('\n')
      }
      case 'startup':
        return 'Agent started. Review your mind for context and take any startup actions.'
      case 'file_change': {
        const d = event.data as FileChangeEventData
        const header = `A file has been ${d.operation}: ${d.path}`
        if (d.diff) {
          return `${header}\n\nChanges:\n\n${this.applyContentLimit(d.diff)}\n\nUse fs_read to see the full file if you need more context.`
        }
        return header
      }
      case 'outbox': {
        const d = event.data as OutboxEventData
        return `An outbound message was sent to "${d.message.to}": ${this.applyContentLimit(d.message.content)}`
      }
      case 'tool_call': {
        const d = event.data as ToolCallEventData
        return [
          `A tool call has been intercepted.`,
          `Tool: ${d.toolName}`,
          `Args: ${this.applyContentLimit(JSON.stringify(d.args))}`,
          `The call is pending. Use db_query on adf_tasks to monitor, or wait for on_task_complete.`
        ].join('\n')
      }
      case 'task_create': {
        const d = event.data as import('../../shared/types/adf-event.types').TaskCreateEventData
        const parts = [
          `A task has been created.`,
          `Task ID: ${d.task.id}`,
          `Tool: ${d.task.tool}`,
          `Status: ${d.task.status}`
        ]
        if (d.task.requires_authorization) parts.push(`Requires authorized code to resolve.`)
        return parts.join('\n')
      }
      case 'task_complete': {
        const d = event.data as TaskCompleteEventData
        const parts = [
          `A task has completed.`,
          `Task ID: ${d.task.id}`,
          `Tool: ${d.task.tool}`,
          `Status: ${d.task.status}`
        ]
        if (d.task.result) parts.push(`Result: ${this.applyContentLimit(d.task.result)}`)
        if (d.task.error) parts.push(`Error: ${d.task.error}`)
        return parts.join('\n')
      }
      case 'log_entry': {
        const d = event.data as LogEntryEventData
        const parts = [
          `A log entry has been recorded.`,
          `Level: ${d.entry.level}`,
        ]
        if (d.entry.origin) parts.push(`Origin: ${d.entry.origin}`)
        if (d.entry.event) parts.push(`Event: ${d.entry.event}`)
        if (d.entry.target) parts.push(`Target: ${d.entry.target}`)
        parts.push(`Message: ${this.applyContentLimit(d.entry.message)}`)
        return parts.join('\n')
      }
      case 'llm_call': {
        const d = event.data as LlmCallEventData
        const parts = [
          `An LLM call completed.`,
          `Provider: ${d.provider}`,
          `Model: ${d.model}`,
          `Source: ${d.source}`,
          `Tokens: ${d.input_tokens} input, ${d.output_tokens} output`,
          `Latency: ${d.duration_ms}ms`,
          `Stop reason: ${d.stop_reason}`,
        ]
        if (d.cache_read_tokens !== undefined) parts.push(`Cache read tokens: ${d.cache_read_tokens}`)
        if (d.cache_write_tokens !== undefined) parts.push(`Cache write tokens: ${d.cache_write_tokens}`)
        if (d.reasoning_tokens !== undefined) parts.push(`Reasoning tokens: ${d.reasoning_tokens}`)
        if (d.cost_usd !== undefined) parts.push(`Estimated cost: $${d.cost_usd.toFixed(6)}`)
        return parts.join('\n')
      }
      default:
        return 'You have been triggered. Review the current state and respond.'
    }
  }

  private buildTriggerContent(dispatch: AdfEventDispatch | AdfBatchDispatch): string | ContentBlock[] {
    if ('event' in dispatch && dispatch.event.type === 'chat') {
      const d = dispatch.event.data as ChatEventData
      if (Array.isArray(d.message.content_json) && d.message.content_json.length > 0) {
        return d.message.content_json
      }
    }
    return this.buildTriggerMessage(dispatch)
  }

  private contentBlocksToText(content: string | ContentBlock[]): string {
    if (typeof content === 'string') return content
    const text = content
      .filter((b) => b.type === 'text' && b.text)
      .map((b) => b.text)
      .join('\n')
    return text || 'The user has manually triggered you. Review the attached content and respond.'
  }

  /** Build inbox summary for agent-scope inbox triggers. */
  private buildInboxSummaryMessage(): string {
    const workspace = this.session.getWorkspace()
    const unread = workspace.getInbox('unread')
    const read = workspace.getInbox('read')

    const unreadBySender: Record<string, number> = {}
    for (const msg of unread) {
      unreadBySender[msg.from] = (unreadBySender[msg.from] ?? 0) + 1
    }

    const summary = JSON.stringify({
      unread: unread.length,
      read: read.length,
      unread_by_sender: unreadBySender,
    }, null, 2)

    return `[Inbox notification] New messages.\n\n${summary}\n\nRead with msg_read; reply with msg_send(parent_id: <inbox id>).`
  }

  /**
   * Strip tool_use and tool_result blocks from messages to fix provider compatibility issues.
   * Keeps text content and other non-tool blocks.
   */
  /**
   * Check if image_url blocks exist in the current session messages.
   * Used to decide whether stripping images is worth trying as an error recovery.
   */
  private tryStripImageBlocksAndRetry(_errorMsg: string): boolean {
    const messages = this.session.getMessages()
    for (const msg of messages) {
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'image_url') return true
        }
      }
    }
    return false
  }

  /**
   * Strip image_url blocks from messages. Used when a provider chokes on image
   * content (malformed image, no vision support, etc).
   */
  private stripImageBlocks(messages: Array<{ role: string; content: any; created_at?: number; seq?: number }>): Array<{ role: string; content: any; created_at?: number; seq?: number }> {
    return messages.map((msg) => {
      if (typeof msg.content === 'string') return msg
      if (!Array.isArray(msg.content)) return msg

      // Preserve identity/metadata (seq, created_at) — dropping them here
      // would erase every [S<seq>] marker and timestamp for the rest of the
      // session and break the prompt-cache prefix.
      const filtered = msg.content.filter((block: any) => block.type !== 'image_url')
      if (filtered.length === 0) {
        return { ...msg, content: '[Image content removed — provider does not support it]' }
      }
      return { ...msg, content: filtered }
    }).filter((msg) => {
      if (typeof msg.content === 'string' && msg.content === '[Image content removed — provider does not support it]') {
        return false
      }
      return true
    })
  }

}
