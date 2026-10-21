import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { CLIENT_SETTINGS_KEYS, settingsKeyClass, type ClientSettingsKey } from '../../../shared/constants/client-settings-keys'
import { createSettingsDefaults } from '../../../shared/constants/settings-defaults'
import { applyClientSettingsMigrations } from '../../../shared/utils/settings-migrations'
import { readJsonOrQuarantine, writeJsonAtomicAsync } from '../../utils/atomic-json'

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
 * change. A value equal to the one held is no change: the file keeps its
 * bytes (a local-only install's quit, M11). `get`/`set` are synchronous
 * for the menu and the updater; the write is not.
 */
export class ClientSettingsStore {
  private data: Record<string, unknown>
  private writeBlocked: boolean
  private pending: Promise<void> = Promise.resolve()

  /**
   * `migrate`: applied to the file's values as loaded, after the client
   * settings migrations; a key it changed is written at once (the migration
   * of an older remote mode whose client file could not be written at boot,
   * runtime-migration.ts).
   */
  constructor(readonly filePath: string, private readonly log: Log = console, opts: { migrate?: ((data: Record<string, unknown>) => string[]) | null } = {}) {
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
    if (opts.migrate) {
      const migrated = opts.migrate(this.data)
      if (migrated.length > 0) this.log.log(`[Settings] Client keys of remote mode migrated in memory: ${migrated.join('; ')}`)
      changedKeys.push(...migrated)
    }
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
      if (value === undefined) {
        if (!(key in this.data)) continue
        delete this.data[key]
      } else {
        if (key in this.data && isDeepStrictEqual(this.data[key], value)) continue
        this.data[key] = value
      }
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

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * A runtimeFleet write (multi-runtime.md §17): each runtime's entry the patch
 * names takes the fields it carries; every other entry and field stays as
 * held (main's moves and Remove are the only other writers). A patch that is
 * not an object leaves what is held.
 */
export function mergeRuntimeFleet(held: unknown, patch: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = isRecord(held) ? { ...held } : {}
  if (!isRecord(patch)) return out
  for (const [id, entry] of Object.entries(patch)) {
    if (!isRecord(entry)) continue
    out[id] = { ...(isRecord(out[id]) ? out[id] as Record<string, unknown> : {}), ...entry }
  }
  return out
}

/** SETTINGS_GET in daemon mode: the daemon's view of backend keys, Studio's of client keys. */
export function mergeSettingsViews(daemonSettings: Record<string, unknown> | null, client: ClientSettingsStore): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(daemonSettings ?? {})) if (!CLIENT_KEY_SET.has(key)) out[key] = value
  return { ...out, ...client.getAll() }
}
