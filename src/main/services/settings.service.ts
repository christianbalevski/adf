import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, statSync } from 'fs'
import { join, dirname } from 'path'
import { createSettingsDefaults } from '../../shared/constants/settings-defaults'
import { withBuiltInAdapterRegistrations } from '../../shared/constants/adapter-registry'
import { applySettingsMigrations, mergeSettingsValue } from '../../shared/utils/settings-migrations'
import { writeJsonAtomic, readJsonOrQuarantine } from '../utils/atomic-json'
import type { ProviderConfig } from '../../shared/types/ipc.types'
import type { AdapterRegistration } from '../../shared/types/channel-adapter.types'
import { OwnerIdentityService } from './owner-identity.service'

/** Prefix used to mark values encrypted via safeStorage in the JSON file */
const SAFE_STORAGE_PREFIX = 'safe:'

/**
 * Keys whose loss is unrecoverable (mnemonic, private keys, DIDs and their
 * delegations). Writes to these flush synchronously — a crash inside the
 * current tick must never be able to regenerate the owner mnemonic because
 * an earlier one only ever lived in memory.
 */
const IDENTITY_CRITICAL_KEYS = new Set([
  'ownerMnemonic',
  'runtimePrivateKey',
  'runtimeEncPrivateKey',
  'ownerDid',
  'runtimeDid',
  'ownerEncPublicKey',
  'runtimeEncPublicKey',
  'runtimeDelegation',
  'legacyOwnerDids',
  'legacyRuntimeDids',
])

const FLUSH_RETRY_DELAY_MS = 1000

/**
 * Whether a secret is missing, readable, or present-but-undecryptable.
 * 'locked' is the dangerous case callers must never confuse with 'absent':
 * the ciphertext is still there (and may become readable again once keychain
 * access is restored), so nothing may be minted over it.
 */
export type SecretStatus = 'absent' | 'ok' | 'locked'

export interface SettingsQuarantineInfo {
  originalPath: string
  quarantinedTo: string
  at: number
}

let lastQuarantine: SettingsQuarantineInfo | null = null

/** Last settings-file corruption event (file was moved aside, not deleted). */
export function getSettingsQuarantine(): SettingsQuarantineInfo | null {
  return lastQuarantine
}

function recordQuarantine(originalPath: string, quarantinedTo: string): void {
  lastQuarantine = { originalPath, quarantinedTo, at: Date.now() }
  console.error(
    `[Settings] CORRUPT SETTINGS FILE: ${originalPath} could not be parsed. ` +
    `It was quarantined to ${quarantinedTo} (NOT deleted) and defaults were loaded. ` +
    'Providers, API keys, tracked directories and the owner mnemonic can be recovered from the quarantined file.'
  )
}

function getSettingsPath(): string {
  // ADF_USER_DATA_DIR redirects the daemon's settings path; honor it here too
  // so an override never makes Studio and the daemon read DIFFERENT files.
  const userDataPath = process.env.ADF_USER_DATA_DIR ?? app.getPath('userData')
  return join(userDataPath, 'adf-settings.json')
}

interface FileFingerprint {
  mtimeMs: number
  size: number
}

/** mtime alone misses same-ms writes (and 1s-granularity filesystems) — pair it with size. */
function fileFingerprint(path: string): FileFingerprint {
  try {
    const s = statSync(path)
    return { mtimeMs: s.mtimeMs, size: s.size }
  } catch {
    return { mtimeMs: 0, size: 0 }
  }
}

function loadStore(): {
  data: Record<string, unknown>
  fingerprint: FileFingerprint
  corruptUnpreserved: boolean
} {
  const path = getSettingsPath()
  const { data, quarantinedTo, corruptUnpreserved } = readJsonOrQuarantine<Record<string, unknown>>(path)
  if (quarantinedTo) recordQuarantine(path, quarantinedTo)
  return {
    data: { ...createSettingsDefaults(), ...(data ?? {}) },
    fingerprint: fileFingerprint(path),
    corruptUnpreserved,
  }
}

