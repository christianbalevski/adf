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
import type {
  ActivityEvent,
  AgentActivity,
  AgentExperienceInputs,
  AgentPowerInputs,
  AgentVitals,
  UpcomingWake
} from '../../shared/types/agent-vitals.types'
import { powerInputsFromConfig, scheduleIntervalMs, scoreAgent } from '../../shared/utils/agent-stats'
import { bucketByLocalDay, mergeRecent, windowStartMs } from '../../shared/utils/agent-activity'
import { localDateKey } from '../../shared/utils/date-key'

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
  /** Per-day cost from the per-agent usage ledger, keyed by local date; days without rows are absent. */
  getAgentDailyCost?(agentId: string, dates: string[]): Record<string, { usd: number; partial: boolean }>
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

interface FileRow {
  path: string
  updated_at: string
  size?: number
}

/**
 * ISO time after which a file write is the agent's own (adf_created_at plus
 * the creation grace). '' when the creation time is unknown: every file counts.
 */
export function agentWriteCutoff(createdAt: string | null | undefined): string {
  const createdMs = createdAt ? Date.parse(createdAt) : NaN
  return Number.isFinite(createdMs) ? new Date(createdMs + CREATION_GRACE_MS).toISOString() : ''
}

/**
 * Split adf_files rows into the agent's own writes and the skills it
 * installed or changed. ISO strings compare lexically (both sides come from
 * Date.toISOString). Registry entries without files (legacy loader catalogs)
 * count as skills too; starter skills stay excluded.
 */
export function classifyFiles<F extends FileRow>(files: F[], cutoff: string, registrySkills: string[] = []): { mine: F[]; agentSkills: Set<string> } {
  const mine: F[] = []
  const agentSkills = new Set<string>()
  const starterSkills = new Set<string>()
  for (const f of files) {
    if (DERIVED_FILES.has(f.path)) continue
    const own = !cutoff || f.updated_at > cutoff
    const skill = SKILL_FILE.exec(f.path)?.[1]
    if (own) {
      mine.push(f)
      if (skill) agentSkills.add(skill)
    } else if (skill) {
      starterSkills.add(skill)
    }
  }
  for (const name of registrySkills) if (!starterSkills.has(name)) agentSkills.add(name)
  return { mine, agentSkills }
}

