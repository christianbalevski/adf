/**
 * Trigger-type-derived limits and drop semantics for system-scope dispatches.
 *
 * The incident: on_llm_call pointed at a cold system lambda fired once per
 * model_invoke, so a parallel ingest burst fanned out one sandbox worker per
 * event, each holding the agent-wide execution budget. The fix is a runtime
 * constant table keyed on trigger type — nothing configurable, nothing the
 * agent can raise — plus a bounded queue whose overflow is loud.
 *
 * Two families are asserted here. Per-event hot paths (on_llm_call and
 * friends) run serialized under a 30 s hang detector. Work-shaped triggers
 * (on_timer, on_inbox, ...) keep exactly the budget they had before any of
 * this existed: `limits.execution_timeout_ms`. The second half is a permanent
 * regression guard — a real agent's on_timer lambda ran 44–55 s successfully,
 * and a flat 30 s default would have killed every one of those runs.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AgentExecutor } from '../../../src/main/runtime/agent-executor'
import {
  SystemDispatchQueue,
  SystemDispatchDroppedError,
  TRIGGER_DISPATCH_LIMITS,
  HIGH_FREQUENCY_CEILING_MS,
  WORK_MAX_CONCURRENT,
  MAX_QUEUE_DEPTH,
  dispatchTimeoutMs,
  limitsForDispatch,
  onDispatchDropped,
} from '../../../src/main/runtime/system-dispatch-limits'
import { SystemScopeHandler } from '../../../src/main/runtime/system-scope-handler'
import { TriggerEvaluator } from '../../../src/main/runtime/trigger-evaluator'
import { TriggersConfigV3Schema } from '../../../src/main/adf/adf-schema'
import { TRIGGER_TYPES_V3 } from '../../../src/shared/types/adf-v02.types'
import { clearAllUmbilicalBuses, ensureUmbilicalBus } from '../../../src/main/runtime/umbilical-bus'
import type { UmbilicalEvent } from '../../../src/main/runtime/umbilical-bus'
import type { AdfEventDispatch, AdfBatchDispatch } from '../../../src/shared/types/adf-event.types'
import type { AgentConfig, Timer } from '../../../src/shared/types/adf-v02.types'

// --------------------------------------------------------------------------
// Fixtures
// --------------------------------------------------------------------------

type LogRow = [string, string, string | null, string | null, string, unknown]

/** A system dispatch for an arbitrary event type — the trigger the table keys on. */
function sysDispatch(eventType: string, lambda: string, over: Partial<AdfEventDispatch> = {}): AdfEventDispatch {
  return {
    event: {
      id: `evt_${Math.random().toString(36).slice(2)}`,
      type: eventType,
      source: 'agent:agent-1',
      time: new Date().toISOString(),
      data: {},
    },
    scope: 'system',
    lambda,
    ...over,
  } as unknown as AdfEventDispatch
}

const llmDispatch = (lambda: string): AdfEventDispatch => sysDispatch('llm_call', lambda)
const timerDispatch = (lambda: string): AdfEventDispatch => sysDispatch('timer', lambda)

function chatDispatch(): AdfEventDispatch {
  return {
    event: {
      id: 'evt_chat',
      type: 'chat',
      source: 'system',
      time: new Date().toISOString(),
      data: { message: { seq: 0, role: 'user', content_json: [{ type: 'text', text: 'hi' }], created_at: Date.now() } },
    },
    scope: 'agent',
  } as AdfEventDispatch
}

/** Records concurrency and lets the test decide when each execution finishes. */
class FakeSystemScopeHandler {
  active = 0
  peak = 0
  started: string[] = []
  private releases: Array<() => void> = []

  execute = (dispatch: AdfEventDispatch): Promise<string | undefined> => {
    this.active++
    this.peak = Math.max(this.peak, this.active)
    this.started.push(dispatch.lambda ?? '(none)')
    return new Promise<string | undefined>((resolve) => {
      this.releases.push(() => { this.active--; resolve(undefined) })
    })
  }

