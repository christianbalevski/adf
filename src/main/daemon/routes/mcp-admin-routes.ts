// Settings → MCP over the daemon API: probe, registration connect test and
// its interactive steps, server logs, app-level OAuth sign-in state, and the
// Python runtime for uvx servers.
//
//   POST /admin/mcp/probe                              MCP_PROBE_SERVER
//   POST /admin/mcp/registration-test                  MCP_REGISTRATION_TEST → 202 { jobId, job }
//   GET  /admin/mcp/interactions?jobId=                interactive steps of running tests
//   POST /admin/mcp/interactions/:interactionId/continue
//   GET  /admin/mcp/logs/:serverName?agentId=          MCP_GET_SERVER_LOGS
//   GET  /admin/mcp/oauth/status?url=                  MCP_OAUTH_STATUS (signed-in flag only)
//   POST /admin/mcp/oauth/signout                      MCP_OAUTH_SIGNOUT { url }
//   POST /admin/mcp/python-runtime                     MCP_ENSURE_PYTHON_RUNTIME → 202 { jobId, job }
//
// The probe and the test run Studio's code (services/mcp-connect-tests.ts).
// The registration test and the Python install can take minutes, so they run
// as jobs (daemon/jobs.ts): the client polls GET /jobs/:jobId for the result
// (Studio's IPC shape) and may cancel with POST /jobs/:jobId/cancel.
//
// A test's interactive steps cannot open a browser or a dialog here, so they
// are handed to the client: while the job runs, GET /admin/mcp/interactions
// lists `open_url` steps (an OAuth authorization URL the client opens) and
// `confirm` steps (the stdio auth preflight's "complete authorization in
// your browser, then Continue"), which the client answers with POST
// …/continue. A confirm nobody answers within CONFIRM_TIMEOUT_MS (the 5
// minutes the OAuth flow waits) lets the preflight continue, stays listed
// with `state: 'timed_out'` until the job ends, and is named in the test
// result's notes.
//
// No secret leaves these routes: OAuth status is a flag, logs are the
// servers' own stdout/stderr lines.

import { randomUUID } from 'crypto'
import type { FastifyInstance } from 'fastify'
import { runMcpAuthPreflight, type McpAuthPreflightRunner } from '../../services/mcp-auth-preflight'
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
import type { McpServerLogEntry } from '../../../shared/types/adf-v02.types'
import { jobsFor } from '../jobs'
import { gapDeps, uvManagerOf } from './gap-deps'
import type { DaemonRouteContext } from './index'
import { loadedAgentIndex } from './loaded-agents'
import { notFound, stringParam } from './route-helpers'

/** How long a `confirm` step waits for the client before the preflight continues on its own. */
export const CONFIRM_TIMEOUT_MS = 300_000
/** Persisted MCP server logs per server name, and how many server names are kept (as Studio). */
const MCP_LOG_CACHE_MAX_SERVERS = 50

export interface McpInteraction {
  id: string
  /** The registration-test job this step belongs to. */
  jobId: string
  kind: 'open_url' | 'confirm'
  /** `pending` until answered; a confirm nobody answered in time reads `timed_out`. */
  state: 'pending' | 'timed_out'
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
  const jobs = jobsFor(options)
  const confirmTimeoutMs = gapDeps(ctx).mcpConfirmTimeoutMs ?? CONFIRM_TIMEOUT_MS

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

  const addInteraction = (entry: Omit<McpInteraction, 'id' | 'createdAt' | 'state'>, resolve?: () => void): PendingInteraction => {
    const pending: PendingInteraction = { ...entry, id: randomUUID(), state: 'pending', createdAt: Date.now(), resolve }
    interactions.set(pending.id, pending)
    console.log(`[MCP] Interactive step for "${entry.serverName ?? 'server'}" (${entry.kind}) handed to the client: GET /admin/mcp/interactions?jobId=${entry.jobId}`)
    return pending
  }

