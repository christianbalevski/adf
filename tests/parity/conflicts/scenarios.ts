import { IPC } from '../../../src/shared/constants/ipc-channels'
import type { ParityScenario, ScenarioContext } from '../harness/scenario'

/**
 * W3-F: write conflicts. Studio's editors save with the revision they last
 * saw (preload `writeInternalFile(path, content, { baseRevision })`,
 * `setDocument(content, { baseRevision })`, `setAgentConfig(config,
 * { baseRevision })`); a save over a revision someone else replaced answers
 * `{ success: false, conflict }` naming the writer, and the editor offers
 * Reload or Keep mine (a save with the conflict's revision as its base).
 * A save without a base still replaces whatever is there.
 */

type AgentEvent = { type?: string; payload?: { state?: string } }
const isEvent = (type: string) => (p: unknown) => (p as AgentEvent)?.type === type
const isState = (state: string) => (p: unknown) =>
  (p as AgentEvent)?.type === 'state_changed' && (p as AgentEvent).payload?.state === state

type Revisioned = { revision?: number; configRevision?: number; documentRevision?: number; success?: boolean; conflict?: { revision?: number } }

/** useAdfFile.openFile: FILE_OPEN, then fetchFileContents (batch + default editor tabs). */
async function openAgent(ctx: ScenarioContext, filePath: string): Promise<Revisioned | undefined> {
  await ctx.invoke(IPC.FILE_OPEN, { filePath })
  const batch = await ctx.invoke<Revisioned>(IPC.DOC_GET_BATCH)
  for (const path of ['mind.md', 'soul.md']) {
    await ctx.invoke(IPC.DOC_READ_INTERNAL_FILE, { path, binaryContent: false })
  }
  return batch
}

export const writeConflictsScenario: ParityScenario = {
  name: 'w3f-write-conflicts',
  description:
    'Studio saves note.md and the document, the agent then rewrites both in a turn; Studio\'s next saves over the revisions it saw are refused naming the agent, and Keep mine saves over the current revision. A save without a base replaces as before.',
  fixtures: [{ name: 'agent-1' }],
  quietMs: 1000,
  llm: (req) => {
    if (req.isPreflight) return { text: 'ok' }
    const toolResults = req.messages.filter((m) => m.role === 'tool').length
    if (toolResults === 0) return { toolCalls: [{ name: 'fs_write', arguments: { mode: 'write', path: 'note.md', content: 'from agent-1' } }] }
    if (toolResults === 1) return { toolCalls: [{ name: 'fs_write', arguments: { mode: 'write', path: 'README.md', content: '# Rewritten by agent-1' } }] }
    return { text: 'Rewrote both.' }
  },
  async run(ctx) {
    const agent = ctx.agent('agent-1')
    const batch = await openAgent(ctx, agent.filePath)

    // The editor's first save of a new file, then a read: both carry the revision.
    const saved = await ctx.invoke<Revisioned>(IPC.DOC_WRITE_INTERNAL_FILE, { path: 'note.md', content: 'from Studio' })
    const note = await ctx.invoke<Revisioned>(IPC.DOC_READ_INTERNAL_FILE, { path: 'note.md', binaryContent: false })
    const doc = await ctx.invoke<Revisioned>(IPC.DOC_GET_DOCUMENT)

    // The agent rewrites both while the editor holds the revisions it read.
    await ctx.invoke(IPC.AGENT_START, { filePath: agent.filePath, hasUserMessage: true })
    await ctx.invoke(IPC.AGENT_INVOKE, { userMessage: 'Rewrite the note and the document.', filePath: agent.filePath })
    await ctx.waitForPush(IPC.AGENT_EVENT, 'turn complete', isEvent('turn_complete'))
    await ctx.waitForPush(IPC.AGENT_EVENT, 'back to idle', isState('idle'))

    // Saves over the stale revisions: refused, naming the agent and carrying its text.
    const stale = await ctx.invoke<Revisioned>(IPC.DOC_WRITE_INTERNAL_FILE, { path: 'note.md', content: 'edited in Studio', baseRevision: note?.revision ?? saved?.revision })
    await ctx.invoke(IPC.DOC_SET_DOCUMENT, { content: '# Edited in Studio', baseRevision: doc?.revision })

    // Keep mine: the save again, over the revision the conflict named.
    await ctx.invoke(IPC.DOC_WRITE_INTERNAL_FILE, { path: 'note.md', content: 'edited in Studio', baseRevision: stale?.conflict?.revision })
    await ctx.invoke(IPC.DOC_READ_INTERNAL_FILE, { path: 'note.md', binaryContent: false })

    // Config: a save over the batch's revision succeeds; a second one over the same base is refused.
    const config = await ctx.invoke<Record<string, unknown>>(IPC.DOC_GET_AGENT_CONFIG)
    await ctx.invoke(IPC.DOC_SET_AGENT_CONFIG, { ...config, description: 'First edit.' }, { baseRevision: batch?.configRevision })
    await ctx.invoke(IPC.DOC_SET_AGENT_CONFIG, { ...config, description: 'Second edit over the old base.' }, { baseRevision: batch?.configRevision })

    // No base: last write wins, as every save did before revisions.
    await ctx.invoke(IPC.DOC_SET_DOCUMENT, { content: '# Saved without a base' })
    await ctx.invoke(IPC.DOC_GET_DOCUMENT)
    await ctx.invoke(IPC.AGENT_STOP)
  },
}

export const CONFLICT_SCENARIOS: readonly ParityScenario[] = [writeConflictsScenario]
