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

import { constants, copyFileSync, existsSync, renameSync, unlinkSync } from 'fs'
import { basename, dirname, join } from 'path'
import { nanoid } from 'nanoid'
import { AdfWorkspace } from './adf-workspace'
import type { AgentConfig } from '../../shared/types/adf-v02.types'
import type { KeySlotRecord } from '../crypto/envelope-crypto'
import {
  appendAdfAttestation,
  createAttestation,
  issueOwnerAttestation,
  retainAttestationsForSubject
} from '../services/attestation.service'
import { didToPublicKey, extractRawPublicKey, publicKeyToDid } from '../crypto/identity-crypto'

/** Lineage reference of the source, read from the byte copy before clearing. */
export interface CloneSourceRef {
  /** Source's live DID (adf_did) when well-formed, or null for a pre-identity file */
  did: string | null
  /** Canonical parent reference: the DID, else config.id (legacy fallback) */
  id: string
  /**
   * adf_did matches the DID derived from the source's own (plain) public key.
   * False when the key is password-protected or the meta row was tampered
   * with. adf_did is an unsigned index, so a bogus value may still be used as
   * the parent reference — but never as the scope of a cert WE sign.
   */
  didVerified: boolean
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
  /** Steps that were skipped (no owner key, locked keys, unverified source DID) */
  warnings: string[]
}

/**
 * DID derived from the signing public key row when it is readable without a
 * derived key: `plain` for unprotected AND envelope-sealed (D6) files — only
 * the private key is sealed. Null for password-protected rows (aes-256-gcm)
 * or a malformed key.
 */
function didFromPublicKeyRow(workspace: AdfWorkspace): string | null {
  const row = workspace.getDatabase().getIdentityRaw('crypto:signing:public_key')
  if (!row || row.encryption_algo !== 'plain') return null
  try {
    return publicKeyToDid(extractRawPublicKey(row.value))
  } catch {
    return null
  }
}

/**
 * Whether the identity envelope is ours to act on: absent (plain keys) or
 * unlocked, else sealed with a key slot for our owner/runtime DID (a fresh
 * open has no cached DEK, so getEnvelopeState reports our own file as
 * 'foreign'). False for another owner's envelope.
 */
export function isIdentityEnvelopeOurs(workspace: AdfWorkspace, keys: CloneOwnerKeys): boolean {
  const state = workspace.getEnvelopeState('identity')
  if (state === 'absent' || state === 'unlocked') return true
  const ours = new Set([keys.ownerDid, keys.runtimeDid].filter(Boolean))
  return (workspace.readEnvelopeSlots('identity') ?? []).some(
    (s) => s.type !== 'password' && ours.has((s as KeySlotRecord).recipient_did)
  )
}

/**
 * Read the source's lineage reference off the untouched byte copy. Mirrors
 * sys_create_adf: `workspace.getDid() || config.id`. A DID that is not a
 * well-formed did:key is ignored entirely (config.id parent, no cert).
 */
