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
        const { unmatched } = applyGapAllowlist(scenario.name, daemon.normalized, reference)
        expect(unmatched, `gap entries that matched nothing in ${scenario.name} (fixed? remove them from harness/gaps.ts)`).toEqual([])
        const actual = renderRecording(toGoldenForm(daemon.normalized))
        expect(diffRendered(expected, actual, { expected: 'embedded', actual: 'daemon (after gaps)' })).toBe('')
        texts.push(actual)
      }
      for (let i = 1; i < texts.length; i++) expect(texts[i]).toBe(texts[0])
    }, 120_000 + RUNS * 120_000)
  }

  // Embedded shows an incoming mesh message on AGENT_EVENT (inter_agent_message,
  // ipc/index.ts foreground_incoming); the daemon emits it on the client
  // stream once W2-B lands (push topic inter_agent_message).
  it.todo('inter-agent-message: a message agent-1 sends agent-2 over the mesh renders the same in the open agent-2 (W2-B)')

  // Embedded forwards PodmanService 'container-phase' unchanged on
  // COMPUTE_CONTAINER_PHASE; daemon mode maps the compute_phase push topic to
  // it unchanged (tests/backend/daemon-mode-fleet.test.ts). The daemon
  // publishes the topic with W2-B, and neither compute fake (a machine
  // without Podman) goes through a phase, so the live comparison waits for
  // W2-B and a phase-emitting fake.
  it.todo('compute-phase: the phase pushes of an agent container match (W2-B)')
})
