import { promises as fsp } from 'node:fs'
import type { SavedRemote } from '../cli/remotes'
import type { RuntimeId } from '../../shared/runtime-tag'
import { writeJsonAtomicAsync } from '../utils/atomic-json'
import { AGENT_WINDOWS_KEY, type SavedAgentWindow } from './agent-windows'
import type { BootBackend, StudioBackendConfig } from './backend-config'
import { runtimeSlot } from './connections'
import { clientSettingsPath } from './daemon-mode/settings'
import { runtimeOrder, savedRuntimeId, SLOT_RUNTIME } from './daemon-mode/runtime-manager'

/**
 * The upgrade of docs/design/multi-runtime.md §7.3 to §7.5: an install that
 * an older Studio left in `mode: remote` becomes `mode: local`, with the
 * connection it used in the runtime set.
 *
 * - `studio-backend.json`: `mode` becomes `local`, `remote.name` goes, and
 *   `runtimeOrder` is written with that connection first. Written once,
 *   atomically, at the first launch of this version, before any connector.
 * - `studio-client-settings.json`: `remoteRecentFiles` moves to
 *   `runtimeRecentFiles[<id>]`; the plain `fleetGroups`, `fleetStewards` and
 *   `fleetMapState` (remote mode wrote that computer's there) move to
 *   `runtimeFleet[<id>]`; an `agentWindows` list saved for
 *   `remote:<name or URL>` is saved for `local`, each entry with its
 *   `runtimeId` and fingerprint.
 *
 * A file in `mode: local` or `mode: embedded` is never read here, and no file
 * of a local-only install is written (M11). Electron-free.
 */

type Log = Pick<Console, 'log' | 'warn'>

/** The connection a `mode: remote` file used, as a runtime of the set. */
export interface RemoteModeRuntime {
  id: RuntimeId
  /** Its name in the notice and the log. */
  name: string
  /** The fingerprint it was paired with; none for the remote slot without a pairing. */
  fingerprint: string | null
  /** It is in the runtime set (still saved). */
  inSet: boolean
}

/**
 * The runtime of an older Studio's remote mode: the saved connection
 * `remote.name`, else the remote slot of studio-backend.json (or the saved
 * connection its pairing became). Null when the file names no connection.
 */
export function remoteModeRuntime(config: Pick<StudioBackendConfig, 'remote'>, saved: Record<string, Pick<SavedRemote, 'fingerprint'>>): RemoteModeRuntime | null {
  const name = config.remote.name
  if (name) return { id: savedRuntimeId(name), name, fingerprint: saved[name]?.fingerprint ?? null, inSet: !!saved[name] }
  if (!config.remote.url) return null
  const slot = runtimeSlot(config, saved)
  if (slot) return { id: SLOT_RUNTIME, name: slot.name, fingerprint: config.remote.paired?.fingerprint ?? null, inSet: true }
  // The slot was paired with a computer that is a saved connection: that connection is the runtime.
  const fp = config.remote.paired?.fingerprint ?? null
  const twin = Object.entries(saved).find(([, r]) => r.fingerprint === fp)?.[0]
  return twin ? { id: savedRuntimeId(twin), name: twin, fingerprint: fp, inSet: true } : null
}

export interface RemoteModeMigration {
  runtime: RemoteModeRuntime | null
  /** studio-backend.json was written. */
  written: boolean
  /** The one sentence shown at this launch (multi-runtime.md §7.3), or null. */
  notice: string | null
}

/** The sentence of the first launch after the migration. */
export function migrationNotice(runtime: RemoteModeRuntime | null): string | null {
  if (!runtime) return null
  return runtime.inSet ? `${runtime.name} is now listed alongside This computer.` : `${runtime.name} is no longer saved; add it again in Settings → Connections.`
}

/**
 * §7.3: an older Studio's `mode: remote` file becomes `mode: local`, the
 * connection it used first in `runtimeOrder`. `boot.config` takes the result
 * whether or not it could be written (this launch runs local either way); a
 * file that cannot be written is said in Settings → Connections and retried
 * at the next launch. Null when the file is not in remote mode.
 */
