/**
 * Append at fire (DESIGN-B v2). A timer occurrence counts as done only once
 * the agent receives it: its payload is written into the target loop's
 * stream. At the tick, a due timer whose target can receive now is claimed
 * and appended in one transaction; a timer whose target cannot receive is
 * held whole and stays due.
 *
 * Every test runs the real AgentRuntimeBuilder (assembleAgent, the
 * TriggerEvaluator, the LoopPool and the executors) with timer polling
 * stopped and ticks driven by hand. Harness adapted from the old branch's
 * timer-delivery.test.ts.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { ERROR_RECOVERY_COOLDOWN_MS } from '../../../src/main/runtime/agent-executor'
import { AgentRuntimeBuilder } from '../../../src/main/runtime/agent-runtime-builder'
import { createHeadlessAgent, MockLLMProvider } from '../../../src/main/runtime/headless'
import { clearAllUmbilicalBuses } from '../../../src/main/runtime/umbilical-bus'
import { createDispatch, createEvent } from '../../../src/shared/types/adf-event.types'
import type { CreateMessageOptions, LLMProvider } from '../../../src/main/providers/provider.interface'
import type { LLMResponse } from '../../../src/shared/types/provider.types'

type Mode = 'fail' | 'auth' | 'ok'

/** A provider whose next answer is set by the test, with an optional barrier. */
class ScriptedProvider implements LLMProvider {
  readonly name = 'scripted-provider'
  readonly modelId = 'scripted-model-v1'
  calls = 0
  seen: string[] = []
  /** The next call fails (structural) once. */
  failOnce = false
  private barrier: { promise: Promise<void>; release: () => void } | null = null
  constructor(public mode: Mode = 'ok') {}
  /** The next call waits until release() and then answers in the current mode. */
  blockNext(): void {
    let release!: () => void
    const promise = new Promise<void>(r => { release = r })
    this.barrier = { promise, release }
  }
  release(): void { const b = this.barrier; this.barrier = null; b?.release() }
  get blocked(): boolean { return this.barrier !== null }
  async createMessage(opts: CreateMessageOptions): Promise<LLMResponse> {
    this.calls++
    this.seen.push(JSON.stringify(opts.messages))
    if (this.barrier) await this.barrier.promise
    if (this.failOnce) { this.failOnce = false; throw new Error('unrecognized executor fault') }
    if (this.mode === 'auth') throw Object.assign(new Error('401 Unauthorized: invalid api key'), { status: 401 })
    if (this.mode === 'fail') throw new Error('unrecognized executor fault')
    return { id: `r${this.calls}`, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }
  }
  async validateConfig() { return { valid: true } }
}

const opened: Array<{ dir: string; workspaces: AdfWorkspace[] }> = []
afterEach(() => {
  vi.useRealTimers()
  for (const { dir, workspaces } of opened.splice(0)) {
    for (const w of workspaces) { try { w.close() } catch { /* closed by its agent */ } }
    rmSync(dir, { recursive: true, force: true })
  }
})

function makeFile(name: string) {
  const dir = mkdtempSync(join(tmpdir(), `adf-delivery-${name}-`))
  const filePath = join(dir, `${name}.adf`)
  createHeadlessAgent({ filePath, name, provider: new MockLLMProvider() }).dispose()
  const entry = { dir, workspaces: [] as AdfWorkspace[] }
  opened.push(entry)
  const open = () => { const w = AdfWorkspace.open(filePath); entry.workspaces.push(w); return w }
  return { filePath, open }
}

type Agent = Awaited<ReturnType<AgentRuntimeBuilder['build']>>

interface BuildOpts {
  maxAttempts?: number
  autoRetry?: boolean
  delayMs?: number
  triggers?: Record<string, unknown>
  loops?: unknown[]
}

async function build(filePath: string, workspace: AdfWorkspace, provider: LLMProvider, o: BuildOpts = {}) {
  const config = workspace.getAgentConfig()
  config.triggers = { ...config.triggers, ...(o.triggers ?? {}) } as typeof config.triggers
  if (o.loops) (config as unknown as { loops: unknown[] }).loops = o.loops
  workspace.setAgentConfig(config)
  const delay = o.delayMs ?? 60_000
  const agent = await new AgentRuntimeBuilder().build({
    workspace, filePath, provider,
    config: { ...config, recovery: { auto_retry: o.autoRetry ?? true, max_attempts: o.maxAttempts ?? 5, base_delay_ms: delay, max_delay_ms: delay } },
  })
  await (agent as unknown as { start?: () => Promise<void> }).start?.()
  agent.triggerEvaluator.stopTimerPolling()
  return agent
}

/** Count system-scope lambda runs instead of running a sandbox. */
function countLambdas(agent: Agent) {
  const runs = { n: 0 }
  agent.executor.setSystemScopeHandler({
    execute: async () => { runs.n++ },
    executeBatch: async () => { runs.n++ },
  } as never)
  return runs
}

const tick = (agent: Agent) => (agent.triggerEvaluator as unknown as { checkTimers: () => void }).checkTimers()
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function until(cond: () => boolean, timeoutMs = 4000, what = 'condition') {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await sleep(10)
  }
}

/** Every agent turn has finished and nothing is queued to run. */
async function settled(agent: Agent, timeoutMs = 4000) {
  let quiet = 0
  await until(() => {
    quiet = agent.executor.isTurnActive() || agent.hasInFlightDispatch() ? 0 : quiet + 1
    return quiet >= 5
  }, timeoutMs, 'the agent to settle')
}

function chat(text = 'hello') {
  return createDispatch(createEvent({ type: 'chat', source: 'test', data: { message: { seq: 0, role: 'user', content_json: [{ type: 'text', text }], created_at: Date.now() } } }), { scope: 'agent' })
}

function addDue(workspace: AdfWorkspace, payload: string, opts: { scope?: string[]; lambda?: string; loop?: string; every?: number } = {}) {
  const due = Date.now() - 1000
  const schedule = opts.every ? { mode: 'interval', every_ms: opts.every } : { mode: 'once', at: due }
  return workspace.addTimer(schedule as never, due, payload, opts.scope ?? ['agent'], opts.lambda, undefined, undefined, opts.loop)
}

