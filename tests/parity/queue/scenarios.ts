import { IPC } from '../../../src/shared/constants/ipc-channels'
import type { LlmReply, LlmRequestView } from '../harness/mock-llm'
import type { ParityScenario, ScenarioContext } from '../harness/scenario'

/**
 * W5-L's parity scenarios: the queued-message fix (fix/queued-message-nav)
 * and the calibrated context breakdown (fix/context-breakdown) from main,
 * as the renderer drives them. The queue itself is renderer state; what the
 * backends must agree on is every signal it acts on (each loop's own turn
 * end in the background batch, the loop states a re-attach answers) and
 * what a send answers.
 */

type AgentEvent = { type?: string; loop?: string; payload?: { state?: string; filePath?: string; loop?: string } }
const isEvent = (type: string) => (p: unknown) => (p as AgentEvent)?.type === type
const isLoopState = (state: string, loop?: string) => (p: unknown) =>
  (p as AgentEvent)?.type === 'state_changed' && (p as AgentEvent).payload?.state === state && (p as AgentEvent).loop === loop
/** A background batch carrying `type` for `filePath` (and `match` on its payload). */
const inBatch = (type: string, filePath: string, match: (payload: AgentEvent['payload']) => boolean = () => true) => (p: unknown) =>
  Array.isArray(p) && (p as AgentEvent[]).some((e) => e.type === type && e.payload?.filePath === filePath && match(e.payload))

/** useAdfFile.openFile: FILE_OPEN, then fetchFileContents (batch + default editor tabs). */
async function openAgent(ctx: ScenarioContext, filePath: string): Promise<{ agentWasRunning?: boolean }> {
  const opened = await ctx.invoke<{ agentWasRunning?: boolean }>(IPC.FILE_OPEN, { filePath })
  await ctx.invoke(IPC.DOC_GET_BATCH)
  for (const path of ['mind.md', 'soul.md']) {
    await ctx.invoke(IPC.DOC_READ_INTERNAL_FILE, { path, binaryContent: false })
  }
  return opened
}

/** A gate the model's reply waits on; a fresh one per run (the scenario object is shared by both backends). */
function gate(): { promise: Promise<void>; open: () => void } {
  let open = () => {}
  const promise = new Promise<void>((resolve) => { open = resolve })
  return { promise, open }
}

/**
 * The runtime stamps each chat message with the wall clock to the second,
 * and the recording marks a stamp older than one already seen `<t:earlier>`
 * (normalize.ts R9). Two loops' histories interleave here, so each message is
 * sent in a later second than the one before: every mark is then the same
 * in every run.
 */
async function nextSecond(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1000 - (Date.now() % 1000) + 50))
}

/** Per loop: `arrived` opens when its held request reached the model, `reply` lets the reply go. */
type Hold = { arrived: ReturnType<typeof gate>; reply: ReturnType<typeof gate> }
let holds: { main: Hold; critic: Hold } | null = null
const held = (hold: Hold, text: string): LlmReply => {
  hold.arrived.open()
  return { text, hold: hold.reply.promise }
}
const said = (req: LlmRequestView, text: string) => req.messages.some((m) => m.role === 'user' && m.text.includes(text))

