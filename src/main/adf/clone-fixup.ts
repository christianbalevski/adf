/**
 * Clone fixup — the post-copy work that turns a byte-for-byte .adf copy into
 * a proper child of its source (ADF_IDENTITY_SPEC D4/D11/D15).
 *
 * The FILE_CLONE flow copies the SQLite file, then clears whatever tables
 * the user deselected. That leaves lineage and provenance wrong in ways a
 * plain table wipe cannot fix:
 *
 *   - adf_parent_did is the SOURCE's parent, so the clone lands as a sibling
 *     (or as a root) in the fleet map instead of under the source.
 *   - A fresh identity appends the source's live DID to adf_did_history
 *     (generateIdentityKeys records "the previous DID"), so the clone would
 *     resolve as the source's continuation — and the inherited history already
 *     claims every DID the source ever rotated away from.
 *   - Inherited attestations are about the source DID; after re-keying they
 *     are foreign-subject certs that never verify.
 *   - A kept identity with deselected attestations has no owner/operator
 *     certs at all.
 *
 * Kept out of the IPC handler so it can run against a temp .adf in tests.
 * The caller snapshots the source reference BEFORE clearing any table (the
 * copy is the only place it can be read from once the source may be locked
 * or mid-rotation) and passes the owner keys it would use for any re-key.
 */

import type { AdfWorkspace } from './adf-workspace'
import {
  appendAdfAttestation,
  createAttestation,
  issueOwnerAttestation,
  retainAttestationsForSubject
} from '../services/attestation.service'
import { extractRawPublicKey, publicKeyToDid } from '../crypto/identity-crypto'

/** Lineage reference of the source, read from the byte copy before clearing. */
export interface CloneSourceRef {
  /** Source's live DID (adf_did), or null for a pre-identity file */
  did: string | null
  /** Canonical parent reference: the DID, else config.id (legacy fallback) */
  id: string
}

export interface CloneOwnerKeys {
  ownerDid: string
  ownerPrivateKey: Buffer | null
  runtimeDid?: string
  runtimePrivateKey?: Buffer | null
}

export interface CloneFixupOptions {
  /** Tables the user chose to keep (everything else was cleared/dropped). */
  selectedTables: Iterable<string>
  source: CloneSourceRef
  /** Local owner/runtime keys — sign the clone cert, re-issue owner certs. */
  keys: CloneOwnerKeys
  /**
   * Fresh-identity provisioning (envelopes + sealed keys + owner certs);
   * invoked only when adf_identity was NOT kept. In production this is
   * OwnerIdentityService.ensureWorkspaceIdentity.
   */
  provisionFreshIdentity: (workspace: AdfWorkspace) => void
}

export interface CloneFixupResult {
  did: string | null
  identity: 'fresh' | 'kept'
  /** A signed `clone` attestation (scope = source DID) was recorded */
  cloneAttested: boolean
  /** Inherited attestations about another subject that were removed */
  purgedAttestations: number
}

/**
 * Read the source's lineage reference off the untouched byte copy. Mirrors
 * sys_create_adf: `workspace.getDid() || config.id`.
 */
export function snapshotCloneSource(copy: AdfWorkspace): CloneSourceRef {
  const did = copy.getDid()
  return { did, id: did || copy.getAgentConfig().id }
}

/**
 * Remove or clear every table the user deselected:
 *   - adf_ tables: DELETE rows but keep schema (valid ADF structure)
 *   - virtual tables: DROP (their shadow tables go with them)
 *   - anything else (local_, …): DROP
 * Shadow tables of virtual tables are skipped — managed by their parent.
 */