function row(workspace: AdfWorkspace, id: number) {
  const r = workspace.getTimers().find(t => t.id === id)
  return { expired: r?.expired === true, run_count: r?.run_count ?? -1, next_wake_at: r?.next_wake_at ?? -1, exists: !!r }
}

/** adf_loop rows (any loop) whose content carries `payload`. */
function loopRows(workspace: AdfWorkspace, payload: string, loop?: string) {
  const w = loop ? workspace.forLoop(loop) : workspace
  return w.getLoop().filter(e => JSON.stringify(e.content_json).includes(payload)).length
}

/** Move Date only, past the recovery cooldown, while `fn` and its dispatches settle. */
async function afterCooldown(fn: () => void, extraMs = 60_000) {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + ERROR_RECOVERY_COOLDOWN_MS + extraMs })
  try { fn(); await sleep(500) } finally { vi.useRealTimers() }
}

async function erroredAgent(name: string, o: BuildOpts & { failure?: 'fail' | 'auth' } = {}) {
  const { filePath, open } = makeFile(name)
  const workspace = open()
  const provider = new ScriptedProvider(o.failure ?? 'fail')
  const agent = await build(filePath, workspace, provider, o)
  await agent.executor.executeTurn(chat())
  expect(agent.executor.getState()).toBe('error')
  return { agent, workspace, provider, filePath, open }
}

beforeEach(() => clearAllUmbilicalBuses())

// ===========================================================================
// 1. Same-tick burst in recoverable error
// ===========================================================================

const sessionCopies = (agent: Agent, needle: string) =>
  agent.session.getMessages().filter(m => JSON.stringify(m.content).includes(needle)).length
const sawOnce = (p: ScriptedProvider, needle: string) => p.seen.some(s => s.includes(needle))
const SIDE = { name: 'research', goal: 'Research.', enabled: true, autostart: false, tools: [] }
const OFF = { name: 'parked', goal: 'Off.', enabled: false, autostart: false, tools: [] }
const sidePool = (agent: Agent) => (agent as unknown as { loopPool: { getRuntime: (n: string) => { executor: Agent['executor']; session: Agent['session']; dispatch: (d: unknown) => Promise<void> } | undefined } }).loopPool

describe('idle and busy targets', { timeout: 30_000 }, () => {
  it('idle: one row, the timer settled at the tick, one turn that sees it', async () => {
    const { filePath, open } = makeFile('idle')
    const workspace = open()
    const provider = new ScriptedProvider('ok')
    const agent = await build(filePath, workspace, provider)
    try {
      const t = addDue(workspace, 'IDLE-ONCE')
      tick(agent)
      expect(loopRows(workspace, 'IDLE-ONCE')).toBe(1)
      expect(row(workspace, t)).toMatchObject({ expired: true, run_count: 1 })
      await settled(agent)
      expect(provider.calls).toBe(1)
      expect(sawOnce(provider, 'IDLE-ONCE')).toBe(true)
      expect(sessionCopies(agent, 'IDLE-ONCE')).toBe(1)
      tick(agent); await settled(agent)
      expect(loopRows(workspace, 'IDLE-ONCE')).toBe(1)
    } finally { await agent.disposeAsync() }
  })

  it('busy: the row is written at the tick and read at the next model boundary, once, with no successor turn of its own', async () => {
    const { filePath, open } = makeFile('busy')
    const workspace = open()
    const provider = new ScriptedProvider('ok')
    const agent = await build(filePath, workspace, provider)
    try {
      provider.blockNext()
      const turn = agent.executor.executeTurn(chat('long work'))
      await until(() => provider.blocked && provider.calls === 1)
      const t = addDue(workspace, 'BUSY-ONCE')
      tick(agent)
      expect(loopRows(workspace, 'BUSY-ONCE')).toBe(1)
      expect(row(workspace, t)).toMatchObject({ expired: true, run_count: 1 })
      tick(agent)
      provider.release()
      await turn
      await settled(agent)
      expect(loopRows(workspace, 'BUSY-ONCE')).toBe(1)
      expect(sawOnce(provider, 'BUSY-ONCE')).toBe(true)
      expect(sessionCopies(agent, 'BUSY-ONCE')).toBe(1)
      // the turn ended before a boundary drained it, so exactly one kick turn read it
      expect(provider.calls).toBe(2)
    } finally { await agent.disposeAsync() }
  })

  it('busy, then the turn fails with auth: the kick is a timer and stays parked (no further provider call)', async () => {
    const { filePath, open } = makeFile('busy-auth')
    const workspace = open()
    const provider = new ScriptedProvider('ok')
    const agent = await build(filePath, workspace, provider)
    try {
      provider.blockNext()
      const turn = agent.executor.executeTurn(chat('long work'))
      await until(() => provider.blocked && provider.calls === 1)
      addDue(workspace, 'BUSY-AUTH')
      tick(agent)
      provider.mode = 'auth'
      provider.release()
      await turn
      await settled(agent); await sleep(100); await settled(agent)
      expect(agent.executor.getState()).toBe('error')
      expect(provider.calls).toBe(1)
      expect(loopRows(workspace, 'BUSY-AUTH')).toBe(1)
    } finally { await agent.disposeAsync() }
  })

  it('a recurring [system, agent] timer keeps its lambda cadence while the agent is busy', async () => {
    const { filePath, open } = makeFile('mixed-busy')
    const workspace = open()
    const provider = new ScriptedProvider('ok')
    const agent = await build(filePath, workspace, provider)
    const runs = countLambdas(agent)
    try {
      provider.blockNext()
      const turn = agent.executor.executeTurn(chat('long work'))
      await until(() => provider.blocked && provider.calls === 1)
      const t = addDue(workspace, 'MIXED-BUSY', { scope: ['system', 'agent'], lambda: 'lib/job.js:main', every: 60_000 })
      tick(agent); await sleep(20)
      expect(runs.n).toBe(1)
      // the next occurrence comes due while the same turn still runs
      workspace.advanceTimer(t, Date.now() - 1000, row(workspace, t).run_count, Date.now())
      tick(agent); await sleep(20)
      expect(runs.n).toBe(2)
      expect(loopRows(workspace, 'MIXED-BUSY')).toBe(2)
      expect(row(workspace, t).run_count).toBe(2)
      provider.release()
      await turn
      await settled(agent)
    } finally { await agent.disposeAsync() }
  })
})

