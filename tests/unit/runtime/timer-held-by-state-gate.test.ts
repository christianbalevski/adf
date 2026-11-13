/**
 * A timer that comes due while the state gate blocks every scope its on_timer
 * config admits (agent scope in suspended, error or off; system scope in off)
 * is left due, not settled, and fires once on the first tick the gate lets it
 * through.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { AgentRuntimeBuilder } from '../../../src/main/runtime/agent-runtime-builder'
import { TriggerEvaluator } from '../../../src/main/runtime/trigger-evaluator'
import { createHeadlessAgent, MockLLMProvider } from '../../../src/main/runtime/headless'
import { clearAllUmbilicalBuses } from '../../../src/main/runtime/umbilical-bus'
import { createDispatch, createEvent } from '../../../src/shared/types/adf-event.types'
import type { AdfEventDispatch, AdfBatchDispatch } from '../../../src/shared/types/adf-event.types'
import type { AgentConfig } from '../../../src/shared/types/adf-v02.types'
import type { CreateMessageOptions, LLMProvider } from '../../../src/main/providers/provider.interface'
import type { LLMResponse } from '../../../src/shared/types/provider.types'

/** First call fails (structural => `error` state); later calls succeed. */
class FailOnceProvider implements LLMProvider {
  readonly name = 'fail-once-provider'
  readonly modelId = 'fail-once-model-v1'
  calls = 0
  seenTexts: string[] = []
  async createMessage(opts: CreateMessageOptions): Promise<LLMResponse> {
    this.calls++
    this.seenTexts.push(JSON.stringify(opts.messages))
    if (this.calls === 1) throw new Error('unrecognized executor fault')
    return { id: `r${this.calls}`, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }
  }
  async validateConfig() { return { valid: true } }
}

/**
 * Call 1 fails (=> `error`). Call 2, the first recovery retry, blocks until
 * released and then fails too. Later calls succeed.
 */
class FailingRetryProvider implements LLMProvider {
  readonly name = 'failing-retry-provider'
  readonly modelId = 'failing-retry-model-v1'
  calls = 0
  seenTexts: string[] = []
  release!: () => void
  private gate = new Promise<void>(r => { this.release = r })
  async createMessage(opts: CreateMessageOptions): Promise<LLMResponse> {
    this.calls++
    this.seenTexts.push(JSON.stringify(opts.messages))
    if (this.calls === 1) throw new Error('unrecognized executor fault')
    if (this.calls === 2) { await this.gate; throw new Error('unrecognized executor fault') }
    return { id: `r${this.calls}`, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }
  }
  async validateConfig() { return { valid: true } }
}

const opened: { dir: string; workspace: AdfWorkspace }[] = []

function makeWorkspace(name: string) {
  const dir = mkdtempSync(join(tmpdir(), `adf-timerloss-${name}-`))
  const filePath = join(dir, `${name}.adf`)
  createHeadlessAgent({ filePath, name, provider: new MockLLMProvider() }).dispose()
  const workspace = AdfWorkspace.open(filePath)
  opened.push({ dir, workspace })
  return { filePath, workspace }
}

afterEach(() => {
  for (const { dir, workspace } of opened.splice(0)) {
    try { workspace.close() } catch { /* already closed by the agent */ }
    rmSync(dir, { recursive: true, force: true })
  }
})

function chatDispatch(text = 'hello') {
  return createDispatch(createEvent({ type: 'chat', source: 'test', data: { message: { seq: 0, role: 'user', content_json: [{ type: 'text', text }], created_at: Date.now() } } }), { scope: 'agent' })
}

async function until(cond: () => boolean, timeoutMs = 3000) {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition')
    await new Promise(r => setTimeout(r, 10))
  }
}

