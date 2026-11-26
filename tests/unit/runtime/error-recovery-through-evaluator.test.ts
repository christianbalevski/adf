/**
 * Error-state recovery by background trigger, driven through the real
 * TriggerEvaluator instead of calling executor.executeTurn directly.
 *
 * Stated intent (commit 43df7ab9 and agent-executor.ts):
 *  - "Non-auth errors arm the existing bounded backoff retry; the next incoming
 *    agent-scope trigger may also spend itself as a recovery turn. After the
 *    attempt cap the agent goes quiet, logs `recovery_suppressed` once, and
 *    probes again every 30 min." (commit message)
 *
 * In error, the executor publishes `recovery_at` with its state_changed event;
 * the trigger gate (scopeFires in shared/utils/trigger-gate) reads it, the
 * same fact the UI reads, before it fires an agent-scope trigger. A refused
 * timer stays due and a refused message stays unread.
 *  - "a structural/unclassified error now spends the NEXT trigger as its
 *    recovery attempt" and "the agent goes quiet, but never permanently deaf."
 *    (executor comments on the in-error entry path)
 *  - ERROR_RECOVERY_COOLDOWN_MS: "How long a capped-out agent waits before a
 *    background trigger may spend itself on another recovery attempt."
 */
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
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
import { noticeFor } from '../../../src/main/tui/state/transcript'

/** The clause of a recovery-suppressed text that is about messages (up to the next ';' or '.'). */
const messageClause = (text: string) => { const i = text.search(/messages/); return i < 0 ? '' : text.slice(i).split(/[;.]/)[0] }

/** Fails with an unclassified (structural) error until `heal()`, then answers. */
class FlakyProvider implements LLMProvider {
  readonly name = 'flaky-provider'
  readonly modelId = 'flaky-model-v1'
  calls = 0
  seen: string[] = []
  healed = false
  constructor(private failure: 'structural' | 'auth' = 'structural') {}
  heal() { this.healed = true }
  async createMessage(opts: CreateMessageOptions): Promise<LLMResponse> {
    this.calls++
    this.seen.push(JSON.stringify(opts))
    if (!this.healed) {
      throw this.failure === 'auth'
        ? Object.assign(new Error('401 Unauthorized: invalid api key'), { status: 401 })
        : new Error('unrecognized executor fault')
    }
    return { id: `r${this.calls}`, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }
  }
  async validateConfig() { return { valid: true } }
}

function makeWorkspace(name: string) {
  const dir = mkdtempSync(join(tmpdir(), `adf-probe-${name}-`))
  const filePath = join(dir, `${name}.adf`)
  createHeadlessAgent({ filePath, name, provider: new MockLLMProvider() }).dispose()
  return { filePath, workspace: AdfWorkspace.open(filePath) }
}

