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
import { DEFAULT_MIND_LOG_CONTENT, type AgentConfig, type AlfAttestation, type TimerSchedule } from '../../shared/types/adf-v02.types'
import type { AgentState, FleetAgentStatus, FleetStatusResult, MeshAgentStatus } from '../../shared/types/ipc.types'
import type {
  AgentActivity,
  AgentContents,
  AgentExperienceInputs,
  AgentMetric,
  AgentPowerInputs,
  AgentVitals,
  MemoryFileSize,
  MemoryStrata,
  TableSize,
  UpcomingWake
} from '../../shared/types/agent-vitals.types'
import { MEMORY_STRATA_DAYS, UPCOMING_TEXT_MAX } from '../../shared/types/agent-vitals.types'
import { powerInputsFromConfig, scheduleIntervalMs, scoreAgent } from '../../shared/utils/agent-stats'
import { windowStartMs } from '../../shared/utils/agent-activity'
import { readDailyActivity, recentCost, scanLoopRows, startLoopDayScan, maxLoopSeq, type LoopDayScan } from './agent-daily'
import { parseMetric } from '../../shared/utils/agent-metrics'
import { localDateKey } from '../../shared/utils/date-key'
import { resolveLoopThreshold } from '../../shared/utils/context-breakdown'
import { verifyAttestation } from './attestation.service'

const MIND_LOG_SEED_BYTES = Buffer.byteLength(DEFAULT_MIND_LOG_CONTENT)

/**
 * Bytes of a `mind/` file that count as the agent's memory: its size, less
 * the seeded header on `mind/log.md`. The one rule behind memoryTokens,
 * Contents' memory tokens and the strata.
 */
export function memoryBytes(path: string, size: unknown): number {
  const bytes = typeof size === 'number' && Number.isFinite(size) ? size : 0
  return path === 'mind/log.md' ? Math.max(0, bytes - MIND_LOG_SEED_BYTES) : bytes
}

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

