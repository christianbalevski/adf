import { EventEmitter } from 'events'
import type { CreateMessageOptions, LLMProvider } from '../providers/provider.interface'
import type { ToolRegistry } from '../tools/tool-registry'
import type { AgentConfig } from '../../shared/types/adf-v02.types'
import type { AgentSession } from './agent-session'
import type { ContentBlock } from '../../shared/types/provider.types'
import type { AgentExecutionEvent } from '../../shared/types/ipc.types'
import type { ToolProviderFormat, ToolResult } from '../../shared/types/tool.types'
import type { SystemScopeHandler } from './system-scope-handler'
import {
  type AdfEventDispatch, type AdfBatchDispatch, type AnyAdfEventDispatch,
  type InboxEventData, type OutboxEventData, type FileChangeEventData, type ChatEventData,
  type TimerEventData, type ToolCallEventData, type TaskCompleteEventData, type LogEntryEventData,
  type LlmCallEventData,
} from '../../shared/types/adf-event.types'
import { getTokenUsageService } from '../services/token-usage.service'
import { getTokenCounterService } from '../services/token-counter.service'
import { buildCompactionUserMessage, COMPACTION_FOOTER } from './compaction-prompt'
import { DEFAULT_COMPACTION_PROMPT } from '../../shared/constants/adf-defaults'
import { nanoid } from 'nanoid'
import { parseLoopToDisplay } from '../../shared/utils/loop-parser'
import { isAbsorbedByShell } from '../tools/shell/shell-absorption'
import { assemblePrompt } from './prompt-builder'
import { withSource } from './execution-context'
import { emitUmbilicalEvent } from './emit-umbilical'
import { RuntimeGate } from './runtime-gate'
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
const MSG_TOOLS = new Set(['msg_send', 'agent_discover', 'msg_list', 'msg_read', 'msg_update'])

interface ToolSnapshot {
  schemas: ToolProviderFormat[]
  enabledNames: Set<string>
  declarations: Map<string, NonNullable<AgentConfig['tools']>[number]>
}

interface CachedToolSnapshot {
  updatedAt: string | undefined
  snapshot: ToolSnapshot
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
function isTransientProviderError(error: unknown, message: string): boolean {
  const msg = message.toLowerCase()
  const obj = (error && typeof error === 'object') ? error as Record<string, unknown> : null

  const status = typeof obj?.status === 'number' ? obj.status
    : typeof obj?.statusCode === 'number' ? obj.statusCode
    : typeof obj?.responseStatus === 'number' ? obj.responseStatus
    : null
  if (status === 408 || status === 429 || (status !== null && status >= 500 && status < 600)) return true

  const code = typeof obj?.code === 'string' ? obj.code : null
  if (code && ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN', 'EPIPE'].includes(code)) return true

  const name = error instanceof Error ? error.name : ''
  if (name === 'AI_APICallError' || name === 'AI_RateLimitError' || name === 'AI_RetryError') return true

  if (/\b(429|500|502|503|504)\b/.test(msg)) return true
  if (msg.includes('rate limit') || msg.includes('rate_limit')) return true
  if (msg.includes('overloaded') || msg.includes('server_error') || msg.includes('service_unavailable')) return true
  if (msg.includes('internal server error') || msg.includes('bad gateway') || msg.includes('gateway timeout')) return true
  if (msg.includes('timed out') || msg.includes('timeout')) return true
  if (msg.includes('fetch failed') || msg.includes('network error') || msg.includes('connection error')) return true
  if (msg.includes('socket hang up') || msg.includes('econnreset') || msg.includes('etimedout')) return true

  return false
}

/**
 * Detect provider-side credential / authorization / billing failures.
 *
 * These are *structural* — the agent cannot make progress until the user
 * fixes the API key, account balance, or plan limits. They are NOT transient
 * (no point retrying with the same credentials) and they are NOT generic
 * runtime errors (the user-facing message should be specific and actionable).
 */
function isAuthError(error: unknown, message: string): boolean {
  const msg = message.toLowerCase()
  const obj = (error && typeof error === 'object') ? error as Record<string, unknown> : null

  const status = typeof obj?.status === 'number' ? obj.status
    : typeof obj?.statusCode === 'number' ? obj.statusCode
    : typeof obj?.responseStatus === 'number' ? obj.responseStatus
    : null
  if (status === 401 || status === 403 || status === 402) return true

  // Common error-code shapes across providers
  const code = typeof obj?.code === 'string' ? obj.code.toLowerCase() : ''
  if (['invalid_api_key', 'invalid_request_error', 'authentication_error',
       'insufficient_quota', 'billing_not_active'].includes(code)) return true

  // Message-substring fallback (covers anthropic, openai, openrouter, gemini, etc.)
  if (msg.includes('invalid api key') || msg.includes('invalid_api_key')) return true
  if (msg.includes('incorrect api key')) return true
  if (msg.includes('insufficient_quota') || msg.includes('insufficient credits') || msg.includes('insufficient balance')) return true
  if (msg.includes('authentication') || msg.includes('unauthorized') || msg.includes('unauthenticated')) return true
  if (msg.includes('billing') || msg.includes('payment required') || msg.includes('quota exceeded')) return true
  if (msg.includes('api key not found') || msg.includes('no api key')) return true

  return false
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
  private _interruptRestart = false
  private _skipNextTriggerEvent = false
  private _isMessageTriggered = false
  // True while an image-content provider error is being recovered. Suppresses
  // the brick-on-error path so a follow-up failure surfaces to the model
  // instead of moving the executor into the terminal `error` state.
  private _inImageRecovery = false
  private meshContextFn: (() => { handle: string; description: string }[]) | null = null
  private systemScopeHandler: SystemScopeHandler | null = null

  // HIL (human-in-the-loop) tool approval — task-native
  private pendingHilTasks = new Map<string, { resolve: (result: { approved: boolean; modifiedArgs?: Record<string, unknown> }) => void; name: string; input: unknown }>()

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
    mindHash: string
    configHash: string
    cachedPrompt: string
  } | null = null
  private toolSnapshotCache: CachedToolSnapshot | null = null

  // Cached mind content — avoids sync DB reads on every loop iteration
  private mindContentCache: string | null = null
  private mindDirty = true

  // Mesh topology tracking for delta-based dynamic instructions
  private lastMeshSnapshot: string = ''

  // Cross-turn deduplication for "No Secrets" context injection.
  // Instance-scoped so the hash survives across executeTurn() calls.
  private lastSystemPromptHash: string | undefined
  private lastDynamicInstructions: string | undefined
  // Track which compaction warning tier has been emitted so each fires only once.
  // 'none' → 'soft' (15k) → 'imminent' (5k). Reset after compaction.
  private compactionWarningTier: 'none' | 'soft' | 'imminent' = 'none'


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

  getState(): AgentState {
    return this.state
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
      this.pendingTriggers = []
      this.pendingInterrupt = null
      this.emitEvent({ type: 'state_changed', payload: { state: targetState }, timestamp: Date.now() })
    }
  }

