// Path-addressed fleet and compute routes for Studio in daemon mode (tracker
// W3-D): what Studio's IPC handlers do with a file path or with the shared
// container only, where the existing routes take an agent id or act on every
// container.
//
//   GET  /fleet/vitals?path=&force=         AGENT_VITALS: the overview card of any .adf
//   GET  /fleet/activity?path=&force=       AGENT_ACTIVITY: the overview's lower sections
//   POST /fleet/state                       { filePaths, state }  MESH_SET_AGENT_STATE
//   POST /fleet/found                       { dir, name, newRoot? }  MESH_FOUND_AGENT
//   POST /compute/shared/stop               COMPUTE_STOP: the shared container only
//   GET  /compute/users?names=              other runtimes using each container (W1-G)
//
// Bodies are Studio's (ipc/index.ts). /agents/:id/vitals stays for the CLI
// and the terminal app: it resolves an id, and a file that is neither loaded
// nor in a tracked folder has none.

import { dirname, isAbsolute } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { AgentVitalsService } from '../../services/agent-vitals'
import { AdfWorkspace } from '../../adf/adf-workspace'
import { markConfigReviewed } from '../../services/agent-review'
import { canonicalizePath, isSameOrSubPath } from '../../utils/tracked-paths'
import { prepareFoundAgent } from '../../utils/found-agent'
import type { FleetSettableState, FleetStateResult } from '../../../shared/types/ipc.types'
import { createDaemonVitalsDeps } from '../vitals-routes'
import type { DaemonRouteContext } from './index'
import { badRequest, flagParam, serverError, stringParam, unavailable } from './route-helpers'

/** How old the fleet scan behind agentsSpawned may get (Studio's AGENT_VITALS: 30 s). */
const FLEET_SCAN_MAX_AGE_MS = 30_000

/** The shared container's name (podman.service.ts SHARED_CONTAINER). */
const SHARED_CONTAINER = 'adf-mcp'

/** Compute members these routes use when the daemon's compute service has them (PodmanService). */
interface ComputeExtras {
  containerUsers?(name?: string): Promise<string[]>
}

function canon(filePath: string): string {
  try { return canonicalizePath(filePath) } catch { return filePath }
}


