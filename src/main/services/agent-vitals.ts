/**
 * Agent vitals: the fleet map's per-agent status rows and the overview
 * card's slower per-agent read (stat inputs and maturity counts).
 *
 * Both paths share one rule: a running agent is read out of the workspace it
 * already has open, never reopened. A file nobody has open is read through a
 * short readonly peek and cached by mtime, so the 5s fleet poll and repeated
 * card opens cost a stat() call, not a database open.
 *
 * Everything that touches IPC state (mesh manager, executors, settings) comes
 * in through AgentVitalsDeps so the module is testable without Electron.
 */

import { promises as fsp, statSync } from 'fs'
import { AdfDatabase } from '../adf/adf-database'
import type { AdfWorkspace } from '../adf/adf-workspace'
import { canonicalizePath, containsPath } from '../utils/tracked-paths'
import { deriveHandle } from '../utils/handle'
import type { AgentConfig, TimerSchedule } from '../../shared/types/adf-v02.types'
import type { AgentState, FleetAgentStatus, FleetStatusResult, MeshAgentStatus } from '../../shared/types/ipc.types'
import type { AgentExperienceInputs, AgentPowerInputs, AgentVitals } from '../../shared/types/agent-vitals.types'
import { powerInputsFromConfig, scheduleIntervalMs, scoreAgent } from '../../shared/utils/agent-stats'

/** Display/identity metadata the fleet map needs per agent. */
export type FleetMeta = NonNullable<ReturnType<typeof AdfDatabase.peekFleetMeta>>

/** The slice of AdfWorkspace this module reads. */
export type VitalsWorkspace = Pick<AdfWorkspace, 'getAgentConfig' | 'getMeta' | 'querySQL'>

export interface AgentVitalsDeps {
  isMeshRunning(): boolean
  /** Mesh-registered agents with their executor state overlaid. */
  getLiveMeshAgents(): MeshAgentStatus[]
  getTrackedDirectories(): string[]
  getMaxScanDepth(): number
  listAdfFiles(dir: string, maxDepth: number): Promise<string[]>
  /** Live executor's context gauge, undefined when the agent is not running. */
  getContextGauge(filePath: string): { tokens: number; threshold: number } | undefined
  /** Open WS connections; undefined when there is no connection manager. */
  getWsConnectionCount(filePath: string): number | undefined
  /** Running executors' display states. Later entries win (foreground last). */
  getLiveExecStates(): Array<{ filePath: string; state: AgentState }>
  /** Workspaces already open in this process. Later entries win (foreground last). */
  getOpenWorkspaces(): Array<{ filePath: string; workspace: VitalsWorkspace }>
  /** 7-day cost from the per-agent usage ledger. */
  getAgentCost?(agentId: string): { usd: number; partial: boolean } | null
  now?(): number
}

/**
 * Mesh rows with running executors' display states laid over them.
 * MeshManager.getAgentStatuses() has no executor access and reports 'idle'
 * for everyone. Later `live` entries win the state; `activeLoops` keeps the
 * last defined count. Studio and the daemon both build getLiveMeshAgents
 * with this.
 */
export function overlayLiveStates(
  meshAgents: MeshAgentStatus[],
  live: Array<{ filePath: string; state: AgentState; activeLoops?: number }>
): MeshAgentStatus[] {
  const byPath = new Map<string, { state: AgentState; activeLoops?: number }>()
  for (const l of live) {
    byPath.set(l.filePath, { state: l.state, activeLoops: l.activeLoops ?? byPath.get(l.filePath)?.activeLoops })
  }
  return meshAgents.map((a) => {
    const l = byPath.get(a.filePath)
    if (!l) return a
    return l.activeLoops === undefined ? { ...a, state: l.state } : { ...a, state: l.state, activeLoops: l.activeLoops }
  })
}

// =============================================================================
// Fleet metadata
// =============================================================================

function parseDidHistory(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((d) => typeof d === 'string' && d) : []
  } catch {
    return []
  }
}

/**
 * Fleet metadata read straight out of an agent's OPEN workspace. A running
 * agent rewrites its own file constantly, so the mtime cache never hits for
 * one and every poll paid for a fresh readonly open (two opens plus a
 * TRUNCATE checkpoint) of a database already held in memory.
 */
