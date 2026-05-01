/**
 * Umbilical steady-state throughput benchmark.
 *
 * Measures dispatch of 1000 events/sec × 30 seconds × 3 taps against a single
 * UmbilicalBus. Each tap has a narrow filter so it matches ~33% of events.
 *
 * This benchmark exercises the bus + TapManager filter path (matchExact,
 * when expression, token bucket, exclude_own_origin). It does NOT invoke the
 * code sandbox — the cost of actually running warm tap lambdas depends on
 * the lambda body and is not what this benchmark measures.
 *
 * The goal: confirm the fan-out + filter + accept/reject decision is fast
 * enough that the sandbox invocation path is the bottleneck, not the bus.
 *
 * Usage:
 *   node --experimental-strip-types scripts/perf/umbilical-throughput.ts
 */

import { UmbilicalBus } from '../../src/main/runtime/umbilical-bus'

const EVENTS_PER_SEC = 1000
const DURATION_SEC = 30
const TOTAL_EVENTS = EVENTS_PER_SEC * DURATION_SEC

interface FilterMatcher {
  name: string
  matchExact: Set<string>
  matchPrefixes: string[]
  matchAny: boolean
  whenFn: ((event: { event_type: string; payload: Record<string, unknown> }) => boolean) | null
  tokens: number
  lastRefillAt: number
  maxRate: number
  deliveries: number
  drops: number
}

function makeTap(name: string, eventTypes: string[], when?: string): FilterMatcher {
  const matchExact = new Set<string>()
  const matchPrefixes: string[] = []
  let matchAny = false
  for (const t of eventTypes) {
    if (t === '*') matchAny = true
    else if (t.endsWith('.*')) matchPrefixes.push(t.slice(0, -1))
    else matchExact.add(t)
  }
  let whenFn: ((event: { event_type: string; payload: Record<string, unknown> }) => boolean) | null = null
  if (when) {
    const fn = new Function('event', `return (${when});`) as (event: unknown) => boolean
    whenFn = (event) => {
      try { return Boolean(fn(event)) } catch { return false }
    }
  }
  return {
    name,
    matchExact,
    matchPrefixes,
    matchAny,
    whenFn,
    tokens: 10_000,       // generous — benchmark is not testing the limiter
    lastRefillAt: Date.now(),
    maxRate: 10_000,
    deliveries: 0,
    drops: 0,
  }
}

function shouldDispatch(tap: FilterMatcher, event: { event_type: string; payload: Record<string, unknown>; source: string }): boolean {
  const matchesType = tap.matchAny
    || tap.matchExact.has(event.event_type)
    || tap.matchPrefixes.some(p => event.event_type.startsWith(p))
  if (!matchesType) return false
  if (tap.whenFn && !tap.whenFn(event)) return false
  const now = Date.now()
  const elapsedSec = (now - tap.lastRefillAt) / 1000
  tap.tokens = Math.min(tap.maxRate, tap.tokens + elapsedSec * tap.maxRate)
  tap.lastRefillAt = now
  if (tap.tokens < 1) {
    tap.drops += 1
    return false
  }
  tap.tokens -= 1
  return true
}

async function main(): Promise<void> {
  const bus = new UmbilicalBus('bench-agent')

  const taps = [
    makeTap('tap-tool', ['tool.completed']),
    makeTap('tap-db', ['db.write'], "event.payload.sql && event.payload.sql.includes('local_orders')"),
    makeTap('tap-lambda', ['lambda.completed']),
  ]

  for (const tap of taps) {
    bus.subscribe((event) => {
      if (shouldDispatch(tap, event)) tap.deliveries += 1
    })
  }

  const eventTypes = ['tool.completed', 'db.write', 'lambda.completed']
  const intervalMs = 1000 / EVENTS_PER_SEC
  const latencies: number[] = []

  const startWall = Date.now()
  const startCpu = process.cpuUsage()

  for (let i = 0; i < TOTAL_EVENTS; i++) {
    const t0 = Number(process.hrtime.bigint())
    bus.publish({
      event_type: eventTypes[i % eventTypes.length],
      timestamp: Date.now(),
      source: 'agent:bench',
      payload: i % 3 === 1
        ? { sql: 'INSERT INTO local_orders (id, amount) VALUES (?, ?)', changes: 1 }
        : { name: 'bench-tool' }
    })
    const t1 = Number(process.hrtime.bigint())
    latencies.push(t1 - t0)
    // Pace: yield microtask every 100 events and wait if running ahead.
    if (i % 100 === 0) {
      const elapsed = Date.now() - startWall
      const expected = i * intervalMs
      if (elapsed < expected) await new Promise(r => setTimeout(r, expected - elapsed))
    }
  }

  const endWall = Date.now()
  const endCpu = process.cpuUsage(startCpu)

  latencies.sort((a, b) => a - b)
  const p50ns = latencies[Math.floor(latencies.length * 0.5)]
  const p99ns = latencies[Math.floor(latencies.length * 0.99)]

  const totalCpuMs = (endCpu.user + endCpu.system) / 1000
  const wallMs = endWall - startWall

  console.log('=== Umbilical steady-state benchmark ===')
  console.log(`Events emitted:       ${TOTAL_EVENTS}`)
  console.log(`Wall clock:           ${wallMs}ms (target ${DURATION_SEC * 1000}ms)`)
  console.log(`Throughput:           ${(TOTAL_EVENTS / wallMs * 1000).toFixed(0)} events/sec`)
  console.log(`CPU total:            ${totalCpuMs.toFixed(1)}ms  (${((totalCpuMs / wallMs) * 100).toFixed(1)}% of wall time)`)
  console.log(`Per-publish latency:  p50 ${(p50ns / 1000).toFixed(1)}us, p99 ${(p99ns / 1000).toFixed(1)}us`)
  for (const tap of taps) {
    console.log(`Tap ${tap.name.padEnd(12)}: ${tap.deliveries} deliveries, ${tap.drops} drops`)
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