export function registerFleetClientRoutes(server: FastifyInstance, ctx: DaemonRouteContext): void {
  const { runtime, options } = ctx
  const vitals = new AgentVitalsService(createDaemonVitalsDeps({ runtime, settings: options.settingsStore, mesh: options.mesh, ws: options.wsService }))
  const trackedDirs = (): string[] => (options.settingsStore?.get('trackedDirectories') as string[] | undefined) ?? []

  type VitalsReq = { Querystring: { path?: string; force?: string } }

  server.get<VitalsReq>('/fleet/vitals', async (request, reply) => {
    const filePath = stringParam(request.query.path)
    if (!filePath) return badRequest(reply, 'path is required')
    const force = flagParam(request.query.force)
    if (force === null) return badRequest(reply, 'force must be 1, 0, true or false')
    try {
      // agentsSpawned counts children in the last fleet scan; refreshed at most every 30 s, as Studio does.
      await vitals.ensureFleetScan(FLEET_SCAN_MAX_AGE_MS).catch(() => {})
      return await vitals.getAgentVitals(filePath, { force })
    } catch (err) {
      return serverError(reply, err)
    }
  })

  server.get<VitalsReq>('/fleet/activity', async (request, reply) => {
    const filePath = stringParam(request.query.path)
    if (!filePath) return badRequest(reply, 'path is required')
    const force = flagParam(request.query.force)
    if (force === null) return badRequest(reply, 'force must be 1, 0, true or false')
    try {
      return await vitals.getAgentActivity(filePath, { force })
    } catch (err) {
      return serverError(reply, err)
    }
  })

  // End any active turn and enter idle or hibernate, per file. An agent that
  // is not loaded is offline; a stopped or errored executor is refused.
  server.post<{ Body: { filePaths?: unknown; state?: unknown } }>('/fleet/state', async (request): Promise<FleetStateResult> => {
    const updated: string[] = []
    const failed: { filePath: string; error: string }[] = []
    const filePaths = Array.isArray(request.body?.filePaths) ? (request.body.filePaths as unknown[]).filter((p): p is string => typeof p === 'string') : []
    const state = request.body?.state
    if (state !== 'hibernate' && state !== 'idle') {
      return { updated, failed: filePaths.map((filePath) => ({ filePath, error: 'invalid state' })) }
    }
    for (const filePath of filePaths) {
      try {
        const key = canon(filePath)
        const live = runtime.listLiveAgents().find((a) => canon(a.filePath) === key)
        if (!live) {
          failed.push({ filePath, error: 'agent offline' })
          continue
        }
        if (live.executorState === 'stopped' || live.executorState === 'error') {
          failed.push({ filePath, error: `agent ${live.executorState}` })
          continue
        }
        runtime.setAgentDisplayState(live.agentId, state as FleetSettableState)
        updated.push(filePath)
      } catch (error) {
        failed.push({ filePath, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return { updated, failed }
  })

  // Found an agent from the fleet map, as Studio's MESH_FOUND_AGENT does it:
  // the destination must be an absolute folder inside a tracked folder, or
  // (newRoot) a sibling of a tracked root, never elsewhere. The folder is
  // created, the file (the typed name slugged, no length limit) is made from
  // the default template with the typed name, its identity provisioned (a
  // failure, such as a locked owner identity, is logged and the file kept),
  // marked reviewed (the owner made it) and left closed; a folder no tracked
  // root covers is tracked, and the watcher tells the mesh and the clients.
  // The checks, the folder and the slug are Studio's own (utils/found-agent.ts, E1).
  server.post<{ Body: { dir?: unknown; name?: unknown; newRoot?: unknown } }>('/fleet/found', async (request) => {
    const factory = options.agentFactory
    if (!factory) return { success: false, error: 'Agent creation is not configured on this daemon.' }
    try {
      const name = typeof request.body?.name === 'string' ? request.body.name : ''
      const dir = typeof request.body?.dir === 'string' ? request.body.dir : ''
      // An HTTP body may name a relative folder; Studio's dialog never does.
      if (name.trim() && !isAbsolute(dir)) return { success: false, error: 'Destination must be an absolute folder path' }
      const plan = prepareFoundAgent({ dir, name, newRoot: request.body?.newRoot === true }, trackedDirs())
      if (!plan.ok) return { success: false, error: plan.error }
      const filePath = plan.filePath

      const made = await factory.templatesService().instantiate({ destPath: filePath, name: plan.name })
      if (!made.success) return { success: false, error: made.error }
      const workspace = AdfWorkspace.open(filePath)
      try {
        try {
          if (!options.identity) throw new Error('no owner identity on this daemon')
          options.identity.service.ensureWorkspaceIdentity(workspace)
        } catch (err) {
          console.warn('[OwnerIdentity] Identity provisioning on found failed:', err)
        }
        options.settingsStore?.set?.('reviewedAgents', markConfigReviewed(options.settingsStore.get('reviewedAgents'), workspace.getAgentConfig()))
      } finally {
        workspace.close()
      }
      const folder = dirname(canonicalizePath(filePath))
      const roots = trackedDirs()
      if (!roots.some((d) => { try { return isSameOrSubPath(d, folder) } catch { return false } })) {
        options.settingsStore?.set?.('trackedDirectories', [...roots, folder])
        console.log(`[Fleet] Tracking ${folder} (founded ${filePath})`)
      }
      ctx.options.routes?.trackedDirWatcher?.sync()
      console.log(`[Fleet] Founded ${filePath} from the fleet map`)
      return { success: true, filePath }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // Studio's COMPUTE_STOP stops the shared container only (POST /compute/stop
  // stops every container this runtime started).
  server.post('/compute/shared/stop', async (_request, reply) => {
    const compute = options.computeService
    if (!compute) return unavailable(reply, 'Compute service is not configured.')
    try {
      await compute.stop()
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // Other live runtimes on this machine that use each container ("daemon pid
  // 4242"), for Settings → Compute and the reset confirmation. The shared
  // container is always answered; `names` adds others (comma-separated).
  server.get<{ Querystring: { names?: string } }>('/compute/users', async (request, reply) => {
    const compute = options.computeService as (NonNullable<typeof options.computeService> & ComputeExtras) | undefined
    if (!compute) return unavailable(reply, 'Compute service is not configured.')
    const names = [...new Set([SHARED_CONTAINER, ...(request.query.names ?? '').split(',').map((n) => n.trim()).filter(Boolean)])]
    const users: Record<string, string[]> = {}
    if (!compute.containerUsers) return { users }
    try {
      await Promise.all(names.map(async (name) => {
        const list = await compute.containerUsers!(name)
        if (list.length > 0) users[name] = list
      }))
      return { users }
    } catch (err) {
      return serverError(reply, err)
    }
  })
}
