/**
 * UI ↔ runtime parity grid for timers (idea from the old branch's grid,
 * adapted to append-at-fire).
 *
 * Drives the real runtime (AgentRuntimeBuilder: assembleAgent, TriggerEvaluator,
 * LoopPool, LoopRuntime, the executors) with ticks by hand and, at every cell,
 * compares
 *
 *   predicted: the Timers tab countdown (timerCountdown over the real
 *              getTimers row), the Overview's Upcoming countdown
 *              (wakeCountdown over a real readUpcoming row) and the Overview's
 *              next wake (nextFiringWake), each from the renderer store as fed
 *              by the executors' own state_changed events, and again from the
 *              start/re-attach snapshot;
 *   actual:    whether the next tick settles the row. Under append-at-fire a
 *              row settles exactly when it fires: its agent part is written
 *              into the target loop, or (system-only) its lambda is dispatched.
 *
 * Grid: main state (idle, hibernate, suspended, error with budget, error in
 * cooldown, error after auth) × the inner loop's state (idle, error after a
 * failed turn, error after auth) × on_timer targets (both, agent, system) ×
 * timer scopes (and their order) × target loop (main, inner, missing,
 * disabled).
 *
 * Executors are stubbed after their state is reached (executeTurn records
 * instead of running), so a cell never changes the facts of the next one.
 * hibernate and suspended are published by hand on the two paths the executor
 * uses (the evaluator's setDisplayState and the store's setState).
 */
import { describe, expect, it, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { AgentRuntimeBuilder } from '../../../src/main/runtime/agent-runtime-builder'
import { createHeadlessAgent, MockLLMProvider } from '../../../src/main/runtime/headless'
import { clearAllUmbilicalBuses } from '../../../src/main/runtime/umbilical-bus'
import { createDispatch, createEvent } from '../../../src/shared/types/adf-event.types'
import type { CreateMessageOptions, LLMProvider } from '../../../src/main/providers/provider.interface'
import type { LLMResponse } from '../../../src/shared/types/provider.types'
import { readUpcoming } from '../../../src/main/services/agent-vitals'
import { useAgentStore } from '../../../src/renderer/stores/agent.store'
import * as model from '../../../src/renderer/components/agent/overview/agent-overview-model'

class Provider implements LLMProvider {
  readonly name = 'grid-provider'
  readonly modelId = 'grid-model-v1'
  constructor(public mode: 'ok' | 'fail' | 'auth' = 'ok') {}
  async createMessage(_o: CreateMessageOptions): Promise<LLMResponse> {
    if (this.mode === 'auth') throw Object.assign(new Error('401 Unauthorized: invalid api key'), { status: 401 })
    if (this.mode === 'fail') throw new Error('unrecognized executor fault')
    return { id: 'r', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }
  }
  async validateConfig() { return { valid: true } }
}

type Agent = Awaited<ReturnType<AgentRuntimeBuilder['build']>>
type Executor = Agent['executor']
type Pool = { getRuntime: (n: string) => { executor: Executor }; sideLoopStates: () => Record<string, string>; sideLoopRecoveryAt?: () => Record<string, number> }

const MAIN_STATES = ['idle', 'hibernate', 'suspended', 'error-budget', 'error-cooldown', 'error-auth'] as const
const INNER_STATES = ['idle', 'error-failed', 'error-auth'] as const
const TARGETS = { both: ['system', 'agent'], agent: ['agent'], system: ['system'] } as const
const SCOPES = [['agent'], ['system'], ['system', 'agent'], ['agent', 'system']] as const
const LOOPS = ['main', 'side', 'ghost', 'off'] as const
const LOOP_DECLS = [
  { name: 'side', goal: 'Side.', enabled: true, autostart: false, tools: [] },
  { name: 'off', goal: 'Off.', enabled: false, autostart: false, tools: [] },
]

const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

const chat = (text: string) => createDispatch(createEvent({ type: 'chat', source: 'test', data: { message: { seq: 0, role: 'user', content_json: [{ type: 'text', text }], created_at: Date.now() } } }), { scope: 'agent' })
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(r => setImmediate(r)) }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Feed an executor's state_changed into the renderer store, as useAgent does. */
function publishTo(executor: Executor, loop: string) {
  executor.on('event', (e: { type: string; payload: { state: string; recovery_at?: number | null } }) => {
    if (e.type === 'state_changed') useAgentStore.getState().setState(e.payload.state, loop === 'main' ? undefined : loop, e.payload.recovery_at)
  })
}

/** Record dispatches instead of running them, so the reached state holds. */
function record(executor: Executor) {
  (executor as unknown as { executeTurn: () => Promise<void> }).executeTurn = async () => {}
}

