import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { embeddedBackend as embeddedBase, type ParityBackend } from './backend'
import { DAEMON_BUNDLE, daemonBackend } from './daemon-backend'
import { diffRendered, renderRecording } from './format'
import { applyGapAllowlist } from './gaps'
import { toGoldenForm } from './normalize'
import { runScenario, type ParityScenario } from './scenario'

/**
 * The two checks every domain scenario gets (README "Adding a scenario"),
 * as daemon.test.ts and embedded.test.ts run them for the core scenarios:
 *
 * - embedded: stable across PARITY_RUNS and equal to its committed
 *   recording (`recordings/<name>.embedded.txt`);
 * - daemon (built bundle in a child process): indistinguishable from
 *   embedded after the named gaps of harness/gaps.ts, every gap listed for
 *   the scenario matching. Skipped without out/main/daemon.js
 *   (daemon.test.ts reports a missing or stale bundle).
 */

const RUNS = Math.max(1, Number(process.env.PARITY_RUNS ?? 1))
const BUNDLE = existsSync(DAEMON_BUNDLE)

export interface ParityCaseOptions {
  /**
   * Wraps each backend of a run, for a domain whose scenarios need the
   * machine set up before the backend boots (e.g. a loopback server whose
   * port the daemon child's fence must allow: it reads its ports at spawn).
   * Applied to both backends alike.
   */
  backend?: (backend: ParityBackend) => ParityBackend
}

/**
 * `embeddedOnly`: scenarios the daemon side cannot drive yet (each names
 * why in its comment); they get the embedded check only.
 */
export function parityCases(domain: string, scenarios: readonly ParityScenario[], embeddedOnly: readonly ParityScenario[] = [], opts: ParityCaseOptions = {}): void {
  const wrap = opts.backend ?? ((b: ParityBackend) => b)
  const embeddedBackend = wrap(embeddedBase)
  describe(`parity: ${domain}, embedded backend`, () => {
    for (const scenario of [...scenarios, ...embeddedOnly]) {
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
        await expect(renderRecording(toGoldenForm(first!.normalized))).toMatchFileSnapshot(`../recordings/${scenario.name}.embedded.txt`)
      }, 60_000 + RUNS * 30_000)
    }
  })

  describe.skipIf(!BUNDLE)(`parity: ${domain}, daemon backend (child process)`, () => {
    for (const scenario of scenarios) {
      it(`${scenario.name}: indistinguishable from embedded, apart from the named gaps`, async () => {
        const embedded = await runScenario(scenario, embeddedBackend)
        const expected = renderRecording(toGoldenForm(embedded.normalized))
        for (let run = 0; run < RUNS; run++) {
          const daemon = await runScenario(scenario, wrap(daemonBackend()), { tolerant: true })
          const { unmatched } = applyGapAllowlist(scenario.name, daemon.normalized, structuredClone(embedded.normalized))
          expect(unmatched, `gap entries that matched nothing in ${scenario.name} (fixed? remove them from harness/gaps.ts)`).toEqual([])
          const actual = renderRecording(toGoldenForm(daemon.normalized))
          expect(diffRendered(expected, actual, { expected: 'embedded', actual: 'daemon (after gaps)' })).toBe('')
        }
      }, 120_000 + RUNS * 120_000)
    }
  })
}
