import { dirname, join } from 'node:path'
import { IPC } from '../../../src/shared/constants/ipc-channels'
import type { ParityScenario, ScenarioContext } from '../harness/scenario'

/**
 * W3-A's parity scenarios (tracker W3-A acceptance): files, documents, agent
 * runtime, review and templates, each the renderer's own call sequence for
 * the flow (preload `window.adfApi` → channel), including the reads the
 * renderer makes after it.
 */

type AgentEvent = { type?: string; payload?: { state?: string; filePath?: string } }
const isEvent = (type: string) => (p: unknown) => (p as AgentEvent)?.type === type
const isState = (state: string) => (p: unknown) =>
  (p as AgentEvent)?.type === 'state_changed' && (p as AgentEvent).payload?.state === state
/** A background batch carrying `type` for `filePath`. */
const inBatch = (type: string, filePath: string) => (p: unknown) =>
  Array.isArray(p) && (p as AgentEvent[]).some((e) => e.type === type && e.payload?.filePath === filePath)

/** useAdfFile.openFile: FILE_OPEN, then fetchFileContents (batch + default editor tabs). */
async function openAgent(ctx: ScenarioContext, filePath: string): Promise<{ success?: boolean; agentWasRunning?: boolean; needsPassword?: boolean }> {
  const opened = await ctx.invoke<{ success?: boolean; agentWasRunning?: boolean; needsPassword?: boolean }>(IPC.FILE_OPEN, { filePath })
  if (opened?.needsPassword) return opened
  await ctx.invoke(IPC.DOC_GET_BATCH)
  for (const path of ['mind.md', 'soul.md']) {
    await ctx.invoke(IPC.DOC_READ_INTERNAL_FILE, { path, binaryContent: false })
  }
  return opened
}

export const switchWithBackgroundScenario: ParityScenario = {
  name: 'switch-with-background',
  description:
    'Start agent-2, switch to agent-1 while agent-2 runs in the background, chat with agent-2 from the background, then switch back to it (re-attach) and stop it.',
  fixtures: [{ name: 'agent-1' }, { name: 'agent-2' }],
  quietMs: 1000,
  backgroundStreamsOnly: true,
  llm: (req) => (req.isPreflight ? { text: 'ok' } : { text: 'Background reply.' }),
  async run(ctx) {
    const agent1 = ctx.agent('agent-1')
    const agent2 = ctx.agent('agent-2')
    await openAgent(ctx, agent2.filePath)
    await ctx.invoke(IPC.AGENT_START, { filePath: agent2.filePath, hasUserMessage: false })
    await openAgent(ctx, agent1.filePath)
    await ctx.waitForPush(IPC.BACKGROUND_AGENT_EVENT_BATCH, 'agent-2 listed in the background', inBatch('agent_started', agent2.filePath))
    await ctx.invoke(IPC.BACKGROUND_AGENT_STATUS)
    await ctx.invoke(IPC.FILE_CHECK_REVIEW)
    await ctx.invoke(IPC.AGENT_INVOKE, { userMessage: 'Hello from the fleet bar.', filePath: agent2.filePath })
    await ctx.waitForPush(IPC.BACKGROUND_AGENT_EVENT_BATCH, 'agent-2 turn complete', inBatch('turn_complete', agent2.filePath))
    const back = await openAgent(ctx, agent2.filePath)
    if (back?.agentWasRunning) await ctx.invoke(IPC.AGENT_START)
    await ctx.invoke(IPC.DOC_GET_CHAT, {})
    await ctx.invoke(IPC.AGENT_STATUS)
    await ctx.invoke(IPC.AGENT_STOP)
    await ctx.invoke(IPC.BACKGROUND_AGENT_STATUS)
  },
}

export const passwordUnlockScenario: ParityScenario = {
  name: 'password-unlock',
  description: 'Open agent-1, protected by a legacy file password: the open asks for it, the unlock opens the file, then the agent starts and stops.',
  fixtures: [{ name: 'agent-1', legacyPassword: 'parity-password' }],
  quietMs: 1000,
  async run(ctx) {
    const agent = ctx.agent('agent-1')
    await openAgent(ctx, agent.filePath)
    await ctx.invoke(IPC.IDENTITY_PASSWORD_UNLOCK, { password: 'wrong-password' })
    await ctx.invoke(IPC.IDENTITY_PASSWORD_UNLOCK, { password: 'parity-password' })
    // PasswordDialog → completeFileOpen: contents, then the review check.
    await ctx.invoke(IPC.DOC_GET_BATCH)
    await ctx.invoke(IPC.FILE_CHECK_REVIEW)
    await ctx.invoke(IPC.AGENT_START, { filePath: agent.filePath, hasUserMessage: false })
    await ctx.invoke(IPC.AGENT_STATUS)
    await ctx.invoke(IPC.AGENT_STOP)
  },
}

