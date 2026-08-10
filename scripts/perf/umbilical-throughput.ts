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
 *   npx tsx scripts/perf/umbilical-throughput.ts
 *
 * With the Phase 2 durable log attached (writes every event to a real SQLite
 * `local_*` table, so better-sqlite3 must match the runtime's ABI):
 *   ADF_PERF_UMBILICAL_LOG=1 ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe \
 *     ./node_modules/tsx/dist/cli.mjs scripts/perf/umbilical-throughput.ts
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

/**
 * Optional Phase 2 leg: subscribe the durable log writer to the same bus so the
 * measured publish cost includes JSON serialization, the rolling hash, and a
 * real synchronous INSERT. Imported lazily — the default run must not need
 * better-sqlite3 at all.
 */
async function attachDurableLog(bus: UmbilicalBus): Promise<{ report: () => void; cleanup: () => void } | null> {
  if (process.env.ADF_PERF_UMBILICAL_LOG !== '1') return null
  const { AdfWorkspace } = await import('../../src/main/adf/adf-workspace')
  const { createUmbilicalLogWriter } = await import('../../src/main/runtime/umbilical-log-writer')

  const dir = mkdtempSync(join(tmpdir(), 'adf-perf-umbilical-log-'))
  const workspace = AdfWorkspace.create(join(dir, 'bench-agent.adf'), { name: 'bench-agent' })
  const writer = createUmbilicalLogWriter({
    agentId: 'bench-agent',
    store: workspace,
    config: { log: { enabled: true } },
  })
  if (!writer) throw new Error('durable log writer did not initialize')
  writer.attach(bus)

  return {
    report: () => {
      writer.detach()
      const rows = workspace.querySQL(`SELECT COUNT(*) as count FROM "${writer.table}"`) as Array<{ count: number }>
      console.log(`Durable log:          ${rows[0]?.count ?? 0} rows retained, ${writer.failures} write failures`)
    },
    cleanup: () => {
      workspace.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

async function main(): Promise<void> {
  const bus = new UmbilicalBus('bench-agent')
  const durableLog = await attachDurableLog(bus)

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
  durableLog?.report()
  durableLog?.cleanup()
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
