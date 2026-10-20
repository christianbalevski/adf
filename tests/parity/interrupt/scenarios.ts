import { IPC } from '../../../src/shared/constants/ipc-channels'
import type { LlmReply } from '../harness/mock-llm'
import type { ParityScenario, ScenarioContext } from '../harness/scenario'

/**
 * The composer's Stop (AGENT_INTERRUPT) in both backends: the same runtime
 * interrupt as the terminal app's Esc. The interrupted turn's model request
 * is held open, so the interrupt lands while the request is in flight.
 */

type AgentEvent = { type?: string; loop?: string; payload?: { state?: string; content?: unknown; interrupted?: boolean } }
const isEvent = (type: string) => (p: unknown) => (p as AgentEvent)?.type === type
const isLoopState = (state: string) => (p: unknown) =>
  (p as AgentEvent)?.type === 'state_changed' && (p as AgentEvent).payload?.state === state && (p as AgentEvent).loop === undefined

/** useAdfFile.openFile: FILE_OPEN, then fetchFileContents (batch + default editor tabs). */
async function openAgent(ctx: ScenarioContext, filePath: string): Promise<void> {
  await ctx.invoke(IPC.FILE_OPEN, { filePath })
  await ctx.invoke(IPC.DOC_GET_BATCH)
  for (const path of ['mind.md', 'soul.md']) {
    await ctx.invoke(IPC.DOC_READ_INTERNAL_FILE, { path, binaryContent: false })
  }
}

/** A gate; a fresh one per run (the scenario object is shared by both backends). */
function gate(): { promise: Promise<void>; open: () => void } {
  let open = () => {}
  const promise = new Promise<void>((resolve) => { open = resolve })
  return { promise, open }
}

/** `arrived` opens when the long request reached the model. Its reply is never written: the interrupt cancels it. */
let arrived: ReturnType<typeof gate> | null = null
const never = new Promise<void>(() => {})

export const turnInterruptScenario: ParityScenario = {
  name: 'turn-interrupt',
  description:
    'Start agent-1 idle and send a chat whose model request stays in flight; Stop (AGENT_INTERRUPT) ends the turn: "Turn interrupted" in the loop, back to idle. A second Stop with nothing running answers interrupted false; the next chat runs as usual.',
  fixtures: [{ name: 'agent-1' }],
  quietMs: 1000,
  llm: (req): LlmReply => {
    if (req.isPreflight) return { text: 'ok' }
    if (arrived && req.last?.text.includes('Long task.')) {
      arrived.open()
      return { text: 'Never sent.', hold: never }
    }
    return { text: 'Back and ready.' }
  },
  async run(ctx) {
    arrived = gate()
    const agent = ctx.agent('agent-1')
    try {
      await openAgent(ctx, agent.filePath)
      await ctx.invoke(IPC.AGENT_START, { filePath: agent.filePath, hasUserMessage: true })
      const turn = ctx.invoke(IPC.AGENT_INVOKE, { userMessage: 'Long task.', filePath: agent.filePath })
      await ctx.waitForPush(IPC.AGENT_EVENT, 'thinking', isLoopState('thinking'))
      await arrived.promise

      await ctx.invoke(IPC.AGENT_INTERRUPT, { filePath: agent.filePath })
      await ctx.waitForPush(IPC.AGENT_EVENT, 'Turn interrupted in the loop', (p) => isEvent('context_injected')(p) && String((p as AgentEvent).payload?.content).includes('Turn interrupted'))
      await ctx.waitForPush(IPC.AGENT_EVENT, 'interrupted turn complete', (p) => isEvent('turn_complete')(p) && (p as AgentEvent).payload?.interrupted === true)
      await ctx.waitForPush(IPC.AGENT_EVENT, 'back to idle', isLoopState('idle'))
      await turn

      // Nothing running now: answered, nothing changes.
      await ctx.invoke(IPC.AGENT_INTERRUPT, { filePath: agent.filePath })

      await ctx.invoke(IPC.AGENT_INVOKE, { userMessage: 'Are you there?', filePath: agent.filePath })
      await ctx.waitForPush(IPC.AGENT_EVENT, 'turn complete', (p) => isEvent('turn_complete')(p) && (p as AgentEvent).payload?.interrupted !== true)
      await ctx.waitForPush(IPC.AGENT_EVENT, 'idle again', isLoopState('idle'))
      await ctx.invoke(IPC.DOC_GET_CHAT, {})
      await ctx.invoke(IPC.AGENT_STOP)
    } finally {
      arrived = null
    }
  },
}

export const INTERRUPT_SCENARIOS: readonly ParityScenario[] = [turnInterruptScenario]
