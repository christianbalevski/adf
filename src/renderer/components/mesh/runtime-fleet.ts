import type { AdfApi } from '../../../preload/api'
import type { AppSettings, FleetAgentStatus, FleetBurnResult, FleetMessageResult } from '../../../shared/types/ipc.types'
import { reportFailure } from '../../stores/failure-notices.store'
import { runtimeName } from '../../stores/runtimes.store'
import type { RuntimeView } from '../../../shared/types/connection.types'
import { agentKey, isRemoteAgentKey, parseAgentKey } from '../../../shared/types/agent-ref'
import { LOCAL_RUNTIME, type RuntimeId } from '../../../shared/runtime-tag'
import { selectMeshSlice, type MeshSlice } from '../../stores/mesh.store'
import { apiFor, openAgentKey } from '../../utils/runtime-api'

/**
 * The fleet map across runtimes (docs/design/multi-runtime.md §6.4).
 *
 * One map. This computer's agents are on it exactly as before. Every other
 * runtime of the set contributes its agents as one region: each agent's id on
 * the map is its agent key (runtime and path, agentKey), its region root is
 * the runtime's (`<runtime id>\n`), and its district is the tracked folder it
 * lives in. Equal paths or agent ids on two runtimes are two tiles.
 *
 * With This computer only nothing here changes what the map shows or calls:
 * `selectMapAgents` answers the store's own list.
 */

const REGION_SEPARATOR = '\n'

/** The region root of a runtime other than This computer. */
export function runtimeRegionRoot(runtimeId: RuntimeId): string {
  return `${runtimeId}${REGION_SEPARATOR}`
}

/** The runtime a region root names; null for one of This computer's folders. */
export function runtimeOfRegion(dirPath: string): RuntimeId | null {
  return dirPath.endsWith(REGION_SEPARATOR) && dirPath.indexOf(REGION_SEPARATOR) === dirPath.length - 1
    ? dirPath.slice(0, -1)
    : null
}

/** A map agent: a fleet status, with its district within a runtime's region. */
export type MapAgent = FleetAgentStatus & { district?: string; sourceRoot?: string }

/** Map key → district (the tracked folder, and the subfolder under it) within its runtime's region. */
const districts = new Map<string, string>()

/** The district of a map agent within a runtime's region ('' when unknown). */
export function runtimeDistrictOf(key: string): string {
  return districts.get(key) ?? ''
}

const sepOf = (p: string): '/' | '\\' => (!p.includes('/') && p.includes('\\') ? '\\' : '/')

/** The district of a remote agent: its tracked folder's name, then the subfolder it sits in. */
export function districtOfRemote(filePath: string, root: string | undefined): string {
  if (!root) return ''
  const sep = sepOf(filePath)
  const folder = root.split(/[\\/]/).filter(Boolean).pop() ?? root
  const dirEnd = filePath.lastIndexOf(sep)
  const dir = dirEnd > 0 ? filePath.slice(0, dirEnd) : ''
  if (dir === root) return folder
  if (dir.startsWith(root + sep)) return `${folder}/${dir.slice(root.length + 1).split(/[\\/]/).join('/')}`
  return folder
}

const mapped = new WeakMap<FleetAgentStatus, { runtimeId: RuntimeId; agent: MapAgent }>()

/** A remote runtime's agent as the map shows it (cached per source object, so selectors stay identity-stable). */
export function toMapAgent(runtimeId: RuntimeId, agent: FleetAgentStatus): MapAgent {
  const hit = mapped.get(agent)
  if (hit && hit.runtimeId === runtimeId) return hit.agent
  const key = agentKey({ runtimeId, filePath: agent.filePath })
  const district = districtOfRemote(agent.filePath, agent.trackedDirRoot)
  districts.set(key, district)
  const out: MapAgent = { ...agent, filePath: key, trackedDirRoot: runtimeRegionRoot(runtimeId), district, ...(agent.trackedDirRoot ? { sourceRoot: agent.trackedDirRoot } : {}) }
  mapped.set(agent, { runtimeId, agent: out })
  return out
}

/** Every runtime's agents on one list: This computer's first, as they are. */
export function mapAgentsOf(local: FleetAgentStatus[], remotes: ReadonlyArray<{ runtimeId: RuntimeId; agents: FleetAgentStatus[] }>): FleetAgentStatus[] {
  if (remotes.length === 0) return local
  const out: FleetAgentStatus[] = [...local]
  for (const { runtimeId, agents } of remotes) for (const a of agents) out.push(toMapAgent(runtimeId, a))
  return out
}