export const queuedAcrossSwitchScenario: ParityScenario = {
  name: 'queued-across-switch',
  description:
    'agent-2 is mid-turn in main and in its inner loop critic when the owner switches to agent-1 (a message is queued for each). Each loop\'s turn end arrives in the background batch on its own, the queued messages go then, and the switch back re-attaches with the loop states.',
  fixtures: [
    { name: 'agent-1' },
    { name: 'agent-2', loops: [{ name: 'critic', goal: 'Review what agent-2 writes.', enabled: true, autostart: false, tools: [] }] },
  ],
  quietMs: 1000,
  backgroundStreamsOnly: true,
  llm: (req): LlmReply => {
    if (req.isPreflight) return { text: 'ok' }
    const last = req.last?.text ?? ''
    if (holds && last.includes('Long main task.')) return held(holds.main, 'Main task done.')
    if (holds && last.includes('Long critic task.')) return held(holds.critic, 'Critic task done.')
    return { text: said(req, 'Queued for critic.') ? 'Critic got the queued note.' : 'Main got the queued note.' }
  },
  async run(ctx) {
    holds = { main: { arrived: gate(), reply: gate() }, critic: { arrived: gate(), reply: gate() } }
    const agent1 = ctx.agent('agent-1')
    const agent2 = ctx.agent('agent-2')
    try {
      await openAgent(ctx, agent2.filePath)
      await ctx.invoke(IPC.AGENT_START, { filePath: agent2.filePath, hasUserMessage: true })
      // Both loops mid-turn: their replies are held until the scenario lets
      // them end. Each loop's request reaches the model before the next step
      // (the critic's first-turn preflight would race main's request).
      const mainTurn = ctx.invoke(IPC.AGENT_INVOKE, { userMessage: 'Long main task.', filePath: agent2.filePath })
      await ctx.waitForPush(IPC.AGENT_EVENT, 'main thinking', isLoopState('thinking'))
      await holds.main.arrived.promise
      await nextSecond()
      const criticTurn = ctx.invoke(IPC.AGENT_INVOKE, { userMessage: 'Long critic task.', filePath: agent2.filePath, loop: 'critic' })
      await ctx.waitForPush(IPC.AGENT_EVENT, 'critic thinking', isLoopState('thinking', 'critic'))
      await holds.critic.arrived.promise

      // The owner switches away: agent-2 is announced in the background with
      // both loops busy, then (next batch window) its busy inner-loop count.
      await ctx.invoke(IPC.FILE_OPEN, { filePath: agent1.filePath })
      await ctx.waitForPush(IPC.BACKGROUND_AGENT_EVENT_BATCH, 'agent-2 listed in the background', inBatch('agent_started', agent2.filePath))
      await ctx.waitForPush(IPC.BACKGROUND_AGENT_EVENT_BATCH, 'agent-2 inner loop busy', inBatch('agent_loops_changed', agent2.filePath))
      await ctx.invoke(IPC.DOC_GET_BATCH)
      for (const path of ['mind.md', 'soul.md']) await ctx.invoke(IPC.DOC_READ_INTERNAL_FILE, { path, binaryContent: false })
      await ctx.invoke(IPC.BACKGROUND_AGENT_STATUS)

      // main's turn ends in the background: deliverSettledBackgroundQueues sends main's queue.
      holds.main.reply.open()
      await ctx.waitForPush(IPC.BACKGROUND_AGENT_EVENT_BATCH, 'agent-2 main idle', inBatch('agent_state_changed', agent2.filePath, (p) => p?.state === 'idle'))
      await mainTurn
      await nextSecond()
      await ctx.invoke(IPC.AGENT_INVOKE, { userMessage: 'Queued for main.', filePath: agent2.filePath, loop: 'main' })
      await ctx.waitForPush(IPC.BACKGROUND_AGENT_EVENT_BATCH, 'agent-2 main idle after the queued message', inBatch('agent_state_changed', agent2.filePath, (p) => p?.state === 'idle'))

      // critic's turn ends: its own transition (the busy count alone would not say which loop).
      holds.critic.reply.open()
      await ctx.waitForPush(IPC.BACKGROUND_AGENT_EVENT_BATCH, 'agent-2 critic idle', inBatch('agent_loop_state_changed', agent2.filePath, (p) => p?.loop === 'critic' && p?.state === 'idle'))
      await criticTurn
      await nextSecond()
      await ctx.invoke(IPC.AGENT_INVOKE, { userMessage: 'Queued for critic.', filePath: agent2.filePath, loop: 'critic' })
      await ctx.waitForPush(IPC.BACKGROUND_AGENT_EVENT_BATCH, 'agent-2 critic idle after the queued message', inBatch('agent_loop_state_changed', agent2.filePath, (p) => p?.loop === 'critic' && p?.state === 'idle'))

      // Back to agent-2: the re-attach answers main's state and every inner loop's.
      const back = await openAgent(ctx, agent2.filePath)
      if (back?.agentWasRunning) await ctx.invoke(IPC.AGENT_START)
      await ctx.invoke(IPC.DOC_GET_CHAT, {})
      await ctx.invoke(IPC.DOC_GET_CHAT, { loop: 'critic' })
      await ctx.invoke(IPC.AGENT_STOP)
    } finally {
      holds.main.reply.open()
      holds.critic.reply.open()
      holds = null
    }
  },
}