describe('error and recovery', { timeout: 30_000 }, () => {
  it('error with budget: the tick appends and the turn it starts is the recovery attempt', async () => {
    const { agent, workspace, provider } = await erroredAgent('err-budget')
    try {
      provider.mode = 'ok'
      const t = addDue(workspace, 'ERR-BUDGET')
      tick(agent)
      expect(loopRows(workspace, 'ERR-BUDGET')).toBe(1)
      expect(row(workspace, t)).toMatchObject({ expired: true, run_count: 1 })
      await settled(agent)
      expect(agent.executor.getState()).toBe('idle')
      expect(sawOnce(provider, 'ERR-BUDGET')).toBe(true)
      expect(sessionCopies(agent, 'ERR-BUDGET')).toBe(1)
    } finally { await agent.disposeAsync() }
  })

  it('error in cooldown: the timer is held whole (no row, not settled) until the cooldown ends, then fires once', async () => {
    const { agent, workspace, provider } = await erroredAgent('err-cooldown', { autoRetry: false, maxAttempts: 1 })
    try {
      addDue(workspace, 'SPEND')
      tick(agent); await settled(agent) // the one attempt in budget, still failing
      expect(agent.executor.getState()).toBe('error')
      const callsAfterAttempt = provider.calls
      const t = addDue(workspace, 'COOLDOWN')
      tick(agent); tick(agent); await settled(agent)
      expect(loopRows(workspace, 'COOLDOWN')).toBe(0)
      expect(row(workspace, t)).toMatchObject({ expired: false, run_count: 0 })
      expect(provider.calls).toBe(callsAfterAttempt)
      provider.mode = 'ok'
      await afterCooldown(() => tick(agent))
      await settled(agent)
      expect(loopRows(workspace, 'COOLDOWN')).toBe(1)
      expect(row(workspace, t)).toMatchObject({ expired: true, run_count: 1 })
      expect(sawOnce(provider, 'COOLDOWN')).toBe(true)
    } finally { await agent.disposeAsync() }
  })

  it('auth: held whole, no provider call; after the credentials are fixed it fires once', async () => {
    const { agent, workspace, provider } = await erroredAgent('err-auth', { failure: 'auth' })
    try {
      const calls = provider.calls
      const t = addDue(workspace, 'AUTH-HELD')
      tick(agent); tick(agent); await settled(agent)
      expect(provider.calls).toBe(calls)
      expect(loopRows(workspace, 'AUTH-HELD')).toBe(0)
      expect(row(workspace, t)).toMatchObject({ expired: false, run_count: 0 })
      provider.mode = 'ok'
      expect(agent.executor.recoverFromAuthError('fixed')).toBe(true)
      tick(agent); await settled(agent)
      expect(loopRows(workspace, 'AUTH-HELD')).toBe(1)
      expect(row(workspace, t)).toMatchObject({ expired: true, run_count: 1 })
      expect(sawOnce(provider, 'AUTH-HELD')).toBe(true)
    } finally { await agent.disposeAsync() }
  })

  it('a recurring timer missed while parked is caught up once, rescheduled from then', async () => {
    const { agent, workspace, provider } = await erroredAgent('err-recurring', { failure: 'auth' })
    try {
      const t = workspace.addTimer({ mode: 'interval', every_ms: 60_000 } as never, Date.now() - 5 * 60_000, 'EVERY-MIN', ['agent'])
      for (let i = 0; i < 3; i++) tick(agent)
      expect(loopRows(workspace, 'EVERY-MIN')).toBe(0)
      provider.mode = 'ok'
      agent.executor.recoverFromAuthError('fixed')
      tick(agent); tick(agent); await settled(agent)
      expect(loopRows(workspace, 'EVERY-MIN')).toBe(1)
      expect(row(workspace, t).run_count).toBe(1)
      expect(row(workspace, t).next_wake_at).toBeGreaterThan(Date.now())
    } finally { await agent.disposeAsync() }
  })

  it('auth error landing between the tick and turn entry: the declined row is queued into the live session, releasable by the sweep', async () => {
    const { filePath, open } = makeFile('decline-race')
    const workspace = open()
    const provider = new ScriptedProvider('ok')
    const agent = await build(filePath, workspace, provider)
    try {
      await agent.executor.executeTurn(chat('warm up'))
      // the tick sees an idle, healthy agent; the dispatch then reaches an executor in auth error
      const exec = agent.executor as unknown as { state: string; _errorReason: string | null }
      const real = agent.executor.executeTurn.bind(agent.executor)
      ;(agent.executor as unknown as { executeTurn: typeof real }).executeTurn = (d, o) => { exec.state = 'error'; exec._errorReason = 'auth'; return real(d, o) }
      addDue(workspace, 'RACE')
      tick(agent); await settled(agent)
      expect(provider.calls).toBe(1)
      expect(loopRows(workspace, 'RACE')).toBe(1)
      const pending = agent.session.peekPendingContextInjections().filter(i => i.text.includes('RACE'))
      expect(pending).toHaveLength(1)
      expect(pending[0]).toMatchObject({ category: 'loop' })
      expect(pending[0].wake).not.toBe(true)
    } finally { await agent.disposeAsync() }
  })
})

