import { IPC } from '../../../src/shared/constants/ipc-channels'
import type { LlmRequestView } from '../harness/mock-llm'
import type { ParityScenario, ScenarioContext } from '../harness/scenario'

/**
 * Mesh, fleet map and emergency stop scenarios (tracker W3-D). Each is the
 * renderer's own call sequence (preload `window.adfApi` → channel).
 *
 * Two agents run and a third does not, in a tracked folder, with the mesh
 * on: the fleet map shows two live tiles and one ghost. An agent starts the
 * way the sidebar starts one: open it, then start it; opening the second
 * moves the first to the background.
 */

type AgentEvent = { type?: string; payload?: { state?: string; filePath?: string } }

/** A background batch that carries `type` for `filePath`. */
const batchHas = (type: string, filePath: string, state?: string) => (p: unknown) =>
  Array.isArray(p) && (p as AgentEvent[]).some((e) => e?.type === type && e.payload?.filePath === filePath && (state === undefined || e.payload?.state === state))

async function openAndStart(ctx: ScenarioContext, filePath: string): Promise<void> {
  await ctx.invoke(IPC.FILE_OPEN, { filePath })
  await ctx.invoke(IPC.AGENT_START, { filePath, hasUserMessage: false })
}

/** agent-1 and agent-2 running (agent-2 in the foreground), agent-3 stopped. */
async function twoRunningOneStopped(ctx: ScenarioContext): Promise<void> {
  const a1 = ctx.agent('agent-1').filePath
  await openAndStart(ctx, a1)
  await openAndStart(ctx, ctx.agent('agent-2').filePath)
  await ctx.waitForPush(IPC.BACKGROUND_AGENT_EVENT_BATCH, 'agent-1 runs in the background', batchHas('agent_started', a1))
}

const MESH_SETTINGS = (env: { agentsDir: string }) => ({ meshEnabled: true, trackedDirectories: [env.agentsDir] })
const THREE = [{ name: 'agent-1' }, { name: 'agent-2' }, { name: 'agent-3' }] as const

export const fleetMapScenario: ParityScenario = {
  name: 'fleet-map',
  description:
    'agent-1 and agent-2 running, agent-3 stopped, in a tracked folder with the mesh on. The fleet map polls, then hibernates agent-1 and agent-3 (offline).',
  fixtures: THREE,
  settings: MESH_SETTINGS,
  quietMs: 1000,
  async run(ctx) {
    await twoRunningOneStopped(ctx)
    await ctx.invoke(IPC.MESH_FLEET_STATUS)
    await ctx.invoke(IPC.MESH_MAP_POLL, { sinceSeq: undefined })
    await ctx.invoke(IPC.MESH_STATUS)
    await ctx.invoke(IPC.MESH_TOKEN_BURN)
    const a1 = ctx.agent('agent-1').filePath
    await ctx.invoke(IPC.MESH_SET_AGENT_STATE, { filePaths: [a1, ctx.agent('agent-3').filePath], state: 'hibernate' })
    await ctx.waitForPush(IPC.BACKGROUND_AGENT_EVENT_BATCH, 'agent-1 hibernates', batchHas('agent_state_changed', a1, 'hibernate'))
    await ctx.invoke(IPC.MESH_FLEET_STATUS)
  },
}

export const emergencyStopScenario: ParityScenario = {
  name: 'emergency-stop',
  description:
    'agent-1 and agent-2 running, agent-3 stopped, mesh on. Emergency stop: every agent stops and the mesh goes down; the status reads after it show all three off.',
  fixtures: THREE,
  settings: MESH_SETTINGS,
  quietMs: 1000,
  async run(ctx) {
    await twoRunningOneStopped(ctx)
    // The renderer resets its agent, mesh and background stores after the call (StatusBar).
    await ctx.invoke(IPC.EMERGENCY_STOP)
    await ctx.invoke(IPC.AGENT_STATUS)
    await ctx.invoke(IPC.MESH_FLEET_STATUS)
  },
}

/**
 * The receiving agent's inbox trigger waits this long after the message: its
 * turn starts after the sender's turn has ended, so the two agents' model
 * requests never interleave (agent-1's turn takes about 1 s with the mock
 * model's streamed replies).
 */
const INBOX_DEBOUNCE_MS = 3000
/** Longer than the daemon's 500 ms mesh-server debounce plus the bind. */
const MESH_SERVER_BIND_MS = 1500
/** agent-1's requests carry the chat; every other one is agent-2's inbox turn. */
const fromAgent1 = (req: LlmRequestView) => req.messages.some((m) => m.text.includes('Tell agent-2 hello.'))

export const meshMessageTurnScenario: ParityScenario = {
  name: 'mesh-message-turn',
  description:
    'agent-2 running in the background, agent-1 open and running, mesh on. A chat asks agent-1 to message agent-2 (msg_send to its handle); the message reaches agent-2\'s inbox and its on_inbox trigger runs a turn in agent-2.',
  fixtures: [
    { name: 'agent-1' },
    { name: 'agent-2', triggers: { on_inbox: { enabled: true, targets: [{ scope: 'agent', debounce_ms: INBOX_DEBOUNCE_MS }] } } },
  ],
  settings: MESH_SETTINGS,
  llm: (req) => {
    if (req.isPreflight) return { text: 'ok' }
    if (!fromAgent1(req)) return { text: 'Got it.' }
    if (req.last?.role === 'tool') return { text: 'Sent.' }
    return { toolCalls: [{ name: 'msg_send', arguments: { recipient: 'agent-2', content: 'Hello from agent-1.' } }] }
  },
  // agent-2's reply streams to a background agent: no deltas to measure.
  shownStream: fromAgent1,
  quietMs: 1000,
  async run(ctx) {
    const a2 = ctx.agent('agent-2').filePath
    await openAndStart(ctx, a2)
    const a1 = ctx.agent('agent-1').filePath
    await openAndStart(ctx, a1)
    await ctx.waitForPush(IPC.BACKGROUND_AGENT_EVENT_BATCH, 'agent-2 runs in the background', batchHas('agent_started', a2))
    // The daemon binds its mesh server 500 ms after the last agent registers
    // (daemon/index.ts ensureMeshServer); a message built before that names
    // the default port 7295 in reply_to, return_path and card instead of the
    // bound one (a daemon bug, reported in tracker §7). Waited out here, so
    // the comparison is about the message and the turn it triggers.
    await new Promise((resolve) => setTimeout(resolve, MESH_SERVER_BIND_MS))
    await ctx.invoke(IPC.AGENT_INVOKE, { userMessage: 'Tell agent-2 hello.', filePath: a1 })
    await ctx.waitForPush(IPC.BACKGROUND_AGENT_EVENT_BATCH, 'agent-2 answered the message', batchHas('turn_complete', a2))
  },
}

/** Every mesh scenario, in run order. */
export const MESH_SCENARIOS: readonly ParityScenario[] = [fleetMapScenario, emergencyStopScenario, meshMessageTurnScenario]
