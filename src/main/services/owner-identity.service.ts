/**
 * Owner Identity Service
 *
 * Manages the app-level identity pair:
 *  - Owner DID: the user. Derived from a BIP-39 mnemonic (SLIP-0010 Ed25519),
 *    so the same mnemonic yields the same owner DID on every machine.
 *  - Runtime DID: this install. Fresh local keypair, NOT seed-derived — the
 *    seed stays cold after setup. The owner key certifies the runtime via a
 *    delegation attestation.
 *
 * Legacy installs (pre-mnemonic) had label-only DIDs whose private keys were
 * discarded at generation. Migration mints a key-backed identity, records the
 * old DIDs in legacy lists, and restamps local ADFs that referenced them.
 */

import { readdirSync } from 'fs'
import { join } from 'path'
import type { AlfAttestation } from '../../shared/types/adf-v02.types'
import { AdfWorkspace, type EnvelopeRecipients } from '../adf/adf-workspace'
import { generateEd25519KeyPair, extractRawPublicKey, publicKeyToDid } from '../crypto/identity-crypto'
import { generateMnemonic, validateMnemonic, deriveOwnerIdentity, deriveOwnerEncryptionKey } from '../crypto/mnemonic-identity'
import { generateX25519KeyPair, extractRawX25519PublicKey } from '../crypto/envelope-crypto'
import { appendAdfAttestation, createAttestation, issueOwnerAttestation, verifyAttestation } from './attestation.service'
import { getReviewedIds } from './agent-review'
import type { SettingsService } from './settings.service'

export interface OwnerIdentityStatus {
  ownerDid: string
  runtimeDid: string
  hasMnemonic: boolean
  backupConfirmed: boolean
  legacyOwnerDids: string[]
  legacyRuntimeDids: string[]
  safeStorageAvailable: boolean
  /** Owner-signed delegation cert for the runtime key, with its verification result. */
  runtimeDelegation: AlfAttestation | null
  runtimeDelegationValid: boolean
}

export interface RestampResult {
  restamped: number
  attested: number
  failures: string[]
}

export class OwnerIdentityService {
  constructor(private settings: SettingsService) {}

  // =========================================================================
  // Identity bootstrap + migration
  // =========================================================================

  /**
   * Ensure a key-backed owner + runtime identity exists. Cases:
   *  1. Fresh install — mint mnemonic + runtime keypair, sign runtime delegation.
   *  2. Upgrade (legacy label-only DIDs) — move old DIDs to legacy lists, mint,
   *     restamp local ADFs.
   *  3. Already migrated — sanity-check the derived DID matches.
   */
  ensureIdentity(): { ownerDid: string; runtimeDid: string; migrated: boolean } {
    const existingOwnerDid = this.settings.get('ownerDid') as string | undefined
    const mnemonic = this.settings.getSecret('ownerMnemonic')

    if (mnemonic) {
      // Already migrated. Sanity-check determinism; never crash the app over it.
      const ownerDid = this.settings.get('ownerDid') as string
      const runtimeDid = this.settings.get('runtimeDid') as string
      try {
        const derived = deriveOwnerIdentity(mnemonic)
        if (derived.did !== ownerDid) {
          console.warn(`[OwnerIdentity] Stored ownerDid ${ownerDid} does not match mnemonic-derived ${derived.did}`)
        }
      } catch (err) {
        console.warn('[OwnerIdentity] Failed to derive owner identity from stored mnemonic:', err)
      }
      this.ensureEncryptionKeys()
      return { ownerDid, runtimeDid, migrated: false }
    }

    const isUpgrade = !!existingOwnerDid
    if (isUpgrade) {
      const legacyOwner = (this.settings.get('legacyOwnerDids') as string[] | undefined) ?? []
      if (!legacyOwner.includes(existingOwnerDid)) {
        this.settings.set('legacyOwnerDids', [...legacyOwner, existingOwnerDid])
      }
      const existingRuntimeDid = this.settings.get('runtimeDid') as string | undefined
      if (existingRuntimeDid) {
        const legacyRuntime = (this.settings.get('legacyRuntimeDids') as string[] | undefined) ?? []
        if (!legacyRuntime.includes(existingRuntimeDid)) {
          this.settings.set('legacyRuntimeDids', [...legacyRuntime, existingRuntimeDid])
        }
      }
    }

    const newMnemonic = generateMnemonic()
    const owner = deriveOwnerIdentity(newMnemonic)
    this.settings.setSecret('ownerMnemonic', newMnemonic)
    this.settings.set('ownerDid', owner.did)
    this.settings.set('ownerSeedBackupConfirmed', false)

    const runtimeDid = this.mintRuntimeKey(owner.privateKeyPkcs8, owner.did)
    this.ensureEncryptionKeys()

    console.log(`[OwnerIdentity] ${isUpgrade ? 'Migrated to' : 'Created'} key-backed identity — owner ${owner.did}, runtime ${runtimeDid}`)

    if (isUpgrade) {
      const result = this.restampLocalAdfs()
      console.log(`[OwnerIdentity] Restamped ${result.restamped} ADF(s), attested ${result.attested}, ${result.failures.length} failure(s)`)
    }

    return { ownerDid: owner.did, runtimeDid, migrated: isUpgrade }
  }

