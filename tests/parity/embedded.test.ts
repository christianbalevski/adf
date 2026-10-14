import { describe, expect, it } from 'vitest'
import { embeddedBackend } from './harness/backend'
import { diffRendered, renderRecording } from './harness/format'
import { toGoldenForm } from './harness/normalize'
import { diffBackends, runScenario } from './harness/scenario'
import { CORE_SCENARIOS, chatToolCallScenario } from './scenarios/core'

/**
 * Parity harness, embedded side (design §12 item 2).
 *
 * Each scenario runs against `registerAllIpcHandlers` in a fresh isolated
 * environment. The normalized recording must be identical across
 * PARITY_RUNS runs (default 1) and must match the committed recording in
 * `recordings/`, which is the embedded baseline the daemon backend is held
 * to. A change to embedded behaviour, prompts or event payloads changes the
 * recording: review the diff, then refresh with `vitest run tests/parity -u`.
 */

const RUNS = Math.max(1, Number(process.env.PARITY_RUNS ?? 1))

describe('parity: embedded backend', () => {
  for (const scenario of CORE_SCENARIOS) {
    it(`${scenario.name}: stable and matches its recording`, async () => {
      const texts: string[] = []
      let first: Awaited<ReturnType<typeof runScenario>> | null = null
      for (let i = 0; i < RUNS; i++) {
        const result = await runScenario(scenario, embeddedBackend)
        first ??= result
        texts.push(result.text)
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
