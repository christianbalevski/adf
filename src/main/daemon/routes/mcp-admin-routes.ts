// Settings → MCP over the daemon API: probe, registration connect test and
// its interactive steps, server logs, app-level OAuth sign-in state, and the
// Python runtime for uvx servers.
//
//   POST /admin/mcp/probe                              MCP_PROBE_SERVER
//   POST /admin/mcp/registration-test                  MCP_REGISTRATION_TEST
//   GET  /admin/mcp/interactions                       pending interactive steps of running tests
//   POST /admin/mcp/interactions/:interactionId/continue
//   GET  /admin/mcp/logs/:serverName?agentId=          MCP_GET_SERVER_LOGS
//   GET  /admin/mcp/oauth/status?url=                  MCP_OAUTH_STATUS (signed-in flag only)
//   POST /admin/mcp/oauth/signout                      MCP_OAUTH_SIGNOUT { url }
//   POST /admin/mcp/python-runtime                     MCP_ENSURE_PYTHON_RUNTIME
//
// The probe and the test run Studio's code (services/mcp-connect-tests.ts).
// Their interactive steps cannot open a browser or a dialog here, so they
// are handed to the client instead: while a test runs, GET
// /admin/mcp/interactions lists `open_url` steps (an OAuth authorization URL
// the client opens) and `confirm` steps (the stdio auth preflight's
// "complete authorization in your browser, then Continue"), which the client
// answers with POST …/continue. A confirm nobody answers continues after
// CONFIRM_TIMEOUT_MS, the same 5 minutes the OAuth flow waits.
//
// No secret leaves these routes: OAuth status is a flag, logs are the
// servers' own stdout/stderr lines.

import { randomUUID } from 'crypto'
import type { FastifyInstance } from 'fastify'
import { runMcpAuthPreflight } from '../../services/mcp-auth-preflight'
import {
  appendMcpLog,
  ensurePythonRuntime,
  mcpOAuthSignOut,
  mcpOAuthStatus,
  probeMcpServer,
  runMcpRegistrationTest,
  type McpTestPodman,
} from '../../services/mcp-connect-tests'
import type { ComputeSettings } from '../../services/container-routing'
import { withDeadline } from '../../utils/concurrency'
import type { McpServerLogEntry } from '../../../shared/types/adf-v02.types'
import { gapDeps, uvManagerOf } from './gap-deps'
import type { DaemonRouteContext } from './index'
import { loadedAgentIndex } from './loaded-agents'
import { notFound, stringParam } from './route-helpers'

/** How long a `confirm` step waits for the client before the preflight continues on its own. */
export const CONFIRM_TIMEOUT_MS = 300_000
/** Uv and Python downloads on POST /admin/mcp/python-runtime; past this the route answers and the download continues. */
export const PYTHON_RUNTIME_DEADLINE_MS = 600_000
/** Persisted MCP server logs per server name, and how many server names are kept (as Studio). */
const MCP_LOG_CACHE_MAX_SERVERS = 50

export interface McpInteraction {
  id: string
  kind: 'open_url' | 'confirm'
  /** The registration test's `interactionTag`, when the caller sent one. */
  tag?: string
  serverName?: string
  /** open_url: the authorization URL to open in the user's browser. */
  url?: string
  /** confirm: whether the preflight found an authorization URL to open. */
  authUrlOpened?: boolean
  message: string
  createdAt: number
}

interface PendingInteraction extends McpInteraction {
  resolve?: () => void
}

