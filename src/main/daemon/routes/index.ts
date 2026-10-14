// Registry of daemon route modules. createDaemonHttpApi calls
// registerDaemonRoutes once, next to its other route modules.
//
// To add routes:
//   1. Write `src/main/daemon/routes/<area>-routes.ts` exporting
//      `register<Area>Routes(server, ctx)`.
//   2. Import it below and append it to DAEMON_ROUTE_MODULES (one line each).
//   3. If it needs a dependency the composition root (daemon/index.ts) owns,
//      add an optional field to DaemonRouteDeps and pass it there; read it as
//      `ctx.options.routes?.<field>`.
//   4. Document every route in docs/daemon/openapi.json (add entries only);
//      tests/openapi-coverage.test.ts fails on an undocumented route.

import type { FastifyInstance } from 'fastify'
import type { RuntimeService } from '../../runtime/runtime-service'
import type { DaemonHttpApiOptions } from '../http-api'
import type { LocalAccessOptions } from '../local-access'
import { registerMetaRoutes, type DaemonStartedBy } from './meta-routes'
import { registerApprovalsRoutes } from './approvals-routes'
import { registerCredentialsRoutes } from './credentials-routes'
import { registerFleetRoutes } from './fleet-routes'
import { registerDashboardRoutes } from './dashboard-routes'
import { registerRegistryRoutes } from './registry-routes'
import { registerCatalogRoutes } from './catalog-routes'
import { registerMcpAdminRoutes } from './mcp-admin-routes'
import { registerOwnerEnvelopeRoutes } from './owner-envelope-routes'
import { registerComputeAdminRoutes } from './compute-admin-routes'
import { registerJobRoutes } from './job-routes'
import type { GapRouteDeps } from './gap-deps'

/** Dependencies of route modules that DaemonHttpApiOptions does not carry. Every field is optional. */
export interface DaemonRouteDeps {
  /** GET /version: who launched this daemon run (ADF_DAEMON_STARTED_BY). */
  startedBy?: DaemonStartedBy
  /** Services the W1-D gap routes use (gap-deps.ts). */
  gaps?: GapRouteDeps
}

export interface DaemonRouteContext {
  runtime: RuntimeService
  options: DaemonHttpApiOptions
  /** Proxy mode + local proof, for local-only routes (requireLocalCaller). */
  localAccess: LocalAccessOptions
}

export type DaemonRouteModule = (server: FastifyInstance, ctx: DaemonRouteContext) => void

/** Append new modules at the end. */
export const DAEMON_ROUTE_MODULES: readonly DaemonRouteModule[] = [
  registerMetaRoutes,
  registerApprovalsRoutes,
  registerCredentialsRoutes,
  registerFleetRoutes,
  registerDashboardRoutes,
  registerRegistryRoutes,
  registerCatalogRoutes,
  registerMcpAdminRoutes,
  registerOwnerEnvelopeRoutes,
  registerComputeAdminRoutes,
  registerJobRoutes,
]

export function registerDaemonRoutes(server: FastifyInstance, ctx: DaemonRouteContext): void {
  for (const register of DAEMON_ROUTE_MODULES) register(server, ctx)
}
