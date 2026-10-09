// Agent vitals over the daemon API: the overview card Studio serves on
// adf:agent:vitals, from the same AgentVitalsService.
//
//   GET /agents/:id/vitals?force=1
//   GET /agents/:id/activity?force=1   (the overview's lower sections)
//
// Studio hands the service its executor/workspace state; the daemon hands it
// the RuntimeService's loaded agents (createDaemonVitalsDeps). A loaded agent
// is read out of its open workspace; a tracked agent that is not loaded is
// read from its file with a readonly peek.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { AgentVitalsDeps, AgentVitalsService } from '../services/agent-vitals'
import { overlayLiveStates } from '../services/agent-vitals'
import { toDisplayState } from '../runtime/display-state'
import type { RuntimeAgentRef, RuntimeLiveAgent } from '../runtime/runtime-service'
import { canonicalizePath } from '../utils/tracked-paths'
import type { MeshAgentStatus } from '../../shared/types/ipc.types'
import { maxDepthOf, storedDirs, type TrackedDirsSettings } from './tracked-dirs'

/** The mesh slice vitals reads (MeshManager). */
export interface DaemonVitalsMesh {
  isEnabled(): boolean
  getAgentStatuses(): MeshAgentStatus[]
}

/** Structural subset of RuntimeService vitals uses. */
export interface VitalsRuntime {
  getAgent(agentId: string): RuntimeAgentRef | undefined
  listLiveAgents(): RuntimeLiveAgent[]
  scanAdfFiles(dirs: string[], maxDepth?: number): string[]
}

export interface DaemonVitalsSources {
  runtime: VitalsRuntime
  settings?: TrackedDirsSettings
  mesh?: DaemonVitalsMesh
  ws?: { getConnections(agentFilePath?: string): unknown[] }
  getAgentCost?: AgentVitalsDeps['getAgentCost']
  getAgentDailyCost?: AgentVitalsDeps['getAgentDailyCost']
}

/** How old the fleet scan behind agentsSpawned may get before a vitals read redoes it. */
const FLEET_SCAN_MAX_AGE_MS = 30_000

function canon(filePath: string): string {
  try { return canonicalizePath(filePath) } catch { return filePath }
}

/** AgentVitalsDeps from the daemon's runtime, settings, mesh and WS manager. */
export function createDaemonVitalsDeps(src: DaemonVitalsSources): AgentVitalsDeps {
  const live = (): RuntimeLiveAgent[] => src.runtime.listLiveAgents()
  const liveStates = (): Array<{ filePath: string; state: ReturnType<typeof toDisplayState> }> =>
    live().map((a) => ({ filePath: a.filePath, state: toDisplayState(a.executorState) }))
  return {
    isMeshRunning: () => !!src.mesh?.isEnabled(),
    getLiveMeshAgents: () => (src.mesh?.isEnabled() ? overlayLiveStates(src.mesh.getAgentStatuses(), liveStates()) : []),
    getTrackedDirectories: () => (src.settings ? storedDirs(src.settings) : []),
    getMaxScanDepth: () => (src.settings ? maxDepthOf(src.settings) : 5),
    listAdfFiles: async (dir, maxDepth) => src.runtime.scanAdfFiles([dir], maxDepth),
    getContextGauge: (filePath) => {
      const key = canon(filePath)
      return live().find((a) => canon(a.filePath) === key)?.getContextGauge()
    },
    getWsConnectionCount: (filePath) => (src.ws ? src.ws.getConnections(filePath).length || undefined : undefined),
    getLiveExecStates: liveStates,
    getOpenWorkspaces: () => live().map((a) => ({ filePath: a.filePath, workspace: a.workspace })),
    getAgentCost: src.getAgentCost,
    getAgentDailyCost: src.getAgentDailyCost,
  }
}

/**
 * The .adf file `id` names: a loaded agent (id, handle or name, as every
 * /agents/:id route), else a tracked agent that is not loaded (agent id or
 * handle from its file). `null` file: loaded without one.
 */
function resolveVitalsFile(
  id: string,
  runtime: VitalsRuntime,
  vitals: AgentVitalsService,
  settings: TrackedDirsSettings | undefined,
): { filePath: string | null } | undefined {
  const loaded = runtime.getAgent(id)
  if (loaded) return { filePath: loaded.filePath }
  if (!settings) return undefined
  const files = runtime.scanAdfFiles(storedDirs(settings), maxDepthOf(settings))
  let byHandle: string | undefined
  for (const filePath of files) {
    const meta = vitals.peekFleetMetaCached(filePath)
    if (!meta) continue
    if (meta.agentId === id) return { filePath }
    if (!byHandle && meta.handle === id) byHandle = filePath
  }
  return byHandle ? { filePath: byHandle } : undefined
}

export function registerVitalsRoutes(
  server: FastifyInstance,
  deps: { runtime: VitalsRuntime; vitals: AgentVitalsService; settings?: TrackedDirsSettings },
): void {
  let lastFleetScan = 0
  type Req = { Params: { id: string }; Querystring: { force?: string } }

  /** Validate `force` and resolve the file; sends the error reply and returns null on failure. */
  const target = (request: FastifyRequest<Req>, reply: FastifyReply, what: string): { filePath: string; forced: boolean } | null => {
    const force = request.query.force
    if (force !== undefined && !['1', '0', 'true', 'false'].includes(force)) {
      reply.code(400).send({ error: 'force must be 1, 0, true or false', code: 'bad_request' })
      return null
    }
    const found = resolveVitalsFile(request.params.id, deps.runtime, deps.vitals, deps.settings)
    if (!found) {
      reply.code(404).send({ error: `Unknown agent "${request.params.id}"`, code: 'not_found' })
      return null
    }
    if (!found.filePath) {
      reply.code(409).send({ error: `Agent has no .adf file; ${what} read from the file.`, code: 'conflict' })
      return null
    }
    return { filePath: found.filePath, forced: force === '1' || force === 'true' }
  }

  server.get<Req>('/agents/:id/vitals', async (request, reply) => {
    const t = target(request, reply, 'vitals are')
    if (!t) return reply
    try {
      // agentsSpawned counts children in the last fleet scan. Studio's fleet
      // poll keeps that fresh; the daemon has no poll, so refresh it here.
      const now = Date.now()
      if (t.forced || now - lastFleetScan > FLEET_SCAN_MAX_AGE_MS) {
        await deps.vitals.getFleetStatus()
        lastFleetScan = now
      }
      return await deps.vitals.getAgentVitals(t.filePath, { force: t.forced })
    } catch (err) {
      return fail(reply, err)
    }
  })

  server.get<Req>('/agents/:id/activity', async (request, reply) => {
    const t = target(request, reply, 'activity is')
    if (!t) return reply
    try {
      return await deps.vitals.getAgentActivity(t.filePath, { force: t.forced })
    } catch (err) {
      return fail(reply, err)
    }
  })
}

function fail(reply: FastifyReply, err: unknown) {
  return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) })
}
