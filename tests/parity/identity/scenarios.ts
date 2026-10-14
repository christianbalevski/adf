import { IPC } from '../../../src/shared/constants/ipc-channels'
import type { ParityScenario } from '../harness/scenario'

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
    await ctx.invoke(IPC.IDENTITY_SET, { purpose: 'app:token', value: 'token-2' })
    await ctx.invoke(IPC.IDENTITY_GET, { purpose: 'app:token' })
    await ctx.invoke(IPC.IDENTITY_SET_CODE_ACCESS, { purpose: 'app:token', codeAccess: true })
    await ctx.invoke(IPC.IDENTITY_LIST, { prefix: 'app:' })
    await ctx.invoke(IPC.IDENTITY_DELETE, { purpose: 'app:token' })
    await ctx.invoke(IPC.IDENTITY_LIST, { prefix: 'app:' })
    await ctx.invoke(IPC.IDENTITY_GET, { purpose: 'app:token' })
  },
}

export const IDENTITY_SCENARIOS: readonly ParityScenario[] = [ownerIdentityScenario, agentKeystoreScenario]