  executeBatch = this.execute as never

  releaseOne(): void { this.releases.shift()?.() }
  releaseAll(): void { for (const r of this.releases.splice(0)) r() }
}

function makeExecutor() {
  const logs: LogRow[] = []
  const workspace = {
    insertLog: (...row: LogRow) => { logs.push(row) },
    getFilePath: () => '/tmp/test.adf',
    insertTask: () => {},
    updateTaskStatus: () => {},
    getTask: () => null,
  }
  const session = { getWorkspace: () => workspace } as never
  const config = { name: 'agent-1', id: 'agent-1', tools: [], triggers: {}, limits: {} } as unknown as AgentConfig
  const executor = new AgentExecutor(config, {} as never, { executeTool: vi.fn() } as never, session)
  const handler = new FakeSystemScopeHandler()
  executor.setSystemScopeHandler(handler as never)
  return { executor, handler, logs }
}

/** SystemScopeHandler wired to a stub sandbox so the timeout argument is observable. */
function makeLambdaHandler(limits: Record<string, unknown> = {}) {
  const execute = vi.fn(async () => ({ result: 'ok', stdout: '', error: undefined }))
  const workspace = {
    readFile: () => 'function run(e) { return 1 }',
    isFileAuthorized: () => false,
    getAgentConfig: () => ({ limits } as unknown as AgentConfig),
    insertLog: () => {},
  }
  const sandbox = { execute, destroy: vi.fn() }
  const callHandler = {
    setAuthorizationContext: () => {},
    getAuthorizationContext: () => false,
    getEnabledToolNames: () => [],
    getHilToolNames: () => [],
    handleCall: async () => ({}),
  }
  const handler = new SystemScopeHandler(workspace as never, sandbox as never, callHandler as never, 'agent-1')
  return { handler, execute }
}

/** Let queued promise chains advance. */
const settle = async (): Promise<void> => { for (let i = 0; i < 10; i++) await Promise.resolve() }

// --------------------------------------------------------------------------
// The type table
// --------------------------------------------------------------------------

describe('trigger dispatch limits table', () => {
  it('covers every v3 trigger type', () => {
    for (const trigger of TRIGGER_TYPES_V3) {
      expect(TRIGGER_DISPATCH_LIMITS[trigger], trigger).toBeDefined()
    }
    expect(Object.keys(TRIGGER_DISPATCH_LIMITS).sort()).toEqual([...TRIGGER_TYPES_V3].sort())
  })

  it('splits per-event hot paths from work-shaped triggers', () => {
    for (const trigger of ['on_llm_call', 'on_tool_call', 'on_logs', 'on_file_change'] as const) {
      expect(TRIGGER_DISPATCH_LIMITS[trigger], trigger).toEqual({ ceiling_ms: HIGH_FREQUENCY_CEILING_MS, max_concurrent: 1 })
    }
    for (const trigger of ['on_timer', 'on_startup', 'on_inbox', 'on_task_create', 'on_task_complete', 'on_outbox', 'on_chat'] as const) {
      expect(TRIGGER_DISPATCH_LIMITS[trigger], trigger).toEqual({ ceiling_ms: null, max_concurrent: WORK_MAX_CONCURRENT })
    }
    expect(HIGH_FREQUENCY_CEILING_MS).toBe(30_000)
  })

  it('resolves limits from the event type, not from the dispatch', () => {
    expect(limitsForDispatch(llmDispatch('lib/a.js:run')).max_concurrent).toBe(1)
    expect(limitsForDispatch(timerDispatch('lib/a.js:run')).max_concurrent).toBe(WORK_MAX_CONCURRENT)
    // Unknown event types fall back to the work-shaped profile.
    expect(limitsForDispatch(sysDispatch('mystery', 'lib/a.js:run')).ceiling_ms).toBeNull()
  })
})

