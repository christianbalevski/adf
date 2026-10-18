// Compute gap routes: container rebuild, the external execution target probe,
// and the Computer tab's container lookup.
//
//   POST /compute/containers/:name/rebuild         COMPUTE_REBUILD_CONTAINER
//   POST /compute/execution-targets/test           COMPUTE_TEST_EXECUTION_TARGET (body: the target)
//   GET  /compute/browser-info?agentName=&agentId= COMPUTE_BROWSER_INFO
//
// They call the daemon's compute service (PodmanService), as Studio's
// handlers call its own; bodies keep Studio's shapes. The noVNC port is on
// the daemon host's loopback, so browser-info is for local clients.

import type { FastifyInstance } from 'fastify'
import { getComputeBrowserInfo, type BrowserInfoPodman } from '../../services/compute-browser-info'
import { ExternalExecutionService } from '../../services/external-execution.service'
import { gapDeps } from './gap-deps'
import type { DaemonRouteContext } from './index'
import { badRequest, stringParam, unavailable } from './route-helpers'

interface RebuildCapable {
  rebuildContainer?(name: string): Promise<{ recreated: boolean }>
}

export function registerComputeAdminRoutes(server: FastifyInstance, ctx: DaemonRouteContext): void {
  const compute = () => ctx.options.computeService as (NonNullable<typeof ctx.options.computeService> & RebuildCapable & Partial<BrowserInfoPodman>) | undefined
  let external: { probe(target: unknown): Promise<unknown> } | null = null

  server.post<{ Params: { name: string } }>('/compute/containers/:name/rebuild', async (request) => {
    const service = compute()
    if (!service?.rebuildContainer) return { success: false, error: 'Compute is not configured on this daemon' }
    try {
      const result = await service.rebuildContainer(request.params.name)
      console.log(`[Compute] Rebuilt container ${request.params.name} on request`)
      return { success: true, ...result }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // Probes a local container engine target (version + inspect, bounded by
  // the service's own command timeouts).
  server.post<{ Body: unknown }>('/compute/execution-targets/test', async (request) => {
    external ??= gapDeps(ctx).externalExecution ?? (new ExternalExecutionService() as unknown as { probe(target: unknown): Promise<unknown> })
    return external.probe(request.body)
  })

  server.get<{ Querystring: { agentName?: string; agentId?: string } }>('/compute/browser-info', async (request, reply) => {
    const agentName = stringParam(request.query.agentName)
    const agentId = stringParam(request.query.agentId)
    if (!agentName || !agentId) return badRequest(reply, 'agentName and agentId are required')
    const service = compute()
    if (!service?.containerPhase || !service.browserReady || !service.getNovncHostPort) return unavailable(reply, 'Compute is not configured on this daemon.')
    return getComputeBrowserInfo(service as BrowserInfoPodman, { agentName, agentId })
  })
}