export function registerMcpAdminRoutes(server: FastifyInstance, ctx: DaemonRouteContext): void {
  const { runtime, options } = ctx
  const index = loadedAgentIndex(runtime)
  const interactions = new Map<string, PendingInteraction>()

  // Logs of probe and test runs, and of every loaded agent's MCP servers, so
  // the Logs viewer still has them after the manager is gone.
  const logCache = new Map<string, McpServerLogEntry[]>()
  const cacheLog = (name: string, entry: McpServerLogEntry): void => {
    appendMcpLog(logCache, name, entry)
    while (logCache.size > MCP_LOG_CACHE_MAX_SERVERS) {
      const oldest = logCache.keys().next().value
      if (oldest === undefined) break
      logCache.delete(oldest)
    }
  }
  index.onLoaded(({ agent }) => {
    agent.mcpManager?.on('log', (name: string, entry: McpServerLogEntry) => cacheLog(name, entry))
  })

  const addInteraction = (entry: Omit<McpInteraction, 'id' | 'createdAt'>, resolve?: () => void): PendingInteraction => {
    const pending: PendingInteraction = { ...entry, id: randomUUID(), createdAt: Date.now(), resolve }
    interactions.set(pending.id, pending)
    console.log(`[MCP] Interactive step for "${entry.serverName ?? 'server'}" (${entry.kind}) handed to the client: GET /admin/mcp/interactions`)
    return pending
  }

  const oauthIO = (tag: string | undefined, serverName: string | undefined) => ({
    openUrl: (url: string) => {
      addInteraction({ kind: 'open_url', tag, serverName, url, message: 'Open this authorization page in the browser to sign in.' })
    },
    log: (msg: string) => console.log(msg),
  })

  const interactivePreflight = (tag: string | undefined) => gapDeps(ctx).mcpAuthPreflight ?? ((serverCfg, opts) =>
    runMcpAuthPreflight(serverCfg, opts, {
      ...oauthIO(tag, serverCfg.name),
      confirm: ({ serverName, authUrlOpened }) => new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        const pending = addInteraction({
          kind: 'confirm',
          tag,
          serverName,
          authUrlOpened,
          message: authUrlOpened
            ? `Complete the authorization flow for "${serverName}" in the browser, then continue.`
            : `The "${serverName}" MCP server is running for interactive authorization. If a browser window opened, complete the flow and continue. If no browser opened, check the logs for an authorization URL.`,
        }, () => {
          if (timer) clearTimeout(timer)
          interactions.delete(pending.id)
          resolve()
        })
        timer = setTimeout(() => {
          console.warn(`[MCP] No client continued the authorization step for "${serverName}" within ${CONFIRM_TIMEOUT_MS / 1000}s — continuing`)
          pending.resolve?.()
        }, CONFIRM_TIMEOUT_MS)
        timer.unref?.()
      }),
    }))

  const podman = (): McpTestPodman => {
    const compute = options.computeService as unknown as Partial<McpTestPodman> | undefined
    if (compute?.ensureRunning && compute.findPodman && compute.ensureWorkspace && compute.execInContainer) return compute as McpTestPodman
    return {
      ensureRunning: async () => { throw new Error('Compute is not configured on this daemon') },
      findPodman: async () => null,
      ensureWorkspace: async () => {},
      execInContainer: async () => ({}),
    }
  }

  server.post<{ Body: unknown }>('/admin/mcp/probe', async (request) =>
    probeMcpServer(request.body, { uvManager: uvManagerOf(ctx), onLog: cacheLog }))

  server.post<{ Body: { interactionTag?: unknown } | null }>('/admin/mcp/registration-test', async (request) => {
    const tag = stringParam(request.body?.interactionTag)
    const startedAt = Date.now()
    const serverName = stringParam((request.body as { registration?: { name?: unknown } } | null)?.registration?.name)
    try {
      return await runMcpRegistrationTest(request.body, {
        computeSettings: () => (options.settingsStore?.get('compute') ?? { hostAccessEnabled: false, hostApproved: [] }) as ComputeSettings,
        uvManager: uvManagerOf(ctx),
        podman: podman(),
        appOAuthStore: gapDeps(ctx).mcpAppOAuthStore ?? null,
        oauthIO: oauthIO(tag, serverName),
        authPreflight: interactivePreflight(tag),
        onLog: cacheLog,
      })
    } finally {
      // Steps of this run that nobody answered are over with it.
      for (const [id, entry] of interactions) {
        if (entry.createdAt >= startedAt && entry.tag === tag && entry.serverName === serverName) {
          entry.resolve?.()
          interactions.delete(id)
        }
      }
    }
  })

  server.get<{ Querystring: { tag?: string } }>('/admin/mcp/interactions', async (request) => {
    const tag = stringParam(request.query.tag)
    return {
      interactions: [...interactions.values()]
        .filter((entry) => !tag || entry.tag === tag)
        .map(({ resolve: _resolve, ...entry }) => entry),
    }
  })

  // open_url steps are acknowledged (removed); confirm steps let the waiting
  // preflight continue.
  server.post<{ Params: { interactionId: string } }>('/admin/mcp/interactions/:interactionId/continue', async (request, reply) => {
    const entry = interactions.get(request.params.interactionId)
    if (!entry) return notFound(reply, 'No such pending interaction (answered, timed out, or its test finished)')
    interactions.delete(entry.id)
    entry.resolve?.()
    return { success: true }
  })

  // A loaded agent's live server logs first (agentId), else the cache.
  server.get<{ Params: { serverName: string }; Querystring: { agentId?: string } }>('/admin/mcp/logs/:serverName', async (request) => {
    const name = request.params.serverName
    const agentId = stringParam(request.query.agentId)
    const ref = agentId ? runtime.getAgent(agentId) : undefined
    const live = ref ? index.get(ref.id)?.agent.mcpManager?.getServerLogs(name) : undefined
    if (live && live.length > 0) return { logs: live }
    return { logs: logCache.get(name) ?? [] }
  })

  server.get<{ Querystring: { url?: string } }>('/admin/mcp/oauth/status', async (request) => {
    const store = gapDeps(ctx).mcpAppOAuthStore
    if (!store) return { signedIn: false }
    return mcpOAuthStatus(store, { url: request.query.url })
  })

  server.post<{ Body: { url?: unknown } | null }>('/admin/mcp/oauth/signout', async (request) => {
    const store = gapDeps(ctx).mcpAppOAuthStore
    if (!store) return { success: false, error: 'MCP OAuth sign-in is not available on this daemon: it has no app-level OAuth token store.' }
    const result = await mcpOAuthSignOut(store, request.body)
    if (result.success) console.log('[MCP] Signed out of an OAuth remote server on request')
    return result
  })

  server.post('/admin/mcp/python-runtime', async () => {
    const { timedOut, value } = await withDeadline(ensurePythonRuntime(uvManagerOf(ctx)), PYTHON_RUNTIME_DEADLINE_MS)
    if (timedOut || !value) {
      return { success: false, error: `Installing uv / Python is taking longer than ${PYTHON_RUNTIME_DEADLINE_MS / 60_000} minutes; it continues in the background. Try again later.`, uvAvailable: false, pythonAvailable: false }
    }
    return value
  })
}
