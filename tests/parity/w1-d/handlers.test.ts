import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { AdfWorkspace } from '../../../src/main/adf/adf-workspace'
import { listAdapterCredentialFiles, listMcpCredentialFiles, listProviderCredentialFiles } from '../../../src/main/services/credential-list-files'
import { IPC } from '../../../src/shared/constants/ipc-channels'
import { embeddedBackend } from '../harness/backend'
import { MOCK_PROVIDER_ID } from '../harness/fixtures'
import { runScenario, type ParityScenario } from '../harness/scenario'

/**
 * Handler-level tests for the Studio IPC handlers whose bodies W1-D moved
 * into shared modules (E1). Each scenario drives `registerAllIpcHandlers`
 * through the parity harness's fake `ipcMain`, so the handler wiring in
 * ipc/index.ts (argument mapping, which workspace, cache side effects) is
 * exercised end to end, not only the extracted function.
 */

type Res = Record<string, unknown>

/** Write rows into a fixture file before the backend opens it. */
function editFile(filePath: string, edit: (ws: AdfWorkspace) => void): void {
  const ws = AdfWorkspace.open(filePath)
  try { edit(ws) } finally { ws.close() }
}

/** Read-only look at one identity row of a file the backend may hold open. */
function identityAlgo(filePath: string, purpose: string): string | null {
  const db = new Database(filePath, { readonly: true, fileMustExist: true })
  try {
    const row = db.prepare('SELECT encryption_algo FROM adf_identity WHERE purpose = ?').get(purpose) as { encryption_algo: string } | undefined
    return row?.encryption_algo ?? null
  } finally {
    db.close()
  }
}

const providerAndLists: ParityScenario = {
  name: 'w1d-provider-test-and-credential-lists',
  description: 'PROVIDER_TEST with and without force under the opt-out; the three CREDENTIAL_LIST_FILES handlers; AGENT_REGISTRY_BRING_HOME.',
  fixtures: [{ name: 'agent-1' }, { name: 'agent-2' }],
  quietMs: 500,
  async run(ctx) {
    const agent1 = ctx.agent('agent-1')
    const agent2 = ctx.agent('agent-2')
    editFile(agent2.filePath, (ws) => {
      ws.setIdentity('mcp:@acme/server:API_KEY', 'mcp-secret')
      ws.setIdentity('adapter:telegram:BOT_TOKEN', 'bot-secret')
      ws.setIdentity(`provider:${MOCK_PROVIDER_ID}:apiKey`, 'provider-secret')
    })
    await ctx.invoke(IPC.SETTINGS_SET, { trackedDirectories: [ctx.env.agentsDir] })
    await ctx.invoke(IPC.FILE_OPEN, { filePath: agent1.filePath })

    // providerChecksEnabled is off (baseSettings): without force nothing is probed.
    expect(await ctx.invoke<Res>(IPC.PROVIDER_TEST, { providerId: MOCK_PROVIDER_ID })).toEqual({ status: 'unknown' })
    const forced = await ctx.invoke<Res>(IPC.PROVIDER_TEST, { providerId: MOCK_PROVIDER_ID, force: true })
    expect(['ok', 'failed']).toContain(forced.status)
    expect(await ctx.invoke<Res>(IPC.PROVIDER_TEST, { providerId: 'missing' })).toEqual({ status: 'unconfigured' })

    // The open file comes first, then the tracked folder; values never.
    const sources = { knownFiles: [agent1.filePath], trackedDirs: [ctx.env.agentsDir] }
    const mcp = await ctx.invoke<Res>(IPC.MCP_CREDENTIAL_LIST_FILES, { mcpServerName: 'acme', npmPackage: '@acme/server' })
    expect(mcp).toEqual(listMcpCredentialFiles({ mcpServerName: 'acme', npmPackage: '@acme/server' }, sources))
    expect(mcp.files).toEqual([{ filePath: agent2.filePath, fileName: 'agent-2.adf', hasCredentials: true, populatedKeys: ['API_KEY'] }])
    const adapters = await ctx.invoke<Res>(IPC.ADAPTER_CREDENTIAL_LIST_FILES, { adapterType: 'telegram' })
    expect(adapters).toEqual(listAdapterCredentialFiles('telegram', sources))
    expect((adapters.files as unknown[]).length).toBe(1)
    const providers = await ctx.invoke<Res>(IPC.PROVIDER_CREDENTIAL_LIST_FILES, { providerId: MOCK_PROVIDER_ID })
    expect(providers).toEqual(listProviderCredentialFiles(MOCK_PROVIDER_ID, sources))
    expect((providers.files as Array<{ fileName: string }>).map((f) => f.fileName).sort()).toEqual(['agent-2.adf'])
    expect(JSON.stringify([mcp, adapters, providers])).not.toMatch(/secret/)
    expect(await ctx.invoke<Res>(IPC.MCP_CREDENTIAL_LIST_FILES, { mcpServerName: 'acme' })).toEqual({ files: [] })

    // Bring a bundled registry agent home: into agentsFolder, no identity, the app default provider.
    expect(await ctx.invoke<Res>(IPC.AGENT_REGISTRY_BRING_HOME, { id: '' })).toEqual({ success: false, error: 'Missing registry id' })
    const home = await ctx.invoke<Res>(IPC.AGENT_REGISTRY_BRING_HOME, { id: 'ash' })
    expect(home).toMatchObject({ success: true })
    const filePath = String(home.filePath)
    expect(filePath.startsWith(ctx.env.agentsDir)).toBe(true)
    const copy = AdfWorkspace.open(filePath)
    try {
      expect(copy.getDid()).toBeNull()
      expect(copy.getAgentConfig().model.provider).toBe(MOCK_PROVIDER_ID)
      expect(copy.getAgentConfig().name).toBe('ash')
    } finally {
      copy.close()
    }
    expect((await ctx.invoke<Res>(IPC.AGENT_REGISTRY_BRING_HOME, { id: 'no-such-agent' })).success).toBe(false)
  },
}