  /**
   * Provision the X25519 encryption keys used for envelope keyslots
   * (ADF_IDENTITY_SPEC D7). Idempotent backfill — runs on every
   * ensureIdentity() so installs migrated before envelopes existed pick
   * them up. Owner: public half derived from the mnemonic and cached in
   * settings (private half re-derived only on the recovery path).
   * Runtime: fresh keypair, private half in safeStorage.
   */
  private ensureEncryptionKeys(): void {
    const mnemonic = this.settings.getSecret('ownerMnemonic')
    if (mnemonic && !this.settings.get('ownerEncPublicKey')) {
      try {
        const enc = deriveOwnerEncryptionKey(mnemonic)
        this.settings.set('ownerEncPublicKey', enc.publicKeyRaw.toString('base64'))
      } catch (err) {
        console.warn('[OwnerIdentity] Failed to derive owner encryption key:', err)
      }
    }
    if (!this.settings.getSecret('runtimeEncPrivateKey')) {
      const kp = generateX25519KeyPair()
      this.settings.setSecret('runtimeEncPrivateKey', kp.privateKey.toString('base64'))
      this.settings.set('runtimeEncPublicKey', extractRawX25519PublicKey(kp.publicKey).toString('base64'))
    }
  }

  /** Generate + persist a fresh runtime keypair and its owner-signed delegation. */
  private mintRuntimeKey(ownerPrivateKey: Buffer, ownerDid: string): string {
    const kp = generateEd25519KeyPair()
    const runtimeDid = publicKeyToDid(extractRawPublicKey(kp.publicKey))
    this.settings.setSecret('runtimePrivateKey', kp.privateKey.toString('base64'))
    this.settings.set('runtimeDid', runtimeDid)
    const delegation = createAttestation(
      { issuer: ownerDid, subject: runtimeDid, role: 'runtime', issued_at: new Date().toISOString() },
      ownerPrivateKey
    )
    this.settings.set('runtimeDelegation', delegation)
    return runtimeDid
  }

  // =========================================================================
  // Key access
  // =========================================================================

  getOwnerDid(): string {
    return (this.settings.get('ownerDid') as string) ?? ''
  }

  getRuntimeDid(): string {
    return (this.settings.get('runtimeDid') as string) ?? ''
  }

  /** Derive the owner signing key from the mnemonic on demand. Never cached to disk. */
  getOwnerSigningKey(): Buffer | null {
    const mnemonic = this.settings.getSecret('ownerMnemonic')
    if (!mnemonic) return null
    try {
      return deriveOwnerIdentity(mnemonic).privateKeyPkcs8
    } catch {
      return null
    }
  }

