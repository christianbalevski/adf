import { promises as fsp } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { readRemotesAsync, remotesFilePath, type SavedRemote } from '../cli/remotes'
import { LOCAL_RUNTIME, type RuntimeId } from '../../shared/runtime-tag'
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
 * - `studio-client-settings.json` first: `remoteRecentFiles` moves to
 *   `runtimeRecentFiles[<id>]`; the plain `fleetGroups`, `fleetStewards` and
 *   `fleetMapState` (remote mode wrote that computer's there) move to
 *   `runtimeFleet[<id>]`; an `agentWindows` list saved for
 *   `remote:<name or URL>` is saved for `local`, each entry with its
 *   `runtimeId` and fingerprint. The file is marked `remoteModeMigrated`
 *   while studio-backend.json still says remote, so a launch that migrates
 *   again moves nothing This computer wrote meanwhile.
 * - then `studio-backend.json`: `mode` becomes `local`, `remote.name` goes,
 *   and `runtimeOrder` is written with that connection first. Not written
 *   while the client keys could not be: the next launch migrates both.
 *
 * Each file is written atomically, before any connector.
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
  /**
   * The client file could not be written: the migration of its keys, for the
   * client settings store to apply as it loads the file (and mark it), so this
   * launch never shows or writes the remote's keys as This computer's, and
   * the next write of the file holds them. Null when the file has them.
   */
  clientKeys?: ((data: Record<string, unknown>) => string[]) | null
}

/** The sentence of the first launch after the migration. */
export function migrationNotice(runtime: RemoteModeRuntime | null): string | null {
  if (!runtime) return null
  return runtime.inSet ? `${runtime.name} is in Settings → Connections.` : `${runtime.name} is no longer saved; add it again in Settings → Connections.`
}

/**
 * §7.3: an older Studio's `mode: remote` file becomes `mode: local`, the
 * connection it used first in `runtimeOrder`. `boot.config` takes the result
 * whether or not it could be written (this launch runs local either way); a
 * file that cannot be written is said in Settings → Connections and retried
 * at the next launch. Null when the file is not in remote mode.
 */
export async function migrateRemoteMode(boot: BootBackend, saved: Record<string, SavedRemote>, log: Log = console, opts: { clientKeysFailed?: string } = {}): Promise<RemoteModeMigration | null> {
  if (boot.config.mode !== 'remote') return null
  const runtime = remoteModeRuntime(boot.config, saved)
  const { name: _old, ...remote } = boot.config.remote
  const kept: StudioBackendConfig = { ...boot.config, mode: 'local', remote }
  const previous = boot.config.runtimeOrder ?? []
  const first = runtime?.inSet && !previous.includes(runtime.id) ? [runtime.id, ...previous] : previous
  const next: StudioBackendConfig = { ...kept, runtimeOrder: runtimeOrder(first, saved, runtimeSlot(kept, saved)) }
  boot.config = next
  // Until it is written, every save of studio-backend.json in this launch keeps it in remote mode (backend-config.ts).
  boot.remoteModePending = { name: _old ?? null }
  const what = runtime ? `${runtime.name} (${runtime.id})${runtime.inSet ? '' : ', which is no longer saved'}` : 'no connection'
  if (boot.writeBlocked) {
    log.warn(`[Backend] ${boot.configPath} is in remote mode (an older Studio) and cannot be rewritten: ${boot.writeBlocked} This launch runs Local with ${what}; the next launch migrates it again`)
    boot.notices = [...(boot.notices ?? []), `studio-backend.json still says remote and could not be rewritten: ${boot.writeBlocked}`]
    return { runtime, written: false, notice: migrationNotice(runtime) }
  }
  if (opts.clientKeysFailed) {
    log.warn(`[Backend] Not rewriting ${boot.configPath} from remote mode: the client keys could not be migrated (${opts.clientKeysFailed}). This launch runs Local with ${what}; the next launch migrates both again`)
    boot.notices = [...(boot.notices ?? []), `studio-backend.json still says remote: ${opts.clientKeysFailed}.`]
    return { runtime, written: false, notice: migrationNotice(runtime) }
  }
  try {
    await writeJsonAtomicAsync(boot.configPath, next)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.warn(`[Backend] Could not write the migrated ${boot.configPath} (${message}); this launch runs Local with ${what}, and the next launch migrates it again`)
    boot.notices = [...(boot.notices ?? []), `studio-backend.json still says remote: it could not be rewritten (${message}).`]
    return { runtime, written: false, notice: migrationNotice(runtime) }
  }
  boot.remoteModePending = null
  log.log(`[Backend] Migrated ${boot.configPath} from remote mode to Local, with ${what} in the runtime set; runtime order ${next.runtimeOrder!.join(', ') || '(none)'}`)
  return { runtime, written: true, notice: migrationNotice(runtime) }
}

