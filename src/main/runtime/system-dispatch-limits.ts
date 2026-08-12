import type { AdfBatchDispatch, AdfEventDispatch } from '../../shared/types/adf-event.types'
import { TRIGGER_TO_EVENT_TYPE } from '../../shared/types/adf-event.types'
import type { TriggerTypeV3 } from '../../shared/types/adf-v02.types'

/**
 * Execution ceiling and concurrency for a system-scope dispatch, derived from
 * the trigger type alone. Nothing here is configurable: a trigger's shape is a
 * property of the trigger, not of the agent that wired it, and every knob we
 * could expose would be writable by the agent the limit exists to bound.
 */
export interface DispatchLimits {
  /** Hard ceiling for one dispatch, or null to use `limits.execution_timeout_ms`. */
  ceiling_ms: number | null
  /** In-flight dispatches allowed per lane (see `SystemDispatchQueue.keyFor`). */
  max_concurrent: number
}

/**
 * Ceiling for triggers that fire once per event on a hot path. These lambdas
 * are short by construction — the corpus max outside a known drain-loop bug is
 * well under a second — so 30 s is a hang detector, not a work budget.
 */
export const HIGH_FREQUENCY_CEILING_MS = 30_000

/** In-flight dispatches allowed for a work-shaped trigger. */
export const WORK_MAX_CONCURRENT = 4

/** Waiting dispatches held per lane before new ones are dropped. */
export const MAX_QUEUE_DEPTH = 64

/**
 * Two families, split by what the trigger *is*:
 *
 *  - High-frequency, per-event (`on_llm_call`, `on_tool_call`, `on_logs`,
 *    `on_file_change`). One dispatch per model call / tool call / log row /
 *    file write, so a single burst can fan out hundreds. They are short, and
 *    they are usually accumulators doing read-modify-write against the same
 *    workspace rows — serializing them (`max_concurrent: 1`) makes that
 *    correct and simultaneously puts the tightest possible bound on worker
 *    count. 30 s catches a hang without touching real work.
 *
 *  - Work-shaped (everything else). A timer, a startup hook, an inbox handler
 *    or a task callback is a unit of work the user asked for; it may
 *    legitimately run for minutes. These keep today's behaviour exactly —
 *    the ceiling is `limits.execution_timeout_ms` — with a modest concurrency
 *    cap so a backlog cannot fan out without bound.
 */
export const TRIGGER_DISPATCH_LIMITS: Record<TriggerTypeV3, DispatchLimits> = {
  on_llm_call:     { ceiling_ms: HIGH_FREQUENCY_CEILING_MS, max_concurrent: 1 },
  on_tool_call:    { ceiling_ms: HIGH_FREQUENCY_CEILING_MS, max_concurrent: 1 },
  on_logs:         { ceiling_ms: HIGH_FREQUENCY_CEILING_MS, max_concurrent: 1 },
  on_file_change:  { ceiling_ms: HIGH_FREQUENCY_CEILING_MS, max_concurrent: 1 },
  on_timer:        { ceiling_ms: null, max_concurrent: WORK_MAX_CONCURRENT },
  on_startup:      { ceiling_ms: null, max_concurrent: WORK_MAX_CONCURRENT },
  on_inbox:        { ceiling_ms: null, max_concurrent: WORK_MAX_CONCURRENT },
  on_task_create:  { ceiling_ms: null, max_concurrent: WORK_MAX_CONCURRENT },
  on_task_complete:{ ceiling_ms: null, max_concurrent: WORK_MAX_CONCURRENT },
  on_outbox:       { ceiling_ms: null, max_concurrent: WORK_MAX_CONCURRENT },
  on_chat:         { ceiling_ms: null, max_concurrent: WORK_MAX_CONCURRENT },
}

/** Applied when an event type maps to no known trigger — treated as work. */
export const DEFAULT_DISPATCH_LIMITS: DispatchLimits = { ceiling_ms: null, max_concurrent: WORK_MAX_CONCURRENT }