  getRuntimeSigningKey(): Buffer | null {
    const b64 = this.settings.getSecret('runtimePrivateKey')
    return b64 ? Buffer.from(b64, 'base64') : null
  }

  getRuntimeDelegation(): AlfAttestation | null {
    return (this.settings.get('runtimeDelegation') as AlfAttestation | undefined) ?? null
  }

  /** Owner X25519 encryption public key (raw 32 bytes) — all that's needed to write owner slots. */
  getOwnerEncPublicKey(): Buffer | null {
    const b64 = this.settings.get('ownerEncPublicKey') as string | undefined
    return b64 ? Buffer.from(b64, 'base64') : null
  }

  /** Derive the owner X25519 private key from the mnemonic. Recovery path only; never cached. */
  getOwnerEncPrivateKey(): Buffer | null {
    const mnemonic = this.settings.getSecret('ownerMnemonic')
    if (!mnemonic) return null
    try {
      return deriveOwnerEncryptionKey(mnemonic).privateKeyPkcs8
    } catch {
      return null
    }
  }

  /** Runtime X25519 encryption private key (PKCS8 DER) — day-to-day envelope unwrapping. */
  getRuntimeEncPrivateKey(): Buffer | null {
    const b64 = this.settings.getSecret('runtimeEncPrivateKey')
    return b64 ? Buffer.from(b64, 'base64') : null
  }

  /** Runtime X25519 encryption public key (raw 32 bytes). */
  getRuntimeEncPublicKey(): Buffer | null {
    const b64 = this.settings.get('runtimeEncPublicKey') as string | undefined
    return b64 ? Buffer.from(b64, 'base64') : null
  }

  // =========================================================================
  // Backup / import
  // =========================================================================

  getStatus(): OwnerIdentityStatus {
    const runtimeDelegation = this.getRuntimeDelegation()
    return {
      ownerDid: this.getOwnerDid(),
      runtimeDid: this.getRuntimeDid(),
      hasMnemonic: !!this.settings.getSecret('ownerMnemonic'),
      backupConfirmed: !!this.settings.get('ownerSeedBackupConfirmed'),
      legacyOwnerDids: (this.settings.get('legacyOwnerDids') as string[] | undefined) ?? [],
      legacyRuntimeDids: (this.settings.get('legacyRuntimeDids') as string[] | undefined) ?? [],
      safeStorageAvailable: this.settings.isSafeStorageAvailable(),
      runtimeDelegation,
      runtimeDelegationValid: !!runtimeDelegation && verifyAttestation(runtimeDelegation, { expectedSubject: this.getRuntimeDid() })
    }
  }

  revealMnemonic(): string | null {
    return this.settings.getSecret('ownerMnemonic')
  }

  confirmBackup(): void {
    this.settings.set('ownerSeedBackupConfirmed', true)
  }

  /**
   * Replace the owner identity with one derived from an imported mnemonic.
   * The current owner DID joins the legacy list so local files converge to the
   * imported identity via restamp. Runtime delegation is re-signed.
   */
  importMnemonic(mnemonic: string): { ownerDid: string } & RestampResult {
    const normalized = mnemonic.trim().toLowerCase().replace(/\s+/g, ' ')
    if (!validateMnemonic(normalized)) {
      throw new Error('Invalid mnemonic phrase')
    }

    const currentOwnerDid = this.getOwnerDid()
    const owner = deriveOwnerIdentity(normalized)

    if (currentOwnerDid && currentOwnerDid !== owner.did) {
      const legacy = (this.settings.get('legacyOwnerDids') as string[] | undefined) ?? []
      if (!legacy.includes(currentOwnerDid)) {
        this.settings.set('legacyOwnerDids', [...legacy, currentOwnerDid])
      }
    }

    this.settings.setSecret('ownerMnemonic', normalized)
    this.settings.set('ownerDid', owner.did)
    this.settings.set('ownerSeedBackupConfirmed', true) // imported = user has the phrase

    // New owner → new encryption key; overwrite unconditionally (runtime enc key is kept).
    try {
      const enc = deriveOwnerEncryptionKey(normalized)
      this.settings.set('ownerEncPublicKey', enc.publicKeyRaw.toString('base64'))
    } catch (err) {
      console.warn('[OwnerIdentity] Failed to derive owner encryption key on import:', err)
    }
    this.ensureEncryptionKeys()

    // Re-sign the runtime delegation under the new owner (keep the runtime key).
    const runtimeDid = this.getRuntimeDid()
    if (runtimeDid) {
      const delegation = createAttestation(
        { issuer: owner.did, subject: runtimeDid, role: 'runtime', issued_at: new Date().toISOString() },
        owner.privateKeyPkcs8
      )
      this.settings.set('runtimeDelegation', delegation)
    }

    const result = this.restampLocalAdfs()
    console.log(`[OwnerIdentity] Imported identity ${owner.did} — restamped ${result.restamped}, ${result.failures.length} failure(s)`)
    return { ownerDid: owner.did, ...result }
  }