export function liveFleetMeta(workspace: Pick<VitalsWorkspace, 'getAgentConfig' | 'getMeta'>): FleetMeta | null {
  try {
    const config = workspace.getAgentConfig()
    return {
      handle: workspace.getMeta('adf_handle') || config?.handle || null,
      name: workspace.getMeta('adf_name') || config?.name || null,
      icon: config?.icon ?? null,
      model: config?.model?.model_id || null,
      status: workspace.getMeta('status') ?? null,
      did: workspace.getMeta('adf_did') || null,
      didHistory: parseDidHistory(workspace.getMeta('adf_did_history')),
      agentId: config?.id ?? null,
      parentDid: workspace.getMeta('adf_parent_did') || null,
      createdAt: workspace.getMeta('adf_created_at') || config?.metadata?.created_at || null
    }
  } catch {
    return null
  }
}

// =============================================================================
// Slow part: stat inputs + maturity counts
// =============================================================================

type Sql = (sql: string, params?: unknown[]) => unknown[]

/** One query; a missing table/column on an old file reads as `fallback`. */
function safe<T>(q: Sql, sql: string, map: (rows: unknown[]) => T, fallback: T, params?: unknown[]): T {
  try {
    return map(q(sql, params))
  } catch {
    return fallback
  }
}

const firstNumber = (rows: unknown[], col = 'n'): number => {
  const v = (rows[0] as Record<string, unknown> | undefined)?.[col]
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/** Runtime-derived files that are rewritten on open; never the agent's work. */
const DERIVED_FILES = new Set(['skills-registry.json'])
const SKILL_FILE = /^skills\/([^/]+)\//
/** Writes this soon after adf_created_at are the creation itself (seed files). */
const CREATION_GRACE_MS = 10_000

export interface VitalsSlowPart {
  meta: FleetMeta
  power: AgentPowerInputs
  maturity: Omit<AgentExperienceInputs, 'agentsSpawned' | 'ageDays'>
  nextWakeAt?: number
}

/**
 * Every read the card needs, against one connection. Aggregates only (MAX,
 * COUNT, column lists without blobs except the skills registry), so a live
 * agent's connection is held for a few milliseconds.
 */
export function readVitalsSlowPart(q: Sql): VitalsSlowPart {
  const config = safe<Partial<AgentConfig>>(
    q,
    'SELECT config_json FROM adf_config WHERE id = 1',
    (rows) => {
      const raw = (rows[0] as { config_json?: string } | undefined)?.config_json
      return raw ? (JSON.parse(raw) as AgentConfig) : {}
    },
    {}
  )
  const metaMap = safe(
    q,
    "SELECT key, value FROM adf_meta WHERE key IN ('adf_handle','adf_name','status','adf_did','adf_did_history','adf_parent_did','adf_created_at')",
    (rows) => new Map((rows as Array<{ key: string; value: string }>).map((r) => [r.key, r.value])),
    new Map<string, string>()
  )
  const getMeta = (k: string): string | null => metaMap.get(k) ?? null
  const meta: FleetMeta = {
    handle: getMeta('adf_handle') || config.handle || null,
    name: getMeta('adf_name') || config.name || null,
    icon: config.icon ?? null,
    model: config.model?.model_id || null,
    status: getMeta('status'),
    did: getMeta('adf_did') || null,
    didHistory: parseDidHistory(getMeta('adf_did_history')),
    agentId: config.id ?? null,
    parentDid: getMeta('adf_parent_did') || null,
    createdAt: getMeta('adf_created_at') || config.metadata?.created_at || null
  }
  // Files seeded at creation land a few ms after adf_created_at; anything the
  // agent writes comes much later (a turn takes seconds).
  const createdMs = meta.createdAt ? Date.parse(meta.createdAt) : NaN
  const cutoff = Number.isFinite(createdMs) ? new Date(createdMs + CREATION_GRACE_MS).toISOString() : ''

  // Identity: purposes and sealing only, never values.
  const identity = safe(
    q,
    'SELECT purpose, encryption_algo FROM adf_identity',
    (rows) => rows as Array<{ purpose: string; encryption_algo: string | null }>,
    []
  )
  const credentials = { plain: 0, sealed: 0 }
  let privateKey: AgentPowerInputs['privateKey'] = 'none'
  for (const r of identity) {
    const sealed = !!r.encryption_algo && r.encryption_algo !== 'plain'
    if (r.purpose === 'crypto:signing:private_key') privateKey = sealed ? 'sealed' : 'plain'
    else if (r.purpose.startsWith('crypto:')) continue
    else if (sealed) credentials.sealed++
    else credentials.plain++
  }

  // Timers: non-expired rows. `expired` arrived in a later schema; fall back.
  const timerRows = safe(
    q,
    'SELECT schedule_json, next_wake_at FROM adf_timers WHERE expired = 0',
    (rows) => rows as Array<{ schedule_json: string; next_wake_at: number }>,
    safe(q, 'SELECT schedule_json, next_wake_at FROM adf_timers', (rows) => rows as Array<{ schedule_json: string; next_wake_at: number }>, [])
  )
  let fastestIntervalMs: number | undefined
  let nextWakeAt: number | undefined
  for (const t of timerRows) {
    if (typeof t.next_wake_at === 'number' && (nextWakeAt === undefined || t.next_wake_at < nextWakeAt)) nextWakeAt = t.next_wake_at
    let schedule: TimerSchedule | null = null
    try { schedule = JSON.parse(t.schedule_json) as TimerSchedule } catch { schedule = null }
    const every = scheduleIntervalMs(schedule)
    if (every !== undefined && (fastestIntervalMs === undefined || every < fastestIntervalMs)) fastestIntervalMs = every
  }

  // Loop history: the AUTOINCREMENT high-water mark survives compaction and
  // clears; MAX(seq) covers files whose sqlite_sequence row is missing.
  const loopEntries = Math.max(
    safe(q, "SELECT seq AS n FROM sqlite_sequence WHERE name = 'adf_loop'", (r) => firstNumber(r), 0),
    safe(q, 'SELECT MAX(seq) AS n FROM adf_loop', (r) => firstNumber(r), 0)
  )

  // Files changed after creation. Template instances carry their template's
  // older timestamps, so starter files never count. ISO strings compare
  // lexically (both sides come from Date.toISOString).
  const files = safe(
    q,
    'SELECT path, updated_at FROM adf_files',
    (rows) => rows as Array<{ path: string; updated_at: string }>,
    []
  )
  let filesWritten = 0
  const agentSkills = new Set<string>()
  const starterSkills = new Set<string>()
  for (const f of files) {
    if (DERIVED_FILES.has(f.path)) continue
    const mine = !cutoff || f.updated_at > cutoff
    const skill = SKILL_FILE.exec(f.path)?.[1]
    if (mine) {
      filesWritten++
      if (skill) agentSkills.add(skill)
    } else if (skill) {
      starterSkills.add(skill)
    }
  }
  // Registry entries without files (legacy loader catalogs) count too;
  // starter skills stay excluded. Deduped by name.
  const registry = safe(
    q,
    "SELECT content FROM adf_files WHERE path = 'skills-registry.json'",
    (rows) => {
      const c = (rows[0] as { content?: Buffer | string } | undefined)?.content
      if (!c) return [] as string[]
      const parsed = JSON.parse(Buffer.isBuffer(c) ? c.toString('utf-8') : String(c)) as { skills?: Record<string, unknown> | Array<{ name?: string }> }
      const skills = parsed.skills
      if (Array.isArray(skills)) return skills.map((s) => s?.name).filter((n): n is string => typeof n === 'string')
      return skills && typeof skills === 'object' ? Object.keys(skills) : []
    },
    [] as string[]
  )
  for (const name of registry) if (!starterSkills.has(name)) agentSkills.add(name)

  const tables = safe(
    q,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'local\\_%' ESCAPE '\\'",
    (rows) => (rows as Array<{ name: string }>).map((r) => r.name).filter((n) => /^local_[A-Za-z0-9_]+$/.test(n)),
    [] as string[]
  )
  let localRows = 0
  for (const t of tables) localRows += safe(q, `SELECT COUNT(*) AS n FROM "${t}"`, (r) => firstNumber(r), 0)

  // Compactions: each one archives the rows it replaced into adf_audit
  // (source 'loop', on by default; clears land there too). With loop audit
  // off nothing is kept, so the live summary row is the only trace.
  const audited = safe(q, "SELECT COUNT(*) AS n FROM adf_audit WHERE source = 'loop'", (r) => firstNumber(r), 0)
  const liveSummaries = safe(
    q,
    "SELECT COUNT(*) AS n FROM adf_loop WHERE role = 'user' AND content_json LIKE '%[Loop Compacted%'",
    (r) => firstNumber(r),
    0
  )

  return {
    meta,
    power: powerInputsFromConfig(config, {
      credentials,
      privateKey,
      timers: { active: timerRows.length, fastestIntervalMs }
    }),
    maturity: {
      loopEntries,
      filesWritten,
      localTables: tables.length,
      localRows,
      skills: agentSkills.size,
      compactions: Math.max(audited, liveSummaries)
    },
    nextWakeAt
  }
}

// =============================================================================
// Service
// =============================================================================

/** A live agent's slow part is recomputed at most this often. */
const LIVE_MIN_INTERVAL_MS = 2_000

export class AgentVitalsService {
  // Ghost metadata cache, keyed by file path. Two jobs:
  // 1. Perf — the 5s fleet poll would otherwise open every offline agent's
  //    SQLite each cycle; unchanged mtime serves from memory.
  // 2. Stability — a peek can fail transiently (SQLITE_BUSY while an agent
  //    is mass-starting and writing its own file). Serving the last good
  //    meta instead of dropping the entry stops agents blinking off the map.
  private fleetMetaCache = new Map<string, { mtimeMs: number; meta: FleetMeta }>()
  // First-observed time of each agent's current status line (for status age)
  private statusSinceMap = new Map<string, { value: string; since: number }>()
  /** Last fleet result, for the spawned-children count. */
  private lastFleet: FleetAgentStatus[] | null = null

  private slowCache = new Map<string, { key: string; at: number; slow: VitalsSlowPart }>()
  private workspaceIds = new WeakMap<object, number>()
  private nextWorkspaceId = 1

  constructor(private deps: AgentVitalsDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  peekFleetMetaCached(filePath: string): FleetMeta | null {
    let mtimeMs: number
    try {
      mtimeMs = statSync(filePath).mtimeMs
    } catch {
      this.fleetMetaCache.delete(filePath) // file gone — genuine removal
      return null
    }
    const cached = this.fleetMetaCache.get(filePath)
    if (cached && cached.mtimeMs === mtimeMs) return cached.meta
    const meta = AdfDatabase.peekFleetMeta(filePath)
    if (meta) {
      this.fleetMetaCache.set(filePath, { mtimeMs, meta })
      return meta
    }
    // Peek failed (likely transient lock) — serve stale rather than blink
    return cached?.meta ?? null
  }

  // Fleet map: live mesh agents plus on-disk .adf files in tracked
  // directories that have no running executor ("ghost" nodes). Works even
  // with the mesh disabled — every on-disk agent is then a ghost.
  async getFleetStatus(): Promise<FleetStatusResult> {
    const deps = this.deps
    const running = deps.isMeshRunning()

    const agents: FleetAgentStatus[] = deps.getLiveMeshAgents().map((a) => {
      const ctx = deps.getContextGauge(a.filePath)
      return {
        ...a,
        online: true,
        contextTokens: ctx && ctx.tokens > 0 ? ctx.tokens : undefined,
        contextThreshold: ctx && ctx.tokens > 0 ? ctx.threshold : undefined,
        // Standing boundary links — open WS pipes render as dashed channel
        // edges to the perimeter, distinct from request traffic
        wsConnections: deps.getWsConnectionCount(a.filePath)
      }
    })

    const trackedDirs = deps.getTrackedDirectories()
    const maxDepth = deps.getMaxScanDepth()
    const seen = new Set(agents.map((a) => canonicalizePath(a.filePath)))

    // Longest-prefix tracked-dir match, mirroring MeshManager.findTrackedDirRoot.
    const findGhostTrackedDirRoot = (filePath: string): string | undefined => {
      const canonFile = canonicalizePath(filePath)
      let longestMatch: string | undefined
      let longestLen = -1
      for (const dir of trackedDirs) {
        const canonDir = canonicalizePath(dir)
        if (containsPath(canonDir, canonFile) && canonDir.length > longestLen) {
          longestMatch = dir
          longestLen = canonDir.length
        }
      }
      return longestMatch
    }

    // Live executors independent of mesh registration — with the mesh
    // disabled, getLiveMeshAgents() is empty, so a foreground chat-started
    // agent (or a background executor) would otherwise be reported as an
    // offline ghost on every poll, stomping the event-driven state the
    // renderer just applied. Overlay their real display state so the poll
    // stays truthful; a genuinely stopped executor leaves these maps and
    // the ghost settles back to 'off' within one poll cycle.
    //
    // The open workspaces come along for the ride: a live agent's metadata is
    // read out of the database it already has open, so the poll never reopens a
    // file whose mtime is changing under it anyway.
    const liveExecStates = new Map<string, AgentState>()
    for (const s of deps.getLiveExecStates()) liveExecStates.set(canonicalizePath(s.filePath), s.state)
    const liveWorkspaces = new Map<string, VitalsWorkspace>()
    for (const w of deps.getOpenWorkspaces()) liveWorkspaces.set(canonicalizePath(w.filePath), w.workspace)

    for (const dir of trackedDirs) {
      const filePaths = await deps.listAdfFiles(dir, maxDepth)
      for (const filePath of filePaths) {
        const canon = canonicalizePath(filePath)
        if (seen.has(canon)) continue
        seen.add(canon)
        const openWorkspace = liveWorkspaces.get(canon)
        const meta = (openWorkspace ? liveFleetMeta(openWorkspace) : null) ?? this.peekFleetMetaCached(filePath)
        if (!meta) continue
        const live = liveExecStates.get(canon)
        const isLive = live !== undefined && live !== 'off'
        const ctx = isLive ? deps.getContextGauge(filePath) : undefined
        agents.push({
          filePath,
          handle: meta.handle || deriveHandle(filePath),
          did: meta.did ?? undefined,
          agentId: meta.agentId ?? undefined,
          parentDid: meta.parentDid ?? undefined,
          didHistory: meta.didHistory.length > 0 ? meta.didHistory : undefined,
          icon: meta.icon ?? undefined,
          state: isLive ? live : 'off',
          status: meta.status ?? undefined,
          model: meta.model ?? undefined,
          trackedDirRoot: findGhostTrackedDirRoot(filePath),
          createdAt: meta.createdAt ?? undefined,
          participating: false,
          online: isLive,
          contextTokens: ctx && ctx.tokens > 0 ? ctx.tokens : undefined,
          contextThreshold: ctx && ctx.tokens > 0 ? ctx.threshold : undefined
        })
      }
    }

    // Status age — when the current status line was first observed. adf_meta
    // has no timestamps, so this is poll-observation memory: good enough for
    // the "now / 4m / 1h" chip, resets on app restart.
    const now = this.now()
    for (const a of agents) {
      if (!a.status) {
        this.statusSinceMap.delete(a.filePath)
        continue
      }
      const prev = this.statusSinceMap.get(a.filePath)
      if (!prev || prev.value !== a.status) {
        this.statusSinceMap.set(a.filePath, { value: a.status, since: now })
      }
      a.statusSince = this.statusSinceMap.get(a.filePath)!.since
    }

    this.lastFleet = agents
    return { running, agents }
  }

  private findOpenWorkspace(filePath: string): VitalsWorkspace | undefined {
    const canon = canonicalizePath(filePath)
    let found: VitalsWorkspace | undefined
    for (const w of this.deps.getOpenWorkspaces()) {
      if (canonicalizePath(w.filePath) === canon) found = w.workspace
    }
    return found
  }

  private workspaceId(ws: VitalsWorkspace): number {
    let id = this.workspaceIds.get(ws)
    if (id === undefined) {
      id = this.nextWorkspaceId++
      this.workspaceIds.set(ws, id)
    }
    return id
  }

  /** Drop the cached slow part (e.g. after a config change made elsewhere). */
  invalidate(filePath?: string): void {
    if (filePath) this.slowCache.delete(filePath)
    else this.slowCache.clear()
  }

  /**
   * Slow part, cached. Live agents: keyed by the connection's total_changes()
   * (any write — a finished turn, a config change — bumps it) and recomputed
   * at most every LIVE_MIN_INTERVAL_MS. Files nobody has open: keyed by the
   * file's and its WAL's mtime/size, read with one readonly peek.
   */
  private async getSlowPart(filePath: string, force: boolean): Promise<{ slow: VitalsSlowPart; live: boolean }> {
    // Let other IPC work run before the synchronous reads.
    await new Promise<void>((resolve) => setImmediate(resolve))
    const ws = this.findOpenWorkspace(filePath)
    const cached = this.slowCache.get(filePath)
    const now = this.now()
    let key: string
    if (ws) {
      if (!force && cached?.key.startsWith('live:') && now - cached.at < LIVE_MIN_INTERVAL_MS) {
        return { slow: cached.slow, live: true }
      }
      const changes = safe(ws.querySQL.bind(ws), 'SELECT total_changes() AS n', (r) => firstNumber(r), -1)
      key = `live:${this.workspaceId(ws)}:${changes}`
    } else {
      const [main, wal] = await Promise.all([
        fsp.stat(filePath),
        fsp.stat(`${filePath}-wal`).catch(() => null)
      ])
      key = `file:${main.mtimeMs}:${main.size}:${wal?.mtimeMs ?? 0}:${wal?.size ?? 0}`
    }
    if (!force && cached && cached.key === key) {
      if (ws) cached.at = now
      return { slow: cached.slow, live: !!ws }
    }

    // The read is synchronous, so no second caller can arrive mid-read and
    // there is nothing to dedupe. (An in-flight map here once stuck: the async
    // wrapper's `finally` ran before the entry was set, so every later
    // cache miss and every `force` got the first read back forever.)
    try {
      const slow = ws
        ? readVitalsSlowPart((sql, params) => ws.querySQL(sql, params))
        : AdfDatabase.peek(filePath, (db) => readVitalsSlowPart((sql, params) => db.prepare(sql).all(...(params ?? []))))
      this.slowCache.set(filePath, { key, at: this.now(), slow })
      return { slow, live: !!ws }
    } catch (err) {
      // Transient lock on a peek: serve the last good read.
      if (cached) return { slow: cached.slow, live: !!ws }
      throw err
    }
  }

  /** Children in the last fleet scan whose parent reference names this agent. */
  private countSpawned(meta: FleetMeta): number | null {
    if (!this.lastFleet) return null
    const ids = new Set<string>([...(meta.did ? [meta.did] : []), ...meta.didHistory, ...(meta.agentId ? [meta.agentId] : [])])
    if (ids.size === 0) return 0
    return this.lastFleet.filter((a) => a.parentDid && ids.has(a.parentDid)).length
  }

  async getAgentVitals(filePath: string, opts?: { force?: boolean }): Promise<AgentVitals> {
    const { slow, live } = await this.getSlowPart(filePath, !!opts?.force)
    const now = this.now()
    const createdMs = slow.meta.createdAt ? Date.parse(slow.meta.createdAt) : NaN
    const ageDays = Number.isFinite(createdMs) ? Math.max(0, (now - createdMs) / 86_400_000) : 0
    const maturity: AgentExperienceInputs = {
      ...slow.maturity,
      agentsSpawned: this.countSpawned(slow.meta),
      ageDays
    }
    const ctx = live ? this.deps.getContextGauge(filePath) : undefined
    const cost = slow.meta.agentId && this.deps.getAgentCost ? this.deps.getAgentCost(slow.meta.agentId) : null
    const cachedAt = this.slowCache.get(filePath)?.at ?? now
    return {
      filePath,
      computedAt: cachedAt,
      live,
      handle: slow.meta.handle || deriveHandle(filePath),
      name: slow.meta.name ?? undefined,
      did: slow.meta.did ?? undefined,
      agentId: slow.meta.agentId ?? undefined,
      model: slow.meta.model ?? undefined,
      createdAt: slow.meta.createdAt ?? undefined,
      ageDays,
      contextTokens: ctx && ctx.tokens > 0 ? ctx.tokens : undefined,
      contextThreshold: ctx && ctx.tokens > 0 ? ctx.threshold : undefined,
      nextWakeAt: slow.nextWakeAt,
      cost7dUsd: cost ? cost.usd : undefined,
      cost7dPartial: cost ? cost.partial : undefined,
      stats: scoreAgent(slow.power, maturity),
      maturity
    }
  }
}
