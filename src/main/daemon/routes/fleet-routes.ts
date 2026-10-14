// The fleet map over the daemon API: mesh debug view, fleet status rows,
// token burn, the aggregate poll, recent tools, owner messages, adapter
// states and restarts, peer reads, and the emergency stop.
//
//   GET  /fleet/mesh?debug=1&sinceSeq=      MESH_STATUS
//   GET  /fleet/status                      MESH_FLEET_STATUS
//   GET  /fleet/burn                        MESH_TOKEN_BURN
//   POST /fleet/burn/hydrate                { burnTotals }  (the client key fleetMapState.burnTotals)
//   GET  /fleet/map?sinceSeq=               MESH_MAP_POLL: { debug, fleet, burn, adapters, peers }
//   GET  /fleet/recent-tools                MESH_GET_RECENT_TOOLS
//   POST /fleet/message                     { filePaths, content }  MESH_MESSAGE_AGENTS
//   GET  /fleet/adapters                    ADAPTER_GET_STATUS
//   POST /fleet/adapters/restart            { type, filePath? }  ADAPTER_RESTART
//   GET  /network/peers/health?url=         MESH_PEER_AGENT_HEALTH
//   GET  /network/peers/shared-file?baseUrl=&path=   MESH_PEER_SHARED_FILE
//   POST /runtime/emergency-stop            EMERGENCY_STOP
//
// Bodies are the ones Studio's handlers return (shared modules under
// src/main/services). Agents are addressed by file path, as the fleet map
// knows them; the daemon's paths are canonical (RuntimeService).

import { existsSync } from 'fs'
import type { FastifyInstance } from 'fastify'
import { AdfWorkspace } from '../../adf/adf-workspace'
import { RuntimeGate } from '../../runtime/runtime-gate'
import type { RuntimeService } from '../../runtime/runtime-service'
import { AgentVitalsService } from '../../services/agent-vitals'
import { mergeAdapterStates } from '../../services/adapter-status'
import { getFleetBurnService } from '../../services/fleet-burn.service'
import { killAllHostExecs } from '../../services/host-exec.service'
import { buildMeshStatus, type MeshStatusSource } from '../../services/mesh-status'
import { fetchPeerSharedFile, probePeerHealth } from '../../services/peer-fetch'
import { readRecentToolsFromWorkspace } from '../../services/recent-tools'
import { killAllTracked } from '../../utils/child-registry'
import { canonicalizePath } from '../../utils/tracked-paths'
import { createDispatch, createEvent } from '../../../shared/types/adf-event.types'
import type { ContentBlock } from '../../../shared/types/provider.types'
import type { FleetMessageResult } from '../../../shared/types/ipc.types'
import type { AdapterState } from '../../../shared/types/channel-adapter.types'
import { createDaemonVitalsDeps } from '../vitals-routes'
import { gapDeps } from './gap-deps'
import type { DaemonRouteContext } from './index'
import { loadedAgentIndex } from './loaded-agents'
import { badRequest, serverError, stringParam } from './route-helpers'

/** MeshManager methods past DaemonVitalsMesh that these routes use when the daemon's mesh has them. */
interface MeshExtras {
  getDebugInfo?(): { messageLog: Array<{ seq?: number }> } & Record<string, unknown>
  disableMesh?(): void
}

interface Stoppable {
  stopAll?(): void
}

function canon(filePath: string): string {
  try { return canonicalizePath(filePath) } catch { return filePath }
}

/** The loaded agent for a file path (canonical compare), if any. */
function agentAt(runtime: RuntimeService, filePath: string): { id: string; filePath: string } | undefined {
  const key = canon(filePath)
  for (const agent of runtime.listAgents()) {
    if (agent.filePath && canon(agent.filePath) === key) return { id: agent.id, filePath: agent.filePath }
  }
  return undefined
}

function sinceSeqOf(raw: unknown): number | undefined | null {
  if (raw === undefined) return undefined
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 ? n : null
}

