import { describe, expect, it } from 'vitest'
import { embeddedBackend } from './harness/backend'
import { runScenario, type ParityScenario } from './harness/scenario'
import { adapterTelegramScenario } from './mcp/scenarios'

/**
 * W5-G, CI run 38749217035: w3c-adapter-telegram, remote side. Embedded
 * Studio runs its envelope sweep 2 s after boot; it provisions keys, the DID
 * and the owner and operator attestations of every reviewed agent in the
 * tracked folders. The scenario sets the tracked folder itself, so a run that
 * took over 2 s on a loaded runner recorded both fixtures provisioned
 * (2 attestations each), a fast one recorded none (the committed recording),
 * and the daemon (no boot sweep) none. The harness now runs the sweep at
 * boot (runDeferredEnvelopeSweepNow), before the scenario sets anything, so
 * the recorded state no longer depends on how long the scenario took.
 *
 * The slow runner is modelled by idling past the sweep's 2 s timer after the
 * scenario, before the snapshot.
 */
const slowTelegram: ParityScenario = {
  ...adapterTelegramScenario,
  name: 'w5g-slow-adapter-telegram',
  async run(ctx) {
    await adapterTelegramScenario.run(ctx)
    await new Promise((r) => setTimeout(r, 2_500))
  },
}

describe('parity harness: the boot envelope sweep', () => {
  it('a scenario that outlasts the 2 s sweep timer records the same agent state as a fast one', async () => {
    const result = await runScenario(slowTelegram, embeddedBackend)
    for (const agent of ['agents/agent-1.adf', 'agents/agent-2.adf']) {
      const tables = result.raw.state.adf[agent].tables
      expect(tables.adf_attestations.rows, `${agent} adf_attestations`).toEqual([])
      expect(tables.adf_identity.rows, `${agent} adf_identity`).toEqual([])
    }
  }, 60_000)
})
