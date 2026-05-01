import { EventEmitter } from 'events'
import { CronExpressionParser } from 'cron-parser'
import type {
  AgentConfig,
  TriggerScopeV3,
  TriggerTypeV3,
  TriggerConfig,
  TriggerTarget,
  Timer,
  TimerSchedule,
  TaskEntry,
  AdfLogEntry,
  LogLevel,
} from '../../shared/types/adf-v02.types'
import type { AdfWorkspace } from '../adf/adf-workspace'
import {
  createEvent, createDispatch,
  type AdfEvent, type AdfEventType, type AdfEventDispatch, type AdfBatchDispatch, type AnyAdfEvent,
  type FileChangeEventData,
  type LlmCallEventData,
} from '../../shared/types/adf-event.types'
import { withSource } from './execution-context'
import { emitUmbilicalEvent } from './emit-umbilical'
import { RuntimeGate } from './runtime-gate'

const TIMER_POLL_INTERVAL_MS = 5000

/** Max product of line counts before we skip diff computation to avoid perf issues. */
const DIFF_MAX_COMPLEXITY = 1_000_000

/**
 * Compute a unified diff between two strings (line-based LCS).
 * Returns empty string if texts are identical, or null if too large to diff efficiently.
 */
function computeUnifiedDiff(filePath: string, before: string, after: string): string | null {
  if (before === after) return ''

  const oldLines = before.split('\n')
  const newLines = after.split('\n')

  if (oldLines.length * newLines.length > DIFF_MAX_COMPLEXITY) return null

  // LCS via DP
  const m = oldLines.length, n = newLines.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = oldLines[i - 1] === newLines[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1])

  // Backtrack to produce edit script
  const ops: Array<[' ' | '+' | '-', string]> = []
  let i = m, j = n
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      ops.unshift([' ', oldLines[i - 1]])
      i--; j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.unshift(['+', newLines[j - 1]])
      j--
    } else {
      ops.unshift(['-', oldLines[i - 1]])
      i--
    }
  }

  // Find indices of changed lines
  const changes: number[] = []
  for (let k = 0; k < ops.length; k++) {
    if (ops[k][0] !== ' ') changes.push(k)
  }
  if (changes.length === 0) return ''

  // Group into hunks with 3 lines of context, merging overlapping regions
  const CTX = 3
  const hunks: Array<[number, number]> = []
  let hStart = Math.max(0, changes[0] - CTX)
  let hEnd = Math.min(ops.length - 1, changes[0] + CTX)

  for (let c = 1; c < changes.length; c++) {
    const cStart = Math.max(0, changes[c] - CTX)
    if (cStart <= hEnd + 1) {
      hEnd = Math.min(ops.length - 1, changes[c] + CTX)
    } else {
      hunks.push([hStart, hEnd])
      hStart = cStart
      hEnd = Math.min(ops.length - 1, changes[c] + CTX)
    }
  }
  hunks.push([hStart, hEnd])

  // Emit unified diff
  const result: string[] = [`--- a/${filePath}`, `+++ b/${filePath}`]

  for (const [start, end] of hunks) {
    // Compute old/new line numbers at hunk start
    let oldLine = 1, newLine = 1
    for (let k = 0; k < start; k++) {
      if (ops[k][0] !== '+') oldLine++
      if (ops[k][0] !== '-') newLine++
    }

    let oldCount = 0, newCount = 0
    const lines: string[] = []
    for (let k = start; k <= end; k++) {
      const [op, line] = ops[k]
      lines.push(`${op}${line}`)
      if (op !== '+') oldCount++
      if (op !== '-') newCount++
    }

    result.push(`@@ -${oldLine},${oldCount} +${newLine},${newCount} @@`)
    result.push(...lines)
  }

  return result.join('\n')
}

type DisplayState = 'active' | 'idle' | 'hibernate' | 'suspended' | 'off'