  // =========================================================================
  // Workspace identity provisioning + envelope migration (spec D1/D10/§8)
  // =========================================================================

  /** Recipient bundle for envelope keyslots; null when enc keys are unavailable (D14). */
  private getEnvelopeRecipients(): EnvelopeRecipients | null {
    const ownerDid = this.getOwnerDid()
    const runtimeDid = this.getRuntimeDid()
    const ownerEncPublicKey = this.getOwnerEncPublicKey()
    const runtimeEncPublicKey = this.getRuntimeEncPublicKey()
    if (!ownerDid || !runtimeDid || !ownerEncPublicKey || !runtimeEncPublicKey) return null
    return { ownerDid, ownerEncPublicKey, runtimeDid, runtimeEncPublicKey }
  }

  /**
   * D10 unwrap cascade with this install's keys. The owner (mnemonic-derived)
   * key is only touched when the runtime slot fails, and a successful owner
   * unlock re-wraps a runtime slot so the seed is needed at most once per
   * file per machine.
   */
  unlockWorkspaceEnvelopes(workspace: AdfWorkspace): void {
    if (!workspace.hasEnvelopes()) return
    const states = workspace.unlockEnvelopes({ runtimeEncPrivateKey: this.getRuntimeEncPrivateKey() })
    if (states.identity !== 'unlocked' || states.credentials !== 'unlocked') {
      const ownerKey = this.getOwnerEncPrivateKey()
      if (!ownerKey) return
      const runtimeEncPub = this.getRuntimeEncPublicKey()
      workspace.unlockEnvelopes({
        ownerEncPrivateKey: ownerKey,
        reWrapRuntime: runtimeEncPub ? { did: this.getRuntimeDid(), encPublicKey: runtimeEncPub } : undefined
      })
    }
  }

