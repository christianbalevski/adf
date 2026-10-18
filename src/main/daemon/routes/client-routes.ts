// Client sessions and the client event stream (design daemon-backend.md D5),
// internal routes for clients that need exact UI parity (Studio daemon mode):
//
//   POST   /client/sessions                          {client, version, exitDaemonWhenClosed} → {sessionId, epoch}
//   GET    /client/sessions/:id/events?since=&epoch= SSE stream of client frames
//   PUT    /client/sessions/:id/focus                {agentId | null}
//   POST   /client/sessions/:id/documents            {filePath} or {agentId}: hold an open document
//   DELETE /client/sessions/:id/documents/:agentId   release it
//   DELETE /client/sessions/:id                      end the session
//
// The registry (client-sessions.ts) is the composition root's
// (registerDaemonClientSessions, or DaemonRouteDeps.clientSessions); a bare
// createDaemonHttpApi (tests) gets one fed by the runtime, the approvals hub
// and the event bus only.
//
// Producers that are routes (not services) are observed here, after the
// route answered:
//   - PUT /agents/:id/config with X-ADF-Client-Session: the config_changed it
//     raises is not echoed to that session (origin dedup);
//   - DELETE /agents/:id/inbox: `inbox` with an empty inbox (DOC_CLEAR_INBOX);
//   - POST /registry/agents/:id/bring-home: `adf_file_created`;
//   - template writes (/templates*): `templates`;
//   - W3-F: PUT /agents/:id/{config,files/content,mind} of an open document
//     that is not running (no runtime raises their frames): `config_changed`
//     / `file_updated`, with the write's revision and writer.
// Every write to /agents/:id/* runs as its writer (runAsWriter): the client
// session's client, or `cli` without one, so the revision it takes and the
// frames it raises name who wrote (W3-F).

import { deviceIdOf } from '../remote-access/request-auth'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { approvalHub } from '../../runtime/approval-hub'
import { DOCUMENT_HOLDER_FORMAT } from '../../runtime/runtime-service'
import { runAsWriter, type ResourceWriter } from '../../runtime/resource-revisions'
import type { AgentConfig } from '../../../shared/types/adf-v02.types'
import {
  ClientSessionError,
  ClientSessionRegistry,
  daemonClientSessions,
  runAsClientWrite,
  runtimeDocumentHost,
  wireApprovalsToClientSessions,
  wireEventBusToClientSessions,
  wireRuntimeToClientSessions,
  type ClientStreamSink,
} from '../client-sessions'
import type { DaemonRouteContext } from './index'
import { localAccessRefusal } from '../local-access'
import { requireLocalCaller } from '../identity-routes'
import { badRequest, stringParam } from './route-helpers'

/** Request header naming the client session a write comes from. */
export const CLIENT_SESSION_HEADER = 'x-adf-client-session'

interface SessionParams { id: string }