describe('effective lambda timeout', () => {
  /**
   * REGRESSION GUARD — observed on a real-world agent:
   * limits.execution_timeout_ms = 60000; its on_timer lambda
   * automation/self-reflect.js:run has four SUCCESSFUL runs in its own adf_logs
   * at 49437 ms, 54151 ms, 44230 ms and 47935 ms. A flat 30 s default for
   * system lambdas killed every one of them, and the only knob reachable from
   * config was the shared on_timer gate target. A work-shaped trigger must
   * always get the agent budget.
   */
  it('gives an on_timer lambda the agent execution budget, not 30s', async () => {
    const { handler, execute } = makeLambdaHandler({ execution_timeout_ms: 60_000 })
    await handler.execute(timerDispatch('automation/self-reflect.js:run'))

    expect(execute.mock.calls[0][2]).toBe(60_000)
    for (const observed of [49_437.79, 54_151.09, 44_230.1, 47_935.03]) {
      expect(observed).toBeLessThan(execute.mock.calls[0][2] as number)
    }
  })

  it('gives an on_llm_call lambda 30s even when the agent budget is 20 minutes', async () => {
    const { handler, execute } = makeLambdaHandler({ execution_timeout_ms: 1_200_000 })
    await handler.execute(llmDispatch('lib/llm-token-counter.js:onLlmCall'))
    expect(execute.mock.calls[0][2]).toBe(HIGH_FREQUENCY_CEILING_MS)
  })

  it('never exceeds a smaller agent limit', () => {
    expect(dispatchTimeoutMs(llmDispatch('a.js:b'), 5_000)).toBe(5_000)
    expect(dispatchTimeoutMs(timerDispatch('a.js:b'), 5_000)).toBe(5_000)
  })

  it('passes undefined through when the agent sets no limit', async () => {
    const { handler, execute } = makeLambdaHandler({})
    await handler.execute(timerDispatch('lib/work.js:run'))
    expect(execute.mock.calls[0][2]).toBeUndefined()
    // A hot-path trigger still gets its own ceiling in that case.
    expect(dispatchTimeoutMs(llmDispatch('a.js:b'), undefined)).toBe(HIGH_FREQUENCY_CEILING_MS)
  })
})

// --------------------------------------------------------------------------
// Backpressure — through the executor seam (the real dispatch path)
// --------------------------------------------------------------------------

