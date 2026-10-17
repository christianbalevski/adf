import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import type { ProviderConfig } from '../../shared/types/ipc.types'
import type { AdapterRegistration } from '../../shared/types/channel-adapter.types'
import type { ProviderSettingsStore } from '../providers/provider-factory'
import { defaultUserDataPath } from '../utils/user-data-path'
import { withBuiltInAdapterRegistrations } from '../../shared/constants/adapter-registry'
import { createSettingsDefaults } from '../../shared/constants/settings-defaults'
import { applySettingsMigrations, mergeSettingsValue } from '../../shared/utils/settings-migrations'
import { writeJsonAtomic, readJsonOrQuarantine } from '../utils/atomic-json'
import { ProviderKeyVaultLockedError, SECRET_STORE_KEY_STORAGE, type ProviderKeyVault } from './provider-key-vault'
import { CLIENT_SETTINGS_KEYS } from '../../shared/constants/client-settings-keys'

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
    `[FileSettingsStore] CORRUPT SETTINGS FILE: ${originalPath} could not be parsed. ` +
    `It was quarantined to ${quarantinedTo} (NOT deleted) and defaults were loaded. ` +
    'Providers, API keys, tracked directories and the owner mnemonic can be recovered from the quarantined file.'
  )
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

const SAVE_RETRY_DELAY_MS = 1000

/**
 * Studio's client keys (§4.1). Their defaults are merged in memory like every
 * other key, but a write never puts a default into the file: in daemon mode
 * they live in Studio's studio-client-settings.json and MUST NOT end up in
 * both files. One the file holds, or one written here, is kept.
 */
const CLIENT_KEYS: readonly string[] = CLIENT_SETTINGS_KEYS

export class FileSettingsStore implements ProviderSettingsStore {
  private data: Record<string, unknown>
  private lastSynced: FileFingerprint = { mtimeMs: 0, size: 0 }
  /** Keys changed in memory but not yet synced to disk (retained across failed saves). */
  private readonly pendingKeys = new Set<string>()
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * Set when the on-disk file is corrupt AND could not be quarantined (held
   * open elsewhere): the corrupt bytes are the only copy of the user's data,
   * so writes are refused until a re-read succeeds or quarantines.
   */
  private writeBlocked = false
  /** Holds the keys of providers marked `apiKeyStorage: 'secret-store'` (see provider-key-vault.ts). */
  private providerKeys: ProviderKeyVault | null = null
  /** Client keys present in the file (read or written here); others are defaults only and never written. */
  private readonly clientKeysOnDisk = new Set<string>()

  constructor(readonly filePath?: string) {
    if (filePath) {
      const { data, quarantinedTo, corruptUnpreserved } = readJsonOrQuarantine<Record<string, unknown>>(filePath)
      if (quarantinedTo) recordQuarantine(filePath, quarantinedTo)
      this.noteClientKeys(data)
      this.writeBlocked = corruptUnpreserved
      // Merge the same defaults SettingsService uses (file values win) so the
      // daemon never runs agents with an empty system prompt or bare compute
      // config when keys are missing from the file.
      this.data = { ...createSettingsDefaults(), ...(data ?? {}) }
      this.lastSynced = fileFingerprint(filePath)
    } else {
      this.data = createSettingsDefaults()
    }
    // Same migrations SettingsService runs, so stale values (e.g. a partial
    // compute.containerPackages missing VNC packages) never survive in the daemon.
    const { changedKeys } = applySettingsMigrations(this.data)
    // A migration of a client key the file does not hold is Studio's to run on its own file.
    const toSave = changedKeys.filter((key) => !CLIENT_KEYS.includes(key) || this.clientKeysOnDisk.has(key))
    if (toSave.length > 0) this.save(toSave)
  }

  /**
   * Re-read the file when its fingerprint changed on disk, so a long-lived
   * daemon reflects Studio-side edits (new MCP servers, `agentVisible`
   * toggles / revocations, `runLocation` flips) without a restart. Cheap
   * (one statSync) and a no-op when nothing changed. Keys with unflushed
   * in-memory writes are preserved — memory is newer than disk for those.
   */
  private refreshFromDiskIfChanged(): void {
    if (!this.filePath) return
    const disk = fileFingerprint(this.filePath)
    if (disk.mtimeMs === 0) return
    if (disk.mtimeMs === this.lastSynced.mtimeMs && disk.size === this.lastSynced.size) return
    const { data, quarantinedTo } = readJsonOrQuarantine<Record<string, unknown>>(this.filePath)
    if (quarantinedTo) recordQuarantine(this.filePath, quarantinedTo)
    if (!data) return
    this.noteClientKeys(data)
    const merged: Record<string, unknown> = { ...createSettingsDefaults(), ...data }
    for (const key of this.pendingKeys) merged[key] = this.data[key]
    applySettingsMigrations(merged)
    this.data = merged
    this.lastSynced = disk
  }