export function registerClientRoutes(server: FastifyInstance, ctx: DaemonRouteContext): void {
  const given = ctx.options.routes?.clientSessions ?? daemonClientSessions()
  const sessions = given ?? defaultRegistry(server, ctx)
  // Other routes check a session is live (POST /agents/create takes its holder from the session header).
  server.decorate('adfClientSessions', sessions)

  server.addHook('onClose', (_instance, done) => {
    // The server closes first in a daemon shutdown. Hijacked SSE responses
    // are invisible to Fastify: end them, and every session, here.
    sessions.dispose()
    done()
  })

  server.post<{ Body: { client?: unknown; version?: unknown; exitDaemonWhenClosed?: unknown; umbilical?: unknown; pid?: unknown } }>('/client/sessions', async (request, reply) => {
    const body = request.body ?? {}
    const client = stringParam(body.client)
    const version = stringParam(body.version)
    if (!client || !version) return badRequest(reply, 'client and version are required')
    if (body.exitDaemonWhenClosed !== undefined && typeof body.exitDaemonWhenClosed !== 'boolean') {
      return badRequest(reply, 'exitDaemonWhenClosed must be a boolean')
    }
    if (body.exitDaemonWhenClosed === true && !requireLocalCaller(request, reply, ctx.localAccess, 'Ownership of daemon shutdown can be granted')) return reply
    if (body.umbilical !== undefined && typeof body.umbilical !== 'boolean') return badRequest(reply, 'umbilical must be a boolean')
    if (body.pid !== undefined && !(typeof body.pid === 'number' && Number.isInteger(body.pid) && body.pid > 0)) return badRequest(reply, 'pid must be a positive integer')
    // A pid names a process on the daemon's machine: taken from a local caller only (a remote one's pid means nothing here).
    // A device token is another computer, whatever the peer address (remote-access.md §4.5).
    const deviceId = deviceIdOf(request.raw)
    const local = body.pid !== undefined && !deviceId && !localAccessRefusal({ remoteAddress: request.socket?.remoteAddress, headers: request.headers }, ctx.localAccess)
    const pid = local ? body.pid as number : undefined
    return send(reply, () => reply.code(201).send(sessions.create({ client, version, exitDaemonWhenClosed: body.exitDaemonWhenClosed === true, umbilical: body.umbilical === true, ...(pid ? { pid } : {}), ...(deviceId ? { deviceId } : {}) })))
  })

  server.get<{ Params: SessionParams; Querystring: { since?: string; epoch?: string } }>('/client/sessions/:id/events', async (request, reply) => {
    const { id } = request.params
    if (!sessions.has(id)) return sendError(reply, new ClientSessionError(`No client session ${id} (it ended or expired, or the daemon restarted).`, 404, 'session_not_found'))
    // ?since= wins over the standard SSE Last-Event-ID header.
    const sinceText = request.query.since ?? single(request.headers['last-event-id'])?.trim()
    let since: number | undefined
    if (sinceText !== undefined && sinceText !== '') {
      since = Number(sinceText)
      if (!Number.isSafeInteger(since) || since < 0) return badRequest(reply, 'since must be a non-negative integer cursor')
    }
    const epoch = stringParam(request.query.epoch)

    reply.hijack()
    const raw = reply.raw
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    raw.write(': connected\n\n')
    // Closed when the response or its socket is gone: a client that hung up
    // before attach is never attached, so its session's expiry clock runs.
    const sink: ClientStreamSink = {
      write: (chunk) => raw.write(chunk),
      once: (event, listener) => raw.once(event, listener),
      destroy: () => raw.destroy(),
      end: (chunk, cb) => { raw.end(chunk, cb) },
      get destroyed() { return raw.destroyed || raw.writableEnded || !raw.socket || raw.socket.destroyed },
    }
    const detach = () => sessions.detach(id, sink)
    request.raw.once('close', detach)
    raw.once('close', detach)
    try {
      sessions.attach(id, sink, { since, epoch })
    } catch {
      raw.destroy()
    }
  })

  server.put<{ Params: SessionParams; Body: { agentId?: unknown } }>('/client/sessions/:id/focus', async (request, reply) => {
    const agentId = request.body?.agentId
    if (agentId !== null && (typeof agentId !== 'string' || agentId.length === 0)) return badRequest(reply, 'agentId must be an agent id or null')
    return send(reply, () => ({ sessionId: request.params.id, focus: sessions.setFocus(request.params.id, agentId) }))
  })

  server.post<{ Params: SessionParams; Body: { filePath?: unknown; agentId?: unknown } }>('/client/sessions/:id/documents', async (request, reply) => {
    const filePath = stringParam(request.body?.filePath)
    const agentId = stringParam(request.body?.agentId)
    if (!filePath && !agentId) return badRequest(reply, 'filePath or agentId is required')
    try {
      return await sessions.holdDocument(request.params.id, { ...(filePath ? { filePath } : {}), ...(agentId ? { agentId } : {}) })
    } catch (err) {
      return sendError(reply, err)
    }
  })

  server.delete<{ Params: SessionParams & { agentId: string } }>('/client/sessions/:id/documents/:agentId', async (request, reply) => {
    try {
      await sessions.releaseDocument(request.params.id, request.params.agentId)
      return { sessionId: request.params.id, agentId: request.params.agentId, released: true }
    } catch (err) {
      return sendError(reply, err)
    }
  })

  server.delete<{ Params: SessionParams }>('/client/sessions/:id', async (request, reply) => {
    try {
      await sessions.end(request.params.id)
      return { sessionId: request.params.id, ended: true }
    } catch (err) {
      return sendError(reply, err)
    }
  })

  observeRouteProducers(server, ctx, sessions)
}

/** A registry for a daemon whose composition root passed none: runtime frames, approvals and the event bus. */
function defaultRegistry(server: FastifyInstance, ctx: DaemonRouteContext): ClientSessionRegistry {
  const sessions = new ClientSessionRegistry({
    startedBy: ctx.options.routes?.startedBy,
    requestShutdown: ctx.options.requestShutdown,
    resolveAgentId: (identifier) => ctx.runtime.getAgentOrDocument(identifier)?.id ?? null,
    // Session documents are open documents; the holder sweep keeps its TTL
    // here (the daemon's own wiring, wireDocumentsToClientSessions, also
    // tells the sweep which holders are live sessions).
    documents: runtimeDocumentHost(ctx.runtime),
  })
  const unwire = [
    wireRuntimeToClientSessions(sessions, ctx.runtime),
    wireApprovalsToClientSessions(sessions, approvalHub),
  ]
  if (ctx.options.eventBus) unwire.push(wireEventBusToClientSessions(sessions, ctx.options.eventBus))
  server.addHook('onClose', (_instance, done) => {
    for (const fn of unwire) fn()
    done()
  })
  return sessions
}