/**
 * Watches for trigger conditions and emits "trigger" events
 * when the agent should execute a turn.
 *
 * v3 target-based evaluation: each trigger type has an array of targets
 * specifying scope (system/agent), optional filter, and timing.
 *
 * Timing modifiers (mutually exclusive per target):
 *   debounce_ms — clear previous timer, set new timeout
 *   interval_ms — first event fires immediately, subsequent dropped until interval elapses
 *   batch_ms    — first event starts window, collect events, fire once when window expires
 */
export class TriggerEvaluator extends EventEmitter {
  private config: AgentConfig
  private workspace: AdfWorkspace | null = null
  private timerPollInterval: NodeJS.Timeout | null = null

  // State gating
  private displayState: DisplayState = 'idle'

  // Hibernate nudge: fires after configured interval since the last trigger while in hibernate
  private lastTriggerAt: number = Date.now()
  private lastHibernateNudge: number | null = null
  private static readonly DEFAULT_HIBERNATE_NUDGE_MS = 24 * 60 * 60 * 1000

  // Debounce timers keyed by `${triggerType}:${targetIndex}`
  private debounceTimers = new Map<string, NodeJS.Timeout>()

  // Interval trackers: last fire time keyed by `${triggerType}:${targetIndex}`
  private intervalLastFire = new Map<string, number>()

  // Batch collectors keyed by `${triggerType}:${targetIndex}`
  private batchTimers = new Map<string, NodeJS.Timeout>()
  private batchQueues = new Map<string, AnyAdfEvent[]>()

  // Inbox interval timers: delayed-fire (start timer on first event, fire at end of window)
  private inboxIntervalTimers = new Map<string, NodeJS.Timeout>()

  // File-change diff: stores the "before" content per file path for the duration of a debounce window
  private fileChangeSnapshots = new Map<string, string>()

  // File-change debounce: stores latest FileChangeEventData per debounce key for diff recomputation
  private debouncedFileContent = new Map<string, FileChangeEventData>()

  constructor(config: AgentConfig) {
    super()
    this.config = config
  }

  updateConfig(config: AgentConfig): void {
    this.config = config
  }

  /** Set workspace reference for task count queries. */
  setWorkspace(workspace: AdfWorkspace): void {
    this.workspace = workspace
  }

  getDisplayState(): string {
    return this.displayState
  }

  setDisplayState(state: string): void {
    const prev = this.displayState
    this.displayState = state as DisplayState
    // Reset nudge timer when leaving hibernate
    if (prev === 'hibernate' && state !== 'hibernate') {
      this.lastHibernateNudge = null
    }
  }

  /**
   * Start polling for expired timers. Call after agent is started.
   */
  startTimerPolling(workspace: AdfWorkspace): void {
    this.workspace = workspace
    this.stopTimerPolling()
    this.timerPollInterval = setInterval(() => {
      this.checkTimers()
      this.checkHibernateNudge()
    }, TIMER_POLL_INTERVAL_MS)
  }

  stopTimerPolling(): void {
    if (this.timerPollInterval) {
      clearInterval(this.timerPollInterval)
      this.timerPollInterval = null
    }
  }

  // ===========================================================================
  // State gating
  // ===========================================================================

  /**
   * Determine if a trigger should fire given the current display state and scope.
   *
   * System scope: fires in all states except `off`
   * Agent scope:
   *   active/idle → all triggers
   *   hibernate    → only on_timer
   *   suspended/off → nothing
   */
  private shouldFire(scope: TriggerScopeV3, triggerType: TriggerTypeV3): boolean {
    if (scope === 'system') {
      return this.displayState !== 'off'
    }
    // Agent scope
    switch (this.displayState) {
      case 'active':
      case 'idle':
        return true
      case 'hibernate':
        return triggerType === 'on_timer'
      case 'suspended':
      case 'off':
        return false
      default:
        return false
    }
  }

  // ===========================================================================
  // Timing modifiers
  // ===========================================================================

