/**
 * Attestation Service
 *
 * Delegation certificates: a parent identity (owner or runtime) signs a
 * statement about a subject DID ("this agent is mine"). Attestations are
 * public-by-design and live in the adf_attestations table (spec D15) —
 * stored plain, NOT in adf_identity, whose rows are blanket-encrypted under
 * password protection and would be unreadable at card-build time for locked
 * files. (They lived in an adf_meta key before schema v24.)
 *
 * Two lifecycle classes: current-state certs (owner/operator — replaced
 * wholesale on re-key) and append-only facts (clone, rotation — never
 * deleted by re-attestation).
 *
 * Signature covers the canonical JSON of every field except `signature`,
 * including `subject`, so a cert cannot be replayed onto another identity.
 */

import type { AlfAttestation } from '../../shared/types/adf-v02.types'
import type { AdfWorkspace } from '../adf/adf-workspace'
import { signEd25519, verifyEd25519, didToPublicKey, rawPublicKeyToSpki } from '../crypto/identity-crypto'
import { canonicalJsonStringify } from './alf-pipeline'

/** Legacy adf_meta key (pre-v24); retained for the schema migration only. */
export const ATTESTATIONS_META_KEY = 'adf_attestations'

/** Current-state roles replaced wholesale on re-key. Everything else is append-only. */
export const REPLACEABLE_ROLES = ['owner', 'operator']

/**
 * Runtime-issued roles that agents may never add or issue themselves — they
 * feed the card/mdns ownership trust flags and the claim/rotation provenance
 * chain.
 */
export const RESERVED_ROLES = new Set(['owner', 'operator', 'runtime', 'clone', 'rotation'])

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

/** Read all attestations from the adf_attestations table, oldest first. */
export function readAdfAttestations(workspace: AdfWorkspace): AlfAttestation[] {
  return workspace
    .getDatabase()
    .listAttestations()
    .filter((a) => a && typeof a.signature === 'string') as unknown as AlfAttestation[]
}

/**
 * Replace the full attestation set. Destructive — appropriate only for tests
 * and full resets; production re-attestation goes through
 * issueOwnerAttestation (scoped) or appendAdfAttestation (append-only).
 */
export function writeAdfAttestations(workspace: AdfWorkspace, attestations: AlfAttestation[]): void {
  const db = workspace.getDatabase()
  db.deleteAllAttestations()
  for (const att of attestations) db.insertAttestation(att)
}

/** Append a single append-only attestation (clone, rotation, …). */
export function appendAdfAttestation(workspace: AdfWorkspace, attestation: AlfAttestation): void {
  workspace.getDatabase().insertAttestation(attestation)
}

/**
 * Store a peer-issued attestation (agent-facing attestation_add).
 * Boundary rules: the signature must verify against the issuer DID, the
 * subject must be THIS agent (you collect certs about yourself, not a trust
 * cache of others), the role must not be reserved, and duplicates (same
 * signature) are ignored.
 */
export function addPeerAttestation(
  workspace: AdfWorkspace,
  attestation: AlfAttestation,
  ownDid: string
): { ok: true } | { ok: false; error: string } {
  if (!attestation || typeof attestation !== 'object') return { ok: false, error: 'Attestation must be an object' }
  if (!ownDid) return { ok: false, error: 'This agent has no DID' }
  const role = typeof attestation.role === 'string' ? attestation.role.trim() : ''
  if (!role) return { ok: false, error: 'Attestation role is required' }
  if (RESERVED_ROLES.has(role)) return { ok: false, error: `Role "${role}" is reserved for the runtime` }
  if (attestation.subject !== ownDid) {
    return { ok: false, error: `Attestation subject must be this agent's DID (${ownDid})` }
  }
  if (!verifyAttestation(attestation, { expectedSubject: ownDid })) {
    return { ok: false, error: 'Attestation signature is invalid or expired' }
  }
  const existing = readAdfAttestations(workspace)
  if (existing.some((a) => a.signature === attestation.signature)) {
    return { ok: true } // idempotent — already stored
  }
  const { issuer, subject, issued_at, expires_at, scope, signature } = attestation
  workspace.getDatabase().insertAttestation({ issuer, subject, role, issued_at, expires_at, scope, signature })
  return { ok: true }
}

/**
 * Sign an attestation about another DID with this agent's key (agent-facing
 * attestation_issue). The cert is returned, NOT stored — attestations live
 * with their subject, who adds it via attestation_add on their side.
 */
export function issuePeerAttestation(
  workspace: AdfWorkspace,
  fields: { subject: string; role: string; scope?: string; expires_at?: string },
  signingKeyPkcs8: Buffer
): { ok: true; attestation: AlfAttestation } | { ok: false; error: string } {
  const issuer = workspace.getDid()
  if (!issuer) return { ok: false, error: 'This agent has no DID' }
  const role = typeof fields.role === 'string' ? fields.role.trim() : ''
  if (!role) return { ok: false, error: 'Attestation role is required' }
  if (RESERVED_ROLES.has(role)) return { ok: false, error: `Role "${role}" is reserved for the runtime` }
  if (typeof fields.subject !== 'string' || !didToPublicKey(fields.subject)) {
    return { ok: false, error: 'Subject must be a valid did:key identifier' }
  }
  if (fields.subject === issuer) return { ok: false, error: 'An agent cannot attest to itself' }
  if (fields.expires_at !== undefined && Number.isNaN(Date.parse(fields.expires_at))) {
    return { ok: false, error: 'expires_at must be an ISO 8601 timestamp' }
  }
  const attestation = createAttestation(
    {
      issuer,
      subject: fields.subject,
      role,
      issued_at: new Date().toISOString(),
      ...(fields.expires_at !== undefined ? { expires_at: fields.expires_at } : {}),
      ...(fields.scope !== undefined ? { scope: String(fields.scope) } : {})
    },
    signingKeyPkcs8
  )
  return { ok: true, attestation }
}

/**
 * Issue fresh owner/operator attestations for the workspace's agent DID,
 * replacing ONLY those roles (re-keying invalidates old-subject certs).
 * Append-only facts (clone, rotation) are preserved (D15). Owner attestation
 * always; runtime 'operator' attestation when a runtime key is supplied.
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
  const db = workspace.getDatabase()
  db.deleteAttestationsByRoles(REPLACEABLE_ROLES)
  for (const att of attestations) db.insertAttestation(att)
  return attestations
}
