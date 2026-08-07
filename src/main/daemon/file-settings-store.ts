import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import type { ProviderConfig } from '../../shared/types/ipc.types'
import type { AdapterRegistration } from '../../shared/types/channel-adapter.types'
import type { ProviderSettingsStore } from '../providers/provider-factory'
import { defaultUserDataPath } from '../utils/user-data-path'
import { withBuiltInAdapterRegistrations } from '../../shared/constants/adapter-registry'
import { createSettingsDefaults } from '../../shared/constants/settings-defaults'
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

function fileMtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

export class FileSettingsStore implements ProviderSettingsStore {
  private data: Record<string, unknown>
  private lastSyncedMtime = 0

  constructor(readonly filePath?: string) {
    if (filePath) {
      const { data, quarantinedTo } = readJsonOrQuarantine<Record<string, unknown>>(filePath)
      if (quarantinedTo) recordQuarantine(filePath, quarantinedTo)
      // Merge the same defaults SettingsService uses (file values win) so the
      // daemon never runs agents with an empty system prompt or bare compute
      // config when keys are missing from the file.
      this.data = { ...createSettingsDefaults(), ...(data ?? {}) }
      this.lastSyncedMtime = fileMtimeMs(filePath)
    } else {
      this.data = createSettingsDefaults()
    }
  }

  get(key: string): unknown {
    if (key === 'adapters') {
      return withBuiltInAdapterRegistrations(this.data.adapters as AdapterRegistration[] | undefined)
    }
    return this.data[key]
  }

  getAll(): Record<string, unknown> {
    return structuredCloneJson({
      ...this.data,
      adapters: withBuiltInAdapterRegistrations(this.data.adapters as AdapterRegistration[] | undefined),
    })
  }

  set(key: string, value: unknown): void {
    this.data[key] = value
    this.save([key])
  }

  update(values: Record<string, unknown>): void {
    Object.assign(this.data, values)
    this.save(Object.keys(values))
  }

  getProvider(id: string): ProviderConfig | undefined {
    const providers = (this.data.providers as ProviderConfig[] | undefined) ?? []
    return providers.find(provider => provider.id === id)
  }

  /**
   * Persist atomically. If another writer (e.g. Studio) touched the file
   * since our last read/write, re-read it and merge: our changed keys win,
   * every other key comes from disk — so two writers no longer clobber each
   * other with stale snapshots.
   */
  private save(changedKeys: string[]): void {
    if (!this.filePath) return
    const dir = dirname(this.filePath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

    const diskMtime = fileMtimeMs(this.filePath)
    if (diskMtime !== 0 && diskMtime !== this.lastSyncedMtime) {
      const { data: disk, quarantinedTo } = readJsonOrQuarantine<Record<string, unknown>>(this.filePath)
      if (quarantinedTo) recordQuarantine(this.filePath, quarantinedTo)
      if (disk) {
        const merged: Record<string, unknown> = { ...createSettingsDefaults(), ...disk }
        for (const key of changedKeys) {
          merged[key] = this.data[key]
        }
        this.data = merged
      }
    }

    writeJsonAtomic(this.filePath, this.data)
    this.lastSyncedMtime = fileMtimeMs(this.filePath)
  }
}

export function defaultSettingsPath(): string {
  return join(defaultUserDataPath(), 'adf-settings.json')
}

function structuredCloneJson(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>
}
