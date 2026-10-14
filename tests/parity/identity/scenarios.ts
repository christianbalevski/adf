import { IPC } from '../../../src/shared/constants/ipc-channels'
import type { ParityScenario } from '../harness/scenario'
import identityFixture from '../harness/identity.fixture.json'

/**
 * Identity parity scenarios (tracker W3-B). Each is the renderer's own call
 * sequence: Settings → Identity (IdentityTab, IdentityRestoreBanner) and the
 * agent's Identity panel (IdentityPanel).
 */

/**
 * Settings → Identity: the owner panel, "Back up seed phrase" (reveal from
 * the shared keychain entry in daemon mode, §5.4) and its confirmation.
 * With no agent file open, the agent Identity panel's calls answer as with
 * no workspace.
 */
export const ownerIdentityScenario: ParityScenario = {
  name: 'owner-identity',
  description: 'Settings → Identity: status, back up the seed phrase, confirm, status again; the agent panel with no file open.',
  fixtures: [],
  quietMs: 500,
  async run(ctx) {
    await ctx.invoke(IPC.IDENTITY_OWNER_STATUS)
    await ctx.invoke(IPC.IDENTITY_OWNER_REVEAL_MNEMONIC)
    await ctx.invoke(IPC.IDENTITY_OWNER_CONFIRM_BACKUP)
    await ctx.invoke(IPC.IDENTITY_OWNER_STATUS)
    // IdentityPanel.refresh() with no file open.
    await ctx.invoke(IPC.IDENTITY_GET_DID)
    await ctx.invoke(IPC.IDENTITY_LIST_ENTRIES)
    await ctx.invoke(IPC.IDENTITY_PASSWORD_CHECK)
    await ctx.invoke(IPC.IDENTITY_ATTESTATIONS_GET)
    await ctx.invoke(IPC.IDENTITY_ENVELOPE_STATUS)
    await ctx.invoke(IPC.IDENTITY_REVEAL, { purpose: 'app:token' })
  },
}

/**
 * The agent's Identity panel on a running agent: add a key, reveal it,
 * replace it, toggle code access, list, delete. Values reach the panel as
 * embedded shows them (the daemon's local-only reveal route). The agent is
 * not stopped: embedded Studio's stop of an agent started idle pushes a
 * startup-dispatch error that is not this scenario's subject.
 */
export const agentKeystoreScenario: ParityScenario = {
  name: 'agent-keystore',
  description: 'Open and start agent-1 (start_in_state idle: no startup turn); in its Identity panel add app:token, reveal, replace, code access, list, delete. The agent keeps running (as in chat-tool-call).',
  fixtures: [{ name: 'agent-1' }],
  quietMs: 1000,
  async run(ctx) {
    const agent = ctx.agent('agent-1')
    await ctx.invoke(IPC.FILE_OPEN, { filePath: agent.filePath })
    await ctx.invoke(IPC.AGENT_START, { filePath: agent.filePath, hasUserMessage: false })
    await ctx.invoke(IPC.IDENTITY_PASSWORD_CHECK)
    await ctx.invoke(IPC.IDENTITY_SET, { purpose: 'app:token', value: 'token-1' })
    await ctx.invoke(IPC.IDENTITY_REVEAL, { purpose: 'app:token' })
    // Key material is never revealed, in either mode: the panel shows why.
    await ctx.invoke(IPC.IDENTITY_REVEAL, { purpose: 'crypto:signing:private_key' })
    await ctx.invoke(IPC.IDENTITY_GET, { purpose: 'crypto:signing:private_key' })
    await ctx.invoke(IPC.IDENTITY_SET, { purpose: 'app:token', value: 'token-2' })
    await ctx.invoke(IPC.IDENTITY_GET, { purpose: 'app:token' })
    await ctx.invoke(IPC.IDENTITY_SET_CODE_ACCESS, { purpose: 'app:token', codeAccess: true })
    await ctx.invoke(IPC.IDENTITY_LIST, { prefix: 'app:' })
    await ctx.invoke(IPC.IDENTITY_DELETE, { purpose: 'app:token' })
    await ctx.invoke(IPC.IDENTITY_LIST, { prefix: 'app:' })
    await ctx.invoke(IPC.IDENTITY_GET, { purpose: 'app:token' })
  },
}

