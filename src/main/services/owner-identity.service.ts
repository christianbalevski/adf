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
import { AdfWorkspace } from '../adf/adf-workspace'
import { generateEd25519KeyPair, extractRawPublicKey, publicKeyToDid } from '../crypto/identity-crypto'
import { generateMnemonic, validateMnemonic, deriveOwnerIdentity } from '../crypto/mnemonic-identity'
import { createAttestation, issueOwnerAttestation, verifyAttestation } from './attestation.service'
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

    console.log(`[OwnerIdentity] ${isUpgrade ? 'Migrated to' : 'Created'} key-backed identity — owner ${owner.did}, runtime ${runtimeDid}`)

    if (isUpgrade) {
      const result = this.restampLocalAdfs()
      console.log(`[OwnerIdentity] Restamped ${result.restamped} ADF(s), attested ${result.attested}, ${result.failures.length} failure(s)`)
    }

    return { ownerDid: owner.did, runtimeDid, migrated: isUpgrade }
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