describe('system-scope backpressure', () => {
  it('serializes an on_llm_call burst strictly', async () => {
    const { executor, handler } = makeExecutor()
    const burst = Array.from({ length: 5 }, () => executor.executeTurn(llmDispatch('lib/counter.ts:count')))

    await settle()
    expect(handler.started).toEqual(['lib/counter.ts:count'])

    handler.releaseOne()
    await settle()
    expect(handler.started).toHaveLength(2)

    for (let i = 0; i < 4; i++) { handler.releaseAll(); await settle() }

    await Promise.all(burst)
    expect(handler.started).toHaveLength(5)
    expect(handler.peak).toBe(1)
  })

  it('lets a work-shaped trigger run WORK_MAX_CONCURRENT at a time', async () => {
    const { executor, handler } = makeExecutor()
    const burst = Array.from({ length: 10 }, () => executor.executeTurn(timerDispatch('lib/poller.ts:pollFeed')))

    await settle()
    expect(handler.started).toHaveLength(WORK_MAX_CONCURRENT)
    expect(handler.peak).toBe(WORK_MAX_CONCURRENT)

    for (let i = 0; i < 3; i++) { handler.releaseAll(); await settle() }
    await Promise.all(burst)
    expect(handler.started).toHaveLength(10)
    expect(handler.peak).toBe(WORK_MAX_CONCURRENT)
  })

  it('throttles per lane — a saturated lambda does not hold up a different one', async () => {
    const { executor, handler } = makeExecutor()
    const busy = Array.from({ length: 3 }, () => executor.executeTurn(llmDispatch('lib/slow.ts:run')))
    await settle()

    const other = executor.executeTurn(llmDispatch('lib/other.ts:run'))
    await settle()

    expect(handler.started).toEqual(['lib/slow.ts:run', 'lib/other.ts:run'])

    for (let i = 0; i < 3; i++) { handler.releaseAll(); await settle() }
    await Promise.all([...busy, other])
  })

  it('same lambda under two different triggers gets its own lane', async () => {
    const { executor, handler } = makeExecutor()
    const a = executor.executeTurn(llmDispatch('lib/shared.ts:run'))
    const b = executor.executeTurn(sysDispatch('tool_call', 'lib/shared.ts:run'))
    await settle()

    expect(handler.started).toHaveLength(2)
    handler.releaseAll(); await settle()
    await Promise.all([a, b])
  })

  /**
   * Lane identity is trigger type + executable, on purpose. TickerPulse.adf
   * points six distinct timers at lib/poller.ts:pollFeed; they share one lane
   * because the cap exists to bound workers running that code and to keep its
   * read-modify-write against the same rows from racing itself.
   */
  it('distinct timers sharing one lambda share a lane', async () => {
    const { executor, handler } = makeExecutor()
    const six = Array.from({ length: 6 }, () => executor.executeTurn(timerDispatch('lib/poller.ts:pollFeed')))
    await settle()

    expect(handler.started).toHaveLength(WORK_MAX_CONCURRENT)
    for (let i = 0; i < 3; i++) { handler.releaseAll(); await settle() }
    await Promise.all(six)
    expect(handler.peak).toBe(WORK_MAX_CONCURRENT)
  })

  it('an agent-scope turn is never delayed by a saturated system lane', async () => {
    const { executor, handler } = makeExecutor()
    const burst = Array.from({ length: 6 }, () => executor.executeTurn(llmDispatch('lib/counter.ts:count')))
    await settle()
    expect(handler.started).toHaveLength(1)

    // The chat turn fails fast on the stub provider — the point is that it
    // settles at all while five system dispatches sit in the queue.
    let settled = false
    const chat = executor.executeTurn(chatDispatch()).then(() => { settled = true }, () => { settled = true })
    await Promise.race([chat, new Promise((r) => setTimeout(r, 1000))])
    expect(settled).toBe(true)
    expect(handler.started).toHaveLength(1)

    executor.abort()
    handler.releaseAll()
    await Promise.all(burst)
  })

  it('teardown discards the queue instead of resurrecting it', async () => {
    const { executor, handler } = makeExecutor()
    const burst = Array.from({ length: 5 }, () => executor.executeTurn(llmDispatch('lib/counter.ts:count')))
    await settle()
    expect(handler.started).toHaveLength(1)

    executor.abort()
    handler.releaseAll()
    await Promise.all(burst)
    await settle()

    // Only the one already running ever executed.
    expect(handler.started).toHaveLength(1)
  })
})

// --------------------------------------------------------------------------
// Drop semantics
// --------------------------------------------------------------------------