export async function migrateRemoteMode(boot: BootBackend, saved: Record<string, SavedRemote>, log: Log = console): Promise<RemoteModeMigration | null> {
  if (boot.config.mode !== 'remote') return null
  const runtime = remoteModeRuntime(boot.config, saved)
  const { name: _old, ...remote } = boot.config.remote
  const kept: StudioBackendConfig = { ...boot.config, mode: 'local', remote }
  const previous = boot.config.runtimeOrder ?? []
  const first = runtime?.inSet && !previous.includes(runtime.id) ? [runtime.id, ...previous] : previous
  const next: StudioBackendConfig = { ...kept, runtimeOrder: runtimeOrder(first, saved, runtimeSlot(kept, saved)) }
  boot.config = next
  const what = runtime ? `${runtime.name} (${runtime.id})${runtime.inSet ? '' : ', which is no longer saved'}` : 'no connection'
  if (boot.writeBlocked) {
    log.warn(`[Backend] ${boot.configPath} is in remote mode (an older Studio) and cannot be rewritten: ${boot.writeBlocked} This launch runs This computer with ${what}; the next launch migrates it again`)
    boot.notices = [...(boot.notices ?? []), `studio-backend.json still says remote and could not be rewritten: ${boot.writeBlocked}`]
    return { runtime, written: false, notice: migrationNotice(runtime) }
  }
  try {
    await writeJsonAtomicAsync(boot.configPath, next)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.warn(`[Backend] Could not write the migrated ${boot.configPath} (${message}); this launch runs This computer with ${what}, and the next launch migrates it again`)
    boot.notices = [...(boot.notices ?? []), `studio-backend.json still says remote: it could not be rewritten (${message}).`]
    return { runtime, written: false, notice: migrationNotice(runtime) }
  }
  log.log(`[Backend] Migrated ${boot.configPath} from remote mode to This computer, with ${what} in the runtime set; runtime order ${next.runtimeOrder!.join(', ') || '(none)'}`)
  return { runtime, written: true, notice: migrationNotice(runtime) }
}

const FLEET_KEYS = ['fleetGroups', 'fleetStewards', 'fleetMapState'] as const

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * §7.5: the runtime id an older remote mode saved its agent windows for
 * (`remote:<name or URL>`, DaemonWindows.runtime then): the connection's
 * name, its address when it is the remote slot's, or a saved connection's
 * name. Null: another URL or an unknown name; its entries are dropped.
 */
function windowsRuntime(listRuntime: string, config: Pick<StudioBackendConfig, 'remote'>, runtime: RemoteModeRuntime | null, saved: Record<string, Pick<SavedRemote, 'fingerprint'>>): RuntimeId | null {
  const x = listRuntime.slice('remote:'.length)
  if (runtime && (x === config.remote.name || (!config.remote.name && (x === config.remote.url || x === config.remote.paired?.name)))) return runtime.id
  if (saved[x]) return savedRuntimeId(x)
  return null
}

/**
 * The client keys of §7.4 and §7.5 for the runtime of an older remote mode,
 * on the parsed client file. Pure; returns the keys it changed.
 */
