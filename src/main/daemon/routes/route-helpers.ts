// Small helpers shared by the gap route modules (W1-D). Error bodies follow
// the daemon convention `{ error, code }` (docs/daemon/openapi.json).

import type { FastifyReply } from 'fastify'
import type { RuntimeAgentRef, RuntimeService } from '../../runtime/runtime-service'

export function badRequest(reply: FastifyReply, error: string) {
  return reply.code(400).send({ error, code: 'bad_request' })
}

export function notFound(reply: FastifyReply, error: string) {
  return reply.code(404).send({ error, code: 'not_found' })
}

export function unavailable(reply: FastifyReply, error: string) {
  return reply.code(503).send({ error, code: 'unavailable' })
}

export function serverError(reply: FastifyReply, err: unknown) {
  return reply.code(500).send({ error: err instanceof Error ? err.message : String(err), code: 'internal_error' })
}

/** A loaded agent by id, handle or name (as every /agents/:id route); sends 404 and returns null otherwise. */
export function loadedAgent(runtime: RuntimeService, id: string, reply: FastifyReply): RuntimeAgentRef | null {
  const ref = runtime.getAgent(id)
  if (ref) return ref
  void notFound(reply, `Unknown agent "${id}"`)
  return null
}

/** A query or body value that must be a non-empty string. */
export function stringParam(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** `force`-style query flags: `1`/`true` on, `0`/`false`/absent off, anything else invalid (null). */
export function flagParam(value: unknown): boolean | null {
  if (value === undefined) return false
  if (value === '1' || value === 'true' || value === true) return true
  if (value === '0' || value === 'false' || value === false) return false
  return null
}