  private applyDebounce(key: string, ms: number, emitFn: () => void): void {
    const existing = this.debounceTimers.get(key)
    if (existing) clearTimeout(existing)
    this.debounceTimers.set(key, setTimeout(() => {
      this.debounceTimers.delete(key)
      emitFn()
    }, ms))
  }

  private applyInterval(key: string, ms: number, emitFn: () => void): void {
    const lastFire = this.intervalLastFire.get(key) ?? 0
    const now = Date.now()
    if (now - lastFire >= ms) {
      this.intervalLastFire.set(key, now)
      emitFn()
    }
    // else: drop the event silently
  }

  /**
   * Inbox-specific interval: first event starts a timer, fires at end of window.
   * Subsequent events during the window are absorbed.
   */
  private applyInboxInterval(key: string, ms: number, emitFn: () => void): void {
    if (this.inboxIntervalTimers.has(key)) return
    this.inboxIntervalTimers.set(key, setTimeout(() => {
      this.inboxIntervalTimers.delete(key)
      emitFn()
    }, ms))
  }

  private applyBatch(key: string, ms: number, item: AnyAdfEvent, emitFn: (items: AnyAdfEvent[]) => void, batchCount?: number): void {
    let queue = this.batchQueues.get(key)
    if (!queue) {
      queue = []
      this.batchQueues.set(key, queue)
    }
    queue.push(item)

    // Fire early if batch_count threshold reached
    if (batchCount !== undefined && queue.length >= batchCount) {
      const existing = this.batchTimers.get(key)
      if (existing) clearTimeout(existing)
      this.batchTimers.delete(key)
      const collected = this.batchQueues.get(key) ?? []
      this.batchQueues.delete(key)
      if (collected.length > 0) emitFn(collected)
      return
    }

    // Only start timer on first event in the batch window
    if (!this.batchTimers.has(key)) {
      this.batchTimers.set(key, setTimeout(() => {
        this.batchTimers.delete(key)
        const collected = this.batchQueues.get(key) ?? []
        this.batchQueues.delete(key)
        if (collected.length > 0) {
          emitFn(collected)
        }
      }, ms))
    }
  }

  // ===========================================================================
  // Filter matching
  // ===========================================================================

  /**
   * Simple glob match: supports * wildcard.
   * e.g. "document.*" matches "document.md", "document.txt"
   */
  private globMatch(pattern: string, value: string): boolean {
    const regex = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$')
    return regex.test(value)
  }

  private matchesFilter(
    triggerType: TriggerTypeV3,
    target: TriggerTarget,
    eventData: Record<string, unknown>
  ): boolean {
    const filter = target.filter
    if (!filter) return true

    switch (triggerType) {
      case 'on_inbox':
        if (typeof filter.source === 'string' && filter.source !== eventData.source) return false
        if (filter.sender && filter.sender !== eventData.sender) return false
        return true
      case 'on_outbox':
        if (filter.to && filter.to !== eventData.to) return false
        return true
      case 'on_file_change':
        if (filter.watch && !this.globMatch(filter.watch, eventData.path as string)) return false
        return true
      case 'on_tool_call':
        if (filter.tools?.length && !filter.tools.some(t => this.globMatch(t, eventData.tool as string))) return false
        return true
      case 'on_task_create':
        if (filter.tools?.length && !filter.tools.some(t => this.globMatch(t, eventData.tool as string))) return false
        return true
      case 'on_task_complete':
        if (filter.tools?.length && !filter.tools.some(t => this.globMatch(t, eventData.tool as string))) return false
        if (filter.status && filter.status !== eventData.status) return false
        return true
      case 'on_logs':
        if (filter.level?.length && !filter.level.includes(eventData.level as string)) return false
        if (filter.origin?.length && !filter.origin.some(o => this.globMatch(o, eventData.origin as string ?? ''))) return false
        if (filter.event?.length && !filter.event.some(e => this.globMatch(e, eventData.event as string ?? ''))) return false
        return true
      case 'on_llm_call':
        if (Array.isArray(filter.source) && filter.source.length && !filter.source.includes(eventData.source as string)) return false
        if (filter.provider?.length && !filter.provider.includes(eventData.provider as string)) return false
        return true
      default:
        return true
    }
  }

