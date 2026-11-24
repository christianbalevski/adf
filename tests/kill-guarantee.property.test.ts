// Kill is guaranteed: a start asked for before or during a Kill is never
// carried out after it, and only a start asked for after it reopens the gate.
// The example tests in daemon-fleet-api.test.ts pin one ordering each. Here
// each interleaving point (directory scan, provider resolution, Kill pass, unload)
// yields to a scheduler, and the outcome is checked against when each request
// was made. fast-check explores orderings at random; orderings it found that
// need a precise sequence are pinned below so they run every time. A start
// asked for after the last Kill must load the agent.
//
// The runtime refuses a mid-Kill load at entry and again at registration, so
// removing one guard alone changes no outcome; removing both fails the pinned
// cases.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AdfWorkspace } from '../src/main/adf/adf-workspace'
import { createDaemonHttpApi } from '../src/main/daemon/http-api'
import { MockLLMProvider, createHeadlessAgent } from '../src/main/runtime/headless'
import { RuntimeGate } from '../src/main/runtime/runtime-gate'
import { RuntimeService } from '../src/main/runtime/runtime-service'

const HOLDER = '00000000-0000-4000-8000-000000000001'
const AGENTS = 2

type Op =
  | { kind: 'kill' }
  | { kind: 'start'; agent: number }
  | { kind: 'load'; agent: number }
  | { kind: 'open'; agent: number }
  | { kind: 'autostart' }
  // Lets one scheduled step run before the next request.
  | { kind: 'tick' }

/** Releases steps oldest first (each id in turn; more ids than any run schedules). */
const fifo = () => fc.schedulerFor(Array.from({ length: 500 }, (_, i) => i + 1))

function seed(dir: string, n: number): { filePath: string; id: string } {
  const filePath = join(dir, `agent-${n}.adf`)
  createHeadlessAgent({ filePath, name: `agent-${n}`, provider: new MockLLMProvider(), createOptions: { handle: `agent-${n}`, start_in_state: 'hibernate' } }).dispose()
  const ws = AdfWorkspace.open(filePath)
  const config = ws.getAgentConfig()
  ws.setAgentConfig({ ...config, autostart: true })
  ws.close()
  return { filePath, id: config.id }
}

async function scenario(sched: fc.Scheduler, ops: Op[]): Promise<void> {
  RuntimeGate._resetForTests()
  const dir = mkdtempSync(join(tmpdir(), 'adf-kill-property-'))
  const agents = Array.from({ length: AGENTS }, (_, n) => seed(dir, n))
  // Reviewed, so autostart loads them.
  const reviewed = agents.map((a) => a.id)
  const settings = { get: (key: string) => (key === 'reviewedAgents' ? reviewed : undefined), set: () => {} }
  // Leases and asynchronous filesystem scans have their own integration
  // tests. Here the scheduler controls when each scan and load can proceed.
  const runtime = new RuntimeService({ settings, agentLeases: null, enforceReviewGate: false, providerFactory: () => new MockLLMProvider() })
  vi.spyOn(runtime, 'scanAdfFilesAsync').mockImplementation(async (dirs, maxDepth) => {
    await sched.schedule(Promise.resolve(), 'autostart scan')
    return runtime.scanAdfFiles(dirs, maxDepth)
  })
  const server = createDaemonHttpApi(runtime, { settingsStore: settings })

  type Async = (...a: unknown[]) => Promise<unknown>
  const yieldAt = (name: string, label: string) => {
    const target = runtime as unknown as Record<string, Async>
    const original = target[name].bind(runtime)
    vi.spyOn(target, name).mockImplementation((...a: unknown[]) => sched.schedule(Promise.resolve(), label).then(() => original(...a)))
  }
  yieldAt('resolveProvider', 'provider')
  yieldAt('settleLoads', 'kill pass')
  yieldAt('unloadAgent', 'unload')

  // Request order on one clock: a start is asked for when it is called (its
  // Kill epoch is taken then); a Kill begins when beginKill runs.
  let clock = 0
  let lastKillAt = -1
  let killBegan: (() => void) | null = null
  const beginKill = RuntimeGate.beginKill.bind(RuntimeGate)
  vi.spyOn(RuntimeGate, 'beginKill').mockImplementation(() => {
    lastKillAt = clock++
    killBegan?.()
    return beginKill()
  })
  const asks: { t: number; midKill: boolean }[][] = agents.map(() => [])
  const ask = (n: number) => asks[n].push({ t: clock, midKill: RuntimeGate.killing })
  const pending: Promise<unknown>[] = []
  const settle = (p: Promise<unknown>) => pending.push(p.catch(() => undefined))

  try {
    await server.ready()
    for (const o of ops) {
      if (o.kind === 'kill') {
        const began = new Promise<void>((resolve) => { killBegan = resolve })
        settle(server.inject({ method: 'POST', url: '/runtime/emergency-stop' }))
        await began
        killBegan = null
      } else if (o.kind === 'start') {
        ask(o.agent); clock++
        settle(runtime.startOrLoadAgent(agents[o.agent].filePath))
      } else if (o.kind === 'load') {
        ask(o.agent); clock++
        settle(runtime.loadAgent(agents[o.agent].filePath))
      } else if (o.kind === 'autostart') {
        agents.forEach((_, n) => ask(n)); clock++
        settle(runtime.autostartFromDirectories([dir], { maxDepth: 0 }))
      } else if (o.kind === 'open') {
        settle(runtime.openDocument(agents[o.agent].filePath, { holder: HOLDER }).then(() => runtime.releaseDocument(agents[o.agent].id, HOLDER)))
      } else if (sched.count() > 0) {
        await sched.waitOne()
      }
      // Let promise continuations reach the next controlled step before
      // issuing another request.
      await setImmediate()
    }
    // The scheduler releases new steps as they appear, including steps an
    // earlier release queued after returning.
    await sched.waitFor(Promise.all(pending))

    // A start counts only if it was asked for after the last Kill began and
    // while no Kill was running.
    const counts = (a: { t: number; midKill: boolean }) => a.t > lastKillAt && !a.midKill
    const loaded = new Set(runtime.listAgents().map((a) => a.id))
    agents.forEach((agent, n) => {
      expect(loaded.has(agent.id), `agent-${n}: loaded must match whether a start for it counts. Ops: ${JSON.stringify(ops)}`).toBe(asks[n].some(counts))
    })
    if (lastKillAt >= 0 && !asks.some((a) => a.some(counts))) {
      expect(RuntimeGate.killing).toBe(false)
      expect(RuntimeGate.stopped, 'the gate reopened with no start after the Kill').toBe(true)
    }
  } finally {
    vi.restoreAllMocks()
    for (const a of runtime.listAgents()) await runtime.unloadAgent(a.id, { mode: 'immediate' }).catch(() => undefined)
    await server.close()
    await runtime.shutdownAll({ agentTimeoutMs: 500 }).catch(() => undefined)
    rmSync(dir, { recursive: true, force: true })
  }
}

