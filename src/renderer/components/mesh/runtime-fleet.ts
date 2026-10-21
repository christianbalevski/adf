import type { AdfApi } from '../../../preload/api'
import type { AppSettings, FleetAgentStatus, FleetBurnResult, FleetMessageResult, MeshEvent } from '../../../shared/types/ipc.types'
import { reportFailure } from '../../stores/failure-notices.store'
import { runtimeName } from '../../stores/runtimes.store'
import type { RuntimeView } from '../../../shared/types/connection.types'
import { agentKey, isRemoteAgentKey, parseAgentKey } from '../../../shared/types/agent-ref'
import { LOCAL_RUNTIME, type RuntimeId } from '../../../shared/runtime-tag'
import { selectMeshSlice, type MeshSlice } from '../../stores/mesh.store'
import { apiFor, openAgentKey } from '../../utils/runtime-api'
import { useFleetStore } from '../../stores/fleet.store'

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
  /** The peer's mesh address. */
  url?: string
  host?: string
  /** Remote access fingerprint and daemon port (TXT `fp`, `daemon_port`), when it announces them. */
  fingerprint?: string
  daemon_port?: number
  /** Its directory: one stub tile per agent. */
  agents?: Array<{ handle: string; did?: string }>
  [key: string]: unknown
}

/**
 * What ties a peer of a poll to a runtime of the set (§6.4), built per poll
 * from what each runtime's connection checked: nothing a peer record says
 * by itself (address, directory, an earlier match) counts.
 */
export interface PeerMatch {
  /** Runtime DID per runtime of the set, read over its connection (GET /identity; null: not read). */
  dids: Readonly<Record<RuntimeId, string | null | undefined>>
  /** The remote runtimes of the set, with the fingerprint pinned when they were paired (the authenticated hello checks it). */
  remotes: ReadonlyArray<{ id: RuntimeId; fingerprint: string | null }>
  /** Agent DID → the runtime of the set whose tile it is (only to drop those stubs from a station). */
  agentDids: ReadonlyMap<string, RuntimeId>
}

/**
 * The runtime of the set a peer is, or null for a peer the map does not
 * manage: its runtime DID is the one read over that runtime's connection, or
 * its fingerprint is the one pinned for it. An address, a directory of the
 * map's agent DIDs or a match in an earlier poll is not enough: any host on
 * the LAN can announce those.
 */
export function managedRuntimeOf(p: MapPeer, m: PeerMatch): RuntimeId | null {
  if (p.runtime_did) {
    for (const [id, did] of Object.entries(m.dids)) if (did && did === p.runtime_did) return id
  }
  if (p.fingerprint) {
    const hit = m.remotes.find((r) => r.fingerprint && r.fingerprint === p.fingerprint)
    if (hit) return hit.id
  }
  return null
}

/** The peer without the stubs whose agent DID is a tile of the map (the peer itself when none is). */
function withoutManagedStubs<P extends MapPeer>(p: P, agentDids: ReadonlyMap<string, RuntimeId>): P {
  if (!p.agents || !p.agents.some((a) => a.did && agentDids.has(a.did))) return p
  return { ...p, agents: p.agents.filter((a) => !(a.did && agentDids.has(a.did))) }
}

/** A set of runtime DIDs as a PeerMatch (by runtime DID only). */
function matchOfDids(setDids: ReadonlySet<string>): PeerMatch {
  const dids: Record<string, string> = {}
  for (const did of setDids) dids[did] = did
  return { dids, remotes: [], agentDids: new Map() }
}

/**
 * The peer stations of every runtime's poll (§6.4): a peer that is a runtime
 * of the set (managedRuntimeOf) is drawn as that runtime's region, not as a
 * station; every other peer is one station per runtime id, the first poll
 * that reports it winning, without the stubs that are tiles of the map.
 * A runtime_id matched in one list is that runtime in every list of the
 * same poll. `onMatch` hears each runtime_id matched (for traffic and
 * regionFromStation; the next poll matches afresh).
 */
export function mergePeers<P extends MapPeer>(
  polls: ReadonlyArray<readonly P[]>,
  match: PeerMatch | ReadonlySet<string>,
  onMatch?: (peerRuntimeId: string, runtime: RuntimeId) => void,
): P[] {
  const m = match instanceof Set ? matchOfDids(match) : (match as PeerMatch)
  const managed = new Map<string, RuntimeId>()
  for (const peers of polls) {
    for (const p of peers) {
      if (managed.has(p.runtime_id)) continue
      const rt = managedRuntimeOf(p, m)
      if (rt) managed.set(p.runtime_id, rt)
    }
  }
  for (const [rid, rt] of managed) onMatch?.(rid, rt)
  const seen = new Set<string>()
  const out: P[] = []
  for (const peers of polls) {
    for (const p of peers) {
      if (managed.has(p.runtime_id) || seen.has(p.runtime_id)) continue
      seen.add(p.runtime_id)
      out.push(withoutManagedStubs(p, m.agentDids))
    }
  }
  return out
}