describe('a timer due while the agent is in error', { timeout: 20_000 }, () => {
  beforeEach(() => clearAllUmbilicalBuses())

  it('a once timer that comes due while the agent is in error reaches the model after the backoff retry recovers it', async () => {
    const { filePath, workspace } = makeWorkspace('heldonce')
    const provider = new FailOnceProvider()
    const config = workspace.getAgentConfig()
    const agent = await new AgentRuntimeBuilder().build({
      workspace, filePath, provider,
      config: { ...config, recovery: { auto_retry: true, max_attempts: 5, base_delay_ms: 400, max_delay_ms: 400 } },
    })
    await (agent as unknown as { start?: () => Promise<void> }).start?.()
    agent.triggerEvaluator.stopTimerPolling() // ticks are driven by hand below
    const tick = () => (agent.triggerEvaluator as unknown as { checkTimers: () => void }).checkTimers()
    try {
      await agent.executor.executeTurn(chatDispatch())
      expect(agent.executor.getState()).toBe('error')
      const due = Date.now() - 1000
      const t = workspace.addTimer({ mode: 'once', at: due } as never, due, 'REMIND-HELD', ['agent'])
      tick() // in error: held
      const row = () => workspace.getTimers().find(r => r.id === t) as { expired?: boolean; run_count: number }
      expect(row().expired === true).toBe(false)
      expect(row().run_count).toBe(0)
      await until(() => agent.executor.getState() === 'idle') // backoff retry succeeded
      expect(provider.seenTexts.some(x => x.includes('REMIND-HELD'))).toBe(false)
      tick() // first tick after recovery
      await until(() => provider.seenTexts.some(x => x.includes('REMIND-HELD')))
      expect(row().expired).toBe(true)
      expect(row().run_count).toBe(1)
    } finally {
      await agent.disposeAsync()
    }
  })
  it('known loss: a held timer released into a recovery retry that fails is not delivered', async () => {
    // Pins current behaviour. The hold releases on the executor's gate state,
    // and a recovery retry starts by setting idle, so the retry turn releases
    // the timer; when that turn ends in error, its queue is discarded with
    // the row already settled. A settle-on-consumption fix should flip this.
    const { filePath, workspace } = makeWorkspace('heldretryfail')
    const provider = new FailingRetryProvider()
    const config = workspace.getAgentConfig()
    const agent = await new AgentRuntimeBuilder().build({
      workspace, filePath, provider,
      config: { ...config, recovery: { auto_retry: true, max_attempts: 5, base_delay_ms: 300, max_delay_ms: 300 } },
    })
    await (agent as unknown as { start?: () => Promise<void> }).start?.()
    agent.triggerEvaluator.stopTimerPolling() // ticks are driven by hand below
    const tick = () => (agent.triggerEvaluator as unknown as { checkTimers: () => void }).checkTimers()
    try {
      await agent.executor.executeTurn(chatDispatch())
      expect(agent.executor.getState()).toBe('error')
      const due = Date.now() - 1000
      const t = workspace.addTimer({ mode: 'once', at: due } as never, due, 'REMIND-LOST', ['agent'])
      const row = () => workspace.getTimers().find(r => r.id === t) as { expired?: boolean; run_count: number }
      tick() // in error: held
      expect(row().expired === true).toBe(false)
      expect(row().run_count).toBe(0)

      await until(() => provider.calls === 2) // first recovery retry is in flight
      tick() // released into the retry turn and settled
      expect(row().expired).toBe(true)
      expect(row().run_count).toBe(1)

      provider.release() // the retry fails
      await until(() => agent.executor.getState() === 'idle', 5000) // a later retry succeeds
      tick(); tick()
      await new Promise(r => setTimeout(r, 300))
      expect(provider.seenTexts.some(x => x.includes('REMIND-LOST'))).toBe(false)
      expect(row().expired).toBe(true)
      expect(row().run_count).toBe(1)
    } finally {
      await agent.disposeAsync()
    }
  })
})

