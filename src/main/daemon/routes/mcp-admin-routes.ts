// Settings → MCP over the daemon API: probe, registration connect test and
// its interactive steps, server logs, app-level OAuth sign-in state, and the
// Python runtime for uvx servers.
//
//   POST /admin/mcp/probe                              MCP_PROBE_SERVER
//   POST /admin/mcp/registration-test                  MCP_REGISTRATION_TEST → 202 { jobId, job }
//   GET  /admin/mcp/interactions?jobId=                interactive steps of running tests
//   POST /admin/mcp/interactions/:interactionId/continue
//   POST /admin/mcp/interactions/:interactionId/cancel
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
// lists `open_url` steps (an OAuth authorization URL the client opens and
// acknowledges with POST …/continue) and `sign_in` steps (a stdio server's
// sign-in command is running: the client shows a dialog until the step
// leaves the list, and POST …/cancel ends the sign-in). A sign-in ends when
// its command exits; the preflight's own timeout bounds it.
//
// No secret leaves these routes: OAuth status is a flag, logs are the
// servers' own stdout/stderr lines.

import { randomUUID } from 'crypto'
import type { FastifyInstance, FastifyReply } from 'fastify'
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
import { JobLimitError, jobsFor, type JobContext, type JobView } from '../jobs'
import { gapDeps, uvManagerOf } from './gap-deps'
import type { DaemonRouteContext } from './index'
import { loadedAgentIndex } from './loaded-agents'
import { notFound, stringParam } from './route-helpers'

/** Persisted MCP server logs per server name, and how many server names are kept (as Studio). */
const MCP_LOG_CACHE_MAX_SERVERS = 50

export interface McpInteraction {
  id: string
  /** The registration-test job this step belongs to. */
  jobId: string
  kind: 'open_url' | 'sign_in'
  state: 'pending'
  serverName?: string
  /** The authorization URL (sign_in: the one the command printed, once it has). */
  url?: string
  message: string
  createdAt: number
}

interface PendingInteraction extends McpInteraction {
  resolve?: () => void
  /** sign_in: read on every listing, since the command may print it late. */
  authUrl?: () => string | null
}

export function registerMcpAdminRoutes(server: FastifyInstance, ctx: DaemonRouteContext): void {
  const { runtime, options } = ctx
  const index = loadedAgentIndex(runtime)
  const interactions = new Map<string, PendingInteraction>()
  const jobs = jobsFor(options)

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

  const addInteraction = (entry: Omit<PendingInteraction, 'id' | 'createdAt' | 'state'>): PendingInteraction => {
    const pending: PendingInteraction = { ...entry, id: randomUUID(), state: 'pending', createdAt: Date.now() }
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
      // Listed until the command finishes (signal) or the client cancels.
      waitForUser: ({ serverName, authUrl, signal }) => new Promise<void>((resolve) => {
        const done = () => { interactions.delete(pending.id); resolve() }
        const pending = addInteraction({
          jobId,
          kind: 'sign_in',
          serverName,
          authUrl,
          message: `Finish signing in to ${serverName} in your browser.`,
          resolve: done,
        })
        if (signal.aborted) done()
        else signal.addEventListener('abort', done, { once: true })
      }),
    }))

  /** Close a finished job's steps. */
  const closeInteractions = (jobId: string): void => {
    for (const [id, entry] of interactions) {
      if (entry.jobId !== jobId) continue
      interactions.delete(id)
      entry.resolve?.()
    }
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
    const run = async ({ signal, id }: JobContext) => {
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
        return result
      } finally {
        closeInteractions(id)
      }
    }
    let job: JobView
    try {
      job = jobs.start('mcp.registration-test', run)
    } catch (err) {
      if (err instanceof JobLimitError) return tooManyJobs(reply, err)
      throw err
    }
    return reply.code(202).send({ jobId: job.id, job })
  })

  server.get<{ Querystring: { jobId?: string } }>('/admin/mcp/interactions', async (request) => {
    const jobId = stringParam(request.query.jobId)
    return {
      interactions: [...interactions.values()]
        .filter((entry) => !jobId || entry.jobId === jobId)
        .map(({ resolve: _resolve, authUrl, ...entry }) => {
          const url = authUrl?.() ?? entry.url
          return url ? { ...entry, url } : entry
        }),
    }
  })

  // open_url steps are acknowledged (removed).
  server.post<{ Params: { interactionId: string } }>('/admin/mcp/interactions/:interactionId/continue', async (request, reply) => {
    const entry = interactions.get(request.params.interactionId)
    if (!entry || entry.kind !== 'open_url') return notFound(reply, 'No such pending authorization page (answered, or its test finished)')
    interactions.delete(entry.id)
    return { success: true }
  })

  // sign_in steps: the user cancelled; the preflight stops and the test fails.
  server.post<{ Params: { interactionId: string } }>('/admin/mcp/interactions/:interactionId/cancel', async (request, reply) => {
    const entry = interactions.get(request.params.interactionId)
    if (!entry || entry.kind !== 'sign_in') return notFound(reply, 'No such sign-in in progress (finished, cancelled, or its test finished)')
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

  server.get<{ Querystring: { name?: string; url?: string } }>('/admin/mcp/oauth/status', async (request) => {
    const store = gapDeps(ctx).mcpAppOAuthStore
    if (!store) return { signedIn: false }
    return mcpOAuthStatus(store, { name: request.query.name, url: request.query.url })
  })

  server.post<{ Body: { name?: unknown } | null }>('/admin/mcp/oauth/signout', async (request) => {
    const store = gapDeps(ctx).mcpAppOAuthStore
    if (!store) return { success: false, error: 'MCP OAuth sign-in is not available on this daemon: it has no app-level OAuth token store.' }
    const result = await mcpOAuthSignOut(store, request.body)
    if (result.success) console.log('[MCP] Signed out of an OAuth remote server on request')
    return result
  })

  // Downloads uv and Python when missing: a job (202 { jobId, job }). A
  // cancelled job stops waiting; a download already running finishes. While
  // one runs, another request joins it (`job.joined`) instead of starting a
  // second download into the same directory.
  server.post('/admin/mcp/python-runtime', async (_request, reply) => {
    try {
      const job = jobs.start('mcp.python-runtime', () => ensurePythonRuntime(uvManagerOf(ctx)), { key: 'uv' })
      return reply.code(202).send({ jobId: job.id, job })
    } catch (err) {
      if (err instanceof JobLimitError) return tooManyJobs(reply, err)
      throw err
    }
  })
}

/** 429: the job registry is full (jobs.ts MAX_RUNNING). */
export function tooManyJobs(reply: FastifyReply, err: JobLimitError): FastifyReply {
  return reply.code(429).send({ error: err.message, code: err.code })
}
