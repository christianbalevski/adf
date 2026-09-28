/**
 * Owner identity for the headless daemon (CLI/TUI users who never run Studio).
 *
 * The daemon runs Studio's own OwnerIdentityService — same derivation, same
 * workspace provisioning, same attestations — over DaemonIdentitySettings, an
 * adapter that decides where each value lives:
 *
 *  - owner phrase: the OS keychain entry `ADF / owner-mnemonic`, which Studio
 *    on the same machine mirrors into and imports from, or (no keychain) a
 *    passphrase-encrypted file next to the daemon settings;
 *  - daemon runtime signing key: the same secret backend, under an account
 *    namespaced by the settings path;
 *  - daemon runtime encryption key: the existing `runtime-enc-key` file
 *    (daemon-enc-key.ts), so trusted-daemon slots and runtime slots share it;
 *  - runtime DID / delegation: `daemonRuntimeDid` / `daemonRuntimeDelegation`
 *    in settings — never Studio's `runtimeDid`, which shares the file;
 *  - owner public fields (`ownerDid`, `ownerEncPublicKey`, backup flag): the
 *    shared settings keys, written only for the SAME owner DID.
 *
 * The phrase is returned exactly once (create) and never logged.
 */

import { createHash } from 'crypto'
import { dirname, join, resolve } from 'path'
import { deriveOwnerIdentity, validateMnemonic } from '../crypto/mnemonic-identity'
import { OWNER_SEED_DERIVED_KEY, OwnerIdentityService, type OwnerIdentitySettings } from '../services/owner-identity.service'
import {
  FileSecretBackend,
  MIN_PASSPHRASE_LENGTH,
  OWNER_MNEMONIC_ACCOUNT,
  WrongPassphraseError,
  openKeychainBackend,
  type SecretBackend,
} from '../services/owner-secret-store'
import type { SecretStatus } from '../services/settings.service'
import type { DaemonEncKey } from './daemon-enc-key'

export type DaemonIdentityState = 'none' | 'locked' | 'restore-needed' | 'ready'

export interface DaemonIdentityStatus {
  status: DaemonIdentityState
  ownerDid: string | null
  runtimeDid: string | null
  storage: 'keychain' | 'file'
  /** The user confirmed they wrote the phrase down (shared with Studio). */
  backupConfirmed: boolean
  /** File storage that is not unlocked: create/restore/unlock take a passphrase. */
  passphraseRequired: boolean
  /** One human sentence saying what to do next. */
  message: string
}

export type DaemonIdentityErrorCode =
  | 'invalid_mnemonic'
  | 'owner_mismatch'
  | 'identity_exists'
  | 'passphrase_required'
  | 'weak_passphrase'
  | 'wrong_passphrase'
  | 'not_file_storage'
  | 'nothing_to_unlock'
  | 'not_ready'

export class DaemonIdentityError extends Error {
  constructor(
    readonly code: DaemonIdentityErrorCode,
    message: string,
    readonly httpStatus: number,
  ) {
    super(message)
    this.name = 'DaemonIdentityError'
  }
}

interface IdentitySettingsStore {
  get(key: string): unknown
  set(key: string, value: unknown): void
}

/** Studio's runtime keys → the daemon's own keys in the shared settings file. */
const RUNTIME_KEY_MAP: Record<string, string> = {
  runtimeDid: 'daemonRuntimeDid',
  runtimeDelegation: 'daemonRuntimeDelegation',
  legacyRuntimeDids: 'daemonLegacyRuntimeDids',
}

/**
 * OwnerIdentitySettings for the daemon (see module doc). Keychain reads are
 * cached per process; DaemonIdentity.refresh() drops the cache so a phrase
 * Studio changed is picked up.
 */
export class DaemonIdentitySettings implements OwnerIdentitySettings {
  private readonly cache = new Map<string, string | null>()

  constructor(
    private readonly store: IdentitySettingsStore,
    private readonly backend: SecretBackend,
    private readonly encKey: DaemonEncKey | null,
    private readonly runtimeAccount: string,
  ) {}

  clearCache(): void {
    this.cache.clear()
  }

  get(key: string): unknown {
    if (key === 'runtimeEncPublicKey') return this.encKey?.publicKeyB64
    return this.store.get(RUNTIME_KEY_MAP[key] ?? key)
  }

  set(key: string, value: unknown): void {
    // Fixed by the daemon key file; nothing to store.
    if (key === 'runtimeEncPublicKey') return
    if (key === 'ownerDid') {
      const current = this.store.get('ownerDid')
      if (typeof current === 'string' && current !== '' && current !== value) {
        throw new DaemonIdentityError('owner_mismatch', `Refusing to replace this machine's owner ${current} from the daemon.`, 409)
      }
    }
    this.store.set(RUNTIME_KEY_MAP[key] ?? key, value)
  }