const envelopeAndAttestations: ParityScenario = {
  name: 'w1d-envelope-and-attestations',
  description: 'IDENTITY_ENVELOPE_STATUS / SHARE_SET / SHARE_REMOVE / UNLOCK_PASSWORD and IDENTITY_ATTESTATIONS_GET / REISSUE on the open file.',
  fixtures: [{ name: 'agent-1' }],
  quietMs: 500,
  async run(ctx) {
    expect(await ctx.invoke<Res>(IPC.IDENTITY_ENVELOPE_STATUS)).toEqual({ success: false, error: 'No ADF open' })
    await ctx.invoke(IPC.FILE_OPEN, { filePath: ctx.agent('agent-1').filePath })
    expect(await ctx.invoke<Res>(IPC.IDENTITY_ENVELOPE_STATUS)).toEqual({ success: true, identity: 'unlocked', credentials: 'unlocked', sharePasswordSet: false })
    expect(await ctx.invoke<Res>(IPC.IDENTITY_ENVELOPE_SHARE_SET_PASSWORD, 'seven77')).toEqual({ success: false, error: 'Share password must be at least 8 characters' })
    expect(await ctx.invoke<Res>(IPC.IDENTITY_ENVELOPE_SHARE_SET_PASSWORD, 'eight888')).toEqual({ success: true })
    expect((await ctx.invoke<Res>(IPC.IDENTITY_ENVELOPE_STATUS)).sharePasswordSet).toBe(true)
    expect(await ctx.invoke<Res>(IPC.IDENTITY_ENVELOPE_UNLOCK_PASSWORD, 'eight888', false)).toEqual({ success: true, adopted: false, credentials: 'unlocked' })
    expect(await ctx.invoke<Res>(IPC.IDENTITY_ENVELOPE_UNLOCK_PASSWORD, 'eight888')).toEqual({ success: true, adopted: true, credentials: 'unlocked' })
    expect(await ctx.invoke<Res>(IPC.IDENTITY_ENVELOPE_SHARE_REMOVE_PASSWORD)).toEqual({ success: true })
    expect((await ctx.invoke<Res>(IPC.IDENTITY_ENVELOPE_STATUS)).sharePasswordSet).toBe(false)

    const atts = await ctx.invoke<Res>(IPC.IDENTITY_ATTESTATIONS_GET)
    expect(typeof atts.did).toBe('string')
    expect((atts.attestations as unknown[]).length).toBeGreaterThan(0)
    const reissued = await ctx.invoke<Res>(IPC.IDENTITY_ATTESTATIONS_REISSUE)
    expect(reissued.success).toBe(true)
  },
}

const FOREIGN_OWNER = 'did:key:z6MkforeignOwnerForTheW1dClaimScenario000000000'

const claimPasswordFile: ParityScenario = {
  name: 'w1d-claim-password-file',
  description: 'IDENTITY_CLAIM on a foreign whole-file-password agent: unlock, claim, then a provider credential write must not reuse the dropped derived key.',
  fixtures: [{ name: 'agent-2' }],
  quietMs: 500,
  async run(ctx) {
    const agent = ctx.agent('agent-2')
    editFile(agent.filePath, (ws) => {
      ws.generateIdentityKeys(null)
      ws.getDatabase().setMeta('adf_owner_did', FOREIGN_OWNER, 'readonly')
      ws.setPassword('hunter22')
    })
    expect(await ctx.invoke<Res>(IPC.FILE_OPEN, { filePath: agent.filePath })).toMatchObject({ needsPassword: true })
    // Claim needs the derived key first.
    expect(await ctx.invoke<Res>(IPC.IDENTITY_CLAIM)).toEqual({ success: false, error: 'File is password-protected — enter the password before claiming' })
    expect(await ctx.invoke<Res>(IPC.IDENTITY_PASSWORD_UNLOCK, { password: 'hunter22' })).toMatchObject({ success: true })
    expect(await ctx.invoke<Res>(IPC.IDENTITY_PASSWORD_CHECK)).toEqual({ needsPassword: true }) // foreign: not converted
    const claimed = await ctx.invoke<Res>(IPC.IDENTITY_CLAIM)
    expect(claimed.success).toBe(true)
    expect(typeof claimed.did).toBe('string')
    expect(await ctx.invoke<Res>(IPC.IDENTITY_PASSWORD_CHECK)).toEqual({ needsPassword: false })

    // The claim dropped the password and the cached derived key: the next
    // credential write is sealed in the new envelope, not encrypted with the stale key.
    expect(await ctx.invoke<Res>(IPC.PROVIDER_CREDENTIAL_SET, { filePath: agent.filePath, providerId: MOCK_PROVIDER_ID, value: 'k-after-claim' })).toEqual({ success: true })
    expect(identityAlgo(agent.filePath, `provider:${MOCK_PROVIDER_ID}:apiKey`)).toBe('env:credentials')
  },
}

describe('parity: W1-D moved handlers through registerAllIpcHandlers', () => {
  for (const scenario of [providerAndLists, envelopeAndAttestations, claimPasswordFile]) {
    it(scenario.name, async () => {
      await runScenario(scenario, embeddedBackend)
    }, 120_000)
  }
})