function chatDispatch(text = 'hello') {
  return createDispatch(createEvent({ type: 'chat', source: 'test', data: { message: { seq: 0, role: 'user', content_json: [{ type: 'text', text }], created_at: Date.now() } } }), { scope: 'agent' })
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

type Agent = Awaited<ReturnType<AgentRuntimeBuilder['build']>>
function addDueTimer(workspace: AdfWorkspace, payload: string) {
  const due = Date.now() - 1000
  return workspace.addTimer({ mode: 'once', at: due } as never, due, payload, ['agent'])
}
function timerRow(workspace: AdfWorkspace, id: number) {
  const row = workspace.getTimers().find(t => t.id === id) as { expired?: boolean; run_count: number }
  return { expired: row.expired === true, run_count: row.run_count }
}
const tick = (agent: Agent) => (agent.triggerEvaluator as unknown as { checkTimers: () => void }).checkTimers()
/** What a mesh, adapter or startup-sweep delivery does: write the inbox row, then call onInbox. */
function deliverInbox(agent: Agent, workspace: AdfWorkspace, text: string) {
  const messageId = workspace.addToInbox({ from: 'did:key:peer', content: text, source: 'mesh', received_at: Date.now(), status: 'unread' } as never)
  agent.triggerEvaluator.onInbox('did:key:peer', text, { source: 'mesh', messageId })
}

/** Build, start, stop real polling (ticks are driven by hand), and fail one chat turn into `error`. */
async function erroredAgent(name: string, maxAttempts: number, failure: 'structural' | 'auth' = 'structural', extraTriggers: Record<string, unknown> = {}, autoRetry = true, loops?: unknown[]) {
  const { filePath, workspace } = makeWorkspace(name)
  const provider = new FlakyProvider(failure)
  const config = workspace.getAgentConfig()
  config.triggers = { ...config.triggers, ...extraTriggers } as typeof config.triggers
  if (loops) (config as unknown as { loops: unknown[] }).loops = loops
  workspace.setAgentConfig(config)
  const agent = await new AgentRuntimeBuilder().build({
    workspace, filePath, provider,
    // Long backoff: the armed retry never fires during the test, so only a
    // background trigger can be the recovery attempt.
    config: { ...config, recovery: { auto_retry: autoRetry, max_attempts: maxAttempts, base_delay_ms: 60_000, max_delay_ms: 300_000 } },
  })
  await (agent as unknown as { start?: () => Promise<void> }).start?.()
  agent.triggerEvaluator.stopTimerPolling()
  await agent.executor.executeTurn(chatDispatch())
  const triggers = config.triggers as Record<string, { enabled?: boolean; targets?: Array<{ scope: string }> }>
  return {
    agent, workspace, provider,
    pre: {
      state: agent.executor.getState(),
      calls: provider.calls,
      onTimerAgent: !!triggers.on_timer?.enabled && !!triggers.on_timer?.targets?.some(t => t.scope === 'agent'),
      onInboxAgent: !!triggers.on_inbox?.enabled && !!triggers.on_inbox?.targets?.some(t => t.scope === 'agent'),
    },
  }
}

/**
 * Run `fn` with only Date moved past the cooldown, and keep it there while the
 * dispatch settles: the evaluator hands the dispatch to the executor after an
 * await (assemble-agent dispatch -> beforeDispatch), so restoring Date right
 * after `fn` would let the executor read the real clock.
 */
async function afterCooldown(fn: () => void) {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + ERROR_RECOVERY_COOLDOWN_MS + 60_000 })
  try { fn(); await sleep(500) } finally { vi.useRealTimers() }
}

function outcome(agent: Agent, workspace: AdfWorkspace, provider: FlakyProvider, marker: string) {
  return {
    state: agent.executor.getState(),
    calls: provider.calls,
    reachedModel: provider.seen.some(s => s.includes(marker)),
    recoveryLogged: workspace.getLogs().some(l => l.event === 'error_recovery_trigger'),
    recoveryAttempts: workspace.getLogs().filter(l => l.event === 'error_recovery_trigger').length,
    unread: workspace.getUnreadCount(),
  }
}