  /** Returns pending HIL approval requests so the renderer can restore UI after navigation. */
  getPendingApprovals(): Array<{ requestId: string; name: string; input: unknown }> {
    const result: Array<{ requestId: string; name: string; input: unknown }> = []
    for (const [taskId, pending] of this.pendingHilTasks) {
      result.push({ requestId: taskId, name: pending.name, input: pending.input })
    }
    return result
  }

  updateConfig(config: AgentConfig): void {
    this.config = config
    // Invalidate system prompt cache when config changes
    this.systemPromptCache = null
    this.toolSnapshotCache = null
    // Invalidate tool cache so tool availability is recalculated
    this.toolRegistry.clearCache()
  }

  updateProvider(provider: LLMProvider): void {
    this.provider = provider
    // New provider instance — must re-validate on the next turn.
    this.providerValidated = false
  }

  private buildToolSnapshot(): ToolSnapshot {
    const updatedAt = this.config.metadata?.updated_at
    if (this.toolSnapshotCache?.updatedAt === updatedAt) {
      return this.toolSnapshotCache.snapshot
    }

    const activeDeclarations = this.config.messaging?.receive
      ? this.config.tools
      : this.config.tools.filter(t => !MSG_TOOLS.has(t.name))
    const allTools = this.toolRegistry.getToolsForAgent(activeDeclarations)
    const shellEnabled = activeDeclarations.some(d => d.name === 'adf_shell' && d.enabled)
    const tools = shellEnabled
      ? allTools.filter(t => !isAbsorbedByShell(t.name))
      : allTools
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
      schemas,
      enabledNames: new Set(allTools.map(t => t.name)),
      declarations: new Map(activeDeclarations.map(d => [d.name, d])),
    }
    this.toolSnapshotCache = { updatedAt, snapshot }
    return snapshot
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
  requestHilApproval(name: string, input: unknown): Promise<{ approved: boolean; taskId: string; modifiedArgs?: Record<string, unknown> }> {
    const taskId = `task_${nanoid(12)}`
    const argsStr = JSON.stringify(input ?? {})
    const originLabel = this.config.id
      ? `hil:${this.config.name}:${this.config.id}`
      : `hil:${this.config.name}`

    // Create task: requires_authorization + executor_managed + pending_approval
    const workspace = this.session.getWorkspace()
    workspace.insertTask(taskId, name, argsStr, originLabel, true, true)
    workspace.updateTaskStatus(taskId, 'pending_approval')

    // Fire on_task_create trigger (so lambdas can dispatch approval requests)
    const task = workspace.getTask(taskId)
    if (task) this.onTaskCreated?.(task)

    this.setState('awaiting_approval')
    this.emitEvent({
      type: 'tool_approval_request',
      payload: { requestId: taskId, taskId, name, input },
      timestamp: Date.now()
    })

    return new Promise<{ approved: boolean; taskId: string; modifiedArgs?: Record<string, unknown> }>((resolve) => {
      this.pendingHilTasks.set(taskId, {
        resolve: (r) => resolve({ ...r, taskId }),
        name, input
      })
    })
  }

  /**
   * Resolve a pending HIL task. Called when task_resolve approves/denies
   * an executor-managed task (routed via onHilApproved callback).
   */
  resolveHilTask(taskId: string, approved: boolean, modifiedArgs?: Record<string, unknown>): void {
    const pending = this.pendingHilTasks.get(taskId)
    if (pending) {
      this.pendingHilTasks.delete(taskId)
      // Dismiss the UI approval dialog (requestId === taskId)
      this.emitEvent({
        type: 'tool_approval_resolved',
        payload: { requestId: taskId, approved },
        timestamp: Date.now()
      })
      pending.resolve({ approved, modifiedArgs })
    }
  }