export const failedSendScenario: ParityScenario = {
  name: 'failed-send',
  description:
    'Sends that are refused: to the open agent before it runs, and to another agent that is not running. Each is only answered (the renderer shows "Not sent"); then the open agent starts and the retried send goes through.',
  fixtures: [{ name: 'agent-1' }, { name: 'agent-2' }],
  quietMs: 1000,
  llm: (req) => (req.isPreflight ? { text: 'ok' } : { text: 'Got it this time.' }),
  async run(ctx) {
    const agent1 = ctx.agent('agent-1')
    const agent2 = ctx.agent('agent-2')
    await openAgent(ctx, agent1.filePath)
    await ctx.invoke(IPC.AGENT_INVOKE, { userMessage: 'Before the start.', filePath: agent1.filePath })
    await ctx.invoke(IPC.AGENT_INVOKE, { userMessage: 'To a stopped agent.', filePath: agent2.filePath })
    await ctx.invoke(IPC.AGENT_INVOKE, { userMessage: 'To a stopped loop.', filePath: agent1.filePath, loop: 'main' })
    await ctx.invoke(IPC.AGENT_START, { filePath: agent1.filePath, hasUserMessage: true })
    await ctx.invoke(IPC.AGENT_INVOKE, { userMessage: 'Before the start.', filePath: agent1.filePath })
    await ctx.waitForPush(IPC.AGENT_EVENT, 'turn complete', isEvent('turn_complete'))
    await ctx.waitForPush(IPC.AGENT_EVENT, 'back to idle', isLoopState('idle'))
    await ctx.invoke(IPC.DOC_GET_CHAT, {})
    await ctx.invoke(IPC.AGENT_STOP)
  },
}

let promptTokens = 0

export const contextAfterCallScenario: ParityScenario = {
  name: 'context-after-call',
  description:
    'The context breakdown before any call (estimates), then after one call whose reported prompt is within the calibration band (calibrated, with the reply\'s reported output).',
  fixtures: [{ name: 'agent-1' }],
  quietMs: 1000,
  llm: (req) => (req.isPreflight ? { text: 'ok' } : { text: 'Measured reply.', usage: { prompt: promptTokens, completion: 12 } }),
  async run(ctx) {
    const agent = ctx.agent('agent-1')
    await openAgent(ctx, agent.filePath)
    await ctx.invoke(IPC.AGENT_START, { filePath: agent.filePath, hasUserMessage: true })
    const before = await ctx.invoke<{ system_prompt_tokens: number; tools_total_tokens: number; dynamic_instructions_tokens: number; messages_tokens: number } | null>(IPC.CONTEXT_BREAKDOWN_GET, { filePath: agent.filePath })
    // A real prompt 30% over the estimate (inside the 0.5 to 3 guard), so the breakdown calibrates to it.
    const estimate = before ? before.system_prompt_tokens + before.tools_total_tokens + before.dynamic_instructions_tokens + before.messages_tokens : 1000
    promptTokens = Math.round(estimate * 1.3)
    await ctx.invoke(IPC.AGENT_INVOKE, { userMessage: 'Measure me.', filePath: agent.filePath })
    await ctx.waitForPush(IPC.AGENT_EVENT, 'turn complete', isEvent('turn_complete'))
    await ctx.waitForPush(IPC.AGENT_EVENT, 'back to idle', isLoopState('idle'))
    await ctx.invoke(IPC.CONTEXT_BREAKDOWN_GET, { filePath: agent.filePath })
    await ctx.invoke(IPC.AGENT_STOP)
  },
}

export const QUEUE_SCENARIOS: readonly ParityScenario[] = [queuedAcrossSwitchScenario, failedSendScenario, contextAfterCallScenario]
