import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DAEMON_BUNDLE, daemonBackend } from './harness/daemon-backend'
import { renderRecording } from './harness/format'
import { toGoldenForm } from './harness/normalize'
import { runScenario } from './harness/scenario'
import { CORE_SCENARIOS } from './scenarios/core'

/**
 * Parity harness, daemon side (tracker W2-C, README "Daemon backend").
 *
 * Each core scenario runs against Studio in daemon mode on the built daemon
 * in a child process, and its recording is committed in golden form as
 * `recordings/<scenario>.daemon.txt`, next to the embedded baseline
 * `<scenario>.embedded.txt`. The acceptance bar is the two files being
 * identical, i.e. `diffBackends(scenario, embeddedBackend, daemonBackend())`
 * returning ''. Until the workstreams the daemon side still needs have
 * landed, the daemon run is tolerant (a refused call or a missing push is
 * recorded, not thrown); docs/design/daemon-backend-gaps.md ("Parity diffs
 * after W2-C") names the workstream that closes each remaining difference.
 * No normalizer rule hides any of it. When a dependency lands the recording
 * moves towards the embedded one: review the change and refresh with `-u`.
 *
 *   git diff --no-index tests/parity/recordings/<s>.embedded.txt tests/parity/recordings/<s>.daemon.txt
 *
 * Needs out/main/daemon.js (npx electron-vite build); skipped, visibly, without it.
 */
describe.skipIf(!existsSync(DAEMON_BUNDLE))('parity: daemon backend (child process)', () => {
  for (const scenario of CORE_SCENARIOS) {
    it(`${scenario.name}: daemon-mode recording`, async () => {
      const result = await runScenario(scenario, daemonBackend(), { tolerant: true })
      await expect(renderRecording(toGoldenForm(result.normalized))).toMatchFileSnapshot(`recordings/${scenario.name}.daemon.txt`)
    }, 300_000)
  }
})
