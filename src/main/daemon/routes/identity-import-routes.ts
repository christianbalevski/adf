// Owner import (design daemon-backend.md §5.4): Studio's "Import identity"
// against the daemon, and `adf identity import`.
//
//   POST /identity/import   {mnemonic, passphrase?, switchOwner?, previousOwnerBackupConfirmed?}
//
// Local callers only, and ALWAYS with this run's local proof
// (X-ADF-Local-Proof from <settings dir>/daemon-local-proof), not only in
// proxy mode: the route can replace the machine's owner. The phrase is never
// echoed, logged or put in an error. Everything that can refuse the import
// (phrase, switch and backup confirmations, the file-storage passphrase) is
// checked before any agent is touched. Imports run one at a time; loaded
// agents are unloaded before the restamp and loaded again after it, and an
// agent that was loaded while the import ran is cycled too. Each step is
// logged and listed in the response.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { DaemonIdentityError, type DaemonOwnerImportOptions } from '../daemon-identity'
import { requireLocalCaller } from '../identity-routes'
import { LOCAL_PROOF_HEADER } from '../local-access'
import { tokensEqual } from '../daemon-token'
import type { DaemonRouteContext } from './index'

const OWNER_SECRETS = 'Owner identity secrets can be handled'

interface ImportBody {
  mnemonic?: unknown
  passphrase?: unknown
  switchOwner?: unknown
  previousOwnerBackupConfirmed?: unknown
}

interface AgentRef { agentId: string; name: string; filePath: string }

export function registerIdentityImportRoutes(server: FastifyInstance, ctx: DaemonRouteContext): void {
  // One import at a time (the restamp and the unload/reload cycle are not re-entrant).
  let queue: Promise<unknown> = Promise.resolve()
  const serialized = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task)
    queue = run.catch(() => {})
    return run
  }

  server.post<{ Body: ImportBody | undefined }>('/identity/import', async (request, reply) => {
    const identity = ctx.options.identity
    if (!identity) return reply.code(503).send({ error: 'Owner identity is not configured on this daemon.' })
    if (!requireLocalCaller(request, reply, ctx.localAccess, OWNER_SECRETS)) return reply
    if (!requireLocalProof(request, reply, ctx.localAccess.localProof ?? null)) return reply
    const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body) ? request.body : {}
    if (typeof body.mnemonic !== 'string' || !body.mnemonic) {
      return reply.code(400).send({ error: 'mnemonic is required', code: 'invalid_mnemonic' })
    }
    if (body.passphrase !== undefined && typeof body.passphrase !== 'string') {
      return reply.code(400).send({ error: 'passphrase must be a string', code: 'bad_request' })
    }
    for (const key of ['switchOwner', 'previousOwnerBackupConfirmed'] as const) {
      if (body[key] !== undefined && typeof body[key] !== 'boolean') {
        return reply.code(400).send({ error: `${key} must be a boolean`, code: 'bad_request' })
      }
    }
    const input: DaemonOwnerImportOptions = {
      mnemonic: body.mnemonic,
      passphrase: body.passphrase as string | undefined,
      switchOwner: body.switchOwner as boolean | undefined,
      previousOwnerBackupConfirmed: body.previousOwnerBackupConfirmed as boolean | undefined,
    }

    return serialized(async () => {
      let plan: { ownerDid: string; previousOwnerDid: string | null }
      try {
        plan = identity.checkImport(input)
      } catch (err) {
        return sendImportError(reply, err)
      }

      // Unload file-backed agents so the restamp is the only writer of their
      // identity rows, then load them again on the new identity.
      const unloaded: AgentRef[] = []
      const unloadAll = async (why: string) => {
        for (const agent of ctx.runtime.listAgents()) {
          if (!agent.filePath) continue
          console.log(`[ADF Daemon] Owner import: unloading ${agent.name} (${agent.filePath}) ${why}`)
          try {
            await ctx.runtime.unloadAgent(agent.id)
            unloaded.push({ agentId: agent.id, name: agent.name, filePath: agent.filePath })
          } catch (err) {
            console.error(`[ADF Daemon] Owner import: could not unload ${agent.name}:`, err instanceof Error ? err.message : err)
          }
        }
      }
      await unloadAll('for the restamp')

      let result: ReturnType<typeof identity.importOwner> | null = null
      let failure: unknown = null
      try {
        result = identity.importOwner(input)
      } catch (err) {
        failure = err
      }
      // A load that finished while agents were being unloaded opened its file
      // on the previous identity: cycle it as well.
      await unloadAll('(it was loaded while the import ran)')

      const reloaded: AgentRef[] = []
      const reloadFailures: Array<{ name: string; filePath: string; error: string }> = []
      const seen = new Set<string>()
      for (const agent of unloaded) {
        if (seen.has(agent.filePath)) continue
        seen.add(agent.filePath)
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
  })
}

/** This route needs the local proof in every mode (requireLocalCaller asks for it only behind a proxy). */
function requireLocalProof(request: FastifyRequest, reply: FastifyReply, localProof: string | null): boolean {
  const raw = request.headers[LOCAL_PROOF_HEADER]
  const presented = (Array.isArray(raw) ? raw[0] : raw)?.trim()
  if (presented && localProof && tokensEqual(presented, localProof)) return true
  void reply.code(403).send({
    error: 'Importing an owner identity needs this machine\'s local proof (X-ADF-Local-Proof, read from the daemon-local-proof file next to the daemon settings). Run adf identity import on the daemon host.',
    code: 'loopback_only',
  })
  return false
}

function sendImportError(reply: FastifyReply, err: unknown) {
  if (err instanceof DaemonIdentityError) return reply.code(err.httpStatus).send({ error: err.message, code: err.code })
  // Generic failures: the message only (never request data — the body holds the phrase).
  return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) })
}