/** safe() whose fallback (usually the older schema's query) runs only when the query fails. */
function safeOr<T>(q: Sql, sql: string, map: (rows: unknown[]) => T, orElse: () => T, params?: unknown[]): T {
  try {
    return map(q(sql, params))
  } catch {
    return orElse()
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

/** `local_*` tables whose rows are counted, at most. */
const MAX_TABLES = 50

/** `local_*` table names (safe identifiers only). */
function listLocalTables(q: Sql): string[] {
  return safe(
    q,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'local\\_%' ESCAPE '\\' ORDER BY name",
    (rows) => (rows as Array<{ name: string }>).map((r) => r.name).filter((n) => /^local_[A-Za-z0-9_]+$/.test(n)),
    [] as string[]
  )
}

/** adf_audit sources of archived loop streams: legacy `loop` (main, before schema 29) and `loop:<name>`. */
const LOOP_AUDIT_WHERE = "(source = 'loop' OR source LIKE 'loop:%')"
/** An archived loop snapshot of at least this share of the loop's threshold is one full context. */
const FULL_SNAPSHOT_SHARE = 0.5
const BASELINE_KEY = 'context_baseline_tokens'

const loopOfSource = (source: string): string => (source === 'loop' ? 'main' : source.slice('loop:'.length) || 'main')
const clamp01 = (x: number): number => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0)

/** Live `[Loop Compacted` summary rows of one file, and how far the scan has read. */
export interface SummaryScan {
  /** Highest adf_loop seq this scan has seen. */
  lastSeq: number
  hits: Array<{ seq: number; loop: string }>
}

/**
 * Live compaction summary rows. The LIKE runs over the whole content, so with
 * `prior` (the last scan of this file) only rows above its high-water seq are
 * matched; earlier hits are kept while their rows still exist (a primary-key
 * lookup). seq is AUTOINCREMENT, so rows never appear below the high-water mark.
 * `upTo` stops the scan at that seq, so a cold scan can run in chunks.
 */
export function readSummaryScan(q: Sql, prior?: SummaryScan, upTo = Infinity): SummaryScan {
  const maxSeq = Math.min(upTo, safe(q, 'SELECT MAX(seq) AS n FROM adf_loop', (r) => firstNumber(r), 0))
  const base = prior && prior.lastSeq <= maxSeq ? prior : null
  const sql = (loopCol: string): string =>
    `SELECT seq, ${loopCol} AS loop FROM adf_loop WHERE seq > ? AND seq <= ? AND role = 'user' AND content_json LIKE '%[Loop Compacted%'`
  type Hit = { seq: number; loop: string | null }
  const params = [base ? base.lastSeq : 0, maxSeq]
  const fresh = safeOr(q, sql('loop'), (r) => r as Hit[], () => safe(q, sql("'main'"), (r) => r as Hit[], [], params), params)
  let kept: SummaryScan['hits'] = []
  if (base && base.hits.length > 0) {
    const alive = new Set(safe(
      q,
      'SELECT seq FROM adf_loop WHERE seq IN (SELECT value FROM json_each(?))',
      (r) => (r as Array<{ seq: number }>).map((x) => x.seq),
      [] as number[],
      [JSON.stringify(base.hits.map((h) => h.seq))]
    ))
    kept = base.hits.filter((h) => alive.has(h.seq))
  }
  return { lastSeq: maxSeq, hits: [...kept, ...fresh.map((h) => ({ seq: h.seq, loop: h.loop || 'main' }))] }
}

/**
 * Contexts of work over every loop the file knows: config.loops, live
 * adf_loop streams, and deleted loops whose stream was archived to adf_audit.
 * Per loop: past contexts plus the current context's fill.
 *
 * Past: each archived snapshot (compaction, clear, slice clear, loop delete)
 * counts by size: bytes / 4 tokens against half the loop's compaction
 * threshold, capped at 1, so a compaction is one context and a small slice
 * clear a fraction. With loop audit off nothing is archived and the live
 * `[Loop Compacted` summary rows are the only trace; the larger of the two
 * counts wins.
 *
 * Current: the loop's context baseline (the size of its next request, kept
 * per loop in adf_meta) or, without one, its live rows' content bytes / 4,
 * as a 0..1 share of the loop's compaction threshold. Thresholds resolve as
 * the executor does (resolveLoopThreshold); a deleted loop uses the host's.
 */
export function readContextsWorked(q: Sql, config: Partial<AgentConfig>, summaryScan: SummaryScan = readSummaryScan(q)): number {
  const threshold = (loop: string): number => resolveLoopThreshold(config as AgentConfig, loop)
  const loops = new Set<string>(['main', ...(config.loops ?? []).map((l) => l?.name).filter((n): n is string => typeof n === 'string' && !!n)])

  type LoopCount = { loop: string | null; n: number }
  const live = safeOr(q, 'SELECT loop, COUNT(*) AS n FROM adf_loop GROUP BY loop', (r) => r as LoopCount[],
    () => safe(q, "SELECT 'main' AS loop, COUNT(*) AS n FROM adf_loop", (r) => r as LoopCount[], []))
  const liveRows = new Map<string, number>()
  for (const r of live) {
    const name = r.loop || 'main'
    liveRows.set(name, (liveRows.get(name) ?? 0) + r.n)
    loops.add(name)
  }

  const archived = new Map<string, number>()
  for (const r of safe(q, `SELECT source, size_bytes AS bytes FROM adf_audit WHERE ${LOOP_AUDIT_WHERE}`, (rows) => rows as Array<{ source: string; bytes: number }>, [])) {
    const name = loopOfSource(r.source)
    loops.add(name)
    const bytes = typeof r.bytes === 'number' ? r.bytes : 0
    archived.set(name, (archived.get(name) ?? 0) + clamp01(bytes / 4 / (threshold(name) * FULL_SNAPSHOT_SHARE)))
  }

  const summaries = new Map<string, number>()
  for (const h of summaryScan.hits) summaries.set(h.loop, (summaries.get(h.loop) ?? 0) + 1)

  const baselines = new Map<string, number>()
  for (const r of safe(q, `SELECT key, value FROM adf_meta WHERE key = '${BASELINE_KEY}' OR key LIKE '${BASELINE_KEY}:%'`, (rows) => rows as Array<{ key: string; value: string }>, [])) {
    try {
      const tokens = (JSON.parse(r.value) as { tokens?: unknown }).tokens
      if (typeof tokens === 'number' && Number.isFinite(tokens)) baselines.set(r.key === BASELINE_KEY ? 'main' : r.key.slice(BASELINE_KEY.length + 1), tokens)
    } catch { /* unreadable baseline: fall back to row bytes */ }
  }

  let total = 0
  for (const loop of loops) {
    total += Math.max(archived.get(loop) ?? 0, summaries.get(loop) ?? 0)
    if (!liveRows.get(loop)) continue
    let tokens = baselines.get(loop)
    if (tokens === undefined) {
      // octet_length reads the stored size without loading the text.
      const bytesSql = (where: string): string => `SELECT SUM(octet_length(content_json)) AS n FROM adf_loop ${where}`
      const bytes = loop === 'main'
        ? safeOr(q, bytesSql("WHERE loop = 'main'"), (r) => firstNumber(r), () => safe(q, bytesSql(''), (r) => firstNumber(r), 0))
        : safe(q, bytesSql('WHERE loop = ?'), (r) => firstNumber(r), 0, [loop])
      tokens = bytes / 4
    }
    total += clamp01(tokens / threshold(loop))
  }
  return Math.round(total * 100) / 100
}

/**
 * The cheap reads behind the card: config, identity and timer rows, metrics,
 * the message high-water mark. Small tables and primary keys only, so it may
 * run on every overview read.
 */
export interface VitalsCheapPart {
  config: Partial<AgentConfig>
  meta: FleetMeta
  power: AgentPowerInputs
  messages: number
  metrics: AgentMetric[]
  nextWakeAt?: number
  /** The ALF card face: description, public flag, verified owner attestation. */
  card: { description?: string; public: boolean; ownerVerified: boolean }
}

/** The expensive reads: the adf_files scan, local table counts, contexts worked. */
export interface VitalsHeavyPart {
  maturity: Omit<AgentExperienceInputs, 'agentsSpawned' | 'ageDays' | 'messages'>
  summaryScan: SummaryScan
  /** USD over the last 7 local days from priced adf_loop rows (agent-daily.ts); absent without usage records. */
  cost7d?: { usd: number; partial: boolean }
}

/** True when adf_attestations holds an owner attestation about `did` that is unexpired and verifies. */
function readOwnerVerified(q: Sql, did: string | null): boolean {
  if (!did) return false
  const rows = safe(q, 'SELECT raw_json FROM adf_attestations', (r) => r as Array<{ raw_json: string }>, [])
  for (const r of rows) {
    let att: AlfAttestation | null = null
    try { att = JSON.parse(r.raw_json) as AlfAttestation } catch { att = null }
    if (att && att.role === 'owner' && verifyAttestation(att, { expectedSubject: did })) return true
  }
  return false
}

export function readVitalsCheapPart(q: Sql): VitalsCheapPart {
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
  type TimerRow = { schedule_json: string; next_wake_at: number }
  const timerRows = safeOr(
    q,
    'SELECT schedule_json, next_wake_at FROM adf_timers WHERE expired = 0',
    (rows) => rows as TimerRow[],
    () => safe(q, 'SELECT schedule_json, next_wake_at FROM adf_timers', (rows) => rows as TimerRow[], [])
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

  // Messages, every loop current and past: seq is one AUTOINCREMENT shared by
  // all loops, so its high-water mark is the sum and survives compaction,
  // clears and loop deletion. MAX(seq) covers files without a sqlite_sequence row.
  const messages = Math.max(
    safe(q, "SELECT seq AS n FROM sqlite_sequence WHERE name = 'adf_loop'", (r) => firstNumber(r), 0),
    safe(q, 'SELECT MAX(seq) AS n FROM adf_loop', (r) => firstNumber(r), 0)
  )

  const metrics = safe(
    q,
    "SELECT key, value FROM adf_meta WHERE key LIKE 'metric:%' ORDER BY key LIMIT 20",
    (rows) => (rows as Array<{ key: string; value: unknown }>).map((r) => parseMetric(r.key.slice('metric:'.length), r.value)),
    [] as AgentMetric[]
  )

  return {
    config,
    meta,
    power: powerInputsFromConfig(config, {
      credentials,
      privateKey,
      timers: { active: timerRows.length, fastestIntervalMs }
    }),
    messages,
    metrics,
    nextWakeAt,
    card: {
      ...(config.description?.trim() ? { description: config.description.trim() } : {}),
      public: config.serving?.public?.enabled ?? false,
      ownerVerified: readOwnerVerified(q, meta.did)
    }
  }
}

/**
 * The Experience inputs that scan: adf_files (paths and timestamps, no
 * content), local table row counts, contexts worked. `prior` makes the
 * compaction-summary LIKE incremental.
 */
export function readVitalsHeavyPart(q: Sql, cheap: Pick<VitalsCheapPart, 'config' | 'meta'>, prior?: SummaryScan): VitalsHeavyPart {
  // Files seeded at creation land a few ms after adf_created_at; anything the
  // agent writes comes much later (a turn takes seconds).
  const cutoff = agentWriteCutoff(cheap.meta.createdAt)

  // Files changed after creation. Template instances carry their template's
  // older timestamps, so starter files never count. mind/ counts as memory
  // tokens instead.
  const { mine, agentSkills } = classifyFiles(
    safe(q, 'SELECT path, updated_at FROM adf_files', (rows) => rows as FileRow[], []),
    cutoff,
    readRegistrySkills(q)
  )
  const filesWritten = mine.filter((f) => !f.path.startsWith('mind/')).length
  // The seeded mind/log.md header is not the agent's memory: with memory XP
  // square-rooted, even its ~40 tokens would lift a brand-new agent to Lv 2.
  const mindFiles = safe(q, "SELECT path, size FROM adf_files WHERE path LIKE 'mind/%'", (rows) => rows as Array<{ path: string; size: unknown }>, [])
  const memoryTokens = Math.round(mindFiles.reduce((n, f) => n + memoryBytes(f.path, f.size), 0) / 4)

  // COUNT(*) is a full scan per table: rows are summed over the first
  // MAX_TABLES only, as Contents does, so an agent with hundreds of tables
  // cannot stall the main process on every refresh.
  const tables = listLocalTables(q)
  let localRows = 0
  for (const t of tables.slice(0, MAX_TABLES)) localRows += safe(q, `SELECT COUNT(*) AS n FROM "${t}"`, (r) => firstNumber(r), 0)

  const summaryScan = readSummaryScan(q, prior)
  return {
    maturity: {
      contextsWorked: readContextsWorked(q, cheap.config, summaryScan),
      filesWritten,
      memoryTokens,
      localTables: tables.length,
      localRows,
      skills: agentSkills.size
    },
    summaryScan
  }
}

// =============================================================================
// Activity: upcoming wakes, per-day messages and cost, contents
// =============================================================================

/** Contents' "updated this week" window. */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000

/** bytes / 4, rounded: the overview's token estimate. */
const approxTokens = (bytes: number): number => Math.round(bytes / 4)

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Current `mind/` tokens by the age of each file's updated_at: `week` (at
 * most 7 days), `month` (30), `quarter` (90), `older`. A boundary belongs to
 * the younger band. Bytes by memoryBytes (the seeded `mind/log.md` header is
 * not memory). ISO timestamps compare lexically.
 */
export function readMemoryStrata(q: Sql, now = Date.now()): MemoryStrata {
  const since = (days: number): string => new Date(now - days * DAY_MS).toISOString()
  const week = since(MEMORY_STRATA_DAYS.week)
  const month = since(MEMORY_STRATA_DAYS.month)
  const quarter = since(MEMORY_STRATA_DAYS.quarter)
  const bytes: MemoryStrata = { older: 0, quarter: 0, month: 0, week: 0 }
  const rows = safe(q, "SELECT path, size, updated_at FROM adf_files WHERE path LIKE 'mind/%'", (r) => r as Array<{ path: string; size: unknown; updated_at: string }>, [])
  for (const r of rows) {
    const at = String(r.updated_at ?? '')
    const band: keyof MemoryStrata = at >= week ? 'week' : at >= month ? 'month' : at >= quarter ? 'quarter' : 'older'
    bytes[band] += memoryBytes(r.path, r.size)
  }
  return { older: approxTokens(bytes.older), quarter: approxTokens(bytes.quarter), month: approxTokens(bytes.month), week: approxTokens(bytes.week) }
}

/**
 * The Contents section: mind/ files and the agent's skills as counts and
 * approximate tokens (mind also by age band, skills also per skill), local
 * tables as counts and rows. Mind tokens use memoryBytes, as memoryTokens does.
 */
export function readContents(q: Sql, files: FileRow[], agentSkills: Set<string>, now = Date.now()): AgentContents {
  const weekAgo = now - WEEK_MS
  let mindFiles = 0
  let mindBytes = 0
  let mindRecent = 0
  let skillBytes = 0
  const mindItems: MemoryFileSize[] = []
  const perSkill = new Map<string, { bytes: number; files: number }>()
  for (const name of agentSkills) perSkill.set(name, { bytes: 0, files: 0 })
  for (const f of files) {
    const size = typeof f.size === 'number' && Number.isFinite(f.size) ? f.size : 0
    if (f.path.startsWith('mind/')) {
      mindFiles++
      mindBytes += memoryBytes(f.path, size)
      mindItems.push({ path: f.path, tokens: approxTokens(memoryBytes(f.path, size)), updatedAt: f.updated_at })
      if (Date.parse(f.updated_at) >= weekAgo) mindRecent++
      continue
    }
    const skill = SKILL_FILE.exec(f.path)?.[1]
    if (skill && agentSkills.has(skill)) {
      skillBytes += size
      const s = perSkill.get(skill)!
      s.bytes += size
      s.files++
    }
  }
  const items = [...perSkill]
    .map(([name, s]) => ({ name, tokens: approxTokens(s.bytes), files: s.files }))
    .sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name))

  // ISO timestamps sort lexically: newest first.
  mindItems.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.path.localeCompare(b.path)))

  const allTables = listLocalTables(q)
  const tables = allTables.slice(0, MAX_TABLES)
  let rows = 0
  const tableItems: TableSize[] = []
  for (const t of tables) {
    const n = safe(q, `SELECT COUNT(*) AS n FROM "${t}"`, (r) => firstNumber(r), 0)
    const columns = safe(q, `SELECT COUNT(*) AS n FROM pragma_table_info('${t}')`, (r) => firstNumber(r), 0)
    rows += n
    tableItems.push({ name: t, rows: n, columns })
  }
  tableItems.sort((a, b) => b.rows - a.rows || a.name.localeCompare(b.name))
  const unread = allTables.length - tables.length

  return {
    mind: { files: mindFiles, tokens: approxTokens(mindBytes), updatedThisWeek: mindRecent, strata: readMemoryStrata(q, now), items: mindItems },
    skills: { count: agentSkills.size, tokens: approxTokens(skillBytes), items },
    tables: { count: tables.length, rows, items: tableItems, ...(unread > 0 ? { unread } : {}) }
  }
}

