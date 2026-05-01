import { afterAll, describe, it, expect, vi } from 'vitest'
import { tmpdir } from 'os'
import { dirname, join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'

// Mock electron before any main-process imports are resolved.
// The runtime transitively imports token-usage.service and settings.service
// which require `electron.app` / `electron.safeStorage`.
vi.mock('electron', () => {
  const dir = join(tmpdir(), `adf-harness-${process.pid}`)
  return {
    app: {
      getPath: (_name: string) => dir,
      on: () => {},
      getName: () => 'adf-harness',
      getVersion: () => '0.0.0-harness',
    },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (s: string) => Buffer.from(s, 'utf-8'),
      decryptString: (b: Buffer) => b.toString('utf-8'),
    },
    shell: { openExternal: async () => {} },
    ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {}, removeAllListeners: () => {} },
    BrowserWindow: class {},
    dialog: {},
  }
})

import { runHarness, formatReport, scenarios, type HarnessResult } from '../../src/main/runtime/headless/harness'
import { createHeadlessAgent, MockLLMProvider } from '../../src/main/runtime/headless'
import { createDispatch, createEvent } from '../../src/shared/types/adf-event.types'

const RUN_BENCH = process.env.RUN_BENCH === '1'
const reports: HarnessResult[] = []

function recordReport(result: HarnessResult): HarnessResult {
  reports.push(result)
  console.log(formatReport(result))
  return result
}

afterAll(() => {
  const out = process.env.BENCH_OUT
  if (!RUN_BENCH || !out || reports.length === 0) return
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, JSON.stringify({ reports }, null, 2))
})

describe.runIf(RUN_BENCH)('runtime stress harness', () => {
  it('sanity: one agent, one manual turn', async () => {
    const provider = new MockLLMProvider({ latencyMs: 0, tokensPerResponse: 20 })
    const agent = createHeadlessAgent({ name: 'sanity', provider })
    const dispatch = createDispatch(
      createEvent({
        type: 'chat',
        source: 'system',
        data: {
          message: {
            seq: 0,
            role: 'user',
            content_json: [{ type: 'text', text: 'hi' }],
            created_at: Date.now(),
          },
        },
      }),
      { scope: 'agent' },
    )
    await agent.executor.executeTurn(dispatch)
    expect(provider.getCallCount()).toBeGreaterThan(0)
    agent.dispose()
  }, 15_000)

  it('smoke: single agent, overhead scenario', async () => {
    const result = recordReport(await runHarness({
      ...scenarios.overhead,
      agents: 1,
      durationMs: 3_000,
    }))
    expect(result.metrics.turns.completed).toBeGreaterThan(0)
    expect(result.metrics.turns.errored).toBe(0)
  }, 30_000)

  it('multi-agent: 10 agents, overhead scenario', async () => {
    const result = recordReport(await runHarness({
      ...scenarios.overhead,
      agents: 10,
      durationMs: 5_000,
    }))
    expect(result.metrics.turns.completed).toBeGreaterThan(0)
    expect(result.metrics.turns.errored).toBe(0)
  }, 60_000)

  it('scenario: idle', async () => {
    const result = recordReport(await runHarness({ ...scenarios.idle, durationMs: 15_000 }))
    expect(result.metrics.turns.errored).toBe(0)
  }, 60_000)

  it('scenario: mixed', async () => {
    const result = recordReport(await runHarness({ ...scenarios.mixed, durationMs: 15_000 }))
    expect(result.metrics.turns.errored).toBe(0)
  }, 60_000)

  it('scenario: burst', async () => {
    const result = recordReport(await runHarness({ ...scenarios.burst, durationMs: 10_000 }))
    expect(result.metrics.turns.errored).toBe(0)
  }, 60_000)
})

// Keep the test file "passing" when RUN_BENCH is not set, so npm test doesn't error.
describe('runtime stress harness (gated)', () => {
  it('is gated by RUN_BENCH=1', () => {
    expect(RUN_BENCH || !RUN_BENCH).toBe(true)
  })
})