describe('inner loops and missing or disabled targets', { timeout: 30_000 }, () => {
  it('an inner loop that is auth-parked holds the timer; once fixed it is delivered into that loop once', async () => {
    const { filePath, open } = makeFile('inner-auth')
    const workspace = open()
    const provider = new ScriptedProvider('auth')
    const agent = await build(filePath, workspace, provider, { loops: [SIDE] })
    try {
      const side = sidePool(agent).getRuntime('research')!
      await side.dispatch(chat('inner fails'))
      expect(side.executor.getState()).toBe('error')
      expect(agent.executor.getState()).toBe('idle')
      const calls = provider.calls
      const t = addDue(workspace, 'INNER-AUTH', { loop: 'research' })
      tick(agent); tick(agent); await settled(agent); await sleep(50)
      expect(provider.calls).toBe(calls)
      expect(loopRows(workspace, 'INNER-AUTH', 'research')).toBe(0)
      expect(row(workspace, t)).toMatchObject({ expired: false, run_count: 0 })
      provider.mode = 'ok'
      side.executor.recoverFromAuthError('fixed')
      tick(agent); await sleep(200)
      expect(loopRows(workspace, 'INNER-AUTH', 'research')).toBe(1)
      expect(loopRows(workspace, 'INNER-AUTH')).toBe(0)
      expect(row(workspace, t)).toMatchObject({ expired: true, run_count: 1 })
    } finally { await agent.disposeAsync() }
  })

  it('an inner loop in error with budget: the tick is its recovery attempt', async () => {
    const { filePath, open } = makeFile('inner-budget')
    const workspace = open()
    const provider = new ScriptedProvider('fail')
    const agent = await build(filePath, workspace, provider, { loops: [SIDE] })
    try {
      const side = sidePool(agent).getRuntime('research')!
      await side.dispatch(chat('inner fails'))
      expect(side.executor.getState()).toBe('error')
      provider.mode = 'ok'
      const t = addDue(workspace, 'INNER-BUDGET', { loop: 'research' })
      tick(agent)
      await until(() => side.executor.getState() === 'idle' && !side.executor.isTurnActive())
      expect(loopRows(workspace, 'INNER-BUDGET', 'research')).toBe(1)
      expect(row(workspace, t)).toMatchObject({ expired: true, run_count: 1 })
      expect(sawOnce(provider, 'INNER-BUDGET')).toBe(true)
    } finally { await agent.disposeAsync() }
  })

  it('an inner loop with its recovery budget spent holds its timer until recovery_at, then takes it once (round 13)', async () => {
    const { filePath, open } = makeFile('inner-spent')
    const workspace = open()
    const provider = new ScriptedProvider('fail')
    const agent = await build(filePath, workspace, provider, { loops: [SIDE], autoRetry: false, maxAttempts: 1 })
    try {
      const side = sidePool(agent).getRuntime('research')!
      await side.dispatch(chat('inner fails')).catch(() => {})
      expect(side.executor.getState()).toBe('error')
      // the one attempt in budget, still failing
      addDue(workspace, 'INNER-SPEND', { loop: 'research' })
      tick(agent)
      await until(() => side.executor.getState() === 'error' && !side.executor.isTurnActive())
      await sleep(50)
      const calls = provider.calls
      const t = addDue(workspace, 'INNER-SPENT', { loop: 'research' })
      for (let i = 0; i < 3; i++) { tick(agent); await sleep(20) }
      expect(row(workspace, t)).toMatchObject({ expired: false, run_count: 0 })
      expect(loopRows(workspace, 'INNER-SPENT', 'research')).toBe(0)
      expect(provider.calls).toBe(calls)
      provider.mode = 'ok'
      await afterCooldown(() => tick(agent))
      await until(() => side.executor.getState() === 'idle' && !side.executor.isTurnActive())
      expect(row(workspace, t)).toMatchObject({ expired: true, run_count: 1 })
      expect(loopRows(workspace, 'INNER-SPENT', 'research')).toBe(1)
      expect(provider.seen.slice(calls).some(x => x.includes('INNER-SPENT'))).toBe(true)
    } finally { await agent.disposeAsync() }
  })

  it('a disabled loop holds the timer whole (the reviewer\'s probe): no row, not settled, lambda not run, no log', async () => {
    const { filePath, open } = makeFile('disabled-probe')
    const workspace = open()
    const provider = new ScriptedProvider('ok')
    const agent = await build(filePath, workspace, provider, { loops: [OFF] })
    const runs = countLambdas(agent)
    try {
      const t = addDue(workspace, 'PARKED-MIXED', { loop: 'parked', scope: ['system', 'agent'], lambda: 'lib/job.js:main', every: 3_600_000 })
      for (let i = 0; i < 5; i++) tick(agent)
      await settled(agent)
      expect(runs.n).toBe(0)
      expect(row(workspace, t)).toMatchObject({ expired: false, run_count: 0 })
      expect(loopRows(workspace, 'PARKED-MIXED', 'parked')).toBe(0)
      expect(workspace.getLogs().some(l => l.event === 'loop_dispatch_dropped')).toBe(false)
      expect(provider.calls).toBe(0)
    } finally { await agent.disposeAsync() }
  })

  it('a loop that is not declared (deleted): base behaviour, the row settles, the agent part is dropped and logged, a mixed row runs its lambda', async () => {
    const { filePath, open } = makeFile('missing')
    const workspace = open()
    const provider = new ScriptedProvider('ok')
    const agent = await build(filePath, workspace, provider)
    const runs = countLambdas(agent)
    try {
      const mixed = addDue(workspace, 'GHOST-MIXED', { loop: 'ghost', scope: ['system', 'agent'], lambda: 'lib/job.js:main', every: 3_600_000 })
      const agentOnly = addDue(workspace, 'GHOST-AGENT', { loop: 'ghost' })
      tick(agent); tick(agent); await settled(agent); await sleep(20)
      expect(runs.n).toBe(1)
      expect(row(workspace, mixed)).toMatchObject({ expired: false, run_count: 1 })
      expect(row(workspace, agentOnly)).toMatchObject({ expired: true, run_count: 1 })
      for (const p of ['GHOST-MIXED', 'GHOST-AGENT']) {
        expect(loopRows(workspace, p)).toBe(0)
        expect(loopRows(workspace, p, 'ghost')).toBe(0)
      }
      const drops = workspace.getLogs().filter(l => l.event === 'loop_dispatch_dropped' && l.target === 'ghost')
      expect(drops).toHaveLength(2)
      expect(provider.calls).toBe(0)
    } finally { await agent.disposeAsync() }
  })
})

