import { describe, it, expect, vi } from 'vitest'
import { CodeSandboxService } from '../../../src/main/runtime/code-sandbox'

/**
 * Regression suite for the global resource ceiling.
 *
 * Partitioning cold lambdas by per-invocation sandbox id removed an accidental
 * bound: 20 concurrent cold invocations went from one shared worker (+6.9 MB) to
 * 20 workers (+88 MB), and a 10-agent x 3-lane x 4-concurrent burst reached 120
 * live workers / 133 OS threads / +585 MB. Warm sandboxes went from one per
 * agent to one per source file with nothing ever evicting them, so residency
 * scaled with triggers *declared* rather than with load.
 *
 * CodeSandboxService is the process-wide singleton, so it is the only component
 * that sees every agent — the cap lives there.
 */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const HOLD = 'await new Promise(r => setTimeout(r, 250)); return "held";'

/** The private worker map — resource accounting has no public mutator. */
function workersOf(sandbox: CodeSandboxService): Map<string, { lastUsed: number; ephemeral: boolean }> {
  return (sandbox as unknown as {
    workers: Map<string, { lastUsed: number; ephemeral: boolean }>
  }).workers
}

describe('CodeSandboxService global admission control', () => {
  it('caps concurrent cold-lambda workers and queues the rest instead of dropping them', async () => {
    const sandbox = new CodeSandboxService()
    sandbox.setMaxWorkers(2)

    let peak = 0
    const poll = setInterval(() => { peak = Math.max(peak, workersOf(sandbox).size) }, 10)

    try {
      const ids = Array.from({ length: 8 }, (_, i) => `res-cold-${i}`)
      const results = await Promise.all(ids.map(async (id) => {
        const r = await sandbox.execute(id, HOLD, 20000, undefined, undefined, { ephemeral: true })
        sandbox.destroy(id) // cold sandboxes are torn down by their caller
        return r
      }))
      clearInterval(poll)

      // Every execution ran — the gate blocks with a deadline, it never drops.
      expect(results).toHaveLength(8)
      expect(results.every((r) => r.result === 'held')).toBe(true)
      expect(results.every((r) => !r.error)).toBe(true)
      // ...but never more than the ceiling at a time.
      expect(peak).toBeLessThanOrEqual(2)
      expect(peak).toBeGreaterThan(0)
      expect(sandbox.getResourceStats().cold).toBe(0)
    } finally {
      clearInterval(poll)
      sandbox.destroyAll()
    }
  }, 60000)

  it('reports the ceiling in one aggregate warning, not one per agent', async () => {
    const sandbox = new CodeSandboxService()
    sandbox.setMaxWorkers(1)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      const ids = Array.from({ length: 6 }, (_, i) => `res-warn-${i}`)
      await Promise.all(ids.map(async (id) => {
        await sandbox.execute(id, HOLD, 20000, undefined, undefined, { ephemeral: true })
        sandbox.destroy(id)
      }))

      const saturation = warn.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes('global worker ceiling is binding'))
      // Five executions blocked; one warning names the shared cause.
      expect(saturation).toHaveLength(1)
      expect(saturation[0]).toContain('queued')
    } finally {
      warn.mockRestore()
      sandbox.destroyAll()
    }
  }, 60000)

  it('raising the ceiling releases queued executions immediately', async () => {
    const sandbox = new CodeSandboxService()
    sandbox.setMaxWorkers(1)

    try {
      // One long-lived cold worker holds the only permit.
      const holder = sandbox.execute(
        'res-raise-holder', 'await new Promise(r => setTimeout(r, 2500)); return "h";',
        20000, undefined, undefined, { ephemeral: true }
      )
      await sleep(300)

      const t0 = Date.now()
      const queued = sandbox.execute('res-raise-queued', 'return "q"', 20000, undefined, undefined,
        { ephemeral: true })
      await sleep(200)
      expect(sandbox.getResourceStats().waiting).toBe(1)

      sandbox.setMaxWorkers(4)
      const r = await queued
      const elapsed = Date.now() - t0

      expect(r.result).toBe('q')
      // Released by the setting change, not by the holder finishing at ~2.5s.
      expect(elapsed).toBeLessThan(1500)
      await holder
    } finally {
      sandbox.destroyAll()
    }
  }, 60000)

  it('evicts the least recently used idle warm resident when the count cap binds', async () => {
    const sandbox = new CodeSandboxService()
    // The user-facing setting derives a warm cap generous enough that it never
    // thrashes; shrink it directly so the eviction path is testable in seconds.
    ;(sandbox as unknown as { maxWarmWorkers: number }).maxWarmWorkers = 2

    try {
      await sandbox.execute('res-warm-a', 'globalThis.mark = "a"; return 1', 10000)
      await sleep(20)
      await sandbox.execute('res-warm-b', 'return 1', 10000)
      await sleep(20)
      expect(workersOf(sandbox).size).toBe(2)

      // Third resident: 'a' is the least recently used, so it goes.
      await sandbox.execute('res-warm-c', 'return 1', 10000)
      expect(workersOf(sandbox).has('res-warm-a')).toBe(false)
      expect(workersOf(sandbox).has('res-warm-b')).toBe(true)
      expect(workersOf(sandbox).has('res-warm-c')).toBe(true)

      // Eviction is transparent to the agent — the sandbox comes back, minus
      // the module state it had parked (the documented cost of the TTL).
      const back = await sandbox.execute('res-warm-a', 'return typeof globalThis.mark', 10000)
      expect(back.result).toBe('undefined')
    } finally {
      sandbox.destroyAll()
    }
  }, 60000)

  it('reaps warm residents that have been idle past their TTL', async () => {
    const sandbox = new CodeSandboxService()

    try {
      await sandbox.execute('res-ttl-idle', 'return 1', 10000)
      expect(workersOf(sandbox).has('res-ttl-idle')).toBe(true)

      // Age it past WARM_IDLE_TTL_MS (5 minutes). The sweep is lazy — it runs
      // on the next admission rather than on a timer, so the service never
      // holds the event loop open.
      workersOf(sandbox).get('res-ttl-idle')!.lastUsed = Date.now() - 10 * 60_000
      await sandbox.execute('res-ttl-other', 'return 1', 10000)

      expect(workersOf(sandbox).has('res-ttl-idle')).toBe(false)
      expect(sandbox.getResourceStats().warm).toBe(1)
    } finally {
      sandbox.destroyAll()
    }
  }, 60000)
})

