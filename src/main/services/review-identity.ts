/**
 * The identity half of an agent review summary, read from an open workspace:
 * who the file says owns it (verified attestation first, meta fallback) set
 * against this install's own owner/runtime identity. Shared by Studio's review
 * dialog, the daemon's template review and the runtime's review endpoints, so
 * every surface shows the same scenario for the same file.
 */
import type { AdfWorkspace } from '../adf/adf-workspace'
import type { ReviewIdentitySummary } from '../../shared/types/ipc.types'
import { deriveReviewIdentity } from './agent-review'
import { readAdfAttestations, verifyAttestation } from './attestation.service'

/** The slice of OwnerIdentityService a review needs. */
export interface LocalReviewIdentity {
  getOwnerDid(): string
  getRuntimeDid(): string
  getOwnerEncPrivateKey(): Buffer | null
}

export function reviewIdentityFor(workspace: AdfWorkspace, local: LocalReviewIdentity): ReviewIdentitySummary {
  const agentDid = workspace.getDid()
  // Owner shown in review: verified attestation first (proof), meta
  // fallback (fact) — never the agent's own DID.
  const ownerAtt = readAdfAttestations(workspace)
    .filter((a) => a.role === 'owner')
    .find((a) => verifyAttestation(a, agentDid ? { expectedSubject: agentDid } : undefined))
  const credentialSlots = workspace.readEnvelopeSlots('credentials') ?? []
  return deriveReviewIdentity({
    agentDid,
    fileOwnerDid: ownerAtt?.issuer ?? workspace.getMeta('adf_owner_did') ?? null,
    fileRuntimeDid: workspace.getMeta('adf_runtime_did') ?? null,
    localOwnerDid: local.getOwnerDid(),
    localRuntimeDid: local.getRuntimeDid(),
    identityEnvelope: workspace.getEnvelopeState('identity'),
    credentialsEnvelope: workspace.getEnvelopeState('credentials'),
    sharePasswordSet: credentialSlots.some((s) => s.type === 'password'),
    filePasswordProtected: workspace.isPasswordProtected(),
    ownerKeyAvailable: local.getOwnerEncPrivateKey() !== null,
  })
}
