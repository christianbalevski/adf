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
 * Two formats. v2 (`v: 2`, everything issued now) signs the canonical JSON
 * of every field except `signature`, `claims` and any later field included,
 * so nothing can be added to a cert without breaking it. v1 (no `v`) signed
 * only issuer, subject, role, issued_at, expires_at and scope; it still
 * verifies, for certs signed by keys this runtime does not hold (a peer's),
 * and own v1 certs are re-signed as v2 (upgradeOwnAttestations). Both sign
 * `subject`, so a cert cannot be replayed onto another identity.
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

/** The most a cert's `claims` may take, as canonical JSON (UTF-8 bytes). */
export const ATTESTATION_CLAIMS_MAX_BYTES = 4096
/** The most a whole v2 cert may take, as canonical JSON: a verifier refuses larger ones unread. */
export const ATTESTATION_MAX_BYTES = 8192
/**
 * The most peer certs (non-reserved roles) a file keeps, and their total
 * size as stored JSON. Peers choose what they send, and published cards
 * carry every stored cert, so attestation_add refuses past either.
 */
export const PEER_ATTESTATIONS_MAX_COUNT = 64
export const PEER_ATTESTATIONS_MAX_BYTES = 65536
/** The deepest a cert's claims may nest (objects and arrays). */
export const ATTESTATION_CLAIMS_MAX_DEPTH = 8

/** Why `claims` cannot be signed, or null: a plain JSON object within the limits above. */
export function attestationClaimsProblem(claims: unknown): string | null {
  if (claims === null || typeof claims !== 'object' || Array.isArray(claims)) return 'claims must be a JSON object'
  const problem = jsonValueProblem(claims, 1)
  if (problem) return problem
  const bytes = Buffer.byteLength(canonicalJsonStringify(claims))
  if (bytes > ATTESTATION_CLAIMS_MAX_BYTES) return `claims take ${bytes} bytes; the most is ${ATTESTATION_CLAIMS_MAX_BYTES}`
  return null
}

function jsonValueProblem(value: unknown, depth: number): string | null {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return null
  if (typeof value === 'number') return Number.isFinite(value) ? null : 'claims numbers must be finite'
  if (typeof value !== 'object') return `claims cannot hold a ${typeof value}`
  if (depth > ATTESTATION_CLAIMS_MAX_DEPTH) return `claims nest deeper than ${ATTESTATION_CLAIMS_MAX_DEPTH} levels`
  if (Array.isArray(value)) {
    for (const item of value) {
      const problem = jsonValueProblem(item, depth + 1)
      if (problem) return problem
    }
    return null
  }
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return 'claims can hold only plain objects'
  // Canonical JSON sets a "__proto__" key as the prototype, leaving it out of the signed bytes.
  if (Object.prototype.hasOwnProperty.call(value, '__proto__')) return 'claims cannot hold a "__proto__" key'
  for (const item of Object.values(value)) {
    const problem = jsonValueProblem(item, depth + 1)
    if (problem) return problem
  }
  return null
}

/** Why the cert's fields have the wrong types, or null. Every field is signed in v2, so each is checked. */
function fieldsProblem(fields: Record<string, unknown>): string | null {
  for (const key of ['issuer', 'subject', 'role', 'issued_at'] as const) {
    if (typeof fields[key] !== 'string') return `${key} must be a string`
  }
  for (const key of ['expires_at', 'scope'] as const) {
    if (fields[key] !== undefined && typeof fields[key] !== 'string') return `${key} must be a string`
  }
  if (Object.prototype.hasOwnProperty.call(fields, '__proto__')) return 'an attestation cannot hold a "__proto__" key'
  return null
}

function signableBytes(fields: Omit<AlfAttestation, 'signature'>): Buffer {
  if (fields.v === 2) return Buffer.from(canonicalJsonStringify(fields))
  const { issuer, subject, role, issued_at, expires_at, scope } = fields
  const signable: Record<string, unknown> = { issuer, subject, role, issued_at }
  if (expires_at !== undefined) signable.expires_at = expires_at
  if (scope !== undefined) signable.scope = scope
  return Buffer.from(canonicalJsonStringify(signable))
}

/**
 * Sign a v2 attestation with the issuer's private key (PKCS8 DER). Throws
 * when `claims` is not a JSON object within the limits.
 */
export function createAttestation(
  fields: Omit<AlfAttestation, 'signature' | 'v'>,
  privateKeyPkcs8: Buffer
): AlfAttestation {
  const fieldProblem = fieldsProblem(fields as unknown as Record<string, unknown>)
  if (fieldProblem) throw new Error(`Attestation not signed: ${fieldProblem}`)
  if (fields.claims !== undefined) {
    const problem = attestationClaimsProblem(fields.claims)
    if (problem) throw new Error(`Attestation not signed: ${problem}`)
  }
  const unsigned: Omit<AlfAttestation, 'signature'> = { v: 2, ...fields }
  const signature = `ed25519:${signEd25519(signableBytes(unsigned), privateKeyPkcs8)}`
  return { ...unsigned, signature }
}

/**
 * Verify an attestation's signature against its issuer DID, plus expiry and
 * (optionally) an expected subject. Returns false on any failure.
 */
export function verifyAttestation(
  att: AlfAttestation,
  opts?: { expectedSubject?: string; now?: Date }
): boolean {
  if (!att || typeof att !== 'object' || typeof att.signature !== 'string' || !att.signature.startsWith('ed25519:')) return false
  // Remote data: a mistyped field is a failure, never a throw.
  if (fieldsProblem(att as unknown as Record<string, unknown>)) return false
  // An unknown version is not guessed at: a v3 cert fails here, as a v1 verifier fails a v2 one.
  if (att.v !== undefined && att.v !== 2) return false
  if (att.v === 2) {
    try {
      if (Buffer.byteLength(canonicalJsonStringify(att)) > ATTESTATION_MAX_BYTES) return false
    } catch {
      return false
    }
    if (att.claims !== undefined && attestationClaimsProblem(att.claims)) return false
  }
  if (opts?.expectedSubject && att.subject !== opts.expectedSubject) return false
  if (att.expires_at !== undefined) {
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
 * Drop every attestation whose subject is not `subject`. Attestations live
 * with their subject (addPeerAttestation enforces this), so after a byte copy
 * is re-keyed, anything about the OLD DID is a foreign-subject leftover that
 * would fail verifyAttestation({ expectedSubject }) forever. Order of the
 * survivors is preserved. Returns the number removed.
 */
export function retainAttestationsForSubject(workspace: AdfWorkspace, subject: string): number {
  const all = readAdfAttestations(workspace)
  const kept = all.filter((a) => a.subject === subject)
  if (kept.length === all.length) return 0
  writeAdfAttestations(workspace, kept)
  return all.length - kept.length
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
  const peers = existing.filter((a) => !RESERVED_ROLES.has(a.role))
  if (peers.length >= PEER_ATTESTATIONS_MAX_COUNT) {
    return { ok: false, error: `This agent already keeps ${peers.length} peer attestations, the most it stores` }
  }
  const peerBytes = peers.reduce((n, a) => n + Buffer.byteLength(JSON.stringify(a)), 0) + Buffer.byteLength(JSON.stringify(attestation))
  if (peerBytes > PEER_ATTESTATIONS_MAX_BYTES) {
    return { ok: false, error: `Storing it would take peer attestations to ${peerBytes} bytes; the most is ${PEER_ATTESTATIONS_MAX_BYTES}` }
  }
  // v2 signs every field, so the cert is kept whole; v1 keeps only what it signed.
  if (attestation.v === 2) {
    workspace.getDatabase().insertAttestation(attestation)
  } else {
    const { issuer, subject, issued_at, expires_at, scope, signature } = attestation
    workspace.getDatabase().insertAttestation({ issuer, subject, role, issued_at, expires_at, scope, signature })
  }
  return { ok: true }
}

/**
 * Sign an attestation about another DID with this agent's key (agent-facing
 * attestation_issue). The cert is returned, NOT stored — attestations live
 * with their subject, who adds it via attestation_add on their side.
 */
export function issuePeerAttestation(
  workspace: AdfWorkspace,
  fields: { subject: string; role: string; scope?: string; expires_at?: string; claims?: unknown },
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
  if (fields.claims !== undefined) {
    const problem = attestationClaimsProblem(fields.claims)
    if (problem) return { ok: false, error: problem }
  }
  const attestation = createAttestation(
    {
      issuer,
      subject: fields.subject,
      role,
      issued_at: new Date().toISOString(),
      ...(fields.expires_at !== undefined ? { expires_at: fields.expires_at } : {}),
      ...(fields.scope !== undefined ? { scope: String(fields.scope) } : {}),
      ...(fields.claims !== undefined ? { claims: fields.claims as Record<string, unknown> } : {})
    },
    signingKeyPkcs8
  )
  return { ok: true, attestation }
}

/**
 * Re-sign as v2 every v1 cert in the file that one of `signers` issued (the
 * owner and runtime keys this runtime holds): the same fields, the same
 * issued_at, a v2 signature. Certs of other issuers (peers) stay v1, which
 * still verifies. Only reads when nothing needs it. Otherwise each row is
 * updated in place (by its old signature) in one immediate transaction that
 * waits at most `busyTimeoutMs` for another connection: rows added or
 * changed meanwhile by another runtime are never touched. Returns the
 * number re-signed.
 */
export function upgradeOwnAttestations(
  workspace: AdfWorkspace,
  signers: Array<{ did: string; privateKey: Buffer | null }>,
  busyTimeoutMs?: number
): number {
  const keys = new Map(signers.filter((s) => s.did && s.privateKey).map((s) => [s.did, s.privateKey as Buffer]))
  if (keys.size === 0) return 0
  const updates: Array<{ from: string; to: AlfAttestation }> = []
  for (const att of readAdfAttestations(workspace)) {
    const key = att.v === undefined ? keys.get(att.issuer) : undefined
    // Only a cert that verifies is carried over: re-signing must never make a broken one valid.
    if (!key || !verifyAttestation(att, { now: new Date(0) })) continue
    const { issuer, subject, role, issued_at, expires_at, scope } = att
    updates.push({
      from: att.signature,
      to: createAttestation({
        issuer, subject, role, issued_at,
        ...(expires_at !== undefined ? { expires_at } : {}),
        ...(scope !== undefined ? { scope } : {}),
      }, key),
    })
  }
  if (updates.length === 0) return 0
  return workspace.immediateTransaction(() => workspace.getDatabase().resignAttestations(updates), busyTimeoutMs)
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
