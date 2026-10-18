// One-call reads and the save of an agent's file, for a running agent or an
// open document (design D4; tracker W2-A):
//
//   GET  /agents/:id/header       Studio's DOC_GET_HEADER: document, config, status text
//   GET  /agents/:id/batch        Studio's DOC_GET_BATCH: the header, lastTokens,
//                                 contextBaseline and main's last 200 display entries
//   POST /agents/:id/checkpoint   Studio's FILE_SAVE: fold the WAL into the .adf
//
// Studio calls the header at every main-loop turn end and the batch on every
// file switch, so each is one read instead of four routes.

import type { FastifyInstance, FastifyReply } from 'fastify'
import { RuntimeLoopError } from '../../runtime/runtime-service'
import type { DaemonRouteContext } from './index'
import { notFound, serverError } from './route-helpers'

function fail(reply: FastifyReply, err: unknown) {
  if (err instanceof RuntimeLoopError) return reply.code(err.statusCode).send({ ...(err.details ?? {}), error: err.message, code: err.code ?? 'conflict' })
  return serverError(reply, err)
}

export function registerDocumentRoutes(server: FastifyInstance, ctx: DaemonRouteContext): void {
  const runtime = ctx.runtime
  type Id = { Params: { id: string } }

  server.get<Id>('/agents/:id/header', async (request, reply) => {
    if (!runtime.getAgentOrDocument(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    try { return runtime.getAgentHeader(request.params.id) } catch (err) { return fail(reply, err) }
  })

  server.get<Id>('/agents/:id/batch', async (request, reply) => {
    if (!runtime.getAgentOrDocument(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    try { return runtime.getAgentBatch(request.params.id) } catch (err) { return fail(reply, err) }
  })

  server.post<Id>('/agents/:id/checkpoint', async (request, reply) => {
    if (!runtime.getAgentOrDocument(request.params.id)) return notFound(reply, `Unknown agent "${request.params.id}"`)
    try { return runtime.checkpointAgent(request.params.id) } catch (err) { return fail(reply, err) }
  })
}
