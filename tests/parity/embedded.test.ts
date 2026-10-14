import { describe, expect, it } from 'vitest'
import { embeddedBackend } from './harness/backend'
import { diffRendered, renderRecording } from './harness/format'
import { toGoldenForm } from './harness/normalize'
import { diffBackends, runScenario, streamingReport } from './harness/scenario'
import { CORE_SCENARIOS, chatToolCallScenario } from './scenarios/core'

/**
 * Parity harness, embedded side (design §12 item 2). See README.md.
 *
 * Each scenario runs against `registerAllIpcHandlers` in a fresh isolated
 * environment. The normalized recording must be identical across
 * PARITY_RUNS runs (default 1) and must match the committed recording in
 * `recordings/`, which is the embedded baseline the daemon backend is held
 * to. A change to embedded behaviour, prompts, event payloads or persisted
 * state changes the recording: review the diff, then refresh with
 * `vitest run tests/parity -u`.
 *
 * Streaming is checked on timing data that never enters a recording: every
 * text slice the mock LLM writes (200 ms apart) must arrive as its own
 * text_delta_batch, and the first one within FIRST_DELTA_BOUND_MS.
 */

const RUNS = Math.max(1, Number(process.env.PARITY_RUNS ?? 1))
/** The executor's 50 ms batch window plus generous scheduling slack for loaded CI runners. */
const FIRST_DELTA_BOUND_MS = 50 + 250

describe('parity: embedded backend', () => {
  for (const scenario of CORE_SCENARIOS) {
    it(`${scenario.name}: stable, streams per slice, matches its recording`, async () => {
      const texts: string[] = []
      let first: Awaited<ReturnType<typeof runScenario>> | null = null
      for (let i = 0; i < RUNS; i++) {
        const result = await runScenario(scenario, embeddedBackend)
        first ??= result
        texts.push(result.text)
        const report = streamingReport(result.raw)
        expect(report.batches, 'one text_delta_batch per streamed slice').toBe(report.slices)
        for (const ms of report.firstDeltaLatencyMs) expect(ms).toBeLessThanOrEqual(FIRST_DELTA_BOUND_MS)
      }
      for (let i = 1; i < texts.length; i++) {
        expect(diffRendered(texts[0], texts[i], { expected: 'run 1', actual: `run ${i + 1}` })).toBe('')
      }
      await expect(renderRecording(toGoldenForm(first!.normalized)))
        .toMatchFileSnapshot(`recordings/${scenario.name}.embedded.txt`)
    }, 60_000 + RUNS * 30_000)
  }

  // The cross-backend entry point W2-C uses, pointed at two independent
  // embedded runs: proves the comparison path and that two fresh machines
  // agree even when PARITY_RUNS is 1.
  it('diffBackends: two independent embedded runs are indistinguishable', async () => {
    expect(await diffBackends(chatToolCallScenario, embeddedBackend, embeddedBackend)).toBe('')
  }, 120_000)
})