export function snapshotCloneSource(copy: AdfWorkspace): CloneSourceRef {
  const raw = copy.getDid()
  const did = raw && didToPublicKey(raw) ? raw : null
  const derived = did ? didFromPublicKeyRow(copy) : null
  return { did, id: did || copy.getAgentConfig().id, didVerified: did !== null && derived === did }
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
  const warnings: string[] = []
  let cloneAttested = false
  let purgedAttestations = 0
  let identity: CloneFixupResult['identity']

  const stampLocalIdentity = () => {
    // Overwrite, not fill-in: the copy carries the SOURCE owner's stamps.
    workspace.setMeta('adf_owner_did', keys.ownerDid, 'readonly')
    if (keys.runtimeDid) workspace.setMeta('adf_runtime_did', keys.runtimeDid, 'readonly')
  }

  if (!selected.has('adf_identity')) {
    identity = 'fresh'
    // Envelopes + fresh keys + owner/operator certs for the NEW DID.
    opts.provisionFreshIdentity(workspace)
    const newDid = workspace.getDid()
    // No new DID (locked/foreign file) or the source's DID reappearing would
    // leave a clone that IS the source — abort so the caller discards it.
    if (!newDid || newDid === source.did) {
      throw new Error('Clone identity provisioning did not mint a new DID')
    }
    stampLocalIdentity()

    // The copy inherited the source's rotated-away DIDs, and minting just
    // appended the source's LIVE DID on top. A clone is a new lineage node:
    // its ancestry is adf_parent_did + the clone cert below, never history
    // (history would make resolveLineage treat it as the source itself).
    workspace.resetDidHistory()

    // Inherited certs are about the source DID — subject-mismatched forever.
    purgedAttestations = retainAttestationsForSubject(workspace, newDid)
    // Provenance, exactly as claimWorkspace records it. Skipped when the
    // source had no DID: there is nothing to scope the cert to, and the
    // config-id parent reference already carries the lineage.
    //
    // Signed ONLY for a verified source DID. adf_meta is unsigned: a crafted
    // file could carry a victim's DID there, and signing a `clone` cert
    // scoped to it would lend our owner key to a forged provenance claim.
    if (source.did) {
      if (!source.didVerified) {
        warnings.push('Source DID does not match its signing key — clone provenance was not signed.')
      } else if (!keys.ownerPrivateKey) {
        warnings.push('Owner key unavailable — clone provenance was not signed.')
      } else {
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
    // from the public key row, which is plain for both unprotected and
    // envelope-sealed files. Password-protected keys can't be read without
    // the derived key — leave that case to the unlock path.
    if (!workspace.getDid()) {
      const did = didFromPublicKeyRow(workspace)
      if (did) workspace.setMeta('adf_did', did, 'readonly')
      else warnings.push('Keys are password-protected — adf_did was not recomputed; unlock the clone to restore it.')
    }
    if (!selected.has('adf_attestations')) {
      if (!isIdentityEnvelopeOurs(workspace, keys)) {
        // Another owner's sealed keys: stamping ourselves would claim a DID
        // we cannot sign for. Leave the source's stamps so the review gate
        // offers Claim, as it does when attestations were kept.
        warnings.push('Identity kept from another owner — use Claim to take ownership.')
      } else {
        // Same DID, so kept attestations would stay valid — but these were
        // deleted by the table clear. Reissue owner/operator for the LOCAL
        // owner and stamp the meta to match: cloning our own keys into our
        // tracked dir is a claim on the copy, whatever the stamps said.
        stampLocalIdentity()
        const issued = issueOwnerAttestation(workspace, keys)
        if (issued.length === 0) {
          warnings.push(
            keys.ownerPrivateKey
              ? 'No DID available — owner/operator certs were not issued.'
              : 'Owner key unavailable — owner/operator certs were not issued.'
          )
        }
      }
    } else {
      if (!workspace.getMeta('adf_owner_did')) workspace.setMeta('adf_owner_did', keys.ownerDid, 'readonly')
      if (keys.runtimeDid && !workspace.getMeta('adf_runtime_did')) {
        workspace.setMeta('adf_runtime_did', keys.runtimeDid, 'readonly')
      }
    }
  }

  // Child of the source in every branch. Overwrites the inherited value (the
  // SOURCE's parent) and re-inserts the row when adf_meta was cleared. setMeta
  // is an upsert whose ON CONFLICT touches only the value, so a kept row keeps
  // the readonly protection stamped at file creation and a re-inserted one
  // gets it from the argument.
  workspace.setMeta('adf_parent_did', source.id, 'readonly')

  return { did: workspace.getDid(), identity, cloneAttested, purgedAttestations, warnings }
}

export interface CloneAdfDeps {
  keys: CloneOwnerKeys
  provisionFreshIdentity: CloneFixupOptions['provisionFreshIdentity']
  /** Runs once the final .adf is in place (fleet refresh / directory tracking). */
  onCreated?: (filePath: string) => void
}

export interface CloneAdfResult {
  filePath: string
  name: string
  /** Final config (new id + name) — the caller marks it reviewed */
  config: AgentConfig
  fixup: CloneFixupResult
}

/**
 * Remove a SQLite file's -wal/-shm siblings, plus the file itself and its
 * migration `.bak` unless `keepMain`. Missing files are fine; other errors
 * are swallowed unless `strict`.
 */
function removeSqliteFiles(path: string, opts: { keepMain?: boolean; strict?: boolean } = {}): void {
  const targets = opts.keepMain
    ? [`${path}-wal`, `${path}-shm`]
    : [path, `${path}-wal`, `${path}-shm`, `${path}.bak`]
  for (const p of targets) {
    try {
      if (existsSync(p)) unlinkSync(p)
    } catch (error) {
      if (opts.strict) throw error
    }
  }
}

/**
 * The whole FILE_CLONE operation: copy → snapshot → clear → rename+id →
 * fixup → checkpoint → close → move into place.
 *
 * Work happens on `<name>.adf.partial` in the same directory: the tracked-dir
 * watcher and autostart filter on the `.adf` suffix, so a half-built clone is
 * never picked up as an agent, and the final rename is atomic on the same
 * volume. Any failure removes the partial (plus -wal/-shm) and rethrows.
 */
export function cloneAdfFile(sourcePath: string, selectedTables: string[], deps: CloneAdfDeps): CloneAdfResult {
  const dir = dirname(sourcePath)
  const originalName = basename(sourcePath, '.adf')
  let newName = `${originalName}_clone`
  let finalPath = join(dir, `${newName}.adf`)
  let counter = 2
  while (existsSync(finalPath)) {
    newName = `${originalName}_clone_${counter}`
    finalPath = join(dir, `${newName}.adf`)
    counter++
  }
  const tempPath = `${finalPath}.partial`

  // A stale partial from a crashed run must not leak into this copy: fail
  // rather than copy over anything we could not remove.
  removeSqliteFiles(tempPath, { strict: true })
  copyFileSync(sourcePath, tempPath, constants.COPYFILE_EXCL)

  let fixup: CloneFixupResult
  let config: AgentConfig
  let workspace: AdfWorkspace | null = null
  try {
    workspace = AdfWorkspace.open(tempPath)
    // The copy is still byte-identical: read the SOURCE's lineage reference
    // (DID, else config.id) before any table is cleared.
    const source = snapshotCloneSource(workspace)
    const selectedSet = new Set(selectedTables)
    clearUnselectedTables(workspace, selectedSet)

    // Rename + new config.id (same generator as AdfDatabase.create) in every
    // branch: the review gate keys on id alone, so a kept-identity clone
    // that inherited the source's id would inherit its reviewed status and
    // could autostart under the source's DID. Nothing else in the file keys
    // on the old id at this point.
    config = workspace.getAgentConfig()
    config.name = newName
    config.id = nanoid(12)
    workspace.setAgentConfig(config)

    fixup = applyCloneFixup(workspace, {
      selectedTables: selectedSet,
      source,
      keys: deps.keys,
      provisionFreshIdentity: deps.provisionFreshIdentity
    })

    // Fold the WAL back so the rename moves a single self-contained file.
    workspace.getDatabase().checkpoint()
    workspace.close()
    workspace = null
    removeSqliteFiles(tempPath, { keepMain: true })

    // Re-check: something may have claimed the name while we worked.
    if (existsSync(finalPath)) throw new Error(`A file named "${basename(finalPath)}" already exists.`)
    renameSync(tempPath, finalPath)
  } catch (error) {
    try { workspace?.close() } catch { /* already closed */ }
    removeSqliteFiles(tempPath)
    throw error
  }

  // The clone is complete once renamed; a failing notifier is a warning, not a failed clone.
  try {
    deps.onCreated?.(finalPath)
  } catch (error) {
    fixup.warnings.push(`Clone created, but the fleet was not notified: ${String(error)}`)
  }
  return { filePath: finalPath, name: newName, config, fixup }
}
