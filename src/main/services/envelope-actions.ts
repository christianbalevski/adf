/**
 * Per-file envelope, attestation and claim actions on one open workspace:
 * the Identity panel's envelope status, the credentials share password
 * (D12), owner/operator attestations, and claiming a file under the local
 * owner. Shared by Studio's IDENTITY_* handlers (on the open file) and the
 * daemon's /agents/:id envelope, attestation and claim routes (on a loaded
 * agent's workspace).
 *
 * Results keep Studio's IPC shapes. No key material or password leaves
 * these functions; errors carry messages only.
 */

import type { AdfWorkspace } from '../adf/adf-workspace'
import { issueOwnerAttestation, readAdfAttestations } from './attestation.service'
import type { OwnerIdentityService } from './owner-identity.service'

/** The owner identity reads these actions need (OwnerIdentityService). */
export type EnvelopeOwnerIdentity = Pick<
  OwnerIdentityService,
  | 'getOwnerDid'
  | 'getRuntimeDid'
  | 'getOwnerSigningKey'
  | 'getRuntimeSigningKey'
  | 'getOwnerEncPublicKey'
  | 'getRuntimeEncPublicKey'
  | 'getEnvelopeRecipients'
  | 'claimWorkspace'
>

type EnvelopeName = 'identity' | 'credentials'

/** Owner + operator attestations for the file's DID. Failures are logged, never thrown. */
export function issueAttestationsFor(workspace: AdfWorkspace, svc: EnvelopeOwnerIdentity): void {
  try {
    issueOwnerAttestation(workspace, {
      ownerDid: svc.getOwnerDid(),
      ownerPrivateKey: svc.getOwnerSigningKey(),
      runtimeDid: svc.getRuntimeDid(),
      runtimePrivateKey: svc.getRuntimeSigningKey()
    })
  } catch (err) {
    console.warn('[OwnerIdentity] Attestation issuance failed:', err)
  }
}

export function readAttestations(workspace: AdfWorkspace) {
  return { attestations: readAdfAttestations(workspace), did: workspace.getDid() }
}

export function reissueAttestations(workspace: AdfWorkspace, svc: EnvelopeOwnerIdentity) {
  if (!workspace.getDid()) return { success: false as const, error: 'Agent has no DID — generate keys first' }
  issueAttestationsFor(workspace, svc)
  return { success: true as const, attestations: readAdfAttestations(workspace) }
}

/**
 * State of both envelopes plus whether a share password is set.
 *
 * 'foreign' from getEnvelopeState only means "no cached DEK, no password
 * slot" — a session-cache artifact for an own file whose open path never
 * unlocked (e.g. legacy password gate). Attempt the local-key unwrap
 * first (`unlock`), then classify leftovers by slot DIDs: local
 * owner/runtime slot present → ours-but-not-unlocked → 'locked', never
 * 'foreign'.
 */
export function readEnvelopeStatus(workspace: AdfWorkspace, svc: EnvelopeOwnerIdentity, unlock: (ws: AdfWorkspace) => void) {
  unlock(workspace)
  const localDids = new Set([svc.getOwnerDid(), svc.getRuntimeDid()])
  const classify = (name: EnvelopeName) => {
    const state = workspace.getEnvelopeState(name)
    if (state !== 'foreign') return state
    const slots = workspace.readEnvelopeSlots(name) ?? []
    const oursBySlot = slots.some(
      (s) => s.type !== 'password' && localDids.has((s as { recipient_did?: string }).recipient_did ?? '')
    )
    return oursBySlot ? 'locked' : 'foreign'
  }
  const credentialSlots = workspace.readEnvelopeSlots('credentials') ?? []
  return {
    success: true as const,
    identity: classify('identity'),
    credentials: classify('credentials'),
    sharePasswordSet: credentialSlots.some((s) => s.type === 'password')
  }
}

/**
 * Share flow (D12): add a password slot to the credentials envelope so the
 * file can travel; identity is never password-shareable. One password slot
 * at a time — replace rather than accumulate.
 */
export function setSharePassword(workspace: AdfWorkspace, password: unknown) {
  if (typeof password !== 'string' || password.length < 8) {
    return { success: false as const, error: 'Share password must be at least 8 characters' }
  }
  try {
    workspace.removeEnvelopePasswordSlots('credentials')
    workspace.addEnvelopePasswordSlot('credentials', password)
    return { success: true as const }
  } catch (err) {
    return { success: false as const, error: err instanceof Error ? err.message : String(err) }
  }
}

export function removeSharePassword(workspace: AdfWorkspace) {
  workspace.removeEnvelopePasswordSlots('credentials')
  return { success: true as const }
}

/**
 * Recipient flow (D12): unlock foreign credentials with the share password.
 * adopt: true (the post-claim manual path, e.g. IdentityPanel) additionally
 * re-wraps to the local owner/runtime; the password slot is PRESERVED
 * (multi-route — the same password keeps working for re-sharing). adopt:
 * false (the pre-accept review flow) caches the DEK for this session only
 * and writes NOTHING — rejecting the review must leave the file untouched;
 * adoption then happens inside the claim path.
 */
