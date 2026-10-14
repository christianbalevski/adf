import { describe, expect, it } from 'vitest'
import { embeddedBackend } from '../harness/backend'
import { diffRendered, renderRecording } from '../harness/format'
import { toGoldenForm } from '../harness/normalize'
import { runScenario } from '../harness/scenario'
import { DOCUMENT_SCENARIOS } from './scenarios'

/**
 * W3-A's scenarios against embedded Studio: stable across PARITY_RUNS runs
 * and equal to the committed recording, the baseline the daemon side is held
 * to (tests/parity/documents/daemon.test.ts). Refresh with `-u` after
 * reviewing the diff.
 */

const RUNS = Math.max(1, Number(process.env.PARITY_RUNS ?? 1))

describe('parity (W3-A): embedded backend', () => {
  for (const scenario of DOCUMENT_SCENARIOS) {
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
})