  const oauthIO = (jobId: string, serverName: string | undefined) => ({
    openUrl: (url: string) => {
      addInteraction({ jobId, kind: 'open_url', serverName, url, message: 'Open this authorization page in the browser to sign in.' })
    },
    log: (msg: string) => console.log(msg),
  })

  const interactivePreflight = (jobId: string): McpAuthPreflightRunner => gapDeps(ctx).mcpAuthPreflight ?? ((serverCfg, opts) =>
    runMcpAuthPreflight(serverCfg, opts, {
      ...oauthIO(jobId, serverCfg.name),
      confirm: ({ serverName, authUrlOpened }) => new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        const pending = addInteraction({
          jobId,
          kind: 'confirm',
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
          console.warn(`[MCP] No client continued the authorization step for "${serverName}" within ${confirmTimeoutMs / 1000}s — continuing without it`)
          // Kept, visibly: listed as timed_out and named in the job's result.
          pending.state = 'timed_out'
          pending.resolve = undefined
          resolve()
        }, confirmTimeoutMs)
        timer.unref?.()
      }),
    }))

  /** Close a finished job's steps: release waiting confirms; returns the timed-out ones. */
  const closeInteractions = (jobId: string): PendingInteraction[] => {
    const timedOut: PendingInteraction[] = []
    for (const [id, entry] of interactions) {
      if (entry.jobId !== jobId) continue
      if (entry.state === 'timed_out') timedOut.push(entry)
      entry.resolve?.()
      interactions.delete(id)
    }
    return timedOut
  }

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

  // 202 { jobId, job }: the result (Studio's McpRegistrationTestResult)
  // arrives on GET /jobs/:jobId.
  server.post<{ Body: unknown }>('/admin/mcp/registration-test', async (request, reply) => {
    const body = request.body
    const serverName = stringParam((body as { registration?: { name?: unknown } } | null)?.registration?.name)
    const job = jobs.start('mcp.registration-test', async ({ signal, id }) => {
      try {
        const result = await runMcpRegistrationTest(body, {
          computeSettings: () => (options.settingsStore?.get('compute') ?? { hostAccessEnabled: false, hostApproved: [] }) as ComputeSettings,
          uvManager: uvManagerOf(ctx),
          podman: podman(),
          appOAuthStore: gapDeps(ctx).mcpAppOAuthStore ?? null,
          oauthIO: oauthIO(id, serverName),
          authPreflight: interactivePreflight(id),
          onLog: cacheLog,
          signal,
        })
        for (const entry of closeInteractions(id)) {
          result.notes.push(`No one confirmed the authorization step for "${entry.serverName ?? serverName ?? 'the server'}" within ${Math.round(confirmTimeoutMs / 60_000)} minutes; the test continued without the confirmation.`)
        }
        return result
      } finally {
        closeInteractions(id)
      }
    })
    return reply.code(202).send({ jobId: job.id, job })
  })

  server.get<{ Querystring: { jobId?: string } }>('/admin/mcp/interactions', async (request) => {
    const jobId = stringParam(request.query.jobId)
    return {
      interactions: [...interactions.values()]
        .filter((entry) => !jobId || entry.jobId === jobId)
        .map(({ resolve: _resolve, ...entry }) => entry),
    }
  })

  // open_url steps are acknowledged (removed); confirm steps let the waiting
  // preflight continue. A timed-out step can no longer be answered.
  server.post<{ Params: { interactionId: string } }>('/admin/mcp/interactions/:interactionId/continue', async (request, reply) => {
    const entry = interactions.get(request.params.interactionId)
    if (!entry || entry.state !== 'pending') return notFound(reply, 'No such pending interaction (answered, timed out, or its test finished)')
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

  // Downloads uv and Python when missing: a job (202 { jobId, job }). A
  // cancelled job stops waiting; a download already running finishes.
  server.post('/admin/mcp/python-runtime', async (_request, reply) => {
    const job = jobs.start('mcp.python-runtime', () => ensurePythonRuntime(uvManagerOf(ctx)))
    return reply.code(202).send({ jobId: job.id, job })
  })
}
