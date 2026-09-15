import { describe, expect, it, beforeEach, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { ERROR_RECOVERY_COOLDOWN_MS } from '../../../src/main/runtime/agent-executor'
import { AgentRuntimeBuilder } from '../../../src/main/runtime/agent-runtime-builder'
import { createHeadlessAgent, MockLLMProvider } from '../../../src/main/runtime/headless'
import { clearAllUmbilicalBuses, ensureUmbilicalBus } from '../../../src/main/runtime/umbilical-bus'
import { createDispatch, createEvent } from '../../../src/shared/types/adf-event.types'
import type { RecoveryConfig } from '../../../src/shared/types/adf-v02.types'
import type { CreateMessageOptions, LLMProvider } from '../../../src/main/providers/provider.interface'
import type { LLMResponse } from '../../../src/shared/types/provider.types'

// ─────────────────────────────────────────────────────────────────────────
// Test doubles
// ─────────────────────────────────────────────────────────────────────────

/** Provider that fails with a transient error for the first `failures` calls, then succeeds. */
class FlakyProvider implements LLMProvider {
  readonly name = 'flaky-provider'
  readonly modelId = 'flaky-model-v1'
  createMessageCalls = 0
  lastMessages: unknown = []

  constructor(
    private failures: number,
    private headers?: Record<string, string>,
    private errProps?: Record<string, unknown>,
  ) {}

  async createMessage(opts: CreateMessageOptions): Promise<LLMResponse> {
    this.lastMessages = opts.messages
    this.createMessageCalls++
    if (this.createMessageCalls <= this.failures) {
      const err = new Error(
        typeof this.errProps?.message === 'string' ? this.errProps.message : 'Overloaded'
      ) as Error & Record<string, unknown>
      err.statusCode = 529
      if (this.headers) err.responseHeaders = this.headers
      if (this.errProps) Object.assign(err, this.errProps)
      throw err
    }
    return {
      id: `reply-${this.createMessageCalls}`,
      content: [{ type: 'text', text: 'recovered ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }
  }

  async validateConfig(): Promise<{ valid: boolean; error?: string }> {
    return { valid: true }
  }
}

/** Provider whose createMessage outcomes follow a fixed script; repeats the last entry when exhausted. */
class ScriptedProvider implements LLMProvider {
  readonly name = 'scripted-provider'
  readonly modelId = 'scripted-model-v1'
  createMessageCalls = 0

  constructor(private script: Array<'fail' | 'ok'>) {}

  async createMessage(_opts: CreateMessageOptions): Promise<LLMResponse> {
    const step = this.script[Math.min(this.createMessageCalls, this.script.length - 1)]
    this.createMessageCalls++
    if (step === 'fail') {
      const err = new Error('Overloaded') as Error & { statusCode: number }
      err.statusCode = 529
      throw err
    }
    return {
      id: `reply-${this.createMessageCalls}`,
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }
  }

  async validateConfig(): Promise<{ valid: boolean; error?: string }> {
    return { valid: true }
  }
}

/** Provider whose preflight fails transiently once, then validates; createMessage always succeeds. */
class PreflightFlakyProvider implements LLMProvider {
  readonly name = 'preflight-flaky-provider'
  readonly modelId = 'preflight-flaky-model-v1'
  validateCalls = 0
  createMessageCalls = 0

  async createMessage(_opts: CreateMessageOptions): Promise<LLMResponse> {
    this.createMessageCalls++
    return {
      id: `reply-${this.createMessageCalls}`,
      content: [{ type: 'text', text: 'ok after outage' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }
  }

  async validateConfig(): Promise<{ valid: boolean; error?: string }> {
    this.validateCalls++
    return this.validateCalls === 1
      ? { valid: false, error: '529 Overloaded' }
      : { valid: true }
  }
}

/**
 * Provider whose failures are STRUCTURAL (no status, no transient wording), so
 * the executor bricks into `error` state instead of taking the transient path.
 * Outcomes follow a fixed script; the last entry repeats.
 */
class StructuralFailProvider implements LLMProvider {
  readonly name = 'structural-provider'
  readonly modelId = 'structural-model-v1'
  createMessageCalls = 0

  constructor(private script: Array<'fail' | 'ok'>) {}

  async createMessage(_opts: CreateMessageOptions): Promise<LLMResponse> {
    const step = this.script[Math.min(this.createMessageCalls, this.script.length - 1)]
    this.createMessageCalls++
    if (step === 'fail') throw new Error('unrecognized executor fault')
    return {
      id: `reply-${this.createMessageCalls}`,
      content: [{ type: 'text', text: 'recovered from error state' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }
  }

  async validateConfig(): Promise<{ valid: boolean; error?: string }> {
    return { valid: true }
  }
}

function makeWorkspace(name: string) {
  const dir = mkdtempSync(join(tmpdir(), `adf-recovery-${name}-`))
  const filePath = join(dir, `${name}.adf`)
  const created = createHeadlessAgent({
    filePath,
    name,
    provider: new MockLLMProvider(),
  })
  created.dispose()
  return { filePath, workspace: AdfWorkspace.open(filePath) }
}

function chatDispatch(text = 'hello') {
  return createDispatch(
    createEvent({
      type: 'chat',
      source: 'test',
      data: {
        message: {
          seq: 0,
          role: 'user',
          content_json: [{ type: 'text', text }],
          created_at: Date.now(),
        },
      },
    }),
    { scope: 'agent' },
  )
}

/** A background (non-chat) agent-scope trigger — the kind `error` state used to swallow. */
function timerDispatch(payload = 'scheduled work') {
  return createDispatch(
    createEvent({
      type: 'timer',
      source: 'test',
      data: {
        timer: {
          id: 1,
          schedule: { mode: 'once', at: Date.now() },
          next_wake_at: Date.now(),
          payload,
          scope: ['agent'],
          run_count: 0,
          created_at: Date.now(),
        },
      },
    }),
    { scope: 'agent' },
  )
}

async function until(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition')
    await new Promise(r => setTimeout(r, 10))
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function buildAgent(
  workspace: AdfWorkspace,
  filePath: string,
  provider: LLMProvider,
  recovery?: Partial<RecoveryConfig>,
) {
  const config = workspace.getAgentConfig()
  return new AgentRuntimeBuilder().build({
    workspace,
    filePath,
    config: recovery
      ? { ...config, recovery: { auto_retry: true, max_attempts: 5, base_delay_ms: 15_000, max_delay_ms: 300_000, ...recovery } }
      : config,
    provider,
  })
}

function collectRuntimeEvents(agentId: string) {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = []
  const bus = ensureUmbilicalBus(agentId)
  bus.subscribe(event => {
    if (event.event_type.startsWith('provider.retry')) {
      events.push({ type: event.event_type, payload: event.payload as Record<string, unknown> })
    }
  })
  return events
}

// ─────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────

describe('AgentExecutor — automatic provider-error recovery', () => {
  beforeEach(() => {
    clearAllUmbilicalBuses()
  })

  it('retries a transient provider error with backoff and recovers', async () => {
    const { filePath, workspace } = makeWorkspace('recovers')
    const provider = new FlakyProvider(2)
    const events = collectRuntimeEvents(workspace.getAgentConfig().id)

    const agent = await buildAgent(workspace, filePath, provider, { base_delay_ms: 20, max_delay_ms: 60 })
    try {
      await agent.executor.executeTurn(chatDispatch())
      // Turn 1 failed; two backoff retries should fire and the third call succeeds.
      await until(() => provider.createMessageCalls >= 3)
      await until(() => agent.executor.getState() === 'idle')

      expect(provider.createMessageCalls).toBe(3)
      expect(agent.executor.getState()).toBe('idle')

      const scheduled = events.filter(e => e.type === 'provider.retry_scheduled')
      const started = events.filter(e => e.type === 'provider.retry_started')
      expect(scheduled.length).toBe(2)
      expect(started.length).toBe(2)
      expect(scheduled[0].payload.attempt).toBe(1)
      expect(scheduled[1].payload.attempt).toBe(2)
      expect(scheduled[0].payload.max_attempts).toBe(5)

      // The successful retry turn must carry the elapsed-time notice so the
      // model knows the call failed and how long has passed.
      const sentHistory = JSON.stringify(provider.lastMessages)
      expect(sentHistory).toContain('auto-recovery retry 2/5')
      expect(sentHistory).toContain('Provider error')
    } finally {
      await agent.disposeAsync()
    }
  })

  it('gives up after max_attempts and stays idle (never error state)', async () => {
    const { filePath, workspace } = makeWorkspace('exhausts')
    const provider = new FlakyProvider(Number.POSITIVE_INFINITY)

    const errorEvents: string[] = []
    const bus = ensureUmbilicalBus(workspace.getAgentConfig().id)
    bus.subscribe(event => {
      if (event.event_type === 'agent.error') {
        const inner = (event.payload as { event?: { payload?: { error?: string } } })?.event
        if (inner?.payload?.error) errorEvents.push(inner.payload.error)
      }
    })

    const agent = await buildAgent(workspace, filePath, provider, { max_attempts: 2, base_delay_ms: 20, max_delay_ms: 60 })
    try {
      await agent.executor.executeTurn(chatDispatch())
      // Initial call + 2 retries, then it gives up.
      await until(() => provider.createMessageCalls >= 3)
      await sleep(300)

      expect(provider.createMessageCalls).toBe(3)
      expect(agent.executor.getState()).toBe('idle')
      expect(errorEvents.some(e => e.includes('gave up after 2'))).toBe(true)

      // A durable notice must sit in the loop so the next wake knows the
      // trigger above was never processed and how long the outage lasted.
      const loopText = JSON.stringify(workspace.getLoop().map(e => e.content_json))
      expect(loopText).toContain('Auto-recovery gave up after 2')
      expect(loopText).toContain('NOT processed')
    } finally {
      await agent.disposeAsync()
    }
  })

  it('does not retry when recovery.auto_retry is disabled', async () => {
    const { filePath, workspace } = makeWorkspace('disabled')
    const provider = new FlakyProvider(Number.POSITIVE_INFINITY)

    const errorEvents: string[] = []
    const bus = ensureUmbilicalBus(workspace.getAgentConfig().id)
    bus.subscribe(event => {
      if (event.event_type === 'agent.error') {
        const inner = (event.payload as { event?: { payload?: { error?: string } } })?.event
        if (inner?.payload?.error) errorEvents.push(inner.payload.error)
      }
    })

    const agent = await buildAgent(workspace, filePath, provider, { auto_retry: false, base_delay_ms: 20 })
    try {
      await agent.executor.executeTurn(chatDispatch())
      await sleep(300)

      expect(provider.createMessageCalls).toBe(1)
      expect(agent.executor.getState()).toBe('idle')
      expect(errorEvents.some(e => e.includes('disabled'))).toBe(true)
    } finally {
      await agent.disposeAsync()
    }
  })

  it('cancels the pending retry when fresh work arrives, which resumes from the same history', async () => {
    const { filePath, workspace } = makeWorkspace('superseded')
    const provider = new FlakyProvider(1)
    const events = collectRuntimeEvents(workspace.getAgentConfig().id)

    // Long delay so the retry is still pending when the user message lands.
    const agent = await buildAgent(workspace, filePath, provider, { base_delay_ms: 60_000 })
    try {
      await agent.executor.executeTurn(chatDispatch('first'))
      expect(events.filter(e => e.type === 'provider.retry_scheduled').length).toBe(1)

      // Fresh user turn supersedes the armed retry and succeeds immediately.
      await agent.executor.executeTurn(chatDispatch('second'))
      await until(() => agent.executor.getState() === 'idle')
      await sleep(200)

      expect(provider.createMessageCalls).toBe(2)
      expect(events.filter(e => e.type === 'provider.retry_cancelled').map(e => e.payload.reason)).toContain('superseded')
      expect(events.filter(e => e.type === 'provider.retry_started').length).toBe(0)
    } finally {
      await agent.disposeAsync()
    }
  })

  it('honors a Retry-After header larger than the computed backoff', async () => {
    const { filePath, workspace } = makeWorkspace('retry-after')
    // Retry-After: 1s dwarfs the 20ms base delay — the scheduled delay must honor it.
    const provider = new FlakyProvider(1, { 'retry-after': '1' })
    const events = collectRuntimeEvents(workspace.getAgentConfig().id)

    const agent = await buildAgent(workspace, filePath, provider, { base_delay_ms: 20, max_delay_ms: 5_000 })
    try {
      await agent.executor.executeTurn(chatDispatch())
      await until(() => events.some(e => e.type === 'provider.retry_scheduled'))

      const scheduled = events.find(e => e.type === 'provider.retry_scheduled')!
      expect(scheduled.payload.delay_ms as number).toBeGreaterThanOrEqual(1000)
      await until(() => provider.createMessageCalls >= 2, 10_000)
      await until(() => agent.executor.getState() === 'idle')
    } finally {
      await agent.disposeAsync()
    }
  })

  it('never retries auth errors — 401 goes straight to error state', async () => {
    const { filePath, workspace } = makeWorkspace('auth-brick')
    const provider = new FlakyProvider(Number.POSITIVE_INFINITY, undefined, { statusCode: 401, message: 'Unauthorized' })
    const events = collectRuntimeEvents(workspace.getAgentConfig().id)

    const agent = await buildAgent(workspace, filePath, provider, { base_delay_ms: 20 })
    try {
      await agent.executor.executeTurn(chatDispatch())
      await sleep(200)

      expect(provider.createMessageCalls).toBe(1)
      expect(agent.executor.getState()).toBe('error')
      expect(events.length).toBe(0)
    } finally {
      await agent.disposeAsync()
    }
  })

  it('retries a 429 whose body mentions billing (rate limit, not credentials)', async () => {
    const { filePath, workspace } = makeWorkspace('billing-429')
    const provider = new FlakyProvider(1, undefined, {
      statusCode: 429,
      message: 'You exceeded your current quota, please check your plan and billing details.',
    })
    const events = collectRuntimeEvents(workspace.getAgentConfig().id)

    const agent = await buildAgent(workspace, filePath, provider, { base_delay_ms: 20, max_delay_ms: 60 })
    try {
      await agent.executor.executeTurn(chatDispatch())
      await until(() => provider.createMessageCalls >= 2)
      await until(() => agent.executor.getState() === 'idle')

      expect(events.filter(e => e.type === 'provider.retry_scheduled').length).toBe(1)
      expect(agent.executor.getState()).toBe('idle')
    } finally {
      await agent.disposeAsync()
    }
  })

  it('abort() during the backoff window cancels the armed retry', async () => {
    const { filePath, workspace } = makeWorkspace('abort-backoff')
    const provider = new FlakyProvider(Number.POSITIVE_INFINITY)
    const events = collectRuntimeEvents(workspace.getAgentConfig().id)

    const agent = await buildAgent(workspace, filePath, provider, { base_delay_ms: 60_000 })
    try {
      await agent.executor.executeTurn(chatDispatch())
      expect(events.filter(e => e.type === 'provider.retry_scheduled').length).toBe(1)

      agent.executor.abort()
      await sleep(200)

      expect(provider.createMessageCalls).toBe(1)
      expect(events.filter(e => e.type === 'provider.retry_cancelled').map(e => e.payload.reason)).toContain('abort')
      expect(events.filter(e => e.type === 'provider.retry_started').length).toBe(0)
    } finally {
      await agent.disposeAsync()
    }
  })

  it('keeps escalating attempts across fresh failing turns (recurring trigger cannot defeat max_attempts)', async () => {
    const { filePath, workspace } = makeWorkspace('escalates')
    const provider = new FlakyProvider(Number.POSITIVE_INFINITY)
    const events = collectRuntimeEvents(workspace.getAgentConfig().id)

    // Long delay: the armed retry never fires; each fresh turn supersedes it.
    const agent = await buildAgent(workspace, filePath, provider, { max_attempts: 3, base_delay_ms: 60_000 })
    try {
      await agent.executor.executeTurn(chatDispatch('first'))
      await agent.executor.executeTurn(chatDispatch('second'))

      const attempts = events.filter(e => e.type === 'provider.retry_scheduled').map(e => e.payload.attempt)
      expect(attempts).toEqual([1, 2])
    } finally {
      await agent.disposeAsync()
    }
  })

  it('resets the attempt counter after a successful call, not at turn entry', async () => {
    const { filePath, workspace } = makeWorkspace('resets')
    // Outage 1: fail, retry ok. Outage 2: fail, retry ok.
    const provider = new ScriptedProvider(['fail', 'ok', 'fail', 'ok'])
    const events = collectRuntimeEvents(workspace.getAgentConfig().id)

    const agent = await buildAgent(workspace, filePath, provider, { base_delay_ms: 20, max_delay_ms: 60 })
    try {
      await agent.executor.executeTurn(chatDispatch('first'))
      await until(() => provider.createMessageCalls >= 2)
      await until(() => agent.executor.getState() === 'idle')

      await agent.executor.executeTurn(chatDispatch('second'))
      await until(() => provider.createMessageCalls >= 4)
      await until(() => agent.executor.getState() === 'idle')

      const attempts = events.filter(e => e.type === 'provider.retry_scheduled').map(e => e.payload.attempt)
      expect(attempts).toEqual([1, 1])
    } finally {
      await agent.disposeAsync()
    }
  })

  it('writes the give-up notice once per outage, not once per failing turn', async () => {
    const { filePath, workspace } = makeWorkspace('one-notice')
    const provider = new FlakyProvider(Number.POSITIVE_INFINITY)

    const agent = await buildAgent(workspace, filePath, provider, { max_attempts: 1, base_delay_ms: 20, max_delay_ms: 60 })
    try {
      // Turn + 1 retry → give up (writes the notice).
      await agent.executor.executeTurn(chatDispatch('first'))
      await until(() => provider.createMessageCalls >= 2)
      await sleep(200)

      // Further failing turns during the same outage must not add another.
      await agent.executor.executeTurn(chatDispatch('second'))
      await sleep(200)

      const loopText = JSON.stringify(workspace.getLoop().map(e => e.content_json))
      expect(loopText.split('NOT processed').length - 1).toBe(1)
    } finally {
      await agent.disposeAsync()
    }
  })

  it('updateConfig disabling auto_retry cancels an armed retry', async () => {
    const { filePath, workspace } = makeWorkspace('live-disable')
    const provider = new FlakyProvider(Number.POSITIVE_INFINITY)
    const events = collectRuntimeEvents(workspace.getAgentConfig().id)

    const agent = await buildAgent(workspace, filePath, provider, { base_delay_ms: 60_000 })
    try {
      await agent.executor.executeTurn(chatDispatch())
      expect(events.filter(e => e.type === 'provider.retry_scheduled').length).toBe(1)

      const config = agent.executor.getConfig()
      agent.executor.updateConfig({
        ...config,
        recovery: { auto_retry: false, max_attempts: 5, base_delay_ms: 60_000, max_delay_ms: 300_000 },
      })
      await sleep(100)

      expect(events.filter(e => e.type === 'provider.retry_cancelled').map(e => e.payload.reason)).toContain('disabled')
      expect(provider.createMessageCalls).toBe(1)
    } finally {
      await agent.disposeAsync()
    }
  })

  it('routes a transient preflight failure into recovery instead of the credentials brick', async () => {
    const { filePath, workspace } = makeWorkspace('preflight-529')
    const provider = new PreflightFlakyProvider()
    const events = collectRuntimeEvents(workspace.getAgentConfig().id)

    const agent = await buildAgent(workspace, filePath, provider, { base_delay_ms: 20, max_delay_ms: 60 })
    try {
      await agent.executor.executeTurn(chatDispatch())
      await until(() => provider.createMessageCalls >= 1)
      await until(() => agent.executor.getState() === 'idle')

      expect(agent.executor.getState()).toBe('idle')
      expect(provider.validateCalls).toBe(2)
      expect(events.filter(e => e.type === 'provider.retry_scheduled').length).toBe(1)
    } finally {
      await agent.disposeAsync()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────
// `error` state is no longer a dead end for background agents.
//
// Regression: an undici stream drop surfaced as a bare `terminated`, fell
// through to the structural branch, and parked a background agent in `error`
// for 23 hours — every timer/inbox trigger dropped, nothing ever retried.
// ─────────────────────────────────────────────────────────────────────────

describe('AgentExecutor — bounded recovery out of the error state', () => {
  beforeEach(() => {
    clearAllUmbilicalBuses()
  })

  it('schedules a bounded recovery for a non-auth error and returns to idle on success', async () => {
    const { filePath, workspace } = makeWorkspace('error-recovers')
    const provider = new StructuralFailProvider(['fail', 'ok'])
    const events = collectRuntimeEvents(workspace.getAgentConfig().id)

    const agent = await buildAgent(workspace, filePath, provider, { base_delay_ms: 20, max_delay_ms: 60 })
    try {
      await agent.executor.executeTurn(chatDispatch())
      // The structural failure still bricks the turn...
      expect(agent.executor.getState()).toBe('error')
      expect(events.filter(e => e.type === 'provider.retry_scheduled').length).toBe(1)

      // ...but the armed retry climbs back out on its own.
      await until(() => provider.createMessageCalls >= 2)
      await until(() => agent.executor.getState() === 'idle')

      expect(provider.createMessageCalls).toBe(2)
      expect(agent.executor.getState()).toBe('idle')
      expect(events.filter(e => e.type === 'provider.retry_started').length).toBe(1)
      expect(workspace.getLogs().some(l => l.event === 'recovery_exhausted')).toBe(false)
    } finally {
      await agent.disposeAsync()
    }
  })

  it('never schedules recovery for an auth error — credentials stay bricked', async () => {
    const { filePath, workspace } = makeWorkspace('error-auth-bricked')
    const provider = new FlakyProvider(Number.POSITIVE_INFINITY, undefined, { statusCode: 401, message: 'Unauthorized' })
    const events = collectRuntimeEvents(workspace.getAgentConfig().id)

    const agent = await buildAgent(workspace, filePath, provider, { base_delay_ms: 20, max_delay_ms: 60 })
    try {
      await agent.executor.executeTurn(chatDispatch())
      await sleep(250)

      expect(agent.executor.getState()).toBe('error')
      expect(provider.createMessageCalls).toBe(1)
      expect(events.length).toBe(0)

      // And a background trigger is still dropped — retrying a bad key is futile.
      await agent.executor.executeTurn(timerDispatch())
      await sleep(100)
      expect(provider.createMessageCalls).toBe(1)
      expect(agent.executor.getState()).toBe('error')
      expect(workspace.getLogs().some(l => l.event === 'error_recovery_trigger')).toBe(false)
    } finally {
      await agent.disposeAsync()
    }
  })

  it('spends the next background trigger as a recovery attempt instead of dropping it', async () => {
    const { filePath, workspace } = makeWorkspace('error-trigger-recovers')
    const provider = new StructuralFailProvider(['fail', 'ok'])

    // Long backoff: the armed retry never fires, so the timer trigger is the
    // only thing that can pull the agent out.
    const agent = await buildAgent(workspace, filePath, provider, { base_delay_ms: 60_000 })
    try {
      await agent.executor.executeTurn(chatDispatch())
      expect(agent.executor.getState()).toBe('error')

      const states: string[] = []
      agent.executor.on('event', (e: { type: string; payload?: { state?: string } }) => {
        if (e.type === 'state_changed' && e.payload?.state) states.push(e.payload.state)
      })

      await agent.executor.executeTurn(timerDispatch())
      await until(() => agent.executor.getState() === 'idle')

      expect(provider.createMessageCalls).toBe(2)
      expect(agent.executor.getState()).toBe('idle')
      // The transition out of error must go through setState so the manager/UI see it.
      expect(states).toContain('idle')
      expect(states).toContain('thinking')
      expect(workspace.getLogs().some(l => l.event === 'error_recovery_trigger')).toBe(true)
    } finally {
      await agent.disposeAsync()
    }
  })

  it('stays in error and logs recovery_exhausted once the attempt cap is reached', async () => {
    const { filePath, workspace } = makeWorkspace('error-exhausts')
    const provider = new StructuralFailProvider(['fail'])

    const agent = await buildAgent(workspace, filePath, provider, { max_attempts: 1, base_delay_ms: 20, max_delay_ms: 60 })
    try {
      await agent.executor.executeTurn(chatDispatch())
      // Initial turn + the single permitted retry, then it gives up.
      await until(() => provider.createMessageCalls >= 2)
      await sleep(250)

      expect(provider.createMessageCalls).toBe(2)
      expect(agent.executor.getState()).toBe('error')
      const exhausted = workspace.getLogs().filter(l => l.event === 'recovery_exhausted')
      expect(exhausted.length).toBe(1)
      expect(exhausted[0].message).toContain('stays in error state')
    } finally {
      await agent.disposeAsync()
    }
  })

  it('drops background triggers once the cap is hit, logging recovery_suppressed exactly once', async () => {
    const { filePath, workspace } = makeWorkspace('error-suppressed')
    const provider = new StructuralFailProvider(['fail'])

    // One attempt, armed with a backoff long enough that it never fires here:
    // the budget is spent, so every timer tick below must be refused.
    const agent = await buildAgent(workspace, filePath, provider, { max_attempts: 1, base_delay_ms: 60_000 })
    try {
      await agent.executor.executeTurn(chatDispatch())
      expect(agent.executor.getState()).toBe('error')
      expect(provider.createMessageCalls).toBe(1)

      for (let i = 0; i < 3; i++) {
        await agent.executor.executeTurn(timerDispatch(`tick ${i}`))
      }
      await sleep(100)

      // No flapping: the agent never left error and never burned a call.
      expect(provider.createMessageCalls).toBe(1)
      expect(agent.executor.getState()).toBe('error')

      const suppressed = workspace.getLogs().filter(l => l.event === 'recovery_suppressed')
      expect(suppressed.length).toBe(1)
      expect(suppressed[0].message).toContain('Recovery attempts exhausted')
      // ...and no trigger was mistaken for a recovery attempt.
      expect(workspace.getLogs().some(l => l.event === 'error_recovery_trigger')).toBe(false)
    } finally {
      await agent.disposeAsync()
    }
  })

  it('lets a background trigger recover once the cooldown has elapsed', async () => {
    const { filePath, workspace } = makeWorkspace('error-cooldown')
    const provider = new StructuralFailProvider(['fail', 'ok'])

    const agent = await buildAgent(workspace, filePath, provider, { max_attempts: 1, base_delay_ms: 60_000 })
    try {
      await agent.executor.executeTurn(chatDispatch())
      expect(agent.executor.getState()).toBe('error')

      // Refused while the cooldown is running.
      await agent.executor.executeTurn(timerDispatch('too soon'))
      expect(provider.createMessageCalls).toBe(1)
      expect(agent.executor.getState()).toBe('error')

      // Jump past the cooldown. Only Date is faked, and only for the
      // synchronous part of the dispatch that reads the clock — the gate runs
      // before executeTurnImpl's first await, so real timers are back in place
      // long before the recovery turn does any waiting.
      let turn: Promise<void>
      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + ERROR_RECOVERY_COOLDOWN_MS + 60_000 })
      try {
        turn = agent.executor.executeTurn(timerDispatch('after cooldown'))
      } finally {
        vi.useRealTimers()
      }
      await turn
      await until(() => agent.executor.getState() === 'idle')

      expect(provider.createMessageCalls).toBe(2)
      expect(agent.executor.getState()).toBe('idle')
      const admitted = workspace.getLogs().filter(l => l.event === 'error_recovery_trigger')
      expect(admitted.length).toBe(1)
      expect(admitted[0].message).toContain('after cooldown')
    } finally {
      vi.useRealTimers()
      await agent.disposeAsync()
    }
  })
})