  // ===========================================================================
  // Inbox summary
  // ===========================================================================

  private buildInboxSummary(): string {
    if (!this.workspace) return '{ "error": "workspace unavailable" }'
    const unread = this.workspace.getInbox('unread')
    const read = this.workspace.getInbox('read')
    const archived = this.workspace.getInbox('archived')

    const unreadBySender: Record<string, number> = {}
    const unreadBySource: Record<string, number> = {}
    let oldestUnread: number | undefined
    for (const msg of unread) {
      unreadBySender[msg.from] = (unreadBySender[msg.from] ?? 0) + 1
      const src = msg.source ?? 'mesh'
      unreadBySource[src] = (unreadBySource[src] ?? 0) + 1
      if (oldestUnread === undefined || msg.received_at < oldestUnread) {
        oldestUnread = msg.received_at
      }
    }

    return JSON.stringify({
      total: unread.length + read.length + archived.length,
      unread: unread.length,
      read: read.length,
      archived: archived.length,
      unread_by_sender: unreadBySender,
      unread_by_source: unreadBySource,
      oldest_unread_timestamp: oldestUnread ?? null
    }, null, 2)
  }

  // ===========================================================================
  // Target-based evaluation
  // ===========================================================================

  private getTriggerConfig(triggerType: TriggerTypeV3): TriggerConfig | undefined {
    return this.config.triggers?.[triggerType]
  }

  private emitTriggerFired(triggerType: TriggerTypeV3, target: TriggerTarget): void {
    const agentId = this.config.id
    withSource(`system:trigger:${triggerType}`, agentId, () => {
      emitUmbilicalEvent({
        event_type: 'trigger.fired',
        payload: { trigger_type: triggerType, scope: target.scope, target_lambda: target.lambda ?? null }
      })
    })
  }

  /**
   * Evaluate all targets for a trigger type and emit dispatches for matching ones.
   *
   * One event, N dispatches: the event is created once by the caller. Each matching
   * target produces an AdfEventDispatch wrapping the same event with target routing.
   */
  private evaluateTargets<T extends AdfEventType>(
    triggerType: TriggerTypeV3,
    event: AdfEvent<T>,
    filterData: Record<string, unknown> = {},
    skipSystemScope?: boolean
  ): void {
    const cfg = this.getTriggerConfig(triggerType)
    if (!cfg?.enabled) return

    const targets = cfg.targets ?? []
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i]
      if (skipSystemScope && target.scope === 'system') continue
      if (!this.shouldFire(target.scope, triggerType)) continue
      if (!this.matchesFilter(triggerType, target, filterData)) continue

      const key = `${triggerType}:${i}`
      const isInbox = triggerType === 'on_inbox'
      const isFileChange = triggerType === 'on_file_change'

      const doEmit = () => {
        this.lastTriggerAt = Date.now()
        // Agent-scope inbox: skip if all messages already handled by system-scope lambda
        if (isInbox && target.scope === 'agent') {
          const unreadCount = this.workspace?.getUnreadCount() ?? 0
          if (unreadCount === 0) return
        }
        this.emitTriggerFired(triggerType, target)
        this.emit('trigger', createDispatch(event, target))
      }

