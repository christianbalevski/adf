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
import { readdir } from 'fs/promises'
import { join } from 'path'
import type { AlfAttestation } from '../../shared/types/adf-v02.types'
import { AdfWorkspace, type EnvelopeRecipients } from '../adf/adf-workspace'
import { AdfDatabase } from '../adf/adf-database'
import { generateEd25519KeyPair, extractRawPublicKey, publicKeyToDid } from '../crypto/identity-crypto'
import { generateMnemonic, validateMnemonic, deriveOwnerIdentity, deriveOwnerEncryptionKey } from '../crypto/mnemonic-identity'
import { generateX25519KeyPair, extractRawX25519PublicKey, openKeySlot, type KeySlotRecord } from '../crypto/envelope-crypto'
import { daemonEncKeyLabel } from '../daemon/daemon-enc-key'
import { appendAdfAttestation, createAttestation, issueOwnerAttestation, readAdfAttestations, verifyAttestation } from './attestation.service'
import { getReviewedIds } from './agent-review'
import type { SettingsService } from './settings.service'
import type { SharedMnemonicStore } from './owner-secret-store'

/**
 * The slice of settings the identity service needs. SettingsService (Studio,
 * safeStorage-backed) and the daemon's DaemonIdentitySettings (keychain or
 * passphrase file) both provide it.
 */
export type OwnerIdentitySettings = Pick<
  SettingsService,
  'get' | 'set' | 'getSecret' | 'setSecret' | 'secretStatus' | 'isSafeStorageAvailable'
>

export interface OwnerIdentityStatus {
  ownerDid: string
  runtimeDid: string
  hasMnemonic: boolean
  /** A mnemonic blob exists but cannot be decrypted (keychain denied/changed). */
  mnemonicLocked: boolean
  /**
   * The owner DID on record comes from a seed phrase this install cannot read
   * (e.g. created by the headless daemon into its passphrase file). Nothing is
   * minted; the user restores it with the same 12 words.
   */
  restoreRequired: boolean
  backupConfirmed: boolean
  legacyOwnerDids: string[]
  legacyRuntimeDids: string[]
  safeStorageAvailable: boolean
  /** Owner-signed delegation cert for the runtime key, with its verification result. */
  runtimeDelegation: AlfAttestation | null
  runtimeDelegationValid: boolean
}

/**
 * Settings flag: `ownerDid` was derived from a BIP-39 phrase (set by Studio
 * and the daemon whenever they mint, import or adopt one). Legacy label-only
 * DIDs never carry it; see OwnerIdentityService.ownerIsSeedDerived.
 */
export const OWNER_SEED_DERIVED_KEY = 'ownerDidSeedDerived'

/**
 * Secret settings key holding a previous owner's phrase after an owner switch
 * made outside this install: `ownerMnemonicSuperseded:<that owner's DID>`,
 * same `safe:` encoding as `ownerMnemonic`, one key per owner so a later
 * switch never overwrites it. Kept so the phrase stays recoverable; never
 * shown, never used to sign.
 */
export function ownerMnemonicSupersededKey(ownerDid: string): string {
  return `ownerMnemonicSuperseded:${ownerDid}`
}

export interface RestampResult {
  restamped: number
  attested: number
  failures: string[]
  /** Files `skip` left out (another runtime runs them); restamped when next opened. Present only when a `skip` was given. */
  skipped?: string[]
}

/** How long minting an agent's identity waits for another connection's write lock (an interactive open). */
export const PROVISION_BUSY_TIMEOUT_MS = 100
/** The boot sweep's wait: a busy file is a named failure, retried at the next boot or open. */
export const SWEEP_BUSY_TIMEOUT_MS = 25

/** What one boot envelope sweep did (sweepEnvelopeMigration). */
export interface EnvelopeSweepResult {
  /** Files that got signing keys (and a DID and attestations). */
  provisioned: number
  /** Plain secret rows sealed under their envelope. */
  sealed: number
  /** `<path>: <error>` per file (or folder) that failed; retried at the next boot or open. */
  failures: string[]
  /** Files left alone: open or running in this process, or run by another runtime. */
  skipped: string[]
  /** No owner identity to provision with: nothing was opened. */
  ownerNotReady?: true
}

/** The sweep's log line, the same in both modes; null when it did nothing. Failures are named with their paths. */
export function describeEnvelopeSweep(sweep: EnvelopeSweepResult, ms: number): string | null {
  if (sweep.ownerNotReady) return '[OwnerIdentity] Envelope sweep skipped: the owner identity is not ready, so no tracked agent was provisioned'
  if (!sweep.provisioned && !sweep.sealed && !sweep.failures.length && !sweep.skipped.length) return null
  return `[OwnerIdentity] Envelope sweep: ${sweep.provisioned} provisioned, ${sweep.sealed} rows sealed, ${sweep.failures.length} failure(s)` +
    `${sweep.skipped.length ? `, ${sweep.skipped.length} open here or run by another runtime (provisioned when next opened)` : ''} in ${ms.toFixed(0)}ms` +
    `${sweep.failures.length ? ` — failed (retried at the next boot or open): ${sweep.failures.join('; ')}` : ''}`
}