describe('two runtimes on one file', { timeout: 30_000 }, () => {
  it('both read the same due row before either claims: one row, one run', async () => {
    const { filePath, open } = makeFile('two-runtimes')
    const wa = open()
    const wb = open()
    const pa = new ScriptedProvider('ok')
    const pb = new ScriptedProvider('ok')
    const a = await build(filePath, wa, pa)
    const b = await build(filePath, wb, pb)
    try {
      addDue(wa, 'TWO-RUNTIMES', { every: 3_600_000 })
      const stale = wb.getDueTimers()
      expect(stale).toHaveLength(1)
      tick(a)
      ;(wb as unknown as { getDueTimers: () => unknown[] }).getDueTimers = () => stale
      tick(b)
      await settled(a); await settled(b)
      expect(loopRows(wa, 'TWO-RUNTIMES')).toBe(1)
      expect([pa, pb].filter(p => sawOnce(p, 'TWO-RUNTIMES'))).toHaveLength(1)
    } finally {
      await a.disposeAsync()
      await b.disposeAsync()
    }
  })

  it('a system-only timer read by both runs its lambda once', async () => {
    const { filePath, open } = makeFile('two-runtimes-sys')
    const wa = open()
    const wb = open()
    const a = await build(filePath, wa, new ScriptedProvider('ok'))
    const b = await build(filePath, wb, new ScriptedProvider('ok'))
    const ra = countLambdas(a)
    const rb = countLambdas(b)
    try {
      addDue(wa, 'TWO-SYS', { scope: ['system'], lambda: 'lib/job.js:main', every: 3_600_000 })
      const stale = wb.getDueTimers()
      tick(a)
      ;(wb as unknown as { getDueTimers: () => unknown[] }).getDueTimers = () => stale
      tick(b)
      await sleep(50)
      expect(ra.n + rb.n).toBe(1)
    } finally {
      await a.disposeAsync()
      await b.disposeAsync()
    }
  })
})

describe('a mixed [system, agent] row while its agent part is held', { timeout: 30_000 }, () => {
  it('auth-parked: the lambda waits with the row, then both run once', async () => {
    const { agent, workspace, provider } = await erroredAgent('mixed-held', { failure: 'auth' })
    const runs = countLambdas(agent)
    try {
      const t = addDue(workspace, 'MIXED-HELD', { scope: ['system', 'agent'], lambda: 'lib/job.js:main' })
      tick(agent); tick(agent); await sleep(20)
      expect(runs.n).toBe(0)
      expect(row(workspace, t)).toMatchObject({ expired: false, run_count: 0 })
      provider.mode = 'ok'
      agent.executor.recoverFromAuthError('fixed')
      tick(agent); tick(agent); await settled(agent)
      expect(runs.n).toBe(1)
      expect(loopRows(workspace, 'MIXED-HELD')).toBe(1)
      expect(row(workspace, t)).toMatchObject({ expired: true, run_count: 1 })
    } finally { await agent.disposeAsync() }
  })
})

// ===========================================================================
// Round 1 (break-it recoveryb-r1)
// ===========================================================================

describe('round 1: F1 one recovery window admits one attempt', { timeout: 30_000 }, () => {
  it('five recurring agent timers, out of budget, provider still down: one row per cooldown window', async () => {
    const { agent, workspace, provider } = await erroredAgent('r1-burst', { maxAttempts: 1 })
    const rows = () => workspace.getLoop().filter(e => JSON.stringify(e.content_json).includes('BURST-')).length
    const attempts = () => workspace.getLogs().filter(l => l.event === 'error_recovery_trigger').length
    const base = Date.now()
    try {
      for (let i = 0; i < 5; i++) workspace.addTimer({ mode: 'interval', every_ms: 60_000 } as never, base - 1000, `BURST-${i}`, ['agent'])
      tick(agent); await sleep(50)
      expect(rows()).toBe(0) // in cooldown: held
      const windows: Array<{ rows: number; attempts: number; state: string }> = []
      for (let w = 1; w <= 3; w++) {
        vi.useFakeTimers({ toFake: ['Date'], now: base + w * (ERROR_RECOVERY_COOLDOWN_MS + 120_000) })
        try { tick(agent); await sleep(500) } finally { vi.useRealTimers() }
        windows.push({ rows: rows(), attempts: attempts(), state: agent.executor.getState() })
      }
      expect(windows).toEqual([
        { rows: 1, attempts: 1, state: 'error' },
        { rows: 2, attempts: 2, state: 'error' },
        { rows: 3, attempts: 3, state: 'error' },
      ])
      expect(provider.mode).toBe('fail')
    } finally { await agent.disposeAsync() }
  })

  it('an inner loop in error takes one timer per tick as its attempt', async () => {
    const { filePath, open } = makeFile('r1-inner-burst')
    const workspace = open()
    const provider = new ScriptedProvider('fail')
    const agent = await build(filePath, workspace, provider, { loops: [SIDE] })
    try {
      const side = sidePool(agent).getRuntime('research')!
      await side.dispatch(chat('inner fails')).catch(() => {})
      expect(side.executor.getState()).toBe('error')
      for (let i = 0; i < 3; i++) addDue(workspace, `IN-BURST-${i}`, { loop: 'research', every: 3_600_000 })
      provider.blockNext() // the attempt's call waits, so the attempt holds the inner loop
      tick(agent); await sleep(50)
      const rows = workspace.forLoop('research').getLoop().filter(e => JSON.stringify(e.content_json).includes('IN-BURST-')).length
      expect(rows).toBe(1)
      provider.release()
      await sleep(100)
    } finally { await agent.disposeAsync() }
  })
})