/**
 * The owner's own legacy whole-file-password file: open (needs the
 * password), a wrong password, the right one. Unlock converts it (design
 * §5.4, envelope-actions.ts convertOwnLegacyPassword): the password is
 * removed, keys and envelopes are minted, and the same password becomes the
 * credentials envelope's share password.
 *
 * Embedded only for now: in daemon mode the unlock reaches a file that is
 * not running only through the client session's hold, which Studio main
 * gets with W2-C2. The daemon's conversion is covered by
 * tests/daemon-owner-envelope-api.test.ts.
 */
export const legacyPasswordUnlockScenario: ParityScenario = {
  name: 'legacy-password-unlock',
  description: 'Open agent-1 (legacy whole-file password), unlock with a wrong then the right password: converted to envelopes.',
  fixtures: [{ name: 'agent-1', legacyPassword: 'legacy-pw-1' }],
  quietMs: 500,
  async run(ctx) {
    const agent = ctx.agent('agent-1')
    await ctx.invoke(IPC.FILE_OPEN, { filePath: agent.filePath })
    await ctx.invoke(IPC.IDENTITY_PASSWORD_CHECK)
    await ctx.invoke(IPC.IDENTITY_PASSWORD_UNLOCK, { password: 'wrong-password' })
    await ctx.invoke(IPC.IDENTITY_PASSWORD_UNLOCK, { password: 'legacy-pw-1' })
    await ctx.invoke(IPC.IDENTITY_PASSWORD_CHECK)
    await ctx.invoke(IPC.IDENTITY_ENVELOPE_STATUS)
    await ctx.invoke(IPC.IDENTITY_REVEAL, { purpose: 'app:token' })
    await ctx.invoke(IPC.IDENTITY_LIST_ENTRIES)
  },
}

/** Run against embedded Studio only, each with the reason (above). */
export const IDENTITY_EMBEDDED_ONLY: readonly ParityScenario[] = [legacyPasswordUnlockScenario]

/** The fixture owner's phrase (the identity fixture's `safe:` encoding, harness/electron-fake.ts). */
function fixturePhrase(): string {
  const raw = Buffer.from(String((identityFixture as Record<string, unknown>).ownerMnemonic).replace(/^safe:/, ''), 'base64').toString('utf-8')
  return raw.slice('parity-safe:'.length)
}

/**
 * Settings → Identity → Restore identity with the phrase of the owner on
 * record (`expectedOwnerDid`), then a phrase of another owner in restore
 * mode (refused before anything changes), then status.
 */
export const ownerImportScenario: ParityScenario = {
  name: 'owner-import',
  description: 'Restore the owner identity with its own phrase; a restore with another phrase is refused; status.',
  fixtures: [],
  quietMs: 500,
  async run(ctx) {
    const status = await ctx.invoke<{ ownerDid: string }>(IPC.IDENTITY_OWNER_STATUS)
    await ctx.invoke(IPC.IDENTITY_OWNER_IMPORT, fixturePhrase(), status.ownerDid)
    await ctx.invoke(IPC.IDENTITY_OWNER_IMPORT, 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', status.ownerDid)
    await ctx.invoke(IPC.IDENTITY_OWNER_IMPORT, 'not a phrase')
    await ctx.invoke(IPC.IDENTITY_OWNER_STATUS)
  },
}

/**
 * Claim a running agent under the local owner (fresh identity), then store
 * and read back a value: the write survives the claim.
 */
export const agentClaimScenario: ParityScenario = {
  name: 'agent-claim',
  description: 'Open and start agent-1; claim it; store app:token and reveal it; DID and attestations.',
  fixtures: [{ name: 'agent-1' }],
  quietMs: 1000,
  async run(ctx) {
    const agent = ctx.agent('agent-1')
    await ctx.invoke(IPC.FILE_OPEN, { filePath: agent.filePath })
    await ctx.invoke(IPC.AGENT_START, { filePath: agent.filePath, hasUserMessage: false })
    await ctx.invoke(IPC.IDENTITY_CLAIM)
    await ctx.invoke(IPC.IDENTITY_SET, { purpose: 'app:token', value: 'after-claim' })
    await ctx.invoke(IPC.IDENTITY_REVEAL, { purpose: 'app:token' })
    await ctx.invoke(IPC.IDENTITY_GET_DID)
    await ctx.invoke(IPC.IDENTITY_ATTESTATIONS_GET)
  },
}

export const IDENTITY_SCENARIOS: readonly ParityScenario[] = [ownerIdentityScenario, agentKeystoreScenario, ownerImportScenario, agentClaimScenario]