describe('background triggers reach an agent in error through the evaluator', () => {
  beforeEach(() => clearAllUmbilicalBuses())

  it('after the attempt cap and the 30-minute cooldown, a due timer is the recovery probe', async () => {
    const { agent, workspace, provider, pre } = await erroredAgent('cap-timer', 1)
    try {
      expect(pre).toMatchObject({ state: 'error', calls: 1, onTimerAgent: true })
      provider.heal()
      let timerId = 0
      await afterCooldown(() => {
        const due = Date.now() - 1000
        timerId = workspace.addTimer({ mode: 'once', at: due } as never, due, 'PROBE-TIMER', ['agent'])
        tick(agent)
      })
      const row = workspace.getTimers().find(t => t.id === timerId) as { expired?: boolean; run_count: number }
      const r = { ...outcome(agent, workspace, provider, 'PROBE-TIMER'), timerExpired: row.expired === true, timerRunCount: row.run_count }
      expect(r.recoveryLogged).toBe(true)
      expect(r.reachedModel).toBe(true)
      expect(r.state).toBe('idle')
    } finally {
      await agent.disposeAsync()
    }
  })

  it('after the attempt cap and the 30-minute cooldown, an inbox message is the recovery probe', async () => {
    const { agent, workspace, provider, pre } = await erroredAgent('cap-inbox', 1)
    try {
      expect(pre).toMatchObject({ state: 'error', calls: 1, onInboxAgent: true })
      provider.heal()
      await afterCooldown(() => {
        deliverInbox(agent, workspace, 'PROBE-INBOX')
      })
      const r = outcome(agent, workspace, provider, 'PROBE-INBOX')
      expect(r.recoveryLogged).toBe(true)
      expect(r.calls).toBe(2)
      expect(r.state).toBe('idle')
    } finally {
      await agent.disposeAsync()
    }
  })

  it('within the attempt cap, the next inbox message is the recovery attempt', async () => {
    const { agent, workspace, provider, pre } = await erroredAgent('within-cap-inbox', 5)
    try {
      expect(pre).toMatchObject({ state: 'error', calls: 1, onInboxAgent: true })
      provider.heal()
      deliverInbox(agent, workspace, 'PROBE-INBOX-2')
      await sleep(500)
      const r = outcome(agent, workspace, provider, 'PROBE-INBOX-2')
      expect(r.recoveryLogged).toBe(true)
      expect(r.calls).toBe(2)
      expect(r.state).toBe('idle')
    } finally {
      await agent.disposeAsync()
    }
  })
  it('auth error: ten inbox messages and repeated timer ticks make no provider call; timers stay held, messages unread', async () => {
    const { agent, workspace, provider, pre } = await erroredAgent('auth', 5, 'auth')
    try {
      expect(pre).toMatchObject({ state: 'error', calls: 1 })
      expect(agent.executor.getErrorReason()).toBe('auth')
      const t = addDueTimer(workspace, 'AUTH-TIMER')
      for (let i = 0; i < 10; i++) deliverInbox(agent, workspace, `AUTH-INBOX-${i}`)
      for (let i = 0; i < 5; i++) tick(agent)
      await sleep(500)
      const r = outcome(agent, workspace, provider, 'AUTH-')
      expect(r).toMatchObject({ state: 'error', calls: 1, recoveryAttempts: 0, unread: 10 })
      expect(timerRow(workspace, t)).toMatchObject({ expired: false, run_count: 0 })
    } finally {
      await agent.disposeAsync()
    }
  })

  it('within the cap, a burst of five inbox messages spends one recovery attempt', async () => {
    const { agent, workspace, provider, pre } = await erroredAgent('burst', 5)
    try {
      expect(pre).toMatchObject({ state: 'error', calls: 1 })
      // Provider still failing: each attempt that runs ends in error again.
      for (let i = 0; i < 5; i++) deliverInbox(agent, workspace, `BURST-${i}`)
      await sleep(800)
      const r = outcome(agent, workspace, provider, 'BURST-')
      expect(r.recoveryAttempts).toBe(1)
      expect(r.calls).toBe(2)
      expect(r.state).toBe('error')
      expect(r.unread).toBe(5)
    } finally {
      await agent.disposeAsync()
    }
  })

  it('after the cap and before the cooldown: nothing runs, timers stay held, messages stay unread', async () => {
    const { agent, workspace, provider, pre } = await erroredAgent('capped-quiet', 1)
    try {
      expect(pre).toMatchObject({ state: 'error', calls: 1 })
      provider.heal()
      const t = addDueTimer(workspace, 'QUIET-TIMER')
      deliverInbox(agent, workspace, 'QUIET-INBOX')
      tick(agent); tick(agent)
      await sleep(500)
      const r = outcome(agent, workspace, provider, 'QUIET-')
      expect(r).toMatchObject({ state: 'error', calls: 1, recoveryAttempts: 0, unread: 1 })
      expect(timerRow(workspace, t)).toMatchObject({ expired: false, run_count: 0 })
      // The person can see why: the suppression is announced once, not per trigger.
      expect(workspace.getLogs().filter(l => l.event === 'recovery_suppressed')).toHaveLength(1)
      // Messages are not re-fired after the cooldown: the clause about them promises no time.
      const log = workspace.getLogs().find(l => l.event === 'recovery_suppressed')!.message
      expect(messageClause(log)).not.toMatch(/until|wait|cooldown|after/)
    } finally {
      await agent.disposeAsync()
    }
  })

  it('the TUI notice for recovery_suppressed promises no time for messages', () => {
    const notice = noticeFor({ event_type: 'error.recovery_suppressed', payload: {} } as never)!
    expect(messageClause(notice.text)).not.toMatch(/until|wait|cooldown|after/)
  })

  it('an inner-loop inbox target does not run while main is in error', async () => {
    const { agent, workspace, provider, pre } = await erroredAgent('side-loop', 5, 'structural',
      { on_inbox: { enabled: true, targets: [{ scope: 'agent', loop: 'side' }] } }, true,
      [{ name: 'side', goal: 'Answer peers.', enabled: true, autostart: false, tools: [] }])
    try {
      expect(pre).toMatchObject({ state: 'error', calls: 1 })
      for (let i = 0; i < 5; i++) { deliverInbox(agent, workspace, `SIDE-${i}`); await sleep(150) }
      await sleep(500)
      expect(provider.calls - pre.calls).toBe(0)
      expect(agent.executor.getState()).toBe('error')
    } finally {
      await agent.disposeAsync()
    }
  })

  it('with auto_retry off, trigger attempts still spend the max_attempts budget', async () => {
    const { agent, workspace, provider, pre } = await erroredAgent('no-auto-retry', 1, 'structural', {}, false)
    try {
      expect(pre).toMatchObject({ state: 'error', calls: 1 })
      for (let i = 0; i < 6; i++) { deliverInbox(agent, workspace, `NR-INBOX-${i}`); await sleep(100) }
      for (let i = 0; i < 4; i++) { addDueTimer(workspace, `NR-TIMER-${i}`); tick(agent); await sleep(100) }
      await sleep(300)
      const r = outcome(agent, workspace, provider, 'NR-')
      // One attempt, then the budget is spent and the rest wait.
      expect(r.calls - pre.calls).toBe(1)
      expect(r.state).toBe('error')
      expect(workspace.getLogs().filter(l => l.event === 'recovery_suppressed')).toHaveLength(1)
    } finally {
      await agent.disposeAsync()
    }
  })

  it('a held timer spent as a post-cap probe that fails stays in the conversation and reaches the model on the next turn', async () => {
    const { agent, workspace, provider, pre } = await erroredAgent('failing-probe', 1)
    try {
      expect(pre).toMatchObject({ state: 'error', calls: 1 })
      const t = addDueTimer(workspace, 'FAILED-PROBE')
      await afterCooldown(() => { tick(agent) })
      await sleep(300)
      const afterProbe = { ...outcome(agent, workspace, provider, 'FAILED-PROBE'), row: timerRow(workspace, t) }
      provider.heal()
      await agent.executor.executeTurn(chatDispatch('owner-after-fix'))
      await sleep(300)
      for (let i = 0; i < 3; i++) { tick(agent); await sleep(200) }
      const last = provider.seen.slice(afterProbe.calls).join('\n')
      const r = { afterProbe, state: agent.executor.getState(), calls: provider.calls, row: timerRow(workspace, t), inLaterCalls: last.includes('FAILED-PROBE') }
      expect(r.afterProbe).toMatchObject({ state: 'error', calls: 2, reachedModel: true })
      expect(r.inLaterCalls).toBe(true)
    } finally {
      await agent.disposeAsync()
    }
  })

  // The agent's own activity while it is in error: its LLM calls and its error
  // logs. Provider never heals. Pass: provider calls stay within 1 (the turn
  // that errored) + max_attempts, then nothing until the cooldown, then at most
  // one probe per cooldown.
  for (const [label, triggers] of [
    ['on_llm_call', { on_llm_call: { enabled: true, targets: [{ scope: 'agent' }] } }],
    ['on_logs', { on_logs: { enabled: true, targets: [{ scope: 'agent' }] } }],
  ] as const) {
    it(`SELF-${label}: an agent-scope ${label} target cannot run an agent in error past its recovery budget`, async () => {
      const maxAttempts = 3
      const { agent, workspace, provider, pre } = await erroredAgent(`self-${label}`, maxAttempts, 'structural', triggers)
      try {
        const counts: Record<string, unknown> = { afterFirstError: pre.calls }
        const dispatched: Record<string, number> = {}
        const seenEvents: Record<string, number> = {}
        agent.triggerEvaluator.on('trigger', (d: { event?: { type: string }; events?: Array<{ type: string }> }) => {
          const t = d.event?.type ?? d.events?.[0]?.type ?? '?'
          dispatched[t] = (dispatched[t] ?? 0) + 1
        })
        const ev = agent.triggerEvaluator as unknown as { onLog: (...a: unknown[]) => void; onLlmCall: (...a: unknown[]) => void }
        const origLog = ev.onLog.bind(ev); ev.onLog = (...a) => { seenEvents[`log:${a[0]}`] = (seenEvents[`log:${a[0]}`] ?? 0) + 1; origLog(...a) }
        const origLlm = ev.onLlmCall.bind(ev); ev.onLlmCall = (...a) => { seenEvents.llm_call = (seenEvents.llm_call ?? 0) + 1; origLlm(...a) }
        // One outside message starts recovery; then let anything self-feed for 3 s, ticking.
        deliverInbox(agent, workspace, 'KICK')
        for (let i = 0; i < 15; i++) { tick(agent); await sleep(200) }
        counts.after3s = provider.calls
        for (let i = 0; i < 10; i++) { tick(agent); await sleep(200) }
        counts.after5s = provider.calls
        await afterCooldown(() => { tick(agent) })
        for (let i = 0; i < 10; i++) { tick(agent); await sleep(100) }
        counts.afterCooldownProbe = provider.calls
        counts.state = agent.executor.getState()
        counts.recoveryAttempts = outcome(agent, workspace, provider, 'x').recoveryAttempts
        // Not vacuous: the agent's own events reached the evaluator.
        expect(seenEvents[label === 'on_logs' ? 'log:error' : 'llm_call']).toBeGreaterThan(0)
        // None of them is dispatched: each lands while a turn holds the agent,
        // or after the attempt was spent, so the gate refuses it.
        if (label === 'on_logs') expect(dispatched.log_entry ?? 0).toBe(0)
        expect(counts.after3s).toBeLessThanOrEqual(1 + maxAttempts)
        expect(counts.after5s).toBe(counts.after3s)
        // Exactly the one attempt the inbox message started. The agent's own
        // events never become attempts: those that land while the turn runs
        // are its own activity (not dispatched), and those written as it ends,
        // before its slot is released, are refused by the gate (recovery_at is
        // null while a turn still holds the agent).
        expect(counts.recoveryAttempts).toBe(1)
        expect(counts.after3s).toBe(2)
        expect(counts.afterCooldownProbe as number).toBeLessThanOrEqual((counts.after5s as number) + 1)
      } finally {
        await agent.disposeAsync()
      }
    }, 20_000)
  }

  it('SELF-BETWEEN: an error log written between attempts is spent as an attempt, bounded by the cap, not by timing', async () => {
    const maxAttempts = 3
    const { agent, workspace, provider, pre } = await erroredAgent('self-between', maxAttempts, 'structural', { on_logs: { enabled: true, targets: [{ scope: 'agent' }] } })
    try {
      expect(pre).toMatchObject({ state: 'error', calls: 1 })
      const callsAfter: number[] = []
      // Five error logs from outside any turn, each after the previous attempt has ended.
      for (let i = 0; i < 5; i++) {
        workspace.insertLog('error', 'test', 'external_fault', null, `external error ${i}`)
        await sleep(600)
        callsAfter.push(provider.calls)
      }
      const r = {
        callsAfter,
        triggerAttempts: outcome(agent, workspace, provider, 'x').recoveryAttempts,
        budgetUsed: (agent.executor as unknown as { _recoveryAttempts: number })._recoveryAttempts,
        state: agent.executor.getState(),
      }
      // Each log between attempts is an attempt; the cap, not timing, stops
      // it. The budget counts the backoff retry the first failure armed (1)
      // plus the two logs that ran as attempts: 3 = max_attempts, then quiet.
      expect(r).toEqual({ callsAfter: [2, 3, 3, 3, 3], triggerAttempts: 2, budgetUsed: maxAttempts, state: 'error' })
    } finally {
      await agent.disposeAsync()
    }
  }, 20_000)

  for (const [label, triggers] of [
    ['on_llm_call', { on_llm_call: { enabled: true, targets: [{ scope: 'agent' }] } }],
    ['on_logs', { on_logs: { enabled: true, targets: [{ scope: 'agent' }] } }],
  ] as const) {
    it(`SELF-HEALED-${label}: once a recovery attempt succeeds, an agent-scope ${label} target does not keep waking it`, async () => {
      const { agent, workspace, provider, pre } = await erroredAgent(`self-healed-${label}`, 3, 'structural', triggers)
      try {
        provider.heal()
        deliverInbox(agent, workspace, 'KICK')
        for (let i = 0; i < 15; i++) { tick(agent); await sleep(200) }
        const after3s = provider.calls
        for (let i = 0; i < 10; i++) { tick(agent); await sleep(200) }
        const r = { afterFirstError: pre.calls, after3s, after5s: provider.calls, state: agent.executor.getState() }
        expect(r.state).toBe('idle')
        expect(r.after5s).toBe(r.after3s)
        expect(r.after3s).toBeLessThanOrEqual(4)
      } finally {
        await agent.disposeAsync()
      }
    }, 20_000)
  }

  it('after the cooldown: one probe, and on success the held timer and the unread message reach the model', async () => {
    const { agent, workspace, provider, pre } = await erroredAgent('probe', 1)
    try {
      expect(pre).toMatchObject({ state: 'error', calls: 1 })
      // Refused inside the cooldown window: the message stays unread, the timer stays due.
      const t1 = addDueTimer(workspace, 'HELD-ONE')
      const t2 = addDueTimer(workspace, 'HELD-TWO')
      deliverInbox(agent, workspace, 'REFUSED-INBOX')
      tick(agent)
      await sleep(300)
      expect(outcome(agent, workspace, provider, 'x')).toMatchObject({ state: 'error', calls: 1, unread: 1 })
      provider.heal()
      await afterCooldown(() => { tick(agent) })
      await sleep(500)
      // One recovery attempt per tick (round 1 F1): the first held timer is the
      // probe; once it succeeds the agent is idle and the next tick delivers the other.
      tick(agent)
      await sleep(500)
      const r = outcome(agent, workspace, provider, 'HELD-ONE')
      const later = provider.seen.slice(1).join('\n')
      const seen = {
        heldOne: later.includes('HELD-ONE'),
        heldTwo: later.includes('HELD-TWO'),
        unreadHint: later.includes('[Inbox: 1 unread]'),
      }
      expect(r.recoveryAttempts).toBe(1)
      expect(r.state).toBe('idle')
      expect(seen).toEqual({ heldOne: true, heldTwo: true, unreadHint: true })
      expect(r.unread).toBe(1) // seen as unread; reading it is the agent's call
      expect(timerRow(workspace, t1)).toMatchObject({ expired: true, run_count: 1 })
      expect(timerRow(workspace, t2)).toMatchObject({ expired: true, run_count: 1 })
    } finally {
      await agent.disposeAsync()
    }
  })
})

