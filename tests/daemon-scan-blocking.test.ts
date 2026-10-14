// The credential list-files and dashboard agent-stats scans must not block
// the daemon's event loop (W1-D review): a tracked tree of a few hundred
// agents used to stall every client and agent for seconds. The scans read
// directories asynchronously and yield after every file; this measures the
// longest event-loop stall while the routes run.
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

/** Run `work` while sampling the event loop every millisecond; returns the work's result and the longest gap. */
async function withStallMeter<T>(work: () => Promise<T>): Promise<{ result: T; maxStallMs: number }> {
  let last = performance.now()
  let maxStallMs = 0
  const timer = setInterval(() => {
    const now = performance.now()
    maxStallMs = Math.max(maxStallMs, now - last)
    last = now
  }, 1)
  try {
    last = performance.now()
    const result = await work()
    return { result, maxStallMs }
  } finally {
    clearInterval(timer)
  }
}

describe('scans do not block the event loop', () => {
  for (const [name, url, count] of [
    ['MCP credential files', '/credentials/mcp/files?mcpServerName=acme&npmPackage=%40acme%2Fserver', FILES],
    ['provider credential files', '/credentials/providers/files?providerId=anthropic', FILES],
    ['adapter credential files', '/credentials/adapters/files?adapterType=telegram', 0],
  ] as const) {
    it(`${name}: ${FILES} files, no stall over ${MAX_STALL_MS} ms`, async () => {
      const { result, maxStallMs } = await withStallMeter(() => server.inject({ method: 'GET', url }))
      expect(result.json().files).toHaveLength(count)
      expect(maxStallMs).toBeLessThan(MAX_STALL_MS)
    }, 60_000)
  }

  it(`dashboard agent stats (first, uncached scan): no stall over ${MAX_STALL_MS} ms`, async () => {
    const { result, maxStallMs } = await withStallMeter(() => server.inject({ method: 'GET', url: '/dashboard/agent-stats' }))
    expect(result.json().total).toBe(FILES)
    expect(maxStallMs).toBeLessThan(MAX_STALL_MS)
  }, 60_000)
})