/** Agent DID → runtime, over the map's agents. */
export function agentDidsOf(agents: readonly FleetAgentStatus[]): Map<string, RuntimeId> {
  const out = new Map<string, RuntimeId>()
  for (const a of agents) if (a.did) out.set(a.did, keyRuntime(a.filePath) ?? LOCAL_RUNTIME)
  return out
}

// ---- Cross-runtime traffic (§6.4) -------------------------------------------
//
// A runtime reports a message to or from another runtime as traffic with that
// peer's station (`station:peer:<runtime_id>`, and the agent at the other
// end). When that peer is a runtime of the set its station is not drawn, so
// the message is drawn between the two tiles instead: the peer's runtime_id
// gives the runtime (as the polls matched it), the agent's DID or handle the
// tile, looked up within that runtime only.

const PEER_STATION = 'station:peer:'

/** Peer runtime_id → runtime of the set, as the last poll matched them. Empty with This computer only. */
let peerRuntimes: Readonly<Record<string, RuntimeId>> = {}

export function setPeerRuntimes(next: Readonly<Record<string, RuntimeId>>): void {
  peerRuntimes = next
}

/** What a Mesh view's polls keep per runtime id (MeshGraphView's RemotePollState). */
export interface PeerMatchState {
  seq: Record<string, number>
  errors: Record<string, string>
  dids: Record<string, string | null>
  didRetry?: Record<string, { at: number; wait: number }>
  learned?: Record<string, string>
}

/** The poll states of the mounted Mesh views. */
const matchStates = new Set<PeerMatchState>()

/** A Mesh view's poll state, until the returned function is called (unmount). */
export function trackPeerMatchState(state: PeerMatchState): () => void {
  matchStates.add(state)
  return () => { matchStates.delete(state) }
}

/**
 * Ids that are another computer now, or moved (RUNTIMES_MOVED, §17): their
 * runtime DID, its retry, the log cursor and every match to them go, so the
 * next poll reads and matches them again.
 */
export function forgetRuntimeMatches(ids: Iterable<RuntimeId>): void {
  const gone = new Set(ids)
  if (gone.size === 0) return
  for (const state of matchStates) {
    for (const id of gone) {
      delete state.dids[id]
      delete state.seq[id]
      delete state.errors[id]
      if (state.didRetry) delete state.didRetry[id]
    }
    if (state.learned) for (const [rid, id] of Object.entries(state.learned)) if (gone.has(id)) delete state.learned[rid]
  }
  if (Object.values(peerRuntimes).some((id) => gone.has(id))) {
    peerRuntimes = Object.fromEntries(Object.entries(peerRuntimes).filter(([, id]) => !gone.has(id)))
  }
}

/** Per agent list: DID and handle → path (DIDs first; a handle never hides a DID). */
const tileIndex = new WeakMap<readonly FleetAgentStatus[], Map<string, string>>()

function tileOf(agents: readonly FleetAgentStatus[], id: string): string | null {
  let index = tileIndex.get(agents)
  if (!index) {
    index = new Map()
    for (const a of agents) if (a.did) index.set(a.did, a.filePath)
    for (const a of agents) if (a.handle && !index.has(a.handle)) index.set(a.handle, a.filePath)
    tileIndex.set(agents, index)
  }
  return index.get(id) ?? null
}

/** The map key of the tile of a peer's agent, when the peer is a runtime of the set. */
export function peerAgentTile(peerRuntimeId: string, id: string | undefined, agentsOf: (runtime: RuntimeId) => readonly FleetAgentStatus[]): string | null {
  const runtime = peerRuntimes[peerRuntimeId]
  if (!runtime || !id) return null
  const filePath = tileOf(agentsOf(runtime), id)
  return filePath === null ? null : agentKey({ runtimeId: runtime, filePath })
}

/**
 * One message is reported twice when both ends are runtimes of the set: the
 * sender's runtime reports it leaving, the recipient's arriving. Each report
 * waits this long for its twin, which is then not drawn again.
 */
