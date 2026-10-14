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
//   - template writes (/templates*): `templates`.

import type { FastifyInstance, FastifyReply } from 'fastify'
import { approvalHub } from '../../runtime/approval-hub'
import { DOCUMENT_HOLDER_FORMAT } from '../../runtime/runtime-service'
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

  server.post<{ Body: { client?: unknown; version?: unknown; exitDaemonWhenClosed?: unknown; umbilical?: unknown } }>('/client/sessions', async (request, reply) => {
    const body = request.body ?? {}
    const client = stringParam(body.client)
    const version = stringParam(body.version)
    if (!client || !version) return badRequest(reply, 'client and version are required')
    if (body.exitDaemonWhenClosed !== undefined && typeof body.exitDaemonWhenClosed !== 'boolean') {
      return badRequest(reply, 'exitDaemonWhenClosed must be a boolean')
    }
    if (body.umbilical !== undefined && typeof body.umbilical !== 'boolean') return badRequest(reply, 'umbilical must be a boolean')
    return send(reply, () => reply.code(201).send(sessions.create({ client, version, exitDaemonWhenClosed: body.exitDaemonWhenClosed === true, umbilical: body.umbilical === true })))
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
const AGENT_INBOX = /^\/agents\/([^/?]+)\/inbox(?:\?|$)/
const BRING_HOME = /^\/registry\/agents\/[^/?]+\/bring-home(?:\?|$)/
const TEMPLATES = /^\/templates(?:[/?]|$)/

function observeRouteProducers(server: FastifyInstance, ctx: DaemonRouteContext, sessions: ClientSessionRegistry): void {
  // A write to /agents/:id/* that names its client session: the route
  // handler's synchronous part (where it calls the RuntimeService write, which
  // raises config_changed / file_updated synchronously) runs inside this
  // hook's done(), within runAsClientWrite, so those echo frames skip that
  // session. Nothing the request queues (a turn, a timer, a startup turn)
  // inherits the stamp. This MUST stay the last preHandler hook, so done()
  // calls the handler itself (W2-A's async guard is registered before it).
  server.addHook('preHandler', (request, _reply, done) => {
    const sessionId = clientSessionOf(request.headers)
    if (sessionId && sessions.has(sessionId) && request.method !== 'GET' && request.method !== 'HEAD' && AGENT_ROUTE.test(request.url)) {
      runAsClientWrite(sessionId, () => done())
      return
    }
    done()
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
      if (document) {
        // What an agent's own fs_write of document.md raises (agent-executor),
        // so every other client refreshes through the same renderer path.
        const ref = ctx.runtime.getAgentOrDocument(decodeSegment(document[1]))
        const content = (request.body as { content?: unknown } | undefined)?.content
        if (ref && typeof content === 'string') {
          const origin = clientSessionOf(request.headers)
          sessions.publishExecutor({ agentId: ref.id, filePath: ref.filePath ?? null, event: { type: 'document_updated', payload: { content }, timestamp: Date.now() } }, origin && sessions.has(origin) ? origin : null)
        }
      } else if (inbox) {
        const ref = ctx.runtime.getAgentOrDocument(decodeSegment(inbox[1]))
        if (ref) sessions.publishPush('inbox', { inbox: { version: 1, messages: [] } }, { agentId: ref.id, filePath: ref.filePath ?? null })
      } else if (request.method === 'POST' && BRING_HOME.test(url)) {
        const result = parseJson(payload) as { success?: unknown; filePath?: unknown } | null
        if (result?.success === true && typeof result.filePath === 'string') sessions.publishPush('adf_file_created', { filePath: result.filePath })
      } else if (TEMPLATES.test(url)) {
        sessions.publishPush('templates', {})
      }
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