async function buildCase(main: typeof MAIN_STATES[number], inner: typeof INNER_STATES[number], targets: readonly string[]) {
  clearAllUmbilicalBuses()
  useAgentStore.getState().reset()
  const dir = mkdtempSync(join(tmpdir(), 'adf-grid-'))
  dirs.push(dir)
  const filePath = join(dir, 'grid.adf')
  createHeadlessAgent({ filePath, name: 'grid', provider: new MockLLMProvider() }).dispose()
  const workspace = AdfWorkspace.open(filePath)
  const config = workspace.getAgentConfig()
  config.triggers = { ...config.triggers, on_timer: { enabled: true, targets: targets.map(scope => ({ scope })) } } as typeof config.triggers
  ;(config as unknown as { loops: unknown[] }).loops = LOOP_DECLS
  workspace.setAgentConfig(config)
  const provider = new Provider('ok')
  const maxAttempts = main === 'error-cooldown' ? 1 : 5
  const agent = await new AgentRuntimeBuilder().build({
    workspace, filePath, provider,
    config: { ...config, recovery: { auto_retry: true, max_attempts: maxAttempts, base_delay_ms: 600_000, max_delay_ms: 600_000 } },
  })
  await (agent as unknown as { start?: () => Promise<void> }).start?.()
  agent.triggerEvaluator.stopTimerPolling()
  const store = useAgentStore.getState()
  store.setConfig(workspace.getAgentConfig())
  store.setState('idle')
  const pool = (agent as unknown as { loopPool: Pool }).loopPool
  const side = pool.getRuntime('side')
  publishTo(agent.executor, 'main')
  publishTo(side.executor, 'side')

  if (inner !== 'idle') {
    provider.mode = inner === 'error-auth' ? 'auth' : 'fail'
    await side.executor.executeTurn(chat('inner fails'))
  }
  if (main.startsWith('error')) {
    provider.mode = main === 'error-auth' ? 'auth' : 'fail'
    await agent.executor.executeTurn(chat('main fails'))
  } else if (main !== 'idle') {
    agent.triggerEvaluator.setDisplayState(main)
    useAgentStore.getState().setState(main)
  }
  await sleep(20)
  provider.mode = 'ok'
  record(agent.executor)
  record(side.executor)
  return { agent, workspace, pool }
}

/** The renderer's view after a start or re-attach: what the snapshot carries. */
function reattach(agent: Agent, workspace: AdfWorkspace, pool: Pool) {
  const store = useAgentStore.getState()
  store.reset()
  store.setConfig(workspace.getAgentConfig())
  const recoveryAt = (agent.executor as unknown as { getRecoveryAt?: () => number | null }).getRecoveryAt?.() ?? undefined
  store.setState(agent.triggerEvaluator.getDisplayState(), undefined, recoveryAt)
  const recovery = pool.sideLoopRecoveryAt?.() ?? {}
  for (const [loop, state] of Object.entries(pool.sideLoopStates())) store.setState(state, loop, recovery[loop])
}

interface Mismatch { cell: string; tab: boolean; upcoming: boolean; next: boolean; acted: boolean }

async function runCells(label: string, agent: Agent, workspace: AdfWorkspace, out: Mismatch[]) {
  const tick = () => (agent.triggerEvaluator as unknown as { checkTimers: () => void }).checkTimers()
  const q = (s: string, p?: unknown[]) => workspace.querySQL(s, p as never)
  const m = model as unknown as Record<string, (...a: unknown[]) => unknown>
  let cells = 0
  for (const scopes of SCOPES) {
    for (const loop of LOOPS) {
      const payload = `GRID-${label}-${scopes.join('+')}-${loop}`
      const due = Date.now() - 1000
      const id = workspace.addTimer({ mode: 'interval', every_ms: 3_600_000 } as never, due, payload, [...scopes], 'lib/job.js:main', undefined, undefined, loop === 'main' ? undefined : loop)
      const row = workspace.getTimers().find(t => t.id === id)!
      const up = readUpcoming(q as never).find(u => u.id === id)!
      const s = useAgentStore.getState() as unknown as { gate: string; recoveryAt?: number | null; config: unknown; loopGateFacts?: unknown }
      const facts = { state: s.gate, recoveryAt: s.recoveryAt } // as useGateFacts reads the store
      const ctx = m.timerContext?.(s.config, s.loopGateFacts ?? {})
      const now = Date.now()
      const tabAt = m.timerCountdown(row, facts, (at: number) => String(at), ctx) as string | null
      const tab = tabAt !== null && Number(tabAt) <= now
      const upcoming = m.wakeCountdown(up, facts, now, ctx) === 'due'
      const nextAt = m.nextFiringWake([row], facts, ctx) as number | undefined
      const next = nextAt !== undefined && nextAt <= now
      tick()
      await flush()
      const acted = (workspace.getTimers().find(t => t.id === id)?.run_count ?? 0) > 0
      if (tab !== acted || upcoming !== acted || next !== acted) {
        out.push({ cell: `${label} scopes=${scopes.join('+')} loop=${loop}`, tab, upcoming, next, acted })
      }
      workspace.deleteTimer(id)
      cells++
    }
  }
  return cells
}

describe('timer UI ↔ runtime parity grid', { timeout: 600_000 }, () => {
  it('the Timers tab and the Overview predict, at every cell, what the runtime does on the next tick (live and after a re-attach)', async () => {
    const mismatches: Mismatch[] = []
    let cells = 0
    for (const main of MAIN_STATES) {
      for (const inner of INNER_STATES) {
        for (const [tname, targets] of Object.entries(TARGETS)) {
          const { agent, workspace, pool } = await buildCase(main, inner, targets)
          try {
            const label = `main=${main} inner=${inner} targets=${tname}`
            cells += await runCells(`${label} live`, agent, workspace, mismatches)
            reattach(agent, workspace, pool)
            cells += await runCells(`${label} reattach`, agent, workspace, mismatches)
          } finally {
            await agent.disposeAsync()
            try { workspace.close() } catch { /* closed by the agent */ }
          }
        }
      }
    }
    const byKind: Record<string, number> = {}
    for (const x of mismatches) {
      const kind = x.cell.replace(/ scopes=\S+/, '').replace(/ (live|reattach)/, '')
      byKind[kind] = (byKind[kind] ?? 0) + 1
    }
    console.log('GRID cells', cells, 'mismatches', mismatches.length, JSON.stringify(byKind))
    for (const x of mismatches.slice(0, 40)) console.log('GRID-MISMATCH', JSON.stringify(x))
    expect(cells).toBe(MAIN_STATES.length * INNER_STATES.length * 3 * 2 * SCOPES.length * LOOPS.length)
    expect(mismatches).toEqual([])
  })
})
