/**
 * Agent template management (registered by createDaemonHttpApi next to the
 * identity routes). The same AgentTemplatesService Studio's Settings >
 * Agent templates tab uses, over the same `<userData>/templates` folder:
 * create (blank or a duplicate), rename, notes, default, reset a shipped
 * template, delete (into `<userData>/templates-trash`, never a hard delete),
 * contents (config, seed files, extra files) and the per-template review.
 *
 * GET /templates (the list) lives in identity-routes.ts. Every route needs the
 * owner identity (409 identity_not_ready otherwise), like the list.
 */

import type { FastifyInstance, FastifyReply } from 'fastify'
import type { AgentConfig } from '../../shared/types/adf-v02.types'
import type { AgentTemplateSummary } from '../../shared/types/ipc.types'
import { DaemonIdentityError } from './daemon-identity'
import { AgentCreateError, templatesTrashDir, type DaemonAgentFactory } from './daemon-agent-factory'

export interface TemplateRouteDeps {
  agentFactory?: DaemonAgentFactory
}

type IdParams = { Params: { id: string } }

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof DaemonIdentityError) return reply.code(err.httpStatus).send({ error: err.message, code: err.code })
  if (err instanceof AgentCreateError) {
    return reply.code(err.httpStatus).send({ error: err.message, code: err.code, ...(err.identity ? { identity: err.identity } : {}) })
  }
  return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) })
}