const FLEET_KEYS = ['fleetGroups', 'fleetStewards', 'fleetMapState'] as const

/** In studio-client-settings.json while studio-backend.json still says remote: its client keys were migrated. */
export const REMOTE_MODE_MIGRATED_KEY = 'remoteModeMigrated'

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
 * `remoteModeRecentFiles` and an agent windows list saved for `remote:…` are
 * remote mode's whenever they are there. The plain fleet keys are not: in a
 * file marked `remoteModeMigrated` they are This computer's (written since
 * the client keys were migrated), so they never move; unmarked, they move
 * only while the runtime has no `runtimeFleet` entry, and only a key copied
 * there is deleted.
 */
export function migrateRemoteModeClientKeys(data: Record<string, unknown>, config: Pick<StudioBackendConfig, 'remote'>, runtime: RemoteModeRuntime | null, saved: Record<string, Pick<SavedRemote, 'fingerprint'>>): string[] {
  const changed: string[] = []
  const marked = data[REMOTE_MODE_MIGRATED_KEY] === true
  const id = runtime?.id ?? null
  if (id && Array.isArray(data.remoteRecentFiles)) {
    const recents = isObject(data.runtimeRecentFiles) ? { ...data.runtimeRecentFiles } : {}
    const own = Array.isArray(recents[id]) ? (recents[id] as unknown[]) : []
    recents[id] = [...new Set([...data.remoteRecentFiles, ...own].filter((p): p is string => typeof p === 'string'))]
    data.runtimeRecentFiles = recents
    delete data.remoteRecentFiles
    changed.push('remoteRecentFiles → runtimeRecentFiles')
  }
  const fleet = isObject(data.runtimeFleet) ? { ...data.runtimeFleet } : {}
  if (id && !marked && !(id in fleet) && FLEET_KEYS.some((key) => key in data)) {
    const entry: Record<string, unknown> = {}
    for (const key of FLEET_KEYS) {
      if (!(key in data) || key in entry) continue
      entry[key] = data[key]
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
 * §7.4, §7.5 on `studio-client-settings.json`, before studio-backend.json
 * and before the client settings are loaded. Written atomically, and only
 * when a key changed (with `mark`, marked `remoteModeMigrated`). A file that cannot
 * be read or parsed is left to the client settings store (it quarantines a
 * corrupt one). Null: the file could not be written. Never throws.
 */
export async function migrateRemoteModeClientFile(userDataDir: string, config: Pick<StudioBackendConfig, 'remote'>, runtime: RemoteModeRuntime | null, saved: Record<string, SavedRemote>, log: Log = console, opts: { mark?: boolean } = {}): Promise<string[] | null> {
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
    await writeJsonAtomicAsync(path, opts.mark ? { ...data, [REMOTE_MODE_MIGRATED_KEY]: true } : data)
    log.log(`[Backend] Migrated the client keys of remote mode in ${path}: ${changed.join('; ')}`)
  } catch (err) {
    log.warn(`[Backend] Could not write the migrated client keys to ${path} (${errorText(err)}); they stay as they were`)
    return null
  }
  return changed
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Mark or unmark the client file (`remoteModeMigrated`): marked while
 * studio-backend.json still says remote after the client keys were migrated
 * (or held none), unmarked once it says local. A missing file is created
 * only to mark it. Logged on failure; never throws.
 */
async function markClientFile(userDataDir: string, mark: boolean, log: Log): Promise<void> {
  const path = clientSettingsPath(userDataDir)
  let data: unknown = {}
  try {
    const text = await fsp.readFile(path, 'utf-8')
    // Unmarking at every launch that reads mode local: a file without the key is not parsed.
    if (!mark && !text.includes(REMOTE_MODE_MIGRATED_KEY)) return
    data = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT' || !mark) return
  }
  if (!isObject(data) || (data[REMOTE_MODE_MIGRATED_KEY] === true) === mark) return
  if (mark) data[REMOTE_MODE_MIGRATED_KEY] = true
  else delete data[REMOTE_MODE_MIGRATED_KEY]
  try {
    await writeJsonAtomicAsync(path, data)
    log.log(`[Backend] ${mark ? 'Marked' : 'Unmarked'} ${path} (${REMOTE_MODE_MIGRATED_KEY}): studio-backend.json ${mark ? 'still says remote' : 'no longer says remote'}`)
  } catch (err) {
    log.warn(`[Backend] Could not ${mark ? 'mark' : 'unmark'} ${path} (${REMOTE_MODE_MIGRATED_KEY}): ${errorText(err)}`)
  }
}

/** The client keys' migration, applied in memory and marked (RemoteModeMigration.clientKeys). */
function clientKeysInMemory(config: Pick<StudioBackendConfig, 'remote'>, runtime: RemoteModeRuntime | null, saved: Record<string, Pick<SavedRemote, 'fingerprint'>>): (data: Record<string, unknown>) => string[] {
  return (data) => {
    const changed = migrateRemoteModeClientKeys(data, config, runtime, saved)
    if (data[REMOTE_MODE_MIGRATED_KEY] !== true) {
      data[REMOTE_MODE_MIGRATED_KEY] = true
      changed.push(REMOTE_MODE_MIGRATED_KEY)
    }
    return changed
  }
}

/**
 * The whole migration of §7.3 to §7.5, in a crash-safe order: the client
 * keys first, then studio-backend.json. A client file that cannot be
 * written leaves studio-backend.json in remote mode, so the next launch
 * migrates both; this launch migrates the client keys in memory
 * (`clientKeys`). With `savedUnreadable` (cli-remotes.json cannot be read)
 * only the client keys migrate, which need only `remote.name`;
 * studio-backend.json waits for a launch that can read the saved
 * connections, and Settings → Connections says so.
 *
 * Null when the file is not in remote mode (a client file still marked
 * `remoteModeMigrated` is unmarked), or the launch runs Inside Studio (it
 * leaves both files for the next launch).
 */
export async function migrateRemoteModeInstall(boot: BootBackend, userDataDir: string, saved: Record<string, SavedRemote>, log: Log = console, opts: { savedUnreadable?: string | null } = {}): Promise<RemoteModeMigration | null> {
  if (boot.config.mode !== 'remote') {
    // The mark holds only while studio-backend.json says remote; a stuck one would stop a later migration's fleet keys.
    await markClientFile(userDataDir, false, log)
    return null
  }
  if (boot.mode !== 'local') return null
  const legacy = boot.config
  const runtime = remoteModeRuntime(legacy, saved)
  const clientWrite = await migrateRemoteModeClientFile(userDataDir, legacy, runtime, saved, log, { mark: true })
  const clientKeys = clientWrite === null ? clientKeysInMemory(legacy, runtime, saved) : null
  if (opts.savedUnreadable) {
    log.warn(`[Backend] ${boot.configPath} is in remote mode; it migrates at the first launch that can read the saved connections (${opts.savedUnreadable})`)
    boot.notices = [...(boot.notices ?? []), 'studio-backend.json still says remote; it is migrated at the first launch that can read the saved connections.']
    // The client keys moved (or there were none): what This computer writes until then is its own.
    if (clientWrite !== null) await markClientFile(userDataDir, true, log)
    return { runtime, written: false, notice: null, clientKeys }
  }
  const migration = await migrateRemoteMode(boot, saved, log, clientWrite === null ? { clientKeysFailed: `${clientSettingsPath(userDataDir)} could not be written` } : {})
  // Written: the migration never runs again. Not written: a later run must not move what This computer writes meanwhile.
  if (clientWrite !== null && migration) await markClientFile(userDataDir, !migration.written, log)
  return migration ? { ...migration, clientKeys } : null
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

/** The client keys held per runtime other than This computer (§7.4). */
export const RUNTIME_KEYS = ['runtimeRecentFiles', 'runtimeFleet'] as const
export type RuntimeKey = (typeof RUNTIME_KEYS)[number]

/**
 * §7.4: the keys of a runtime that is no longer in the set go, so a computer
 * saved later under that id does not get them. One renamed (`moves`: the same
 * computer under another id) takes them to its new id, unless that id has
 * its own. Pure; null when nothing changed, so a file without such a runtime
 * is never rewritten.
 */
export function relinkRuntimeKeys(values: Partial<Record<RuntimeKey, unknown>>, keep: (id: string) => boolean, moves: ReadonlyMap<string, string> = new Map()): Partial<Record<RuntimeKey, Record<string, unknown>>> | null {
  const patch: Partial<Record<RuntimeKey, Record<string, unknown>>> = {}
  for (const key of RUNTIME_KEYS) {
    const held = values[key]
    if (!isObject(held)) continue
    const next = { ...held }
    let changed = false
    for (const id of Object.keys(held)) {
      if (keep(id)) continue
      const to = moves.get(id)
      if (to && keep(to) && !(to in next)) next[to] = held[id]
      delete next[id]
      changed = true
    }
    if (changed) patch[key] = next
  }
  return Object.keys(patch).length > 0 ? patch : null
}

/**
 * At launch: the ids whose computer is now saved under another name, by
 * fingerprint. From the saved agent windows (an entry of an id not in the
 * set whose fingerprint is a saved connection's, as relinkSavedAgentWindows
 * moves it), and the remote slot whose pairing became a saved connection.
 */
export function renamedRuntimes(windows: unknown, saved: Record<string, Pick<SavedRemote, 'fingerprint'>>, slot: { inSet: boolean; fingerprint: string | null }): Map<string, string> {
  const byFingerprint = (fp: string | null | undefined): string | null => {
    const name = fp ? Object.entries(saved).find(([, r]) => r.fingerprint === fp)?.[0] : undefined
    return name ? savedRuntimeId(name) : null
  }
  const moves = new Map<string, string>()
  if (!slot.inSet) {
    const to = byFingerprint(slot.fingerprint)
    if (to) moves.set(SLOT_RUNTIME, to)
  }
  const entries = isObject(windows) && Array.isArray(windows.windows) ? windows.windows : []
  for (const raw of entries) {
    if (!isObject(raw) || typeof raw.runtimeId !== 'string' || !raw.runtimeId.startsWith('remote:')) continue
    if (saved[raw.runtimeId.slice('remote:'.length)] || moves.has(raw.runtimeId)) continue
    const to = byFingerprint(typeof raw.fingerprint === 'string' ? raw.fingerprint : null)
    if (to) moves.set(raw.runtimeId, to)
  }
  return moves
}

/**
 * While Studio runs, cli-remotes.json changed (`adf pair`, `adf remotes
 * forget`, Studio's Add and Remove): a name gone whose fingerprint is now
 * under another name moved there; a name that now holds another fingerprint
 * is another computer (replaced).
 */
export function savedConnectionChanges(before: Record<string, Pick<SavedRemote, 'fingerprint'>>, after: Record<string, Pick<SavedRemote, 'fingerprint'>>): { moves: Map<string, string>; replaced: Set<string> } {
  const moves = new Map<string, string>()
  const replaced = new Set<string>()
  for (const [name, remote] of Object.entries(before)) {
    const now = after[name]
    if (now) {
      if (now.fingerprint !== remote.fingerprint) replaced.add(savedRuntimeId(name))
      continue
    }
    // Any name with that fingerprint, saved before or not (adf pair --as lab, then forget): relinkRuntimeKeys keeps its own keys.
    const to = Object.entries(after).find(([, r]) => r.fingerprint === remote.fingerprint)?.[0]
    if (to) moves.set(savedRuntimeId(name), savedRuntimeId(to))
  }
  return { moves, replaced }
}

/**
 * The client key `runtimeFingerprints`: the fingerprint of each remote
 * runtime that has keys, as last seen saved (forgetGoneRuntimeKeys writes
 * it; recordRuntimeFingerprintsOnWrite with a runtime's first keys). With
 * it the keys follow the fingerprint when Studio did not see the change, as
 * relinkSavedAgentWindows does with the fingerprint of each saved window.
 */
export const RUNTIME_FINGERPRINTS_KEY = 'runtimeFingerprints'

/**
 * §20 item 2: a write that gives a saved connection's runtime keys for the
 * first time records its fingerprint with them (`fingerprintOf`: from the
 * cached saved connections, no disk access), so a rename while Studio is
 * closed moves them at the next launch. A recorded fingerprint is left as it
 * is (forgetGoneRuntimeKeys compares it with the saved one); a write of the
 * record itself brings nothing.
 */
export function recordRuntimeFingerprintsOnWrite(store: { get(key: string): unknown; onWrite(extra: (values: Record<string, unknown>) => Record<string, unknown> | null): void }, fingerprintOf: (id: string) => string | null): void {
  store.onWrite((values) => {
    if (RUNTIME_FINGERPRINTS_KEY in values || !RUNTIME_KEYS.some((key) => isObject(values[key]))) return null
    const recorded = store.get(RUNTIME_FINGERPRINTS_KEY)
    const previous: Record<string, unknown> = isObject(recorded) ? recorded : {}
    const added: Record<string, string> = {}
    for (const key of RUNTIME_KEYS) {
      const held = values[key]
      if (!isObject(held)) continue
      for (const id of Object.keys(held)) {
        if (!id.startsWith('remote:') || typeof previous[id] === 'string' || added[id]) continue
        const fp = fingerprintOf(id)
        if (fp) added[id] = fp
      }
    }
    return Object.keys(added).length > 0 ? { [RUNTIME_FINGERPRINTS_KEY]: { ...previous, ...added } } : null
  })
}

/** `runtimeFingerprints` as a saved list, for savedConnectionChanges. */
function recordedConnections(recorded: unknown): Record<string, { fingerprint: string }> {
  if (!isObject(recorded)) return {}
  const out: Record<string, { fingerprint: string }> = {}
  for (const [id, fp] of Object.entries(recorded)) {
    if (id.startsWith('remote:') && typeof fp === 'string' && fp) out[id.slice('remote:'.length)] = { fingerprint: fp }
  }
  return out
}

/**
 * At launch: what changed since the keys' fingerprints were recorded (a name
 * gone whose fingerprint is under another name moved; a name that holds
 * another fingerprint was replaced), plus the moves renamedRuntimes finds
 * from the saved agent windows and the slot.
 */
export function launchRuntimeKeyChanges(recorded: unknown, windows: unknown, saved: Record<string, Pick<SavedRemote, 'fingerprint'>>, slot: { inSet: boolean; fingerprint: string | null }): { moves: Map<string, string>; replaced: Set<string> } {
  const changes = savedConnectionChanges(recordedConnections(recorded), saved)
  for (const [from, to] of renamedRuntimes(windows, saved, slot)) if (!changes.moves.has(from)) changes.moves.set(from, to)
  return changes
}

/**
 * The names in cli-remotes.json (readRemotesAsync, the one reader): no file
 * is no connection; a file that cannot be read or parsed is null (unknown),
 * and then no key is forgotten. A malformed entry still counts as a name.
 */
export async function savedConnectionNames(env: NodeJS.ProcessEnv): Promise<Set<string> | null> {
  const read = await readRemotesAsync(env)
  return read.unreadable ? null : read.names
}

type RuntimeKeyStore = { get(key: string): unknown; patch(values: Record<string, unknown>): void }

function runtimeKeyValues(settings: RuntimeKeyStore): Partial<Record<RuntimeKey, unknown>> {
  return Object.fromEntries(RUNTIME_KEYS.map((key) => [key, settings.get(key)]))
}

/** Remove, or another computer in the remote slot: the keys of `id` go now (§7.4). */
export function forgetRuntimeKeysOf(settings: RuntimeKeyStore, id: string, log: Log = console): void {
  const patch = relinkRuntimeKeys(runtimeKeyValues(settings), (other) => other !== id)
  if (!patch) return
  log.log(`[Connection] Open Recent and Mesh view keys of ${id} removed (${Object.keys(patch).join(', ')})`)
  settings.patch(patch)
}

/**
 * At launch and whenever cli-remotes.json changes: the keys of each runtime
 * not in the set go, or move to its new id (`moves`); an id in `replaced`
 * is another computer now. Nothing goes while cli-remotes.json cannot be
 * read or parsed (said in the log). Never throws.
 */
export async function forgetGoneRuntimeKeys(settings: RuntimeKeyStore, env: NodeJS.ProcessEnv, slotInSet: () => boolean, changes: { moves?: ReadonlyMap<string, string>; replaced?: ReadonlySet<string> } = {}, log: Log = console): Promise<void> {
  const before = runtimeKeyValues(settings)
  if (!RUNTIME_KEYS.some((key) => isObject(before[key]) && Object.keys(before[key] as object).length > 0) && !isObject(settings.get(RUNTIME_FINGERPRINTS_KEY))) return
  const read = await readRemotesAsync(env)
  if (read.unreadable) {
    log.warn(`[Connection] ${remotesFilePath(env)} could not be read; the Open Recent and Mesh view keys of every runtime are kept`)
    return
  }
  // §20 item 4: read again after the await, and patched in the same synchronous stretch, so a window's merge meanwhile
  // is kept; relinkRuntimeKeys changes only the ids that go or move.
  const values = runtimeKeyValues(settings)
  const recorded = settings.get(RUNTIME_FINGERPRINTS_KEY)
  const names = read.names
  const saved = read.file.remotes
  // What changed since the fingerprints were recorded, then what the caller saw change (it wins).
  const since = savedConnectionChanges(recordedConnections(recorded), saved)
  const moves = new Map([...since.moves, ...(changes.moves ?? [])])
  const replaced = new Set([...since.replaced, ...(changes.replaced ?? [])])
  const keep = (id: string): boolean => id === LOCAL_RUNTIME || (id === SLOT_RUNTIME ? slotInSet() : id.startsWith('remote:') && names.has(id.slice('remote:'.length)) && !replaced.has(id))
  const patch: Record<string, unknown> = relinkRuntimeKeys(values, keep, moves) ?? {}
  if (Object.keys(patch).length > 0) log.log(`[Connection] Open Recent and Mesh view keys of runtimes no longer in the set removed, or moved to the new name of the same computer (${Object.keys(patch).join(', ')})`)
  // The fingerprint of each remote runtime that has keys now (a malformed entry keeps the one recorded).
  const after: Record<string, unknown> = { ...values, ...patch }
  const previous = isObject(recorded) ? recorded : {}
  const record: Record<string, string> = {}
  for (const key of RUNTIME_KEYS) {
    const held = after[key]
    if (!isObject(held)) continue
    for (const id of Object.keys(held)) {
      if (!id.startsWith('remote:')) continue
      const fp = saved[id.slice('remote:'.length)]?.fingerprint ?? (typeof previous[id] === 'string' ? previous[id] : null)
      if (fp) record[id] = fp
    }
  }
  if (!isDeepStrictEqual(record, previous)) patch[RUNTIME_FINGERPRINTS_KEY] = Object.keys(record).length > 0 ? record : undefined
  if (Object.keys(patch).length > 0) settings.patch(patch)
}