/** Skill names in skills-registry.json (object or array form). */
function readRegistrySkills(q: Sql): string[] {
  return safe(
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
}

/** `local_*` table names (safe identifiers only). */
function listLocalTables(q: Sql): string[] {
  return safe(
    q,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'local\\_%' ESCAPE '\\' ORDER BY name",
    (rows) => (rows as Array<{ name: string }>).map((r) => r.name).filter((n) => /^local_[A-Za-z0-9_]+$/.test(n)),
    [] as string[]
  )
}

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
  const cutoff = agentWriteCutoff(meta.createdAt)

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
  // older timestamps, so starter files never count.
  const { mine, agentSkills } = classifyFiles(
    safe(q, 'SELECT path, updated_at FROM adf_files', (rows) => rows as FileRow[], []),
    cutoff,
    readRegistrySkills(q)
  )
  const filesWritten = mine.length

  const tables = listLocalTables(q)
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
// Activity: upcoming wakes, recent events, per-day turns, what it knows
// =============================================================================

/** config.id, the per-agent ledger's key. */
function readAgentId(q: Sql): string | null {
  return safe(q, "SELECT json_extract(config_json, '$.id') AS v FROM adf_config WHERE id = 1", (r) => {
    const v = (r[0] as { v?: unknown } | undefined)?.v
    return typeof v === 'string' && v ? v : null
  }, null)
}

/** Newest adf_loop rows scanned for recent events (rowid range, PK order). */
const RECENT_LOOP_ROWS = 200
/** adf_loop rows scanned at most for the per-day turn counts. */
export const DAILY_SCAN_CAP = 5_000
const RECENT_MESSAGES = 8
const RECENT_LOG_ERRORS = 5
const RECENT_FILES = 5
const MAX_SKILLS = 50
const MAX_TABLES = 50
const MAX_FILES = 20
const LABEL_MAX = 80

/** The part of AgentActivity read from the file (costs and identity come from the service). */
export type ActivityRead = Omit<AgentActivity, 'filePath' | 'computedAt' | 'live'>

function shortLabel(s: unknown, max = LABEL_MAX): string {
  const line = typeof s === 'string' ? s.trim().split(/\r?\n/, 1)[0] : ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** A DID is long; keep the method, the start and the tail. */
function shortParty(alias: unknown, address: unknown): string {
  if (typeof alias === 'string' && alias.trim()) return shortLabel(alias, 40)
  const a = typeof address === 'string' ? address : ''
  if (a.startsWith('did:') && a.length > 28) return `${a.slice(0, 16)}…${a.slice(-4)}`
  return shortLabel(a, 40) || 'unknown'
}

function scheduleLabel(raw: string): string {
  let s: TimerSchedule | null = null
  try { s = JSON.parse(raw) as TimerSchedule } catch { s = null }
  if (!s) return 'Timer'
  if (s.mode === 'cron') return shortLabel(`cron ${s.cron}`)
  if (s.mode === 'interval') {
    const min = Math.round(s.every_ms / 60_000)
    if (min < 1) return `Every ${Math.max(1, Math.round(s.every_ms / 1000))} s`
    if (min < 120) return `Every ${min} min`
    return `Every ${Math.round(min / 60)} h`
  }
  return 'One-time wake'
}

interface LoopBlockRow {
  seq: number
  role: string
  at: number
  loop: string | null
  type: string | null
  name: string | null
  id: string | null
  tuid: string | null
  err: number | null
}

/**
 * Events from the newest loop rows, newest first. One query: the content
 * blocks are unpacked by json_each in SQLite, so only names and flags cross
 * into JS, never tool inputs or results.
 */
function readLoopEvents(q: Sql): ActivityEvent[] {
  const sql = (loopCol: string): string => `
    SELECT l.seq AS seq, l.role AS role, l.created_at AS at, ${loopCol} AS loop,
      json_extract(j.value, '$.type') AS type, json_extract(j.value, '$.name') AS name,
      json_extract(j.value, '$.id') AS id, json_extract(j.value, '$.tool_use_id') AS tuid,
      json_extract(j.value, '$.is_error') AS err
    FROM (SELECT * FROM adf_loop ORDER BY seq DESC LIMIT ${RECENT_LOOP_ROWS}) l,
      json_each(CASE WHEN json_valid(l.content_json) AND json_type(l.content_json) = 'array' THEN l.content_json ELSE '[]' END) j
    WHERE j.type = 'object'
    ORDER BY l.seq ASC, j.key ASC`
  const rows = safe(q, sql('l.loop'), (r) => r as LoopBlockRow[], safe(q, sql("'main'"), (r) => r as LoopBlockRow[], []))

  // Oldest first so a result can name the call before it.
  const toolNames = new Map<string, string>()
  const bySeq = new Map<number, LoopBlockRow[]>()
  for (const r of rows) {
    if (r.type === 'tool_use' && r.id && r.name) toolNames.set(r.id, r.name)
    const list = bySeq.get(r.seq)
    if (list) list.push(r)
    else bySeq.set(r.seq, [r])
  }
  const out: ActivityEvent[] = []
  for (const [seq, blocks] of [...bySeq.entries()].reverse()) {
    const first = blocks[0]
    const at = typeof first.at === 'number' ? first.at : 0
    const loop = first.loop || 'main'
    if (first.role === 'assistant') {
      const calls = blocks.filter((b) => b.type === 'tool_use' && b.name)
      if (calls.length === 0) out.push({ kind: 'turn', at, label: loop, seq, loop })
      for (const c of calls.reverse()) out.push({ kind: 'tool', at, label: c.name as string, seq, loop })
    } else {
      for (const b of blocks.slice().reverse()) {
        if (b.type !== 'tool_result' || !b.err) continue
        const name = (b.tuid && toolNames.get(b.tuid)) || 'A tool call'
        out.push({ kind: 'error', at, label: `${name} failed`, seq, loop })
      }
    }
  }
  return out
}

/** State of the per-day turn scan for one file. */
export interface TurnScan {
  /** Highest adf_loop seq this scan has seen. */
  lastSeq: number
  /** Turn times inside the window. */
  times: number[]
  /** The cold scan stopped at DAILY_SCAN_CAP with rows older than it still inside the window. */
  capped: boolean
}

/**
 * Finished-turn times since `since`: assistant rows without a tool call.
 * `prior` (the last scan of this file) makes it incremental: only rows above
 * its high-water seq are read, so a running agent pays for its new rows, not
 * for 14 days of history on every change. Cold, or when more than
 * DAILY_SCAN_CAP rows arrived since, it reads the newest DAILY_SCAN_CAP
 * rowids. `role` precedes content_json in the row, so user rows are rejected
 * before their content is touched.
 */
function readTurnTimes(q: Sql, since: number, prior?: TurnScan): TurnScan {
  const maxSeq = safe(q, 'SELECT MAX(seq) AS n FROM adf_loop', (r) => firstNumber(r), 0)
  const floor = Math.max(0, maxSeq - DAILY_SCAN_CAP)
  const base = prior && prior.lastSeq >= floor && prior.lastSeq <= maxSeq ? prior : null
  const from = base ? base.lastSeq : floor
  const fresh = safe(
    q,
    `SELECT created_at AS t FROM adf_loop WHERE seq > ? AND role = 'assistant' AND created_at >= ? AND instr(content_json, '"type":"tool_use"') = 0`,
    (r) => (r as Array<{ t: number }>).map((x) => x.t),
    [] as number[],
    [from, since]
  )
  if (base) return { lastSeq: maxSeq, times: [...base.times.filter((t) => t >= since), ...fresh], capped: base.capped }
  const firstAt = (where: string, params: unknown[]): number | null =>
    safe(q, `SELECT created_at AS t FROM adf_loop ${where} ORDER BY seq LIMIT 1`, (r) => {
      const t = (r[0] as { t?: number } | undefined)?.t
      return typeof t === 'number' ? t : null
    }, null, params)
  // Capped: rows below the floor exist and the first scanned row is inside the window.
  let capped = false
  if (floor > 0) {
    const firstScanned = firstAt('WHERE seq > ?', [floor])
    capped = firstScanned !== null && firstScanned > since && firstAt('WHERE seq <= ?', [floor]) !== null
  }
  return { lastSeq: maxSeq, times: fresh, capped }
}

/**
 * Everything the overview's lower sections read from the file. Every query is
 * bounded: timers and messages by LIMIT on an indexed column, loop events by
 * the newest RECENT_LOOP_ROWS rowids, the per-day count by DAILY_SCAN_CAP
 * rowids, local tables and skills by MAX_*. adf_files is read path +
 * timestamps only (as the vitals read does).
 */
export function readAgentActivity(q: Sql, now: number, prior?: TurnScan): ActivityRead & { turnScan: TurnScan } {
  const createdAt = safe(
    q,
    "SELECT COALESCE((SELECT value FROM adf_meta WHERE key = 'adf_created_at'), (SELECT json_extract(config_json, '$.metadata.created_at') FROM adf_config WHERE id = 1)) AS v",
    (r) => (r[0] as { v?: string | null } | undefined)?.v ?? null,
    null as string | null
  )
  const cutoff = agentWriteCutoff(createdAt)

  // Coming up: next three wakes (idx_adf_timers_wake).
  type TimerRow = { id: number; next_wake_at: number; scope: string | null; payload: string | null; lambda: string | null; schedule_json: string }
  const timerCols = 'id, next_wake_at, scope, payload, lambda, schedule_json'
  const timers = safe(
    q,
    `SELECT ${timerCols} FROM adf_timers WHERE expired = 0 ORDER BY next_wake_at LIMIT 3`,
    (r) => r as TimerRow[],
    safe(q, `SELECT ${timerCols} FROM adf_timers ORDER BY next_wake_at LIMIT 3`, (r) => r as TimerRow[], [])
  )
  const upcoming: UpcomingWake[] = timers.map((t) => {
    let scope: UpcomingWake['scope'] = 'system'
    try {
      const parsed = JSON.parse(t.scope ?? '[]') as unknown
      if (Array.isArray(parsed) && parsed[0] === 'agent') scope = 'agent'
    } catch { /* default */ }
    return { id: t.id, at: t.next_wake_at, scope, label: shortLabel(t.payload) || shortLabel(t.lambda) || scheduleLabel(t.schedule_json) }
  })

  // Files: one path/timestamp scan, shared by recent events and knowledge.
  const { mine, agentSkills } = classifyFiles(
    safe(q, 'SELECT path, updated_at, size FROM adf_files', (rows) => rows as FileRow[], []),
    cutoff,
    readRegistrySkills(q)
  )
  mine.sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0))

  // Recent events from every source, merged newest first.
  const fileEvents: ActivityEvent[] = mine.slice(0, RECENT_FILES).map((f) => ({ kind: 'file', at: Date.parse(f.updated_at) || 0, label: f.path }))
  const inbox = safe(
    q,
    `SELECT "from" AS addr, sender_alias AS alias, received_at AS at FROM adf_inbox ORDER BY received_at DESC LIMIT ${RECENT_MESSAGES}`,
    (r) => (r as Array<{ addr: string; alias: string | null; at: number }>).map((m): ActivityEvent => ({ kind: 'message_in', at: m.at, label: shortParty(m.alias, m.addr) })),
    []
  )
  const outbox = safe(
    q,
    `SELECT "to" AS addr, recipient_alias AS alias, created_at AS at FROM adf_outbox ORDER BY created_at DESC LIMIT ${RECENT_MESSAGES}`,
    (r) => (r as Array<{ addr: string; alias: string | null; at: number }>).map((m): ActivityEvent => ({ kind: 'message_out', at: m.at, label: shortParty(m.alias, m.addr) })),
    []
  )
  // idx_adf_logs_level; rowid order inside the index entry.
  const logErrors = safe(
    q,
    `SELECT message, created_at AS at FROM adf_logs WHERE level = 'error' ORDER BY id DESC LIMIT ${RECENT_LOG_ERRORS}`,
    (r) => (r as Array<{ message: string; at: number }>).map((m): ActivityEvent => ({ kind: 'error', at: m.at, label: shortLabel(m.message) || 'Error' })),
    []
  )
  const recent = mergeRecent([readLoopEvents(q), fileEvents, inbox, outbox, logErrors])

  const since = windowStartMs(now)
  const turns = readTurnTimes(q, since, prior)
  // Compacted: a loop snapshot was archived inside the window, so older rows of it are gone.
  const compacted = safe(q, "SELECT 1 AS n FROM adf_audit WHERE source = 'loop' AND created_at >= ? LIMIT 1", (r) => r.length > 0, false, [since])
  const daily = bucketByLocalDay(turns.times, now).map(({ date, count }) => ({ date, turns: count }))

  // What it knows.
  const tableNames = listLocalTables(q).slice(0, MAX_TABLES)
  const tables = tableNames.map((name) => ({ name, rows: safe(q, `SELECT COUNT(*) AS n FROM "${name}"`, (r) => firstNumber(r), 0) }))

  return {
    upcoming,
    recent,
    daily,
    dailyPartial: turns.capped || compacted,
    knowledge: {
      skills: [...agentSkills].sort((a, b) => a.localeCompare(b)).slice(0, MAX_SKILLS),
      tables,
      files: mine.slice(0, MAX_FILES).map((f) => ({ path: f.path, updatedAt: f.updated_at, size: typeof f.size === 'number' ? f.size : 0 })),
      filesTotal: mine.length
    },
    turnScan: turns
  }
}