/** A service `{ success: false, error }` as a 400 (404 when the file is gone). */
function refused(reply: FastifyReply, error: string | undefined) {
  const message = error || 'The template was refused.'
  const missing = /not in the templates folder|Unknown template/.test(message)
  return reply.code(missing ? 404 : 400).send({ error: message, code: missing ? 'template_missing' : 'template_invalid' })
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function registerTemplateRoutes(server: FastifyInstance, deps: TemplateRouteDeps): void {
  const factory = (reply: FastifyReply): DaemonAgentFactory | null => {
    if (deps.agentFactory) return deps.agentFactory
    void reply.code(503).send({ error: 'Agent creation is not configured on this daemon.' })
    return null
  }
  const summaryOf = (f: DaemonAgentFactory, id: string): AgentTemplateSummary | undefined =>
    f.listTemplates().templates.find((t) => t.id === id)

  server.post<{ Body: { name?: unknown; fromId?: unknown } | undefined }>('/templates', async (request, reply) => {
    const f = factory(reply)
    if (!f) return reply
    const body = request.body
    if (!isObject(body) || typeof body.name !== 'string') return reply.code(400).send({ error: 'name is required', code: 'bad_request' })
    if (body.fromId !== undefined && typeof body.fromId !== 'string') return reply.code(400).send({ error: 'fromId must be a string', code: 'bad_request' })
    try {
      f.requireIdentity()
      const made = await f.templatesService().create({ name: body.name, ...(body.fromId !== undefined ? { fromId: body.fromId as string } : {}) })
      if (!made.success || !made.id) return refused(reply, made.error)
      return reply.code(201).send({ id: made.id, template: summaryOf(f, made.id) ?? null })
    } catch (err) {
      return sendError(reply, err)
    }
  })

  server.get<IdParams>('/templates/:id', async (request, reply) => {
    const f = factory(reply)
    if (!f) return reply
    try {
      f.requireIdentity()
      const id = request.params.id
      f.existingTemplateFile(id)
      const list = f.listTemplates()
      const contents = f.templatesService().getContents(id)
      if (!contents.success || !contents.contents) return refused(reply, contents.error)
      return {
        template: list.templates.find((t) => t.id === id) ?? null,
        isDefault: list.defaultId === id,
        defaultId: list.defaultId,
        contents: contents.contents,
      }
    } catch (err) {
      return sendError(reply, err)
    }
  })

  server.patch<IdParams & { Body: { name?: unknown; description?: unknown; warning?: unknown } | undefined }>('/templates/:id', async (request, reply) => {
    const f = factory(reply)
    if (!f) return reply
    const body = request.body
    if (!isObject(body)) return reply.code(400).send({ error: 'Request body must be a JSON object.', code: 'bad_request' })
    for (const key of ['name', 'description', 'warning'] as const) {
      if (body[key] !== undefined && typeof body[key] !== 'string') return reply.code(400).send({ error: `${key} must be a string`, code: 'bad_request' })
    }
    try {
      f.requireIdentity()
      let id = request.params.id
      f.existingTemplateFile(id)
      const service = f.templatesService()
      if (body.description !== undefined || body.warning !== undefined) {
        const noted = service.setMeta({ id, description: body.description as string | undefined, warning: body.warning as string | undefined })
        if (!noted.success) return refused(reply, noted.error)
      }
      if (typeof body.name === 'string') {
        const current = summaryOf(f, id)
        if (body.name.trim() !== current?.name) {
          const renamed = service.rename({ id, name: body.name })
          if (!renamed.success || !renamed.id) return refused(reply, renamed.error)
          id = renamed.id
        }
      }
      return { id, template: summaryOf(f, id) ?? null }
    } catch (err) {
      return sendError(reply, err)
    }
  })

  server.delete<IdParams>('/templates/:id', async (request, reply) => {
    const f = factory(reply)
    if (!f) return reply
    try {
      f.requireIdentity()
      const id = request.params.id
      f.existingTemplateFile(id)
      const done = await f.templatesService().delete(id)
      if (!done.success) return refused(reply, done.error)
      return { deleted: true, id, trashFolder: templatesTrashDir(), defaultId: f.templatesService().defaultTemplateId() }
    } catch (err) {
      return sendError(reply, err)
    }
  })

  server.post<IdParams>('/templates/:id/default', async (request, reply) => {
    const f = factory(reply)
    if (!f) return reply
    try {
      f.requireIdentity()
      f.existingTemplateFile(request.params.id)
      const done = f.templatesService().setDefault(request.params.id)
      if (!done.success) return refused(reply, done.error)
      return { defaultId: request.params.id }
    } catch (err) {
      return sendError(reply, err)
    }
  })

  server.post<IdParams>('/templates/:id/reset', async (request, reply) => {
    const f = factory(reply)
    if (!f) return reply
    try {
      f.requireIdentity()
      const id = request.params.id
      f.existingTemplateFile(id)
      const shipped = summaryOf(f, id)?.shipped
      if (!shipped) return reply.code(400).send({ error: `"${id}" is not a shipped template.`, code: 'template_invalid' })
      const done = f.templatesService().resetShipped(shipped)
      if (!done.success) return refused(reply, done.error)
      return { id, template: summaryOf(f, id) ?? null }
    } catch (err) {
      return sendError(reply, err)
    }
  })

  server.get<IdParams>('/templates/:id/review', async (request, reply) => {
    const f = factory(reply)
    if (!f) return reply
    try {
      return { id: request.params.id, ...f.templateReview(request.params.id) }
    } catch (err) {
      return sendError(reply, err)
    }
  })

  server.post<IdParams & { Body: { password?: unknown } | undefined }>('/templates/:id/review/accept', async (request, reply) => {
    const f = factory(reply)
    if (!f) return reply
    const password = isObject(request.body) && typeof request.body.password === 'string' ? request.body.password : undefined
    try {
      f.acceptTemplateReview(request.params.id, password)
      return { id: request.params.id, reviewed: true, template: summaryOf(f, request.params.id) ?? null }
    } catch (err) {
      return sendError(reply, err)
    }
  })

  server.put<IdParams & { Body: { config?: unknown } | undefined }>('/templates/:id/config', async (request, reply) => {
    const f = factory(reply)
    if (!f) return reply
    const config = isObject(request.body) ? request.body.config : undefined
    if (!isObject(config)) return reply.code(400).send({ error: 'config (an object) is required', code: 'bad_request' })
    try {
      f.requireIdentity()
      f.existingTemplateFile(request.params.id)
      const done = f.templatesService().setConfig({ id: request.params.id, config: config as unknown as AgentConfig })
      if (!done.success) return refused(reply, done.error)
      return { id: request.params.id, success: true }
    } catch (err) {
      return sendError(reply, err)
    }
  })

  server.put<IdParams & { Body: { path?: unknown; content?: unknown } | undefined }>('/templates/:id/files', async (request, reply) => {
    const f = factory(reply)
    if (!f) return reply
    const body = isObject(request.body) ? request.body : {}
    if (typeof body.path !== 'string' || typeof body.content !== 'string') {
      return reply.code(400).send({ error: 'path and content (strings) are required', code: 'bad_request' })
    }
    try {
      f.requireIdentity()
      f.existingTemplateFile(request.params.id)
      const done = f.templatesService().setFile({ id: request.params.id, path: body.path, content: body.content })
      if (!done.success) return refused(reply, done.error)
      return { id: request.params.id, path: body.path.trim(), success: true }
    } catch (err) {
      return sendError(reply, err)
    }
  })

  server.delete<IdParams & { Querystring: { path?: string } }>('/templates/:id/files', async (request, reply) => {
    const f = factory(reply)
    if (!f) return reply
    const path = request.query.path
    if (!path) return reply.code(400).send({ error: 'path is required', code: 'bad_request' })
    try {
      f.requireIdentity()
      f.existingTemplateFile(request.params.id)
      const done = f.templatesService().removeFile({ id: request.params.id, path })
      if (!done.success) return refused(reply, done.error)
      return { id: request.params.id, path, success: true }
    } catch (err) {
      return sendError(reply, err)
    }
  })
}