export function clearUnselectedTables(workspace: AdfWorkspace, selectedTables: Iterable<string>): void {
  const selected = new Set(selectedTables)
  const virtualRows = workspace.querySQL(
    "SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE 'CREATE VIRTUAL TABLE%'"
  ) as Array<{ name: string }>
  const shadowPrefixes = virtualRows.map((v) => `${v.name}_`)
  const virtualSet = new Set(virtualRows.map((v) => v.name))

  const allRows = workspace.querySQL(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  ) as Array<{ name: string }>

  for (const row of allRows) {
    if (shadowPrefixes.some((prefix) => row.name.startsWith(prefix))) continue
    if (selected.has(row.name)) continue

    if (virtualSet.has(row.name)) {
      workspace.executeSQL(`DROP TABLE "${row.name}"`)
    } else if (row.name.startsWith('adf_')) {
      workspace.executeSQL(`DELETE FROM "${row.name}"`)
    } else {
      workspace.executeSQL(`DROP TABLE "${row.name}"`)
    }
  }
}

/**
 * Apply identity, provenance and lineage fixups to a cleared clone. Runs
 * AFTER clearUnselectedTables and the rename; every branch ends with the
 * clone parented to the source.
 */
export function applyCloneFixup(workspace: AdfWorkspace, opts: CloneFixupOptions): CloneFixupResult {
  const selected = new Set(opts.selectedTables)
  const { source, keys } = opts
  let cloneAttested = false
  let purgedAttestations = 0
  let identity: CloneFixupResult['identity']

  if (!selected.has('adf_identity')) {
    identity = 'fresh'
    // Envelopes + fresh keys + owner/operator certs for the NEW DID.
    opts.provisionFreshIdentity(workspace)
    const newDid = workspace.getDid()

    // The copy inherited the source's rotated-away DIDs, and minting just
    // appended the source's LIVE DID on top. A clone is a new lineage node:
    // its ancestry is adf_parent_did + the clone cert below, never history
    // (history would make resolveLineage treat it as the source itself).
    workspace.resetDidHistory()

    if (newDid) {
      // Inherited certs are about the source DID — subject-mismatched forever.
      purgedAttestations = retainAttestationsForSubject(workspace, newDid)
      // Provenance, exactly as claimWorkspace records it. Skipped when the
      // source had no DID: there is nothing to scope the cert to, and the
      // config-id parent reference already carries the lineage.
      if (source.did && keys.ownerPrivateKey) {
        appendAdfAttestation(workspace, createAttestation(
          { issuer: keys.ownerDid, subject: newDid, role: 'clone', issued_at: new Date().toISOString(), scope: source.did },
          keys.ownerPrivateKey
        ))
        cloneAttested = true
      }
    }
  } else {
    identity = 'kept'
    // Keys survive; the DID row may not (adf_meta deselected). Recompute it
    // from the public key so the clone is not a keyed-but-DID-less file.
    // Password-protected keys can't be read without the derived key — leave
    // that case to the unlock path.
    if (!workspace.getDid()) {
      const pub = workspace.getSigningKeys(null)?.publicKey
      if (pub) workspace.setMeta('adf_did', publicKeyToDid(extractRawPublicKey(pub)), 'readonly')
    }
    if (!workspace.getMeta('adf_owner_did')) workspace.setMeta('adf_owner_did', keys.ownerDid, 'readonly')
    if (keys.runtimeDid && !workspace.getMeta('adf_runtime_did')) {
      workspace.setMeta('adf_runtime_did', keys.runtimeDid, 'readonly')
    }
    // Same DID, so kept attestations stay valid. Deselected ones were deleted
    // by the table clear — reissue owner/operator so the clone is not certless.
    if (!selected.has('adf_attestations')) issueOwnerAttestation(workspace, keys)
  }

  // Child of the source in every branch. Overwrites the inherited value (the
  // SOURCE's parent) and re-inserts the row when adf_meta was cleared. setMeta
  // is an upsert whose ON CONFLICT touches only the value, so a kept row keeps
  // the readonly protection stamped at file creation and a re-inserted one
  // gets it from the argument.
  workspace.setMeta('adf_parent_did', source.id, 'readonly')

  return { did: workspace.getDid(), identity, cloneAttested, purgedAttestations }
}
