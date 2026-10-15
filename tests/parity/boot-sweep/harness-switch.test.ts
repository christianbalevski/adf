import { describe, expect, it } from 'vitest'
import { embeddedBackend } from '../harness/backend'
import { runScenario, type ParityScenario } from '../harness/scenario'
import { adapterTelegramScenario } from '../mcp/scenarios'

/**
 * W5-G, CI run 38749217035: w3c-adapter-telegram, remote side. Embedded
 * Studio runs its envelope sweep 2 s after boot; it provisions keys, the DID
 * and the owner and operator attestations of every reviewed agent in the
 * tracked folders. A scenario that outlasted the timer on a loaded runner
 * recorded the fixtures provisioned (2 attestations each), a fast one, the
 * committed recordings and the daemon (no boot sweep) did not. The harness
 * now cancels the sweep at boot (cancelDeferredEnvelopeSweep).
 *
 * The slow runner is modelled by idling past the 2 s timer after the
 * scenario, before the snapshot: once with the folder tracked by the scenario
 * (w3c-adapter-telegram), once tracked from boot (as the mesh scenarios do).
 */
const idlePastSweep = (base: ParityScenario, name: string, settings?: ParityScenario['settings']): ParityScenario => ({
  ...base,
  name,
  ...(settings ? { settings } : {}),
  async run(ctx) {
    await base.run(ctx)
    await new Promise((r) => setTimeout(r, 2_500))
  },
})

describe('parity harness: the boot envelope sweep', () => {
  for (const scenario of [
    idlePastSweep(adapterTelegramScenario, 'w5g-slow-adapter-telegram'),
    idlePastSweep(adapterTelegramScenario, 'w5g-slow-adapter-telegram-tracked', (env) => ({ trackedDirectories: [env.agentsDir] })),
  ]) {
    it(`${scenario.name}: a scenario that outlasts the 2 s sweep timer records the same agent state as a fast one`, async () => {
      const result = await runScenario(scenario, embeddedBackend)
      for (const agent of ['agents/agent-1.adf', 'agents/agent-2.adf']) {
        const tables = result.raw.state.adf[agent].tables
        expect(tables.adf_attestations.rows, `${agent} adf_attestations`).toEqual([])
        expect(tables.adf_identity.rows, `${agent} adf_identity`).toEqual([])
      }
    }, 60_000)
  }
})
