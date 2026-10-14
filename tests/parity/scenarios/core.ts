import { IPC } from '../../../src/shared/constants/ipc-channels'
import type { ParityScenario, ScenarioContext } from '../harness/scenario'

/**
 * The first three parity scenarios: open an agent, start it, and run one
 * chat turn with a tool call. Each is the renderer's own call sequence for
 * that flow (preload `window.adfApi` → channel), including the reads the
 * renderer makes after it.
 */

type AgentEvent = { type?: string; payload?: { state?: string } }
const isEvent = (type: string) => (p: unknown) => (p as AgentEvent)?.type === type
const isState = (state: string) => (p: unknown) =>
  (p as AgentEvent)?.type === 'state_changed' && (p as AgentEvent).payload?.state === state

/** useAdfFile.openFile: FILE_OPEN, then fetchFileContents (batch + default editor tabs). */
async function openAgent(ctx: ScenarioContext, filePath: string): Promise<void> {
  await ctx.invoke(IPC.FILE_OPEN, { filePath })
  await ctx.invoke(IPC.DOC_GET_BATCH)
  for (const path of ['mind.md', 'soul.md']) {
    await ctx.invoke(IPC.DOC_READ_INTERNAL_FILE, { path, binaryContent: false })
  }
}

export const openAgentScenario: ParityScenario = {
  name: 'open-agent',
  description: 'Open agent-1 from disk without starting it, as the sidebar does.',
  fixtures: [{ name: 'agent-1' }],
  quietMs: 1000,
  async run(ctx) {
    const agent = ctx.agent('agent-1')
    await openAgent(ctx, agent.filePath)
    await ctx.invoke(IPC.FILE_GET_CURRENT)
    await ctx.invoke(IPC.AGENT_STATUS)
  },
}

export const startAgentScenario: ParityScenario = {
  name: 'start-agent',
  description:
    'Open agent-1 (start_in_state left at its default, active), start it, let the startup turn finish, then stop it.',
  fixtures: [{ name: 'agent-1', startInState: 'active' }],
  quietMs: 1000,
  llm: (req) => (req.isPreflight ? { text: 'ok' } : { text: 'Started and ready.' }),
  async run(ctx) {
    const agent = ctx.agent('agent-1')
    await openAgent(ctx, agent.filePath)
    await ctx.invoke(IPC.AGENT_START, { filePath: agent.filePath, hasUserMessage: false })
    await ctx.waitForPush(IPC.AGENT_EVENT, 'startup turn complete', isEvent('turn_complete'))
    await ctx.waitForPush(IPC.AGENT_EVENT, 'back to idle', isState('idle'))
    await ctx.invoke(IPC.AGENT_STATUS)
    await ctx.invoke(IPC.AGENT_STOP)
    await ctx.invoke(IPC.AGENT_STATUS)
    await ctx.invoke(IPC.FILE_GET_CURRENT)
  },
}

export const chatToolCallScenario: ParityScenario = {
  name: 'chat-tool-call',
  description:
    'Start agent-1 idle, send one chat message; the model calls fs_write, then answers. Read back the chat and the written file.',
  fixtures: [{ name: 'agent-1' }],
  quietMs: 1000,
  llm: (req) => {
    if (req.isPreflight) return { text: 'ok' }
    if (req.last?.role === 'tool') return { text: 'Wrote note.md.' }
    return { toolCalls: [{ name: 'fs_write', arguments: { mode: 'write', path: 'note.md', content: 'hello from agent-1' } }] }
  },
  async run(ctx) {
    const agent = ctx.agent('agent-1')
    await openAgent(ctx, agent.filePath)
    await ctx.invoke(IPC.AGENT_START, { filePath: agent.filePath, hasUserMessage: true })
    await ctx.invoke(IPC.AGENT_INVOKE, { userMessage: 'Write a note.', filePath: agent.filePath })
    await ctx.waitForPush(IPC.AGENT_EVENT, 'turn complete', isEvent('turn_complete'))
    await ctx.waitForPush(IPC.AGENT_EVENT, 'back to idle', isState('idle'))
    await ctx.invoke(IPC.DOC_GET_CHAT, {})
    await ctx.invoke(IPC.DOC_READ_INTERNAL_FILE, { path: 'note.md', binaryContent: false })
    await ctx.invoke(IPC.AGENT_STATUS)
  },
}

/** Every scenario, in run order. Later workstreams append theirs in their own files. */
export const CORE_SCENARIOS: readonly ParityScenario[] = [openAgentScenario, startAgentScenario, chatToolCallScenario]