  private account(key: string): string | null {
    if (key === 'ownerMnemonic') return OWNER_MNEMONIC_ACCOUNT
    if (key === 'runtimePrivateKey') return this.runtimeAccount
    return null
  }

  getSecret(key: string): string | null {
    if (key === 'runtimeEncPrivateKey') return this.encKey ? this.encKey.privateKeyPkcs8.toString('base64') : null
    const account = this.account(key)
    if (!account || !this.backend.isUnlocked()) return null
    if (this.cache.has(account)) return this.cache.get(account) ?? null
    const value = this.backend.get(account)
    this.cache.set(account, value)
    return value
  }

  setSecret(key: string, value: string): void {
    if (key === 'runtimeEncPrivateKey') return // the daemon key file is immutable (daemon-enc-key.ts)
    const account = this.account(key)
    if (!account) throw new Error(`Unknown daemon secret "${key}"`)
    this.backend.set(account, value)
    this.cache.set(account, value)
  }

  secretStatus(key: string): SecretStatus {
    // A missing/corrupt daemon key file must never be "minted over".
    if (key === 'runtimeEncPrivateKey') return this.encKey ? 'ok' : 'locked'
    if (!this.backend.isUnlocked()) return 'locked'
    try {
      return this.getSecret(key) === null ? 'absent' : 'ok'
    } catch {
      return 'locked'
    }
  }

  isSafeStorageAvailable(): boolean {
    return this.backend.isUnlocked()
  }
}

export interface DaemonIdentityOptions {
  settings: IdentitySettingsStore
  /** Path of the daemon settings file; the fallback secret file sits next to it. */
  settingsPath: string
  encKey: DaemonEncKey | null
  /** Test seam: skip keychain detection. */
  backend?: SecretBackend
  /** Passphrase for the file backend (ADF_OWNER_PASSPHRASE[_FILE]). */
  bootPassphrase?: string
}

export const SECRET_FILE_NAME = 'owner-secrets.json'

export class DaemonIdentity {
  readonly service: OwnerIdentityService
  private readonly identitySettings: DaemonIdentitySettings
  private readonly backend: SecretBackend
  private readonly store: IdentitySettingsStore
  private readonly encKey: DaemonEncKey | null
  private readonly bootPassphrase?: string
  /** Owner DID the service is active for; null when not ready. */
  private readyOwnerDid: string | null = null

