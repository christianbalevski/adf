import { join } from 'node:path'
import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { extractRawX25519PublicKey, generateX25519KeyPair } from '../../../src/main/crypto/envelope-crypto'
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

export type FixtureName = 'agent-1' | 'agent-2' | 'agent-3'

export const FIXTURE_IDS: Record<FixtureName, string> = {
  'agent-1': '5f1d7a3e-2c4b-4e8a-9b6d-0a1b2c3d4e01',
  'agent-2': '5f1d7a3e-2c4b-4e8a-9b6d-0a1b2c3d4e02',
  'agent-3': '5f1d7a3e-2c4b-4e8a-9b6d-0a1b2c3d4e03',
}

export const MOCK_PROVIDER_ID = 'parity-llm'

/**
 * The creation date every fixture's document states. AdfWorkspace.create
 * writes today's UTC date into README.md (`Created: YYYY-MM-DD`,
 * getDefaultDocumentContent), a value no normalizer rule sees (a bare date
 * is no instant) and that changes at 00:00 UTC, so every recording that
 * shows the document or its bytes would differ from one day to the next.
 * The fixture builder pins it; the committed recordings were made on this date.
 */
export const FIXTURE_CREATED_DATE = '2026-10-14'

/** The fixed owner/runtime identity seeded into every run's settings. */
export const IDENTITY: { ownerDid: string; runtimeDid: string; runtimeId: string } & Record<string, unknown> = identityFixture

export interface FixtureSpec {
  name: FixtureName
  /** Default 'idle': start runs no startup turn unless the scenario asks for one. */
  startInState?: StartInState
  /** A legacy whole-file password (deprecated mechanism, still opened and converted), with one stored value under it. */
  legacyPassword?: string
  /**
   * Envelopes sealed to another owner and runtime, the credentials one with
   * this share password and the mock provider's key sealed in it: locked on
   * this machine until the password is entered.
   */
  lockedCredentials?: { sharePassword: string }
  /** Envelopes sealed to the fixture owner and runtime (this machine's), with the mock provider's key sealed in the credentials one. */
  ownerSealedKey?: string
  /** Built-in tools turned on (enabled and visible), e.g. `mcp_restart`. */
  enableTools?: readonly string[]
  /** MCP servers in the agent's config (`mcp.servers`), e.g. an OAuth remote attach cannot express. */
  mcpServers?: ReadonlyArray<Record<string, unknown>>
  /** Default true. False: not in reviewedAgents, so opening it asks for a review. */
  reviewed?: boolean
}

export interface FixtureAgent {
  name: FixtureName
  id: string
  filePath: string
  reviewed: boolean
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
      const document = workspace.readDocument()
      const pinned = document.replace(/^Created: \d{4}-\d{2}-\d{2}$/m, `Created: ${FIXTURE_CREATED_DATE}`)
      if (pinned !== document) workspace.writeDocument(pinned)
      const config = workspace.getAgentConfig()
      config.id = FIXTURE_IDS[spec.name]
      for (const name of spec.enableTools ?? []) {
        const tool = config.tools.find((t) => t.name === name)
        if (tool) Object.assign(tool, { enabled: true, visible: true })
        else config.tools.push({ name, enabled: true, visible: true })
      }
      if (spec.mcpServers) config.mcp = { ...config.mcp, servers: spec.mcpServers.map((server) => ({ ...server })) } as typeof config.mcp
      workspace.setAgentConfig(config)
      if (spec.ownerSealedKey) {
        workspace.provisionEnvelopes({
          ownerDid: IDENTITY.ownerDid,
          ownerEncPublicKey: Buffer.from(String(identityFixture.ownerEncPublicKey), 'base64'),
          runtimeDid: IDENTITY.runtimeDid,
          runtimeEncPublicKey: Buffer.from(String(identityFixture.runtimeEncPublicKey), 'base64'),
        })
        workspace.setIdentity(`provider:${MOCK_PROVIDER_ID}:apiKey`, spec.ownerSealedKey)
      }
      if (spec.lockedCredentials) {
        const encKey = () => extractRawX25519PublicKey(generateX25519KeyPair().publicKey)
        workspace.provisionEnvelopes({ ownerDid: 'did:key:z6MkParityForeignOwner', ownerEncPublicKey: encKey(), runtimeDid: 'did:key:z6MkParityForeignRuntime', runtimeEncPublicKey: encKey() })
        workspace.setIdentity(`provider:${MOCK_PROVIDER_ID}:apiKey`, 'sealed-old')
        workspace.addEnvelopePasswordSlot('credentials', spec.lockedCredentials.sharePassword)
      }
      if (spec.legacyPassword) {
        workspace.setIdentity('app:token', 'legacy-secret')
        workspace.setPassword(spec.legacyPassword)
      }
    } finally {
      workspace.close()
    }
    out[spec.name] = { name: spec.name, id: FIXTURE_IDS[spec.name], filePath, reviewed: spec.reviewed !== false }
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
    reviewedAgents: Object.fromEntries(Object.values(agents).filter((a) => a.reviewed).map((a) => [a.id, 'accepted'])),
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