      if (target.debounce_ms) {
        if (isFileChange && event.type === 'file_change') {
          // File-change debounce: recompute diff from snapshot when debounce fires
          const filePath = (event.data as FileChangeEventData).path
          // Store latest event content for diff recomputation
          this.debouncedFileContent.set(`${key}:${filePath}`, (event.data as FileChangeEventData))
          this.applyDebounce(key, target.debounce_ms, () => {
            const latestData = this.debouncedFileContent.get(`${key}:${filePath}`)
            this.debouncedFileContent.delete(`${key}:${filePath}`)
            const snapshot = this.fileChangeSnapshots.get(filePath)
            this.fileChangeSnapshots.delete(filePath)

            // Get current file content for diff
            const currentContent = this.workspace?.readFile(filePath)
            if (snapshot !== undefined && currentContent !== undefined) {
              const diff = computeUnifiedDiff(filePath, snapshot, currentContent)
              // Create updated event with recomputed diff
              const meta = this.workspace?.getFileMeta(filePath)
              const updatedEvent = createEvent({
                type: 'file_change' as const,
                source: event.source,
                data: {
                  path: filePath,
                  mime_type: meta?.mime_type ?? latestData?.mime_type ?? null,
                  size: meta?.size ?? latestData?.size ?? 0,
                  protection: meta?.protection ?? latestData?.protection ?? 'none',
                  authorized: meta?.authorized ?? latestData?.authorized ?? false,
                  created_at: meta?.created_at ?? latestData?.created_at ?? '',
                  updated_at: meta?.updated_at ?? latestData?.updated_at ?? '',
                  operation: latestData?.operation ?? 'modified',
                  diff,
                },
              })
              this.lastTriggerAt = Date.now()
              this.emitTriggerFired(triggerType, target)
              this.emit('trigger', createDispatch(updatedEvent, target))
            } else {
              doEmit()
            }
          })
        } else {
          this.applyDebounce(key, target.debounce_ms, doEmit)
        }
      } else if (target.interval_ms) {
        if (isInbox) {
          this.applyInboxInterval(key, target.interval_ms, doEmit)
        } else {
          this.applyInterval(key, target.interval_ms, doEmit)
        }
      } else if (target.batch_ms) {
        this.applyBatch(key, target.batch_ms, event as AnyAdfEvent, (items) => {
          this.lastTriggerAt = Date.now()
          // Agent-scope inbox batch: skip if all handled
          if (isInbox && target.scope === 'agent') {
            const unreadCount = this.workspace?.getUnreadCount() ?? 0
            if (unreadCount === 0) return
          }
          if (items.length === 1) {
            this.emitTriggerFired(triggerType, target)
            this.emit('trigger', createDispatch(items[0], target))
          } else {
            this.emitTriggerFired(triggerType, target)
            this.emit('trigger', {
              events: items,
              count: items.length,
              scope: target.scope,
              lambda: target.lambda,
              command: target.command,
              warm: target.warm,
            } satisfies AdfBatchDispatch)
          }
        }, target.batch_count)
      } else {
        doEmit()
      }
    }
  }

  // ===========================================================================
  // Public trigger methods
  // ===========================================================================

  onFileChange(path: string, operation: string, content?: string, previousContent?: string): void {
    // Capture snapshot on first change in a debounce window
    if (previousContent !== undefined && !this.fileChangeSnapshots.has(path)) {
      this.fileChangeSnapshots.set(path, previousContent)
    }

    // Build FileChangeEventData from file metadata
    const meta = this.workspace?.getFileMeta(path)
    let diff: string | null = null
    if (previousContent !== undefined && content !== undefined) {
      diff = computeUnifiedDiff(path, previousContent, content)
    }

    const event = createEvent({
      type: 'file_change' as const,
      source: `agent:${this.config.name ?? 'unknown'}`,
      data: {
        path,
        mime_type: meta?.mime_type ?? null,
        size: meta?.size ?? content?.length ?? 0,
        protection: meta?.protection ?? 'none',
        authorized: meta?.authorized ?? false,
        created_at: meta?.created_at ?? '',
        updated_at: meta?.updated_at ?? '',
        operation: operation as 'created' | 'modified' | 'deleted',
        diff,
      },
    })
    this.evaluateTargets('on_file_change', event, { path })
  }

  onChat(userMessage?: string): void {
    const event = createEvent({
      type: 'chat' as const,
      source: 'system',
      data: {
        message: {
          seq: 0,
          role: 'user' as const,
          content_json: [{ type: 'text', text: userMessage ?? '' }],
          created_at: Date.now(),
        },
      },
    })
    this.evaluateTargets('on_chat', event)
  }

  onInbox(sender: string, message: string, opts?: {
    mentioned?: boolean
    source?: string
    messageId?: string
    parentId?: string
    threadId?: string
    sourceMeta?: Record<string, unknown>
  }): void {
    // Look up full InboxMessage row when messageId available
    const inboxRow = opts?.messageId ? this.workspace?.getInboxMessageById(opts.messageId) : null
    const source = opts?.source ?? 'mesh'

    const event = createEvent({
      type: 'inbox' as const,
      source: `adapter:${source}`,
      data: {
        message: inboxRow ?? {
          // Construct minimal InboxMessage from available params
          id: opts?.messageId ?? '',
          from: sender,
          content: message,
          parent_id: opts?.parentId,
          thread_id: opts?.threadId,
          source,
          source_context: opts?.sourceMeta,
          received_at: Date.now(),
          status: 'unread' as const,
        },
      },
    })
    this.evaluateTargets('on_inbox', event, { sender, source })
  }

  onOutbox(recipient: string, message: string): void {
    const event = createEvent({
      type: 'outbox' as const,
      source: `agent:${this.config.name ?? 'unknown'}`,
      data: {
        message: {
          id: '',
          from: this.config.name ?? 'unknown',
          to: recipient,
          content: message,
          created_at: Date.now(),
          status: 'pending' as const,
        },
      },
    })
    this.evaluateTargets('on_outbox', event, { to: recipient })
  }

  onToolCall(tool: string, args: string, taskId: string, origin?: string, skipSystemScope?: boolean): void {
    let parsedArgs: Record<string, unknown> = {}
    try { parsedArgs = JSON.parse(args) } catch { /* keep empty */ }

    const event = createEvent({
      type: 'tool_call' as const,
      source: `agent:${this.config.name ?? 'unknown'}`,
      data: { toolName: tool, args: parsedArgs, origin: origin ?? 'agent' },
    })
    this.evaluateTargets('on_tool_call', event, { tool }, skipSystemScope)
  }

  onTaskCreate(task: TaskEntry): void {
    const event = createEvent({
      type: 'task_create' as const,
      source: `agent:${this.config.name ?? 'unknown'}`,
      data: { task },
    })
    this.evaluateTargets('on_task_create', event, { tool: task.tool })
  }

  onTaskComplete(taskId: string, tool: string, status: string, result?: string, error?: string): void {
    // Look up full TaskEntry row
    const taskRow = this.workspace?.getTask(taskId)
    const event = createEvent({
      type: 'task_complete' as const,
      source: `agent:${this.config.name ?? 'unknown'}`,
      data: {
        task: taskRow ?? {
          id: taskId,
          tool,
          args: '{}',
          status: status as any,
          result,
          error,
          created_at: Date.now(),
        },
      },
    })
    this.evaluateTargets('on_task_complete', event, { tool, status })
  }

  onLog(level: string, origin: string | null, event: string | null, target: string | null, message: string): void {
    const logEvent = createEvent({
      type: 'log_entry' as const,
      source: `agent:${this.config.name ?? 'unknown'}`,
      data: {
        entry: {
          id: 0,
          level: level as LogLevel,
          origin,
          event,
          target,
          message,
          data: null,
          created_at: Date.now(),
        } satisfies AdfLogEntry,
      },
    })
    this.evaluateTargets('on_logs', logEvent, { level, origin: origin ?? '', event: event ?? '' })
  }

  onLlmCall(data: LlmCallEventData): void {
    const event = createEvent({
      type: 'llm_call' as const,
      source: `agent:${this.config.name ?? 'unknown'}`,
      data,
    })
    this.evaluateTargets('on_llm_call', event, { source: data.source, provider: data.provider })
  }

  onStartup(): void {
    const event = createEvent({
      type: 'startup' as const,
      source: `agent:${this.config.name ?? 'unknown'}`,
      data: undefined,
    })
    this.evaluateTargets('on_startup', event)
  }

  /** @deprecated Use onFileChange('document.md', 'modified', content, previousContent) */
  onDocumentEdit(newContent: string, previousContent?: string): void {
    this.onFileChange('document.md', 'modified', newContent, previousContent)
  }

  // ===========================================================================
  // Timer polling
  // ===========================================================================

  private calculateNextWake(schedule: TimerSchedule, now: number): number | null {
    switch (schedule.mode) {
      case 'once':
        return schedule.at
      case 'interval':
        return now + schedule.every_ms
      case 'cron': {
        try {
          const interval = CronExpressionParser.parse(schedule.cron, { currentDate: new Date(now) })
          return interval.next().getTime()
        } catch {
          return null
        }
      }
    }
  }

  private checkTimers(): void {
    if (RuntimeGate.stopped) return
    if (!this.workspace) return

    let expired: Timer[]
    try {
      expired = this.workspace.getExpiredTimers()
    } catch {
      // Database may have been closed before the interval was cleared
      return
    }
    if (expired.length === 0) return

    // Delete all expired timers first
    try {
      this.workspace.deleteTimers(expired.map(t => t.id))
    } catch (error) {
      console.error('[TriggerEvaluator] Failed to delete expired timers:', error)
      try {
        this.workspace.insertLog(
          'error', 'timer', 'delete_expired_failed', null,
          `Failed to delete expired timers: ${error instanceof Error ? error.message : String(error)}`,
          { timer_ids: expired.map(t => t.id) }
        )
      } catch { /* database may be unavailable */ }
      return
    }

    const now = Date.now()

    const timerAgentId = this.config.id
    for (const timer of expired) {
      // on_timer trigger config is a gate, not a router.
      // The timer owns what runs. The trigger controls whether it's allowed.
      const cfg = this.getTriggerConfig('on_timer')
      if (!cfg?.enabled) continue

      const targets = cfg.targets ?? []

      // Create one event per timer, dispatch per scope
      const timerWithUpdatedCount = { ...timer, run_count: timer.run_count + 1, last_fired_at: now }
      const event = createEvent({
        type: 'timer' as const,
        source: `agent:${this.config.name ?? 'unknown'}`,
        data: { timer: timerWithUpdatedCount },
      })

      // Process each scope in the timer's scope array
      for (const scope of timer.scope) {
        // Check gate: does on_timer.targets include a target with this scope?
        const gateTarget = targets.find(t => t.scope === scope)
        if (!gateTarget) continue
        if (!this.shouldFire(scope, 'on_timer')) continue

        withSource('system:timer', timerAgentId, () => {
          emitUmbilicalEvent({
            event_type: 'timer.fired',
            payload: {
              timer_id: timer.id,
              scope,
              run_count: timer.run_count + 1,
              scheduled_at: timer.next_wake_at,
            }
          })
          if (scope === 'system') {
            // System scope: execute lambda if present, log to adf_logs
            if (timer.lambda) {
              this.lastTriggerAt = now
              try {
                this.workspace?.insertLog(
                  'info', 'timer', 'on_timer', timer.lambda,
                  `System timer #${timer.id} fired → lambda ${timer.lambda}`,
                  { timer_id: timer.id, payload: timer.payload, run_count: timer.run_count + 1 }
                )
              } catch { /* best-effort logging */ }
              this.emit('trigger', createDispatch(event, {
                scope: 'system',
                lambda: timer.lambda,
                command: undefined,
                warm: timer.warm,
              }))
            } else {
              // No lambda to call — log skip
              try {
                this.workspace?.insertLog(
                  'info', 'timer', 'on_timer', null,
                  `System timer #${timer.id} fired but no lambda — skipped`,
                  { timer_id: timer.id, payload: timer.payload }
                )
              } catch { /* best-effort logging */ }
            }
          } else {
            // Agent scope: wake the LLM loop
            this.lastTriggerAt = now
            this.emit('trigger', createDispatch(event, { scope: 'agent' }))
          }
        })
      }

      // Recurring lifecycle
      if (timer.schedule.mode !== 'once') {
        const newRunCount = timer.run_count + 1

        // Check max_runs
        const maxRuns = timer.schedule.mode === 'interval'
          ? timer.schedule.max_runs
          : timer.schedule.max_runs
        if (maxRuns !== undefined && newRunCount >= maxRuns) continue

        // Calculate next wake
        const nextWake = this.calculateNextWake(timer.schedule, now)
        if (nextWake === null) continue

        // Check end_at
        const endAt = timer.schedule.mode === 'interval'
          ? timer.schedule.end_at
          : timer.schedule.end_at
        if (endAt !== undefined && nextWake > endAt) continue

        // Recreate timer with carried-over state
        try {
          this.workspace.renewTimer(
            timer.schedule, nextWake, timer.payload, timer.scope,
            timer.lambda, timer.warm, newRunCount, timer.created_at, now, timer.locked
          )
        } catch (error) {
          console.error(`[TriggerEvaluator] Failed to renew timer #${timer.id}:`, error)
          try {
            this.workspace.insertLog(
              'error', 'timer', 'renew_failed', null,
              `Failed to renew timer #${timer.id}: ${error instanceof Error ? error.message : String(error)}`,
              { timer_id: timer.id }
            )
          } catch { /* database may be unavailable */ }
        }
      }
    }
  }

  // ===========================================================================
  // Hibernate nudge
  // ===========================================================================

  private checkHibernateNudge(): void {
    if (RuntimeGate.stopped) return
    if (this.displayState !== 'hibernate') return

    const nudgeCfg = this.config.limits?.hibernate_nudge
    // Default: enabled with 24h interval
    const enabled = nudgeCfg?.enabled ?? true
    if (!enabled) return

    const cfg = this.getTriggerConfig('on_timer')
    if (!cfg?.enabled) return

    const intervalMs = nudgeCfg?.interval_ms ?? TriggerEvaluator.DEFAULT_HIBERNATE_NUDGE_MS
    const now = Date.now()
    // Fire after configured interval since last trigger or last nudge
    const lastActivity = this.lastHibernateNudge ?? this.lastTriggerAt
    if (now - lastActivity < intervalMs) return

    this.lastHibernateNudge = now

    const hours = Math.round((now - this.lastTriggerAt) / (60 * 60 * 1000))

    this.lastTriggerAt = now
    const nudgeEvent = createEvent({
      type: 'timer' as const,
      source: 'system',
      data: {
        timer: {
          id: -1,
          schedule: { mode: 'interval' as const, every_ms: intervalMs },
          next_wake_at: 0,
          payload: `[System] You have been hibernating for ${hours} hour${hours !== 1 ? 's' : ''} without any triggers. If this is intended, call sys_set_state('hibernate') to confirm. Otherwise, take action or set a timer.`,
          scope: ['agent'],
          run_count: 0,
          created_at: now,
        },
      },
    })
    this.emit('trigger', createDispatch(nudgeEvent, { scope: 'agent' }))
  }

  // ===========================================================================
  // Cleanup
  // ===========================================================================

  dispose(): void {
    // Clear debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer)
    }
    this.debounceTimers.clear()

    // Clear interval trackers
    this.intervalLastFire.clear()

    // Clear inbox interval timers
    for (const timer of this.inboxIntervalTimers.values()) {
      clearTimeout(timer)
    }
    this.inboxIntervalTimers.clear()

    // Clear batch timers and queues
    for (const timer of this.batchTimers.values()) {
      clearTimeout(timer)
    }
    this.batchTimers.clear()
    this.batchQueues.clear()

    // Clear file-change diff snapshots
    this.fileChangeSnapshots.clear()
    this.debouncedFileContent.clear()

    // Stop timer polling and release workspace reference
    this.stopTimerPolling()
    this.workspace = null
    this.removeAllListeners()
  }
}