export class SettingsService {
  private data: Record<string, unknown>
  private lastSynced: FileFingerprint
  /** Keys mutated in memory but not yet flushed to disk. */
  private readonly dirtyKeys = new Set<string>()
  private flushScheduled = false
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * Set when the on-disk file is corrupt AND could not be quarantined (held
   * open elsewhere): the corrupt bytes are the only copy of the user's data,
   * so writes are refused until a re-read succeeds or quarantines.
   */
  private writeBlocked = false

  constructor() {
    const { data, fingerprint, corruptUnpreserved } = loadStore()
    this.data = data
    this.lastSynced = fingerprint
    this.writeBlocked = corruptUnpreserved
    const { changedKeys } = applySettingsMigrations(this.data)
    if (changedKeys.length > 0) this.scheduleSave(...changedKeys)
    // Flush migrations synchronously: a second SettingsService constructed in
    // the same tick (or a crash inside it) must see the migrated store on disk.
    this.flush()
    // Best-effort safety net; explicit flush() on shutdown is still preferred.
    process.once('exit', () => this.flush())
  }

  /**
   * Mark keys dirty and coalesce disk writes: bursts of set()/setSecret()
   * calls produce a single write on the next microtask. get() reads the
   * in-memory store, so set() stays synchronous in observable behavior.
   * Identity-critical keys bypass coalescing — their set()/setSecret()
   * callers flush synchronously.
   */
  private scheduleSave(...keys: string[]): void {
    for (const key of keys) this.dirtyKeys.add(key)
    if (this.flushScheduled) return
    this.flushScheduled = true
    queueMicrotask(() => this.flush())
  }