  /** Attach the daemon secret store that holds `apiKeyStorage: 'secret-store'` provider keys. */
  setProviderKeyVault(vault: ProviderKeyVault | null): void {
    this.providerKeys = vault
  }

  get providerKeyVault(): ProviderKeyVault | null {
    return this.providerKeys
  }

  get(key: string): unknown {
    this.refreshFromDiskIfChanged()
    if (key === 'adapters') {
      return withBuiltInAdapterRegistrations(this.data.adapters as AdapterRegistration[] | undefined)
    }
    if (key === 'providers') return this.withVaultKeys(this.data.providers)
    return this.data[key]
  }

  getAll(): Record<string, unknown> {
    this.refreshFromDiskIfChanged()
    return structuredCloneJson({
      ...this.data,
      adapters: withBuiltInAdapterRegistrations(this.data.adapters as AdapterRegistration[] | undefined),
      ...('providers' in this.data ? { providers: this.withVaultKeys(this.data.providers) } : {}),
    })
  }

  set(key: string, value: unknown): void {
    // Same merge semantics as SettingsService: partial compute updates merge
    // instead of replacing wholesale, so a daemon PUT /settings/compute with a
    // partial body cannot erase hostAccessEnabled/hostApproved/executionTargets.
    this.data[key] = mergeSettingsValue(this.data[key], key, key === 'providers' ? this.sealProviderKeys(value) : value)
    this.save([key])
  }

  delete(key: string): void {
    // Removing every provider removes their stored keys too (sealProviderKeys).
    if (key === 'providers') this.sealProviderKeys([])
    delete this.data[key]
    this.save([key])
  }

  update(values: Record<string, unknown>): void {
    // Sealed first: a refused providers value leaves every key unchanged.
    const providers = 'providers' in values ? this.sealProviderKeys(values.providers) : undefined
    for (const [key, value] of Object.entries(values)) {
      this.data[key] = mergeSettingsValue(this.data[key], key, key === 'providers' ? providers : value)
    }
    this.save(Object.keys(values))
  }

  getProvider(id: string): ProviderConfig | undefined {
    const providers = (this.data.providers as ProviderConfig[] | undefined) ?? []
    const provider = providers.find(provider => provider.id === id)
    return provider ? this.withVaultKey(provider) : undefined
  }

  /** Secret-store providers get their key from the vault (the file holds none). */
  private withVaultKey(provider: ProviderConfig): ProviderConfig {
    if (provider.apiKeyStorage !== SECRET_STORE_KEY_STORAGE || provider.apiKey || !this.providerKeys) return provider
    return { ...provider, apiKey: this.providerKeys.get(provider.id) ?? '' }
  }

  private withVaultKeys(providers: unknown): unknown {
    if (!Array.isArray(providers) || !this.providerKeys) return providers
    return providers.map(entry => (entry && typeof entry === 'object' ? this.withVaultKey(entry as ProviderConfig) : entry))
  }

  /**
   * A write never puts a secret-store provider's key in the file: a key that
   * arrives (echoed back from a read, or a new one) goes to the vault and the
   * entry keeps an empty apiKey. withVaultKey fills the key by id, so the
   * stored key must never reach an endpoint it was not entered for (W5-D1):
   * it is removed (logged) when its entry's `type` or `baseUrl` changes without
   * a new key, when the entry stops keeping its key in the secret store, and
   * when the entry is removed. While the vault is locked a key can be neither
   * read, saved nor removed, so any of those changes, and a new key for a
   * secret-store entry, is refused (ProviderKeyVaultLockedError) and nothing
   * is written. An entry with no stored key can still be set up.
   */
  private sealProviderKeys(value: unknown): unknown {
    if (!Array.isArray(value)) return value
    const before = new Map(((this.data.providers as ProviderConfig[] | undefined) ?? []).filter(p => p && typeof p === 'object').map(p => [p.id, p]))
    const after = new Map((value as unknown[]).filter((p): p is ProviderConfig => !!p && typeof p === 'object').map(p => [p.id, p]))
    const sealed = (p: ProviderConfig | undefined): boolean => p?.apiKeyStorage === SECRET_STORE_KEY_STORAGE
    // Why an earlier secret-store entry's stored key may no longer serve it (null: it still does).
    const unbound = (old: ProviderConfig): string | null => {
      const next = after.get(old.id)
      if (!next) return 'was removed'
      if (!sealed(next)) return 'no longer keeps its key in the secret store'
      if (!next.apiKey && ((old.baseUrl ?? '') !== (next.baseUrl ?? '') || (old.type ?? '') !== (next.type ?? ''))) return 'changed its address or type without a new key'
      return null
    }
    const keys = this.providerKeys
    if (keys && !keys.available()) {
      for (const old of before.values()) {
        const next = after.get(old.id)
        if (sealed(old) && (!next || !sealed(next) || (old.baseUrl ?? '') !== (next.baseUrl ?? '') || (old.type ?? '') !== (next.type ?? ''))) this.refuseLocked(next ?? old)
      }
      for (const next of after.values()) if (sealed(next) && next.apiKey) this.refuseLocked(next)
    } else if (keys) {
      for (const old of before.values()) {
        const why = sealed(old) ? unbound(old) : null
        if (why && keys.get(old.id) !== null) {
          keys.delete(old.id)
          console.warn(`[FileSettingsStore] Provider "${old.id}" ${why}: its stored key was removed, so it is never sent to another endpoint. Enter the key again.`)
        }
      }
    }
    return value.map(entry => {
      if (!entry || typeof entry !== 'object') return entry
      const provider = entry as ProviderConfig
      if (!sealed(provider) || !provider.apiKey) return entry
      if (!keys) console.error(`[FileSettingsStore] Provider "${provider.id}" keeps its key in the secret store, which this daemon does not have: the key was not saved.`)
      else if (keys.get(provider.id) !== provider.apiKey) keys.set(provider.id, provider.apiKey)
      return { ...provider, apiKey: '' }
    })
  }

