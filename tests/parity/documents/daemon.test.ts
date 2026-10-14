import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { embeddedBackend } from '../harness/backend'
import { DAEMON_BUNDLE, daemonBackend } from '../harness/daemon-backend'
import { diffRendered, renderRecording } from '../harness/format'
import { applyGapAllowlist } from '../harness/gaps'
import { toGoldenForm } from '../harness/normalize'
import { runScenario } from '../harness/scenario'
import { existsSync, readFileSync } from 'node:fs'
import { createHoldingAdapterSession } from './hold-session'
import { DOCUMENT_SCENARIOS } from './scenarios'

/**
 * W3-A's scenarios, daemon side: each runs against embedded Studio and
 * against Studio in daemon mode on the built daemon in a child process
 * (tests/parity/daemon.test.ts has the rules). Every remaining difference is
 * an entry of harness/gaps.ts naming the workstream that removes it; an entry
 * that matches nothing fails, and nothing may be left after them.
 *
 * `PARITY_DIFF_DIR=<dir>` writes each scenario's remaining diff there.
 *
 * Every scenario opens files that are not running, so it needs Studio to hold
 * them as open documents through its client session (W2-C2). With the interim
 * GET /events adapter as daemon mode's client session nothing is held, and
 * every read of such a file is the visible W2-B refusal; the suite then
 * skips and says why. It runs as soon as daemon mode's default session is
 * the real one, and must be green (or allowlisted) from then on.
 */

const BUNDLE = existsSync(DAEMON_BUNDLE)
const INTERIM_SESSION = /createEventsAdapterSession\(c\)/.test(
  readFileSync(join(__dirname, '../../../src/main/backend/daemon-mode/index.ts'), 'utf-8'))

describe('parity (W3-A): daemon backend availability', () => {
  it.runIf(INTERIM_SESSION)('waits for client-session document holds (W2-C2): daemon side skipped', () => {
    console.warn('[parity W3-A] daemon side skipped: daemon mode still uses the interim GET /events adapter, which holds no documents (W2-C2)')
  })
})

describe.skipIf(!BUNDLE || INTERIM_SESSION)('parity (W3-A): daemon backend (child process)', () => {
  for (const scenario of DOCUMENT_SCENARIOS) {
    it(`${scenario.name}: indistinguishable from embedded, apart from the named gaps`, async () => {
      const embedded = await runScenario(scenario, embeddedBackend)
      const expected = renderRecording(toGoldenForm(embedded.normalized))
      const daemon = await runScenario(scenario, daemonBackend(), { tolerant: true })
      const reference = structuredClone(embedded.normalized)
      const { unmatched } = applyGapAllowlist(scenario.name, daemon.normalized, reference)
      const actual = renderRecording(toGoldenForm(daemon.normalized))
      const diff = diffRendered(expected, actual, { expected: 'embedded', actual: 'daemon (after gaps)' })
      if (process.env.PARITY_DIFF_DIR) writeFileSync(join(process.env.PARITY_DIFF_DIR, `${scenario.name}.diff`), diff)
      expect(unmatched, `gap entries that matched nothing in ${scenario.name} (fixed? remove them from harness/gaps.ts)`).toEqual([])
      expect(diff).toBe('')
    }, 240_000)
  }
})

// DIAGNOSTIC (PARITY_W3A_HOLDS=1 with PARITY_DIFF_DIR): the scenarios on real
// document holds before W2-C2 (hold-session.ts). Writes each diff; asserts
// nothing, because the event stream is still the interim adapter's.
describe.runIf(BUNDLE && process.env.PARITY_W3A_HOLDS === '1')('parity (W3-A): daemon backend with document holds (diagnostic)', () => {
  for (const scenario of DOCUMENT_SCENARIOS) {
    it(`${scenario.name}: diff written to PARITY_DIFF_DIR`, async () => {
      const embedded = await runScenario(scenario, embeddedBackend)
      const daemon = await runScenario(scenario, daemonBackend({ createSession: createHoldingAdapterSession }), { tolerant: true })
      const reference = structuredClone(embedded.normalized)
      applyGapAllowlist(scenario.name, daemon.normalized, reference)
      const diff = diffRendered(renderRecording(toGoldenForm(embedded.normalized)), renderRecording(toGoldenForm(daemon.normalized)), { expected: 'embedded', actual: 'daemon (holds)' })
      if (process.env.PARITY_DIFF_DIR) writeFileSync(join(process.env.PARITY_DIFF_DIR, `${scenario.name}.holds.diff`), diff)
    }, 240_000)
  }
})
