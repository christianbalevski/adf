import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { leaseKeyForCanonicalPath } from '../../../src/main/runtime/agent-lease'
import type { ParityEnv } from '../harness/env'
import type { ParityScenario } from '../harness/scenario'

/**
 * The boot envelope sweep (spec §8), in every backend (W5-G): embedded
 * Studio and the daemon provision the reviewed agents of the tracked folders
 * that have no keys, 2 s after boot. Here it runs at boot and has finished
 * before the scenario starts (ParityScenario.envelopeSweep).
 *
 * - agent-1: reviewed, no keys → provisioned (keys, DID, owner and operator
 *   attestations).
 * - agent-2: not reviewed → untouched.
 * - agent-3: reviewed, but another live runtime holds its lease → untouched
 *   (provisioned when next opened where it runs).
 */
export const bootEnvelopeSweepScenario: ParityScenario = {
  name: 'w5g-boot-envelope-sweep',
  description: 'Boot with the agents folder tracked: the envelope sweep provisions the reviewed agent, leaves the unreviewed one and the one another runtime runs.',
  fixtures: [{ name: 'agent-1' }, { name: 'agent-2', reviewed: false }, { name: 'agent-3' }],
  envelopeSweep: 'boot',
  settings: (env) => {
    holdLeaseElsewhere(env, join(env.agentsDir, 'agent-3.adf'))
    return { trackedDirectories: [env.agentsDir] }
  },
  quietMs: 500,
  // Nothing to do: the sweep ran at boot; the state dump is the comparison.
  async run() {},
}

/**
 * A lease on `filePath` held by another runtime: this test process's pid (so
 * alive) and a runtime id no backend has, with no endpoint to probe.
 */
function holdLeaseElsewhere(env: ParityEnv, filePath: string): void {
  const canonical = realpathSync.native(filePath)
  mkdirSync(env.leaseDir, { recursive: true })
  writeFileSync(join(env.leaseDir, `${leaseKeyForCanonicalPath(canonical)}.json`), JSON.stringify({
    v: 1,
    path: canonical,
    agentId: null,
    holder: {
      kind: 'studio-embedded',
      pid: process.pid,
      runtimeId: 'ffffffffffffffff',
      hostname: 'parity-other-runtime',
      settingsPath: join(env.root, 'other-runtime', 'adf-settings.json'),
      startedAt: env.startedAt,
      version: null,
      endpoint: null,
    },
    acquiredAt: env.startedAt,
  }, null, 2))
}
