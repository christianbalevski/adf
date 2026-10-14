import { join } from 'node:path'
import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import type { StartInState } from '../../../src/shared/types/adf-v02.types'
import type { ParityEnv } from './env'
import identityFixture from './identity.fixture.json'
import { MOCK_MODEL_ID, type MockLlm } from './mock-llm'

/**
 * Fixture agents and the settings file every run starts from.
 *
 * Owner and runtime identity are fixed (`identity.fixture.json`: a test-only
 * owner phrase, runtime key and delegation, generated once with
 * SettingsService.ensureRuntimeIdentity; `safe:` values use the electron
 * fake's safeStorage encoding). A backend that adopts the existing identity
 * prints `<did:owner>`/`<did:runtime>`; one that mints its own prints `<did#n>`.
 *
 * Fixture agents are the owner's own agents, already on disk before the
 * backend boots: fixed UUID ids, the file basename as the name, the mock LLM
 * as provider, marked reviewed. Their signing keys are NOT pre-minted: the
 * backend mints them on open (reviewed files get keys), so agent DIDs are
 * fresh each run and appear as `<did#n>`.
 */

export type FixtureName = 'agent-1' | 'agent-2'

export const FIXTURE_IDS: Record<FixtureName, string> = {
  'agent-1': '5f1d7a3e-2c4b-4e8a-9b6d-0a1b2c3d4e01',
  'agent-2': '5f1d7a3e-2c4b-4e8a-9b6d-0a1b2c3d4e02',
}

export const MOCK_PROVIDER_ID = 'parity-llm'

/** The fixed owner/runtime identity seeded into every run's settings. */
export const IDENTITY: { ownerDid: string; runtimeDid: string; runtimeId: string } & Record<string, unknown> = identityFixture

export interface FixtureSpec {
  name: FixtureName
  /** Default 'idle': start runs no startup turn unless the scenario asks for one. */
  startInState?: StartInState
}

export interface FixtureAgent {
  name: FixtureName
  id: string
  filePath: string
}

export function createFixtureAgents(env: ParityEnv, specs: readonly FixtureSpec[]): Record<string, FixtureAgent> {
  const out: Record<string, FixtureAgent> = {}
  for (const spec of specs) {
    const filePath = join(env.agentsDir, `${spec.name}.adf`)
    const workspace = AdfWorkspace.create(filePath, {
      name: spec.name,
      handle: spec.name,
      // Fixed: create() otherwise picks a random icon.
      icon: '🤖',
      autonomous: false,
      start_in_state: spec.startInState ?? 'idle',
      model: { provider: MOCK_PROVIDER_ID, model_id: MOCK_MODEL_ID },
    })
    try {
      const config = workspace.getAgentConfig()
      config.id = FIXTURE_IDS[spec.name]
      workspace.setAgentConfig(config)
    } finally {
      workspace.close()
    }
    out[spec.name] = { name: spec.name, id: FIXTURE_IDS[spec.name], filePath }
  }
  return out
}

/**
 * The settings file both backends read. Everything Studio would fetch from
 * the network on its own (update checks, remote catalogs, provider probes)
 * is off; the mesh is off unless a scenario turns it on; the macOS menu bar
 * is off so one recording serves every OS. Native notifications keep their
 * default (on). Scenario overrides are merged on top.
 */
export function baseSettings(
  env: ParityEnv,
  llm: MockLlm,
  agents: Record<string, FixtureAgent>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...identityFixture,
    providers: [{
      id: MOCK_PROVIDER_ID,
      type: 'openai-compatible',
      name: 'Parity LLM',
      baseUrl: llm.baseUrl,
      apiKey: 'parity-api-key',
      defaultModel: MOCK_MODEL_ID,
    }],
    defaultProviderId: MOCK_PROVIDER_ID,
    agentsFolder: env.agentsDir,
    trackedDirectories: [],
    reviewedAgents: Object.fromEntries(Object.values(agents).map((a) => [a.id, 'accepted'])),
    meshEnabled: false,
    meshLan: false,
    updateChecksEnabled: false,
    remoteCatalogsEnabled: false,
    providerChecksEnabled: false,
    spellcheckDownloadsEnabled: false,
    menuBarEnabled: false,
    ...overrides,
  }
}
