// Per-agent owner-identity actions over the daemon API: attestations, the
// credentials envelope's state and share password, claiming a file under the
// local owner, and identity drafts for the create screen.
//
//   GET    /agents/:id/attestations              IDENTITY_ATTESTATIONS_GET
//   POST   /agents/:id/attestations/reissue      IDENTITY_ATTESTATIONS_REISSUE
//   GET    /agents/:id/envelope                  IDENTITY_ENVELOPE_STATUS
//   PUT    /agents/:id/envelope/share-password   IDENTITY_ENVELOPE_SHARE_SET_PASSWORD { password }
//   DELETE /agents/:id/envelope/share-password   IDENTITY_ENVELOPE_SHARE_REMOVE_PASSWORD
//   POST   /agents/:id/envelope/unlock-password  IDENTITY_ENVELOPE_UNLOCK_PASSWORD { password, adopt? }
//   POST   /agents/:id/claim                     IDENTITY_CLAIM
//   POST   /identity/drafts                      IDENTITY_DRAFT_MINT
//   DELETE /identity/drafts/:draftId             IDENTITY_DRAFT_DISCARD
//
// The per-agent routes act on a loaded agent's open workspace with Studio's
// code (services/envelope-actions.ts) and the daemon's owner identity
// (DaemonIdentity.service, public methods only). No key material, password
// or derived key appears in a response or a log line. Drafts hold their
// private key in this process; only { draftId, did } leaves it.
// POST /agents/create with identityDraftId adopts one
// (DaemonAgentFactory.create, as Studio's FILE_CREATE_QUICK).

import type { FastifyInstance, FastifyReply } from 'fastify'
import { unlockWorkspaceEnvelopes } from '../../runtime/identity-provisioner'
import {
  claimAgentWorkspace,
  readAttestations,
  readEnvelopeStatus,
  reissueAttestations,
  removeSharePassword,
  setSharePassword,
  unlockWithSharePassword,
} from '../../services/envelope-actions'
import { identityDrafts } from '../../services/identity-drafts'
import type { DaemonRouteContext } from './index'
import { resolveAgentWorkspace, type ResolvedAgentWorkspace } from './agent-resolver'
import { notFound, unavailable } from './route-helpers'

const NO_OWNER = 'No owner identity on this host — create or restore it first (`adf identity`).'

export function registerOwnerEnvelopeRoutes(server: FastifyInstance, ctx: DaemonRouteContext): void {
  const { runtime } = ctx
  type IdReq = { Params: { id: string } }

  /** The agent's workspace (agent-resolver.ts), or a sent 404 (null). */
  const workspaceOf = (id: string, reply: FastifyReply): ResolvedAgentWorkspace | null => {
    const found = resolveAgentWorkspace(runtime, id)
    if (!found.ok) {
      void notFound(reply, found.message)
      return null
    }
    return found.agent
  }

  /** The owner identity service, or a sent 503 (null). */
  const ownerService = (reply: FastifyReply) => {
    const identity = ctx.options.identity
    if (!identity) {
      void unavailable(reply, 'Owner identity is not configured on this daemon.')
      return null
    }
    return identity
  }

  server.get<IdReq>('/agents/:id/attestations', async (request, reply) => {
    const target = workspaceOf(request.params.id, reply)
    if (!target) return reply
    return readAttestations(target.workspace)
  })

  server.post<IdReq>('/agents/:id/attestations/reissue', async (request, reply) => {
    const target = workspaceOf(request.params.id, reply)
    if (!target) return reply
    const identity = ownerService(reply)
    if (!identity) return reply
    if (!identity.isReady()) return { success: false, error: NO_OWNER }
    const result = reissueAttestations(target.workspace, identity.service)
    if (result.success) console.log(`[ADF Daemon] Reissued owner/operator attestations for ${target.agentId}`)
    return result
  })

  server.get<IdReq>('/agents/:id/envelope', async (request, reply) => {
    const target = workspaceOf(request.params.id, reply)
    if (!target) return reply
    const identity = ownerService(reply)
    if (!identity) return reply
    return readEnvelopeStatus(target.workspace, identity.service, unlockWorkspaceEnvelopes)
  })

  server.put<IdReq & { Body: { password?: unknown } | null }>('/agents/:id/envelope/share-password', async (request, reply) => {
    const target = workspaceOf(request.params.id, reply)
    if (!target) return reply
    const result = setSharePassword(target.workspace, request.body?.password)
    if (result.success) console.log(`[ADF Daemon] Credentials share password set for ${target.agentId}`)
    return result
  })

  server.delete<IdReq>('/agents/:id/envelope/share-password', async (request, reply) => {
    const target = workspaceOf(request.params.id, reply)
    if (!target) return reply
    try {
      const result = removeSharePassword(target.workspace)
      console.log(`[ADF Daemon] Credentials share password removed for ${target.agentId}`)
      return result
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  server.post<IdReq & { Body: { password?: unknown; adopt?: unknown } | null }>('/agents/:id/envelope/unlock-password', async (request, reply) => {
    const target = workspaceOf(request.params.id, reply)
    if (!target) return reply
    const identity = ownerService(reply)
    if (!identity) return reply
    const adopt = typeof request.body?.adopt === 'boolean' ? request.body.adopt : undefined
    return unlockWithSharePassword(target.workspace, request.body?.password, adopt, identity.service)
  })

  // A whole-file-password file needs its derived key (agent-resolver.ts);
  // without it the claim is refused, as Studio refuses it before the
  // password is entered.
  server.post<IdReq>('/agents/:id/claim', async (request, reply) => {
    const target = workspaceOf(request.params.id, reply)
    if (!target) return reply
    const identity = ownerService(reply)
    if (!identity) return reply
    const result = claimAgentWorkspace(target.workspace, {
      derivedKey: target.derivedKey,
      svc: identity.service,
      ensureRuntimeIdentity: () => { if (!identity.isReady()) throw new Error(NO_OWNER) },
      // The whole-file password is gone: its key must go with it, or a later
      // write is encrypted with a key nothing can derive again.
      onPasswordRemoved: () => runtime.forgetFileDerivedKey(target.filePath),
    })
    if (result.success) console.log(`[ADF Daemon] Claimed ${target.agentId} under the local owner: ${result.did}`)
    return result
  })

  server.post('/identity/drafts', async () => identityDrafts.mint())

  server.delete<{ Params: { draftId: string } }>('/identity/drafts/:draftId', async (request) =>
    ({ discarded: identityDrafts.discard(request.params.draftId) }))
}
