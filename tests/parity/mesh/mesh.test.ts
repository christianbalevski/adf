import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { embeddedBackend } from '../harness/backend'
import { DAEMON_BUNDLE, daemonBackend } from '../harness/daemon-backend'
import { diffRendered, renderRecording } from '../harness/format'
import { applyGapAllowlist } from '../harness/gaps'
import { toGoldenForm } from '../harness/normalize'
import { runScenario } from '../harness/scenario'
import { MESH_SCENARIOS } from './scenarios'

/**
 * Parity harness, mesh scenarios (tracker W3-D): the fleet map with two
 * running agents and a stopped one, and the emergency stop. Each runs
 * against embedded Studio (stable, matches its recording in recordings/)
 * and against Studio in daemon mode on the built daemon; the two
 * recordings must be equal apart from the named entries of
 * harness/gaps.ts, as in daemon.test.ts (README "Daemon backend").
 *
 * Needs out/main/daemon.js for the daemon side (`npx electron-vite build`);
 * daemon.test.ts fails a stale bundle.
 */

const RUNS = Math.max(1, Number(process.env.PARITY_RUNS ?? 1))

describe('parity: mesh scenarios, embedded backend', () => {
  for (const scenario of MESH_SCENARIOS) {
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
        .toMatchFileSnapshot(`../recordings/${scenario.name}.embedded.txt`)
    }, 60_000 + RUNS * 30_000)
  }
})

describe.skipIf(!existsSync(DAEMON_BUNDLE))('parity: mesh scenarios, daemon backend (child process)', () => {
  for (const scenario of MESH_SCENARIOS) {
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

  // Studio reads the client stream's inter_agent_message (W2-C2) and shows it
  // for the open agent. A live comparison is not possible yet: embedded never
  // shows a message one of its own agents delivers locally (MeshManager emits
  // foreground_incoming only on ingress, an E3 candidate), and a background
  // AGENT_INVOKE resolves in the middle of the turn in embedded but at its end
  // in daemon mode, so the step boundaries differ. Unit-tested in
  // tests/backend/daemon-mode-bridge.test.ts.
  it.todo('inter-agent-message: a message agent-1 sends agent-2 over the mesh renders the same in the open agent-2 (E3: local delivery)')

  // Studio maps the compute_phase push topic to COMPUTE_CONTAINER_PHASE
  // unchanged on client sessions (W2-C2; tests/backend/daemon-mode-fleet.test.ts).
  // Neither compute fake (a machine without Podman) goes through a phase, so
  // the live comparison waits for a phase-emitting fake.
  it.todo('compute-phase: the phase pushes of an agent container match (needs a phase-emitting compute fake)')
})
