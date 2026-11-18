/**
 * Single-scope parity: the receipt rule changes only timers whose agent part
 * waits. For a system-only timer, and for an agent-only timer on a healthy idle
 * agent, the observable outcome is the same as before it: these assertions hold
 * on the base and on this branch. (The one disclosed difference — an agent
 * part's `timer.fired` is emitted when it is received, not at the tick — is
 * asserted by count here, not by timing.)
 *
 * Set PROBE_OUT to a file path to also write each scenario's observations as
 * JSON lines, for a base-vs-head diff.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { AgentRuntimeBuilder } from '../../../src/main/runtime/agent-runtime-builder'
import { createHeadlessAgent, MockLLMProvider } from '../../../src/main/runtime/headless'
import { clearAllUmbilicalBuses, ensureUmbilicalBus } from '../../../src/main/runtime/umbilical-bus'
import { createDispatch, createEvent } from '../../../src/shared/types/adf-event.types'
import type { AdfEventDispatch } from '../../../src/shared/types/adf-event.types'
import type { CreateMessageOptions, LLMProvider } from '../../../src/main/providers/provider.interface'
import type { LLMResponse } from '../../../src/shared/types/provider.types'

class OkProvider implements LLMProvider {
  readonly name = 'ok-provider'
  readonly modelId = 'ok-model-v1'
  calls = 0
  seen: string[] = []
  async createMessage(opts: CreateMessageOptions): Promise<LLMResponse> {
    this.calls++
    this.seen.push(JSON.stringify(opts.messages))
    return { id: `r${this.calls}`, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }
  }
  async validateConfig() { return { valid: true } }
}

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
beforeEach(() => clearAllUmbilicalBuses())

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
type Agent = Awaited<ReturnType<AgentRuntimeBuilder['build']>>
const tick = (agent: Agent) => (agent.triggerEvaluator as unknown as { checkTimers: () => void }).checkTimers()

async function settled(agent: Agent) {
  let quiet = 0
  const start = Date.now()
  while (quiet < 5) {
    if (Date.now() - start > 4000) throw new Error('timed out waiting for the agent to settle')
    quiet = agent.executor.isTurnActive() || agent.hasInFlightDispatch() ? 0 : quiet + 1
    await sleep(10)
  }
}

async function setup(name: string, targets: Array<{ scope: string }>) {
  const dir = mkdtempSync(join(tmpdir(), `adf-parity-${name}-`))
  dirs.push(dir)
  const filePath = join(dir, `${name}.adf`)
  createHeadlessAgent({ filePath, name, provider: new MockLLMProvider() }).dispose()
  const workspace = AdfWorkspace.open(filePath)
  const config = workspace.getAgentConfig()
  config.triggers = { ...config.triggers, on_timer: { enabled: true, targets } } as typeof config.triggers
  workspace.setAgentConfig(config)
  const provider = new OkProvider()
  const agent = await new AgentRuntimeBuilder().build({ workspace, filePath, provider, config })
  await (agent as unknown as { start?: () => Promise<void> }).start?.()
  agent.triggerEvaluator.stopTimerPolling()
  const lambdaRuns: string[] = []
  let holdLambdas: Promise<void> | null = null
  agent.executor.setSystemScopeHandler({
    execute: async (d: AdfEventDispatch) => {
      lambdaRuns.push(String((d.event.data as { timer?: { payload?: string } } | undefined)?.timer?.payload))
      if (holdLambdas) await holdLambdas
    },
    executeBatch: async () => {},
  } as never)
  const fired: Array<{ scope: string; run_count: number }> = []
  ensureUmbilicalBus(config.id).subscribe(e => { if (e.event_type === 'timer.fired') fired.push(e.payload as never) })
  return {
    agent, workspace, provider, lambdaRuns, fired,
    hold(p: Promise<void> | null) { holdLambdas = p },
  }
}

function observe(name: string, s: Awaited<ReturnType<typeof setup>>, id: number, payload: string) {
  const r = s.workspace.getTimers().find(t => t.id === id)!
  const obs = {
    scenario: name,
    expired: r.expired === true,
    run_count: r.run_count,
    last_fired_set: r.last_fired_at !== undefined,
    next_wake_future: r.next_wake_at > Date.now(),
    lambda_runs: s.lambdaRuns.filter(p => p === payload).length,
    provider_calls: s.provider.calls,
    provider_saw_payload: s.provider.seen.some(x => x.includes(payload)),
    loop_rows: s.workspace.getLoop().filter(e => JSON.stringify(e.content_json).includes(payload)).length,
    timer_fired: s.fired.length,
    fire_logs: s.workspace.getLogs().filter(l => l.event === 'on_timer').map(l => l.message.replace(/#\d+/, '#N')),
  }
  if (process.env.PROBE_OUT) appendFileSync(process.env.PROBE_OUT, JSON.stringify(obs) + '\n')
  return obs
}

function due(workspace: AdfWorkspace, payload: string, scope: string[], opts: { lambda?: string; every?: number } = {}) {
  const at = Date.now() - 1000
  const schedule = opts.every ? { mode: 'interval', every_ms: opts.every } : { mode: 'once', at }
  return workspace.addTimer(schedule as never, at, payload, scope, opts.lambda)
}

describe('system-only timers behave as before', { timeout: 20_000 }, () => {
  it('once: settled at the tick, lambda once, one timer.fired, one fire log', async () => {
    const s = await setup('sys-once', [{ scope: 'system' }])
    try {
      const id = due(s.workspace, 'SYS-ONCE', ['system'], { lambda: 'lib/job.js:main' })
      tick(s.agent)
      // Settled synchronously by the tick, before the lambda runs.
      expect(s.workspace.getTimers().find(t => t.id === id)!.expired).toBe(true)
      await settled(s.agent)
      tick(s.agent); tick(s.agent)
      await settled(s.agent)
      expect(observe('system-only once', s, id, 'SYS-ONCE')).toMatchObject({
        expired: true, run_count: 1, last_fired_set: true, lambda_runs: 1, provider_calls: 0, loop_rows: 0, timer_fired: 1,
        fire_logs: ['System timer #N fired → lambda lib/job.js:main'],
      })
    } finally {
      await s.agent.disposeAsync()
    }
  })

  it('interval: advanced at the tick, lambda once per occurrence', async () => {
    const s = await setup('sys-interval', [{ scope: 'system' }])
    try {
      const id = due(s.workspace, 'SYS-EVERY', ['system'], { lambda: 'lib/job.js:main', every: 3_600_000 })
      tick(s.agent)
      expect(s.workspace.getTimers().find(t => t.id === id)!.run_count).toBe(1)
      await settled(s.agent)
      tick(s.agent)
      await settled(s.agent)
      expect(observe('system-only interval', s, id, 'SYS-EVERY')).toMatchObject({
        expired: false, run_count: 1, last_fired_set: true, next_wake_future: true, lambda_runs: 1, timer_fired: 1,
      })
    } finally {
      await s.agent.disposeAsync()
    }
  })

  it('no lambda: settled with the skip log', async () => {
    const s = await setup('sys-nolambda', [{ scope: 'system' }])
    try {
      const id = due(s.workspace, 'SYS-NOLAMBDA', ['system'])
      tick(s.agent)
      await settled(s.agent)
      expect(observe('system-only no lambda', s, id, 'SYS-NOLAMBDA')).toMatchObject({
        expired: true, run_count: 1, lambda_runs: 0, timer_fired: 1,
        fire_logs: ['System timer #N fired but no lambda — skipped'],
      })
    } finally {
      await s.agent.disposeAsync()
    }
  })

  it('once, dropped by backpressure: rewound by rewindTimer and fired again', async () => {
    const s = await setup('sys-drop', [{ scope: 'system' }])
    let release!: () => void
    s.hold(new Promise<void>(r => { release = r }))
    try {
      const filler = () => createDispatch(createEvent({ type: 'timer', source: 'test', data: { timer: { id: -2, payload: 'FILL' } } as never }), { scope: 'system', lambda: 'lib/job.js:main' })
      const fills = Array.from({ length: 4 + 64 }, () => s.agent.executor.executeTurn(filler()).catch(() => {}))
      await sleep(50)
      const id = due(s.workspace, 'SYS-DROP', ['system'], { lambda: 'lib/job.js:main' })
      tick(s.agent)
      await sleep(100)
      const afterDrop = s.workspace.getTimers().find(t => t.id === id)!
      expect(afterDrop.expired === true).toBe(false)
      expect(afterDrop.run_count).toBe(0)
      expect(s.workspace.getLogs().some(l => l.message.includes('timer rewound, it will fire again'))).toBe(true)
      s.hold(null)
      release()
      await Promise.all(fills)
      tick(s.agent)
      await settled(s.agent)
      expect(observe('system-only once, backpressure drop', s, id, 'SYS-DROP')).toMatchObject({ expired: true, run_count: 1, lambda_runs: 1 })
    } finally {
      release()
      await s.agent.disposeAsync()
    }
  })

  it('held while off, fired once when idle', async () => {
    const s = await setup('sys-off', [{ scope: 'system' }])
    try {
      const id = due(s.workspace, 'SYS-OFF', ['system'], { lambda: 'lib/job.js:main' })
      s.agent.triggerEvaluator.setDisplayState('off')
      tick(s.agent); tick(s.agent)
      await sleep(50)
      expect(s.lambdaRuns).toHaveLength(0)
      expect(s.workspace.getTimers().find(t => t.id === id)!.run_count).toBe(0)
      s.agent.triggerEvaluator.setDisplayState('idle')
      tick(s.agent); tick(s.agent)
      await settled(s.agent)
      expect(observe('system-only held while off', s, id, 'SYS-OFF')).toMatchObject({ expired: true, run_count: 1, lambda_runs: 1 })
    } finally {
      await s.agent.disposeAsync()
    }
  })
})

describe('agent-only timers on a healthy idle agent behave as before', { timeout: 20_000 }, () => {
  it('once: one turn, one loop row, settled, one timer.fired', async () => {
    const s = await setup('agent-once', [{ scope: 'agent' }])
    try {
      const id = due(s.workspace, 'AGENT-ONCE', ['agent'])
      tick(s.agent)
      await settled(s.agent)
      tick(s.agent); tick(s.agent)
      await settled(s.agent)
      expect(observe('agent-only once, idle', s, id, 'AGENT-ONCE')).toMatchObject({
        expired: true, run_count: 1, last_fired_set: true, lambda_runs: 0,
        provider_calls: 1, provider_saw_payload: true, loop_rows: 1, timer_fired: 1, fire_logs: [],
      })
    } finally {
      await s.agent.disposeAsync()
    }
  })

  it('interval: one turn per occurrence, advanced', async () => {
    const s = await setup('agent-interval', [{ scope: 'agent' }])
    try {
      const id = due(s.workspace, 'AGENT-EVERY', ['agent'], { every: 3_600_000 })
      tick(s.agent)
      await settled(s.agent)
      tick(s.agent)
      await settled(s.agent)
      expect(observe('agent-only interval, idle', s, id, 'AGENT-EVERY')).toMatchObject({
        expired: false, run_count: 1, next_wake_future: true, provider_calls: 1, loop_rows: 1, timer_fired: 1,
      })
    } finally {
      await s.agent.disposeAsync()
    }
  })

  it('two due on one tick: both delivered, each once', async () => {
    const s = await setup('agent-two', [{ scope: 'agent' }])
    try {
      const a = due(s.workspace, 'AGENT-TWO-A', ['agent'])
      const b = due(s.workspace, 'AGENT-TWO-B', ['agent'])
      tick(s.agent)
      await settled(s.agent)
      tick(s.agent)
      await settled(s.agent)
      expect(observe('agent-only two on one tick (A)', s, a, 'AGENT-TWO-A')).toMatchObject({ expired: true, run_count: 1, loop_rows: 1, provider_calls: 2 })
      expect(observe('agent-only two on one tick (B)', s, b, 'AGENT-TWO-B')).toMatchObject({ expired: true, run_count: 1, loop_rows: 1, provider_calls: 2 })
    } finally {
      await s.agent.disposeAsync()
    }
  })
})