  private refuseLocked(provider: ProviderConfig): never {
    console.warn(`[FileSettingsStore] Provider "${provider.id}": a change to its address, type, key storage or API key was refused while the secret store is locked.`)
    throw new ProviderKeyVaultLockedError(`The daemon secret store is locked, so provider "${provider.name || provider.id}" cannot change its address, type, key storage or API key now: its stored key can be neither saved nor removed. Unlock the owner identity, then save again.`)
  }

  /**
   * Persist atomically. Never throws (a settings write must never crash the
   * daemon or leak into HTTP handlers as an unhandled rejection) — on failure
   * the changed keys are retained and a retry is scheduled.
   */
  private save(changedKeys: string[]): void {
    for (const key of changedKeys) this.pendingKeys.add(key)
    if (!this.filePath) {
      this.pendingKeys.clear()
      return
    }
    try {
      this.saveNow()
    } catch (err) {
      console.error('[FileSettingsStore] Failed to persist settings (changes retained; will retry):', err)
      this.scheduleRetry()
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      try {
        this.saveNow()
      } catch (err) {
        console.error('[FileSettingsStore] Failed to persist settings (changes retained; will retry):', err)
        this.scheduleRetry()
      }
    }, SAVE_RETRY_DELAY_MS)
    this.retryTimer.unref?.()
  }

  /**
   * If another writer (e.g. Studio) touched the file since our last
   * read/write, re-read it and merge: our changed keys win, every other key
   * comes from disk — so two writers no longer clobber each other with stale
   * snapshots.
   */
  private saveNow(): void {
    if (!this.filePath || this.pendingKeys.size === 0) return
    const dir = dirname(this.filePath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

    const disk = fileFingerprint(this.filePath)
    const stale = disk.mtimeMs !== 0 &&
      (disk.mtimeMs !== this.lastSynced.mtimeMs || disk.size !== this.lastSynced.size)
    if (this.writeBlocked || stale) {
      const { data: onDisk, quarantinedTo, corruptUnpreserved } =
        readJsonOrQuarantine<Record<string, unknown>>(this.filePath)
      if (quarantinedTo) recordQuarantine(this.filePath, quarantinedTo)
      if (corruptUnpreserved) {
        this.writeBlocked = true
        console.error(
          `[FileSettingsStore] ${this.filePath} is corrupt and could not be quarantined (held open by another process?). ` +
          'Refusing to overwrite the only copy of the user\'s data; changes stay pending.'
        )
        this.scheduleRetry()
        return
      }
      this.writeBlocked = false
      if (onDisk) {
        this.noteClientKeys(onDisk)
        const merged: Record<string, unknown> = { ...createSettingsDefaults(), ...onDisk }
        for (const key of this.pendingKeys) {
          if (key in this.data) merged[key] = this.data[key]
          else delete merged[key]
        }
        this.data = merged
      }
    }

    for (const key of this.pendingKeys) {
      if (!CLIENT_KEYS.includes(key)) continue
      if (key in this.data) this.clientKeysOnDisk.add(key)
      else this.clientKeysOnDisk.delete(key)
    }
    const out: Record<string, unknown> = { ...this.data }
    for (const key of CLIENT_KEYS) if (!this.clientKeysOnDisk.has(key)) delete out[key]
    writeJsonAtomic(this.filePath, out)
    this.lastSynced = fileFingerprint(this.filePath)
    this.pendingKeys.clear()
  }

  /** Track which client keys the file holds (a refresh replaces the set: a key Studio moved out is gone). */
  private noteClientKeys(data: Record<string, unknown> | null | undefined): void {
    if (!data) return
    this.clientKeysOnDisk.clear()
    for (const key of CLIENT_KEYS) if (key in data) this.clientKeysOnDisk.add(key)
  }
}

export function defaultSettingsPath(): string {
  return join(defaultUserDataPath(), 'adf-settings.json')
}

function structuredCloneJson(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>
}