// =============================================================================
// Service
// =============================================================================

interface CacheEntry<T> {
  key: string
  at: number
  value: T
}

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

  private slowCache = new Map<string, CacheEntry<VitalsSlowPart>>()
  private activityCache = new Map<string, CacheEntry<ActivityRead & { agentId: string | null }>>()
  /** Last per-day turn scan per file; makes the next one incremental. */
  private turnScans = new Map<string, TurnScan>()
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
    if (filePath) {
      this.slowCache.delete(filePath)
      this.activityCache.delete(filePath)
      this.turnScans.delete(filePath)
    } else {
      this.slowCache.clear()
      this.activityCache.clear()
      this.turnScans.clear()
    }
  }

  /**
   * One cached read. Live agents: keyed by the connection's total_changes()
   * (any write — a finished turn, a config change — bumps it) and recomputed
   * at most every LIVE_MIN_INTERVAL_MS. Files nobody has open: keyed by the
   * file's and its WAL's mtime/size, read with one readonly peek. `salt`
   * joins the key (the activity read's local day, so it rolls at midnight).
   */
  private async cachedRead<T>(
    cache: Map<string, CacheEntry<T>>,
    filePath: string,
    force: boolean,
    read: (q: Sql) => T,
    salt = ''
  ): Promise<{ value: T; live: boolean; at: number }> {
    // Let other IPC work run before the synchronous reads.
    await new Promise<void>((resolve) => setImmediate(resolve))
    const ws = this.findOpenWorkspace(filePath)
    const cached = cache.get(filePath)
    const now = this.now()
    let key: string
    if (ws) {
      if (!force && cached?.key.startsWith('live:') && cached.key.endsWith(`|${salt}`) && now - cached.at < LIVE_MIN_INTERVAL_MS) {
        return { value: cached.value, live: true, at: cached.at }
      }
      const changes = safe(ws.querySQL.bind(ws), 'SELECT total_changes() AS n', (r) => firstNumber(r), -1)
      key = `live:${this.workspaceId(ws)}:${changes}|${salt}`
    } else {
      const [main, wal] = await Promise.all([
        fsp.stat(filePath),
        fsp.stat(`${filePath}-wal`).catch(() => null)
      ])
      key = `file:${main.mtimeMs}:${main.size}:${wal?.mtimeMs ?? 0}:${wal?.size ?? 0}|${salt}`
    }
    if (!force && cached && cached.key === key) {
      if (ws) cached.at = now
      return { value: cached.value, live: !!ws, at: cached.at }
    }

    // The read is synchronous, so no second caller can arrive mid-read and
    // there is nothing to dedupe. (An in-flight map here once stuck: the async
    // wrapper's `finally` ran before the entry was set, so every later
    // cache miss and every `force` got the first read back forever.)
    try {
      const value = ws
        ? read((sql, params) => ws.querySQL(sql, params))
        : AdfDatabase.peek(filePath, (db) => read((sql, params) => db.prepare(sql).all(...(params ?? []))))
      const at = this.now()
      cache.set(filePath, { key, at, value })
      return { value, live: !!ws, at }
    } catch (err) {
      // Transient lock on a peek: serve the last good read.
      if (cached) return { value: cached.value, live: !!ws, at: cached.at }
      throw err
    }
  }

  private async getSlowPart(filePath: string, force: boolean): Promise<{ slow: VitalsSlowPart; live: boolean }> {
    const { value, live } = await this.cachedRead(this.slowCache, filePath, force, readVitalsSlowPart)
    return { slow: value, live }
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

  /**
   * The overview's lower sections: next wakes, recent events, 14 days of
   * finished turns with the ledger's cost per day, and what the agent keeps
   * (skills, local tables, files it wrote). Cached like the vitals slow part;
   * the per-day cost is read from the in-memory ledger on every call.
   */
  async getAgentActivity(filePath: string, opts?: { force?: boolean }): Promise<AgentActivity> {
    const now = this.now()
    const { value, live, at } = await this.cachedRead(
      this.activityCache,
      filePath,
      !!opts?.force,
      (q) => {
        const { turnScan, ...read } = readAgentActivity(q, this.now(), this.turnScans.get(filePath))
        this.turnScans.set(filePath, turnScan)
        return { ...read, agentId: readAgentId(q) }
      },
      localDateKey(new Date(now))
    )
    const { agentId, ...read } = value
    const costs = agentId && this.deps.getAgentDailyCost ? this.deps.getAgentDailyCost(agentId, read.daily.map((d) => d.date)) : {}
    return {
      filePath,
      computedAt: at,
      live,
      ...read,
      daily: read.daily.map((d) => {
        const c = costs[d.date]
        return c ? { ...d, costUsd: c.usd, ...(c.partial ? { costPartial: true } : {}) } : d
      })
    }
  }
}