describe('round 1: F3 a mixed row is held whole while its lambda lane is full', { timeout: 30_000 }, () => {
  it('no row, not settled, lambda not dropped; fires once when the lane has room', async () => {
    const { filePath, open } = makeFile('r1-backpressure')
    const workspace = open()
    const provider = new ScriptedProvider('ok')
    const agent = await build(filePath, workspace, provider)
    const releases: Array<() => void> = []
    let runs = 0
    agent.executor.setSystemScopeHandler({
      execute: () => { runs++; return new Promise<void>(r => releases.push(r)) },
      executeBatch: async () => {},
    } as never)
    try {
      const lambda = 'lib/job.js:main'
      const sys = () => createDispatch(createEvent({ type: 'timer', source: 'test', data: { timer: { id: 999, payload: 'fill', scope: ['system'] } as never } }), { scope: 'system', lambda })
      const fill: Promise<void>[] = []
      for (let i = 0; i < 100; i++) fill.push(agent.executor.executeTurn(sys()).catch(() => {}))
      await sleep(20)
      const running = runs
      const drops = () => workspace.getLogs().filter(l => /dropped/i.test(l.message ?? '')).length
      const dropsBefore = drops()
      const t = addDue(workspace, 'R1-MIXED-BP', { scope: ['system', 'agent'], lambda })
      tick(agent); await sleep(50)
      expect(row(workspace, t)).toMatchObject({ expired: false, run_count: 0 })
      expect(loopRows(workspace, 'R1-MIXED-BP')).toBe(0)
      expect(drops()).toBe(dropsBefore) // the tick dropped nothing: the row was held
      // drain the lane
      while (releases.length) { releases.shift()!(); await sleep(1) }
      await Promise.all(fill)
      expect(runs).toBeGreaterThan(running)
      while (releases.length) { releases.shift()!(); await sleep(1) }
      tick(agent); await sleep(50)
      while (releases.length) { releases.shift()!(); await sleep(1) }
      await settled(agent)
      expect(row(workspace, t)).toMatchObject({ expired: true, run_count: 1 })
      expect(loopRows(workspace, 'R1-MIXED-BP')).toBe(1)
    } finally { await agent.disposeAsync() }
  })
})

describe('round 1: F5 a timer turn rejected at dispatch reaches the host error path', { timeout: 30_000 }, () => {
  it('beforeDispatch throws: onTriggerError is called with the timer dispatch', async () => {
    const { filePath, open } = makeFile('r1-host-error')
    const workspace = open()
    const agent = await build(filePath, workspace, new ScriptedProvider('ok'))
    const errors: Array<{ error: unknown; type?: string }> = []
    agent.attachHost({
      beforeDispatch: () => { throw new Error('host refused') },
      onTriggerError: (error, d) => { errors.push({ error, type: 'event' in d ? d.event.type : undefined }) },
    } as never)
    try {
      addDue(workspace, 'R1-HOST-ERR')
      tick(agent); await sleep(100)
      expect(errors).toHaveLength(1)
      expect(errors[0].type).toBe('timer')
      expect(String(errors[0].error)).toContain('host refused')
    } finally { await agent.disposeAsync() }
  })
})

// ===========================================================================
// Round 2 (necessity recoveryb-r2)
// ===========================================================================

describe('round 2: F2 the first queued kick decides, and the budget applies to it', { timeout: 30_000 }, () => {
  it('a loop_send arriving while a timer kick is queued, then the turn fails with auth: no further provider call', async () => {
    const { filePath, open } = makeFile('r2-kick-order')
    const workspace = open()
    const provider = new ScriptedProvider('ok')
    const agent = await build(filePath, workspace, provider, { loops: [SIDE] })
    const pool = (agent as unknown as { loopPool: { sendToLoop: (f: string, t: string, c: string, w: boolean) => Promise<unknown> } }).loopPool
    try {
      provider.blockNext()
      const turn = agent.executor.executeTurn(chat('long work'))
      await until(() => provider.blocked && provider.calls === 1)
      addDue(workspace, 'R2-TIMER-FIRST')
      tick(agent) // injected + timer kick queued first
      await pool.sendToLoop('research', 'main', 'R2-LOOP-SEND', true) // injected; its kick is redundant behind the queued one
      provider.mode = 'auth'
      provider.release()
      await turn
      await settled(agent); await sleep(100); await settled(agent)
      expect(agent.executor.getState()).toBe('error')
      // The kick is the timer's: auth parking applies, so no turn runs.
      expect(provider.calls).toBe(1)
      // Both rows are in the stream and still reach the next turn the owner starts.
      expect(loopRows(workspace, 'R2-TIMER-FIRST')).toBe(1)
      expect(loopRows(workspace, 'R2-LOOP-SEND')).toBe(1)
    } finally { await agent.disposeAsync() }
  })
})

// ===========================================================================
// Round 4 (break-it recoveryb-r4): several agent timers delivered in one tick
// ===========================================================================

describe('round 4: F1/F3 several agent timers due in one tick', { timeout: 30_000 }, () => {
  /** Every provider call ends with a user row: no call re-asks the model with nothing new. */
  const lastRoles = (p: ScriptedProvider) => p.seen.map(s => (JSON.parse(s) as Array<{ role: string }>).at(-1)?.role)

  it.each([2, 4])('%i missed agent timers on a freshly started agent: one turn reads them all, no empty kick turn', async (n) => {
    const { filePath, open } = makeFile(`r4-fresh-${n}`)
    const workspace = open()
    const provider = new ScriptedProvider('ok')
    const payloads = Array.from({ length: n }, (_, i) => `R4-FRESH-${n}-${i}`)
    for (const p of payloads) addDue(workspace, p)
    const agent = await build(filePath, workspace, provider)
    try {
      tick(agent)
      await settled(agent); await sleep(100); await settled(agent)
      expect(provider.calls).toBe(1)
      expect(lastRoles(provider)).toEqual(['user'])
      for (const p of payloads) {
        expect(loopRows(workspace, p)).toBe(1)
        expect(sessionCopies(agent, p)).toBe(1)
      }
    } finally { await agent.disposeAsync() }
  })

  it('two timers due in one tick after the idle sweep released the session: one turn reads both', async () => {
    const { filePath, open } = makeFile('r4-released')
    const workspace = open()
    const provider = new ScriptedProvider('ok')
    const agent = await build(filePath, workspace, provider)
    try {
      await agent.executor.executeTurn(chat('warm'))
      await settled(agent)
      agent.session.flushToLoop(); agent.session.reset() // what the idle sweep does
      addDue(workspace, 'R4-REL-A'); addDue(workspace, 'R4-REL-B')
      tick(agent)
      await settled(agent); await sleep(100); await settled(agent)
      expect(provider.calls).toBe(2) // the warm-up turn and one timer turn
      expect(lastRoles(provider)).toEqual(['user', 'user'])
      expect(sessionCopies(agent, 'R4-REL-A')).toBe(1)
      expect(sessionCopies(agent, 'R4-REL-B')).toBe(1)
    } finally { await agent.disposeAsync() }
  })
})

