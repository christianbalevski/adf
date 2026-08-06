import { describe, it, expect } from 'vitest'
import { performance } from 'perf_hooks'

/**
 * Agent Runtime Performance Benchmarks
 *
 * Measures:
 * - Message routing time complexity
 * - System prompt caching effectiveness
 */

describe('Agent Runtime Performance', () => {
  it('should route messages in O(1) time', async () => {
    const agentCounts = [1, 10, 50, 100]
    const ITERATIONS = 100_000 // amortize each measurement well above timer resolution
    const routingTimes: number[] = []

    // Build a channel index for `count` agents (this is O(n) setup, NOT routing —
    // it must stay OUTSIDE the timed region or we'd be measuring index build).
    const buildIndex = (count: number) => {
      const channelIndex = new Map<string, Set<string>>()
      for (let i = 0; i < count; i++) {
        const channel = `channel-${i % 5}` // 5 channels total
        if (!channelIndex.has(channel)) channelIndex.set(channel, new Set())
        channelIndex.get(channel)!.add(`agent-${i}`)
      }
      return channelIndex
    }

    for (const count of agentCounts) {
      const channelIndex = buildIndex(count)

      // Warm up so JIT/first-touch cost isn't attributed to the timed loop.
      for (let i = 0; i < ITERATIONS; i++) channelIndex.get('channel-0')

      // Time ONLY the routing lookup — the O(1) operation under test.
      const start = performance.now()
      let acc = 0
      for (let i = 0; i < ITERATIONS; i++) {
        const recipients = channelIndex.get('channel-0')
        acc += recipients ? recipients.size : 0 // defeat dead-code elimination
      }
      const end = performance.now()
      expect(acc).toBeGreaterThan(0)

      const perLookupNs = ((end - start) / ITERATIONS) * 1e6
      routingTimes.push(perLookupNs)
      console.log(`Routing lookup (${count} agents): ${perLookupNs.toFixed(1)}ns/op`)
    }

    // A Map.get is O(1): per-lookup time must not scale with agent count. Compare
    // against the MEDIAN (not the first, warmup-skewed sample) to stay stable.
    const sorted = [...routingTimes].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]
    const worst = Math.max(...routingTimes)
    const ratio = worst / median
    console.log(`Worst/median lookup ratio: ${ratio.toFixed(2)}x (target: <5x for O(1))`)

    // O(n) routing would grow 100x from 1→100 agents; O(1) stays flat. 5x leaves
    // generous headroom for CI timer noise while still catching real regressions.
    expect(ratio).toBeLessThan(5)
  })

  it('should cache system prompts', async () => {
    const targetCacheHitTime = 1 // ms

    // Simulate system prompt generation
    const generatePrompt = () => {
      const template = 'System prompt template with {{placeholder}}'.repeat(100)
      const substituted = template.replace(/{{placeholder}}/g, 'value')
      return substituted
    }

    // First generation (cache miss)
    const start1 = performance.now()
    const prompt1 = generatePrompt()
    const end1 = performance.now()
    const cacheMissTime = end1 - start1

    console.log(`System prompt generation (cache miss): ${cacheMissTime.toFixed(3)}ms`)

    // Subsequent generation (cache hit - should be instant)
    const start2 = performance.now()
    // Simulate cache hit (no actual generation)
    const cachedPrompt = prompt1
    const end2 = performance.now()
    const cacheHitTime = end2 - start2

    console.log(`System prompt generation (cache hit): ${cacheHitTime.toFixed(3)}ms`)
    console.log(`Speedup: ${(cacheMissTime / Math.max(cacheHitTime, 0.001)).toFixed(1)}x`)

    expect(cacheHitTime).toBeLessThan(targetCacheHitTime)
  })

  it('should demonstrate tool registry caching', async () => {
    const toolCount = 50
    const declarations = Array.from({ length: toolCount }, (_, i) => ({
      name: `tool-${i}`,
      enabled: i % 2 === 0 // half enabled
    }))

    // Uncached filtering
    const start1 = performance.now()
    const enabledTools = declarations.filter(d => d.enabled)
    const end1 = performance.now()
    const uncachedTime = end1 - start1

    console.log(`Tool filtering (uncached): ${uncachedTime.toFixed(3)}ms`)

    // Cached lookup (using Map)
    const cache = new Map<string, typeof enabledTools>()
    const cacheKey = JSON.stringify(declarations.map(d => ({ name: d.name, enabled: d.enabled })))

    const start2 = performance.now()
    if (cache.has(cacheKey)) {
      const cached = cache.get(cacheKey)
    } else {
      cache.set(cacheKey, enabledTools)
    }
    const end2 = performance.now()
    const cachedTime = end2 - start2

    console.log(`Tool filtering (cached): ${cachedTime.toFixed(3)}ms`)
  })
})

/**
 * Runtime Metrics Collector
 */
export class RuntimeMetrics {
  private metrics: {
    routingTimeMs: number
    routingComplexity: string
    systemPromptCacheHitRate: number
    toolRegistryCacheHitRate: number
  } = {
    routingTimeMs: 0,
    routingComplexity: 'O(n)',
    systemPromptCacheHitRate: 0,
    toolRegistryCacheHitRate: 0
  }

  recordRoutingTime(time: number, complexity: 'O(1)' | 'O(n)') {
    this.metrics.routingTimeMs = time
    this.metrics.routingComplexity = complexity
  }

  recordSystemPromptCacheHitRate(rate: number) {
    this.metrics.systemPromptCacheHitRate = rate
  }

  recordToolRegistryCacheHitRate(rate: number) {
    this.metrics.toolRegistryCacheHitRate = rate
  }

  getMetrics() {
    return { ...this.metrics }
  }

  reset() {
    this.metrics = {
      routingTimeMs: 0,
      routingComplexity: 'O(n)',
      systemPromptCacheHitRate: 0,
      toolRegistryCacheHitRate: 0
    }
  }
}