/**
 * A 429 until `heal()`. After `cap` calls it hangs (until aborted) instead of
 * throwing, so a self-wake spin reports a count instead of running forever.
 */
class RateLimitedProvider implements LLMProvider {
  readonly name = 'rate-limited-provider'
  readonly modelId = 'rate-limited-model-v1'
  calls = 0
  healed = false
  constructor(private cap = 200) {}
  heal() { this.healed = true }
  async createMessage(opts: CreateMessageOptions): Promise<LLMResponse> {
    this.calls++
    if (this.calls > this.cap) return new Promise((_, reject) => opts.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
    if (!this.healed) throw Object.assign(new Error('429 rate_limit_error: weekly limit reached'), { statusCode: 429 })
    return { id: `r${this.calls}`, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }
  }
  async validateConfig() { return { valid: true } }
}

describe('a provider give-up does not wake the agent through its own on_logs target', () => {
  beforeEach(() => clearAllUmbilicalBuses())

  const executorErrors = { level: ['error'], origin: ['executor'] }
  const anyErrors = { level: ['error'] }
  const gaveUp = (workspace: AdfWorkspace) => workspace.getLogs().some(l => l.event === 'provider_error' && l.level === 'error')
  /** Build and start with an agent-scope on_logs target; timer polling stopped. */
  async function startedAgent(name: string, provider: LLMProvider, opts: { filter?: object; extraTargets?: unknown[]; context?: object } = {}) {
    const { filePath, workspace } = makeWorkspace(name)
    const config = workspace.getAgentConfig()
    config.triggers = { ...config.triggers, on_logs: { enabled: true, targets: [{ scope: 'agent', filter: opts.filter ?? executorErrors }, ...(opts.extraTargets ?? [])] } } as typeof config.triggers
    if (opts.context) config.context = { ...config.context, ...opts.context } as typeof config.context
    workspace.setAgentConfig(config)
    const agent = await new AgentRuntimeBuilder().build({
      workspace, filePath, provider,
      config: { ...config, recovery: { auto_retry: true, max_attempts: 2, base_delay_ms: 20, max_delay_ms: 100 } },
    })
    await (agent as unknown as { start?: () => Promise<void> }).start?.()
    agent.triggerEvaluator.stopTimerPolling()
    return { agent, workspace }
  }
  /** Run one chat turn into a 429; resolves once the retry budget (max_attempts 2) is spent and the give-up is logged. */
  async function gaveUpAgent(name: string, opts: { filter?: object; extraTargets?: unknown[]; context?: object } = {}) {
    const provider = new RateLimitedProvider()
    const { agent, workspace } = await startedAgent(name, provider, opts)
    await agent.executor.executeTurn(chatDispatch())
    for (let i = 0; i < 100 && !gaveUp(workspace); i++) await sleep(20)
    await sleep(300)
    return { agent, workspace, provider }
  }

  // The incident shape: past its budget, every turn gives up on its first
  // call, and each give-up's own error log must not start the next turn.
  for (const [label, filter] of [['origin executor', executorErrors], ['level only', anyErrors]] as const) {
    it(`SELF-WAKE (${label}): a give-up turn's error log is written but runs no further turn`, async () => {
      const { agent, workspace, provider } = await gaveUpAgent(`self-wake-${label.replace(' ', '-')}`, { filter })
      try {
        const afterBudget = provider.calls
        deliverInbox(agent, workspace, 'KICK')
        await sleep(2000)
        const r = { afterBudget, calls: provider.calls, state: agent.executor.getState(), giveUpLogged: gaveUp(workspace) }
        expect(r).toEqual({ afterBudget: 3, calls: 4, state: 'idle', giveUpLogged: true })
      } finally {
        await agent.disposeAsync()
      }
    }, 20_000)
  }

  it('COMPACTION: compaction_failed logs and the give-up, with a level-only filter, run no further turn', async () => {
    const { agent, workspace, provider } = await gaveUpAgent('compaction', { filter: anyErrors, context: { compact_threshold: 1 } })
    try {
      const afterBudget = provider.calls
      deliverInbox(agent, workspace, 'KICK')
      await sleep(1000)
      const afterKick = provider.calls
      await sleep(2000)
      const r = {
        compactionFailed: workspace.getLogs().some(l => l.event === 'compaction_failed' && l.level === 'error'),
        settled: provider.calls === afterKick,
        kickCalls: afterKick - afterBudget,
        state: agent.executor.getState(),
      }
      // Each turn tries compaction (one summarizer call, or two once the
      // pre-turn compaction runs too) before its own call; the budget is 8
      // calls, the kicked turn 3, and then nothing.
      expect({ afterBudget, ...r }).toEqual({ afterBudget: 8, compactionFailed: true, settled: true, kickCalls: 3, state: 'idle' })
    } finally {
      await agent.disposeAsync()
    }
  }, 20_000)

  it('AFTER-HEAL: once the provider heals, the next inbox message runs a turn', async () => {
    const { agent, workspace, provider } = await gaveUpAgent('after-heal')
    try {
      const before = provider.calls
      provider.heal()
      deliverInbox(agent, workspace, 'AFTER-HEAL')
      await sleep(500)
      expect({ before, calls: provider.calls, state: agent.executor.getState() }).toEqual({ before: 3, calls: 4, state: 'idle' })
    } finally {
      await agent.disposeAsync()
    }
  }, 20_000)

  it('SYSTEM-SCOPE: a system-scope on_logs target still receives the give-up error log', async () => {
    const seen: string[] = []
    const { agent, provider } = await gaveUpAgent('system-scope', { extraTargets: [{ scope: 'system', lambda: 'lib/seen.js:seen', filter: executorErrors }] })
    try {
      agent.triggerEvaluator.on('trigger', (d: { scope?: string; event?: { type: string; data?: { entry?: { event?: string } } } }) => {
        if (d.scope === 'system' && d.event?.type === 'log_entry') seen.push(d.event.data?.entry?.event ?? '?')
      })
      // Listening from here: the next failing turn's give-up log.
      await agent.executor.executeTurn(chatDispatch('again'))
      await sleep(300)
      expect({ calls: provider.calls, giveUpToSystem: seen.includes('provider_error') }).toEqual({ calls: 4, giveUpToSystem: true })
    } finally {
      await agent.disposeAsync()
    }
  }, 20_000)

  it('PREFLIGHT: a give-up at the credential preflight, before the turn is thinking, runs no further turn', async () => {
    // validateConfig answers a 429 (providerValidated stays false, so every turn re-preflights); hangs past 200 to cap a spin.
    const provider = new RateLimitedProvider()
    let validations = 0
    provider.validateConfig = async () => (++validations > 200 ? new Promise<never>(() => {}) : { valid: false, error: '429 rate_limit_error: weekly limit reached' })
    const { agent, workspace } = await startedAgent('preflight', provider)
    try {
      await agent.executor.executeTurn(chatDispatch())
      for (let i = 0; i < 100 && !gaveUp(workspace); i++) await sleep(20)
      await sleep(300)
      const afterBudget = validations
      deliverInbox(agent, workspace, 'KICK')
      await sleep(2000)
      // Bound: one preflight per turn (the turn plus 2 retries, then the kicked turn), no model call.
      expect({ afterBudget, validations, calls: provider.calls, state: agent.executor.getState(), giveUpLogged: gaveUp(workspace) })
        .toEqual({ afterBudget: 3, validations: 4, calls: 0, state: 'idle', giveUpLogged: true })
    } finally {
      await agent.disposeAsync()
    }
  }, 20_000)

  it('NO-OVERREACH: with no turn running, an error log from outside still wakes the agent once', async () => {
    const provider = new RateLimitedProvider()
    provider.heal()
    const { agent, workspace } = await startedAgent('outside-log', provider)
    try {
      workspace.insertLog('error', 'executor', 'x', null, 'outside')
      await sleep(1000)
      expect({ calls: provider.calls, state: agent.executor.getState() }).toEqual({ calls: 1, state: 'idle' })
    } finally {
      await agent.disposeAsync()
    }
  }, 20_000)

  it('NO-OVERREACH (lambda): a system-scope lambda\'s error, logged while it runs, still wakes the agent', async () => {
    const provider = new RateLimitedProvider()
    provider.heal()
    const { agent } = await startedAgent('lambda-error', provider)
    try {
      agent.executor.setSystemScopeHandler({ execute: async () => { throw new Error('lambda boom') }, executeBatch: async () => {} } as never)
      // The lambda_error log is written while this system-scope dispatch holds its turn slot.
      await agent.executor.executeTurn(createDispatch(chatDispatch().event, { scope: 'system', lambda: 'lib/x.js:f' }))
      await sleep(1000)
      expect({ calls: provider.calls, state: agent.executor.getState() }).toEqual({ calls: 1, state: 'idle' })
    } finally {
      await agent.disposeAsync()
    }
  }, 20_000)
})