export const configDuringStartScenario: ParityScenario = {
  name: 'config-during-start',
  description: 'Open agent-1 and save a config edit while its start is in flight: the running agent and the file keep the edit.',
  fixtures: [{ name: 'agent-1' }],
  quietMs: 1000,
  async run(ctx) {
    const agent = ctx.agent('agent-1')
    await openAgent(ctx, agent.filePath)
    const config = await ctx.invoke<Record<string, unknown>>(IPC.DOC_GET_AGENT_CONFIG)
    const starting = ctx.invoke(IPC.AGENT_START, { filePath: agent.filePath, hasUserMessage: false })
    await ctx.invoke(IPC.DOC_SET_AGENT_CONFIG, { ...config, description: 'Edited while starting.' })
    await starting
    await ctx.invoke(IPC.DOC_GET_AGENT_CONFIG)
    await ctx.invoke(IPC.AGENT_STATUS)
    await ctx.invoke(IPC.AGENT_STOP)
    await ctx.invoke(IPC.DOC_GET_AGENT_CONFIG)
  },
}

export const reviewAcceptForeignScenario: ParityScenario = {
  name: 'review-accept-foreign',
  description: 'Open agent-2, a file this owner never reviewed and that has no identity: the review asks to claim it, the accept claims it.',
  fixtures: [{ name: 'agent-2', reviewed: false }],
  quietMs: 1000,
  async run(ctx) {
    const agent = ctx.agent('agent-2')
    await openAgent(ctx, agent.filePath)
    await ctx.invoke(IPC.FILE_CHECK_REVIEW)
    await ctx.invoke(IPC.FILE_REVIEW_ACCEPT, { claim: true, expectedPath: join(dirname(agent.filePath), 'agent-1.adf') })
    await ctx.invoke(IPC.FILE_REVIEW_ACCEPT, { claim: true, expectedPath: agent.filePath })
    await ctx.invoke(IPC.FILE_CHECK_REVIEW)
    await ctx.invoke(IPC.DOC_GET_AGENT_CONFIG)
    await ctx.invoke(IPC.FILE_GET_CURRENT)
  },
}

export const templateCreateScenario: ParityScenario = {
  name: 'template-create',
  description: 'List the templates, create one, and list them again once the change settled.',
  fixtures: [],
  quietMs: 1000,
  async run(ctx) {
    await ctx.invoke(IPC.TEMPLATES_LIST)
    await ctx.invoke(IPC.TEMPLATE_CREATE, { name: 'Team agent' })
    // The write pushes TEMPLATES_CHANGED (debounced 150 ms); the folder
    // watcher's own event for the new file lands within its debounce, so
    // the renderer sees one refresh.
    await ctx.waitForPush(IPC.TEMPLATES_CHANGED, 'templates changed', () => true)
    await ctx.invoke(IPC.TEMPLATES_LIST)
  },
}

export const renameWhileRunningScenario: ParityScenario = {
  name: 'rename-while-running',
  description: 'Rename agent-1 while it runs (deferred), stop it: the file moves then and the renderer hears of it.',
  fixtures: [{ name: 'agent-1' }, { name: 'agent-2' }],
  quietMs: 1000,
  async run(ctx) {
    const agent = ctx.agent('agent-1')
    await openAgent(ctx, agent.filePath)
    await ctx.invoke(IPC.AGENT_START, { filePath: agent.filePath, hasUserMessage: false })
    await ctx.invoke(IPC.FILE_RENAME, { filePath: agent.filePath, newName: 'bad/name' })
    await ctx.invoke(IPC.FILE_RENAME, { filePath: agent.filePath, newName: 'agent-2' })
    await ctx.invoke(IPC.FILE_RENAME, { filePath: agent.filePath, newName: 'agent-1-renamed' })
    await ctx.invoke(IPC.FILE_GET_CURRENT)
    await ctx.invoke(IPC.AGENT_STOP)
    await ctx.waitForPush(IPC.FILE_RENAMED, 'file moved after the stop', () => true)
    await ctx.invoke(IPC.FILE_GET_CURRENT)
    await ctx.invoke(IPC.DOC_GET_AGENT_CONFIG)
  },
}