// ===========================================================================
// Round 7 (break-it recoveryb-r7): a kick is owed for every row the model has not seen
// ===========================================================================

describe('round 7: F1 a timer during a manual compaction gets exactly one turn that sees it', { timeout: 30_000 }, () => {
  it('compactNow with the summarizer blocked, a timer due meanwhile: one turn afterwards reads it', async () => {
    const { filePath, open } = makeFile('r7-compact-now')
    const workspace = open()
    const provider = new ScriptedProvider('ok')
    const agent = await build(filePath, workspace, provider)
    try {
      await agent.executor.executeTurn(chat('first'))
      await settled(agent)
      const before = provider.calls
      provider.blockNext()
      const compaction = (agent.executor as unknown as { compactNow: (r: string) => Promise<{ success: boolean }> }).compactNow('manual')
      await until(() => provider.blocked)
      const t = addDue(workspace, 'R7-DURING-COMPACT')
      tick(agent) // the agent is busy: written into the loop, kick queued
      expect(row(workspace, t)).toMatchObject({ expired: true, run_count: 1 })
      provider.release()
      expect(await compaction).toMatchObject({ success: true })
      await settled(agent); await sleep(300); await settled(agent)
      // calls after the summarizer's: exactly one, and it saw the timer
      const after = provider.seen.slice(before + 1)
      expect(after).toHaveLength(1)
      expect(after[0]).toContain('R7-DURING-COMPACT')
      expect(loopRows(workspace, 'R7-DURING-COMPACT')).toBe(1)
      expect(sessionCopies(agent, 'R7-DURING-COMPACT')).toBe(1)
    } finally { await agent.disposeAsync() }
  })
})

// ===========================================================================
// Round 8 (break-it recoveryb-r8): a row still pending injection below the mark
// ===========================================================================

describe('round 8: F1 a row appended during a failed preflight compaction gets a turn that sees it', { timeout: 30_000 }, () => {
  it.each(['timer', 'loop_send'] as const)('%s: the failure notice is written above the row, the row stays pending, one turn reads it', async (kind) => {
    const { filePath, open } = makeFile(`r8-preflight-${kind}`)
    const workspace = open()
    const provider = new ScriptedProvider('ok')
    const agent = await build(filePath, workspace, provider, { loops: [SIDE] })
    const pool = (agent as unknown as { loopPool: { sendToLoop: (f: string, t: string, c: string, w: boolean) => Promise<unknown> } }).loopPool
    const payload = `R8-DURING-PREFLIGHT-${kind}`
    try {
      await agent.executor.executeTurn(chat('first'))
      await settled(agent)
      // Force the preflight compaction on the next turn.
      const ex = agent.executor as unknown as { estimatePreflightTokens: (...a: unknown[]) => number }
      const orig = ex.estimatePreflightTokens.bind(ex)
      let once = true
      ex.estimatePreflightTokens = (...a: unknown[]) => { if (once) { once = false; return 1e9 } return orig(...a) }
      provider.blockNext() // the next call is the summarizer: block it, then make it fail
      const turn = agent.executor.executeTurn(chat('second'))
      await until(() => provider.blocked && provider.calls >= 2)
      const before = provider.calls
      if (kind === 'timer') {
        const t = addDue(workspace, payload)
        tick(agent)
        expect(row(workspace, t)).toMatchObject({ expired: true, run_count: 1 })
      } else {
        await pool.sendToLoop('research', 'main', payload, true)
      }
      provider.failOnce = true
      provider.release()
      await turn
      await settled(agent); await sleep(300); await settled(agent)
      expect(provider.seen.slice(before).some(s => s.includes(payload))).toBe(true)
      expect(sessionCopies(agent, payload)).toBe(1)
      expect(loopRows(workspace, payload)).toBe(1)
    } finally { await agent.disposeAsync() }
  })
})

// ===========================================================================
// Round 9 (break-it recoveryb-r9)
// ===========================================================================

describe('round 9: F2 a tick under another connection\'s write lock', { timeout: 30_000 }, () => {
  it('ends at the first SQLITE_BUSY: it waits about one busy_timeout, not one per row, and every row stays due', async () => {
    const { filePath, open } = makeFile('r9-locked')
    const workspace = open()
    const agent = await build(filePath, workspace, new ScriptedProvider('ok'))
    const { default: Database } = await import('better-sqlite3')
    const other = new Database(filePath)
    try {
      ;(workspace.getDatabase() as unknown as { db: { pragma: (s: string) => unknown } }).db.pragma('busy_timeout = 200')
      const ids = Array.from({ length: 20 }, (_, i) => addDue(workspace, `R9-LOCKED-${i}`))
      other.exec('BEGIN IMMEDIATE')
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
      const started = Date.now()
      tick(agent)
      const blocked = Date.now() - started
      other.exec('ROLLBACK')
      // The tick stopped at the first SQLITE_BUSY: one row failed, the other 19 were not tried.
      const settleErrors = errors.mock.calls.map(c => String(c[0])).filter(line => line.startsWith('[TriggerEvaluator] Failed to settle'))
      expect(settleErrors).toEqual(['[TriggerEvaluator] Failed to settle 1 timer(s); 19 more not tried this tick (the file is busy):'])
      errors.mockRestore()
      expect(blocked).toBeLessThan(4000) // secondary: one BEGIN wait + the log attempt (~400 ms; 1589 on a slow CI runner)
      for (const id of ids) expect(row(workspace, id)).toMatchObject({ expired: false, run_count: 0 })
    } finally {
      try { other.close() } catch { /* closed */ }
      await agent.disposeAsync()
    }
  })
})