type MeshState = MeshSlice & { byRuntime: Record<RuntimeId, MeshSlice> }

let lastLocal: FleetAgentStatus[] | null = null
let lastByRuntime: Record<RuntimeId, MeshSlice> | null = null
let lastMerged: FleetAgentStatus[] = []

/**
 * The map's agents from the mesh store (memoized on the store's slices): the
 * top-level list itself while no other runtime has a slice.
 */
export function selectMapAgents(s: MeshState): FleetAgentStatus[] {
  const ids = Object.keys(s.byRuntime)
  if (ids.length === 0) return s.agents
  if (s.agents === lastLocal && s.byRuntime === lastByRuntime) return lastMerged
  lastLocal = s.agents
  lastByRuntime = s.byRuntime
  lastMerged = mapAgentsOf(s.agents, ids.map((runtimeId) => ({ runtimeId, agents: selectMeshSlice(s, runtimeId).agents })))
  return lastMerged
}

/** The runtime, path and surface a map key stands for. */
export function mapTarget(key: string): { runtimeId: RuntimeId; filePath: string; api: AdfApi } {
  if (!isRemoteAgentKey(key)) return { runtimeId: LOCAL_RUNTIME, filePath: key, api: window.adfApi }
  const { runtimeId, filePath } = parseAgentKey(key)
  return { runtimeId, filePath, api: apiFor(runtimeId) }
}

/** The map key is the main window's open agent (its foreground calls apply). */
export function isOpenOnMap(key: string): boolean {
  return openAgentKey() === key
}

/** Map keys grouped by runtime, each with the paths of that runtime (one call per runtime, §6.4). */
export function byRuntime(keys: readonly string[]): Map<RuntimeId, string[]> {
  const out = new Map<RuntimeId, string[]>()
  for (const key of keys) {
    const { runtimeId, filePath } = isRemoteAgentKey(key) ? parseAgentKey(key) : { runtimeId: LOCAL_RUNTIME, filePath: key }
    const list = out.get(runtimeId) ?? []
    list.push(filePath)
    out.set(runtimeId, list)
  }
  return out
}

/** A remote runtime's burn read, under the map's keys. */
export function keyedBurn(runtimeId: RuntimeId, burn: FleetBurnResult | null): FleetBurnResult['perAgent'] {
  const out: FleetBurnResult['perAgent'] = {}
  for (const [fp, e] of Object.entries(burn?.perAgent ?? {})) out[agentKey({ runtimeId, filePath: fp })] = e
  return out
}

/** This computer's burn with every other runtime's agents added under their keys; the fleet line adds theirs. */
export function mergeBurn(local: FleetBurnResult | null, remotes: ReadonlyArray<{ runtimeId: RuntimeId; burn: FleetBurnResult | null }>): FleetBurnResult | null {
  if (remotes.length === 0) return local
  const fleet = { ...(local?.fleet ?? { tokensPerMin: 0, inPerMin: 0, outPerMin: 0, totalTokens: 0 }) }
  const perAgent = { ...(local?.perAgent ?? {}) }
  for (const { runtimeId, burn } of remotes) {
    if (!burn) continue
    Object.assign(perAgent, keyedBurn(runtimeId, burn))
    fleet.tokensPerMin += burn.fleet.tokensPerMin
    fleet.inPerMin += burn.fleet.inPerMin
    fleet.outPerMin += burn.fleet.outPerMin
    fleet.totalTokens += burn.fleet.totalTokens
  }
  return { perAgent, fleet }
}

/** A peer the polls report, as the map draws it. */
export interface MapPeer {
  runtime_id: string
  runtime_did?: string
  first_seen?: number
  [key: string]: unknown
}

/**
 * The peer stations of every runtime's poll (§6.4): a peer that is a runtime
 * of the set (its runtime DID is one of theirs) is drawn as that runtime's
 * region, not as a station; every other peer is one station per runtime id,
 * the first poll that reports it winning.
 */
export function mergePeers<P extends MapPeer>(polls: ReadonlyArray<readonly P[]>, setDids: ReadonlySet<string>): P[] {
  const seen = new Set<string>()
  const out: P[] = []
  for (const peers of polls) {
    for (const p of peers) {
      if (p.runtime_did && setDids.has(p.runtime_did)) continue
      if (seen.has(p.runtime_id)) continue
      seen.add(p.runtime_id)
      out.push(p)
    }
  }
  return out
}