describe('dropped dispatches', () => {
  /** Fill a lane to capacity so the next run() overflows. */
  async function saturate(queue: SystemDispatchQueue, make: () => AdfEventDispatch) {
    const release: Array<() => void> = []
    let ran = 0
    const task = () => { ran++; return new Promise<void>((res) => release.push(res)) }
    const limit = limitsForDispatch(make()).max_concurrent
    const accepted = Array.from({ length: limit + MAX_QUEUE_DEPTH }, () => queue.run(make(), task))
    await settle()
    return { accepted, release, task, ran: () => ran, limit }
  }

  it('rejects instead of resolving, and names the drop in adf_logs at error level', async () => {
    const logs: Array<[string, string | null, string | null, string, unknown]> = []
    const queue = new SystemDispatchQueue((level, event, target, message, data) => {
      logs.push([level, event, target, message, data])
    })
    const make = () => llmDispatch('lib/counter.ts:count')
    const lane = await saturate(queue, make)
    expect(lane.ran()).toBe(1)
    expect(logs).toHaveLength(0)

    const overflow = await queue.run(make(), lane.task).then(() => 'resolved', (e) => e)
    expect(overflow).toBeInstanceOf(SystemDispatchDroppedError)
    expect((overflow as SystemDispatchDroppedError).trigger).toBe('on_llm_call')
    expect((overflow as SystemDispatchDroppedError).target).toBe('lib/counter.ts:count')

    expect(logs).toHaveLength(1)
    const [level, event, target, message, data] = logs[0]
    expect(level).toBe('error')           // 'warn' is invisible at default_level:'error'
    expect(event).toBe('on_llm_call')
    expect(target).toBe('lib/counter.ts:count')
    expect(message).toContain('dropped')
    expect(data).toMatchObject({
      trigger: 'on_llm_call', target: 'lib/counter.ts:count',
      queued: MAX_QUEUE_DEPTH, max_concurrent: 1, max_queue_depth: MAX_QUEUE_DEPTH,
    })

    // Dropped work never ran; the accepted queue is intact.
    expect(lane.ran()).toBe(1)
    queue.clear()
    await Promise.all(lane.accepted.slice(1))
    lane.release.forEach((r) => r())
    await lane.accepted[0]
    expect(lane.ran()).toBe(1)
  })

  it('runs the producer compensation before rejecting', async () => {
    const queue = new SystemDispatchQueue(() => {})
    const make = () => timerDispatch('lib/hil/request.ts:onTimer')
    const lane = await saturate(queue, make)

    let compensated = 0
    const overflowing = make()
    onDispatchDropped(overflowing, () => { compensated++ })
    await expect(queue.run(overflowing, lane.task)).rejects.toBeInstanceOf(SystemDispatchDroppedError)
    expect(compensated).toBe(1)

    queue.clear()
    lane.release.forEach((r) => r())
    await Promise.all(lane.accepted)
  })

  it('propagates the drop out of executeTurn and closes the umbilical pair', async () => {
    const { executor, handler, logs } = makeExecutor()
    const seen: UmbilicalEvent[] = []
    ensureUmbilicalBus('agent-1').subscribe((e) => { seen.push(e) })

    const make = () => llmDispatch('lib/hil/request.ts:onLlmCall')
    // 1 running + MAX_QUEUE_DEPTH waiting fills the lane exactly.
    const accepted = Array.from({ length: 1 + MAX_QUEUE_DEPTH }, () => executor.executeTurn(make()))
    await settle()
    expect(handler.started).toHaveLength(1)

    const outcome = await executor.executeTurn(make()).then(() => 'resolved', (e) => e)
    expect(outcome).toBeInstanceOf(SystemDispatchDroppedError)
    expect(logs.some((row) => row[0] === 'error' && String(row[4]).includes('dropped'))).toBe(true)

    // A drop used to leave the trigger's own umbilical event with no terminal
    // counterpart — no lambda.started, no lambda.completed, nothing.
    const terminal = seen.find((e) => e.event_type === 'lambda.failed')
    expect(terminal).toBeDefined()
    expect(terminal!.payload).toMatchObject({ trigger: 'on_llm_call', dropped: true })

    executor.abort()
    handler.releaseAll()
    await Promise.all(accepted)
    clearAllUmbilicalBuses()
  })

  it('clear() releases waiters without running them', async () => {
    const queue = new SystemDispatchQueue(() => {})
    let ran = 0
    const release: Array<() => void> = []
    const task = () => { ran++; return new Promise<void>((res) => release.push(res)) }

    const all = Array.from({ length: 4 }, () => queue.run(llmDispatch('lib/a.ts:run'), task))
    await settle()
    expect(ran).toBe(1)

    queue.clear()
    await Promise.all(all.slice(1))
    release.forEach((r) => r())
    await all[0]
    expect(ran).toBe(1)
  })
})

// --------------------------------------------------------------------------
// A dropped one-shot timer must not be consumed
// --------------------------------------------------------------------------

