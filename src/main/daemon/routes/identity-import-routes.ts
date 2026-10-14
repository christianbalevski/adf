// Owner import (design daemon-backend.md §5.4): Studio's "Import identity"
// against the daemon, and `adf identity import`.
//
//   POST /identity/import   {mnemonic, passphrase?, switchOwner?}
//
// Local callers only, like the other routes that take the phrase. The phrase
// is never echoed, logged or put in an error. A phrase of another owner needs
// `switchOwner: true` (409 `switch_unconfirmed` names both DIDs otherwise).
// Loaded agents are unloaded before the restamp rewrites their files and
// loaded again after it; each step is logged and listed in the response.

import type { FastifyInstance } from 'fastify'
import { DaemonIdentityError } from '../daemon-identity'
import { requireLocalCaller } from '../identity-routes'
import type { DaemonRouteContext } from './index'

const OWNER_SECRETS = 'Owner identity secrets can be handled'

interface ImportBody {
  mnemonic?: unknown
  passphrase?: unknown
  switchOwner?: unknown
}

export function registerIdentityImportRoutes(server: FastifyInstance, ctx: DaemonRouteContext): void {
  server.post<{ Body: ImportBody | undefined }>('/identity/import', async (request, reply) => {
    const identity = ctx.options.identity
    if (!identity) return reply.code(503).send({ error: 'Owner identity is not configured on this daemon.' })
    if (!requireLocalCaller(request, reply, ctx.localAccess, OWNER_SECRETS)) return reply
    const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body) ? request.body : {}
    if (typeof body.mnemonic !== 'string' || !body.mnemonic) {
      return reply.code(400).send({ error: 'mnemonic is required', code: 'invalid_mnemonic' })
    }
    if (body.passphrase !== undefined && typeof body.passphrase !== 'string') {
      return reply.code(400).send({ error: 'passphrase must be a string', code: 'bad_request' })
    }
    if (body.switchOwner !== undefined && typeof body.switchOwner !== 'boolean') {
      return reply.code(400).send({ error: 'switchOwner must be a boolean', code: 'bad_request' })
    }
    const input = { mnemonic: body.mnemonic, passphrase: body.passphrase as string | undefined, switchOwner: body.switchOwner as boolean | undefined }

    let plan: { ownerDid: string; previousOwnerDid: string | null }
    try {
      plan = identity.checkImport(input)
    } catch (err) {
      return sendImportError(reply, err)
    }

    // Unload file-backed agents so the restamp is the only writer of their
    // identity rows, then load them again on the new identity.
    const loaded = ctx.runtime.listAgents().filter((agent) => agent.filePath)
    const unloaded: Array<{ agentId: string; name: string; filePath: string }> = []
    for (const agent of loaded) {
      console.log(`[ADF Daemon] Owner import: unloading ${agent.name} (${agent.filePath}) for the restamp`)
      try {
        await ctx.runtime.unloadAgent(agent.id)
        unloaded.push({ agentId: agent.id, name: agent.name, filePath: agent.filePath! })
      } catch (err) {
        console.error(`[ADF Daemon] Owner import: could not unload ${agent.name}:`, err instanceof Error ? err.message : err)
      }
    }

    let result: ReturnType<typeof identity.importOwner> | null = null
    let failure: unknown = null
    try {
      result = identity.importOwner(input)
    } catch (err) {
      failure = err
    }

    const reloaded: Array<{ agentId: string; name: string; filePath: string }> = []
    const reloadFailures: Array<{ name: string; filePath: string; error: string }> = []
    for (const agent of unloaded) {
      try {
        const ref = await ctx.runtime.loadAgent(agent.filePath)
        reloaded.push({ agentId: ref.id, name: agent.name, filePath: agent.filePath })
        console.log(`[ADF Daemon] Owner import: reloaded ${agent.name}`)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        reloadFailures.push({ name: agent.name, filePath: agent.filePath, error: message })
        console.error(`[ADF Daemon] Owner import: could not reload ${agent.name} (${agent.filePath}): ${message}`)
      }
    }

    if (failure || !result) return sendImportError(reply, failure)
    return reply.header('Cache-Control', 'no-store').send({
      identity: result.identity,
      ownerDid: plan.ownerDid,
      previousOwnerDid: result.previousOwnerDid,
      switched: result.previousOwnerDid !== null && result.previousOwnerDid !== plan.ownerDid,
      restamp: result.restamp,
      reloaded,
      reloadFailures,
    })
  })
}

function sendImportError(reply: import('fastify').FastifyReply, err: unknown) {
  if (err instanceof DaemonIdentityError) return reply.code(err.httpStatus).send({ error: err.message, code: err.code })
  // Generic failures: the message only (never request data — the body holds the phrase).
  return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) })
}