/** Trigger name behind an event type, e.g. 'log_entry' → 'on_logs'. */
export function triggerNameForEventType(eventType: string | undefined): TriggerTypeV3 | null {
  if (!eventType) return null
  const entry = Object.entries(TRIGGER_TO_EVENT_TYPE).find(([, v]) => v === eventType)
  return entry ? (entry[0] as TriggerTypeV3) : null
}

/** Limits for the trigger this dispatch came from. */
export function limitsForDispatch(dispatch: AdfEventDispatch | AdfBatchDispatch): DispatchLimits {
  const eventType = 'event' in dispatch ? dispatch.event.type : dispatch.events[0]?.type
  const trigger = triggerNameForEventType(eventType)
  return trigger ? TRIGGER_DISPATCH_LIMITS[trigger] : DEFAULT_DISPATCH_LIMITS
}

/**
 * Effective execution budget for a lambda dispatch: `min(type ceiling, agent
 * limit)`. A work-shaped trigger has no ceiling of its own, so it gets exactly
 * what it got before this existed — `limits.execution_timeout_ms`, or
 * `undefined` when the agent sets none.
 *
 * Shell dispatches (`command`, or a `.sh` lambda) never reach here: the shell
 * runner takes no deadline, so they are exempt from the ceiling by
 * construction. They are still lane-limited — the queue keys on the command
 * string — so the concurrency half of the table applies to them unchanged.
 */
export function dispatchTimeoutMs(
  dispatch: AdfEventDispatch | AdfBatchDispatch,
  agentTimeoutMs: number | undefined,
): number | undefined {
  const ceiling = limitsForDispatch(dispatch).ceiling_ms
  if (ceiling === null) return agentTimeoutMs
  return agentTimeoutMs !== undefined ? Math.min(ceiling, agentTimeoutMs) : ceiling
}

/**
 * Raised at the caller when backpressure discards a dispatch. Overflow used to
 * resolve, which is indistinguishable from a dispatch that ran: the host wires
 * `dispatch(...).catch(onTriggerError)`, so a resolved drop was reported to
 * nobody.
 */
export class SystemDispatchDroppedError extends Error {
  constructor(
    readonly trigger: string,
    readonly target: string | null,
    readonly queued: number,
    readonly running: number,
  ) {
    super(`Backpressure: dropped ${trigger} dispatch for ${target ?? 'target'} — ${queued} already queued, ${running} running`)
    this.name = 'SystemDispatchDroppedError'
  }
}

/**
 * Compensation to run if a dispatch is dropped before it ever executes.
 *
 * Producers that consume state when they emit — the timer tick settles the
 * timer row before emitting, so a `once` timer is spent the moment it fires —
 * register the undo here. Keyed on the dispatch object itself so nothing is
 * added to the dispatch's public shape and nothing outlives it.
 */
const dropCompensations = new WeakMap<object, () => void>()

/** Register the undo for `dispatch`. Called at most once, only on a drop. */
export function onDispatchDropped(dispatch: AdfEventDispatch | AdfBatchDispatch, undo: () => void): void {
  dropCompensations.set(dispatch, undo)
}

type LogFn = (level: string, event: string | null, target: string | null, message: string, data?: unknown) => void

interface Waiter {
  /** Start the held dispatch — settles the promise its caller is awaiting. */
  start: () => void
  /** Release the held dispatch without running it (teardown). */
  drop: () => void
}

interface Lane {
  active: number
  limit: number
  queue: Waiter[]
}

/**
 * Backpressure for system-scope dispatches.
 *
 * A trigger like `on_llm_call` fires once per LLM call, so a burst of parallel
 * model_invoke calls fans out one sandbox worker per event. Lanes bound that:
 * at most `max_concurrent` dispatches in a lane run at once, the rest queue,
 * and overflow is dropped loudly.
 *
 * Lane identity is trigger type + executable — the lambda path (with function
 * name) or the command string. It is deliberately NOT per trigger target and
 * not per timer row: TickerPulse points six timers at `lib/poller.ts:pollFeed`,
 * and those six share a lane on purpose, because the limit exists to bound
 * workers running one piece of code and to serialize its read-modify-write
 * against the same workspace rows. Two different lambdas never throttle each
 * other; the same lambda under two different triggers gets two lanes, since the
 * ceiling and concurrency it runs under come from the trigger type.
 *
 * Only system-scope dispatches ever reach here; agent turns (chat, inbox) run
 * on their own path and are never held or dropped by this queue.
 */