describe('one-shot timer whose dispatch is dropped', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers(); clearAllUmbilicalBuses() })

  function makeTimerWorkspace(timer: Timer) {
    const calls = {
      expireTimers: [] as number[][],
      advanceTimer: [] as Array<[number, number, number, number]>,
      updateTimer: [] as unknown[][],
      logs: [] as Array<[string, string, string, string | null, string, unknown]>,
    }
    let served = false
    const workspace = {
      getDueTimers: () => { if (served) return []; served = true; return [timer] },
      expireTimers: (ids: number[]) => { calls.expireTimers.push(ids); return ids.length },
      advanceTimer: (...args: [number, number, number, number]) => { calls.advanceTimer.push(args); return true },
      updateTimer: (...args: unknown[]) => { calls.updateTimer.push(args); return true },
      insertLog: (...row: [string, string, string, string | null, string, unknown]) => { calls.logs.push(row) },
      getUnreadCount: () => 0,
    }
    return { workspace, calls }
  }

  it('rewinds the timer row and says so, instead of consuming it forever', async () => {
    const now = Date.now()
    const timer: Timer = {
      id: 7,
      schedule: { mode: 'once', at: now - 1_000 },
      next_wake_at: now - 1_000,
      scope: ['system'],
      lambda: 'lib/hil/request.ts:onTimer',
      run_count: 0,
      created_at: now - 10_000,
      warm: false,
    }
    const { workspace, calls } = makeTimerWorkspace(timer)
    const config = {
      id: 'agent-1', name: 'agent-1',
      triggers: { on_timer: { enabled: true, targets: [{ scope: 'system' }] } },
    } as unknown as AgentConfig

    const evaluator = new TriggerEvaluator(config)
    evaluator.setDisplayState('active')
    const emitted: Array<AdfEventDispatch | AdfBatchDispatch> = []
    evaluator.on('trigger', (d: AdfEventDispatch | AdfBatchDispatch) => emitted.push(d))

    evaluator.startTimerPolling(workspace as never)
    vi.advanceTimersByTime(5_000)
    evaluator.stopTimerPolling()

    // The tick settles the row before emitting: the one-shot is already spent.
    expect(calls.expireTimers).toEqual([[7]])
    expect(emitted).toHaveLength(1)

    // Now drop that exact dispatch.
    vi.useRealTimers()
    const queue = new SystemDispatchQueue(() => {})
    const release: Array<() => void> = []
    const task = () => new Promise<void>((res) => release.push(res))
    const filler = Array.from({ length: WORK_MAX_CONCURRENT + MAX_QUEUE_DEPTH }, () =>
      queue.run(sysDispatch('timer', 'lib/hil/request.ts:onTimer'), task))
    await settle()

    await expect(queue.run(emitted[0], task)).rejects.toBeInstanceOf(SystemDispatchDroppedError)

    // updateTimer clears `expired` and restores the wake time; advanceTimer
    // puts run_count / last_fired_at back where they were.
    expect(calls.updateTimer).toHaveLength(1)
    expect(calls.updateTimer[0][0]).toBe(7)
    expect(calls.updateTimer[0][2]).toBe(timer.next_wake_at)
    expect(calls.advanceTimer).toEqual([[7, timer.next_wake_at, 0, timer.created_at]])

    // And the drop is on the record at error level, next to the "fired" row.
    const rewindRow = calls.logs.find((row) => String(row[4]).includes('rewound'))
    expect(rewindRow).toBeDefined()
    expect(rewindRow![0]).toBe('error')

    queue.clear()
    release.forEach((r) => r())
    await Promise.all(filler)
  })

  it('does not rewind a recurring timer — its next run is already scheduled', async () => {
    const now = Date.now()
    const timer: Timer = {
      id: 9,
      schedule: { mode: 'interval', every_ms: 60_000 },
      next_wake_at: now - 1_000,
      scope: ['system'],
      lambda: 'lib/poller.ts:pollFeed',
      run_count: 3,
      created_at: now - 100_000,
    }
    const { workspace, calls } = makeTimerWorkspace(timer)
    const config = {
      id: 'agent-1', name: 'agent-1',
      triggers: { on_timer: { enabled: true, targets: [{ scope: 'system' }] } },
    } as unknown as AgentConfig

    const evaluator = new TriggerEvaluator(config)
    evaluator.setDisplayState('active')
    const emitted: Array<AdfEventDispatch | AdfBatchDispatch> = []
    evaluator.on('trigger', (d: AdfEventDispatch | AdfBatchDispatch) => emitted.push(d))

    evaluator.startTimerPolling(workspace as never)
    vi.advanceTimersByTime(5_000)
    evaluator.stopTimerPolling()
    expect(calls.advanceTimer).toHaveLength(1)   // renewed, not expired

    vi.useRealTimers()
    const queue = new SystemDispatchQueue(() => {})
    const release: Array<() => void> = []
    const task = () => new Promise<void>((res) => release.push(res))
    const filler = Array.from({ length: WORK_MAX_CONCURRENT + MAX_QUEUE_DEPTH }, () =>
      queue.run(sysDispatch('timer', 'lib/poller.ts:pollFeed'), task))
    await settle()

    await expect(queue.run(emitted[0], task)).rejects.toBeInstanceOf(SystemDispatchDroppedError)

    expect(calls.updateTimer).toHaveLength(0)
    expect(calls.advanceTimer).toHaveLength(1)   // untouched by the drop

    queue.clear()
    release.forEach((r) => r())
    await Promise.all(filler)
  })
})

