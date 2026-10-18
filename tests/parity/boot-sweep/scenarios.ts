import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { leaseKeyForCanonicalPath } from '../../../src/main/runtime/agent-lease'
import { IPC } from '../../../src/shared/constants/ipc-channels'
import { writeV2Adf, writeV31Adf } from '../../helpers/old-schema-adf'
import type { ParityEnv } from '../harness/env'
import { FIXTURE_CREATED_DATE, FIXTURE_IDS } from '../harness/fixtures'
import type { ParityScenario } from '../harness/scenario'

/** The old files' ids (W5-H): reviewed, so only their schema version keeps the sweep out. */
const OLD_IDS = { 'agent-4': '5f1d7a3e-2c4b-4e8a-9b6d-0a1b2c3d4e04', 'agent-5': '5f1d7a3e-2c4b-4e8a-9b6d-0a1b2c3d4e05' } as const

/** Each run's old files and their bytes before the backend booted, by run root. */
const oldFiles = new Map<string, Array<{ filePath: string; sha256: string }>>()

const sha256 = (filePath: string) => createHash('sha256').update(readFileSync(filePath)).digest('hex')

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
 * - agent-4 (schema v31) and agent-5 (v2, older than the migration ladder),
 *   both reviewed (W5-H): the sweep never migrates, so both are left
 *   byte-identical (checked in `run`; no .bak, no sidecars in the listing).
 *   Opening agent-5 is refused with the same sentence in every backend.
 */
export const bootEnvelopeSweepScenario: ParityScenario = {
  name: 'w5g-boot-envelope-sweep',
  description: 'Boot with the agents folder tracked: the envelope sweep provisions the reviewed agent, leaves the unreviewed one, the one another runtime runs, and the two that need a schema upgrade.',
  fixtures: [{ name: 'agent-1' }, { name: 'agent-2', reviewed: false }, { name: 'agent-3' }],
  envelopeSweep: 'boot',
  settings: (env) => {
    holdLeaseElsewhere(env, join(env.agentsDir, 'agent-3.adf'))
    const v31 = join(env.agentsDir, 'agent-4.adf')
    const v2 = join(env.agentsDir, 'agent-5.adf')
    writeV31Adf(v31, { id: OLD_IDS['agent-4'], name: 'agent-4', createdDate: FIXTURE_CREATED_DATE })
    writeV2Adf(v2, { id: OLD_IDS['agent-5'], name: 'agent-5' })
    oldFiles.set(env.root, [v31, v2].map((filePath) => ({ filePath, sha256: sha256(filePath) })))
    return {
      trackedDirectories: [env.agentsDir],
      reviewedAgents: Object.fromEntries([FIXTURE_IDS['agent-1'], FIXTURE_IDS['agent-3'], ...Object.values(OLD_IDS)].map((id) => [id, 'accepted'])),
    }
  },
  quietMs: 500,
  // The sweep ran at boot; the state dump is the comparison.
  async run(ctx) {
    for (const { filePath, sha256: before } of oldFiles.get(ctx.env.root) ?? []) {
      if (sha256(filePath) !== before) throw new Error(`the boot envelope sweep changed ${filePath}`)
    }
    oldFiles.delete(ctx.env.root)
    // What the user sees opening a file too old to upgrade.
    await ctx.invoke(IPC.FILE_OPEN, { filePath: join(ctx.env.agentsDir, 'agent-5.adf') })
  },
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