const AGENT_ROUTE = /^\/agents\/([^/?]+)\//
const AGENT_DOCUMENT = /^\/agents\/([^/?]+)\/document(?:\?|$)/
const AGENT_CONFIG = /^\/agents\/([^/?]+)\/config(?:\?|$)/
const AGENT_FILE_CONTENT = /^\/agents\/([^/?]+)\/files\/content(?:\?|$)/
const AGENT_MIND = /^\/agents\/([^/?]+)\/mind(?:\?|$)/
const AGENT_INBOX = /^\/agents\/([^/?]+)\/inbox(?:\?|$)/
const BRING_HOME = /^\/registry\/agents\/[^/?]+\/bring-home(?:\?|$)/

function observeRouteProducers(server: FastifyInstance, ctx: DaemonRouteContext, sessions: ClientSessionRegistry): void {
  // A write to /agents/:id/* that names its client session: the route
  // handler's synchronous part (where it calls the RuntimeService write, which
  // raises config_changed / file_updated synchronously) runs inside this
  // hook's done(), within runAsClientWrite, so those echo frames skip that
  // session. Nothing the request queues (a turn, a timer, a startup turn)
  // inherits the stamp. This MUST stay the last preHandler hook, so done()
  // calls the handler itself (W2-A's async guard is registered before it).
  server.addHook('preHandler', (request, _reply, done) => {
    if (request.method === 'GET' || request.method === 'HEAD' || !AGENT_ROUTE.test(request.url)) {
      done()
      return
    }
    const sessionId = clientSessionOf(request.headers)
    const live = sessionId && sessions.has(sessionId) ? sessionId : null
    runAsWriter(writerOf(sessions, live), () => {
      if (live) runAsClientWrite(live, () => done())
      else done()
    })
  })

  server.addHook('onSend', (request, reply, payload, done) => {
    if (reply.statusCode < 200 || reply.statusCode >= 300 || request.method === 'GET' || request.method === 'HEAD') {
      done(null, payload)
      return
    }
    try {
      const url = request.url
      const inbox = request.method === 'DELETE' ? AGENT_INBOX.exec(url) : null
      const document = request.method === 'PUT' ? AGENT_DOCUMENT.exec(url) : null
      const put = request.method === 'PUT'
      const config = put ? AGENT_CONFIG.exec(url) : null
      const fileContent = put ? (AGENT_FILE_CONTENT.exec(url) ?? AGENT_MIND.exec(url)) : null
      if (document) {
        // What an agent's own fs_write of document.md raises (agent-executor),
        // so every other client refreshes through the same renderer path.
        const ref = ctx.runtime.getAgentOrDocument(decodeSegment(document[1]))
        const content = (request.body as { content?: unknown } | undefined)?.content
        if (ref && typeof content === 'string') {
          const origin = liveSession(sessions, request.headers)
          sessions.publishExecutor({ agentId: ref.id, filePath: ref.filePath ?? null, event: { type: 'document_updated', payload: { content, ...revisionOf(payload), writer: writerOf(sessions, origin) }, timestamp: Date.now() } }, origin)
        }
      } else if (config || fileContent) {
        // A running agent raises these itself (its config-change choke point,
        // its workspace's file-change callback). An open document runs
        // nothing, so the write announces itself, or the other clients would
        // learn of it only through a refused save.
        const ref = ctx.runtime.getAgentOrDocument(decodeSegment((config ?? fileContent)![1]))
        if (ref && !ctx.runtime.getAgent(ref.id)) {
          const origin = liveSession(sessions, request.headers)
          const target = { agentId: ref.id, filePath: ref.filePath ?? null }
          const extra = { ...revisionOf(payload), writer: writerOf(sessions, origin) }
          if (config) {
            const result = parseJson(payload) as { config?: AgentConfig; filePath?: string } | null
            if (result?.config) {
              const filePath = result.filePath ?? ref.filePath ?? null
              const publish = () => sessions.publishPush('config_changed', { filePath, config: result.config!, ...extra }, { agentId: ref.id, filePath })
              if (origin) runAsClientWrite(origin, publish)
              else publish()
            }
          } else {
            const content = (request.body as { content?: unknown } | undefined)?.content
            const path = AGENT_MIND.test(url) ? 'mind.md' : (request.query as { path?: unknown } | undefined)?.path
            if (typeof content === 'string' && typeof path === 'string' && path !== 'README.md' && path !== 'document.md') {
              sessions.publishExecutor({ ...target, event: { type: 'file_updated', payload: { path, content, ...extra }, timestamp: Date.now() } }, origin)
            }
          }
        }
      } else if (inbox) {
        const ref = ctx.runtime.getAgentOrDocument(decodeSegment(inbox[1]))
        if (ref) sessions.publishPush('inbox', { inbox: { version: 1, messages: [] } }, { agentId: ref.id, filePath: ref.filePath ?? null })
      } else if (request.method === 'POST' && BRING_HOME.test(url)) {
        const result = parseJson(payload) as { success?: unknown; filePath?: unknown } | null
        if (result?.success === true && typeof result.filePath === 'string') sessions.publishPush('adf_file_created', { filePath: result.filePath })
      }
      // `templates` comes from the templates service itself (its writes and
      // the templates-folder watcher; daemon-agent-factory.ts), as Studio's
      // TEMPLATES_CHANGED does: one debounced push per change, not a second
      // one per request.
    } catch (err) {
      console.error('[ADF Daemon] Client stream producer failed:', err)
    }
    done(null, payload)
  })
}