export class OwnerIdentityService {
  private sharedMnemonic: SharedMnemonicStore | null = null
  private readonly manageTrustedDaemonSlots: boolean
  private readonly ownerDidOnDisk: (() => unknown) | null

  constructor(
    private settings: OwnerIdentitySettings,
    opts: {
      /**
       * Enroll/revoke `daemon:*` credentials slots from `trustedDaemonEncKeys`.
       * Studio only: it owns that list. A daemon reading a different settings
       * file would otherwise strip slots Studio added.
       */
      manageTrustedDaemonSlots?: boolean
      /**
       * `ownerDid` as the settings file on disk holds it now (Studio: another
       * writer, the daemon's owner import, may have changed it since this
       * process read it). Checked before the phrase is mirrored.
       */
      ownerDidOnDisk?: () => unknown
    } = {}
  ) {
    this.manageTrustedDaemonSlots = opts.manageTrustedDaemonSlots ?? true
    this.ownerDidOnDisk = opts.ownerDidOnDisk ?? null
  }

  /**
   * Studio: the OS-keychain entry the daemon reads the owner phrase from.
   * Studio mirrors its phrase into it, and imports from it when it has an
   * owner DID but cannot read its own copy (same machine, identity created or
   * restored in the CLI/daemon). Never set in the daemon, whose settings
   * adapter already reads that entry directly.
   */
  setSharedMnemonicStore(store: SharedMnemonicStore | null): void {
    this.sharedMnemonic = store
  }

  /**
   * Copy the phrase into the shared keychain entry when it differs. Never
   * throws. A phrase that does not derive the owner DID on record is never
   * mirrored: after an owner switch made outside this app (adf identity
   * import) it would overwrite the new owner's phrase, the only copy on this
   * machine. The owner on record is re-read from disk first: a switch made
   * while this process runs is not in its copy of the settings yet.
   */
  private mirrorToSharedStore(mnemonic: string): void {
    if (!this.sharedMnemonic) return
    let onDisk: unknown
    try { onDisk = this.ownerDidOnDisk?.() } catch { onDisk = undefined }
    if (typeof onDisk === 'string' && onDisk !== '' && onDisk !== this.getOwnerDid()) {
      console.warn(`[OwnerIdentity] Not mirroring this install's owner phrase into the OS keychain: the settings file now names the owner ${onDisk}, not ${this.getOwnerDid()} (switched outside this app, e.g. adf identity import). Restart ADF Studio to follow the switch.`)
      return
    }
    if (!phraseDerives(mnemonic, this.getOwnerDid())) {
      console.warn(`[OwnerIdentity] Not mirroring this install's owner phrase into the OS keychain: it does not belong to this machine's owner ${this.getOwnerDid()}`)
      return
    }
    try {
      if (this.sharedMnemonic.read() !== mnemonic) this.sharedMnemonic.write(mnemonic)
    } catch (err) {
      console.warn('[OwnerIdentity] Could not mirror the owner phrase into the OS keychain:', err instanceof Error ? err.message : err)
    }
  }

  /**
   * Take the owner phrase from the shared keychain entry when this install
   * cannot read its own. Only a phrase that derives the owner DID already on
   * record is taken (or any valid phrase on a fresh install with no owner
   * DID yet). Returns the adopted phrase, or null.
   */
  private importFromSharedStore(currentOwnerDid: string | undefined, opts: { replacingStale?: string } = {}): string | null {
    if (!this.sharedMnemonic) return null
    // Without safeStorage, setSecret would write the phrase to the settings
    // file in plaintext. Keep Studio's previous behavior instead.
    if (!this.settings.isSafeStorageAvailable()) return null
    let phrase: string | null
    try {
      phrase = this.sharedMnemonic.read()
    } catch {
      return null
    }
    if (!phrase || !validateMnemonic(phrase)) return null
    const owner = deriveOwnerIdentity(phrase)
    if (currentOwnerDid && owner.did !== currentOwnerDid) {
      console.warn(`[OwnerIdentity] The OS keychain holds the phrase for ${owner.did}, not this install's owner ${currentOwnerDid} — not importing it.`)
      return null
    }
    const staleOwner = opts.replacingStale ? derivedDid(opts.replacingStale) : null
    if (opts.replacingStale && staleOwner) {
      // Never destroyed: the previous owner's phrase stays recoverable.
      const key = ownerMnemonicSupersededKey(staleOwner)
      this.settings.setSecret(key, opts.replacingStale)
      console.log(`[OwnerIdentity] Kept this install's phrase of the previous owner ${staleOwner} as ${key}`)
    }
    this.settings.setSecret('ownerMnemonic', phrase)
    if (!currentOwnerDid) {
      this.settings.set('ownerDid', owner.did)
      this.settings.set('ownerSeedBackupConfirmed', false)
    }
    this.markSeedDerived()
    console.log(opts.replacingStale
      ? `[OwnerIdentity] The owner is now ${owner.did} (switched outside this app, e.g. adf identity import): replaced this install's phrase of the previous owner with the one in the OS keychain`
      : `[OwnerIdentity] Imported owner phrase for ${owner.did} from the OS keychain`)
    return phrase
  }