// ---- Per-runtime client keys (multi-runtime.md §7.4) ------------------------
//
// This computer keeps fleetGroups, fleetStewards and fleetMapState exactly as
// before. The entries of another runtime (map keys `<runtime id>\n<path>`)
// are kept under runtimeFleet[<runtime id>], with that runtime's own paths:
// the prefix comes off on save and goes back on load. With This computer only
// no write names runtimeFleet.

export type RuntimeFleetEntry = NonNullable<AppSettings['runtimeFleet']>[string]
export type RuntimeFleetStore = Record<RuntimeId, RuntimeFleetEntry>

/** runtimeFleet as last read or written: entries of runtimes not in the set now are kept. */
let storedRuntimeFleet: RuntimeFleetStore = {}

export function setStoredRuntimeFleet(value: unknown): void {
  storedRuntimeFleet = value && typeof value === 'object' && !Array.isArray(value) ? { ...(value as RuntimeFleetStore) } : {}
}

export function storedRuntimeFleetOf(): RuntimeFleetStore {
  return storedRuntimeFleet
}

/** The runtime of a map key (or region root, district anchor); null for This computer's. */
export function keyRuntime(key: string): RuntimeId | null {
  const at = key.indexOf(REGION_SEPARATOR)
  return at < 0 ? null : key.slice(0, at)
}

const withoutRuntime = (key: string): string => key.slice(key.indexOf(REGION_SEPARATOR) + 1)
const withRuntime = (runtimeId: RuntimeId, key: string): string => `${runtimeId}${REGION_SEPARATOR}${key}`

/** A keyed record split by runtime: This computer's entries as they are, every other runtime's without its prefix. */
export function splitRecord<V>(record: Record<string, V>): { local: Record<string, V>; remote: Record<RuntimeId, Record<string, V>> } {
  if (!Object.keys(record).some((k) => k.includes(REGION_SEPARATOR))) return { local: record, remote: {} }
  const local: Record<string, V> = {}
  const remote: Record<RuntimeId, Record<string, V>> = {}
  for (const [key, value] of Object.entries(record)) {
    const rt = keyRuntime(key)
    if (rt === null) local[key] = value
    else (remote[rt] ??= {})[withoutRuntime(key)] = value
  }
  return { local, remote }
}

/** A runtime's saved record back under the map's keys. */
export function prefixRecord<V>(runtimeId: RuntimeId, record: Record<string, V> | undefined): Record<string, V> {
  const out: Record<string, V> = {}
  for (const [key, value] of Object.entries(record ?? {})) out[withRuntime(runtimeId, key)] = value
  return out
}

/** Named groups split by runtime: each runtime keeps its members of a group (a group can span runtimes). */
export function splitGroups(groups: Record<string, string[]>): { local: Record<string, string[]>; remote: Record<RuntimeId, Record<string, string[]>> } {
  if (!Object.values(groups).some((members) => members.some((m) => m.includes(REGION_SEPARATOR)))) return { local: groups, remote: {} }
  const local: Record<string, string[]> = {}
  const remote: Record<RuntimeId, Record<string, string[]>> = {}
  for (const [name, members] of Object.entries(groups)) {
    const mine = members.filter((m) => !m.includes(REGION_SEPARATOR))
    if (mine.length > 0 || members.length === 0) local[name] = mine
    for (const m of members) {
      const rt = keyRuntime(m)
      if (rt === null) continue
      ;((remote[rt] ??= {})[name] ??= []).push(withoutRuntime(m))
    }
  }
  return { local, remote }
}

/** This computer's groups with every saved runtime's members added under their keys. */
export function mergeGroups(local: Record<string, string[]>, store: RuntimeFleetStore): Record<string, string[]> {
  const ids = Object.keys(store).filter((id) => store[id]?.fleetGroups && Object.keys(store[id].fleetGroups!).length > 0)
  if (ids.length === 0) return local
  const out: Record<string, string[]> = {}
  for (const [name, members] of Object.entries(local)) out[name] = [...members]
  for (const id of ids) {
    for (const [name, members] of Object.entries(store[id].fleetGroups!)) {
      out[name] = [...(out[name] ?? []), ...members.map((m) => withRuntime(id, m))]
    }
  }
  return out
}