/** The part of AgentActivity read from the file. */
export type ActivityRead = Omit<AgentActivity, 'filePath' | 'computedAt' | 'live'>

/** Payload text cut to UPCOMING_TEXT_MAX; undefined when empty. */
function upcomingText(v: unknown): string | undefined {
  if (typeof v !== 'string' || !v.trim()) return undefined
  return v.length > UPCOMING_TEXT_MAX ? `${v.slice(0, UPCOMING_TEXT_MAX - 1)}…` : v
}

/** Coming up: the next three wakes (idx_adf_timers_wake). Cheap. */
export function readUpcoming(q: Sql): UpcomingWake[] {
  type TimerRow = { id: number; next_wake_at: number; scope: string | null; payload: string | null; lambda: string | null; loop: string | null }
  const readTimers = (cols: string, where: string): TimerRow[] | null =>
    safe(q, `SELECT ${cols} FROM adf_timers ${where} ORDER BY next_wake_at LIMIT 3`, (r) => r as TimerRow[], null as TimerRow[] | null)
  const timers =
    readTimers('id, next_wake_at, scope, payload, lambda, loop', 'WHERE expired = 0') ??
    readTimers('id, next_wake_at, scope, payload, lambda, NULL AS loop', 'WHERE expired = 0') ??
    readTimers('id, next_wake_at, scope, payload, lambda, NULL AS loop', '') ??
    []
  return timers.map((t) => {
    let scope: UpcomingWake['scope'] = 'system'
    try {
      const parsed = JSON.parse(t.scope ?? '[]') as unknown
      if (Array.isArray(parsed) && parsed[0] === 'agent') scope = 'agent'
    } catch { /* default */ }
    const text = upcomingText(t.payload)
    if (scope === 'agent') return { id: t.id, at: t.next_wake_at, scope, loop: t.loop || 'main', ...(text ? { prompt: text } : {}) }
    return { id: t.id, at: t.next_wake_at, scope, ...(t.lambda ? { lambda: t.lambda } : {}), ...(text ? { input: text } : {}) }
  })
}