// --------------------------------------------------------------------------
// The agent-facing config surface is unchanged
// --------------------------------------------------------------------------

describe('trigger target schema', () => {
  it('round-trips a target byte-identically', () => {
    const input = {
      on_llm_call: {
        enabled: true,
        targets: [{ scope: 'system', lambda: 'lib/tokens.ts:onCall', warm: false, filter: { source: ['model_invoke'] } }],
      },
      on_timer: { enabled: true, targets: [{ scope: 'system' }, { scope: 'agent' }] },
    }
    const parsed = TriggersConfigV3Schema.parse(structuredClone(input))
    expect(parsed).toEqual(input)
    // Key order within a target is what a downgrade would disturb; zod's own
    // top-level key order follows the schema, not the input.
    for (const trigger of Object.keys(input) as Array<keyof typeof input>) {
      expect(JSON.stringify(parsed[trigger])).toBe(JSON.stringify(input[trigger]))
    }
  })

  /**
   * The limits are not config. An earlier attempt put timeout_ms /
   * max_concurrent on the target — writable by the agent they bound, absent
   * from the UI, and silently stripped by any consumer that persisted parsed
   * output. Neither key is part of the surface; both are stripped as unknown.
   */
  it('exposes no timeout or concurrency knob on a target', () => {
    const parsed = TriggersConfigV3Schema.parse({
      on_llm_call: {
        enabled: true,
        targets: [{ scope: 'system', lambda: 'lib/tokens.ts:onCall', timeout_ms: 1_200_000, max_concurrent: 1_000_000 }],
      },
    })
    const target = parsed.on_llm_call!.targets[0] as Record<string, unknown>
    expect(target).not.toHaveProperty('timeout_ms')
    expect(target).not.toHaveProperty('max_concurrent')
    expect(JSON.stringify(target)).toBe(JSON.stringify({ scope: 'system', lambda: 'lib/tokens.ts:onCall' }))
  })

  /** Flipping a target to agent scope stays valid — the refine never grew new arms. */
  it('accepts an agent-scope target with lambda and warm cleared', () => {
    const after = { scope: 'agent', lambda: undefined, warm: undefined }
    expect(TriggersConfigV3Schema.safeParse({ on_timer: { enabled: true, targets: [after] } }).success).toBe(true)
  })
})