export function migrateRemoteModeClientKeys(data: Record<string, unknown>, config: Pick<StudioBackendConfig, 'remote'>, runtime: RemoteModeRuntime | null, saved: Record<string, Pick<SavedRemote, 'fingerprint'>>): string[] {
  const changed: string[] = []
  const id = runtime?.id ?? null
  if (id && Array.isArray(data.remoteRecentFiles)) {
    const recents = isObject(data.runtimeRecentFiles) ? { ...data.runtimeRecentFiles } : {}
    const own = Array.isArray(recents[id]) ? (recents[id] as unknown[]) : []
    recents[id] = [...new Set([...data.remoteRecentFiles, ...own].filter((p): p is string => typeof p === 'string'))]
    data.runtimeRecentFiles = recents
    delete data.remoteRecentFiles
    changed.push('remoteRecentFiles → runtimeRecentFiles')
  }
  if (id && FLEET_KEYS.some((key) => key in data)) {
    const fleet = isObject(data.runtimeFleet) ? { ...data.runtimeFleet } : {}
    const entry: Record<string, unknown> = isObject(fleet[id]) ? { ...(fleet[id] as Record<string, unknown>) } : {}
    for (const key of FLEET_KEYS) {
      if (!(key in data)) continue
      if (!(key in entry)) entry[key] = data[key]
      delete data[key]
    }
    fleet[id] = entry
    data.runtimeFleet = fleet
    changed.push('fleet keys → runtimeFleet')
  }
  const windows = data[AGENT_WINDOWS_KEY]
  if (isObject(windows) && typeof windows.runtime === 'string' && windows.runtime.startsWith('remote:')) {
    const target = windowsRuntime(windows.runtime, config, runtime, saved)
    const fingerprint = target === runtime?.id ? runtime?.fingerprint ?? null : target ? saved[target.slice('remote:'.length)]?.fingerprint ?? null : null
    const entries = Array.isArray(windows.windows) ? windows.windows : []
    const moved: SavedAgentWindow[] = []
    for (const raw of entries) {
      if (!isObject(raw) || typeof raw.filePath !== 'string') continue
      const entry = raw as unknown as SavedAgentWindow
      // An entry that already names its runtime keeps it; the others were the list's.
      if (entry.runtimeId) { moved.push(entry); continue }
      if (!target) continue
      moved.push({ ...entry, runtimeId: target, ...(fingerprint ? { fingerprint } : {}) })
    }
    data[AGENT_WINDOWS_KEY] = { runtime: 'local', windows: moved }
    changed.push(`agentWindows of ${windows.runtime} → ${target ?? 'dropped'}`)
  }
  return changed
}

/**
 * §7.4, §7.5 on `studio-client-settings.json`, after migrateRemoteMode and
 * before the client settings are loaded. Written atomically, and only when a
 * key changed. A file that cannot be read or parsed is left to the client
 * settings store (it quarantines a corrupt one); never throws.
 */
export async function migrateRemoteModeClientFile(userDataDir: string, config: Pick<StudioBackendConfig, 'remote'>, runtime: RemoteModeRuntime | null, saved: Record<string, SavedRemote>, log: Log = console): Promise<string[]> {
  const path = clientSettingsPath(userDataDir)
  let data: unknown
  try {
    data = JSON.parse((await fsp.readFile(path, 'utf-8')).replace(/^\uFEFF/, ''))
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') log.warn(`[Backend] Not migrating the client keys of remote mode: ${path} could not be read (${err instanceof Error ? err.message : String(err)})`)
    return []
  }
  if (!isObject(data)) return []
  const changed = migrateRemoteModeClientKeys(data, config, runtime, saved)
  if (changed.length === 0) return []
  try {
    await writeJsonAtomicAsync(path, data)
    log.log(`[Backend] Migrated the client keys of remote mode in ${path}: ${changed.join('; ')}`)
  } catch (err) {
    log.warn(`[Backend] Could not write the migrated client keys to ${path} (${err instanceof Error ? err.message : String(err)}); they stay as they were`)
    return []
  }
  return changed
}

/**
 * §7.5 at every launch: a saved agent window whose `runtimeId` is not in the
 * runtime set, but whose fingerprint is a saved connection's, moves to that
 * connection (it was renamed, or paired again under another name). Pure;
 * null when nothing changed, so a list of This computer only is never
 * rewritten.
 */
export function relinkSavedAgentWindows(raw: unknown, saved: Record<string, Pick<SavedRemote, 'fingerprint'>>, slotInSet: boolean): { runtime: string; windows: SavedAgentWindow[] } | null {
  if (!isObject(raw) || typeof raw.runtime !== 'string' || !Array.isArray(raw.windows)) return null
  const inSet = (id: string): boolean => id === SLOT_RUNTIME ? slotInSet : id.startsWith('remote:') && !!saved[id.slice('remote:'.length)]
  let changed = false
  const windows = (raw.windows as unknown[]).map((w) => {
    const entry = w as SavedAgentWindow
    if (!isObject(w) || !entry.runtimeId || !entry.fingerprint || inSet(entry.runtimeId)) return entry
    const name = Object.entries(saved).find(([, r]) => r.fingerprint === entry.fingerprint)?.[0]
    if (!name) return entry
    changed = true
    return { ...entry, runtimeId: savedRuntimeId(name) }
  })
  return changed ? { runtime: raw.runtime, windows } : null
}