/** The scanning part of the activity read: per-day messages and cost, contents. */
export type ActivityHeavyRead = Omit<ActivityRead, 'upcoming'> & { dayScan: LoopDayScan }

/**
 * Per-day messages and cost (agent-daily.ts; incremental with `prior`) and
 * contents. Local tables are bounded by MAX_TABLES; adf_files is read path,
 * timestamps and size only, never content.
 */
export function readActivityHeavy(q: Sql, now: number, prior?: LoopDayScan): ActivityHeavyRead {
  const createdAt = safe(
    q,
    "SELECT COALESCE((SELECT value FROM adf_meta WHERE key = 'adf_created_at'), (SELECT json_extract(config_json, '$.metadata.created_at') FROM adf_config WHERE id = 1)) AS v",
    (r) => (r[0] as { v?: string | null } | undefined)?.v ?? null,
    null as string | null
  )
  const cutoff = agentWriteCutoff(createdAt)

  // Files: one path/timestamp/size scan for contents.
  const files = safe(q, 'SELECT path, updated_at, size FROM adf_files', (rows) => rows as FileRow[], [])
  const { agentSkills } = classifyFiles(files, cutoff, readRegistrySkills(q))

  const { daily, scan } = readDailyActivity(q, now, prior)
  return { daily, contents: readContents(q, files, agentSkills, now), dayScan: scan }
}

