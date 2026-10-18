// Studio's quit and mode-switch handover against its daemon (design
// daemon-backend.md §8.3, §11). Internal routes, tag `Client (internal)`:
//
//   GET  /client/sessions                         the open sessions' clients (no ids)
//   POST /client/sessions/:id/quit                {stopDaemon?}  end the session; stop the daemon when allowed
//   PUT  /client/sessions/:id/exit-when-closed    {exitDaemonWhenClosed}  the client's quit behaviour changed
//   POST /client/reload-credentials               {}             re-read the stores Studio moved credentials into
//
// Quit (§8.3, `keepDaemonRunning` off): the session ends, then the daemon
// stops only when this run was started by Studio (GET /version `startedBy`)
// AND no other client session is open. With other clients connected the
// stop is pending: it happens when the last one ends or expires (the orphan
// rule's hold). A daemon the CLI or a service started is never stopped
// here. The decision and its reason are logged and answered, so Studio logs
// them too. When it stops, the registry refuses new sessions before the
// answer is sent, so none can open between the decision and the stop. The
// shutdown is the daemon's own bounded one (20 s), which runs on after
// Studio has exited: it stops only the containers this daemon run claimed
// (W1-G).
//
// Reload: Studio main moved credentials into the daemon's stores (auth.daemon.json,
// the keychain's MCP sign-ins and studio-runtime entry) while this daemon
// was running. No secret crosses HTTP: the daemon re-reads what it reads at
// boot (the runtime identity entry), re-runs the unlock cascade of degraded
// agents, and lets loops that failed on a subscription's auth recover.
// ChatGPT and Grok sessions and MCP sign-ins are read from their stores on
// every use, so they need no cache drop.
//
// Both are local-only (local-access.ts): loopback, no proxy headers, and the
// local proof behind a proxy.

import type { FastifyInstance } from 'fastify'
import { readTokens as readChatGptTokens } from '../../providers/chatgpt-subscription/token-store'
import { readTokens as readGrokTokens } from '../../providers/grok-subscription/token-store'
import { requireLocalCaller } from '../identity-routes'
import type { ClientSessionRegistry } from '../client-sessions'
import type { DaemonRouteContext } from './index'
import { badRequest } from './route-helpers'

export interface ClientQuitResult {
  sessionId: string
  /** False when the session had already ended or expired. */
  ended: boolean
  /** True when the daemon is shutting down because of this request. */
  stopping: boolean
  /** Why the daemon stops or keeps running, one sentence. */
  reason: string
  /** Client sessions still open after this one ended. */
  otherSessions: number
}

export interface CredentialReloadResult {
  /** The runtime identity adoption after the re-read (GET /identity `runtime`), when the daemon has an owner identity. */
  runtime: { state: string; reason: string | null; message: string } | null
  /** Agents whose credentials unlocked now. */
  unlocked: Array<{ agentId: string; filePath: string | null }>
  /** Agents still degraded on locked credentials. */
  stillLocked: Array<{ agentId: string; filePath: string | null }>
  /** Subscription sessions present in this daemon's stores. */
  sessions: string[]
  /** Loops that left an auth error. */
  recovered: number
}

function log(message: string): void {
  console.log(`[ADF Daemon] ${message}`)
}