export function unlockWithSharePassword(workspace: AdfWorkspace, password: unknown, adopt: boolean | undefined, svc: EnvelopeOwnerIdentity) {
  if (!workspace.unlockEnvelopeWithPassword('credentials', String(password))) {
    return { success: false as const, error: 'Wrong password' }
  }
  if (adopt === false) {
    return { success: true as const, adopted: false, credentials: workspace.getEnvelopeState('credentials') }
  }
  try {
    const ownerEncPub = svc.getOwnerEncPublicKey()
    const runtimeEncPub = svc.getRuntimeEncPublicKey()
    const adopted = !!(ownerEncPub && runtimeEncPub)
    if (ownerEncPub && runtimeEncPub) {
      workspace.adoptEnvelope('credentials', {
        ownerDid: svc.getOwnerDid(),
        ownerEncPublicKey: ownerEncPub,
        runtimeDid: svc.getRuntimeDid(),
        runtimeEncPublicKey: runtimeEncPub
      })
    }
    // Credentials written while the envelope was locked landed plain —
    // seal them now that the DEK is available.
    workspace.sealPlainRowsIntoEnvelopes()
    return {
      success: true as const,
      adopted,
      // Adopt skipped ≠ adopted: the envelope stays usable this session but
      // no local key slots were added — the password stays the only route
      // on this machine. Warn, don't fail — failing here would block
      // credential use entirely.
      ...(adopted
        ? {}
        : { warning: 'Owner/runtime encryption keys are unavailable — envelope unlocked for this session only; the password will be required again next time' }),
      credentials: workspace.getEnvelopeState('credentials')
    }
  } catch (err) {
    return { success: false as const, error: err instanceof Error ? err.message : String(err) }
  }
}

export interface LegacyConvertOptions {
  svc: Pick<OwnerIdentityService, 'getOwnerDid' | 'getEnvelopeRecipients' | 'ensureWorkspaceIdentity'>
  /** The whole-file password was removed: forget the derived key everywhere it is held. */
  onPasswordRemoved: () => void
  /** Where the two non-fatal failures are logged (default console). */
  log?: Pick<Console, 'warn'>
  /** Log prefix (default the IPC channel's). */
  label?: string
}

/**
 * Whole-file passwords are deprecated: right after a successful unlock,
 * convert the user's OWN files — strip the whole-file password, mint keys +
 * envelopes, then carry the SAME password forward as a credentials-envelope
 * password slot (multi-route: opens silently via owner/runtime keys, and the
 * password keeps working as a share password). Foreign files are left
 * exactly as-is — the claim flow owns their conversion. Without envelope
 * recipients, skip silently: never strip protection without re-protecting.
 *
 * Returns true when the password was removed (converted). Shared by
 * Studio's IDENTITY_PASSWORD_UNLOCK and the daemon's unlock route.
 */
export function convertOwnLegacyPassword(workspace: AdfWorkspace, derivedKey: Buffer, password: string, opts: LegacyConvertOptions): boolean {
  const log = opts.log ?? console
  const label = opts.label ?? '[IDENTITY_PASSWORD_UNLOCK]'
  let converted = false
  try {
    const svc = opts.svc
    const fileOwnerDid = workspace.getMeta('adf_owner_did')
    const isMine = fileOwnerDid
      ? fileOwnerDid === svc.getOwnerDid()
      : !readAdfAttestations(workspace).some((a) => a.role === 'owner')
    if (isMine && svc.getEnvelopeRecipients()) {
      workspace.removePassword(derivedKey)
      opts.onPasswordRemoved()
      converted = true
      // Now unblocked (no longer password-protected): envelopes + keys +
      // sealing. A failure here leaves a plain file that the FILE_OPEN
      // lazy migration retries on next open.
      try {
        svc.ensureWorkspaceIdentity(workspace)
        if (workspace.getEnvelopeState('credentials') === 'unlocked') {
          // Same replace pattern as the share-password set flow.
          workspace.removeEnvelopePasswordSlots('credentials')
          workspace.addEnvelopePasswordSlot('credentials', password)
        }
      } catch (err) {
        log.warn(`${label} Post-convert provisioning failed:`, err)
      }
    }
  } catch (err) {
    log.warn(`${label} Auto-convert check failed:`, err)
  }
  return converted
}

export interface ClaimOptions {
  /** The file's derived key when it is password-protected and unlocked; else null. */
  derivedKey: Buffer | null
  svc: EnvelopeOwnerIdentity
  /** Make sure this host's runtime key exists (throws when it cannot). */
  ensureRuntimeIdentity: () => void
  /** The whole-file password was removed: forget the cached derived key. */
  onPasswordRemoved: () => void
}

/** Claim the file under the local owner (OwnerIdentityService.claimWorkspace). */
export function claimAgentWorkspace(workspace: AdfWorkspace, opts: ClaimOptions) {
  try {
    if (workspace.isPasswordProtected() && !opts.derivedKey) {
      // Claiming without the derived key would wipe the signing keys and
      // then bail at provisioning, leaving the file key-less and still
      // password-protected.
      return { success: false as const, error: 'File is password-protected — enter the password before claiming' }
    }
    opts.ensureRuntimeIdentity()
    if (!opts.svc.getEnvelopeRecipients()) {
      // Fail plainly: claiming without envelope recipients would mint an
      // identity with no envelopes (plaintext keys, no credential sealing).
      return { success: false as const, error: 'Owner and runtime encryption keys are unavailable (keystore locked?), so the template cannot be claimed securely.' }
    }
    // If password-protected, decrypt everything first, then remove password
    if (workspace.isPasswordProtected() && opts.derivedKey) {
      workspace.removePassword(opts.derivedKey)
      opts.onPasswordRemoved()
    }
    const { did } = opts.svc.claimWorkspace(workspace)
    return { success: true as const, did }
  } catch (err) {
    return { success: false as const, error: String(err) }
  }
}
