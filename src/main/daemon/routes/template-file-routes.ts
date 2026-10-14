// A template's extra files as raw bytes (tracker W3-A; Studio's TEMPLATE_ADD_FILES):
//
//   POST /templates/:id/files/plan       { files: [{ name, isFile, size } | { name, statError }] }:
//                                        the names a picked batch gets, or the refusal
//                                        (whole batch or nothing, as Studio's addFiles)
//   PUT /templates/:id/files/raw?name=   octet-stream body: one host file, any
//                                        type, up to TEMPLATE_EXTRA_FILE_MAX_BYTES
//
// A client plans the whole batch first and uploads only when the plan
// passes, so a refusal never leaves part of a batch written.
// PUT /templates/:id/files takes text in a 1 MiB JSON body, so a picked image
// or PDF cannot travel there. This route stores the bytes under the file's
// base name, numbered past a name the template already uses (`report-2.pdf`),
// exactly as Studio's own picker does (AgentTemplatesService.addFileBuffer),
// and answers the path it chose.

import type { FastifyInstance, FastifyReply } from 'fastify'
import { TEMPLATE_EXTRA_FILE_MAX_BYTES } from '../../../shared/utils/agent-template'
import type { TemplateAddFileItem } from '../../adf/agent-templates'
import { closeAfterResponse } from './file-routes'
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

function planItems(body: unknown): TemplateAddFileItem[] | null {
  const files = (body as { files?: unknown } | null)?.files
  if (!Array.isArray(files) || files.length === 0 || files.length > 1000) return null
  const out: TemplateAddFileItem[] = []
  for (const f of files) {
    if (!f || typeof f !== 'object') return null
    const { name, isFile, size, statError } = f as Record<string, unknown>
    if (typeof name !== 'string' || name.trim() === '' || name.length > 255) return null
    if (typeof statError === 'string') out.push({ name, statError })
    else if (typeof isFile === 'boolean' && typeof size === 'number' && size >= 0) out.push({ name, isFile, size })
    else return null
  }
  return out
}

export function registerTemplateFileRoutes(server: FastifyInstance, ctx: DaemonRouteContext): void {
  server.post<{ Params: { id: string }; Body: unknown }>('/templates/:id/files/plan', async (request, reply) => {
    const factory = ctx.options.agentFactory
    if (!factory) return reply.code(503).send({ error: 'Agent creation is not configured on this daemon.' })
    const items = planItems(request.body)
    if (!items) return reply.code(400).send({ error: 'files must list each picked file as { name, isFile, size } or { name, statError }', code: 'bad_request' })
    try {
      factory.requireIdentity()
      factory.existingTemplateFile(request.params.id)
      return factory.templatesService().planAddFiles(request.params.id, items)
    } catch (err) {
      return sendError(reply, err)
    }
  })

  // The body arrives as the request stream: file-routes.ts's octet-stream
  // parser lists this route among its streaming routes (STREAM_ROUTES).
  server.put<{ Params: { id: string }; Querystring: { name?: string } }>('/templates/:id/files/raw', async (request, reply) => {
    // Every refusal before the body is read answers, then closes the
    // connection: the unread upload is never consumed (file-routes.ts).
    let bodyRead = false
    const refuse = (code: number, body: Record<string, unknown>) => {
      if (!bodyRead) closeAfterResponse(request, reply)
      return reply.code(code).send(body)
    }
    const factory = ctx.options.agentFactory
    if (!factory) return refuse(503, { error: 'Agent creation is not configured on this daemon.' })
    const name = request.query.name
    if (typeof name !== 'string' || name.trim() === '' || name.length > 255 || name.includes('\0')) {
      return refuse(400, { error: 'name (the file name) is required', code: 'bad_request' })
    }
    if (String(request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== OCTET_STREAM) {
      return refuse(415, { error: 'Send the file as the request body with Content-Type: application/octet-stream', code: 'unsupported_media_type' })
    }
    const declared = Number(request.headers['content-length'])
    if (Number.isFinite(declared) && declared > TEMPLATE_EXTRA_FILE_MAX_BYTES) {
      const mb = Math.round(TEMPLATE_EXTRA_FILE_MAX_BYTES / (1024 * 1024))
      return refuse(413, { error: `${name.trim()} is larger than ${mb} MB.`, code: 'too_large', maxBytes: TEMPLATE_EXTRA_FILE_MAX_BYTES })
    }
    try {
      factory.requireIdentity()
      factory.existingTemplateFile(request.params.id)
      const bytes = await readCapped(request.body, TEMPLATE_EXTRA_FILE_MAX_BYTES)
      bodyRead = true
      const added = factory.templatesService().addFileBuffer(request.params.id, name.trim(), bytes)
      if (!added.success || !added.path) {
        const message = added.error || 'The file was refused.'
        const missing = /not in the templates folder|Unknown template/.test(message)
        return reply.code(missing ? 404 : 400).send({ error: message, code: missing ? 'template_missing' : 'template_invalid' })
      }
      return { id: request.params.id, path: added.path, size: bytes.length, success: true }
    } catch (err) {
      if (!bodyRead) closeAfterResponse(request, reply)
      return sendError(reply, err)
    }
  })
}