export function registerClientLifecycleRoutes(server: FastifyInstance, ctx: DaemonRouteContext): void {
  const registry = (): ClientSessionRegistry | undefined =>
    (server as unknown as { adfClientSessions?: ClientSessionRegistry }).adfClientSessions

  server.get('/client/sessions', async (_request, reply) => {
    const sessions = registry()
    if (!sessions) return reply.code(405).send({ error: 'Client sessions are not available on this daemon.', code: 'method_not_allowed' })
    return { sessions: sessions.list() }
  })

  server.put<{ Params: { id: string }; Body: { exitDaemonWhenClosed?: unknown } | undefined }>('/client/sessions/:id/exit-when-closed', async (request, reply) => {
    const value = request.body && typeof request.body === 'object' ? request.body.exitDaemonWhenClosed : undefined
    if (typeof value !== 'boolean') return badRequest(reply, 'exitDaemonWhenClosed must be a boolean')
    if (!requireLocalCaller(request, reply, ctx.localAccess, 'Ownership of daemon shutdown can be changed')) return reply
    const sessions = registry()
    if (!sessions) return reply.code(405).send({ error: 'Client sessions are not available on this daemon.', code: 'method_not_allowed' })
    if (!sessions.has(request.params.id)) return reply.code(404).send({ error: `No client session ${request.params.id} (it ended or expired, or the daemon restarted).`, code: 'session_not_found' })
    sessions.setExitDaemonWhenClosed(request.params.id, value)
    return { sessionId: request.params.id, exitDaemonWhenClosed: value }
  })

  server.post<{ Params: { id: string }; Body: { stopDaemon?: unknown } | undefined }>('/client/sessions/:id/quit', async (request, reply) => {
    const body = request.body && typeof request.body === 'object' ? request.body : {}
    if (body.stopDaemon !== undefined && typeof body.stopDaemon !== 'boolean') return badRequest(reply, 'stopDaemon must be a boolean')
    const stopDaemon = body.stopDaemon === true
    // Stopping the daemon is local-only, as POST /daemon/shutdown is.
    if (stopDaemon && !requireLocalCaller(request, reply, ctx.localAccess, 'The daemon can be stopped')) return reply
    const sessions = registry()
    if (!sessions) return reply.code(405).send({ error: 'Client sessions are not available on this daemon.', code: 'method_not_allowed' })
    const id = request.params.id
    let ended = false
    if (sessions.has(id)) {
      await sessions.end(id)
      ended = true
    }
    // Sessions of other computers (device tokens) never hold the stop: Studio asked the owner first (remote-access.md §3.6).
    const others = sessions.localSize
    const startedBy = ctx.options.routes?.startedBy ?? 'cli'
    const answer = (stopping: boolean, reason: string): ClientQuitResult => {
      log(`Client session ${id} quit${ended ? '' : ' (it had already ended)'}: ${stopping ? 'stopping the daemon' : 'the daemon keeps running'}: ${reason}`)
      return { sessionId: id, ended, stopping, reason, otherSessions: others }
    }
    if (!stopDaemon) return answer(false, 'the client asked to leave the daemon running (keepDaemonRunning on)')
    if (startedBy !== 'studio') return answer(false, `this daemon run was started by ${startedBy}, not Studio; Studio never stops it`)
    if (!ctx.options.requestShutdown) return answer(false, 'shutdown is not available on this daemon')
    if (others > 0) {
      sessions.holdForQuit(`Studio quit (client session ${id}) and asked to stop the daemon it started`)
      return answer(false, `${others} other client session(s) are still open; the daemon stops when the last one ends`)
    }
    // No session may open between this decision and the stop; answer first, the shutdown closes this server.
    sessions.markClosing()
    setTimeout(() => ctx.options.requestShutdown?.(), 50)
    return answer(true, 'Studio started this daemon run and no other client session is open')
  })

  server.post('/client/reload-credentials', async (request, reply) => {
    if (!requireLocalCaller(request, reply, ctx.localAccess, 'Credentials can be reloaded')) return reply
    let runtime: CredentialReloadResult['runtime'] = null
    const identity = ctx.options.identity
    if (identity) {
      try {
        // Re-reads the studio-runtime entry; a change of adoption also re-runs the unlock (daemon/index.ts onRuntimeChange).
        const status = identity.refresh()
        runtime = { state: status.runtime.state, reason: status.runtime.reason, message: status.runtime.message }
      } catch (err) {
        console.error('[ADF Daemon] Owner identity refresh on credential reload failed:', err)
      }
    }
    const sessions: string[] = []
    const signedIn: Array<{ providerType: string; label: string }> = []
    if (readChatGptTokens()) { sessions.push('chatgpt'); signedIn.push({ providerType: 'chatgpt-subscription', label: 'ChatGPT' }) }
    if (readGrokTokens()) { sessions.push('grok'); signedIn.push({ providerType: 'grok-subscription', label: 'Grok' }) }
    const { credentials, recovered } = await ctx.runtime.reloadCredentials('credentials reloaded by Studio', signedIn)
    const result: CredentialReloadResult = {
      runtime,
      unlocked: credentials.filter((c) => c.unlocked).map((c) => ({ agentId: c.agentId, filePath: c.filePath ?? null })),
      stillLocked: credentials.filter((c) => !c.unlocked).map((c) => ({ agentId: c.agentId, filePath: c.filePath ?? null })),
      sessions,
      recovered: recovered.length,
    }
    log(`Credentials reloaded (requested by a local client): runtime identity ${runtime?.state ?? 'n/a'}, ${result.unlocked.length} agent(s) unlocked, ${result.stillLocked.length} still locked, sessions [${sessions.join(', ')}], ${result.recovered} loop(s) recovered`)
    return result
  })
}
