// The credential list-files and dashboard agent-stats scans must not block
// the daemon's event loop (W1-D review): a tracked tree of a few hundred
// agents used to stall every client and agent for seconds. The scans read
// directories asynchronously and yield after every file; this measures the
// longest event-loop stall while the routes run.
//
// A stall counts only for the CPU time this thread spent in it. On a loaded
// CI runner the OS deschedules the thread for a few hundred ms now and then
// (CI run 38749217035: 226 ms; locally reproduced with 40 CPU burners on 32
// cores, every route 65-390 ms). The event loop was not busy then, and
// wall-clock time alone cannot tell that from a scan that blocks. A blocking
// scan burns its whole stall on this thread.
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AdfWorkspace } from '../src/main/adf/adf-workspace'
import { createDaemonHttpApi } from '../src/main/daemon/http-api'
import { RuntimeService } from '../src/main/runtime/runtime-service'

const FILES = 300
const MAX_STALL_MS = 50

let root: string
let server: ReturnType<typeof createDaemonHttpApi>

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'adf-daemon-scan-'))
  const seed = join(root, 'seed.adf')
  const ws = AdfWorkspace.create(seed, { name: 'agent-1' })
  try {
    ws.setIdentity('mcp:@acme/server:API_KEY', 'v')
    ws.setIdentity('provider:anthropic:apiKey', 'v')
  } finally {
    ws.close()
  }
  const tracked = join(root, 'tracked')
  for (let i = 0; i < FILES; i++) {
    const dir = join(tracked, `g${i % 10}`)
    mkdirSync(dir, { recursive: true })
    copyFileSync(seed, join(dir, `agent-${i + 1}.adf`))
  }
  const data: Record<string, unknown> = { trackedDirectories: [tracked] }
  server = createDaemonHttpApi(new RuntimeService({ enforceReviewGate: false }), { settingsStore: { get: (k: string) => data[k] } })
}, 120_000)

afterAll(async () => {
  await server.close()
  rmSync(root, { recursive: true, force: true })
})

/** CPU time of this thread in ms (the whole process where Node has no per-thread reading). */
const cpuMs = (): number => {
  const u = typeof process.threadCpuUsage === 'function' ? process.threadCpuUsage() : process.cpuUsage()
  return (u.user + u.system) / 1000
}

/**
 * Run `work` while sampling the event loop every millisecond. Returns the
 * work's result, the longest gap between samples (wall clock) and the longest
 * busy stall: per gap, the smaller of its length and the CPU time this thread
 * spent in it.
 */
async function withStallMeter<T>(work: () => Promise<T>): Promise<{ result: T; maxStallMs: number; maxBusyStallMs: number }> {
  let last = performance.now()
  let lastCpu = cpuMs()
  let maxStallMs = 0
  let maxBusyStallMs = 0
  const sample = (): void => {
    const now = performance.now()
    const cpu = cpuMs()
    const gap = now - last
    maxStallMs = Math.max(maxStallMs, gap)
    maxBusyStallMs = Math.max(maxBusyStallMs, Math.min(gap, cpu - lastCpu))
    last = now
    lastCpu = cpu
  }
  const timer = setInterval(sample, 1)
  try {
    last = performance.now()
    lastCpu = cpuMs()
    const result = await work()
    // The stretch since the last tick: a scan that never yields ends before any tick.
    sample()
    return { result, maxStallMs, maxBusyStallMs }
  } finally {
    clearInterval(timer)
  }
}

function expectNoBusyStall({ maxStallMs, maxBusyStallMs }: { maxStallMs: number; maxBusyStallMs: number }): void {
  expect(maxBusyStallMs, `longest stall ${maxStallMs.toFixed(0)} ms, of it busy ${maxBusyStallMs.toFixed(0)} ms`).toBeLessThan(MAX_STALL_MS)
}

describe('scans do not block the event loop', () => {
  // A blocking scan, in the middle of the work or as the whole of it (no tick before it ends).
  for (const [name, yields] of [['after a yield', true], ['that never yields', false]] as const) {
    it(`the meter counts a stall the event loop spends working: a block ${name}`, async () => {
      const stall = await withStallMeter(async () => {
        if (yields) await new Promise((r) => setTimeout(r, 5))
        // Spin until this thread has burned 120 ms of CPU, however often the OS preempts it.
        const until = cpuMs() + 120
        while (cpuMs() < until) { /* busy */ }
      })
      expect(stall.maxBusyStallMs).toBeGreaterThanOrEqual(MAX_STALL_MS)
    })
  }

  for (const [name, url, count] of [
    ['MCP credential files', '/credentials/mcp/files?mcpServerName=acme&npmPackage=%40acme%2Fserver', FILES],
    ['provider credential files', '/credentials/providers/files?providerId=anthropic', FILES],
    ['adapter credential files', '/credentials/adapters/files?adapterType=telegram', 0],
  ] as const) {
    it(`${name}: ${FILES} files, no stall over ${MAX_STALL_MS} ms`, async () => {
      const { result, ...stall } = await withStallMeter(() => server.inject({ method: 'GET', url }))
      expect(result.json().files).toHaveLength(count)
      expectNoBusyStall(stall)
    }, 60_000)
  }

  it(`dashboard agent stats (first, uncached scan): no stall over ${MAX_STALL_MS} ms`, async () => {
    const { result, ...stall } = await withStallMeter(() => server.inject({ method: 'GET', url: '/dashboard/agent-stats' }))
    expect(result.json().total).toBe(FILES)
    expectNoBusyStall(stall)
  }, 60_000)
})