/** Stewards (folder → DID) of This computer with every saved runtime's added under their keys. */
export function mergeStewards(local: Record<string, string>, store: RuntimeFleetStore): Record<string, string> {
  let out = local
  for (const [id, entry] of Object.entries(store)) {
    if (!entry?.fleetStewards || Object.keys(entry.fleetStewards).length === 0) continue
    out = { ...out, ...prefixRecord(id, entry.fleetStewards) }
  }
  return out
}

/** The runtimes of the set other than This computer, while there is more than one. */
function otherRuntimes(runtimes: readonly RuntimeView[]): RuntimeId[] {
  return runtimes.length > 1 ? runtimes.filter((r) => r.id !== LOCAL_RUNTIME).map((r) => r.id) : []
}

/**
 * The settings patch of a fleet-map save: This computer's keys as before;
 * with more than one runtime, runtimeFleet with every other runtime's part
 * (`parts`), keeping the saved entries of runtimes not in the set.
 */
export function fleetSettingsPatch(
  local: Partial<Pick<AppSettings, 'fleetGroups' | 'fleetStewards' | 'fleetMapState'>>,
  parts: Record<RuntimeId, Partial<RuntimeFleetEntry>>,
  runtimes: readonly RuntimeView[],
): Record<string, unknown> {
  const ids = otherRuntimes(runtimes)
  if (ids.length === 0) return local
  const next: RuntimeFleetStore = { ...storedRuntimeFleet }
  const fields = Object.keys(local) as Array<keyof RuntimeFleetEntry>
  for (const id of ids) {
    const entry: RuntimeFleetEntry = { ...(next[id] ?? {}) }
    for (const field of fields) {
      const value = parts[id]?.[field]
      if (value !== undefined) (entry as Record<string, unknown>)[field] = value
      else if (field === 'fleetGroups' || field === 'fleetStewards') delete (entry as Record<string, unknown>)[field]
    }
    next[id] = entry
  }
  storedRuntimeFleet = next
  return { ...local, runtimeFleet: next }
}

/** Save named groups and/or stewards (map keys) as their client keys. */
export function saveFleetKeys(patch: { groups?: Record<string, string[]>; stewards?: Record<string, string> }, runtimes: readonly RuntimeView[]): Promise<{ success: boolean }> {
  const local: Partial<Pick<AppSettings, 'fleetGroups' | 'fleetStewards'>> = {}
  const parts: Record<RuntimeId, Partial<RuntimeFleetEntry>> = {}
  if (patch.groups) {
    const { local: g, remote } = splitGroups(patch.groups)
    local.fleetGroups = g
    for (const [id, groups] of Object.entries(remote)) (parts[id] ??= {}).fleetGroups = groups
  }
  if (patch.stewards) {
    const { local: st, remote } = splitRecord(patch.stewards)
    local.fleetStewards = st
    for (const [id, stewards] of Object.entries(remote)) (parts[id] ??= {}).fleetStewards = stewards
  }
  return window.adfApi.setSettings(fleetSettingsPatch(local, parts, runtimes))
}

/**
 * A message to selected agents, one call per runtime (§6.4): a runtime that
 * refuses is said, and its agents count as failed; the others are sent. With
 * This computer's agents only it is the one call made before.
 */
export async function messageByRuntime(keys: string[], content: string): Promise<FleetMessageResult> {
  const groups = byRuntime(keys)
  if (groups.size === 1 && groups.has(LOCAL_RUNTIME)) return window.adfApi.messageFleetAgents(keys, content)
  const out: FleetMessageResult = { delivered: [], failed: [] }
  const keyOf = (runtimeId: RuntimeId, filePath: string) => agentKey({ runtimeId, filePath })
  await Promise.all([...groups].map(async ([runtimeId, paths]) => {
    try {
      const result = await apiFor(runtimeId).messageFleetAgents(paths, content)
      out.delivered.push(...result.delivered.map((fp) => keyOf(runtimeId, fp)))
      out.failed.push(...result.failed.map((f) => ({ ...f, filePath: keyOf(runtimeId, f.filePath) })))
    } catch (err) {
      reportFailure(`${runtimeName(runtimeId)}: message not sent`, err)
      const error = err instanceof Error ? err.message : String(err)
      out.failed.push(...paths.map((fp) => ({ filePath: keyOf(runtimeId, fp), error })))
    }
  }))
  return out
}
