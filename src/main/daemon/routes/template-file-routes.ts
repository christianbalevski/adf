// A template's extra file as raw bytes (tracker W3-A; Studio's TEMPLATE_ADD_FILES):
//
//   PUT /templates/:id/files/raw?name=   octet-stream body: one host file, any
//                                        type, up to TEMPLATE_EXTRA_FILE_MAX_BYTES
//
// PUT /templates/:id/files takes text in a 1 MiB JSON body, so a picked image
// or PDF cannot travel there. This route stores the bytes under the file's
// base name, numbered past a name the template already uses (`report-2.pdf`),
// exactly as Studio's own picker does (AgentTemplatesService.addFileBuffer),
// and answers the path it chose.

import type { FastifyInstance, FastifyReply } from 'fastify'
import { TEMPLATE_EXTRA_FILE_MAX_BYTES } from '../../../shared/utils/agent-template'
import { AgentCreateError } from '../daemon-agent-factory'
import { DaemonIdentityError } from '../daemon-identity'
import { FileOpError, readCapped } from '../file-ops'
import type { DaemonRouteContext } from './index'

const OCTET_STREAM = 'application/octet-stream'

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof DaemonIdentityError) return reply.code(err.httpStatus).send({ error: err.message, code: err.code })
  if (err instanceof AgentCreateError) return reply.code(err.httpStatus).send({ error: err.message, code: err.code })
  if (err instanceof FileOpError) return reply.code(err.statusCode).send({ ...(err.details ?? {}), error: err.message, code: err.code })
  return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) })
}

export function registerTemplateFileRoutes(server: FastifyInstance, ctx: DaemonRouteContext): void {
  // The body arrives as the request stream: file-routes.ts's octet-stream
  // parser lists this route among its streaming routes (STREAM_ROUTES).
  server.put<{ Params: { id: string }; Querystring: { name?: string } }>('/templates/:id/files/raw', async (request, reply) => {
    const factory = ctx.options.agentFactory
    if (!factory) return reply.code(503).send({ error: 'Agent creation is not configured on this daemon.' })
    const name = request.query.name
    if (typeof name !== 'string' || name.trim() === '' || name.length > 255 || name.includes('\0')) {
      return reply.code(400).send({ error: 'name (the file name) is required', code: 'bad_request' })
    }
    if (String(request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== OCTET_STREAM) {
      return reply.code(415).send({ error: 'Send the file as the request body with Content-Type: application/octet-stream', code: 'unsupported_media_type' })
    }
    const declared = Number(request.headers['content-length'])
    if (Number.isFinite(declared) && declared > TEMPLATE_EXTRA_FILE_MAX_BYTES) {
      const mb = Math.round(TEMPLATE_EXTRA_FILE_MAX_BYTES / (1024 * 1024))
      return reply.code(413).send({ error: `${name.trim()} is larger than ${mb} MB.`, code: 'too_large', maxBytes: TEMPLATE_EXTRA_FILE_MAX_BYTES })
    }
    try {
      factory.requireIdentity()
      factory.existingTemplateFile(request.params.id)
      const bytes = await readCapped(request.body, TEMPLATE_EXTRA_FILE_MAX_BYTES)
      const added = factory.templatesService().addFileBuffer(request.params.id, name.trim(), bytes)
      if (!added.success || !added.path) {
        const message = added.error || 'The file was refused.'
        const missing = /not in the templates folder|Unknown template/.test(message)
        return reply.code(missing ? 404 : 400).send({ error: message, code: missing ? 'template_missing' : 'template_invalid' })
      }
      return { id: request.params.id, path: added.path, size: bytes.length, success: true }
    } catch (err) {
      return sendError(reply, err)
    }
  })
}
