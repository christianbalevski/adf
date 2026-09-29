/**
 * Owner identity + agent creation routes (registered by createDaemonHttpApi).
 *
 * Secret-moving and state-changing identity routes (create returns the
 * phrase; restore/unlock take the phrase or passphrase; lock; confirm-backup)
 * answer loopback callers only, on top of the daemon's bearer-token auth. The phrase appears in exactly one response body
 * (POST /identity/create) and nowhere else: not in status, errors, logs, or
 * events.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { DaemonIdentityError, type DaemonIdentity } from './daemon-identity'
import { AgentCreateError, type CreateAgentInput, type DaemonAgentFactory } from './daemon-agent-factory'
import { isLoopbackAddress, localAccessRefusal, type LocalAccessOptions } from './local-access'

const OWNER_SECRETS = 'Owner identity secrets can be handled'

export interface IdentityRouteDeps {
  identity?: DaemonIdentity
  agentFactory?: DaemonAgentFactory
  /** Proxy mode + local proof for the local-only routes (local-access.ts). */
  localAccess?: LocalAccessOptions
}

export { isLoopbackAddress }

/** Local-only routes (local-access.ts): false = a 403 `loopback_only` was sent. */
export function requireLocalCaller(request: FastifyRequest, reply: FastifyReply, opts: LocalAccessOptions, what: string): boolean {
  const refusal = localAccessRefusal({ remoteAddress: request.socket?.remoteAddress, headers: request.headers }, opts)
  if (!refusal) return true
  void reply.code(403).send({
    error: `${what} only from this machine: ${refusal}. Run the adf command on the daemon host, against the daemon's own loopback address (not through a proxy or tunnel).`,
    code: 'loopback_only',
  })
  return false
}

function unavailable(reply: FastifyReply) {
  return reply.code(503).send({ error: 'Owner identity is not configured on this daemon.' })
}

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof DaemonIdentityError) {
    return reply.code(err.httpStatus).send({ error: err.message, code: err.code })
  }
  if (err instanceof AgentCreateError) {
    return reply.code(err.httpStatus).send({
      error: err.message,
      code: err.code,
      ...(err.identity ? { identity: err.identity } : {}),
    })
  }
  // Generic failures: the message only (never request data — bodies here hold secrets).
  return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) })
}

function bodyString(body: unknown, key: string): string | undefined {
  if (!body || typeof body !== 'object') return undefined
  const value = (body as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : undefined
}

export function registerIdentityRoutes(server: FastifyInstance, deps: IdentityRouteDeps): void {
  server.get('/identity', async (_request, reply) => {
    if (!deps.identity) return unavailable(reply)
    try {
      return deps.identity.status()
    } catch (err) {
      return sendError(reply, err)
    }
  })

  server.post('/identity/create', async (request, reply) => {
    if (!deps.identity) return unavailable(reply)
    if (!requireLocalCaller(request, reply, deps.localAccess ?? {}, OWNER_SECRETS)) return reply
    try {
      const { mnemonic, identity } = deps.identity.create({ passphrase: bodyString(request.body, 'passphrase') })
      // Shown once: the daemon never returns the phrase again.
      return reply.code(201).header('Cache-Control', 'no-store').send({ mnemonic, words: mnemonic.split(' '), identity })
    } catch (err) {
      return sendError(reply, err)
    }
  })

  server.post('/identity/restore', async (request, reply) => {
    if (!deps.identity) return unavailable(reply)
    if (!requireLocalCaller(request, reply, deps.localAccess ?? {}, OWNER_SECRETS)) return reply
    const mnemonic = bodyString(request.body, 'mnemonic')
    if (!mnemonic) return reply.code(400).send({ error: 'mnemonic is required', code: 'invalid_mnemonic' })
    try {
      return { identity: deps.identity.restore({ mnemonic, passphrase: bodyString(request.body, 'passphrase') }) }
    } catch (err) {
      return sendError(reply, err)
    }
  })

  server.post('/identity/unlock', async (request, reply) => {
    if (!deps.identity) return unavailable(reply)
    if (!requireLocalCaller(request, reply, deps.localAccess ?? {}, OWNER_SECRETS)) return reply
    try {
      return { identity: deps.identity.unlock(bodyString(request.body, 'passphrase') ?? '') }
    } catch (err) {
      return sendError(reply, err)
    }
  })

  server.post('/identity/lock', async (request, reply) => {
    if (!deps.identity) return unavailable(reply)
    if (!requireLocalCaller(request, reply, deps.localAccess ?? {}, OWNER_SECRETS)) return reply
    try {
      return { identity: deps.identity.lock() }
    } catch (err) {
      return sendError(reply, err)
    }
  })

  server.post('/identity/confirm-backup', async (request, reply) => {
    if (!deps.identity) return unavailable(reply)
    if (!requireLocalCaller(request, reply, deps.localAccess ?? {}, OWNER_SECRETS)) return reply
    try {
      return { identity: deps.identity.confirmBackup() }
    } catch (err) {
      return sendError(reply, err)
    }
  })

  server.get('/templates', async (_request, reply) => {
    if (!deps.agentFactory) return reply.code(503).send({ error: 'Agent creation is not configured on this daemon.' })
    try {
      const list = deps.agentFactory.listTemplates()
      return { templates: list.templates, defaultId: list.defaultId, folder: list.folder, defaultDirectory: deps.agentFactory.defaultDirectory() }
    } catch (err) {
      return sendError(reply, err)
    }
  })

  server.post<{ Body: CreateAgentInput | undefined }>('/agents/create', async (request, reply) => {
    if (!deps.agentFactory) return reply.code(503).send({ error: 'Agent creation is not configured on this daemon.' })
    const body = request.body
    if (body !== undefined && body !== null && (typeof body !== 'object' || Array.isArray(body))) {
      return reply.code(400).send({ error: 'Request body must be a JSON object.', code: 'bad_request' })
    }
    for (const key of ['name', 'directory', 'template', 'provider', 'model'] as const) {
      const value = body?.[key]
      if (value !== undefined && typeof value !== 'string') {
        return reply.code(400).send({ error: `${key} must be a string`, code: 'bad_request' })
      }
    }
    if (body?.start !== undefined && typeof body.start !== 'boolean') {
      return reply.code(400).send({ error: 'start must be a boolean', code: 'bad_request' })
    }
    try {
      const created = await deps.agentFactory.create(body ?? {})
      return reply.code(201).send(created)
    } catch (err) {
      return sendError(reply, err)
    }
  })
}
