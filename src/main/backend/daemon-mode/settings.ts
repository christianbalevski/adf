import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CLIENT_SETTINGS_KEYS, settingsKeyClass, type ClientSettingsKey } from '../../../shared/constants/client-settings-keys'
import { createSettingsDefaults } from '../../../shared/constants/settings-defaults'
import { applyClientSettingsMigrations } from '../../../shared/utils/settings-migrations'
import { readJsonOrQuarantine, writeJsonAtomic, writeJsonAtomicAsync } from '../../utils/atomic-json'

/**
 * Settings in daemon mode (design §4.1, §4.2).
 *
 * Each file has one writer. Studio main writes `studio-client-settings.json`
 * (client keys: presentation and Studio-host behaviour) and never writes
 * `adf-settings.json`; the daemon writes its settings file and Studio reaches
 * backend keys only through `GET/PATCH /settings`, never from a cached copy.
 *
 * - SETTINGS_GET = `{...daemonSettings without client keys, ...client defaults, ...clientFile}`.
 * - SETTINGS_SET splits the patch by `settingsKeyClass`.
 * - The client-key migrations (migrateUiFontSystemDefault) run on the client
 *   file at load, since the daemon's file never holds those keys.
 */

export const CLIENT_SETTINGS_FILE = 'studio-client-settings.json'

export function clientSettingsPath(userDataDir: string): string {
  return join(userDataDir, CLIENT_SETTINGS_FILE)
}

type Log = Pick<Console, 'log' | 'warn' | 'error'>

const CLIENT_KEY_SET: ReadonlySet<string> = new Set(CLIENT_SETTINGS_KEYS)

let cachedDefaults: Readonly<Partial<Record<ClientSettingsKey, unknown>>> | null = null

/** The shipped default of every client key that has one (computed once). */
export function clientSettingsDefaults(): Readonly<Partial<Record<ClientSettingsKey, unknown>>> {
  if (!cachedDefaults) {
    const all = createSettingsDefaults()
    const out: Partial<Record<ClientSettingsKey, unknown>> = {}
    for (const key of CLIENT_SETTINGS_KEYS) if (key in all) out[key] = all[key]
    cachedDefaults = Object.freeze(out)
  }
  return cachedDefaults
}

/**
 * `studio-client-settings.json`. Read once at boot (as SettingsService reads
 * its file), held in memory, written with an atomic async write on every
 * change. `get`/`set` are synchronous for the menu and the updater; the
 * write is not.
 */
export class ClientSettingsStore {
  /**
   * INTERIM until W4-A's mode switch moves the client keys (§4.3): on the
   * first daemon-mode boot, with no client file yet, copy the client keys of
   * adf-settings.json into it, so a switch through ADF_STUDIO_BACKEND or
   * studio-backend.json does not reset theme, recents and the other client
   * keys to defaults. adf-settings.json is only read (the daemon writes it).
   * Logged; a no-op once the client file exists.
   */
  static seedOnce(clientPath: string, settingsPath: string, log: Log = console): void {
    if (existsSync(clientPath) || !existsSync(settingsPath)) return
    // A plain read: adf-settings.json is the daemon's file; a corrupt one is
    // left where it is for the daemon (never renamed from here).
    let data: unknown
    try {
      data = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    } catch (err) {
      log.error(`[Settings] Could not read ${settingsPath} to seed ${clientPath}; client keys start at their defaults:`, err)
      return
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return
    const seed: Record<string, unknown> = {}
    for (const key of CLIENT_SETTINGS_KEYS) if (key in data) seed[key] = (data as Record<string, unknown>)[key]
    try {
      writeJsonAtomic(clientPath, seed)
      log.log(`[Settings] First daemon-mode boot: copied ${Object.keys(seed).length} client keys from ${settingsPath} into ${clientPath} (interim; the mode switch, W4-A, moves them)`)
    } catch (err) {
      log.error(`[Settings] Could not seed ${clientPath}:`, err)
    }
  }

  private data: Record<string, unknown>
  private writeBlocked: boolean
  private pending: Promise<void> = Promise.resolve()

  constructor(readonly filePath: string, private readonly log: Log = console) {
    const { data, quarantinedTo, corruptUnpreserved } = readJsonOrQuarantine<Record<string, unknown>>(filePath)
    if (quarantinedTo) {
      this.log.error(`[Settings] ${filePath} could not be parsed; it was moved to ${quarantinedTo} (not deleted) and client defaults were loaded.`)
    }
    this.writeBlocked = corruptUnpreserved
    if (corruptUnpreserved) {
      this.log.error(`[Settings] ${filePath} is corrupt and could not be moved aside; client settings changes are kept in memory only until it can be read.`)
    }
    this.data = { ...(data && typeof data === 'object' && !Array.isArray(data) ? data : {}) }
    const { changedKeys } = applyClientSettingsMigrations(this.data)
    if (changedKeys.length > 0) {
      this.log.log(`[Settings] Client settings migrated: ${changedKeys.join(', ')}`)
      this.persist()
    }
  }

  get(key: string): unknown {
    if (key in this.data) return this.data[key]
    return (clientSettingsDefaults() as Record<string, unknown>)[key]
  }

  set(key: string, value: unknown): void {
    this.patch({ [key]: value })
  }

  /** Client keys only; anything else is refused (it belongs to the daemon). */
  patch(values: Record<string, unknown>): void {
    let changed = false
    for (const [key, value] of Object.entries(values)) {
      if (!CLIENT_KEY_SET.has(key)) {
        this.log.warn(`[Settings] Not a client key, not written to ${this.filePath}: ${key}`)
        continue
      }
      if (value === undefined) delete this.data[key]
      else this.data[key] = value
      changed = true
    }
    if (changed) this.persist()
  }

  /** Every client key with its value or default. */
  getAll(): Record<string, unknown> {
    return { ...clientSettingsDefaults(), ...this.data }
  }

  /** Resolves when every write started so far has finished. */
  flush(): Promise<void> {
    return this.pending
  }

  private persist(): void {
    if (this.writeBlocked) return
    const snapshot = { ...this.data }
    this.pending = this.pending
      .then(() => writeJsonAtomicAsync(this.filePath, snapshot))
      .catch((err) => this.log.error(`[Settings] Failed to write ${this.filePath}:`, err))
  }
}

export interface SplitSettings {
  client: Record<string, unknown>
  backend: Record<string, unknown>
  /** Keys in neither class; they go to the daemon, as embedded wrote every key to adf-settings.json. */
  unclassified: string[]
}

export function splitSettingsPatch(patch: Record<string, unknown>): SplitSettings {
  const out: SplitSettings = { client: {}, backend: {}, unclassified: [] }
  for (const [key, value] of Object.entries(patch)) {
    const cls = settingsKeyClass(key)
    if (cls === 'client') out.client[key] = value
    else {
      out.backend[key] = value
      if (cls === null) out.unclassified.push(key)
    }
  }
  return out
}

/** SETTINGS_GET in daemon mode: the daemon's view of backend keys, Studio's of client keys. */
export function mergeSettingsViews(daemonSettings: Record<string, unknown> | null, client: ClientSettingsStore): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(daemonSettings ?? {})) if (!CLIENT_KEY_SET.has(key)) out[key] = value
  return { ...out, ...client.getAll() }
}