describe('timer ticks while the agent is in error (evaluator)', () => {
  beforeEach(() => clearAllUmbilicalBuses())

  function evaluatorOn(name: string, targets = [{ scope: 'system' }, { scope: 'agent' }]) {
    const { workspace } = makeWorkspace(name)
    const config = {
      id: 'test-agent', name,
      triggers: { on_timer: { enabled: true, targets } },
    } as unknown as AgentConfig
    const evaluator = new TriggerEvaluator(config)
    evaluator.setWorkspace(workspace)
    const fired: (AdfEventDispatch | AdfBatchDispatch)[] = []
    evaluator.on('trigger', (d: AdfEventDispatch | AdfBatchDispatch) => fired.push(d))
    const tick = () => (evaluator as unknown as { checkTimers: () => void }).checkTimers()
    const payloadsFired = () => fired.map(d => ('event' in d ? (d.event.data as { timer: { payload?: string } }).timer.payload : null))
    return { workspace, evaluator, fired, tick, payloadsFired }
  }

  it('interval and cron timers missed several times during error fire once on recovery, not once per missed run', () => {
    const { workspace, evaluator, tick, payloadsFired } = evaluatorOn('recurring')
    const minute = 60_000
    const missedSince = Date.now() - 5 * minute
    const interval = workspace.addTimer({ mode: 'interval', every_ms: minute } as never, missedSince, 'EVERY-MINUTE', ['agent'])
    const cron = workspace.addTimer({ mode: 'cron', cron: '* * * * *' } as never, missedSince, 'CRON-MINUTE', ['agent'])
    const rows = () => workspace.getTimers().filter(r => r.id === interval || r.id === cron)

    evaluator.setDisplayState('error')
    tick(); tick(); tick()
    expect(payloadsFired()).toEqual([])
    for (const r of rows()) {
      expect(r.run_count).toBe(0)
      expect(r.next_wake_at).toBe(missedSince)
    }

    evaluator.setDisplayState('idle')
    tick()
    expect(payloadsFired().sort()).toEqual(['CRON-MINUTE', 'EVERY-MINUTE'])
    tick(); tick()
    expect(payloadsFired().length).toBe(2)
    for (const r of rows()) {
      expect(r.run_count).toBe(1)
      expect(r.next_wake_at).toBeGreaterThan(Date.now())
    }
  })

  it.each(['error', 'suspended', 'off'])('a once agent timer due while %s is held, then fires once when the agent is idle', (state) => {
    const { workspace, evaluator, tick, payloadsFired } = evaluatorOn(`held-${state}`)
    const due = Date.now() - 1000
    const t = workspace.addTimer({ mode: 'once', at: due } as never, due, 'REMIND', ['agent'])
    const row = () => workspace.getTimers().find(r => r.id === t) as { expired?: boolean; run_count: number }

    evaluator.setDisplayState(state)
    tick(); tick()
    expect(payloadsFired()).toEqual([])
    expect(row().expired ?? false).toBe(false)
    expect(row().run_count).toBe(0)

    evaluator.setDisplayState('idle')
    tick(); tick()
    expect(payloadsFired()).toEqual(['REMIND'])
    expect(row().expired).toBe(true)
    expect(row().run_count).toBe(1)
  })

  it('the hold reads the scopes on_timer admits, not the timer\'s own: a system+agent timer under agent-only on_timer is held in error', () => {
    // system scope can fire in error, but on_timer does not admit it here, so
    // every admitted scope is blocked and the timer must be held.
    const { workspace, evaluator, fired, tick, payloadsFired } = evaluatorOn('admitted-only', [{ scope: 'agent' }])
    const due = Date.now() - 1000
    const t = workspace.addTimer({ mode: 'once', at: due } as never, due, 'ADMITTED', ['system', 'agent'])
    const row = () => workspace.getTimers().find(r => r.id === t) as { expired?: boolean; run_count: number }

    evaluator.setDisplayState('error')
    tick()
    expect(fired.length).toBe(0)
    expect(row().expired ?? false).toBe(false)
    expect(row().run_count).toBe(0)

    evaluator.setDisplayState('idle')
    tick(); tick()
    expect(payloadsFired()).toEqual(['ADMITTED'])
    expect(fired.map(d => d.scope)).toEqual(['agent'])
    expect(row().expired).toBe(true)
    expect(row().run_count).toBe(1)
  })

  it('an agent once timer due in hibernate fires and is settled on the first tick', () => {
    // hibernate admits agent scope only for on_timer; the hold must not catch it.
    const { workspace, evaluator, fired, tick, payloadsFired } = evaluatorOn('hibernate')
    const due = Date.now() - 1000
    const t = workspace.addTimer({ mode: 'once', at: due } as never, due, 'WAKE', ['agent'])
    const row = () => workspace.getTimers().find(r => r.id === t) as { expired?: boolean; run_count: number }

    evaluator.setDisplayState('hibernate')
    tick()
    expect(payloadsFired()).toEqual(['WAKE'])
    expect(fired[0].scope).toBe('agent')
    expect(row().expired).toBe(true)
    expect(row().run_count).toBe(1)
  })

  it('a system-scope timer due while off is held, then fires once when the agent is idle', () => {
    const { workspace, evaluator, fired, tick } = evaluatorOn('system-off')
    const due = Date.now() - 1000
    const t = workspace.addTimer({ mode: 'once', at: due } as never, due, 'SYS', ['system'], 'lib/job.js:main')
    const row = () => workspace.getTimers().find(r => r.id === t) as { expired?: boolean; run_count: number }

    evaluator.setDisplayState('off')
    tick()
    expect(fired.length).toBe(0)
    expect(row().expired ?? false).toBe(false)
    expect(row().run_count).toBe(0)

    evaluator.setDisplayState('idle')
    tick(); tick()
    expect(fired.length).toBe(1)
    expect(fired[0].scope).toBe('system')
    expect(row().expired).toBe(true)
  })

  it('system-scope timers keep firing and settling during error', () => {
    const { workspace, evaluator, fired, tick } = evaluatorOn('system')
    const due = Date.now() - 1000
    const t = workspace.addTimer({ mode: 'once', at: due } as never, due, 'SYS', ['system'], 'lib/job.js:main')

    evaluator.setDisplayState('error')
    tick()
    expect(fired.length).toBe(1)
    expect(fired[0].scope).toBe('system')
    const row = workspace.getTimers().find(r => r.id === t) as { expired?: boolean; run_count: number }
    expect(row.expired).toBe(true)
    expect(row.run_count).toBe(1)
  })

  it('known loss: a mixed system+agent once timer due during error fires only system and is settled', () => {
    const { workspace, evaluator, fired, tick } = evaluatorOn('mixed-lambda')
    const due = Date.now() - 1000
    const t = workspace.addTimer({ mode: 'once', at: due } as never, due, 'MIXED', ['system', 'agent'], 'lib/job.js:main')
    const row = () => workspace.getTimers().find(r => r.id === t) as { expired?: boolean; run_count: number }

    evaluator.setDisplayState('error')
    tick()
    expect(fired.map(d => d.scope)).toEqual(['system'])
    expect(row().expired).toBe(true)
    expect(row().run_count).toBe(1)

    evaluator.setDisplayState('idle')
    tick(); tick()
    expect(fired.map(d => d.scope)).toEqual(['system'])
    expect(row().run_count).toBe(1)
  })

  it('known loss: a mixed system+agent once timer with no lambda due during error is settled with nothing run', () => {
    const { workspace, evaluator, fired, tick } = evaluatorOn('mixed-nolambda')
    const due = Date.now() - 1000
    const t = workspace.addTimer({ mode: 'once', at: due } as never, due, 'MIXED-NOLAMBDA', ['system', 'agent'])
    const row = () => workspace.getTimers().find(r => r.id === t) as { expired?: boolean; run_count: number }

    evaluator.setDisplayState('error')
    tick()
    expect(fired.length).toBe(0)
    expect(row().expired).toBe(true)
    expect(row().run_count).toBe(1)

    evaluator.setDisplayState('idle')
    tick(); tick()
    expect(fired.length).toBe(0)
    expect(row().run_count).toBe(1)
  })
})