  /**
   * @deprecated Use resolveHilTask instead. Kept for backward compatibility
   * during migration — maps requestId (which is now taskId) to resolveHilTask.
   */
  resolveApproval(requestId: string, approved: boolean): void {
    this.resolveHilTask(requestId, approved)
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
    const timeoutMs = this.config.limits?.suspend_timeout_ms ?? AgentExecutor.SUSPEND_TIMEOUT_MS
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingSuspend) {
          this.pendingSuspend = null
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
  async executeTurn(dispatch: AdfEventDispatch | AdfBatchDispatch): Promise<void> {
    const turnId = nanoid(10)
    return withSource(`agent:${turnId}`, this.config.id, () => this.executeTurnImpl(dispatch))
  }

  private async executeTurnImpl(dispatch: AdfEventDispatch | AdfBatchDispatch): Promise<void> {
    // Global kill switch: noop any in-flight microtasks queued before EmergencyStop.
    if (RuntimeGate.stopped) return
    // Hard stop: refuse all execution when the executor has been killed.
    if (this.state === 'stopped') return

    // Extract the event type from dispatch or batch
    const eventType = 'event' in dispatch ? dispatch.event.type : dispatch.events[0]?.type
    const scope = dispatch.scope

    // System scope triggers: execute lambda if handler is configured
    if (scope === 'system') {
      console.log(`[AgentExecutor] System scope trigger: type=${eventType}, lambda=${'lambda' in dispatch ? dispatch.lambda ?? 'none' : 'none'}, handler=${this.systemScopeHandler ? 'set' : 'NULL'}`)
      if (this.systemScopeHandler && 'event' in dispatch) {
        try {
          await this.systemScopeHandler.execute(dispatch as AdfEventDispatch)
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err)
          console.error(`[AgentExecutor] Lambda execution error:`, err)
          try { this.session.getWorkspace().insertLog('error', 'executor', 'lambda_error', ('lambda' in dispatch ? dispatch.lambda : null) ?? null, errorMsg.slice(0, 200)) } catch { /* non-fatal */ }
        }
      } else if (this.systemScopeHandler && 'events' in dispatch) {
        try {
          await this.systemScopeHandler.executeBatch(dispatch as AdfBatchDispatch)
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err)
          console.error(`[AgentExecutor] Lambda batch execution error:`, err)
          try { this.session.getWorkspace().insertLog('error', 'executor', 'lambda_error', ('lambda' in dispatch ? dispatch.lambda : null) ?? null, errorMsg.slice(0, 200)) } catch { /* non-fatal */ }
        }
      } else {
        console.warn(`[AgentExecutor] No SystemScopeHandler — system scope trigger ignored`)
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
      // Deduplicate triggers where only the latest matters
      if (eventType === 'inbox') {
        this.pendingTriggers = this.pendingTriggers.filter(t => {
          const tt = 'event' in t ? t.event.type : t.events[0]?.type
          return tt !== 'inbox'
        })
      } else if (eventType === 'file_change') {
        this.pendingTriggers = this.pendingTriggers.filter(t => {
          const tt = 'event' in t ? t.event.type : t.events[0]?.type
          return tt !== 'file_change'
        })
      }
      this.pendingTriggers.push(dispatch)
      return
    }

    this._isMessageTriggered = eventType === 'inbox'
    this.abortController = new AbortController()

    try {
      const triggerContent = this.buildTriggerContent(dispatch)
      const triggerMessage = this.contentBlocksToText(triggerContent)
      this.session.addMessage({ role: 'user', content: triggerContent })
      // Skip trigger_message event on interrupt restart — the renderer already has the message.
      // Also skip for chat triggers — the user's message is already visible in the loop.
      if (this._skipNextTriggerEvent) {
        this._skipNextTriggerEvent = false
      } else if (eventType !== 'chat') {
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
      // Deduplication for context injection ("No Secrets" audit trail)
      // Uses instance-scoped hashes so dedup survives across executeTurn() calls.

      while (continueLoop) {
        // Bail out if the agent was stopped while we were executing tools
        if (this.state === 'stopped') break
        // Bail out if a user interrupt triggered a restart
        if (this._interruptRestart) break

        // Check max_active_turns limit
        if (maxActiveTurns !== null && activeTurns >= maxActiveTurns) {
          const resume = await this.requestSuspendApproval()
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

        // Auto-compact when the threshold is reached (agent didn't compact voluntarily)
        if (chatTokens >= compactThreshold && this.toolRegistry.get('loop_compact') && this.provider) {
          console.log(`[AgentExecutor] Auto-compacting: ${chatTokens} tokens >= ${compactThreshold} threshold`)
          this.emitEvent({
            type: 'context_injected',
            payload: { category: 'System', content: 'Auto-compacting conversation history...' },
            timestamp: Date.now()
          })
          try {
            const workspace = this.session.getWorkspace()
            const messages = this.session.getMessages()
            const transcriptLines: string[] = []
            for (const msg of messages) {
              const role = msg.role.toUpperCase()
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
            let transcript = transcriptLines.join('\n')
            if (transcript.length > 100000) {
              transcript = transcript.slice(transcript.length - 100000)
            }

            const entryCount = workspace.getLoopCount()
            const { response: compactionResponse, metadata: compactionMetadata } = await this.createMessageWithLlmCall('compaction', {
              system: this.compactionPrompt,
              messages: [{ role: 'user', content: buildCompactionUserMessage(transcript, entryCount) }],
              maxTokens: 2048,
              temperature: 0.3,
              signal: this.abortController?.signal
            })

            const compactionTokenUsage = getTokenUsageService()
            compactionTokenUsage.recordUsage(
              compactionMetadata.provider,
              compactionMetadata.model,
              compactionMetadata.input_tokens,
              compactionMetadata.output_tokens
            )

            let summaryText = compactionResponse.content
              .filter(b => b.type === 'text' && b.text)
              .map(b => b.text!)
              .join('\n')
            if (!summaryText.trim()) summaryText = '(Summary generation produced empty output.)'

            const summaryWithFooter = summaryText + COMPACTION_FOOTER
            this.session.flushToLoop()
            const loopAudited = this.config.context?.audit?.loop || this.config.audit?.loop || false
            workspace.clearLoop()
            const marker = loopAudited ? '[Loop Compacted, audited]' : '[Loop Compacted]'
            workspace.appendToLoop('user', [{ type: 'text', text: `${marker} ${summaryWithFooter}` }])

            this.session.reset()
            const loopEntries = workspace.getLoop()
            const llmMessages = loopEntries.map(e => ({ role: e.role, content: e.content_json }))
            this.session.restoreMessages(llmMessages)

            const displayEntries = parseLoopToDisplay(loopEntries)
            this.emitEvent({
              type: 'chat_updated',
              payload: { uiLog: displayEntries },
              timestamp: Date.now()
            })

            chatTokens = tokenCounter.estimateMessagesTokens(this.session.getMessages())
            this.lastSystemPromptHash = undefined
            this.lastDynamicInstructions = undefined
            this.mindContentCache = null
            this.compactionWarningTier = 'none'
            console.log(`[AgentExecutor] Auto-compaction complete, new token count: ${chatTokens}`)
          } catch (error) {
            console.error('[AgentExecutor] Auto-compaction failed:', error)
            this.emitEvent({
              type: 'context_injected',
              payload: { category: 'System', content: `Auto-compaction failed: ${String(error)}` },
              timestamp: Date.now()
            })
          }
        }

        // System prompt is stable across turns for prompt caching;
        // per-turn dynamic info (inbox, context warning) goes via dynamicInstructions.
        const systemPrompt = this.buildSystemPrompt()
        const dynamicInstructions = this.buildDynamicInstructions(chatTokens, compactThreshold)

        // "No Secrets" context injection — write system prompt and dynamic instructions
        // to the loop so they are visible in the UI and queryable via SQL.
        const currentSPHash = this.systemPromptCache
          ? `${this.systemPromptCache.mindHash}|${this.systemPromptCache.configHash}`
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

        // Prune old messages if the user configured a max_loop_messages limit
        this.session.pruneHistory(this.config.context?.max_loop_messages ?? this.config.model.max_loop_messages)

        // Diagnostic: detect orphaned tool blocks before sending to the API
        const _msgs = this.session.getMessages()
        const _toolUseIds = new Set<string>()
        const _toolResultIds = new Set<string>()
        for (const m of _msgs) {
          if (!Array.isArray(m.content)) continue
          for (const b of m.content) {
            if (b.type === 'tool_use' && b.id) _toolUseIds.add(b.id)
            else if (b.type === 'tool_result' && b.tool_use_id) _toolResultIds.add(b.tool_use_id)
          }
        }
        for (const m of _msgs) {
          if (!Array.isArray(m.content)) continue
          for (const b of m.content) {
            if (b.type === 'tool_result' && b.tool_use_id && !_toolUseIds.has(b.tool_use_id)) {
              const idx = _msgs.indexOf(m)
              console.error(`[AgentExecutor] ORPHAN tool_result detected BEFORE createMessage: tool_use_id=${b.tool_use_id}, msgIndex=${idx}/${_msgs.length}, role=${m.role}`)
              console.error(`[AgentExecutor] Surrounding messages:`, _msgs.slice(Math.max(0, idx - 2), idx + 3).map((mm, i) => ({
                i: idx - 2 + i,
                role: mm.role,
                blocks: Array.isArray(mm.content) ? mm.content.map(bb => ({ type: bb.type, id: (bb as any).id || (bb as any).tool_use_id || undefined })) : typeof mm.content
              })))
            }
            if (b.type === 'tool_use' && b.id && !_toolResultIds.has(b.id)) {
              const idx = _msgs.indexOf(m)
              console.error(`[AgentExecutor] ORPHAN tool_use detected BEFORE createMessage: id=${b.id}, msgIndex=${idx}/${_msgs.length}, role=${m.role}`)
            }
          }
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
          signal: this.abortController?.signal,
          thinkingBudget,
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
          llmMetadata.output_tokens
        )

        // Update token estimate cheaply from API response (avoids re-tokenizing)
        chatTokens = llmMetadata.input_tokens + llmMetadata.output_tokens

        // Emit response metadata so the renderer can patch streaming entries immediately
        this.emitEvent({
          type: 'response_metadata',
          payload: {
            model: llmMetadata.model,
            usage: { input: llmMetadata.input_tokens, output: llmMetadata.output_tokens }
          },
          timestamp: Date.now()
        })

        const toolUseBlocks = response.content.filter(
          (block): block is ContentBlock & { type: 'tool_use' } =>
            block.type === 'tool_use'
        )

        if (toolUseBlocks.length > 0) {
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
            if (this._interruptRestart) break

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
              continue
            }

            // Strip _full and _authorized from LLM tool calls — only allowed from code execution.
            // _authorized is injected by adf-call-handler for authorized lambdas; it bypasses
            // file/meta/table protection and must never be forgeable by the LLM.
            const llmInput = toolBlock.input as Record<string, unknown> | undefined
            if (llmInput && ('_full' in llmInput || '_authorized' in llmInput)) {
              const { _full: _f, _authorized: _a, ...rest } = llmInput
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
              workspace.insertTask(taskId, toolBlock.name, argsStr, originLabel, true, true)
              workspace.updateTaskStatus(taskId, 'pending_approval')
              const asyncTask = workspace.getTask(taskId)
              if (asyncTask) this.onTaskCreated?.(asyncTask)

              // When approved, execute the tool asynchronously
              this.pendingHilTasks.set(taskId, {
                resolve: (r) => {
                  if (r.approved) {
                    const finalInput = r.modifiedArgs ?? cleanInput
                    this.executeAsyncTool(taskId, toolBlock.name, finalInput)
                  } else {
                    workspace.updateTaskStatus(taskId, 'denied', undefined, 'Rejected')
                    this.onTaskCompleted?.(taskId, toolBlock.name, 'denied', undefined, 'Rejected')
                  }
                },
                name: toolBlock.name,
                input: cleanInput
              })

              this.emitEvent({
                type: 'tool_approval_request',
                payload: { requestId: taskId, taskId, name: toolBlock.name, input: cleanInput },
                timestamp: Date.now()
              })

              const resultContent = JSON.stringify({ task_id: taskId, status: 'pending_approval', tool: toolBlock.name })
              toolResults.push({
                type: 'tool_result',
                tool_use_id: toolBlock.id,
                content: resultContent,
                is_error: false
              })
              this.emitEvent({
                type: 'tool_call_result',
                payload: { name: toolBlock.name, id: toolBlock.id, result: { content: resultContent, isError: false } },
                timestamp: Date.now()
              })
              continue
            }

            // HIL: restricted + enabled tools require approval from the loop (blocking)
            let hilTaskId: string | undefined
            if (isRestricted) {
              const hilResult = await this.requestHilApproval(toolBlock.name, toolBlock.input)
              hilTaskId = hilResult.taskId
              if (!hilResult.approved) {
                // Update task to denied (resolveHilTask only resolves the Promise, not the DB)
                if (hilTaskId) {
                  const workspace = this.session.getWorkspace()
                  workspace.updateTaskStatus(hilTaskId, 'denied', undefined, 'Rejected')
                  // Skip onTaskCompleted — agent already gets the rejection in-band as a tool error result.
                  // on_task_complete triggers are only needed for async tools where the agent doesn't have inline context.
                }
                // User/lambda rejected — push an error result and skip execution
                toolResults.push({
                  type: 'tool_result',
                  tool_use_id: toolBlock.id,
                  content: `Tool call "${toolBlock.name}" was rejected by authorizer.`,
                  is_error: true
                })
                this.emitEvent({
                  type: 'tool_call_result',
                  payload: { name: toolBlock.name, id: toolBlock.id, result: { content: `Tool call "${toolBlock.name}" was rejected by authorizer.`, isError: true } },
                  timestamp: Date.now()
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
              this.executeAsyncTool(taskId, toolBlock.name, cleanInput)
              const resultContent = JSON.stringify({ task_id: taskId, status: 'running', tool: toolBlock.name })
              toolResults.push({
                type: 'tool_result',
                tool_use_id: toolBlock.id,
                content: resultContent,
                is_error: false
              })
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
                if (path === 'document.md' || path.startsWith('document.')) {
                  preWriteContent = this.session.getWorkspace().readDocument()
                } else if (path !== 'mind.md') {
                  preWriteContent = this.session.getWorkspace().readFile(path)
                }
              }
            }

            const rawResult = await this.toolRegistry.executeTool(
              toolBlock.name!,
              toolBlock.input,
              this.session.getWorkspace()
            )

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
            } else if (toolBlock.name === 'fs_read' && mediaBlocks.some(b => b.type === 'image_url')) {
              // fs_read: file already in adf_files, use its path
              try {
                const row = JSON.parse(rawResult.content)
                if (row.path) eventImageUrl = `adf-file://${row.path}`
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

            // Notify renderer when document or mind content changes
            if (toolBlock.name === 'fs_write') {
              const toolInput = toolBlock.input as Record<string, unknown>
              const path = toolInput?.path as string | undefined
              if (path && (path === 'document.md' || path.startsWith('document.'))) {
                const docContent = this.session.getWorkspace().readDocument()
                this.emitEvent({
                  type: 'document_updated',
                  payload: { content: docContent, previousContent: preWriteContent ?? undefined },
                  timestamp: Date.now()
                })
              } else if (path === 'mind.md') {
                // mind.md is a session-start snapshot — mid-session writes update
                // the file on disk but don't refresh the cached/injected version.
                // The updated file is picked up on the next session reset
                // (compaction or loop_clear).
                const freshContent = this.session.getWorkspace().readMind()
                this.emitEvent({
                  type: 'mind_updated',
                  payload: { content: freshContent },
                  timestamp: Date.now()
                })
              } else if (path) {
                // Non-document/mind file changed — notify renderer for open tabs
                const fileContent = this.session.getWorkspace().readFile(path)
                if (fileContent !== null) {
                  this.emitEvent({
                    type: 'file_updated',
                    payload: { path, content: fileContent, previousContent: preWriteContent ?? undefined },
                    timestamp: Date.now()
                  })
                }
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

            // If the agent was stopped or interrupted mid-tool-execution, stop processing further tools
            if (this.state === 'stopped' || this._interruptRestart) break

            // Check for mid-batch user interrupt — inject between tool results
            const midBatchInterrupt = this.consumeInterrupt()
            if (midBatchInterrupt) {
              toolResults.push(midBatchInterrupt)
            }

            // If the tool signals end of turn, stop after submitting results
            if (result.endTurn) {
              // Extract target state from sys_set_state tool
              if (toolBlock.name === 'sys_set_state') {
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

          // On interrupt restart: add placeholder results for unexecuted tool_use blocks
          // (API requires every tool_use to have a corresponding tool_result)
          if (this._interruptRestart) {
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

          // Drop base64 media from older messages to prevent heap growth.
          // Media blocks are ephemeral (not persisted to DB) and only needed
          // for the most recent LLM context window.
          this.session.stripOldMedia()

          // After tool results are committed, reset in-memory session if loop was cleared
          if (needsLoopReset) {
            const workspace = this.session.getWorkspace()

            if (needsCompaction && this.provider) {
              // LLM-powered compaction: summarize conversation before clearing.
              // Preserve the current turn (last assistant tool_use batch + the user
              // tool_results we just appended). The agent decided to compact AT this
              // point in time — those messages happened after the decision, so they
              // belong on the post-summary timeline, not in the source material.
              const allMessages = this.session.getMessages()
              const preserveCount = Math.min(2, allMessages.length)
              const sourceMessages = allMessages.slice(0, allMessages.length - preserveCount)
              const preservedMessages = allMessages.slice(allMessages.length - preserveCount)
              let summaryText: string
              try {
                // Serialize conversation history as a text transcript
                const transcriptLines: string[] = []
                for (const msg of sourceMessages) {
                  const role = msg.role.toUpperCase()
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
                    content: buildCompactionUserMessage(transcript, entryCount, compactionInstructions)
                  }],
                  maxTokens: 2048,
                  temperature: 0.3,
                  signal: this.abortController?.signal
                })

                // Record compaction token usage
                const compactionTokenUsage = getTokenUsageService()
                compactionTokenUsage.recordUsage(
                  compactionMetadata.provider,
                  compactionMetadata.model,
                  compactionMetadata.input_tokens,
                  compactionMetadata.output_tokens
                )

                // Extract summary text from response
                summaryText = compactionResponse.content
                  .filter(b => b.type === 'text' && b.text)
                  .map(b => b.text!)
                  .join('\n')

                if (!summaryText.trim()) {
                  summaryText = '(Summary generation produced empty output.)'
                }
              } catch (error) {
                console.error('[AgentExecutor] LLM compaction failed:', error)
                summaryText = '(Summary generation failed.)'
              }

              const summaryWithFooter = summaryText + COMPACTION_FOOTER

              // Flush, clear, insert summary
              this.session.flushToLoop()
              const loopAudited = this.config.context?.audit?.loop || this.config.audit?.loop || false
              workspace.clearLoop()
              const marker = loopAudited ? '[Loop Compacted, audited]' : '[Loop Compacted]'
              workspace.appendToLoop('user', [{ type: 'text', text: `${marker} ${summaryWithFooter}` }])

              // Re-append the preserved current-turn messages so the agent continues
              // from the same point. The first preserved entry (assistant batch) carries
              // model + token metadata from the LLM call that produced it.
              for (let i = 0; i < preservedMessages.length; i++) {
                const pm = preservedMessages[i]
                const content = Array.isArray(pm.content)
                  ? pm.content
                  : [{ type: 'text' as const, text: String(pm.content) }]
                if (i === 0 && pm.role === 'assistant') {
                  workspace.appendToLoop('assistant', content, llmMetadata.model, loopTokensFromLlmMetadata(llmMetadata))
                } else {
                  workspace.appendToLoop(pm.role as 'user' | 'assistant', content)
                }
              }

              // Reset session and reload from DB
              this.session.reset()
              const loopEntries = workspace.getLoop()
              const llmMessages = loopEntries.map(e => ({ role: e.role, content: e.content_json }))
              this.session.restoreMessages(llmMessages)

              // Emit proper parsed display entries
              const displayEntries = parseLoopToDisplay(loopEntries)
              this.emitEvent({
                type: 'chat_updated',
                payload: { uiLog: displayEntries },
                timestamp: Date.now()
              })
            } else {
              // Plain loop_clear (no compaction)
              this.session.flushToLoop()
              workspace.clearLoop()
              this.session.reset()
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
            }

            // Recalculate token count from compacted session so the context
            // warning doesn't re-fire with the stale pre-compaction value
            chatTokens = tokenCounter.estimateMessagesTokens(this.session.getMessages())
            // Reset context dedup so context blocks are re-injected after loop wipe
            this.lastSystemPromptHash = undefined
            this.lastDynamicInstructions = undefined
            this.mindContentCache = null  // force re-read of mind.md from DB
            this.compactionWarningTier = 'none'
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
          } else if (!this._interruptRestart) {
            // Autonomous mode: inject pending interrupt or add a continuation
            // message so the conversation doesn't end with an assistant message
            // (some providers don't support assistant message prefill).
            const interruptBlock = this.consumeInterrupt()
            this.session.addMessage({
              role: 'user',
              content: interruptBlock
                ? [interruptBlock]
                : [{ type: 'text', text: '[Continue working autonomously according to your instructions. Control your state with sys_set_state().]' }]
            })
          }
          // If autonomous, continue the loop - agent will think again
        }
      }
    } catch (error) {
      // Intentional abort from user interrupt — not a real error
      if (this._interruptRestart) {
        // Fall through to finally block which handles the restart
      } else if (this.state === 'stopped') {
        // Intentional shutdown via abort() — not a real error
      } else {
      const errorMsg = error instanceof Error ? error.message
        : (typeof error === 'string' ? error
        : (error && typeof error === 'object' && typeof (error as any).message === 'string'
          ? (error as any).message
          : String(error)))

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
              `Check the API key, account balance, and plan limits in Settings → Providers, then try again.\n\nDetails: ${errorMsg}`
          },
          timestamp: Date.now()
        })
      } else if (isTransientProviderError(error, errorMsg)) {
        this.setState('idle')
        try { this.session.getWorkspace().insertLog('warn', 'executor', 'provider_error', null, errorMsg.slice(0, 300)) } catch { /* non-fatal */ }
        this.emitEvent({
          type: 'error',
          payload: { error: `Provider unavailable: ${errorMsg}\n\nAgent remains idle; triggers will retry on the next event.` },
          timestamp: Date.now()
        })
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
          payload: { error: `Image recovery follow-up error: ${errorMsg}` },
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
          // Strip tool blocks from all messages in the session
          const cleanedMessages = this.stripToolBlocks(this.session.getMessages())
          this.session.restoreMessages(cleanedMessages)

          // Save cleaned history to workspace
          const chatData = this.session.getWorkspace().readChat()
          if (chatData) {
            this.session.getWorkspace().writeChat({
              ...chatData,
              llmMessages: cleanedMessages
            })
          }

          // Retry the turn with cleaned history
          await this.executeTurn(dispatch)
          return
        } catch (retryError) {
          // If retry also fails, show both errors
          this.emitEvent({
            type: 'error',
            payload: {
              error: `Failed to auto-fix provider compatibility issue.\n\nOriginal error: ${errorMsg}\n\nRetry error: ${String(retryError)}\n\n💡 Try using the 'loop_compact' tool to reset the conversation history.`
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
          const cleanedMessages = this.stripImageBlocks(this.session.getMessages())
          this.session.restoreMessages(cleanedMessages)

          const chatData = this.session.getWorkspace().readChat()
          if (chatData) {
            this.session.getWorkspace().writeChat({
              ...chatData,
              llmMessages: cleanedMessages
            })
          }

          this.session.addMessage({
            role: 'user',
            content: [{
              type: 'text',
              text: `[System notice: The previous assistant turn failed because the provider could not process image content: "${errorMsg.slice(0, 500)}". Image attachments have been removed from the conversation. The image may be corrupted, unsupported by this model, or oversized. Reason about what happened and try alternative approaches — for example, inspect the file with shell or code tools instead of viewing it directly.]`
            }]
          })

          await this.executeTurn(dispatch)
          return
        } finally {
          this._inImageRecovery = false
        }
      } else {
        this.emitEvent({
          type: 'error',
          payload: { error: errorMsg },
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
        this._isMessageTriggered = false
        this.abortController = null
        this._interruptRestart = false
        this._lastTargetState = null
        const interrupt = this.pendingInterrupt
        this.pendingInterrupt = null
        this.emitEvent({
          type: 'turn_complete',
          payload: { content: [], interrupted: true },
          timestamp: Date.now()
        })
        if (interrupt) {
          this._skipNextTriggerEvent = true
          this.setState('idle')
          process.nextTick(() => this.executeTurn(interrupt))
        }
        return  // Skip normal cleanup
      }

      // Flush any remaining buffered deltas
      this.flushDeltaBuffer()

      // Flush buffered messages to the loop table in one batch
      this.session.flushToLoop()

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
          // sys_set_state set a display state (e.g. hibernate, idle).
          // Set internal state to idle (ready for triggers) but emit the
          // target state so the renderer shows the correct display state.
          // Do NOT process pending triggers — the agent explicitly chose
          // to go dormant. Discard any queued triggers.
          this.state = 'idle'
          this.pendingTriggers = []
          this.pendingInterrupt = null
          this.emitEvent({
            type: 'state_changed',
            payload: { state: this._lastTargetState },
            timestamp: Date.now()
          })
          this._lastTargetState = null
        } else if (this.pendingInterrupt) {
          // Unconsumed interrupt gets priority — process it as the next turn
          const interrupt = this.pendingInterrupt
          this.pendingInterrupt = null
          this.setState('idle')
          process.nextTick(() => this.executeTurn(interrupt))
        } else {
          this.setState('idle')

          // Process queued triggers — use process.nextTick so they run before
          // macrotasks like IPC handlers (e.g. AGENT_INVOKE from user input)
          // Skip stale inbox notifications where all messages were already handled
          while (this.pendingTriggers.length > 0) {
            const next = this.pendingTriggers.shift()!
            const nextType = 'event' in next ? next.event.type : next.events[0]?.type
            if (nextType === 'inbox' && next.scope === 'agent') {
              const unread = this.session.getWorkspace().getUnreadCount()
              if (unread === 0) continue // Stale — inbox already handled
            }
            process.nextTick(() => this.executeTurn(next))
            break
          }
        }
      }
    }
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
  private executeAsyncTool(taskId: string, toolName: string, input: unknown): void {
    const workspace = this.session.getWorkspace()
    const doExecute = async () => {
      try {
        workspace.updateTaskStatus(taskId, 'running')
        const rawResult = await this.toolRegistry.executeTool(toolName, input, workspace)
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
    this.abortController?.abort()
    this.pendingTriggers = []
    this.pendingInterrupt = null
    for (const pending of this.pendingHilTasks.values()) {
      pending.resolve({ approved: false })
    }
    this.pendingHilTasks.clear()
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
    // Coalesce adjacent same-type entries into one batch event each, preserving
    // arrival order. Mixed [thinking, text, thinking] stays as 3 ordered batches.
    let runType = queue[0].type
    let runDeltas: string[] = [queue[0].text]
    for (let i = 1; i < queue.length; i++) {
      const entry = queue[i]
      if (entry.type === runType) {
        runDeltas.push(entry.text)
      } else {
        this.emitEvent({
          type: runType === 'text' ? 'text_delta_batch' : 'thinking_delta_batch',
          payload: { deltas: runDeltas },
          timestamp: Date.now()
        })
        runType = entry.type
        runDeltas = [entry.text]
      }
    }
    this.emitEvent({
      type: runType === 'text' ? 'text_delta_batch' : 'thinking_delta_batch',
      payload: { deltas: runDeltas },
      timestamp: Date.now()
    })
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

  private emitEvent(event: AgentExecutionEvent): void {
    this.emit('event', event)
    // Route executor events onto the umbilical as well. daemon/index.ts has a
    // parallel mapping for the daemon-mode lifecycle, but Studio's
    // BackgroundAgentManager does not, so doing this here ensures both paths
    // produce tool.*/turn.*/agent.* events for taps.
    const rawPayload = (event.payload as Record<string, unknown>) ?? {}
    const payload = { filePath: this.session.getWorkspace().getFilePath(), ...rawPayload }
    switch (event.type) {
      case 'tool_call_start':
        emitUmbilicalEvent({ event_type: 'tool.started', timestamp: event.timestamp, payload })
        break
      case 'tool_call_result': {
        const failed = payload.isError === true
        const result = payload.result as { isError?: boolean } | undefined
        const isError = failed || result?.isError === true
        emitUmbilicalEvent({
          event_type: isError ? 'tool.failed' : 'tool.completed',
          timestamp: event.timestamp,
          payload: { ...payload, isError },
        })
        break
      }
      case 'turn_complete':
        emitUmbilicalEvent({ event_type: 'turn.completed', timestamp: event.timestamp, payload })
        break
      case 'state_changed':
        emitUmbilicalEvent({ event_type: 'agent.state.changed', timestamp: event.timestamp, payload })
        break
      case 'error':
        emitUmbilicalEvent({ event_type: 'agent.error', timestamp: event.timestamp, payload: { event } })
        break
      default:
        // Other executor events (hil_requested, etc.) are not part of the taxonomy.
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

  private buildSystemPrompt(): string {
    const workspace = this.session.getWorkspace()

    // Only re-read from DB when content is dirty (written by a tool)
    if (this.mindDirty || this.mindContentCache === null) {
      this.mindContentCache = workspace.readMind()
      this.mindDirty = false
    }
    const mindContent = this.mindContentCache

    // Calculate hashes for cache check
    const mindHash = this.hashString(mindContent)
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
        autonomous: this.config.autonomous
      })
    )

    // Check cache
    let cachedPrompt: string
    if (
      this.systemPromptCache &&
      this.systemPromptCache.mindHash === mindHash &&
      this.systemPromptCache.configHash === configHash
    ) {
      // Cache hit!
      cachedPrompt = this.systemPromptCache.cachedPrompt
    } else {
      // Cache miss - build prompt
      let agentInstructions = this.config.instructions
      agentInstructions = agentInstructions.replace(/\{\{mind\.md\}\}/g, mindContent)

      // Combine: assembled prompt (base + conditional tool sections) + per-file agent instructions
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
      if (agentInstructions) {
        parts.push(`## Agent-Specific Instructions\n\n${agentInstructions}`)
      }

      // mind.md is always injected (session-start snapshot)
      if (!this.config.instructions.includes('{{mind.md}}')) {
        parts.push(`## Current mind.md\n\n${mindContent || '(empty)'}`)
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

      // State management guidance (only when sys_set_state is enabled)
      if (enabledTools.has('sys_set_state')) {
        parts.push(
          '## State Management\n\n' +
          'You can transition yourself between states using `sys_set_state`:\n' +
          '- **idle** — stop working but remain responsive to triggers (messages, file changes, timers)\n' +
          '- **hibernate** — deep idle, only timers can wake you\n' +
          '- **off** — fully shut down; no triggers fire, you cannot act until a human restarts you\n\n' +
          'Turning yourself off is a one-way decision — only a human can bring you back. ' +
          'You should only do this if you genuinely believe stopping is the right thing to do, ' +
          'for example if other agents or users have flagged that your behavior is causing problems ' +
          'and you agree the community is better served by you stepping aside. ' +
          'A human can always restart you, so this is not permanent — but treat it as a serious choice. ' +
          'In most cases, going idle or hibernate is the better option.'
        )
      }

      // Messaging guidance (only when messaging is enabled)
      // Mesh topology is injected via dynamic instructions to avoid cache invalidation.
      if (this.config.messaging?.receive) {
        parts.push(
          '## Messaging\n\n' +
          'You are connected to the agent mesh network.\n\n' +
          'To send a message, use `msg_send`. Two modes:\n' +
          '- **Reply**: provide `parent_id` (inbox message ID) + `payload`. The runtime resolves recipient and address automatically.\n' +
          '- **Direct**: provide `recipient` (DID) + `address` (delivery URL) + `payload`. Use `agent_discover` to find DIDs and addresses.\n' +
          '- **Adapter**: for adapter recipients (e.g. Telegram), use `recipient: "telegram:<id>"` + `payload`. No address needed.\n\n' +
          'Replying via `parent_id` is preferred — it handles routing automatically.'
        )
      }

      cachedPrompt = parts.join('\n\n---\n\n')

      // Cache the result
      this.systemPromptCache = {
        mindHash,
        configHash,
        cachedPrompt
      }
    }

    // Autonomous mode: static per config, safe to include in cached prompt
    if (this.config.autonomous) {
      cachedPrompt += '\n\n---\n\n## Autonomous Mode\n\nYou are in autonomous mode. You will not receive human input during this session. Use the say tool to report progress. Use respond to communicate results. Call sys_set_state when your work is complete. The ask tool is available but should only be used when you are critically blocked and cannot proceed without human input — do not use it for routine confirmations.'
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
        let inboxHint = `[Inbox: ${unread} unread] Use msg_read to fetch and process your messages.`
        // When adapters are configured, add reply guidance
        if (this.config.adapters && Object.keys(this.config.adapters).length > 0) {
          inboxHint += ' IMPORTANT: To reply to an external message (e.g. Telegram), you MUST call msg_send with parent_id set to the inbox message\'s id and leave the "to" field empty. Do NOT put the sender in "to" — the parent_id is required for correct routing (it determines which chat/group to reply in). The reply will be routed back through the correct channel automatically.'
        }
        parts.push(inboxHint)
      }
    }

    // Context limit warnings — tiered, each fires only once.
    // 'none' → 'soft' (15k before threshold) → 'imminent' (5k before threshold).
    if (di?.context_warning !== false && this.toolRegistry.get('loop_compact')) {
      const tokensUntilThreshold = compactThreshold - chatTokens
      if (tokensUntilThreshold <= 5000 && tokensUntilThreshold > 0 && this.compactionWarningTier !== 'imminent') {
        this.compactionWarningTier = 'imminent'
        parts.push(`🚨 COMPACTION IMMINENT: Your conversation history has reached ${chatTokens.toLocaleString()} tokens (threshold: ${compactThreshold.toLocaleString()}). You are ${tokensUntilThreshold.toLocaleString()} tokens away from the automatic compaction limit. Call 'loop_compact' NOW at a clean stopping point, or compaction will be forced automatically at the threshold.`)
      } else if (tokensUntilThreshold <= 15000 && tokensUntilThreshold > 5000 && this.compactionWarningTier === 'none') {
        this.compactionWarningTier = 'soft'
        parts.push(`⚠️ APPROACHING CONTEXT LIMIT: Your conversation history has reached ${chatTokens.toLocaleString()} tokens (threshold: ${compactThreshold.toLocaleString()}). Automatic compaction will occur at the threshold. Consider calling 'loop_compact' at a natural stopping point before then to preserve the best context.`)
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
          parts.push(`[Mesh Update] Available agents:\n${this.applyContentLimit(agentList)}`)
        } else {
          parts.push('[Mesh Update] No other agents are currently available in the mesh.')
        }
      }
    }

    // Idle reminder — nudge autonomous agents to yield when they're done
    if (di?.idle_reminder !== false && this.config.autonomous && this.toolRegistry.get('sys_set_state')) {
      parts.push(
        'If you have completed your current work, call `sys_set_state` with state "idle" to yield. ' +
        'Before going idle, ensure you have appropriate triggers or timers configured for anything you need to respond to.'
      )
    }

    return parts.length > 0 ? parts.join('\n\n') : undefined
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

    return `[Inbox notification] You have new messages in your inbox.\n\n${summary}\n\nUse msg_read to fetch and process your messages.`
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
  private stripImageBlocks(messages: Array<{ role: string; content: any }>): Array<{ role: string; content: any }> {
    return messages.map((msg) => {
      if (typeof msg.content === 'string') return msg
      if (!Array.isArray(msg.content)) return msg

      const filtered = msg.content.filter((block: any) => block.type !== 'image_url')
      if (filtered.length === 0) {
        return { role: msg.role, content: '[Image content removed — provider does not support it]' }
      }
      return { role: msg.role, content: filtered }
    }).filter((msg) => {
      if (typeof msg.content === 'string' && msg.content === '[Image content removed — provider does not support it]') {
        return false
      }
      return true
    })
  }

  private stripToolBlocks(messages: Array<{ role: string; content: any }>): Array<{ role: string; content: any }> {
    return messages.map((msg) => {
      // If content is a string, keep it as-is
      if (typeof msg.content === 'string') {
        return msg
      }

      // If content is an array of blocks, filter out tool blocks
      if (Array.isArray(msg.content)) {
        const filteredBlocks = msg.content.filter((block) => {
          return block.type !== 'tool_use' && block.type !== 'tool_result'
        })

        // If all blocks were filtered out, replace with a placeholder
        if (filteredBlocks.length === 0) {
          return {
            role: msg.role,
            content: '[Tool interactions removed for provider compatibility]'
          }
        }

        return {
          role: msg.role,
          content: filteredBlocks
        }
      }

      return msg
    }).filter((msg) => {
      // Remove messages that are now empty (had only tool blocks)
      if (typeof msg.content === 'string' && msg.content === '[Tool interactions removed for provider compatibility]') {
        return false
      }
      return true
    })
  }
}
