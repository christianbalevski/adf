import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { embeddedBackend } from '../harness/backend'
import { DAEMON_BUNDLE, daemonBackend } from '../harness/daemon-backend'
import { diffRendered, renderRecording } from '../harness/format'
import { applyGapAllowlist } from '../harness/gaps'
import { toGoldenForm } from '../harness/normalize'
import { runScenario } from '../harness/scenario'
import { CORE_SCENARIOS } from '../scenarios/core'

/**
 * Remote mode parity (tracker W4-B): the core scenarios against Studio in
 * `mode: 'remote'`, with the real remote connector (transport rule, version
 * handshake) and the built daemon behind a loopback proxy that acts as
 * another machine: it adds X-Forwarded-For, so the daemon treats nothing as
 * a local caller, and strips any local proof (one seen fails the run as a
 * leak). The recording must equal embedded's after the same named gaps as
 * local mode: remote adds no difference to opening an agent, starting it and
 * a chat turn with a tool call.
 *
 * Needs out/main/daemon.js (`npx electron-vite build`), as daemon.test.ts.
 */

const BUNDLE = existsSync(DAEMON_BUNDLE)

/**
 * The one difference remote mode has by design in these scenarios: Studio's
 * lease-registry client record says `mode: 'remote'` (agent-lease.ts
 * registerClient). Rewritten to the local-mode value so the shared allowlist
 * (`mode:lease-roles`) applies; it MUST be found, so a change shows.
 */
function remoteClientRecord(recording: { state: { leases: Record<string, unknown> } }): number {
  const client = recording.state.leases['clients/<pid:this-process>.json'] as { mode?: unknown } | undefined
  if (client?.mode !== 'remote') return 0
  client.mode = 'local'
  return 1
}

describe.skipIf(!BUNDLE)('parity: remote mode (daemon behind a remote-acting proxy)', () => {
  for (const scenario of CORE_SCENARIOS) {
    it(`${scenario.name}: indistinguishable from embedded, apart from the named gaps`, async () => {
      const embedded = await runScenario(scenario, embeddedBackend)
      const expected = renderRecording(toGoldenForm(embedded.normalized))
      const remote = await runScenario(scenario, daemonBackend({ remote: true }), { tolerant: true })
      expect(remoteClientRecord(remote.normalized as never), 'Studio registers as a remote-mode client').toBe(1)
      const { unmatched } = applyGapAllowlist(scenario.name, remote.normalized, structuredClone(embedded.normalized), { daemon: remote.raw })
      expect(unmatched, `gap entries that matched nothing in ${scenario.name}`).toEqual([])
      const actual = renderRecording(toGoldenForm(remote.normalized))
      const diff = diffRendered(expected, actual, { expected: 'embedded', actual: 'remote (after gaps)' })
      if (process.env.PARITY_DIFF_DIR) writeFileSync(join(process.env.PARITY_DIFF_DIR, `remote-${scenario.name}.diff`), diff)
      expect(diff).toBe('')
    }, 240_000)
  }
})