/** Everything the overview's lower sections read from the file. */
export function readAgentActivity(q: Sql, now: number, prior?: LoopDayScan): ActivityRead & { dayScan: LoopDayScan } {
  return { upcoming: readUpcoming(q), ...readActivityHeavy(q, now, prior) }
}

// =============================================================================
// Service
// =============================================================================

/**
 * One cached read in two parts. `cheap` follows the source key; `heavy`
 * (the scans) is reused while younger than HEAVY_MIN_AGE_MS.
 */
interface SplitEntry<C, H> {
  /** Source: the open workspace's total_changes(), or the file's and WAL's mtime/size. */
  key: string
  /** The activity read's local day: a new day re-reads everything. */
  salt: string
  at: number
  cheap: C
  heavyAt: number
  heavy: H
}

/** A live agent's cheap part is re-read at most this often. */
const LIVE_MIN_INTERVAL_MS = 2_000
/**
 * The scanning part is reused for this long even when the database moved: a
 * running agent writes every few seconds, and the scans (adf_files, local
 * tables, loop rows) are what costs main-thread time. `force` skips it.
 */
export const HEAVY_MIN_AGE_MS = 30_000
/** adf_loop seqs per step of a cold compaction-summary scan. */
const SUMMARY_SCAN_CHUNK = 2_000
/** adf_loop seqs per step of a cold activity-window scan (warmDayScan). */
const DAY_SCAN_CHUNK = 2_000
/** `force` re-reads the scanning part at most this often. */
export const FORCE_MIN_INTERVAL_MS = 2_000

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
  private lastFleetAt = 0

  private slowCache = new Map<string, SplitEntry<VitalsCheapPart, VitalsHeavyPart>>()
  private activityCache = new Map<string, SplitEntry<{ upcoming: UpcomingWake[] }, Omit<ActivityHeavyRead, 'dayScan'>>>()
  /**
   * Per-row adf_loop scan of the activity window per file, shared by the
   * vitals (7-day cost) and activity (per-day chart) reads; makes the next
   * one incremental.
   */
  private dayScans = new Map<string, LoopDayScan>()
  /** In-flight cold day scans, so a vitals and an activity read share one. */
  private dayScanWarming = new Map<string, Promise<void>>()
  /** Last compaction-summary scan per file; makes the next one incremental. */
  private summaryScans = new Map<string, SummaryScan>()
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
    this.lastFleetAt = now
    return { running, agents }
  }

  /**
   * Redo the fleet scan behind agentsSpawned when it is missing or older than
   * `maxAgeMs` (always when `force`). Studio's fleet map polls it anyway; a
   * vitals read with the map closed, or from the daemon, refreshes it here so
   * the Experience level does not depend on which screen was opened first.
   */
  async ensureFleetScan(maxAgeMs: number, force = false): Promise<void> {
    if (!force && this.lastFleet && this.now() - this.lastFleetAt <= maxAgeMs) return
    await this.getFleetStatus()
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
      this.dayScans.delete(filePath)
      this.summaryScans.delete(filePath)
    } else {
      this.slowCache.clear()
      this.activityCache.clear()
      this.dayScans.clear()
      this.summaryScans.clear()
    }
  }

  /**
   * One cached read in two parts against one connection. Live agents: keyed by
   * the connection's total_changes() (any write — a finished turn, a config
   * change — bumps it), re-read at most every LIVE_MIN_INTERVAL_MS. Files
   * nobody has open: keyed by the file's and its WAL's mtime/size, read with
   * one readonly peek. A new key re-reads `cheap`; `heavy` (the scans) is
   * reused until it is HEAVY_MIN_AGE_MS old. `force` re-reads `cheap` always
   * and `heavy` unless it is younger than FORCE_MIN_INTERVAL_MS. `salt` (the
   * activity read's local day) drops both when it changes.
   */
  private async splitRead<C, H>(
    cache: Map<string, SplitEntry<C, H>>,
    filePath: string,
    force: boolean,
    readCheap: (q: Sql) => C,
    readHeavy: (q: Sql, cheap: C) => H,
    salt = ''
  ): Promise<{ entry: SplitEntry<C, H>; live: boolean }> {
    // Let other IPC work run before the synchronous reads.
    await new Promise<void>((resolve) => setImmediate(resolve))
    const ws = this.findOpenWorkspace(filePath)
    const cached = cache.get(filePath)
    const fresh = cached && cached.salt === salt ? cached : undefined
    const now = this.now()
    let key: string
    if (ws) {
      if (!force && fresh?.key.startsWith('live:') && now - fresh.at < LIVE_MIN_INTERVAL_MS) return { entry: fresh, live: true }
      const changes = safe(ws.querySQL.bind(ws), 'SELECT total_changes() AS n', (r) => firstNumber(r), -1)
      key = `live:${this.workspaceId(ws)}:${changes}`
    } else {
      const [main, wal] = await Promise.all([
        fsp.stat(filePath),
        fsp.stat(`${filePath}-wal`).catch(() => null)
      ])
      key = `file:${main.mtimeMs}:${main.size}:${wal?.mtimeMs ?? 0}:${wal?.size ?? 0}`
    }
    if (!force && fresh && fresh.key === key) {
      if (ws) fresh.at = now
      return { entry: fresh, live: !!ws }
    }
    const heavyAge = fresh ? now - fresh.heavyAt : Infinity
    const reuseHeavy = fresh !== undefined && heavyAge < (force ? FORCE_MIN_INTERVAL_MS : HEAVY_MIN_AGE_MS)

    // The read is synchronous, so no second caller can arrive mid-read and
    // there is nothing to dedupe. (An in-flight map here once stuck: the async
    // wrapper's `finally` ran before the entry was set, so every later
    // cache miss and every `force` got the first read back forever.)
    const run = (q: Sql): { cheap: C; heavy: H } => {
      const cheap = readCheap(q)
      return { cheap, heavy: reuseHeavy ? fresh!.heavy : readHeavy(q, cheap) }
    }
    try {
      const { cheap, heavy } = ws
        ? run((sql, params) => ws.querySQL(sql, params))
        : AdfDatabase.peek(filePath, (db) => run((sql, params) => db.prepare(sql).all(...(params ?? []))))
      const at = this.now()
      const entry: SplitEntry<C, H> = { key, salt, at, cheap, heavy, heavyAt: reuseHeavy ? fresh!.heavyAt : at }
      cache.set(filePath, entry)
      return { entry, live: !!ws }
    } catch (err) {
      // Transient lock on a peek: serve the last good read.
      if (cached) return { entry: cached, live: !!ws }
      throw err
    }
  }

  /**
   * A live agent's first compaction-summary scan, in SUMMARY_SCAN_CHUNK seq
   * ranges with the event loop free between them: the LIKE reads every user
   * row's content, which on a long unbroken loop is tens of milliseconds.
   * Later scans only read rows above the high-water mark.
   */
  private async warmSummaryScan(filePath: string, ws: VitalsWorkspace): Promise<void> {
    const q: Sql = (sql, params) => ws.querySQL(sql, params)
    const maxSeq = safe(q, 'SELECT MAX(seq) AS n FROM adf_loop', (r) => firstNumber(r), 0)
    let scan: SummaryScan = { lastSeq: 0, hits: [] }
    while (scan.lastSeq < maxSeq) {
      scan = readSummaryScan(q, scan, scan.lastSeq + SUMMARY_SCAN_CHUNK)
      await new Promise<void>((resolve) => setImmediate(resolve))
      // Closed or reopened meanwhile: the next read starts over.
      if (this.findOpenWorkspace(filePath) !== ws) return
    }
    if (!this.summaryScans.has(filePath)) this.summaryScans.set(filePath, scan)
  }

  /**
   * The first day scan of a file for the current window, in DAY_SCAN_CHUNK
   * seq ranges with the event loop free between them: reading created_at
   * walks each row's content overflow, about 3 ms per 1 000 rows. A live
   * agent is read through its workspace; a closed file through one readonly
   * peek per chunk. Later reads are incremental (refreshLoopDayScan).
   * Concurrent callers share one warm-up.
   */
  private warmDayScan(filePath: string): Promise<void> {
    const since = windowStartMs(this.now())
    if (this.dayScans.get(filePath)?.since === since) return Promise.resolve()
    let warming = this.dayScanWarming.get(filePath)
    if (!warming) {
      warming = this.runDayScanWarmUp(filePath, since)
        .catch(() => { /* the heavy read scans synchronously instead */ })
        .finally(() => this.dayScanWarming.delete(filePath))
      this.dayScanWarming.set(filePath, warming)
    }
    return warming
  }

  private async runDayScanWarmUp(filePath: string, since: number): Promise<void> {
    const ws = this.findOpenWorkspace(filePath)
    const run = <T>(read: (q: Sql) => T): T =>
      ws
        ? read((sql, params) => ws.querySQL(sql, params))
        : AdfDatabase.peek(filePath, (db) => read((sql, params) => db.prepare(sql).all(...(params ?? []))))
    let scan = run((q) => startLoopDayScan(q, since))
    const maxSeq = run(maxLoopSeq)
    while (scan.lastSeq < maxSeq) {
      await new Promise<void>((resolve) => setImmediate(resolve))
      // Closed or reopened meanwhile: the next read starts over.
      if (this.findOpenWorkspace(filePath) !== ws) return
      const upTo = Math.min(maxSeq, scan.lastSeq + DAY_SCAN_CHUNK)
      scan = run((q) => scanLoopRows(q, scan, upTo))
    }
    if (this.dayScans.get(filePath)?.since !== since) this.dayScans.set(filePath, scan)
  }

  /** Children in the last fleet scan whose parent reference names this agent. */
  private countSpawned(meta: FleetMeta): number | null {
    if (!this.lastFleet) return null
    const ids = new Set<string>([...(meta.did ? [meta.did] : []), ...meta.didHistory, ...(meta.agentId ? [meta.agentId] : [])])
    if (ids.size === 0) return 0
    return this.lastFleet.filter((a) => a.parentDid && ids.has(a.parentDid)).length
  }

  async getAgentVitals(filePath: string, opts?: { force?: boolean }): Promise<AgentVitals> {
    const ws = this.findOpenWorkspace(filePath)
    if (ws && !this.summaryScans.has(filePath)) await this.warmSummaryScan(filePath, ws)
    await this.warmDayScan(filePath)
    const { entry, live } = await this.splitRead(
      this.slowCache,
      filePath,
      !!opts?.force,
      readVitalsCheapPart,
      (q, cheap) => {
        const heavy = readVitalsHeavyPart(q, cheap, this.summaryScans.get(filePath))
        this.summaryScans.set(filePath, heavy.summaryScan)
        const { daily, scan } = readDailyActivity(q, this.now(), this.dayScans.get(filePath))
        this.dayScans.set(filePath, scan)
        const cost7d = recentCost(daily)
        return cost7d ? { ...heavy, cost7d } : heavy
      }
    )
    const { cheap, heavy } = entry
    const now = this.now()
    const createdMs = cheap.meta.createdAt ? Date.parse(cheap.meta.createdAt) : NaN
    const ageDays = Number.isFinite(createdMs) ? Math.max(0, (now - createdMs) / 86_400_000) : 0
    const maturity: AgentExperienceInputs = {
      ...heavy.maturity,
      messages: cheap.messages,
      agentsSpawned: this.countSpawned(cheap.meta),
      ageDays
    }
    const ctx = live ? this.deps.getContextGauge(filePath) : undefined
    const cost = heavy.cost7d
    return {
      filePath,
      computedAt: entry.at,
      live,
      handle: cheap.meta.handle || deriveHandle(filePath),
      name: cheap.meta.name ?? undefined,
      did: cheap.meta.did ?? undefined,
      agentId: cheap.meta.agentId ?? undefined,
      model: cheap.meta.model ?? undefined,
      createdAt: cheap.meta.createdAt ?? undefined,
      ageDays,
      ...(cheap.meta.status?.trim() ? { status: cheap.meta.status.trim() } : {}),
      ...(cheap.card.description ? { description: cheap.card.description } : {}),
      public: cheap.card.public,
      ownerVerified: cheap.card.ownerVerified,
      contextTokens: ctx && ctx.tokens > 0 ? ctx.tokens : undefined,
      contextThreshold: ctx && ctx.tokens > 0 ? ctx.threshold : undefined,
      nextWakeAt: cheap.nextWakeAt,
      cost7dUsd: cost ? cost.usd : undefined,
      cost7dPartial: cost ? cost.partial : undefined,
      metrics: cheap.metrics,
      stats: scoreAgent(cheap.power, maturity),
      maturity
    }
  }

  /**
   * The overview's lower sections: next wakes, 14 days of messages and cost
   * per day (agent-daily.ts, from the file alone), and what the file holds
   * (mind and skills with approximate tokens, local tables with rows). Cached
   * like the vitals: wakes are the cheap part, days and contents the heavy one.
   */
  async getAgentActivity(filePath: string, opts?: { force?: boolean }): Promise<AgentActivity> {
    const now = this.now()
    await this.warmDayScan(filePath)
    const { entry, live } = await this.splitRead(
      this.activityCache,
      filePath,
      !!opts?.force,
      (q) => ({ upcoming: readUpcoming(q) }),
      (q) => {
        const { dayScan, ...read } = readActivityHeavy(q, this.now(), this.dayScans.get(filePath))
        this.dayScans.set(filePath, dayScan)
        return read
      },
      localDateKey(new Date(now))
    )
    return { filePath, computedAt: entry.at, live, upcoming: entry.cheap.upcoming, ...entry.heavy }
  }
}