  /**
   * Idempotent identity provisioning/migration for one workspace:
   *  - no envelopes → provision them (D5/D6); existing envelopes → unlock (D10)
   *  - no signing keys → generate (sealed when the envelope unlocked), stamp
   *    owner/runtime DIDs, issue attestations (D1)
   *  - plain secret rows → seal under their envelope (§8 migration)
   * Password-locked files are skipped entirely (converted on unlock, later
   * phase). Serves both creation paths and the boot/lazy migration sweep.
   *
   * mintKeys: false = unlock-only. An unreviewed file must not be mutated —
   * a stripped-identity file is untrusted (anyone can strip and reshare), and
   * stamping our owner DID into it before the user accepts review would make
   * rejection meaningless. Minting happens on review-accept instead.
   */
  ensureWorkspaceIdentity(
    workspace: AdfWorkspace,
    opts: { mintKeys?: boolean } = {}
  ): { keysGenerated: boolean; sealed: number } {
    if (workspace.isPasswordProtected()) return { keysGenerated: false, sealed: 0 }
    if (opts.mintKeys === false) {
      this.unlockWorkspaceEnvelopes(workspace)
      return { keysGenerated: false, sealed: 0 }
    }

    const recipients = this.getEnvelopeRecipients()
    if (recipients) {
      if (!workspace.hasEnvelopes()) workspace.provisionEnvelopes(recipients)
      else this.unlockWorkspaceEnvelopes(workspace)
    } else {
      console.warn('[OwnerIdentity] Envelope keys unavailable — provisioning identity without envelopes')
    }

    let keysGenerated = false
    if (workspace.getIdentityRow('crypto:signing:private_key') === null) {
      workspace.generateIdentityKeys(null)
      keysGenerated = true
      if (!workspace.getMeta('adf_owner_did')) workspace.setMeta('adf_owner_did', this.getOwnerDid(), 'readonly')
      if (!workspace.getMeta('adf_runtime_did')) workspace.setMeta('adf_runtime_did', this.getRuntimeDid(), 'readonly')
      issueOwnerAttestation(workspace, {
        ownerDid: this.getOwnerDid(),
        ownerPrivateKey: this.getOwnerSigningKey(),
        runtimeDid: this.getRuntimeDid(),
        runtimePrivateKey: this.getRuntimeSigningKey()
      })
    }

    const sealed = workspace.sealPlainRowsIntoEnvelopes()
    return { keysGenerated, sealed }
  }

  /**
   * Claim a workspace for the local owner (D11): wipe any prior signing keys
   * and their identity envelope, stamp owner/runtime, mint a fresh identity,
   * and — when there was a prior DID — record a clone attestation as
   * provenance. The credentials envelope is untouched: its rows stay foreign
   * until unlocked (e.g. via a share password) rather than being orphaned.
   * Also the adoption path for identity-less files (previousDid null → the
   * wipe is a no-op and no clone attestation is recorded).
   */
  claimWorkspace(workspace: AdfWorkspace): { did: string | null } {
    const db = workspace.getDatabase()
    const previousDid = workspace.getDid()
    db.deleteIdentity('crypto:signing:private_key')
    db.deleteIdentity('crypto:signing:public_key')
    db.deleteIdentity('crypto:envelope:identity')
    db.setMeta('adf_owner_did', this.getOwnerDid(), 'readonly')
    db.setMeta('adf_runtime_did', this.getRuntimeDid(), 'readonly')
    // Fresh identity envelope + sealed keys + attestations (old DID lands in
    // adf_did_history via generateIdentityKeys)
    this.ensureWorkspaceIdentity(workspace)
    const newDid = workspace.getDid()
    const ownerKey = this.getOwnerSigningKey()
    if (previousDid && newDid && ownerKey) {
      appendAdfAttestation(workspace, createAttestation(
        { issuer: this.getOwnerDid(), subject: newDid, role: 'clone', issued_at: new Date().toISOString(), scope: previousDid },
        ownerKey
      ))
    }
    return { did: newDid }
  }