const TWIN_MS = 15_000
const twins = new Map<string, { out: number[]; in: number[] }>()

function isTwin(route: string, side: 'out' | 'in', now: number): boolean {
  const entry = twins.get(route) ?? { out: [], in: [] }
  entry.out = entry.out.filter((t) => now - t < TWIN_MS)
  entry.in = entry.in.filter((t) => now - t < TWIN_MS)
  const other = side === 'out' ? entry.in : entry.out
  const twin = other.length > 0
  if (twin) other.shift()
  else entry[side].push(now)
  if (entry.out.length === 0 && entry.in.length === 0) twins.delete(route)
  else twins.set(route, entry)
  return twin
}

/** For tests: no peer matched, no report waiting for its twin. */
export function resetPeerTraffic(): void {
  twins.clear()
  peerRuntimes = {}
}

type RoutedPayload = {
  filePath: string
  toFilePaths?: string[]
  toPeerAgent?: { runtimeId: string; id: string }
  fromPeerAgent?: { runtimeId: string; id: string }
}

/**
 * A message_routed event with a managed peer's station replaced by the tile
 * at the other end (egress: `toPeerAgent`; ingress: `fromPeerAgent`). The
 * event itself when nothing resolves (a peer the map does not manage, This
 * computer only); null when it is the twin of a report already drawn.
 */
export function resolvePeerTraffic(event: MeshEvent, agentsOf: (runtime: RuntimeId) => readonly FleetAgentStatus[], now = Date.now()): MeshEvent | null {
  if (event.type !== 'message_routed') return event
  const payload = event.payload as RoutedPayload
  const to = payload.toFilePaths ?? []
  // Egress: one station target, and the agent it is bound for.
  if (to.length === 1 && to[0].startsWith(PEER_STATION) && payload.toPeerAgent) {
    const tile = peerAgentTile(to[0].slice(PEER_STATION.length), payload.toPeerAgent.id, agentsOf)
    if (!tile || tile === payload.filePath) return event
    if (isTwin(`${payload.filePath}|${tile}`, 'out', now)) return null
    const { toPeerAgent: _resolved, ...rest } = payload
    return { ...event, payload: { ...rest, toFilePaths: [tile] } } as MeshEvent
  }
  // Ingress: from the station, sent by the agent named.
  if (typeof payload.filePath === 'string' && payload.filePath.startsWith(PEER_STATION) && payload.fromPeerAgent && to.length === 1) {
    const tile = peerAgentTile(payload.filePath.slice(PEER_STATION.length), payload.fromPeerAgent.id, agentsOf)
    if (!tile || tile === to[0]) return event
    if (isTwin(`${tile}|${to[0]}`, 'in', now)) return null
    const { fromPeerAgent: _resolved, ...rest } = payload
    return { ...event, payload: { ...rest, filePath: tile } } as MeshEvent
  }
  return event
}

// ---- Per-runtime client keys (multi-runtime.md §7.4) ------------------------
//
// This computer keeps fleetGroups, fleetStewards and fleetMapState exactly as
// before. The entries of another runtime (map keys `<runtime id>\n<path>`)
// are kept under runtimeFleet[<runtime id>], with that runtime's own paths:
// the prefix comes off on save and goes back on load. With This computer only
// no write names runtimeFleet.
//
// A save sends, per runtime of the set, only the fields it saves; main merges
// them into what it holds per runtime and per field (mergeRuntimeFleet), so a
// save never writes back an entry main moved or removed (§17).

export type RuntimeFleetEntry = NonNullable<AppSettings['runtimeFleet']>[string]
export type RuntimeFleetStore = Record<RuntimeId, RuntimeFleetEntry>

/** runtimeFleet as main holds it: read when the Mesh view mounts and when the runtime set changes, and as written here. */
let storedRuntimeFleet: RuntimeFleetStore = {}

export function setStoredRuntimeFleet(value: unknown): void {
  storedRuntimeFleet = value && typeof value === 'object' && !Array.isArray(value) ? { ...(value as RuntimeFleetStore) } : {}
}

export function storedRuntimeFleetOf(): RuntimeFleetStore {
  return storedRuntimeFleet
}

/**
 * A runtime left the set (Remove, `adf remotes forget`): main deleted its
 * runtimeFleet entry, so the copy here goes too, or the next save of
 * another runtime's part would write it back.
 */
export function forgetRuntimeFleet(runtimeId: RuntimeId): void {
  if (!(runtimeId in storedRuntimeFleet)) return
  const { [runtimeId]: _gone, ...rest } = storedRuntimeFleet
  storedRuntimeFleet = rest
}