function send(reply: FastifyReply, run: () => unknown): unknown {
  try {
    return run()
  } catch (err) {
    return sendError(reply, err)
  }
}

/**
 * The writer of a request (W3-F), for a route whose write runs after an
 * await (the preHandler's runAsWriter covers only the synchronous part):
 * the route wraps its write in runAsWriter(requestWriter(…)) itself.
 */
export function requestWriter(request: { server: FastifyInstance; headers: Record<string, string | string[] | undefined> }): ResourceWriter {
  const sessions = (request.server as unknown as { adfClientSessions?: ClientSessionRegistry }).adfClientSessions
  if (!sessions) return { kind: 'cli' }
  return writerOf(sessions, liveSession(sessions, request.headers))
}

/**
 * Run a route's write that happens after an await (past the preHandler's
 * window) as its request's: the writer for revisions (W3-F), and the origin
 * session, so the change frames the write raises synchronously
 * (`file_updated`, `config_changed`) skip the session that made it (D5.1
 * origin dedup), as for a write in the handler's synchronous part.
 */
export function runAsRequestWrite<T>(request: { server: FastifyInstance; headers: Record<string, string | string[] | undefined> }, fn: () => T): T {
  const sessions = (request.server as unknown as { adfClientSessions?: ClientSessionRegistry }).adfClientSessions
  if (!sessions) return runAsWriter({ kind: 'cli' }, fn)
  const origin = liveSession(sessions, request.headers)
  return runAsWriter(writerOf(sessions, origin), () => (origin ? runAsClientWrite(origin, fn) : fn()))
}

/** The live client session a request names, or null. */
function liveSession(sessions: ClientSessionRegistry, headers: Record<string, string | string[] | undefined>): string | null {
  const sessionId = clientSessionOf(headers)
  return sessionId && sessions.has(sessionId) ? sessionId : null
}

/** Who a write to /agents/:id/* is (W3-F): its live session's client, or the CLI. Never the session id. */
function writerOf(sessions: ClientSessionRegistry, sessionId: string | null): ResourceWriter {
  if (!sessionId) return { kind: 'cli' }
  return { kind: 'client', client: sessions.clientOf(sessionId) ?? 'client' }
}

/** `{revision}` of a write answer, when it has one. */
function revisionOf(payload: unknown): { revision?: number } {
  const revision = (parseJson(payload) as { revision?: unknown } | null)?.revision
  return typeof revision === 'number' ? { revision } : {}
}

/** The client session a request names (X-ADF-Client-Session), when it is a session id. */
function clientSessionOf(headers: Record<string, string | string[] | undefined>): string | null {
  const value = single(headers[CLIENT_SESSION_HEADER])
  return value && DOCUMENT_HOLDER_FORMAT.test(value) ? value : null
}

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof ClientSessionError) return reply.code(err.status).send({ error: err.message, code: err.code })
  return reply.code(500).send({ error: err instanceof Error ? err.message : String(err), code: 'internal_error' })
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function decodeSegment(segment: string): string {
  try { return decodeURIComponent(segment) } catch { return segment }
}

function parseJson(payload: unknown): unknown {
  if (typeof payload !== 'string') return null
  try { return JSON.parse(payload) } catch { return null }
}
