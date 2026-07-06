/**
 * Attestation Service
 *
 * Delegation certificates: a parent identity (owner or runtime) signs a
 * statement about a subject DID ("this agent is mine"). Attestations are
 * public-by-design and live in adf_meta under `adf_attestations` — NOT in
 * adf_identity, whose rows are blanket-encrypted under password protection
 * and would be unreadable at card-build time for locked files.
 *
 * Signature covers the canonical JSON of every field except `signature`,
 * including `subject`, so a cert cannot be replayed onto another identity.
 */

import type { AlfAttestation } from '../../shared/types/adf-v02.types'
import type { AdfWorkspace } from '../adf/adf-workspace'
import { signEd25519, verifyEd25519, didToPublicKey, rawPublicKeyToSpki } from '../crypto/identity-crypto'
import { canonicalJsonStringify } from './alf-pipeline'

/** adf_meta key holding the JSON array of attestations for the file's agent DID. */
export const ATTESTATIONS_META_KEY = 'adf_attestations'

function signableBytes(fields: Omit<AlfAttestation, 'signature'>): Buffer {
  const { issuer, subject, role, issued_at, expires_at, scope } = fields
  const signable: Record<string, unknown> = { issuer, subject, role, issued_at }
  if (expires_at !== undefined) signable.expires_at = expires_at
  if (scope !== undefined) signable.scope = scope
  return Buffer.from(canonicalJsonStringify(signable))
}

/** Sign an attestation with the issuer's private key (PKCS8 DER). */
export function createAttestation(
  fields: Omit<AlfAttestation, 'signature'>,
  privateKeyPkcs8: Buffer
): AlfAttestation {
  const signature = `ed25519:${signEd25519(signableBytes(fields), privateKeyPkcs8)}`
  return { ...fields, signature }
}

/**
 * Verify an attestation's signature against its issuer DID, plus expiry and
 * (optionally) an expected subject. Returns false on any failure.
 */
export function verifyAttestation(
  att: AlfAttestation,
  opts?: { expectedSubject?: string; now?: Date }
): boolean {
  if (!att || typeof att.signature !== 'string' || !att.signature.startsWith('ed25519:')) return false
  if (opts?.expectedSubject && att.subject !== opts.expectedSubject) return false
  if (att.expires_at) {
    const expires = Date.parse(att.expires_at)
    if (Number.isNaN(expires) || expires <= (opts?.now ?? new Date()).getTime()) return false
  }
  const rawPubKey = didToPublicKey(att.issuer)
  if (!rawPubKey) return false
  const { signature: _sig, ...fields } = att
  return verifyEd25519(
    signableBytes(fields),
    att.signature.slice('ed25519:'.length),
    rawPublicKeyToSpki(rawPubKey)
  )
}

/** Read the attestation array from adf_meta. Tolerant: bad JSON → []. */
export function readAdfAttestations(workspace: AdfWorkspace): AlfAttestation[] {
  const raw = workspace.getMeta(ATTESTATIONS_META_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((a) => a && typeof a === 'object') : []
  } catch {
    return []
  }
}

/** Overwrite the attestation array. readonly: not agent-writable via sys_set_meta. */
export function writeAdfAttestations(workspace: AdfWorkspace, attestations: AlfAttestation[]): void {
  workspace.setMeta(ATTESTATIONS_META_KEY, JSON.stringify(attestations), 'readonly')
}

/**
 * Issue fresh attestations for the workspace's agent DID, replacing any
 * existing ones wholesale (re-keying invalidates old-subject certs, and
 * overwrite is what clears them). Owner attestation always; runtime
 * 'operator' attestation when a runtime key is supplied.
 * No-op if the file has no agent DID or no owner key is available.
 */
export function issueOwnerAttestation(
  workspace: AdfWorkspace,
  keys: { ownerDid: string; ownerPrivateKey: Buffer | null; runtimeDid?: string; runtimePrivateKey?: Buffer | null }
): AlfAttestation[] {
  const subject = workspace.getDid()
  if (!subject || !keys.ownerPrivateKey) return []

  const issued_at = new Date().toISOString()
  const attestations: AlfAttestation[] = [
    createAttestation(
      { issuer: keys.ownerDid, subject, role: 'owner', issued_at },
      keys.ownerPrivateKey
    )
  ]
  if (keys.runtimeDid && keys.runtimePrivateKey) {
    attestations.push(
      createAttestation(
        { issuer: keys.runtimeDid, subject, role: 'operator', issued_at },
        keys.runtimePrivateKey
      )
    )
  }
  writeAdfAttestations(workspace, attestations)
  return attestations
}