/**
 * The same computer under another id (a rename, the remote slot cleared,
 * §17): its copy goes to the new id, as main moves it; an entry the new id
 * already has wins.
 */
export function moveRuntimeFleet(from: RuntimeId, to: RuntimeId): void {
  if (!(from in storedRuntimeFleet)) return
  const { [from]: entry, ...rest } = storedRuntimeFleet
  storedRuntimeFleet = to in rest ? rest : { ...rest, [to]: entry }
}

/**
 * The runtime set changed (§17): runtimeFleet is read again from main, and a
 * runtime the map has nothing of gets its saved groups, stewards and
 * placement (once the Mesh view has loaded the map). A failed read keeps the
 * copy, logged.
 */
export async function reloadRuntimeFleet(runtimes: readonly RuntimeView[], api: Pick<AdfApi, 'getSettings'> = window.adfApi): Promise<void> {
  let settings: { runtimeFleet?: unknown } | null
  try {
    settings = await api.getSettings() as { runtimeFleet?: unknown } | null
  } catch (err) {
    console.warn('[Mesh] runtimeFleet was not read again after the runtime set changed:', err)
    return
  }
  setStoredRuntimeFleet(settings?.runtimeFleet)
  const fleet = useFleetStore.getState()
  if (!fleet.placement) return
  const placement = fleet.placement
  const has = (id: RuntimeId): boolean => {
    const prefix = runtimeRegionRoot(id)
    const keys = [
      ...Object.values(fleet.namedGroups).flat(),
      ...Object.keys(fleet.stewards),
      ...Object.keys(placement.regionOrigins),
      ...Object.keys(placement.cellPins),
      ...Object.keys(placement.districtAnchors ?? {}),
    ]
    return keys.some((k) => k.startsWith(prefix))
  }
  const joined = otherRuntimes(runtimes).filter((id) => storedRuntimeFleet[id] && !has(id))
  if (joined.length === 0) return
  const saved: RuntimeFleetStore = Object.fromEntries(joined.map((id) => [id, storedRuntimeFleet[id]]))
  const pick = (field: 'regionOrigins' | 'cellPins' | 'districtAnchors') =>
    Object.assign({}, ...joined.map((id) => prefixRecord(id, saved[id]?.fleetMapState?.placement?.[field] as Record<string, { q: number; r: number }> | undefined)))
  console.log(`[Mesh] Saved groups, stewards and placement of ${joined.join(', ')} added to the map`)
  useFleetStore.setState({
    namedGroups: mergeGroups(fleet.namedGroups, saved),
    stewards: mergeStewards(fleet.stewards, saved),
    placement: {
      ...placement,
      regionOrigins: { ...placement.regionOrigins, ...pick('regionOrigins') },
      cellPins: { ...placement.cellPins, ...pick('cellPins') },
      districtAnchors: { ...(placement.districtAnchors ?? {}), ...pick('districtAnchors') },
    },
  })
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
 * with more than one runtime, runtimeFleet with each other runtime's part
 * (`parts`): only the fields saved (groups and stewards a runtime has none
 * of are saved empty), only for runtimes of the set. Main merges it per
 * runtime and per field, so the entries of runtimes not in the set, and the
 * fields not saved, stay as main holds them.
 */
export function fleetSettingsPatch(
  local: Partial<Pick<AppSettings, 'fleetGroups' | 'fleetStewards' | 'fleetMapState'>>,
  parts: Record<RuntimeId, Partial<RuntimeFleetEntry>>,
  runtimes: readonly RuntimeView[],
): Record<string, unknown> {
  const ids = otherRuntimes(runtimes)
  if (ids.length === 0) return local
  const fields = Object.keys(local) as Array<keyof RuntimeFleetEntry>
  const runtimeFleet: Record<RuntimeId, Partial<RuntimeFleetEntry>> = {}
  for (const id of ids) {
    const entry: Record<string, unknown> = {}
    for (const field of fields) {
      const value = parts[id]?.[field]
      if (value !== undefined) entry[field] = value
      else if (field === 'fleetGroups' || field === 'fleetStewards') entry[field] = {}
    }
    if (Object.keys(entry).length === 0) continue
    runtimeFleet[id] = entry as Partial<RuntimeFleetEntry>
    storedRuntimeFleet = { ...storedRuntimeFleet, [id]: { ...(storedRuntimeFleet[id] ?? {}), ...entry } }
  }
  return Object.keys(runtimeFleet).length > 0 ? { ...local, runtimeFleet } : local
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