export const deleteScenario: ParityScenario = {
  name: 'delete',
  description: 'With agent-1 open, delete agent-2 (closed) and then agent-1 itself (the open file).',
  fixtures: [{ name: 'agent-1' }, { name: 'agent-2' }],
  quietMs: 1000,
  async run(ctx) {
    const agent1 = ctx.agent('agent-1')
    const agent2 = ctx.agent('agent-2')
    await openAgent(ctx, agent1.filePath)
    await ctx.invoke(IPC.FILE_DELETE, { filePath: agent2.filePath })
    await ctx.invoke(IPC.FILE_DELETE, { filePath: agent1.filePath })
    await ctx.invoke(IPC.FILE_GET_CURRENT)
    await ctx.invoke(IPC.FILE_DELETE, { filePath: agent2.filePath })
  },
}

export const docResourcesScenario: ParityScenario = {
  name: 'doc-resources',
  description: 'The resource panels of the open file while its agent is not running: document, timers, internal files (not the listing: its timestamps tie by the millisecond), meta, tasks, inbox, outbox, local tables, older chat, then save and the table listing.',
  fixtures: [{ name: 'agent-1' }],
  quietMs: 1000,
  async run(ctx) {
    const agent = ctx.agent('agent-1')
    await openAgent(ctx, agent.filePath)
    await ctx.invoke(IPC.DOC_GET_DOCUMENT)
    await ctx.invoke(IPC.DOC_SET_DOCUMENT, { content: '# Plan\n\nShip it.' })
    await ctx.invoke(IPC.DOC_GET_DOCUMENT)
    await ctx.invoke(IPC.DOC_GET_TIMERS)
    await ctx.invoke(IPC.DOC_ADD_TIMER, { mode: 'once_at', at: 1, scope: ['agent'] })
    // A fixed instant far ahead: a relative delay would put a run-dependent time in the recording.
    const timer = await ctx.invoke<{ id?: number }>(IPC.DOC_ADD_TIMER, { mode: 'once_at', at: 4_102_444_800_000, scope: ['agent'], payload: 'check in' })
    await ctx.invoke(IPC.DOC_GET_TIMERS)
    if (timer?.id !== undefined) await ctx.invoke(IPC.DOC_DELETE_TIMER, { id: timer.id })
    await ctx.invoke(IPC.DOC_WRITE_INTERNAL_FILE, { path: 'notes/a.md', content: 'first note' })
    await ctx.invoke(IPC.DOC_RENAME_INTERNAL_FILE, { oldPath: 'notes/a.md', newPath: 'notes/b.md' })
    await ctx.invoke(IPC.DOC_SET_FILE_PROTECTION, { path: 'notes/b.md', protection: 'read_only' })
    await ctx.invoke(IPC.DOC_READ_INTERNAL_FILE, { path: 'notes/b.md', binaryContent: false })
    await ctx.invoke(IPC.DOC_DELETE_INTERNAL_FILE, { path: 'notes/missing.md' })
    await ctx.invoke(IPC.DOC_SET_META, { key: 'parity_key', value: 'parity value' })
    await ctx.invoke(IPC.DOC_GET_ALL_META)
    await ctx.invoke(IPC.DOC_DELETE_META, { key: 'parity_key' })
    await ctx.invoke(IPC.DOC_GET_TASKS, {})
    await ctx.invoke(IPC.DOC_GET_INBOX)
    await ctx.invoke(IPC.DOC_GET_OUTBOX)
    await ctx.invoke(IPC.DOC_LIST_LOCAL_TABLES)
    await ctx.invoke(IPC.DOC_QUERY_LOCAL_TABLE, { table: 'adf_config' })
    await ctx.invoke(IPC.DOC_GET_CHAT_OLDER, { beforeSeq: 1_000_000 })
    await ctx.invoke(IPC.FILE_SAVE)
    await ctx.invoke(IPC.FILE_LIST_TABLES, { filePath: agent.filePath })
  },
}

/** W3-A's scenarios, in run order. */
export const DOCUMENT_SCENARIOS: readonly ParityScenario[] = [
  switchWithBackgroundScenario,
  passwordUnlockScenario,
  configDuringStartScenario,
  reviewAcceptForeignScenario,
  templateCreateScenario,
  renameWhileRunningScenario,
  deleteScenario,
  docResourcesScenario,
]