export class SystemDispatchQueue {
  private lanes = new Map<string, Lane>()

  constructor(private log: LogFn) {}

  /** Lane key: trigger type + the executable it routes to. */
  static keyFor(dispatch: AdfEventDispatch | AdfBatchDispatch): string {
    const eventType = 'event' in dispatch ? dispatch.event.type : dispatch.events[0]?.type
    const trigger = triggerNameForEventType(eventType) ?? eventType ?? 'unknown'
    return `${trigger}:${dispatch.lambda ?? dispatch.command ?? '(none)'}`
  }

  /**
   * Run `task` under this dispatch's lane. Resolves when the task completes,
   * rejects with `SystemDispatchDroppedError` when the lane's queue is full.
   */
  run(dispatch: AdfEventDispatch | AdfBatchDispatch, task: () => Promise<unknown>): Promise<void> {
    const key = SystemDispatchQueue.keyFor(dispatch)
    const limit = limitsForDispatch(dispatch).max_concurrent

    let lane = this.lanes.get(key)
    if (!lane) {
      lane = { active: 0, limit, queue: [] }
      this.lanes.set(key, lane)
    } else {
      lane.limit = limit
    }

    if (lane.active < lane.limit) return this.start(key, lane, task)

    if (lane.queue.length >= MAX_QUEUE_DEPTH) return Promise.reject(this.drop(dispatch, lane))

    const held = lane
    return new Promise<void>((resolve, reject) => {
      held.queue.push({
        start: () => { this.start(key, held, task).then(resolve, reject) },
        drop: () => { resolve() },
      })
    })
  }

  /** Discard everything still waiting. Called on teardown — a queued dispatch
   *  must never outlive the agent that scheduled it. */
  clear(): void {
    for (const lane of this.lanes.values()) {
      const waiting = lane.queue.splice(0)
      for (const waiter of waiting) waiter.drop()
    }
    this.lanes.clear()
  }

  /** Depth of the lane a dispatch would land in (waiting, not running). */
  pendingFor(dispatch: AdfEventDispatch | AdfBatchDispatch): number {
    return this.lanes.get(SystemDispatchQueue.keyFor(dispatch))?.queue.length ?? 0
  }

  private start(key: string, lane: Lane, task: () => Promise<unknown>): Promise<void> {
    lane.active++
    return (async () => {
      try {
        await task()
      } finally {
        this.release(key, lane)
      }
    })()
  }

  private release(key: string, lane: Lane): void {
    lane.active--
    const next = lane.queue.shift()
    if (next) {
      next.start()
      return
    }
    if (lane.active <= 0 && lane.queue.length === 0) this.lanes.delete(key)
  }

  /**
   * Undo whatever the producer already committed, name the drop in adf_logs,
   * and build the error the caller is rejected with.
   *
   * Logged at `error`, not `warn`: an agent with `logging.default_level:
   * 'error'` would never see a warn row, and losing a dispatch is exactly the
   * kind of thing that agent still needs to be told about.
   */
  private drop(dispatch: AdfEventDispatch | AdfBatchDispatch, lane: Lane): SystemDispatchDroppedError {
    const key = SystemDispatchQueue.keyFor(dispatch)
    const trigger = key.slice(0, key.indexOf(':'))
    const target = dispatch.lambda ?? dispatch.command ?? null

    const undo = dropCompensations.get(dispatch)
    if (undo) {
      dropCompensations.delete(dispatch)
      try { undo() } catch { /* compensation is best-effort; the drop still stands */ }
    }

    const error = new SystemDispatchDroppedError(trigger, target, lane.queue.length, lane.active)
    this.log(
      'error', trigger, target,
      `${error.message} (max_concurrent=${lane.limit})`,
      { trigger, target, queued: lane.queue.length, running: lane.active, max_concurrent: lane.limit, max_queue_depth: MAX_QUEUE_DEPTH }
    )
    return error
  }
}
