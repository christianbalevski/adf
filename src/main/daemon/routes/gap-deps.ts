// Dependencies of the W1-D gap route modules that DaemonHttpApiOptions does
// not carry, passed as DaemonRouteDeps.gaps by the composition root
// (daemon/index.ts). Every field is optional: a route falls back to a
// private instance where that is safe (uv, the schema-only sandbox stub) and
// otherwise answers that the capability is not available on this daemon.

import type { CodeSandboxService } from '../../runtime/code-sandbox'
import type { AgentRegistryServiceOptions } from '../../services/agent-registry.service'
import type { McpAuthPreflightRunner } from '../../services/mcp-auth-preflight'
import type { PythonRuntimeUv } from '../../services/mcp-connect-tests'
import type { McpOAuthStore } from '../../services/mcp-oauth.types'
import { UvManager } from '../../services/uv-manager'
import type { DaemonRouteContext } from './index'

export interface GapRouteDeps {
  /**
   * The app-level MCP OAuth token store (W1-C's DaemonAppOAuthStore), the
   * "signed in" source of truth for Settings → MCP. Absent: status reads
   * signed out, sign-out and OAuth sign-in during a registration test refuse.
   */
  mcpAppOAuthStore?: McpOAuthStore | null
  /** The daemon's UvManager (shared with the uvx resolver). Default: a private one. */
  uvManager?: PythonRuntimeUv
  /** The daemon's code sandbox, destroyed by emergency stop. Absent: emergency stop skips it. */
  codeSandboxService?: CodeSandboxService
  /** The daemon's mesh HTTP server, stopped by emergency stop (not persisted). Absent: emergency stop skips it. */
  meshServer?: { stop(): Promise<void> }
  /** Interactive stdio auth preflight for the registration test. Default: interaction prompts relayed to the client (mcp-admin-routes). */
  mcpAuthPreflight?: McpAuthPreflightRunner
  /** External execution target probe (Settings → Compute). Default: a private ExternalExecutionService. */
  externalExecution?: { probe(target: unknown): Promise<unknown> }
  /** Registry service overrides (tests): bundled dir, cache dir, app version, fetchers. */
  registry?: {
    bundledDir?: string
    userDataDir?: string
    appVersion?: string
    agentFetchFn?: AgentRegistryServiceOptions['fetchFn']
    mcpFetchFn?: typeof fetch
  }
}

export function gapDeps(ctx: DaemonRouteContext): GapRouteDeps {
  return ctx.options.routes?.gaps ?? {}
}

let sharedUv: UvManager | null = null

/** The composition root's UvManager, else one private instance for all gap routes. */
export function uvManagerOf(ctx: DaemonRouteContext): PythonRuntimeUv {
  const given = gapDeps(ctx).uvManager
  if (given) return given
  if (!sharedUv) sharedUv = new UvManager()
  return sharedUv
}
