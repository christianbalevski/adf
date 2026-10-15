// K12 (design daemon-backend.md §5.3 "Fallback"): the owner trusts, or stops
// trusting, this daemon's key on a machine without a usable OS keychain.
//
//   POST /identity/trust-daemon     {confirm: true}
//   POST /identity/untrust-daemon
//
// Both are explicit owner actions (`adf identity trust-daemon`,
// `adf identity untrust-daemon`), never automatic. Local callers only, and
// always with this run's local proof, as owner import: a trusted key lets
// ADF Studio wrap every agent's credentials to the daemon's key file. Trust
// is refused when the daemon reads the OS keychain and without the owner key.
// The grant is an entry in the settings file (`trustedDaemonEncKeys`), not a
// signed statement. Loaded agents get (or lose) their slot at once; other
// agents when this daemon or Studio next opens them. Untrust also rotates the
// daemon's key (the old one is no longer used) and sweeps the tracked
// folders in the background for slots of the revoked key.

import type { FastifyInstance, FastifyReply } from 'fastify'
import { DaemonIdentityError } from '../daemon-identity'
import { requireLocalCaller } from '../identity-routes'
import { requireLocalProof } from './identity-import-routes'
import type { DaemonRouteContext } from './index'

const OWNER_ACTION = 'Trusting this daemon\'s key is an owner action and can be done'
const PROOF_REFUSAL = 'Trusting or revoking this daemon\'s key needs this machine\'s local proof (X-ADF-Local-Proof, read from the daemon-local-proof file next to the daemon settings). Run adf identity trust-daemon on the daemon host.'

/** What trusting means, for the confirm (CLI) and the refusal without it. */
export const TRUST_DAEMON_CONSEQUENCE =
  'Trusting this daemon adds its key (the runtime-enc-key file next to the daemon settings) to trustedDaemonEncKeys. ' +
  'ADF Studio then wraps every agent\'s credentials to that key, so anyone who can read that file, or write the settings file, can unlock them ' +
  'without the owner passphrase. The grant is an entry in the settings file, not a signed statement. Revoke it with adf identity untrust-daemon.'

export function registerIdentityTrustRoutes(server: FastifyInstance, ctx: DaemonRouteContext): void {
  const applyToLoaded = (): number => {
    const identity = ctx.options.identity
    if (!identity) return 0
    let changed = 0
    for (const ref of ctx.runtime.listAgents()) {
      const workspace = ctx.runtime.getLoadedAgent(ref.id)?.agent.workspace
      if (!workspace) continue
      try {
        if (identity.applyTrustToLoadedAgent(workspace)) changed++
      } catch (err) {
        console.warn(`[ADF Daemon] Trusted-daemon slot of ${ref.name}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return changed
  }

  server.post<{ Body: { confirm?: unknown } | undefined }>('/identity/trust-daemon', async (request, reply) => {
    const identity = ctx.options.identity
    if (!identity) return reply.code(503).send({ error: 'Owner identity is not configured on this daemon.' })
    if (!requireLocalCaller(request, reply, ctx.localAccess, OWNER_ACTION)) return reply
    if (!requireLocalProof(request, reply, ctx.localAccess.localProof ?? null, PROOF_REFUSAL)) return reply
    if (request.body?.confirm !== true) {
      return reply.code(400).send({ error: `${TRUST_DAEMON_CONSEQUENCE} Send {"confirm": true} to go ahead.`, code: 'confirm_required' })
    }
    try {
      const trust = identity.trustDaemon()
      return { trust, agentsUpdated: applyToLoaded() }
    } catch (err) {
      return sendError(reply, err)
    }
  })

  server.post('/identity/untrust-daemon', async (request, reply) => {
    const identity = ctx.options.identity
    if (!identity) return reply.code(503).send({ error: 'Owner identity is not configured on this daemon.' })
    if (!requireLocalCaller(request, reply, ctx.localAccess, OWNER_ACTION)) return reply
    if (!requireLocalProof(request, reply, ctx.localAccess.localProof ?? null, PROOF_REFUSAL)) return reply
    try {
      const { retiredLabel, ...trust } = identity.untrustDaemon()
      const agentsUpdated = applyToLoaded()
      // Tracked agents that are not loaded: in the background, one file per macrotask.
      const loaded = new Set(ctx.runtime.listAgents().map((ref) => ref.filePath).filter((p): p is string => !!p))
      void identity.sweepRevokedSlots(loaded).catch((err) => console.error('[ADF Daemon] Revoked-slot sweep failed:', err instanceof Error ? err.message : err))
      return { trust, retiredLabel, agentsUpdated, sweep: 'started' }
    } catch (err) {
      return sendError(reply, err)
    }
  })
}

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof DaemonIdentityError) return reply.code(err.httpStatus).send({ error: err.message, code: err.code })
  return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) })
}