export function registerFleetRoutes(server: FastifyInstance, ctx: DaemonRouteContext): void {
  const { runtime, options } = ctx
  const mesh = options.mesh as (typeof options.mesh & MeshExtras) | undefined
  const vitalsDeps = createDaemonVitalsDeps({ runtime, settings: options.settingsStore, mesh: options.mesh, ws: options.wsService })
  const vitals = new AgentVitalsService(vitalsDeps)
  const index = loadedAgentIndex(runtime)

  const meshSource: MeshStatusSource = {
    isRunning: () => !!mesh?.isEnabled(),
    liveAgents: () => vitalsDeps.getLiveMeshAgents(),
    debugInfo: () => {
      if (mesh?.getDebugInfo) return mesh.getDebugInfo()
      const debug = options.networkService?.getStatus().debug as ReturnType<NonNullable<MeshExtras['getDebugInfo']>> | undefined
      if (debug) return debug
      throw new Error('Mesh debug info is not available on this daemon')
    },
  }

  const adapterStatus = () => {
    const sources: Array<{ filePath: string | null; states: AdapterState[] }> = []
    for (const agent of runtime.listAgents()) {
      if (!agent.filePath) continue
      try {
        sources.push({ filePath: agent.filePath, states: runtime.getAgentAdaptersDiagnostics(agent.id).states as AdapterState[] })
      } catch { /* unloaded meanwhile */ }
    }
    return mergeAdapterStates(sources)
  }

  server.get<{ Querystring: { debug?: string; sinceSeq?: string } }>('/fleet/mesh', async (request, reply) => {
    const sinceSeq = sinceSeqOf(request.query.sinceSeq)
    if (sinceSeq === null) return badRequest(reply, 'sinceSeq must be a non-negative integer')
    const debug = request.query.debug === '1' || request.query.debug === 'true'
    return buildMeshStatus(meshSource, { debug, sinceSeq })
  })

  server.get('/fleet/status', async (_request, reply) => {
    try { return await vitals.getFleetStatus() } catch (err) { return serverError(reply, err) }
  })

  server.get('/fleet/burn', async () => getFleetBurnService().getBurn())

  // Σ totals survive restarts: Studio keeps them in its client key
  // fleetMapState.burnTotals and hands them over once per session. Rates
  // start fresh (a rolling window cannot span a boot).
  server.post<{ Body: { burnTotals?: unknown } }>('/fleet/burn/hydrate', async (request, reply) => {
    const totals = request.body?.burnTotals
    if (!totals || typeof totals !== 'object' || Array.isArray(totals)) return badRequest(reply, 'burnTotals must be an object of file path → tokens')
    getFleetBurnService().hydrate(totals as Record<string, number>)
    return { success: true }
  })

  // The fleet map's 5 s poll in one round trip, each slice as its own route
  // answers. `sinceSeq` is the mesh message-log cursor.
  server.get<{ Querystring: { sinceSeq?: string } }>('/fleet/map', async (request, reply) => {
    const sinceSeq = sinceSeqOf(request.query.sinceSeq)
    if (sinceSeq === null) return badRequest(reply, 'sinceSeq must be a non-negative integer')
    const [debug, fleet, adapters, peers] = await Promise.all([
      buildMeshStatus(meshSource, { debug: true, sinceSeq }).catch(() => null),
      vitals.getFleetStatus(),
      Promise.resolve().then(adapterStatus).catch(() => ({ adapters: [], perAgent: [] })),
      Promise.resolve().then(() => options.networkService?.getDiscoveredRuntimes?.() ?? []).catch(() => []),
    ])
    let burn: unknown = null
    try { burn = getFleetBurnService().getBurn() } catch { burn = null }
    return { debug, fleet, burn, adapters, peers }
  })

  // Mesh-registered agents first; loaded agents the mesh does not track are
  // read from their workspaces.
  server.get('/fleet/recent-tools', async () => {
    const result = (options.networkService?.getRecentTools?.(5) ?? {}) as Record<string, unknown>
    for (const agent of runtime.listLiveAgents()) {
      if (result[agent.filePath]) continue
      result[agent.filePath] = readRecentToolsFromWorkspace(agent.workspace, 5)
    }
    return result
  })

  // Owner → agent is plain chat, not mesh mail: the message rides the same
  // rails as typing in the chat panel (a real user turn, no inbox row). A
  // message to an agent that is not running starts it (review gate on); when
  // the start is refused (unreviewed, password-locked) the message is written
  // into its loop so it is the next thing the agent sees.
  server.post<{ Body: { filePaths?: unknown; content?: unknown } }>('/fleet/message', async (request): Promise<FleetMessageResult> => {
    const delivered: string[] = []
    const failed: { filePath: string; error: string }[] = []
    const filePaths = Array.isArray(request.body?.filePaths) ? (request.body.filePaths as unknown[]).filter((p): p is string => typeof p === 'string') : []
    const content = typeof request.body?.content === 'string' ? request.body.content : ''
    if (!content.trim()) {
      return { delivered, failed: filePaths.map((filePath) => ({ filePath, error: 'empty message' })) }
    }
    const chatDispatch = () =>
      createDispatch(createEvent({
        type: 'chat' as const, source: 'system',
        data: { message: { seq: 0, role: 'user' as const, content_json: [{ type: 'text', text: content }] as ContentBlock[], created_at: Date.now() } },
      }), { scope: 'agent' })
    const deliver = (agentId: string, why: string) => {
      // Not awaited: the promise resolves only when the whole LLM turn completes.
      void runtime.trigger(agentId, chatDispatch()).catch((err) => {
        console.error(`[Fleet] Owner chat turn failed (${why}):`, err)
      })
    }

    for (const filePath of filePaths) {
      try {
        const loaded = agentAt(runtime, filePath)
        if (loaded) {
          deliver(loaded.id, 'running')
          delivered.push(filePath)
          continue
        }
        if (!existsSync(filePath)) {
          failed.push({ filePath, error: 'file not found' })
          continue
        }
        // A message IS a summons: a deliberate start, so the emergency-stop
        // gate reopens (Studio's gated background start does the same).
        RuntimeGate.resume()
        let startedId: string | null = null
        try {
          startedId = (await runtime.loadAgent(filePath, { enforceReviewGate: true })).id
        } catch (err) {
          console.log(`[Fleet] Owner message: start refused for ${filePath} (${err instanceof Error ? err.message : String(err)}) — writing the message into its loop`)
        }
        if (startedId) {
          deliver(startedId, 'cold start')
          delivered.push(filePath)
          continue
        }
        const workspace = AdfWorkspace.open(filePath)
        try {
          workspace.appendToLoop('user', [{ type: 'text', text: content }])
        } finally {
          workspace.close()
        }
        delivered.push(filePath)
      } catch (error) {
        failed.push({ filePath, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return { delivered, failed }
  })

  server.get('/fleet/adapters', async () => adapterStatus())

  // Adapters run inside the agent that hosts them; the restart reaches that
  // agent's adapter manager.
  server.post<{ Body: { type?: unknown; filePath?: unknown } }>('/fleet/adapters/restart', async (request, reply) => {
    const type = stringParam(request.body?.type)
    if (!type) return badRequest(reply, 'type is required')
    const filePath = stringParam(request.body?.filePath)
    const loaded = filePath ? agentAt(runtime, filePath) : undefined
    const manager = loaded ? index.get(loaded.id)?.agent.adapterManager ?? null : null
    if (!manager) {
      return {
        success: false,
        error: filePath
          ? 'That agent is not running, so its channel has nothing to restart. Start the agent instead.'
          : 'No agent is open, so there is no channel to restart.',
      }
    }
    const success = await manager.restart(type)
    return { success, error: success ? undefined : `Could not restart the ${type} channel.` }
  })

  server.get<{ Querystring: { url?: string } }>('/network/peers/health', async (request) => probePeerHealth(request.query.url))

  server.get<{ Querystring: { baseUrl?: string; path?: string } }>('/network/peers/shared-file', async (request) =>
    fetchPeerSharedFile(request.query.baseUrl, request.query.path))

  // Studio's teardownRuntime({ disposeMode: 'emergency' }) on the daemon:
  // close the runtime gate first (resumable: the next deliberate start
  // reopens it), mesh off (not persisted), every agent unloaded at once,
  // WS connections, mesh server, tracked children, host execs and sandbox
  // workers stopped, then the compute containers. Files stay reopenable.
  server.post('/runtime/emergency-stop', async () => {
    console.log('[EmergencyStop] Shutting down everything...')
    const deps = gapDeps(ctx)
    const skipped: string[] = []
    RuntimeGate.stop()
    try {
      if (mesh?.isEnabled() && mesh.disableMesh) mesh.disableMesh()
      else if (mesh?.isEnabled()) skipped.push('mesh')
    } catch (e) { console.error('[EmergencyStop] mesh disable error:', e) }
    await Promise.all(runtime.listAgents().map(async (agent) => {
      try { await runtime.unloadAgent(agent.id, { mode: 'immediate' }) }
      catch (e) { console.error(`[EmergencyStop] unload ${agent.id} error:`, e) }
    }))
    try { (options.wsService as Stoppable | undefined)?.stopAll?.() } catch (e) { console.error('[EmergencyStop] WS stop error:', e) }
    try {
      if (deps.meshServer) await deps.meshServer.stop()
      else skipped.push('mesh server')
    } catch (e) { console.error('[EmergencyStop] mesh server stop error:', e) }
    try { await killAllTracked() } catch (e) { console.error('[EmergencyStop] tracked child kill error:', e) }
    try { await killAllHostExecs() } catch (e) { console.error('[EmergencyStop] host exec kill error:', e) }
    try {
      if (deps.codeSandboxService) deps.codeSandboxService.destroyAll()
      else skipped.push('sandbox workers')
    } catch (e) { console.error('[EmergencyStop] sandbox destroy error:', e) }
    try { await options.computeService?.pendingStarts?.() } catch (e) { console.error('[EmergencyStop] compute pendingStarts error:', e) }
    try { await options.computeService?.stopAll?.() } catch (e) { console.error('[EmergencyStop] compute stop error:', e) }
    console.log(`[EmergencyStop] All agents stopped, mesh disabled.${skipped.length ? ` Not wired on this daemon, left running: ${skipped.join(', ')}.` : ''}`)
    return { success: true }
  })
}