  // =========================================================================
  // Identity bootstrap + migration
  // =========================================================================

  /**
   * Ensure a key-backed owner + runtime identity exists. Cases:
   *  1. Fresh install — mint mnemonic + runtime keypair, sign runtime delegation.
   *  2. Upgrade (legacy label-only DIDs) — move old DIDs to legacy lists, mint,
   *     restamp local ADFs.
   *  3. Already migrated — sanity-check the derived DID matches.
   *  4. Locked — a mnemonic blob exists but will not decrypt. Refuse to do
   *     anything: minting here would silently rotate the owner DID and
   *     overwrite a blob that is very likely still recoverable.
   */
  ensureIdentity(): { ownerDid: string; runtimeDid: string; migrated: boolean } {
    const existingOwnerDid = this.settings.get('ownerDid') as string | undefined
    // Own copy first; else the phrase the CLI/daemon put in the OS keychain
    // (same owner DID only — see importFromSharedStore).
    let mnemonic = this.settings.getSecret('ownerMnemonic')
    // Own copy of ANOTHER owner. Taken over only for a recorded switch made
    // outside this app (the daemon's import puts the previous owner into
    // legacyOwnerDids and the new phrase into the keychain): an ownerDid that
    // is merely wrong (hand edit, settings copied from elsewhere) must never
    // cost this install its own phrase. ensureRuntimeKey below then re-signs
    // this runtime's delegation under the new owner.
    if (mnemonic && existingOwnerDid && !phraseDerives(mnemonic, existingOwnerDid)) {
      const staleOwner = derivedDid(mnemonic)
      const legacy = (this.settings.get('legacyOwnerDids') as string[] | undefined) ?? []
      if (staleOwner && legacy.includes(staleOwner)) {
        mnemonic = this.importFromSharedStore(existingOwnerDid, { replacingStale: mnemonic }) ?? mnemonic
      } else {
        console.warn(
          `[OwnerIdentity] This install's phrase belongs to ${staleOwner ?? '(unreadable)'}, but the settings name the owner ${existingOwnerDid}, ` +
          'and no owner switch from it is recorded (legacyOwnerDids). Keeping this install\'s phrase; check ownerDid in the settings file.'
        )
      }
    }
    mnemonic = mnemonic ?? this.importFromSharedStore(existingOwnerDid)

    if (mnemonic) {
      // Already migrated. Sanity-check determinism; never crash the app over it.
      const ownerDid = this.settings.get('ownerDid') as string
      try {
        const derived = deriveOwnerIdentity(mnemonic)
        if (derived.did !== ownerDid) {
          console.warn(`[OwnerIdentity] Stored ownerDid ${ownerDid} does not match mnemonic-derived ${derived.did}`)
        } else {
          // Backfill for installs from before the marker existed.
          this.markSeedDerived()
        }
      } catch (err) {
        console.warn('[OwnerIdentity] Failed to derive owner identity from stored mnemonic:', err)
      }
      this.ensureEncryptionKeys()
      // Backfill only: a phrase adopted from the keychain on a fresh install
      // arrives without a runtime key of this install's own.
      this.ensureRuntimeKey()
      this.mirrorToSharedStore(mnemonic)
      const runtimeDid = this.settings.get('runtimeDid') as string
      return { ownerDid, runtimeDid, migrated: false }
    }

    // A null mnemonic means "unreadable" as often as it means "never existed".
    // Before minting anything, make sure the stored blob really is gone —
    // otherwise a denied keychain would cost the user their owner identity.
    if (this.settings.secretStatus('ownerMnemonic') === 'locked') {
      console.error(
        '[OwnerIdentity] Owner mnemonic is present but cannot be decrypted — safeStorage/keychain access was ' +
        'denied or changed (unsigned rebuild, moved profile, new login keychain). ' +
        'REFUSING to mint a new identity: doing so would rotate the owner DID and overwrite the existing, ' +
        'likely still recoverable, encrypted mnemonic. ' +
        'Fix: restore keychain access for this app (or reinstall the signed build), or import your backed-up ' +
        'recovery phrase to re-establish the identity.'
      )
      return {
        ownerDid: existingOwnerDid ?? '',
        runtimeDid: (this.settings.get('runtimeDid') as string | undefined) ?? '',
        migrated: false
      }
    }

    // A seed-derived owner whose phrase this install cannot read (created by
    // the headless daemon/CLI into its passphrase file, or settings carried
    // over from another machine) is NOT a legacy label-only DID. Minting here
    // would silently replace the owner and restamp every local agent. Leave it
    // alone; getStatus() reports restoreRequired and the UI asks for the
    // 12 words (Settings → Identity → Restore).
    if (existingOwnerDid && this.ownerIsSeedDerived()) {
      console.warn(
        `[OwnerIdentity] Owner ${existingOwnerDid} comes from a seed phrase this install cannot read ` +
        '(e.g. created by the ADF daemon/CLI with a passphrase-protected identity file). ' +
        'NOT minting a new owner — restore it with its 12 words (Settings → Identity → Restore identity).'
      )
      return {
        ownerDid: existingOwnerDid,
        runtimeDid: (this.settings.get('runtimeDid') as string | undefined) ?? '',
        migrated: false
      }
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
    this.settings.set(OWNER_SEED_DERIVED_KEY, true)
    this.settings.set('ownerSeedBackupConfirmed', false)

    const runtimeDid = this.mintRuntimeKey(owner.privateKeyPkcs8, owner.did)
    this.ensureEncryptionKeys()
    this.mirrorToSharedStore(newMnemonic)

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
    // Same trap as the mnemonic: only a genuinely absent key gets minted. A
    // locked one still matches every envelope keyslot written with it, so
    // replacing it would orphan them for good.
    const encStatus = this.settings.secretStatus('runtimeEncPrivateKey')
    if (encStatus === 'absent') {
      const kp = generateX25519KeyPair()
      this.settings.setSecret('runtimeEncPrivateKey', kp.privateKey.toString('base64'))
      this.settings.set('runtimeEncPublicKey', extractRawX25519PublicKey(kp.publicKey).toString('base64'))
    } else if (encStatus === 'locked') {
      console.warn(
        '[OwnerIdentity] Runtime encryption key exists but cannot be decrypted — keeping it (and its public half) ' +
        'untouched. Envelopes stay locked until keychain access is restored.'
      )
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

  /**
   * Make sure this install has a runtime signing key certified by the current
   * owner: mint one when absent, re-sign the delegation when it is missing,
   * invalid, or issued by another owner. Needs the owner key; a locked
   * runtime key is never replaced. Returns the runtime DID, or null.
   */
  ensureRuntimeKey(): string | null {
    const ownerDid = this.getOwnerDid()
    const mnemonic = this.settings.getSecret('ownerMnemonic')
    if (!ownerDid || !mnemonic) return null
    let ownerKey: Buffer
    try {
      const owner = deriveOwnerIdentity(mnemonic)
      // Inconsistent store (see ensureIdentity's sanity warning): signing a
      // delegation here would certify under the wrong key.
      if (owner.did !== ownerDid) return this.getRuntimeDid() || null
      ownerKey = owner.privateKeyPkcs8
    } catch {
      return null
    }
    const keyStatus = this.settings.secretStatus('runtimePrivateKey')
    if (keyStatus === 'locked') return this.getRuntimeDid() || null
    const runtimeDid = this.getRuntimeDid()
    if (!runtimeDid || keyStatus === 'absent') return this.mintRuntimeKey(ownerKey, ownerDid)
    const delegation = this.getRuntimeDelegation()
    if (!delegation || delegation.issuer !== ownerDid || !verifyAttestation(delegation, { expectedSubject: runtimeDid })) {
      this.settings.set('runtimeDelegation', createAttestation(
        { issuer: ownerDid, subject: runtimeDid, role: 'runtime', issued_at: new Date().toISOString() },
        ownerKey
      ))
    }
    return runtimeDid
  }

  /** Record that `ownerDid` is seed-derived (idempotent; no write when already set). */
  private markSeedDerived(): void {
    if (this.settings.get(OWNER_SEED_DERIVED_KEY) !== true) this.settings.set(OWNER_SEED_DERIVED_KEY, true)
  }

  /**
   * Whether the owner DID on record comes from a seed phrase (as opposed to a
   * pre-mnemonic, label-only legacy DID). The explicit flag, or — for installs
   * from before it — any value that only ever exists next to a seed-derived
   * owner: its encryption public key, a runtime delegation it signed, or the
   * backup flag written when the phrase was minted.
   */
  ownerIsSeedDerived(): boolean {
    if (this.settings.get(OWNER_SEED_DERIVED_KEY) === true) return true
    return typeof this.settings.get('ownerEncPublicKey') === 'string'
      || !!this.settings.get('runtimeDelegation')
      || !!this.settings.get('daemonRuntimeDelegation')
      || typeof this.settings.get('ownerSeedBackupConfirmed') === 'boolean'
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

  /**
   * Derive the owner signing key from the mnemonic on demand. Never cached to
   * disk. Null when the stored phrase belongs to another owner than the DID
   * on record: its attestations would name one owner and be signed by
   * another, and never verify.
   */
  getOwnerSigningKey(): Buffer | null {
    const mnemonic = this.settings.getSecret('ownerMnemonic')
    if (!mnemonic) return null
    try {
      const owner = deriveOwnerIdentity(mnemonic)
      return owner.did === this.getOwnerDid() ? owner.privateKeyPkcs8 : null
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
    const hasMnemonic = !!this.settings.getSecret('ownerMnemonic')
    const mnemonicLocked = this.settings.secretStatus('ownerMnemonic') === 'locked'
    return {
      ownerDid: this.getOwnerDid(),
      runtimeDid: this.getRuntimeDid(),
      hasMnemonic,
      mnemonicLocked,
      restoreRequired: !hasMnemonic && !mnemonicLocked && !!this.getOwnerDid() && this.ownerIsSeedDerived(),
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
  importMnemonic(mnemonic: string, opts: { expectedOwnerDid?: string; skipRestamp?: (filePath: string) => boolean } = {}): { ownerDid: string } & RestampResult {
    const normalized = mnemonic.trim().toLowerCase().replace(/\s+/g, ' ')
    if (!validateMnemonic(normalized)) {
      throw new Error('Invalid mnemonic phrase')
    }

    const currentOwnerDid = this.getOwnerDid()
    const owner = deriveOwnerIdentity(normalized)
    // Restore (not switch): only the phrase of the owner on record is taken.
    if (opts.expectedOwnerDid && owner.did !== opts.expectedOwnerDid) {
      throw new Error(`That phrase belongs to ${owner.did}, not this machine's owner ${opts.expectedOwnerDid}. Check the words, or use Import identity to switch owners.`)
    }

    if (currentOwnerDid && currentOwnerDid !== owner.did) {
      const legacy = (this.settings.get('legacyOwnerDids') as string[] | undefined) ?? []
      if (!legacy.includes(currentOwnerDid)) {
        this.settings.set('legacyOwnerDids', [...legacy, currentOwnerDid])
      }
    }

    this.settings.setSecret('ownerMnemonic', normalized)
    this.settings.set('ownerDid', owner.did)
    this.settings.set(OWNER_SEED_DERIVED_KEY, true)
    this.settings.set('ownerSeedBackupConfirmed', true) // imported = user has the phrase
    this.mirrorToSharedStore(normalized)

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
    // No runtime key yet (headless restore on a fresh machine): mint one.
    this.ensureRuntimeKey()

    const result = this.restampLocalAdfs(opts.skipRestamp ? { skip: opts.skipRestamp } : {})
    console.log(`[OwnerIdentity] Imported identity ${owner.did} — restamped ${result.restamped}, ${result.failures.length} failure(s)${result.skipped?.length ? `, ${result.skipped.length} left for their next open (another runtime runs them)` : ''}`)
    return { ownerDid: owner.did, ...result }
  }

  // =========================================================================
  // Workspace identity provisioning + envelope migration (spec D1/D10/§8)
  // =========================================================================

  /** Recipient bundle for envelope keyslots; null when enc keys are unavailable (D14). */
  getEnvelopeRecipients(): EnvelopeRecipients | null {
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
      if (ownerKey) {
        const runtimeEncPub = this.getRuntimeEncPublicKey()
        workspace.unlockEnvelopes({
          ownerEncPrivateKey: ownerKey,
          reWrapRuntime: runtimeEncPub ? { did: this.getRuntimeDid(), encPublicKey: runtimeEncPub } : undefined
        })
      }
      // No owner key: fall through anyway — the credentials envelope may
      // still have unlocked via the runtime slot, and trusted-daemon slot
      // reconciliation must run whenever it did (it no-ops otherwise).
    }
    this.ensureTrustedDaemonSlots(workspace)
  }

  /**
   * Phase C (mcp-credential-identity): wrap the CREDENTIALS envelope DEK to
   * every trusted daemon key (settings `trustedDaemonEncKeys`, base64 raw
   * X25519 public keys) that does not have a slot yet. Runs on every
   * unlock/provision — idempotent per file, keyed by the stable
   * `daemon:<fingerprint>` label. The identity envelope never gets daemon
   * slots (enforced again in AdfWorkspace.addEnvelopeKeySlot). Never throws:
   * a malformed trusted key must not break envelope unlock.
   */
  private ensureTrustedDaemonSlots(workspace: AdfWorkspace): void {
    if (!this.manageTrustedDaemonSlots) return
    try {
      const trusted = (this.settings.get('trustedDaemonEncKeys') as string[] | undefined) ?? []
      if (workspace.getEnvelopeState('credentials') !== 'unlocked') return

      const wantedLabels = new Map<string, Buffer>()
      for (const b64 of trusted) {
        const pub = Buffer.from(b64, 'base64')
        if (pub.length !== 32) {
          console.warn(`[OwnerIdentity] Ignoring trusted daemon key that is not a raw 32-byte X25519 public key: ${b64.slice(0, 12)}…`)
          continue
        }
        wantedLabels.set(daemonEncKeyLabel(pub), pub)
      }

      const logSlotChange = (action: 'added' | 'removed', label: string) => {
        const msg = `Trusted-daemon credentials slot ${action}: ${label}`
        console.log(`[OwnerIdentity] ${msg} (${workspace.getFilePath() ?? 'unknown file'})`)
        try { workspace.insertLog('info', 'identity', 'daemon_slot', null, msg) } catch { /* non-fatal */ }
      }

      // Revocation: drop daemon:* key slots whose fingerprint is no longer
      // trusted. Only labels with the daemon prefix are touched — owner,
      // runtime, and password slots are never candidates.
      const slots = workspace.readEnvelopeSlots('credentials') ?? []
      for (const slot of slots) {
        if (slot.type === 'password') continue
        const did = (slot as KeySlotRecord).recipient_did
        if (!did?.startsWith('daemon:') || wantedLabels.has(did)) continue
        if (workspace.removeEnvelopeKeySlot('credentials', did)) logSlotChange('removed', did)
      }

      // Enrollment: re-wrap unconditionally (addEnvelopeKeySlot replaces by
      // recipient_did) — skipping on an existing label would let a
      // pre-planted junk slot with a trusted daemon's label permanently block
      // that daemon from ever unlocking this file (label squat).
      const existingLabels = new Set(
        slots.filter((s) => s.type !== 'password').map((s) => (s as KeySlotRecord).recipient_did)
      )
      for (const [label, pub] of wantedLabels) {
        workspace.addEnvelopeKeySlot('credentials', 'runtime', label, pub)
        if (!existingLabels.has(label)) logSlotChange('added', label)
      }
    } catch (err) {
      console.warn('[OwnerIdentity] Trusted-daemon slot provisioning failed:', err)
    }
  }

  /**
   * K12 (design daemon-backend.md §5.3 "Fallback"): make sure the unlocked
   * CREDENTIALS envelope has a working trusted-daemon slot for one daemon key
   * (the daemon enrolling itself). A slot with the key's label that this key
   * opens is left alone, so the common case writes nothing; a missing or junk
   * one (label squat) is (re)wrapped. Never the identity envelope. Returns
   * what happened; never throws.
   */
  enrollTrustedDaemonSlot(
    workspace: AdfWorkspace,
    key: { label: string; publicKeyRaw: Buffer; privateKeyPkcs8: Buffer },
  ): 'added' | 'present' | 'locked' | 'failed' {
    try {
      if (workspace.getEnvelopeState('credentials') !== 'unlocked') return 'locked'
      const slot = (workspace.readEnvelopeSlots('credentials') ?? []).find(
        (s) => s.type !== 'password' && (s as KeySlotRecord).recipient_did === key.label,
      ) as KeySlotRecord | undefined
      if (slot && openKeySlot(slot, 'credentials', key.privateKeyPkcs8)) return 'present'
      workspace.addEnvelopeKeySlot('credentials', 'runtime', key.label, key.publicKeyRaw)
      const msg = `Trusted-daemon credentials slot added: ${key.label}`
      console.log(`[OwnerIdentity] ${msg} (${workspace.getFilePath() ?? 'unknown file'})`)
      try { workspace.insertLog('info', 'identity', 'daemon_slot', null, msg) } catch { /* non-fatal */ }
      return 'added'
    } catch (err) {
      console.warn('[OwnerIdentity] Trusted-daemon slot enrollment failed:', err)
      return 'failed'
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
   *
   * adoptKeys: when keys are minted, store this pair instead of a fresh one
   * (an identity draft from the create screen). Everything else is the same
   * as a fresh mint: envelopes, sealing, stamps, attestations. Ignored when
   * the file already has signing keys, so it can never replace an identity.
   */
  ensureWorkspaceIdentity(
    workspace: AdfWorkspace,
    opts: {
      mintKeys?: boolean
      adoptKeys?: { privateKey: Buffer; publicKey: Buffer }
      /** How long a mint waits for another connection's write lock (default PROVISION_BUSY_TIMEOUT_MS). */
      busyTimeoutMs?: number
    } = {}
  ): { keysGenerated: boolean; sealed: number } {
    if (workspace.isPasswordProtected()) {
      // Still run the unlock-only step: envelope unwrap is X25519 against
      // local keys and needs no derived key. Skipping it left an own file's
      // sealed envelopes without cached DEKs for the whole session, so the
      // Identity panel misread them as "foreign". Safe for unreviewed
      // foreign files — no local slot opens, and the only write paths
      // (runtime re-wrap, daemon slots) are gated on a successful unlock.
      this.unlockWorkspaceEnvelopes(workspace)
      return { keysGenerated: false, sealed: 0 }
    }
    if (opts.mintKeys === false) {
      this.unlockWorkspaceEnvelopes(workspace)
      return { keysGenerated: false, sealed: 0 }
    }

    const provision = (): { keysGenerated: boolean; sealed: number } => {
      const recipients = this.getEnvelopeRecipients()
      if (recipients) {
        if (!workspace.hasEnvelopes()) workspace.provisionEnvelopes(recipients)
        else this.unlockWorkspaceEnvelopes(workspace)
        // Heal files claimed before the dead-envelope purge existed: identity
        // is ours (unlocked) but the credentials envelope is dead-foreign —
        // drop it and re-provision so new credentials seal again.
        if (workspace.getEnvelopeState('identity') === 'unlocked' && workspace.dropDeadCredentialsEnvelope()) {
          workspace.provisionEnvelopes(recipients)
        }
        // Fresh-provision path caches the DEK without going through
        // unlockWorkspaceEnvelopes — daemon slots still need ensuring.
        this.ensureTrustedDaemonSlots(workspace)
      } else {
        console.warn('[OwnerIdentity] Envelope keys unavailable — provisioning identity without envelopes')
      }

      let keysGenerated = false
      const stampAndAttest = () => {
        if (!workspace.getMeta('adf_owner_did')) workspace.setMeta('adf_owner_did', this.getOwnerDid(), 'readonly')
        if (!workspace.getMeta('adf_runtime_did')) workspace.setMeta('adf_runtime_did', this.getRuntimeDid(), 'readonly')
        issueOwnerAttestation(workspace, {
          ownerDid: this.getOwnerDid(),
          ownerPrivateKey: this.getOwnerSigningKey(),
          runtimeDid: this.getRuntimeDid(),
          runtimePrivateKey: this.getRuntimeSigningKey()
        })
      }
      const signingRow = workspace.getIdentityRow('crypto:signing:private_key')
      if (signingRow === null) {
        workspace.generateIdentityKeys(null, opts.adoptKeys)
        keysGenerated = true
        stampAndAttest()
      } else if (
        signingRow.encryption_algo === 'plain' &&
        workspace.getDid() &&
        !workspace.getMeta('adf_owner_did') &&
        this.getOwnerSigningKey()
      ) {
        // A plain key minted where no owner key was available (a headless
        // child from an older daemon, generate-keys without an owner): it is
        // sealed below like any plain row, and gets the owner stamps and
        // attestations it never received. Only reached for own/reviewed files.
        stampAndAttest()
      }

      const sealed = workspace.sealPlainRowsIntoEnvelopes()
      return { keysGenerated, sealed }
    }

    // Read-only pre-check, outside any write transaction: every open of an
    // agent comes through here, and an already provisioned file must not take
    // the file's write lock (or wait on another connection's). Only minting
    // (no envelopes yet, no signing key) is a check-then-write two runtimes
    // can race on; the rest is as before.
    const mints = (!workspace.hasEnvelopes() && this.getEnvelopeRecipients() !== null) ||
      workspace.getIdentityRow('crypto:signing:private_key') === null
    if (!mints) return provision()
    // Minting: one BEGIN IMMEDIATE transaction, the checks repeated inside it,
    // so two runtimes provisioning the same file at once (the boot sweep and a
    // lazy open elsewhere) cannot each mint envelopes or keys with the last
    // writer winning; the second finds them and is a no-op. A file another
    // connection is writing fails after a short wait (SQLITE_BUSY), never the
    // 5 s busy_timeout: the caller reports it, and the next open retries.
    return workspace.immediateTransaction(provision, opts.busyTimeoutMs ?? PROVISION_BUSY_TIMEOUT_MS)
  }

  /**
   * Claim a workspace for the local owner (D11): wipe any prior signing keys
   * and their identity envelope, stamp owner/runtime, mint a fresh identity,
   * and — when there was a prior DID — record a clone attestation as
   * provenance. A recoverable credentials envelope (any password slot, or
   * already unlocked) is kept; a dead one is dropped and re-provisioned.
   * Also the adoption path for identity-less files (previousDid null → the
   * wipe is a no-op and no clone attestation is recorded).
   */
  claimWorkspace(workspace: AdfWorkspace): { did: string | null } {
    const db = workspace.getDatabase()
    const previousDid = workspace.getDid()
    db.deleteIdentity('crypto:signing:private_key')
    db.deleteIdentity('crypto:signing:public_key')
    db.deleteIdentity('crypto:envelope:identity')
    // The descriptor row is gone — a dangling cached DEK would let
    // generateIdentityKeys seal fresh keys under it, unrecoverably.
    workspace.clearCachedEnvelopeDek('identity')
    // A foreign credentials envelope survives while any DEK route exists
    // (password slot, or already unlocked); a dead one would leave every
    // post-claim credential permanently unsealed.
    workspace.dropDeadCredentialsEnvelope()
    db.setMeta('adf_owner_did', this.getOwnerDid(), 'readonly')
    db.setMeta('adf_runtime_did', this.getRuntimeDid(), 'readonly')
    // Fresh identity envelope + sealed keys + attestations (old DID lands in
    // adf_did_history via generateIdentityKeys)
    this.ensureWorkspaceIdentity(workspace)
    this.adoptCredentialsEnvelope(workspace)
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
   * D12 post-claim adoption: re-wrap an unlocked credentials envelope to the
   * local owner+runtime, replacing the sender's key slots. The share-password
   * slot is PRESERVED (multi-route: the file opens silently via local keys
   * and the same password keeps working for re-sharing). No-op when the
   * envelope is locked/absent, recipients are unavailable, or the key slots
   * are already ours. adoptEnvelope wipes daemon slots, so they are
   * re-ensured after a rewrite.
   */
  private adoptCredentialsEnvelope(workspace: AdfWorkspace): void {
    const recipients = this.getEnvelopeRecipients()
    if (!recipients || workspace.getEnvelopeState('credentials') !== 'unlocked') return
    const slots = workspace.readEnvelopeSlots('credentials') ?? []
    const alreadyOurs =
      slots.some((s) => s.type === 'owner' && (s as KeySlotRecord).recipient_did === recipients.ownerDid) &&
      slots.some((s) => s.type === 'runtime' && (s as KeySlotRecord).recipient_did === recipients.runtimeDid)
    if (alreadyOurs) return
    workspace.adoptEnvelope('credentials', recipients)
    this.ensureTrustedDaemonSlots(workspace)
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
   *
   * One sweep for both modes (embedded Studio and the daemon run it 2 s
   * after boot). The folder walk is async and the sweep yields after every
   * file, so a large tracked tree does not block the event loop. Files
   * `skip` names (open or running in this process, which provisioned them
   * on open; or run by another runtime, the one writer of the file) are not
   * opened; they are provisioned when next opened.
   * `provision` replaces ensureWorkspaceIdentity (the daemon's recipe adds
   * its own unlock cascade and trusted slot around it).
   */
  async sweepEnvelopeMigration(
    opts: {
      skip?: (filePath: string) => Promise<boolean>
      provision?: (workspace: AdfWorkspace, opts: { busyTimeoutMs: number }) => { keysGenerated: boolean; sealed: number }
    } = {},
  ): Promise<EnvelopeSweepResult> {
    const result: EnvelopeSweepResult = { provisioned: 0, sealed: 0, failures: [], skipped: [] }
    if (!this.getEnvelopeRecipients()) return { ...result, ownerNotReady: true }

    const maxDepth = (this.settings.get('maxDirectoryScanDepth') as number) ?? 5
    const tracked = (this.settings.get('trackedDirectories') as string[] | undefined) ?? []
    const files: string[] = []
    for (const dir of tracked) {
      try {
        await collectAdfFilesAsync(dir, maxDepth, 0, files)
      } catch (err) {
        result.failures.push(`${dir}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    const reviewedIds = new Set(getReviewedIds(this.settings.get('reviewedAgents')))

    for (const filePath of files) {
      await new Promise<void>((resolve) => setImmediate(resolve))
      try {
        if (await opts.skip?.(filePath)) {
          result.skipped.push(filePath)
          continue
        }
        // Another connection is writing it: opening would block in the open's
        // own writes for up to 5 s. A named failure, retried at the next boot
        // or open.
        if (!AdfDatabase.writeLockFree(filePath, SWEEP_BUSY_TIMEOUT_MS)) {
          result.failures.push(`${filePath}: busy (another connection is writing it)`)
          continue
        }
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
          const busy = { busyTimeoutMs: SWEEP_BUSY_TIMEOUT_MS }
          const { keysGenerated, sealed } = opts.provision ? opts.provision(workspace, busy) : this.ensureWorkspaceIdentity(workspace, busy)
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
   * Files `skip` names (the daemon: leased by another runtime, which is the
   * one writer of the file) are not opened; they are restamped when next
   * opened (restampAndAttest).
   */
  restampLocalAdfs(opts: { skip?: (filePath: string) => boolean } = {}): RestampResult {
    const result: RestampResult = { restamped: 0, attested: 0, failures: [], ...(opts.skip ? { skipped: [] } : {}) }
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
      if (opts.skip?.(filePath)) {
        result.skipped!.push(filePath)
        continue
      }
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
      // The operator attestation belongs to the runtime the file is stamped
      // with. When that is another runtime on this machine (the daemon's, or
      // Studio's for a daemon), keep its operator attestations rather than
      // replacing them with one from a runtime the file was never stamped by.
      // A file with no runtime stamp gets this runtime's operator attestation,
      // as before this check existed.
      const stampedRuntime = workspace.getMeta('adf_runtime_did')
      const ownRuntime = !stampedRuntime || stampedRuntime === this.getRuntimeDid()
      const keptOperators = ownRuntime ? [] : readAdfAttestations(workspace).filter((a) => a.role === 'operator')
      const issued = issueOwnerAttestation(workspace, {
        ownerDid: this.getOwnerDid(),
        ownerPrivateKey: this.getOwnerSigningKey(),
        ...(ownRuntime ? { runtimeDid: this.getRuntimeDid(), runtimePrivateKey: this.getRuntimeSigningKey() } : {})
      })
      if (issued.length > 0) for (const att of keptOperators) appendAdfAttestation(workspace, att)
      attested = issued.length > 0
    }
    return { restamped, attested }
  }
}

/** True when `mnemonic` derives `ownerDid`. False for an unreadable phrase or an empty DID. */
function phraseDerives(mnemonic: string, ownerDid: string | undefined): boolean {
  return !!ownerDid && derivedDid(mnemonic) === ownerDid
}

function derivedDid(mnemonic: string): string | null {
  try {
    return deriveOwnerIdentity(mnemonic).did
  } catch {
    return null
  }
}

/** collectAdfFiles, reading directories asynchronously (the boot envelope sweep). */
async function collectAdfFilesAsync(dir: string, maxDepth: number, depth: number, out: string[]): Promise<void> {
  if (depth > maxDepth) return
  const entries = await readdir(dir, { withFileTypes: true })
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith('.adf')) {
      out.push(join(dir, e.name))
    } else if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
      await collectAdfFilesAsync(join(dir, e.name), maxDepth, depth + 1, out)
    }
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
