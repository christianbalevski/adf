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

  constructor(readonly filePath?: string) {
    if (filePath) {
      const { data, quarantinedTo, corruptUnpreserved } = readJsonOrQuarantine<Record<string, unknown>>(filePath)
      if (quarantinedTo) recordQuarantine(filePath, quarantinedTo)
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
    if (changedKeys.length > 0) this.save(changedKeys)
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
    const merged: Record<string, unknown> = { ...createSettingsDefaults(), ...data }
    for (const key of this.pendingKeys) merged[key] = this.data[key]
    applySettingsMigrations(merged)
    this.data = merged
    this.lastSynced = disk
  }

  get(key: string): unknown {
    this.refreshFromDiskIfChanged()
    if (key === 'adapters') {
      return withBuiltInAdapterRegistrations(this.data.adapters as AdapterRegistration[] | undefined)
    }
    return this.data[key]
  }

  getAll(): Record<string, unknown> {
    this.refreshFromDiskIfChanged()
    return structuredCloneJson({
      ...this.data,
      adapters: withBuiltInAdapterRegistrations(this.data.adapters as AdapterRegistration[] | undefined),
    })
  }

  set(key: string, value: unknown): void {
    // Same merge semantics as SettingsService: partial compute updates merge
    // instead of replacing wholesale, so a daemon PUT /settings/compute with a
    // partial body cannot erase hostAccessEnabled/hostApproved/executionTargets.
    this.data[key] = mergeSettingsValue(this.data[key], key, value)
    this.save([key])
  }

  update(values: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(values)) {
      this.data[key] = mergeSettingsValue(this.data[key], key, value)
    }
    this.save(Object.keys(values))
  }

  getProvider(id: string): ProviderConfig | undefined {
    const providers = (this.data.providers as ProviderConfig[] | undefined) ?? []
    return providers.find(provider => provider.id === id)
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
        const merged: Record<string, unknown> = { ...createSettingsDefaults(), ...onDisk }
        for (const key of this.pendingKeys) {
          if (key in this.data) merged[key] = this.data[key]
          else delete merged[key]
        }
        this.data = merged
      }
    }

    writeJsonAtomic(this.filePath, this.data)
    this.lastSynced = fileFingerprint(this.filePath)
    this.pendingKeys.clear()
  }
}

export function defaultSettingsPath(): string {
  return join(defaultUserDataPath(), 'adf-settings.json')
}

function structuredCloneJson(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>
}
