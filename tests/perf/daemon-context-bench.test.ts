import { afterEach, describe, expect, it, vi } from 'vitest'
import { performance } from 'node:perf_hooks'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHeadlessAgent, MockLLMProvider } from '../../src/main/runtime/headless'
import { getTokenCounterService } from '../../src/main/services/token-counter.service'
import type { AgentExecutor } from '../../src/main/runtime/agent-executor'

/**
 * Public context reads through a real executor and file-backed SQLite workspace.
 * RUN_BENCH=1 enables wall-clock measurements (7 warmed batches, median ms/op).
 * BENCH_OUT writes results. BENCH_MEASURE_ONLY=1 skips regression assertions so
 * this exact file can also measure a pre-optimization checkout.
 * No provider network, HTTP transport, or UI scheduling is included.
 */
const RUN = process.env.RUN_BENCH === '1'
const MEASURE_ONLY = process.env.BENCH_MEASURE_ONLY === '1'
const cleanup: Array<() => void> = []
afterEach(() => { while (cleanup.length) cleanup.pop()!(); vi.restoreAllMocks() })
type ContextAccess = Pick<AgentExecutor, 'getContextBreakdown'> & {
  recordRequestContext(system: string, dynamic: string | undefined): void
  estimatePreflightTokens(baseline: number, dynamic: string | undefined): number
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'adf-context-bench-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const agent = createHeadlessAgent({
    name: 'context-bench', filePath: join(dir, 'agent.adf'),
    provider: new MockLLMProvider({ latencyMs: 0 }), profile: 'benchmark',
  })
  cleanup.push(() => agent.dispose())
  const executor = agent.executor as unknown as ContextAccess
  expect(executor.getContextBreakdown()).not.toBeNull()
  return { agent, executor }
}
function seed(agent: ReturnType<typeof createHeadlessAgent>, count: number) {
  agent.workspace.transaction(() => {
    for (let i = agent.session.getMessages().length; i < count; i++) {
      agent.session.addMessage({
        role: i % 2 ? 'assistant' : 'user',
        content: [{ type: 'text', text: 'history '.repeat(30) }],
      }, { model: 'mock', tokens: { input: 1000 + i, output: 100, reasoning: 25 } })
    }
  })
}

describe.skipIf(MEASURE_ONLY)('daemon context performance guards', () => {
  it('does not reread usage history for repeated unchanged context reads', () => {
    const { agent, executor } = fixture()
    seed(agent, 1000)
    const db = agent.workspace.getDatabase() as unknown as {
      stmts: { getAssistantTokenRows: { all(...args: unknown[]): unknown[] } }
    }
    const queries = vi.spyOn(db.stmts.getAssistantTokenRows, 'all')
    executor.getContextBreakdown()
    for (let i = 0; i < 100; i++) executor.getContextBreakdown()
    expect(queries).toHaveBeenCalledTimes(1)
    seed(agent, 1002)
    executor.getContextBreakdown()
    expect(queries).toHaveBeenCalledTimes(2)
  })

  it('tokenizes unchanged dynamic instructions once across preflight and diagnostics', () => {
    const { executor } = fixture()
    const hint = 'Inspect this agent and report useful findings. '.repeat(50)
    const tokenizer = vi.spyOn(getTokenCounterService(), 'countTokens')
    executor.recordRequestContext('system', hint)
    executor.estimatePreflightTokens(0, hint)
    for (let i = 0; i < 100; i++) executor.getContextBreakdown()
    expect(tokenizer.mock.calls.filter(([text]) => text === hint)).toHaveLength(1)
  })
})

describe.runIf(RUN)('daemon context timings', () => {
  it('measures repeated context reads with production invalidation checks', () => {
    const { agent, executor } = fixture()
    const results: Array<{ name: string; iterations: number; medianMs: number; minMs: number; maxMs: number }> = []
    function measure(name: string, iterations: number, ceilingMs: number, invalidate?: () => void) {
      for (let i = 0; i < 15; i++) { invalidate?.(); executor.getContextBreakdown() }
      const samples: number[] = []
      for (let batch = 0; batch < 7; batch++) {
        const start = performance.now()
        for (let i = 0; i < iterations; i++) { invalidate?.(); executor.getContextBreakdown() }
        samples.push((performance.now() - start) / iterations)
      }
      samples.sort((a, b) => a - b)
      const result = { name, iterations, medianMs: samples[3], minMs: samples[0], maxMs: samples[6] }
      results.push(result)
      console.log(`[bench:daemon-context] ${JSON.stringify(result)}`)
      // Loose ceilings guard catastrophic stalls; the normal operation-count
      // tests above catch loss of caching without depending on machine speed.
      if (!MEASURE_ONLY) expect(result.medianMs, name).toBeLessThan(ceilingMs)
    }
    for (const chars of [0, 2000, 16000]) {
      const hint = chars ? 'Task: inspect records and report results. '.repeat(Math.ceil(chars / 40)).slice(0, chars) : undefined
      executor.recordRequestContext('system', hint)
      expect(executor.getContextBreakdown()?.dynamic_instructions_tokens).toBeGreaterThanOrEqual(0)
      measure(`dynamic_${chars}`, 100, 5)
    }
    executor.recordRequestContext('system', undefined)
    for (const rows of [100, 1000, 10000]) {
      seed(agent, rows)
      expect(executor.getContextBreakdown()).not.toBeNull()
      measure(`history_${rows}`, 100, 10)
      if (rows === 1000) {
        const seq = agent.session.getMessages().at(-1)!.seq!
        // Both before/after pay the same SQLite update; the next context read
        // must rebuild, including parsing/freezing rather than a warm cache hit.
        measure('history_1000_invalidated_with_update', 100, 10, () => {
          agent.workspace.getDatabase().updateLoopContent('main', seq, [{ type: 'text', text: 'history '.repeat(30) }])
        })
      }
    }
    if (process.env.BENCH_OUT) writeFileSync(process.env.BENCH_OUT, JSON.stringify({
      node: process.version, platform: process.platform, arch: process.arch,
      storage: 'temporary file-backed SQLite, warm reads', results,
    }, null, 2))
  }, 60_000)
})