describe('CodeSandboxService destroyForAgent', () => {
  it('reaps the agent\'s derived sandboxes from the registry', async () => {
    const sandbox = new CodeSandboxService()
    const agent = 'C:\\agents\\alpha.adf'

    try {
      await sandbox.execute(agent, 'return 1', 10000, undefined, undefined, { agent })
      await sandbox.execute(`${agent}:lambda:lib/x.ts`, 'return 1', 10000, undefined, undefined, { agent })
      await sandbox.execute(`${agent}:tap:0`, 'return 1', 10000, undefined, undefined, { agent })
      expect(workersOf(sandbox).size).toBe(3)

      sandbox.destroyForAgent(agent)
      expect(workersOf(sandbox).size).toBe(0)
    } finally {
      sandbox.destroyAll()
    }
  }, 60000)

  it('never reaps another agent\'s sandboxes just because its id is a path prefix', async () => {
    // Sandbox ids are absolute Windows paths, and `config.id` comes from the
    // .adf file. Prefix matching meant an agent declaring `id: "C"` produced
    // destroyForAgent('C'), which matched the prefix `C:` and tore down every
    // path-keyed sandbox in the process.
    const sandbox = new CodeSandboxService()
    const victim = 'C:\\agents\\victim.adf'

    try {
      await sandbox.execute(victim, 'return 1', 10000, undefined, undefined, { agent: victim })
      await sandbox.execute(`${victim}:lambda:lib/y.ts`, 'return 1', 10000, undefined, undefined,
        { agent: victim })
      expect(workersOf(sandbox).size).toBe(2)

      sandbox.destroyForAgent('C')
      expect(workersOf(sandbox).size).toBe(2)

      sandbox.destroyForAgent(victim)
      expect(workersOf(sandbox).size).toBe(0)
    } finally {
      sandbox.destroyAll()
    }
  }, 60000)
})