  /**
   * Write pending changes to disk now. Safe to call any time (no-op when
   * clean, never throws — a settings write must never crash the process).
   * On failure the dirty keys are retained and a retry is scheduled.
   * Call on shutdown to guarantee persistence.
   */
  flush(): void {
    this.flushScheduled = false
    if (this.dirtyKeys.size === 0) return
    try {
      this.flushNow()
    } catch (err) {
      console.error('[Settings] Failed to persist settings (changes retained; will retry):', err)
      this.scheduleRetry()
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.flush()
    }, FLUSH_RETRY_DELAY_MS)
    this.retryTimer.unref?.()
  }

  /**
   * Before writing, if another writer (e.g. the daemon) touched the file
   * since our last read/write, re-read it and merge: our dirty keys win,
   * every other key comes from disk — so two writers no longer clobber
   * each other with stale snapshots.
   */
  private flushNow(): void {
    const path = getSettingsPath()
    const dir = dirname(path)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }

    const disk = fileFingerprint(path)
    const stale = disk.mtimeMs !== 0 &&
      (disk.mtimeMs !== this.lastSynced.mtimeMs || disk.size !== this.lastSynced.size)
    if (this.writeBlocked || stale) {
      const { data: onDisk, quarantinedTo, corruptUnpreserved } =
        readJsonOrQuarantine<Record<string, unknown>>(path)
      if (quarantinedTo) recordQuarantine(path, quarantinedTo)
      if (corruptUnpreserved) {
        this.writeBlocked = true
        console.error(
          `[Settings] ${path} is corrupt and could not be quarantined (held open by another process?). ` +
          'Refusing to overwrite the only copy of the user\'s data; changes stay pending.'
        )
        this.scheduleRetry()
        return
      }
      this.writeBlocked = false
      if (onDisk) {
        const merged: Record<string, unknown> = { ...createSettingsDefaults(), ...onDisk }
        for (const key of this.dirtyKeys) {
          if (key in this.data) merged[key] = this.data[key]
          else delete merged[key]
        }
        this.data = merged
      }
    }

    writeJsonAtomic(path, this.data)
    this.lastSynced = fileFingerprint(path)
    this.dirtyKeys.clear()
  }

  get(key: string): unknown {
    if (key === 'adapters') {
      return withBuiltInAdapterRegistrations(this.data.adapters as AdapterRegistration[] | undefined)
    }
    return this.data[key]
  }

  set(key: string, value: unknown): void {
    // Compute settings are updated from several independent controls. Merge
    // partial updates so an execution-target write cannot erase machine or
    // host-access settings (and vice versa).
    this.data[key] = mergeSettingsValue(this.data[key], key, value)
    this.scheduleSave(key)
    if (IDENTITY_CRITICAL_KEYS.has(key)) this.flush()
  }

  getAll(): Record<string, unknown> {
    const all: Record<string, unknown> = {
      ...this.data,
      adapters: withBuiltInAdapterRegistrations(this.data.adapters as AdapterRegistration[] | undefined),
    }
    // Never ship key material to the renderer — even encrypted blobs have no
    // business there, and the plaintext fallback (no safeStorage) definitely doesn't.
    delete all.ownerMnemonic
    delete all.runtimePrivateKey
    delete all.runtimeEncPrivateKey
    return all
  }

  delete(key: string): void {
    delete this.data[key]
    this.scheduleSave(key)
    if (IDENTITY_CRITICAL_KEYS.has(key)) this.flush()
  }

  /** Look up a provider by its id (e.g. 'anthropic' or 'custom:m3k9x1'). */
  getProvider(id: string): ProviderConfig | undefined {
    const providers = (this.data['providers'] as ProviderConfig[]) ?? []
    return providers.find((p) => p.id === id)
  }

  /**
   * Store a secret value encrypted via Electron's safeStorage.
   * Falls back to plaintext if safeStorage is unavailable.
   * Always flushed synchronously — secrets (mnemonic, private keys) must be
   * durable before control returns to the caller.
   */
  setSecret(key: string, value: string): void {
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(value)
      this.data[key] = SAFE_STORAGE_PREFIX + encrypted.toString('base64')
    } else {
      this.data[key] = value
    }
    this.scheduleSave(key)
    this.flush()
  }

  /**
   * Retrieve a secret value, decrypting if it was stored via safeStorage.
   */
  getSecret(key: string): string | null {
    const raw = this.data[key]
    if (raw === undefined || raw === null) return null
    if (typeof raw !== 'string') return String(raw)

    if (raw.startsWith(SAFE_STORAGE_PREFIX)) {
      if (!safeStorage.isEncryptionAvailable()) {
        console.warn(`[Settings] safeStorage unavailable, cannot decrypt "${key}"`)
        return null
      }
      try {
        const buf = Buffer.from(raw.slice(SAFE_STORAGE_PREFIX.length), 'base64')
        return safeStorage.decryptString(buf)
      } catch (err) {
        console.warn(`[Settings] Failed to decrypt "${key}":`, err)
        return null
      }
    }

    return raw
  }

  /**
   * Classify a secret without exposing it. getSecret() collapses "never
   * stored" and "stored but undecryptable" into null; this keeps them apart
   * so callers can refuse to overwrite key material they simply cannot read
   * right now (keychain denied, unsigned rebuild, moved profile).
   */
  secretStatus(key: string): SecretStatus {
    const raw = this.data[key]
    if (raw === undefined || raw === null) return 'absent'
    if (typeof raw === 'string' && raw.startsWith(SAFE_STORAGE_PREFIX)) {
      return this.getSecret(key) === null ? 'locked' : 'ok'
    }
    return 'ok'
  }

  /**
   * Check if safeStorage encryption is available on this platform.
   */
  isSafeStorageAvailable(): boolean {
    return safeStorage.isEncryptionAvailable()
  }

  /**
   * Ensure key-backed owner and runtime identities exist. Delegates to
   * OwnerIdentityService, which handles first launch, migration from legacy
   * label-only DIDs (whose private keys were discarded), and restamping.
   */
  ensureRuntimeIdentity(): { ownerDid: string; runtimeDid: string } {
    const { ownerDid, runtimeDid } = this.getOwnerIdentity().ensureIdentity()
    return { ownerDid, runtimeDid }
  }

  /** Owner identity service (owner-identity only type-imports this file — no cycle). */
  getOwnerIdentity(): OwnerIdentityService {
    if (!this.ownerIdentity) {
      this.ownerIdentity = new OwnerIdentityService(this)
    }
    return this.ownerIdentity
  }

  private ownerIdentity: OwnerIdentityService | undefined
}