  constructor(opts: DaemonIdentityOptions) {
    this.store = opts.settings
    this.encKey = opts.encKey
    this.bootPassphrase = opts.bootPassphrase || undefined
    this.backend = opts.backend ?? selectBackend(opts.settingsPath)
    const runtimeAccount = `daemon-runtime-signing-key:${createHash('sha256').update(resolve(opts.settingsPath)).digest('hex').slice(0, 12)}`
    this.identitySettings = new DaemonIdentitySettings(this.store, this.backend, this.encKey, runtimeAccount)
    this.service = new OwnerIdentityService(this.identitySettings, { manageTrustedDaemonSlots: false })

    if (this.backend instanceof FileSecretBackend && this.backend.exists() && this.bootPassphrase) {
      try {
        this.backend.unlock(this.bootPassphrase)
      } catch (err) {
        console.error(`[ADF Daemon] Owner identity stays locked: ${err instanceof WrongPassphraseError ? 'wrong passphrase in ADF_OWNER_PASSPHRASE' : err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  get storage(): 'keychain' | 'file' {
    return this.backend.kind
  }

  /** Cheap: the hot path (every workspace open) asks this. */
  isReady(): boolean {
    if (this.readyOwnerDid === null) return false
    // Studio may have switched owners in the shared settings file.
    if (this.store.get('ownerDid') !== this.readyOwnerDid) return this.refresh().status === 'ready'
    return true
  }

  /** Recompute the status and, when ready, make sure the runtime key/stamps exist. */
  refresh(): DaemonIdentityStatus {
    this.identitySettings.clearCache()
    const status = this.computeStatus()
    if (status.status !== 'ready') {
      this.readyOwnerDid = null
      return status
    }
    const derived = status.ownerDid!
    if (this.readyOwnerDid !== derived) {
      // Adopt a phrase whose owner this settings file has not seen yet.
      if (!this.store.get('ownerDid')) this.identitySettings.set('ownerDid', derived)
      // Tell Studio this owner is seed-derived, so it never treats it as a
      // legacy DID to migrate away from (it restores it instead).
      if (this.store.get(OWNER_SEED_DERIVED_KEY) !== true) this.identitySettings.set(OWNER_SEED_DERIVED_KEY, true)
      // Mnemonic present → no minting of a new owner; backfills the owner
      // enc public key and this daemon's runtime key + delegation.
      this.service.ensureIdentity()
      this.readyOwnerDid = derived
      this.notifyReady(derived)
    }
    return { ...status, runtimeDid: this.runtimeDid() }
  }

  /**
   * Run `listener` each time the identity transitions to ready (boot, create,
   * restore, unlock, or a phrase Studio put in the shared keychain). Deferred
   * a tick: refresh() runs inside the workspace-open hooks, and a listener
   * that re-opens envelopes must not re-enter them.
   */
  onReady(listener: (ownerDid: string) => void): void {
    this.readyListeners.push(listener)
  }

  private readonly readyListeners: Array<(ownerDid: string) => void> = []

  private notifyReady(ownerDid: string): void {
    if (this.readyListeners.length === 0) return
    console.log(`[ADF Daemon] Owner identity ready (${ownerDid}) — re-checking loaded agents' sealed credentials`)
    setImmediate(() => {
      for (const listener of this.readyListeners) {
        try { listener(ownerDid) } catch (err) { console.error('[ADF Daemon] Identity-ready listener failed:', err) }
      }
    })
  }

  status(): DaemonIdentityStatus {
    return this.refresh()
  }

  private runtimeDid(): string | null {
    const value = this.store.get('daemonRuntimeDid')
    return typeof value === 'string' && value ? value : null
  }

  private computeStatus(): DaemonIdentityStatus {
    const settingsOwner = stringOrNull(this.store.get('ownerDid'))
    const base = {
      storage: this.backend.kind,
      runtimeDid: this.runtimeDid(),
      backupConfirmed: this.store.get('ownerSeedBackupConfirmed') === true,
      passphraseRequired: this.backend.kind === 'file' && !this.backend.isUnlocked(),
    }
    if (!this.encKey) {
      return { ...base, status: 'locked', ownerDid: settingsOwner, message: 'The daemon runtime encryption key (runtime-enc-key) is unreadable; fix or remove it and restart the daemon.' }
    }
    if (this.backend instanceof FileSecretBackend && this.backend.exists() && !this.backend.isUnlocked()) {
      return { ...base, status: 'locked', ownerDid: settingsOwner, message: 'The owner identity is locked. Unlock it with its passphrase (adf identity unlock).' }
    }
    let phrase: string | null
    try {
      phrase = this.identitySettings.getSecret('ownerMnemonic')
    } catch (err) {
      return { ...base, status: 'locked', ownerDid: settingsOwner, message: `The OS keychain could not be read (${err instanceof Error ? err.message : String(err)}).` }
    }
    if (!phrase) {
      return settingsOwner
        ? { ...base, status: 'restore-needed', ownerDid: settingsOwner, message: `This machine's owner is ${settingsOwner}, but the daemon does not have its seed phrase. Restore it with the same 12 words (adf identity restore).` }
        : { ...base, status: 'none', ownerDid: null, message: 'No owner identity yet. Create one (adf identity new) or restore yours from its seed phrase (adf identity restore).' }
    }
    let derived: string
    try {
      derived = deriveOwnerIdentity(phrase).did
    } catch {
      return { ...base, status: settingsOwner ? 'restore-needed' : 'none', ownerDid: settingsOwner, message: 'The stored seed phrase is unreadable. Restore it from your 12 words (adf identity restore).' }
    }
    if (settingsOwner && settingsOwner !== derived) {
      return { ...base, status: 'restore-needed', ownerDid: settingsOwner, message: `The stored seed phrase belongs to ${derived}, but this machine's owner is ${settingsOwner}. Restore the phrase for ${settingsOwner} (adf identity restore).` }
    }
    return { ...base, status: 'ready', ownerDid: derived, message: 'Owner identity ready.' }
  }

  /** File backend: make sure it is unlocked (creating it on first use). */
  private openFileBackend(passphrase: string | undefined): void {
    if (!(this.backend instanceof FileSecretBackend) || this.backend.isUnlocked()) return
    const pass = passphrase || this.bootPassphrase
    if (!pass) {
      throw new DaemonIdentityError('passphrase_required', 'No OS keychain here, so the owner identity is kept in a passphrase-protected file. Provide a passphrase.', 400)
    }
    if (!this.backend.exists() && pass.length < MIN_PASSPHRASE_LENGTH) {
      throw new DaemonIdentityError('weak_passphrase', `Choose a passphrase of at least ${MIN_PASSPHRASE_LENGTH} characters.`, 400)
    }
    try {
      this.backend.unlock(pass)
    } catch (err) {
      if (err instanceof WrongPassphraseError) throw new DaemonIdentityError('wrong_passphrase', 'Wrong passphrase.', 403)
      throw err
    }
  }

  /**
   * New owner identity. Returns the 12 words ONCE; they are not retrievable
   * from the daemon afterwards.
   */
  create(opts: { passphrase?: string } = {}): { mnemonic: string; identity: DaemonIdentityStatus } {
    const before = this.refresh()
    if (before.status !== 'none') {
      throw new DaemonIdentityError('identity_exists', `An owner identity already exists here (status: ${before.status}). ${before.message}`, 409)
    }
    this.openFileBackend(opts.passphrase)
    this.identitySettings.clearCache()
    // Fresh-install path of Studio's own bootstrap: mint phrase, owner DID,
    // runtime key + delegation, encryption keys.
    this.service.ensureIdentity()
    const mnemonic = this.identitySettings.getSecret('ownerMnemonic')
    if (!mnemonic) throw new Error('Owner identity creation failed: the phrase was not stored.')
    const identity = this.refresh()
    console.log(`[ADF Daemon] Created owner identity ${identity.ownerDid} (${this.backend.kind} storage)`)
    return { mnemonic, identity }
  }

  /** Restore from the 12 words. Must match this machine's owner DID when one is on record. */
  restore(opts: { mnemonic: string; passphrase?: string }): DaemonIdentityStatus {
    const normalized = typeof opts.mnemonic === 'string' ? opts.mnemonic.trim().toLowerCase().replace(/\s+/g, ' ') : ''
    if (!normalized || !validateMnemonic(normalized)) {
      throw new DaemonIdentityError('invalid_mnemonic', 'That is not a valid 12-word seed phrase. Check the words and their order.', 400)
    }
    const derived = deriveOwnerIdentity(normalized).did
    const settingsOwner = stringOrNull(this.store.get('ownerDid'))
    if (settingsOwner && settingsOwner !== derived) {
      throw new DaemonIdentityError(
        'owner_mismatch',
        `That phrase belongs to ${derived}, but this machine's owner is ${settingsOwner}. Enter the phrase for ${settingsOwner}` +
          ' (to switch owners, import the new phrase in ADF Studio).',
        409,
      )
    }
    this.openFileBackend(opts.passphrase)
    this.identitySettings.clearCache()
    this.service.importMnemonic(normalized)
    const identity = this.refresh()
    console.log(`[ADF Daemon] Restored owner identity ${identity.ownerDid} (${this.backend.kind} storage)`)
    return identity
  }

  /** File storage only: unlock with the passphrase. */
  unlock(passphrase: string): DaemonIdentityStatus {
    if (!(this.backend instanceof FileSecretBackend)) {
      throw new DaemonIdentityError('not_file_storage', 'The owner identity is in the OS keychain; there is nothing to unlock.', 400)
    }
    if (!this.backend.exists()) {
      throw new DaemonIdentityError('nothing_to_unlock', 'There is no owner identity file yet. Create one (adf identity new) or restore (adf identity restore).', 409)
    }
    if (!passphrase) throw new DaemonIdentityError('passphrase_required', 'Provide the passphrase.', 400)
    this.openFileBackend(passphrase)
    return this.refresh()
  }

  /** File storage only: forget the decrypted secrets until the next unlock. */
  lock(): DaemonIdentityStatus {
    if (!(this.backend instanceof FileSecretBackend)) {
      throw new DaemonIdentityError('not_file_storage', 'The owner identity is in the OS keychain and cannot be locked by the daemon.', 400)
    }
    this.backend.lock()
    this.readyOwnerDid = null
    return this.refresh()
  }

  /** The user wrote the words down (Studio's "I have written it down"). */
  confirmBackup(): DaemonIdentityStatus {
    if (!this.isReady()) throw new DaemonIdentityError('not_ready', 'No usable owner identity to confirm.', 409)
    this.service.confirmBackup()
    return this.refresh()
  }
}

/** ADF_SECRET_STORE=file|keychain forces a backend; default: keychain when usable, else the file. */
function selectBackend(settingsPath: string): SecretBackend {
  const forced = process.env.ADF_SECRET_STORE
  const file = () => new FileSecretBackend(join(dirname(settingsPath), SECRET_FILE_NAME))
  if (forced === 'file') return file()
  const keychain = openKeychainBackend()
  if (keychain) return keychain
  if (forced === 'keychain') console.error('[ADF Daemon] ADF_SECRET_STORE=keychain but no OS keychain is usable — using the passphrase file instead')
  return file()
}

/** Passphrase from ADF_OWNER_PASSPHRASE, else the first line of ADF_OWNER_PASSPHRASE_FILE. */
export function readBootPassphrase(readFile: (path: string) => string): string | undefined {
  if (process.env.ADF_OWNER_PASSPHRASE) return process.env.ADF_OWNER_PASSPHRASE
  const path = process.env.ADF_OWNER_PASSPHRASE_FILE
  if (!path) return undefined
  try {
    return readFile(path).split(/\r?\n/)[0] || undefined
  } catch (err) {
    console.error(`[ADF Daemon] Could not read ADF_OWNER_PASSPHRASE_FILE: ${err instanceof Error ? err.message : String(err)}`)
    return undefined
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}
