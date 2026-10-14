import { IPC } from '../../../src/shared/constants/ipc-channels'
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

/** Every mesh scenario, in run order. */
export const MESH_SCENARIOS: readonly ParityScenario[] = [fleetMapScenario, emergencyStopScenario]