describe('round 9/10: F3 a render that throws during a busy delivery', { timeout: 30_000 }, () => {
  /** A host whose render of the pool's timer row (context_injected, origin timer:*) throws. */
  const throwingRender = { onEvent: (e: { type: string; payload?: { origin?: string } }) => { if (e.type === 'context_injected' && e.payload?.origin?.startsWith('timer:')) throw new Error('renderer gone') } }

  it('main, a busy mixed row: the claim and row stand, the lambda runs, and the model reads the row', async () => {
    const { filePath, open } = makeFile('r9-wake-throws')
    const workspace = open()
    const provider = new ScriptedProvider('ok')
    const agent = await build(filePath, workspace, provider)
    const runs = countLambdas(agent)
    agent.attachHost(throwingRender as never)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      provider.blockNext()
      const turn = agent.executor.executeTurn(chat('long work'))
      await until(() => provider.blocked && provider.calls === 1)
      const before = provider.calls
      const t = addDue(workspace, 'R9-MIXED-WAKE', { scope: ['system', 'agent'], lambda: 'lib/job.js:main' })
      tick(agent); await sleep(20)
      expect(row(workspace, t)).toMatchObject({ expired: true, run_count: 1 })
      expect(loopRows(workspace, 'R9-MIXED-WAKE')).toBe(1)
      expect(runs.n).toBe(1)
      expect(workspace.getLogs().some(l => l.event === 'renew_failed')).toBe(false)
      provider.release()
      await turn
      await settled(agent); await sleep(100); await settled(agent)
      // the render is best-effort: the injection and the kick still happen
      expect(provider.seen.slice(before).some(x => x.includes('R9-MIXED-WAKE'))).toBe(true)
      expect(sessionCopies(agent, 'R9-MIXED-WAKE')).toBe(1)
    } finally {
      errors.mockRestore()
      await agent.disposeAsync()
    }
  })

  it('inner loop, busy: the model of that loop reads the row', async () => {
    const { filePath, open } = makeFile('r10-inner-render')
    const workspace = open()
    const provider = new ScriptedProvider('ok')
    const agent = await build(filePath, workspace, provider, { loops: [SIDE] })
    agent.attachHost(throwingRender as never)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const side = sidePool(agent).getRuntime('research')!
      await side.dispatch(chat('warm'))
      provider.blockNext()
      const turn = side.dispatch(chat('long inner work'))
      await until(() => provider.blocked)
      const before = provider.calls
      const t = addDue(workspace, 'R10-INNER-WAKE', { loop: 'research' })
      tick(agent); await sleep(20)
      expect(row(workspace, t)).toMatchObject({ expired: true, run_count: 1 })
      provider.release()
      await turn
      await sleep(300)
      expect(provider.seen.slice(before).some(x => x.includes('R10-INNER-WAKE'))).toBe(true)
      expect(side.session.getMessages().filter(m => JSON.stringify(m.content).includes('R10-INNER-WAKE'))).toHaveLength(1)
    } finally {
      errors.mockRestore()
      await agent.disposeAsync()
    }
  })
})

// ===========================================================================
// Round 11 (break-it recoveryb-r11): mixed rows sharing a lambda in one tick
// ===========================================================================

describe('round 11: F1 more same-lambda mixed rows due in one tick than the lane has room for', { timeout: 30_000 }, () => {
  it.each([70, 100])('%i rows: rows beyond room stay due, and every lambda runs over the ticks', async (n) => {
    const { filePath, open } = makeFile(`r11-lane-${n}`)
    const workspace = open()
    const provider = new ScriptedProvider('ok')
    const agent = await build(filePath, workspace, provider)
    const runs = countLambdas(agent)
    try {
      const ids = Array.from({ length: n }, (_, i) => addDue(workspace, `R11-${n}-${i}`, { scope: ['system', 'agent'], lambda: 'lib/x.ts:run' }))
      const due = () => ids.filter(id => !row(workspace, id).expired).length
      tick(agent); await settled(agent); await sleep(50)
      expect(due()).toBeGreaterThan(0) // held whole, not settled with a dropped lambda
      expect(runs.n).toBe(n - due())
      for (let i = 0; i < 5 && due() > 0; i++) { tick(agent); await settled(agent); await sleep(50) }
      expect(due()).toBe(0)
      expect(runs.n).toBe(n)
      for (const id of ids) expect(row(workspace, id)).toMatchObject({ expired: true, run_count: 1 })
    } finally { await agent.disposeAsync() }
  })
})

describe('round 11: system-only rows on the same lambda count against the lane too', { timeout: 30_000 }, () => {
  it('70 system-only rows then a mixed row, one tick: the mixed row is held whole, then fires with its lambda', async () => {
    const { filePath, open } = makeFile('r11-sys-then-mixed')
    const workspace = open()
    const agent = await build(filePath, workspace, new ScriptedProvider('ok'))
    const runs = countLambdas(agent)
    try {
      for (let i = 0; i < 70; i++) addDue(workspace, `R11-SYS-${i}`, { scope: ['system'], lambda: 'lib/x.ts:run' })
      const mixed = addDue(workspace, 'R11-MIXED-LAST', { scope: ['system', 'agent'], lambda: 'lib/x.ts:run' })
      tick(agent); await settled(agent); await sleep(50)
      expect(row(workspace, mixed)).toMatchObject({ expired: false, run_count: 0 })
      expect(loopRows(workspace, 'R11-MIXED-LAST')).toBe(0)
      for (let i = 0; i < 5 && !row(workspace, mixed).expired; i++) { tick(agent); await settled(agent); await sleep(50) }
      expect(row(workspace, mixed)).toMatchObject({ expired: true, run_count: 1 })
      expect(loopRows(workspace, 'R11-MIXED-LAST')).toBe(1)
      expect(runs.n).toBe(71)
    } finally { await agent.disposeAsync() }
  })
})