const agentIndex = fc.integer({ min: 0, max: AGENTS - 1 })
const op: fc.Arbitrary<Op> = fc.oneof(
  { arbitrary: fc.constant({ kind: 'kill' } as const), weight: 3 },
  { arbitrary: agentIndex.map((agent) => ({ kind: 'start', agent }) as const), weight: 3 },
  { arbitrary: agentIndex.map((agent) => ({ kind: 'load', agent }) as const), weight: 2 },
  { arbitrary: agentIndex.map((agent) => ({ kind: 'open', agent }) as const), weight: 2 },
  { arbitrary: fc.constant({ kind: 'autostart' } as const), weight: 1 },
  { arbitrary: fc.constant({ kind: 'tick' } as const), weight: 4 },
)

afterEach(() => {
  vi.restoreAllMocks()
  RuntimeGate._resetForTests()
})

describe('Kill guarantee', () => {
  it('holds for random interleavings of Kills, starts, loads, opens and autostarts', async () => {
    await fc.assert(
      fc.asyncProperty(fc.scheduler(), fc.array(op, { minLength: 1, maxLength: 16 }), (s, ops) => scenario(s, ops)),
      { numRuns: 100 },
    )
  }, 120_000)

  // Reaching these needs one exact order of steps, which random runs rarely hit.
  it.each<[string, Op[]]>([
    ['an autostart asked for during a Kill whose scan finishes afterwards', [
      { kind: 'kill' }, { kind: 'autostart' }, { kind: 'tick' }, { kind: 'tick' },
    ]],
    // Found with the load guards removed: the Kill is unloading a0 when a1
    // is asked for.
    ['a load asked for while the Kill unloads', [
      { kind: 'start', agent: 0 }, { kind: 'kill' }, { kind: 'tick' }, { kind: 'tick' }, { kind: 'load', agent: 1 },
    ]],
    ['a start asked for after the Kill loads the agent', [
      { kind: 'start', agent: 0 }, { kind: 'kill' }, { kind: 'tick' }, { kind: 'tick' }, { kind: 'tick' }, { kind: 'start', agent: 0 },
    ]],
    ['a start asked for while the Kill unloads', [
      { kind: 'start', agent: 0 }, { kind: 'kill' }, { kind: 'tick' }, { kind: 'tick' }, { kind: 'start', agent: 1 },
    ]],
  ])('%s', async (_name, ops) => {
    await scenario(fifo(), ops)
  }, 30_000)
})
