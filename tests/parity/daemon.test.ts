import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { embeddedBackend } from './harness/backend'
import { DAEMON_BUNDLE, daemonBackend } from './harness/daemon-backend'
import { diffRendered, renderRecording } from './harness/format'
import { applyGapAllowlist, GAP_ALLOWLIST } from './harness/gaps'
import { toGoldenForm } from './harness/normalize'
import { runScenario } from './harness/scenario'
import { CORE_SCENARIOS } from './scenarios/core'
import { SETTINGS_SCENARIOS } from './settings/scenarios'
import { IDENTITY_SCENARIOS } from './identity/scenarios'
import { MESH_SCENARIOS } from './mesh/scenarios'
import { W3C_SCENARIO_NAMES } from './mcp/scenarios'
import { DOCUMENT_SCENARIOS } from './documents/scenarios'

/**
 * Parity harness, daemon side (tracker W2-C, README "Daemon backend").
 *
 * Each core scenario runs against embedded Studio and against Studio in
 * daemon mode on the built daemon in a child process; the two recordings are
 * compared. The acceptance bar is no difference at all. Until the
 * workstreams the daemon side needs have landed, the known differences are
 * the named, workstream-tagged transforms of harness/gaps.ts, applied to the
 * daemon side only. Every entry MUST match in each scenario it lists (a
 * fixed gap fails the test until its entry is removed), and nothing may be
 * left after them. No normalizer rule hides a difference.
 *
 * The daemon run is tolerant (a refused call or a missing push is recorded,
 * not thrown), so a difference shows as a diff, not as a crash.
 *
 * Needs out/main/daemon.js (`npx electron-vite build`). Without it the suite
 * is skipped, or fails with PARITY_REQUIRE_DAEMON=1. A bundle older than the
 * newest file under src/main fails: it would test stale code.
 */

const RUNS = Math.max(1, Number(process.env.PARITY_RUNS ?? 1))
const REQUIRE = process.env.PARITY_REQUIRE_DAEMON === '1'
const BUNDLE = existsSync(DAEMON_BUNDLE)

function newestSource(dir: string): { file: string; mtimeMs: number } {
  let best = { file: '', mtimeMs: 0 }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      const sub = newestSource(p)
      if (sub.mtimeMs > best.mtimeMs) best = sub
    } else if (/\.(ts|cjs|mjs|js|json)$/.test(entry.name)) {
      const m = statSync(p).mtimeMs
      if (m > best.mtimeMs) best = { file: p, mtimeMs: m }
    }
  }
  return best
}

describe('parity: daemon backend availability', () => {
  it.runIf(REQUIRE)('the daemon bundle exists (PARITY_REQUIRE_DAEMON=1)', () => {
    expect(BUNDLE, `${DAEMON_BUNDLE} is missing; run npx electron-vite build`).toBe(true)
  })
  it.runIf(BUNDLE)('the daemon bundle is newer than every file under src/main', () => {
    const newest = newestSource(resolve(__dirname, '../../src/main'))
    const bundle = statSync(DAEMON_BUNDLE).mtimeMs
    expect(bundle >= newest.mtimeMs, `${DAEMON_BUNDLE} is older than ${newest.file}; rebuild it (npx electron-vite build)`).toBe(true)
  })
})

describe.skipIf(!BUNDLE)('parity: daemon backend (child process)', () => {
  for (const scenario of CORE_SCENARIOS) {
    it(`${scenario.name}: indistinguishable from embedded, apart from the named gaps`, async () => {
      const embedded = await runScenario(scenario, embeddedBackend)
      const expected = renderRecording(toGoldenForm(embedded.normalized))
      const texts: string[] = []
      for (let run = 0; run < RUNS; run++) {
        const daemon = await runScenario(scenario, daemonBackend(), { tolerant: true })
        const reference = structuredClone(embedded.normalized)
        const { unmatched } = applyGapAllowlist(scenario.name, daemon.normalized, reference, { daemon: daemon.raw })
        expect(unmatched, `gap entries that matched nothing in ${scenario.name} (fixed? remove them from harness/gaps.ts)`).toEqual([])
        const actual = renderRecording(toGoldenForm(daemon.normalized))
        expect(diffRendered(expected, actual, { expected: 'embedded', actual: 'daemon (after gaps)' })).toBe('')
        texts.push(actual)
      }
      for (let i = 1; i < texts.length; i++) expect(texts[i]).toBe(texts[0])
    }, 120_000 + RUNS * 120_000)
  }

  it('every gap entry names a workstream and lists only known scenarios', () => {
    const names = new Set([...[...CORE_SCENARIOS, ...MESH_SCENARIOS, ...SETTINGS_SCENARIOS, ...IDENTITY_SCENARIOS, ...DOCUMENT_SCENARIOS].map((s) => s.name), ...W3C_SCENARIO_NAMES])
    for (const entry of GAP_ALLOWLIST) {
      expect(entry.ws).toMatch(/^(W\d-[A-Z]\d?|E3|mode)$/)
      for (const s of entry.scenarios) expect(names.has(s), `${entry.id}: ${s}`).toBe(true)
    }
    expect(new Set(GAP_ALLOWLIST.map((e) => e.id)).size).toBe(GAP_ALLOWLIST.length)
  })
})