  /**
   * Boot sweep (§8): provision/seal every tracked .adf, mirroring
   * restampLocalAdfs. Idempotent — files already fully migrated are detected
   * cheaply and skipped before any key material is touched. Failures are
   * reported and retried next launch / lazy open.
   *
   * Unreviewed files are left untouched: a file someone dropped into a
   * tracked directory must go through review + claim before we stamp
   * ownership or seal anything into our envelopes.
   */
  sweepEnvelopeMigration(): { provisioned: number; sealed: number; failures: string[] } {
    const result = { provisioned: 0, sealed: 0, failures: [] as string[] }
    if (!this.getEnvelopeRecipients()) return result

    const maxDepth = (this.settings.get('maxDirectoryScanDepth') as number) ?? 5
    const tracked = (this.settings.get('trackedDirectories') as string[] | undefined) ?? []
    const files: string[] = []
    for (const dir of tracked) {
      try {
        collectAdfFiles(dir, maxDepth, 0, files)
      } catch (err) {
        result.failures.push(`${dir}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    const reviewedIds = new Set(getReviewedIds(this.settings.get('reviewedAgents')))

    for (const filePath of files) {
      try {
        const workspace = AdfWorkspace.open(filePath)
        try {
          if (workspace.isPasswordProtected()) continue
          // Fast path: envelopes present, keys present, nothing plain to seal
          if (
            workspace.hasEnvelopes() &&
            workspace.getIdentityRow('crypto:signing:private_key') !== null &&
            !workspace.hasUnsealedSecrets()
          ) continue
          if (!reviewedIds.has(workspace.getAgentConfig().id)) continue
          const { keysGenerated, sealed } = this.ensureWorkspaceIdentity(workspace)
          if (keysGenerated) result.provisioned++
          result.sealed += sealed
        } finally {
          workspace.close()
        }
      } catch (err) {
        result.failures.push(`${filePath}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return result
  }

  // =========================================================================
  // Restamp
  // =========================================================================

  /**
   * Rewrite adf_owner_did / adf_runtime_did in every tracked .adf whose value
   * is a legacy DID, and re-issue owner attestations for files with an agent
   * DID. Idempotent (membership test against legacy lists). Files that are
   * busy or unreadable are reported and retried on next launch / lazy open.
   */
  restampLocalAdfs(): RestampResult {
    const result: RestampResult = { restamped: 0, attested: 0, failures: [] }
    const maxDepth = (this.settings.get('maxDirectoryScanDepth') as number) ?? 5
    const tracked = (this.settings.get('trackedDirectories') as string[] | undefined) ?? []

    const files: string[] = []
    for (const dir of tracked) {
      try {
        collectAdfFiles(dir, maxDepth, 0, files)
      } catch (err) {
        result.failures.push(`${dir}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    for (const filePath of files) {
      try {
        const workspace = AdfWorkspace.open(filePath)
        try {
          const { restamped, attested } = this.restampAndAttest(workspace)
          if (restamped) result.restamped++
          if (attested) result.attested++
        } finally {
          workspace.close()
        }
      } catch (err) {
        result.failures.push(`${filePath}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return result
  }

  /**
   * Restamp + re-attest a single already-open workspace if its owner/runtime
   * DID is legacy. Also the lazy fallback on FILE_OPEN for files outside
   * tracked directories or busy during boot migration.
   */
  restampAndAttest(workspace: AdfWorkspace): { restamped: boolean; attested: boolean } {
    const legacyOwner = (this.settings.get('legacyOwnerDids') as string[] | undefined) ?? []
    const legacyRuntime = (this.settings.get('legacyRuntimeDids') as string[] | undefined) ?? []
    let restamped = false

    const fileOwner = workspace.getMeta('adf_owner_did')
    if (fileOwner && legacyOwner.includes(fileOwner)) {
      workspace.setMeta('adf_owner_did', this.getOwnerDid(), 'readonly')
      restamped = true
    }
    const fileRuntime = workspace.getMeta('adf_runtime_did')
    if (fileRuntime && legacyRuntime.includes(fileRuntime)) {
      workspace.setMeta('adf_runtime_did', this.getRuntimeDid(), 'readonly')
      restamped = true
    }

    let attested = false
    if (restamped && workspace.getDid()) {
      const issued = issueOwnerAttestation(workspace, {
        ownerDid: this.getOwnerDid(),
        ownerPrivateKey: this.getOwnerSigningKey(),
        runtimeDid: this.getRuntimeDid(),
        runtimePrivateKey: this.getRuntimeSigningKey()
      })
      attested = issued.length > 0
    }
    return { restamped, attested }
  }
}

/** Recursively collect .adf file paths, mirroring the tracked-directory scan rules. */
function collectAdfFiles(dir: string, maxDepth: number, depth: number, out: string[]): void {
  if (depth > maxDepth) return
  const entries = readdirSync(dir, { withFileTypes: true })
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith('.adf')) {
      out.push(join(dir, e.name))
    } else if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
      collectAdfFiles(join(dir, e.name), maxDepth, depth + 1, out)
    }
  }
}
