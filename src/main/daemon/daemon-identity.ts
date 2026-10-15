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
 *    shared settings keys, written only for the SAME owner DID (an explicit
 *    `importOwner` is the one switch).
 *
 * Runtime adoption (design daemon-backend.md §5.3, D10): when the keychain
 * holds a verified `studio-runtime:<scope>` entry (studio-runtime-entry.ts),
 * the daemon signs, stamps and unlocks with Studio's runtime identity instead
 * of its own. Studio's values come from the entry; the daemon never writes
 * `runtimeDid`, `runtimeDelegation` or `runtimeEncPublicKey` into the shared
 * settings file, and never mints a runtime key while adopted. Unlock then
 * tries Studio's runtime key, the daemon's own `runtime-enc-key` (files it
 * created before adoption, trusted-daemon slots), then the owner key.
 * Without a keychain, or with a missing or invalid entry, the daemon keeps
 * its own runtime; `status().runtime` says which and why.
 *
 * The phrase is returned exactly once (create) and never logged. No key
 * material appears in logs, statuses or errors.
 */

import { existsSync, mkdirSync, promises as fsp, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import type { AlfAttestation } from '../../shared/types/adf-v02.types'
import { AdfWorkspace } from '../adf/adf-workspace'
import { deriveOwnerIdentity, validateMnemonic } from '../crypto/mnemonic-identity'
import { OWNER_SEED_DERIVED_KEY, OwnerIdentityService, ownerMnemonicSupersededKey, type OwnerIdentitySettings, type RestampResult } from '../services/owner-identity.service'
import { DaemonAppOAuthStore, daemonAppOAuthAccount } from '../services/mcp-oauth-store'
import { settingsScope } from '../services/provider-key-store'
import type { WorkspaceIdentityHooks } from '../runtime/identity-provisioner'
import { testSeamsAllowed } from '../utils/test-seams'
import { canonicalizePath } from '../utils/tracked-paths'
import {
  FileSecretBackend,
  MIN_PASSPHRASE_LENGTH,
  OWNER_MNEMONIC_ACCOUNT,
  WrongPassphraseError,
  probeKeychain,
  type KeychainProbe,
  type SecretBackend,
} from '../services/owner-secret-store'
import { SecretBackendProviderKeyVault, type ProviderKeyVault } from './provider-key-vault'
import type { SecretStatus } from '../services/settings.service'
import { readRevokedDaemonKeyLabels, rotateDaemonEncKey, type DaemonEncKey } from './daemon-enc-key'
import {
  canonicalSettingsPath,
  serializeStudioRuntimeEntry,
  studioRuntimeAccount,
  studioRuntimeScope,
  verifyStudioRuntimeEntry,
  type AdoptedStudioRuntime,
  type StudioRuntimeRejectReason,
} from './studio-runtime-entry'

export type DaemonIdentityState = 'none' | 'locked' | 'restore-needed' | 'ready'

/**
 * Whose runtime identity the daemon uses (design daemon-backend.md §5.3):
 *  - `adopted`: Studio's, from a verified keychain entry;
 *  - `absent`: the keychain holds no entry for this settings file;
 *  - `rejected`: an entry exists but failed verification (`reason`);
 *  - `unavailable`: no usable OS keychain here (or file storage forced).
 * In every state but `adopted` the daemon runs as its own runtime, and the
 * credentials of Studio-made agents unlock through the trusted-daemon slot
 * for `daemonEncPublicKey` (Studio's `trustedDaemonEncKeys`).
 */
export type DaemonRuntimeAdoptionState = 'adopted' | 'absent' | 'rejected' | 'unavailable'

export interface DaemonRuntimeAdoption {
  state: DaemonRuntimeAdoptionState
  /** `studio` only when adopted. */
  source: 'studio' | 'daemon'
  /** Why a present entry was not used; null otherwise. */
  reason: StudioRuntimeRejectReason | null
  /** The daemon's own runtime DID (it stamped the files it created before adoption). */
  daemonRuntimeDid: string | null
  /** Public half of the daemon's own runtime-enc-key: what Studio enrolls as a trusted daemon key. */
  daemonEncPublicKey: string | null
  /** One sentence for the UI (switch dialog, Settings → Identity). */
  message: string
}

/**
 * K12: whether the owner trusts this daemon's key (`trustedDaemonEncKeys`),
 * so ADF Studio wraps agent credentials to it. `not-applicable`: the daemon
 * reads the OS keychain and shares Studio's runtime identity instead.
 */
export interface DaemonTrustStatus {
  state: 'trusted' | 'not-trusted' | 'not-applicable'
  /** `daemon:<fingerprint>`, the slot label; null without a key file. */
  label: string | null
  message: string
}

export interface DaemonIdentityStatus {
  status: DaemonIdentityState
  ownerDid: string | null
  /** The runtime DID the daemon signs and stamps with: Studio's when adopted, else its own. */
  runtimeDid: string | null
  runtime: DaemonRuntimeAdoption
  /** K12: the owner's trust in this daemon's key (adf identity trust-daemon). */
  trust?: DaemonTrustStatus
  storage: 'keychain' | 'file'
  /** The user confirmed they wrote the phrase down (shared with Studio). */
  backupConfirmed: boolean
  /** File storage that is not unlocked: create/restore/unlock take a passphrase. */
  passphraseRequired: boolean
  /**
   * Set when this machine has an OS keychain but the daemon could not read it
   * at boot (retried) and runs on the passphrase file instead: why, and what
   * to do. Create, restore and trust-daemon are refused meanwhile. Null otherwise.
   */
  keychainProblem: string | null
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
  | 'switch_unconfirmed'
  | 'backup_unconfirmed'
  | 'keychain_available'
  | 'keychain_unavailable'

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
  /** Remove a key (FileSettingsStore). Used once: Studio's stale owner phrase after an owner switch. */
  delete?(key: string): void
}

/** Studio's runtime keys → the daemon's own keys in the shared settings file. */
const RUNTIME_KEY_MAP: Record<string, string> = {
  runtimeDid: 'daemonRuntimeDid',
  runtimeDelegation: 'daemonRuntimeDelegation',
  legacyRuntimeDids: 'daemonLegacyRuntimeDids',
}

/** Keys that carry Studio's runtime identity while it is adopted. The daemon never writes them. */
const ADOPTED_SETTINGS_KEYS = new Set(['runtimeDid', 'runtimeDelegation', 'runtimeEncPublicKey', 'legacyRuntimeDids'])

/**
 * OwnerIdentitySettings for the daemon (see module doc). Keychain reads are
 * cached per process; DaemonIdentity.refresh() drops the cache so a phrase
 * Studio changed is picked up.
 */
export class DaemonIdentitySettings implements OwnerIdentitySettings {
  private readonly cache = new Map<string, string | null>()
  private adopted: AdoptedStudioRuntime | null = null
  /** Set only by DaemonIdentity.importOwner: the one deliberate owner switch. */
  allowOwnerChange = false
  /**
   * The adopted runtime's delegation as re-signed by the new owner during an
   * owner import (importMnemonic). importOwner writes it into the keychain
   * entry (takeResignedDelegation), so Studio-made agents keep unlocking.
   */
  private resignedDelegation: AlfAttestation | null = null

  constructor(
    private readonly store: IdentitySettingsStore,
    private readonly backend: SecretBackend,
    private encKey: DaemonEncKey | null,
    private readonly runtimeAccount: string,
  ) {}

  clearCache(): void {
    this.cache.clear()
  }

  /** The daemon key after a rotation (untrustDaemon). */
  setEncKey(key: DaemonEncKey): void {
    this.encKey = key
  }

  /** Use Studio's runtime identity (a verified entry), or the daemon's own (null). */
  setAdopted(runtime: AdoptedStudioRuntime | null): void {
    this.adopted = runtime
  }

  /** The adopted runtime, for importOwner's entry rewrite. Never log or serialize it. */
  adoptedRuntime(): AdoptedStudioRuntime | null {
    return this.adopted
  }

  /** The delegation re-signed during the current owner import, once; null if none. */
  takeResignedDelegation(): AlfAttestation | null {
    const value = this.resignedDelegation
    this.resignedDelegation = null
    return value
  }

  isAdopted(): boolean {
    return this.adopted !== null
  }

  get(key: string): unknown {
    const adopted = this.adopted
    if (adopted) {
      if (key === 'runtimeDid') return adopted.runtimeDid
      if (key === 'runtimeDelegation') return adopted.runtimeDelegation
      if (key === 'runtimeEncPublicKey') return adopted.runtimeEncPublicKeyB64
      // Studio's list, read-only: a restamp treats Studio's retired DIDs as Studio would.
      if (key === 'legacyRuntimeDids') return this.store.get('legacyRuntimeDids')
    }
    if (key === 'runtimeEncPublicKey') return this.encKey?.publicKeyB64
    return this.store.get(RUNTIME_KEY_MAP[key] ?? key)
  }

  set(key: string, value: unknown): void {
    if (this.adopted && ADOPTED_SETTINGS_KEYS.has(key)) {
      // Writing these would change embedded Studio's identity in the shared
      // settings file. The adopted entry is already certified by the owner on
      // record. During an owner import, the new owner's re-signed delegation
      // of Studio's runtime replaces the adopted one in memory, and
      // importOwner writes it into the keychain entry (never the settings).
      if (this.allowOwnerChange) {
        if (key === 'runtimeDelegation' && isDelegationOf(value, this.adopted.runtimeDid) && value.issuer !== this.adopted.runtimeDelegation.issuer) {
          this.adopted = { ...this.adopted, runtimeDelegation: value }
          this.resignedDelegation = value
        }
        return
      }
      console.warn(`[ADF Daemon] Not writing ${key}: the daemon uses ADF Studio's runtime identity and never changes it`)
      return
    }
    // Fixed by the daemon key file; nothing to store.
    if (key === 'runtimeEncPublicKey') return
    if (key === 'ownerDid' && !this.allowOwnerChange) {
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
    const adopted = this.adopted
    if (adopted && key === 'runtimePrivateKey') return adopted.runtimePrivateKeyB64
    if (adopted && key === 'runtimeEncPrivateKey') return adopted.runtimeEncPrivateKeyB64
    if (key === 'runtimeEncPrivateKey') return this.encKey ? this.encKey.privateKeyPkcs8.toString('base64') : null
    const account = this.account(key)
    if (!account || !this.backend.isUnlocked()) return null
    if (this.cache.has(account)) return this.cache.get(account) ?? null
    const value = this.backend.get(account)
    this.cache.set(account, value)
    return value
  }

  setSecret(key: string, value: string): void {
    if (this.adopted && (key === 'runtimePrivateKey' || key === 'runtimeEncPrivateKey')) {
      // Unreachable through OwnerIdentityService while adopted (secretStatus
      // is 'ok', so nothing mints); refuse plainly if anything else tries.
      throw new Error(`Refusing to replace ADF Studio's ${key} from the daemon`)
    }
    if (key === 'runtimeEncPrivateKey') return // the daemon key file is immutable (daemon-enc-key.ts)
    const account = this.account(key)
    if (!account) throw new Error(`Unknown daemon secret "${key}"`)
    this.backend.set(account, value)
    this.cache.set(account, value)
  }

  secretStatus(key: string): SecretStatus {
    // Adopted keys exist by construction, so nothing is ever minted over them.
    if (this.adopted && (key === 'runtimePrivateKey' || key === 'runtimeEncPrivateKey')) return 'ok'
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
  /** Test seam: skip keychain detection (a fake keychain is a backend of kind 'keychain'). */
  backend?: SecretBackend
  /** Passphrase for the file backend (ADF_OWNER_PASSPHRASE[_FILE]). */
  bootPassphrase?: string
  /** Test seams for the keychain probe at boot (selectBackend): the probe, the wait between tries, the platform. */
  keychainProbe?: KeychainProbeDeps
}

export interface KeychainProbeDeps {
  probe?: () => KeychainProbe
  /** Blocking wait between tries (boot only, before the daemon serves anything). */
  sleep?: (ms: number) => void
  platform?: NodeJS.Platform
  now?: () => number
}

export interface DaemonOwnerImportOptions {
  mnemonic: string
  /** File storage only, when it is not unlocked yet. */
  passphrase?: string
  /** Required when the phrase belongs to another owner than this machine's. */
  switchOwner?: boolean
  /** The user states they hold the previous owner's phrase although Studio never recorded the backup. */
  previousOwnerBackupConfirmed?: boolean
}

export interface DaemonOwnerImportResult {
  identity: DaemonIdentityStatus
  previousOwnerDid: string | null
  restamp: RestampResult
}

export const SECRET_FILE_NAME = 'owner-secrets.json'

export class DaemonIdentity {
  readonly service: OwnerIdentityService
  private readonly identitySettings: DaemonIdentitySettings
  private readonly backend: SecretBackend
  private readonly store: IdentitySettingsStore
  /** Replaced when the owner revokes the daemon's key (untrustDaemon rotates it). */
  private encKey: DaemonEncKey | null
  private readonly bootPassphrase?: string
  /** API keys of providers added through the daemon (same secret store as the owner phrase). */
  readonly providerKeys: ProviderKeyVault
  /** App-level MCP OAuth sign-ins (Studio's `mcpOauthCredentials` counterpart), same secret store. */
  readonly mcpOAuth: DaemonAppOAuthStore
  /** Owner DID the service is active for; null when not ready. */
  private readyOwnerDid: string | null = null
  private readonly studioRuntimeAccount: string
  /** The account a Studio that did not canonicalize the settings path would have used. */
  private readonly legacyStudioRuntimeAccount: string
  private readonly canonicalSettingsPath: string
  private adoptedRuntime: AdoptedStudioRuntime | null = null
  private adoption: DaemonRuntimeAdoption
  /** Last logged adoption outcome, so a status poll does not repeat the line. */
  private adoptionLogKey: string | null = null
  /** This machine has a keychain the boot probe could not read: why (null when the keychain is used, or there is none). */
  private keychainError: string | null = null
  /** The keychain answered a later probe (refresh); the daemon keeps the file until it restarts. */
  private keychainRecovered = false
  private lastKeychainProbe = 0
  private readonly keychainDeps: KeychainProbeDeps

  constructor(opts: DaemonIdentityOptions) {
    this.store = opts.settings
    this.encKey = opts.encKey
    this.bootPassphrase = opts.bootPassphrase || undefined
    this.keychainDeps = opts.keychainProbe ?? {}
    if (opts.backend) {
      this.backend = opts.backend
    } else {
      const selected = selectBackend(opts.settingsPath, this.keychainDeps)
      this.backend = selected.backend
      this.keychainError = selected.keychainError
      this.lastKeychainProbe = (this.keychainDeps.now ?? Date.now)()
    }
    const scope = settingsScope(opts.settingsPath)
    const runtimeAccount = `daemon-runtime-signing-key:${scope}`
    this.canonicalSettingsPath = canonicalSettingsPath(opts.settingsPath)
    this.studioRuntimeAccount = studioRuntimeAccount(studioRuntimeScope(opts.settingsPath))
    this.legacyStudioRuntimeAccount = studioRuntimeAccount(scope)
    this.providerKeys = new SecretBackendProviderKeyVault(this.backend, scope)
    // Canonical scope, as the studio-runtime entry: Studio's handover writes here for every spelling of the path.
    this.mcpOAuth = new DaemonAppOAuthStore(this.backend, daemonAppOAuthAccount(studioRuntimeScope(opts.settingsPath)))
    this.identitySettings = new DaemonIdentitySettings(this.store, this.backend, this.encKey, runtimeAccount)
    this.service = new OwnerIdentityService(this.identitySettings, { manageTrustedDaemonSlots: false })

    if (this.backend instanceof FileSecretBackend && this.backend.exists() && this.bootPassphrase) {
      try {
        this.backend.unlock(this.bootPassphrase)
      } catch (err) {
        console.error(`[ADF Daemon] Owner identity stays locked: ${err instanceof WrongPassphraseError ? 'wrong passphrase in ADF_OWNER_PASSPHRASE' : err instanceof Error ? err.message : String(err)}`)
      }
    }
    // Sign-ins stored under the uncanonicalized scope by an earlier build.
    try {
      this.mcpOAuth.adoptLegacyAccount(daemonAppOAuthAccount(scope))
    } catch (err) {
      console.error('[ADF Daemon] Moving app-level MCP sign-ins to the canonical account failed (kept where they are):', err instanceof Error ? err.message : err)
    }
    this.adoption = this.refreshAdoption()
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

  /**
   * Recompute the status and the runtime adoption and, when ready, make sure
   * the runtime key/stamps exist.
   */
  refresh(): DaemonIdentityStatus {
    this.identitySettings.clearCache()
    this.reprobeKeychain()
    const status = this.computeStatus()
    if (status.status === 'ready') {
      // Adopt a phrase whose owner this settings file has not seen yet.
      // Before the adoption check: a Studio entry is verified against it.
      if (!this.store.get('ownerDid')) this.identitySettings.set('ownerDid', status.ownerDid)
    }
    const adoptedBefore = this.identitySettings.isAdopted()
    this.adoption = this.refreshAdoption()
    const runtimeChanged = adoptedBefore !== this.identitySettings.isAdopted()
    if (status.status !== 'ready') {
      this.readyOwnerDid = null
      return this.withRuntime(status)
    }
    const derived = status.ownerDid!
    if (this.readyOwnerDid !== derived || runtimeChanged) {
      // Tell Studio this owner is seed-derived, so it never treats it as a
      // legacy DID to migrate away from (it restores it instead).
      if (this.store.get(OWNER_SEED_DERIVED_KEY) !== true) this.identitySettings.set(OWNER_SEED_DERIVED_KEY, true)
      // Mnemonic present → no minting of a new owner; backfills the owner
      // enc public key and, on the daemon's own runtime, its runtime key +
      // delegation. While Studio's runtime is adopted nothing is minted.
      this.service.ensureIdentity()
      const becameReady = this.readyOwnerDid !== derived
      this.readyOwnerDid = derived
      if (becameReady) this.notifyReady(derived)
    }
    return this.withRuntime(status)
  }

  /**
   * On the fallback file store of a machine that has a keychain: probe the
   * keychain again (at most every 30 s, one try, no wait). When it answers,
   * say so; the daemon keeps the file it booted with until it restarts
   * (switching stores under loaded agents would hide their secrets).
   */
  private reprobeKeychain(): void {
    if (this.keychainError === null || this.keychainRecovered) return
    const now = (this.keychainDeps.now ?? Date.now)()
    if (now - this.lastKeychainProbe < KEYCHAIN_REPROBE_MS) return
    this.lastKeychainProbe = now
    const probe = (this.keychainDeps.probe ?? probeKeychain)()
    if (probe.backend) {
      this.keychainRecovered = true
      console.warn('[ADF Daemon] The OS keychain answers now. The daemon keeps the passphrase file it started with; restart it (adf daemon restart) to use the keychain.')
    } else if (probe.error && probe.error !== this.keychainError) {
      this.keychainError = probe.error
    }
  }

  /** Why the daemon runs on the passphrase file although this machine has a keychain; null when it does not. */
  keychainProblem(): string | null {
    if (this.keychainError === null) return null
    return this.keychainRecovered
      ? `The OS keychain could not be read when the daemon started, so it uses the passphrase file ${SECRET_FILE_NAME}; the keychain answers now. Restart the daemon (adf daemon restart) to use it.`
      : `The OS keychain could not be read (${this.keychainError}; tried ${KEYCHAIN_PROBE_DELAYS_MS.length + 1} times at start), so the daemon uses the passphrase file ${SECRET_FILE_NAME} instead. Fix the keychain and restart the daemon (adf daemon restart).`
  }

  /** Refuse owner actions that would put secrets in the fallback file of a machine whose keychain is just unreadable. */
  private refuseOnKeychainFallback(action: string): void {
    if (this.keychainError === null || this.backend.kind !== 'file') return
    throw new DaemonIdentityError(
      'keychain_unavailable',
      `${action} is refused while the daemon runs on its fallback passphrase file: this machine has an OS keychain, but the daemon could not read it ` +
        `(${this.keychainError}). Done now, the owner secrets would land in ${SECRET_FILE_NAME} instead of the keychain ADF Studio shares. ` +
        'Fix the keychain and restart the daemon (adf daemon restart), or set ADF_SECRET_STORE=file to use the file on purpose.',
      409,
    )
  }

  private withRuntime(status: DaemonIdentityStatus): DaemonIdentityStatus {
    return { ...status, runtimeDid: this.runtimeDid(), runtime: this.adoption, trust: this.trustStatus() }
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

  /**
   * Run `listener` when the daemon starts or stops using Studio's runtime
   * identity (an entry appeared, changed or became invalid). Deferred a tick,
   * like onReady. Loaded agents' envelopes are worth re-checking then.
   */
  onRuntimeChange(listener: (adoption: DaemonRuntimeAdoption) => void): void {
    this.runtimeListeners.push(listener)
  }

  private readonly runtimeListeners: Array<(adoption: DaemonRuntimeAdoption) => void> = []

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

  /** The runtime identity the daemon presents (mesh /ping): Studio's when adopted, else its own. */
  presentedRuntime(): { did: string | null; delegation: AlfAttestation | null } {
    const delegation = this.identitySettings.get('runtimeDelegation')
    return {
      did: this.runtimeDid(),
      delegation: delegation && typeof delegation === 'object' ? delegation as AlfAttestation : null,
    }
  }

  /**
   * `settings` with `runtimeDid` / `runtimeDelegation` answered by
   * presentedRuntime(), for consumers that read them from settings (the mesh
   * server's /ping). The shared file holds Studio's values whether or not the
   * daemon adopted them, so reading it directly advertises a runtime DID the
   * daemon may not sign with.
   */
  presentedSettings(settings: { get(key: string): unknown }): { get(key: string): unknown } {
    return {
      get: (key) => {
        if (key === 'runtimeDid') return this.presentedRuntime().did ?? undefined
        if (key === 'runtimeDelegation') return this.presentedRuntime().delegation ?? undefined
        return settings.get(key)
      },
    }
  }

  private runtimeDid(): string | null {
    const value = this.identitySettings.get('runtimeDid')
    return typeof value === 'string' && value ? value : null
  }

  private daemonRuntimeDid(): string | null {
    const value = this.store.get('daemonRuntimeDid')
    return typeof value === 'string' && value ? value : null
  }

  // ---------------------------------------------------------------------------
  // Runtime adoption (studio-runtime-entry.ts)
  // ---------------------------------------------------------------------------

  /** Read and verify Studio's keychain entry; switch the settings adapter to it or away from it. */
  private refreshAdoption(): DaemonRuntimeAdoption {
    let next: AdoptedStudioRuntime | null = null
    let state: DaemonRuntimeAdoptionState
    let reason: StudioRuntimeRejectReason | null = null
    let detail = ''
    if (this.backend.kind !== 'keychain') {
      state = 'unavailable'
    } else {
      let raw: string | null = null
      let readError: string | null = null
      try {
        raw = this.backend.get(this.studioRuntimeAccount)
      } catch (err) {
        // The binding's message, never the value.
        readError = err instanceof Error ? err.message : String(err)
      }
      if (raw === null && readError === null && this.legacyStudioRuntimeAccount !== this.studioRuntimeAccount) {
        try {
          if (this.backend.get(this.legacyStudioRuntimeAccount) !== null) {
            state = 'rejected'
            reason = 'scope_mismatch'
            detail = `it was stored for the settings path as typed, not its canonical form ${this.canonicalSettingsPath} (${this.studioRuntimeAccount}); switch ADF Studio to local mode again to rewrite it`
          }
        } catch { /* reported by the main read */ }
      }
      if (reason === 'scope_mismatch') {
        state = 'rejected'
      } else if (readError !== null) {
        state = 'unavailable'
        detail = `the OS keychain could not be read (${readError})`
      } else if (raw === null) {
        state = 'absent'
        detail = `the OS keychain has no entry ${this.studioRuntimeAccount} for the settings file ${this.canonicalSettingsPath}`
      } else {
        const verified = verifyStudioRuntimeEntry(raw, {
          ownerDid: this.store.get('ownerDid'),
          runtimeDid: this.store.get('runtimeDid'),
          runtimeEncPublicKey: this.store.get('runtimeEncPublicKey'),
        })
        if (verified.ok) {
          state = 'adopted'
          next = verified.runtime
        } else {
          state = 'rejected'
          reason = verified.reason
          detail = verified.detail
        }
      }
    }

    const changed = (this.adoptedRuntime?.runtimeDid ?? null) !== (next?.runtimeDid ?? null)
    this.adoptedRuntime = next
    this.identitySettings.setAdopted(next)

    const daemonRuntimeDid = this.daemonRuntimeDid()
    const adoption: DaemonRuntimeAdoption = {
      state,
      source: next ? 'studio' : 'daemon',
      reason,
      daemonRuntimeDid,
      daemonEncPublicKey: this.encKey?.publicKeyB64 ?? null,
      message: adoptionMessage(state, next?.runtimeDid ?? null, detail, this.encKey?.publicKeyB64 ?? null),
    }
    this.logAdoption(adoption, next?.runtimeDid ?? null)
    if (changed && this.runtimeListeners.length > 0) {
      setImmediate(() => {
        for (const listener of this.runtimeListeners) {
          try { listener(adoption) } catch (err) { console.error('[ADF Daemon] Runtime-change listener failed:', err) }
        }
      })
    }
    return adoption
  }

  private logAdoption(adoption: DaemonRuntimeAdoption, adoptedDid: string | null): void {
    const key = `${adoption.state}|${adoption.reason ?? ''}|${adoptedDid ?? ''}|${adoption.message}`
    if (key === this.adoptionLogKey) return
    this.adoptionLogKey = key
    const line = `[ADF Daemon] Runtime identity: ${adoption.message}`
    if (adoption.state === 'rejected') console.warn(line)
    else console.log(line)
  }

  /**
   * Steps 1 and 2 of the daemon's unlock cascade (design §5.3): Studio's
   * runtime key, then the daemon's own runtime-enc-key. Step 3, owner-key
   * recovery with a runtime re-wrap, is OwnerIdentityService's. Without
   * adoption the service's runtime key is the daemon's own, so this is a no-op.
   */
  private unlockWithLocalRuntimeKeys(workspace: AdfWorkspace): void {
    const adopted = this.adoptedRuntime
    if (!adopted || !workspace.hasEnvelopes()) return
    workspace.unlockEnvelopes({ runtimeEncPrivateKey: Buffer.from(adopted.runtimeEncPrivateKeyB64, 'base64') })
    // Already-unlocked envelopes are skipped, so this only tries what step 1 left.
    if (this.encKey) workspace.unlockEnvelopes({ runtimeEncPrivateKey: this.encKey.privateKeyPkcs8 })
  }

  /** The full unlock cascade for one workspace: Studio's runtime key → the daemon's → the owner key. */
  unlockWorkspaceEnvelopes(workspace: AdfWorkspace): void {
    this.unlockWithLocalRuntimeKeys(workspace)
    this.service.unlockWorkspaceEnvelopes(workspace)
    this.reconcileTrustedSlot(workspace)
  }

  /**
   * K12 (design §5.3 "Fallback"): the trusted-daemon slot of this daemon's
   * key on an open agent. While the owner trusts this daemon (trustDaemon, an
   * explicit owner action: the key is in `trustedDaemonEncKeys`) and it has
   * no keychain, an unlocked credentials envelope gets a working slot. The
   * daemon never adds its key to the list by itself. Slots under a label the
   * owner revoked (untrustDaemon rotated that key away) come off every agent
   * it opens; a slot of the current key is never removed here, because a
   * daemon on its own settings file does not see the list Studio enrolled it
   * in (Phase C). True when the file changed.
   */
  private reconcileTrustedSlot(workspace: AdfWorkspace): boolean {
    if (!workspace.hasEnvelopes()) return false
    let changed = this.removeRevokedSlots(workspace)
    const key = this.encKey
    if (key && this.backend.kind !== 'keychain' && this.isTrusted()) {
      changed = this.service.enrollTrustedDaemonSlot(workspace, key) === 'added' || changed
    }
    return changed
  }

  /** Remove the credentials slots of revoked daemon keys (no unlock needed: removing a slot only narrows access). */
  private removeRevokedSlots(workspace: AdfWorkspace): boolean {
    const revoked = this.revokedLabels()
    if (revoked.length === 0) return false
    let removed = false
    for (const label of revoked) {
      try {
        if (workspace.removeEnvelopeKeySlot('credentials', label)) {
          removed = true
          console.log(`[ADF Daemon] Removed the revoked trusted-daemon slot ${label} from ${workspace.getFilePath() ?? 'an agent'}`)
        }
      } catch (err) {
        console.warn(`[ADF Daemon] Removing the revoked trusted-daemon slot ${label} failed:`, err instanceof Error ? err.message : err)
      }
    }
    return removed
  }

  private revokedLabelCache: string[] | null = null

  private revokedLabels(): string[] {
    if (!this.encKey) return []
    this.revokedLabelCache ??= readRevokedDaemonKeyLabels(dirname(this.encKey.keyPath))
    return this.revokedLabelCache
  }

  private trustedKeys(): string[] {
    const trusted = this.store.get('trustedDaemonEncKeys')
    return Array.isArray(trusted) ? trusted.filter((k): k is string => typeof k === 'string') : []
  }

  private isTrusted(): boolean {
    return !!this.encKey && this.trustedKeys().includes(this.encKey.publicKeyB64)
  }

  /** Whether the owner trusts this daemon's key (`trustedDaemonEncKeys`): GET /identity, GET /version, `adf daemon status`. */
  trustStatus(): DaemonTrustStatus {
    const label = this.encKey?.label ?? null
    if (this.backend.kind === 'keychain') {
      return this.isTrusted()
        ? { state: 'trusted', label, message: 'This daemon\'s key is in trustedDaemonEncKeys although the daemon reads the OS keychain, where it shares ADF Studio\'s runtime identity. Remove it: adf identity untrust-daemon.' }
        : { state: 'not-applicable', label, message: 'The daemon reads the OS keychain, so it shares ADF Studio\'s runtime identity instead of a trusted key.' }
    }
    if (this.isTrusted()) {
      return { state: 'trusted', label, message: `The owner trusts this daemon's key ${label}: ADF Studio wraps each agent's credentials to it, so they unlock here without the owner passphrase. Revoke: adf identity untrust-daemon.` }
    }
    return { state: 'not-trusted', label, message: 'No OS keychain here: agents made in ADF Studio unlock only through the owner key (adf identity unlock). adf identity trust-daemon lets them unlock without it.' }
  }

  /**
   * Owner action (`adf identity trust-daemon`, POST /identity/trust-daemon):
   * add this daemon's key to `trustedDaemonEncKeys`, so embedded Studio wraps
   * every agent's credentials to it (Phase C) and they unlock here without
   * the owner passphrase. Refused with a keychain (Studio's runtime identity
   * is shared there; trusting the key file would let a plain file unlock what
   * the keychain protects) and without the owner key. The grant is an
   * unsigned settings entry.
   */
  trustDaemon(): DaemonTrustStatus {
    this.refuseOnKeychainFallback('Trusting the daemon key (adf identity trust-daemon)')
    if (this.backend.kind === 'keychain') {
      throw new DaemonIdentityError('keychain_available', 'This daemon reads the OS keychain, where it shares ADF Studio\'s runtime identity (switch Studio to local mode). Trusting its key file would let a plain file unlock what the keychain protects, so it is refused.', 409)
    }
    const key = this.encKey
    if (!key) throw new DaemonIdentityError('not_ready', 'The daemon runtime encryption key (runtime-enc-key) is unreadable; fix or remove it and restart the daemon.', 409)
    if (!this.isReady()) {
      throw new DaemonIdentityError('not_ready', 'Trusting this daemon is an owner action: unlock or restore the owner identity first (adf identity unlock, adf identity restore).', 409)
    }
    if (!this.isTrusted()) {
      this.store.set('trustedDaemonEncKeys', [...this.trustedKeys(), key.publicKeyB64])
      console.log(`[ADF Daemon] The owner trusted this daemon's key ${key.label} (trustedDaemonEncKeys): ADF Studio wraps agent credentials to it from now on`)
    }
    return this.trustStatus()
  }

  /**
   * Owner action (`adf identity untrust-daemon`, POST /identity/untrust-daemon):
   * remove this daemon's key from `trustedDaemonEncKeys` and rotate it
   * (rotateDaemonEncKey): a fresh key replaces the file and the old one is no
   * longer used, so slots wrapped to it stop opening here. The old label is
   * recorded as revoked: its slots come off each agent this daemon opens
   * (reconcileTrustedSlot), the loaded ones and the tracked ones
   * (sweepRevokedSlots, run by the route), and embedded Studio drops them at
   * its next unlock (Phase C revocation). The daemon never adds a key back.
   * Slots of the daemon's own runtime that were wrapped to the old key open
   * again after the next owner-key unlock, which re-wraps them to the new key.
   */
  untrustDaemon(): DaemonTrustStatus & { retiredLabel: string | null } {
    const key = this.encKey
    if (!key) throw new DaemonIdentityError('not_ready', 'The daemon runtime encryption key (runtime-enc-key) is unreadable; fix or remove it and restart the daemon.', 409)
    if (this.trustedKeys().includes(key.publicKeyB64)) {
      this.store.set('trustedDaemonEncKeys', this.trustedKeys().filter((k) => k !== key.publicKeyB64))
    }
    const { key: next, retiredLabel } = rotateDaemonEncKey(dirname(key.keyPath))
    this.encKey = next
    this.identitySettings.setEncKey(next)
    this.revokedLabelCache = null
    console.log(`[ADF Daemon] The owner revoked this daemon's key ${retiredLabel} (trustedDaemonEncKeys): the key is rotated (now ${next.label}), and its slots come off each agent this daemon or ADF Studio opens`)
    return { ...this.trustStatus(), retiredLabel }
  }

  /**
   * After untrustDaemon: remove revoked slots from the agents in the tracked
   * folders. Skipped, and cleaned when they are next opened: `skip` (files
   * this daemon has loaded or holds open as documents; loaded ones are
   * handled through their open workspace), files `leasedElsewhere` names
   * (another runtime runs the agent and is the one writer of its file), and
   * files that cannot be opened. One file per macrotask. Copies outside the
   * tracked folders keep the slot until they are opened here or in Studio.
   */
  async sweepRevokedSlots(
    skip: Iterable<string>,
    opts: { leasedElsewhere?: (filePath: string) => Promise<string | null> } = {},
  ): Promise<{ cleaned: number; skipped: string[]; failed: string[] }> {
    const result = { cleaned: 0, skipped: [] as string[], failed: [] as string[] }
    const skipKeys = new Set([...skip].map(pathKey))
    if (this.revokedLabels().length === 0) return result
    const tracked = this.store.get('trackedDirectories')
    const dirs = Array.isArray(tracked) ? tracked.filter((d): d is string => typeof d === 'string') : []
    const depth = this.store.get('maxDirectoryScanDepth')
    const files: string[] = []
    for (const dir of dirs) await collectAdfFilesAsync(dir, typeof depth === 'number' ? depth : 5, 0, files)
    for (const file of files) {
      if (skipKeys.has(pathKey(file))) {
        result.skipped.push(file)
        continue
      }
      await new Promise<void>((resolve) => setImmediate(resolve))
      const holder = opts.leasedElsewhere ? await opts.leasedElsewhere(file) : null
      if (holder) {
        result.skipped.push(file)
        continue
      }
      let ws: AdfWorkspace | null = null
      try {
        ws = AdfWorkspace.open(file)
        if (this.removeRevokedSlots(ws)) result.cleaned++
      } catch (err) {
        result.failed.push(`${file}: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        try { ws?.close() } catch { /* closed */ }
      }
    }
    console.log(`[ADF Daemon] Revoked trusted-daemon slots removed from ${result.cleaned} tracked agent(s)${result.skipped.length ? `; ${result.skipped.length} open here or run by another runtime, cleaned when next opened` : ''}${result.failed.length ? `; ${result.failed.length} could not be opened and are cleaned when next opened` : ''}`)
    return result
  }

  /**
   * Apply the trust state to a loaded agent now (POST /identity/trust-daemon
   * and /identity/untrust-daemon): trusted, its slot is (re)wrapped; revoked
   * slots come off. True when the file changed.
   */
  applyTrustToLoadedAgent(workspace: AdfWorkspace): boolean {
    return this.reconcileTrustedSlot(workspace)
  }

  /** The daemon's workspace identity hooks (setWorkspaceIdentityHooks). */
  workspaceHooks(): WorkspaceIdentityHooks {
    return {
      ensureIdentity: (workspace) => {
        // Decide readiness first: it may refresh the adoption the cascade uses.
        const ready = this.isReady()
        this.unlockWithLocalRuntimeKeys(workspace)
        if (ready) this.service.ensureWorkspaceIdentity(workspace)
        else this.service.unlockWorkspaceEnvelopes(workspace)
        this.reconcileTrustedSlot(workspace)
      },
      unlockEnvelopes: (workspace) => this.unlockWorkspaceEnvelopes(workspace),
      canProvision: () => this.isReady(),
    }
  }

  private computeStatus(): DaemonIdentityStatus {
    const settingsOwner = stringOrNull(this.store.get('ownerDid'))
    const base = {
      storage: this.backend.kind,
      runtimeDid: this.runtimeDid(),
      runtime: this.adoption,
      backupConfirmed: this.store.get('ownerSeedBackupConfirmed') === true,
      passphraseRequired: this.backend.kind === 'file' && !this.backend.isUnlocked(),
      keychainProblem: this.keychainProblem(),
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
    this.refuseOnKeychainFallback('Creating an owner identity (adf identity new)')
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
    this.refuseOnKeychainFallback('Restoring the owner identity (adf identity restore)')
    const normalized = normalizeMnemonic(opts.mnemonic)
    const derived = deriveOwnerIdentity(normalized).did
    const settingsOwner = stringOrNull(this.store.get('ownerDid'))
    if (settingsOwner && settingsOwner !== derived) {
      throw new DaemonIdentityError(
        'owner_mismatch',
        `That phrase belongs to ${derived}, but this machine's owner is ${settingsOwner}. Enter the phrase for ${settingsOwner}` +
          ' (to switch owners, use adf identity import or Import identity in ADF Studio).',
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

  /**
   * Check an owner import before anything is unloaded, so a refused import
   * changes nothing: a valid phrase; for another owner, an explicit
   * `switchOwner` and a confirmed backup of the previous owner's phrase (the
   * switch removes it from this machine); a passphrase that opens the file
   * backend. Returns the DIDs involved (public values).
   */
  checkImport(opts: DaemonOwnerImportOptions): { ownerDid: string; previousOwnerDid: string | null } {
    // The phrase would land in the fallback file, which the next boot with a working keychain ignores.
    this.refuseOnKeychainFallback('Importing an owner identity (adf identity import)')
    const normalized = normalizeMnemonic(opts.mnemonic)
    const ownerDid = deriveOwnerIdentity(normalized).did
    const previousOwnerDid = stringOrNull(this.store.get('ownerDid'))
    const switching = previousOwnerDid !== null && previousOwnerDid !== ownerDid
    if (switching && opts.switchOwner !== true) {
      throw new DaemonIdentityError(
        'switch_unconfirmed',
        `That phrase belongs to ${ownerDid}, not this machine's owner ${previousOwnerDid}. Importing it makes ${ownerDid} the owner ` +
          `and restamps the agents of ${previousOwnerDid} in tracked directories. Confirm the switch (switchOwner: true) to go ahead.`,
        409,
      )
    }
    if (switching && this.store.get('ownerSeedBackupConfirmed') !== true && opts.previousOwnerBackupConfirmed !== true) {
      throw new DaemonIdentityError(
        'backup_unconfirmed',
        `The seed phrase of ${previousOwnerDid} is not confirmed as written down. The switch overwrites the daemon's copy of it ` +
          `(${this.backend.kind === 'keychain'
            ? 'the OS keychain entry ADF / owner-mnemonic'
            : `the passphrase-protected ${SECRET_FILE_NAME}; a copy in the OS keychain, if ADF Studio put one there, is left as it is`}).` +
          (this.store.get('ownerMnemonic') !== undefined
            ? ` ADF Studio's own copy is moved aside to ${ownerMnemonicSupersededKey(previousOwnerDid!)} in the settings file, readable by ADF Studio on this machine only.`
            : '') +
          ` Without a written copy, ${previousOwnerDid} and every envelope only its owner key opens (agents copied to other ` +
          'machines, backups) may be lost for good. Back it up first ' +
          '(Settings → Back Up Seed Phrase in ADF Studio), or confirm you have it (previousOwnerBackupConfirmed: true, ' +
          'adf identity import --i-have-a-backup).',
        409,
      )
    }
    // Last, so a wrong or missing passphrase is reported before any agent is touched.
    this.openFileBackend(opts.passphrase)
    return { ownerDid, previousOwnerDid }
  }

  /**
   * Import an owner phrase (Studio's Import identity): the same owner acts as
   * a restore; another owner replaces this machine's owner, after
   * checkImport's confirmations, and restamps local agents
   * (OwnerIdentityService.importMnemonic). The caller unloads and reloads
   * loaded agents around it.
   *
   * An adopted Studio runtime stays in use for the restamp, so operator
   * attestations are signed by the runtime the files are stamped with. On a
   * switch the new owner re-signs that runtime's delegation (importMnemonic),
   * and the daemon rewrites the `studio-runtime:<scope>` keychain entry with
   * it (serializeStudioRuntimeEntry; the keys are unchanged), so adoption
   * still verifies and Studio-made agents keep unlocking with no Studio
   * running. Studio's own settings (`runtimeDelegation`) are not written:
   * Studio re-signs its copy at its next start (ensureRuntimeKey). Without
   * a keychain write the daemon falls back to its own runtime, as before.
   *
   * On a switch, ADF Studio's own copy of the previous phrase (`ownerMnemonic`
   * in the shared settings file) is moved, still encrypted, to
   * `ownerMnemonicSuperseded:<previous owner DID>`, so embedded Studio takes the new phrase from the
   * keychain at its next start instead of mirroring the old one back over it,
   * and the old phrase stays recoverable.
   */
  importOwner(opts: DaemonOwnerImportOptions, restampOpts: { leasedElsewhere?: Iterable<string> } = {}): DaemonOwnerImportResult {
    const { ownerDid, previousOwnerDid } = this.checkImport(opts)
    const switched = previousOwnerDid !== null && previousOwnerDid !== ownerDid
    const leased = restampOpts.leasedElsewhere ? new Set([...restampOpts.leasedElsewhere].map(pathKey)) : null
    this.identitySettings.clearCache()
    this.identitySettings.allowOwnerChange = true
    let result: { ownerDid: string } & RestampResult
    try {
      result = this.service.importMnemonic(normalizeMnemonic(opts.mnemonic), leased ? { skipRestamp: (filePath) => leased.has(pathKey(filePath)) } : {})
    } finally {
      this.identitySettings.allowOwnerChange = false
    }
    const resigned = this.identitySettings.takeResignedDelegation()
    if (resigned) this.rewriteStudioRuntimeEntry(resigned)
    const studioCopy = this.store.get('ownerMnemonic')
    if (switched && studioCopy !== undefined) {
      const key = ownerMnemonicSupersededKey(previousOwnerDid!)
      if (this.store.get(key) !== undefined) {
        // Never overwrite a kept phrase. Studio moves its copy itself at its
        // next start (it can decrypt it and knows its real owner).
        console.warn(`[ADF Daemon] Owner switch: ${key} already exists; left ADF Studio's stored phrase in place for Studio to move at its next start`)
      } else if (this.store.delete) {
        // The value is Studio's `safe:` ciphertext (or its plaintext fallback),
        // moved verbatim: the daemon never decrypts it.
        this.store.set(key, studioCopy)
        this.store.delete('ownerMnemonic')
        console.log(`[ADF Daemon] Owner switch: moved ADF Studio's stored phrase for ${previousOwnerDid} to ${key} in the settings file; Studio takes the phrase for ${ownerDid} from the OS keychain at its next start`)
      } else {
        console.warn(`[ADF Daemon] Owner switch: ADF Studio's stored phrase for ${previousOwnerDid} is still in the settings file (this store cannot delete keys)`)
      }
    }
    // Force the ready transition so loaded agents re-check their envelopes.
    this.readyOwnerDid = null
    const identity = this.refresh()
    console.log(
      `[ADF Daemon] Imported owner identity ${ownerDid}${switched ? ` (replaced ${previousOwnerDid})` : ''}: ` +
        `restamped ${result.restamped} agent file(s), attested ${result.attested}, ${result.failures.length} failure(s)` +
        (result.skipped?.length ? `; ${result.skipped.length} run by another runtime, restamped when next opened (${result.skipped.join(', ')})` : ''),
    )
    return {
      identity,
      previousOwnerDid,
      restamp: { restamped: result.restamped, attested: result.attested, failures: result.failures, ...(result.skipped?.length ? { skipped: result.skipped } : {}) },
    }
  }

  /**
   * Write the adopted Studio runtime back into its keychain entry with the
   * delegation the new owner signed (importOwner). Logged; never throws (a
   * failed write leaves adoption to fall back to the daemon's own runtime,
   * which refresh() reports).
   */
  private rewriteStudioRuntimeEntry(delegation: AlfAttestation): void {
    const adopted = this.identitySettings.adoptedRuntime()
    if (!adopted || this.backend.kind !== 'keychain') return
    try {
      this.backend.set(this.studioRuntimeAccount, serializeStudioRuntimeEntry({
        runtimeDid: adopted.runtimeDid,
        runtimeDelegation: delegation,
        runtimePrivateKey: adopted.runtimePrivateKeyB64,
        runtimeEncPrivateKey: adopted.runtimeEncPrivateKeyB64,
        runtimeEncPublicKey: adopted.runtimeEncPublicKeyB64,
      }))
      console.log(`[ADF Daemon] Owner import: re-signed ADF Studio's runtime ${adopted.runtimeDid} under ${delegation.issuer} and rewrote the OS keychain entry ${this.studioRuntimeAccount}, so agents made in Studio keep unlocking here`)
    } catch (err) {
      console.error(`[ADF Daemon] Owner import: could not rewrite the OS keychain entry ${this.studioRuntimeAccount} (${err instanceof Error ? err.message : String(err)}); the daemon uses its own runtime until ADF Studio rewrites it`)
    }
  }

  /** The .adf files in the tracked folders (the restamp's scope), for the import route's lease check. */
  async trackedAdfFiles(): Promise<string[]> {
    const tracked = this.store.get('trackedDirectories')
    const dirs = Array.isArray(tracked) ? tracked.filter((d): d is string => typeof d === 'string') : []
    const depth = this.store.get('maxDirectoryScanDepth')
    const files: string[] = []
    for (const dir of dirs) await collectAdfFilesAsync(dir, typeof depth === 'number' ? depth : 5, 0, files)
    return files
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

function adoptionMessage(state: DaemonRuntimeAdoptionState, adoptedDid: string | null, detail: string, daemonEncPublicKey: string | null): string {
  const fallback = 'Agents made in ADF Studio show as "recognized" here, and their credentials unlock through this ' +
    `daemon's trusted key${daemonEncPublicKey ? ` (${daemonEncPublicKey})` : ''} once Studio trusts it.`
  switch (state) {
    case 'adopted':
      return `Using ADF Studio's runtime identity ${adoptedDid} from the OS keychain, so agents open and unlock as they do in Studio.`
    case 'absent':
      return `Using the daemon's own runtime identity: ${detail || 'ADF Studio has not shared its runtime identity for this settings file'} (ADF Studio writes it when it switches to local mode on this settings file). ${fallback}`
    case 'rejected':
      return `Using the daemon's own runtime identity: ADF Studio's runtime entry in the OS keychain was not used because ${detail}. ${fallback}`
    case 'unavailable':
      return `Using the daemon's own runtime identity: ${detail || 'there is no usable OS keychain here'}, so it cannot use ADF Studio's. ${fallback}`
  }
}

function normalizeMnemonic(mnemonic: unknown): string {
  const normalized = typeof mnemonic === 'string' ? mnemonic.trim().toLowerCase().replace(/\s+/g, ' ') : ''
  if (!normalized || !validateMnemonic(normalized)) {
    throw new DaemonIdentityError('invalid_mnemonic', 'That is not a valid 12-word seed phrase. Check the words and their order.', 400)
  }
  return normalized
}

// ---------------------------------------------------------------------------
// Secret backend selection
// ---------------------------------------------------------------------------

/** Test seam: path of a plaintext JSON file that stands in for the OS keychain. */
export const TEST_KEYCHAIN_FILE_ENV = 'ADF_TEST_KEYCHAIN_FILE'

/**
 * A plaintext JSON file posing as the OS keychain (`{ "<account>": "<value>" }`),
 * for spawned test daemons that must never reach the real keychain. Test
 * seam only (TEST_KEYCHAIN_FILE_ENV); never selected in a packaged build.
 */
export class TestKeychainFileBackend implements SecretBackend {
  readonly kind = 'keychain' as const
  constructor(readonly filePath: string) {}

  private read(): Record<string, string> {
    if (!existsSync(this.filePath)) return {}
    const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8')) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, string> : {}
  }

  private write(values: Record<string, string>): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp`
    writeFileSync(tmp, JSON.stringify(values, null, 2) + '\n', { mode: 0o600 })
    renameSync(tmp, this.filePath)
  }

  isUnlocked(): boolean { return true }

  get(account: string): string | null {
    return this.read()[account] ?? null
  }

  set(account: string, value: string): void {
    this.write({ ...this.read(), [account]: value })
  }

  delete(account: string): void {
    const values = this.read()
    if (!(account in values)) return
    delete values[account]
    this.write(values)
  }
}

/** Waits between the boot probes of a keychain that did not answer: 3 tries over 5 s. */
export const KEYCHAIN_PROBE_DELAYS_MS = [1000, 4000]
/** At most one keychain re-probe per this interval (refresh). */
const KEYCHAIN_REPROBE_MS = 30_000

function blockingSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * ADF_SECRET_STORE=file|keychain forces a backend; ADF_KEYCHAIN=0 rules the
 * keychain out; default: keychain when usable, else the file. A keychain
 * that exists but does not answer (Windows Credential Manager or the macOS
 * Keychain busy at logon) is probed again with backoff before the daemon
 * falls back; the fallback is then reported (`keychainError`), never silent.
 * Linux without a Secret Service is "no keychain", not a failure.
 */
function selectBackend(settingsPath: string, deps: KeychainProbeDeps = {}): { backend: SecretBackend; keychainError: string | null } {
  const forced = process.env.ADF_SECRET_STORE
  const file = () => new FileSecretBackend(join(dirname(settingsPath), SECRET_FILE_NAME))
  if (forced === 'file') return { backend: file(), keychainError: null }
  if (process.env.ADF_KEYCHAIN === '0' || process.env.ADF_KEYCHAIN === 'off') return { backend: file(), keychainError: null }
  const fakePath = process.env[TEST_KEYCHAIN_FILE_ENV]
  if (fakePath) {
    if (testSeamsAllowed()) {
      console.warn(`[ADF Daemon] Test seam: ${fakePath} stands in for the OS keychain (ADF_TEST_SEAMS=1)`)
      return { backend: new TestKeychainFileBackend(fakePath), keychainError: null }
    }
    // Fail closed: never fall through to the real keychain when a test asked not to use it.
    console.error(`[ADF Daemon] Ignoring ${TEST_KEYCHAIN_FILE_ENV}: test seams need ADF_TEST_SEAMS=1 and an unpackaged build. Using the passphrase file, not the OS keychain.`)
    return { backend: file(), keychainError: null }
  }
  const probe = deps.probe ?? probeKeychain
  const sleep = deps.sleep ?? blockingSleep
  const platform = deps.platform ?? process.platform
  let result = probe()
  // Windows and macOS always have a keychain: a failed read is transient (logon, a busy service). Retry.
  const expected = result.present && (platform === 'win32' || platform === 'darwin')
  for (let i = 0; !result.backend && expected && i < KEYCHAIN_PROBE_DELAYS_MS.length; i++) {
    console.warn(`[ADF Daemon] The OS keychain did not answer (${result.error ?? 'unknown error'}); trying again in ${KEYCHAIN_PROBE_DELAYS_MS[i] / 1000}s`)
    sleep(KEYCHAIN_PROBE_DELAYS_MS[i])
    result = probe()
  }
  if (result.backend) return { backend: result.backend, keychainError: null }
  if (expected) {
    const error = result.error ?? 'unknown error'
    console.error(`[ADF Daemon] The OS keychain could not be read after ${KEYCHAIN_PROBE_DELAYS_MS.length + 1} tries (${error}): using the passphrase file ${SECRET_FILE_NAME}. Owner create, restore and trust-daemon are refused until the daemon restarts with the keychain (adf daemon restart).`)
    return { backend: file(), keychainError: error }
  }
  if (forced === 'keychain') console.error('[ADF Daemon] ADF_SECRET_STORE=keychain but no OS keychain is usable — using the passphrase file instead')
  return { backend: file(), keychainError: null }
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

/** A runtime delegation certifying `runtimeDid` (shape only; refreshAdoption verifies it). */
function isDelegationOf(value: unknown, runtimeDid: string): value is AlfAttestation {
  if (!value || typeof value !== 'object') return false
  const d = value as Partial<AlfAttestation>
  return d.role === 'runtime' && d.subject === runtimeDid && typeof d.issuer === 'string' && typeof d.signature === 'string'
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** One spelling per file (canonical path), for the sweep's skip list. */
function pathKey(filePath: string): string {
  try { return canonicalizePath(filePath) } catch { return filePath }
}

/** .adf files under a tracked folder, as the tracked-directory scan finds them (async: the revocation sweep runs in the background). */
async function collectAdfFilesAsync(dir: string, maxDepth: number, depth: number, out: string[]): Promise<void> {
  if (depth > maxDepth) return
  let entries: import('fs').Dirent[]
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith('.adf')) out.push(join(dir, e.name))
    else if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') await collectAdfFilesAsync(join(dir, e.name), maxDepth, depth + 1, out)
  }
}
