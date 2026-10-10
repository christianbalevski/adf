/**
 * Agent vitals: the per-agent overview card's data. Header facts (context,
 * next wake, 7-day cost, model, age) plus four stats scored by the pure
 * module in `src/shared/utils/agent-stats.ts`.
 */

import type { MessagingMode, Visibility } from './adf-v02.types'

/** One line of a stat's breakdown. */
export interface StatFactor {
  /** Stable id, e.g. `tool:compute_exec`, `mcp:github`, `visibility`. */
  id: string
  /** Plain technical English, shown as is. */
  label: string
  /**
   * Power points this factor adds. Negative for mitigations. 0 for an item
   * past its kind's cap (7th MCP server, 4th adapter): listed, not counted.
   */
  points: number
  /** True when the capability needs human approval (restricted tool, sealed secret). */
  gated: boolean
  /** Config path (or table) that controls this factor. */
  configPath: string
}

/**
 * Reach / Access / Autonomy. A capped level on the 1-20 scale in
 * `src/shared/utils/agent-stats.ts`: level = 1 + round(19 * fill), fill =
 * points / max. Gated points count toward the level; `open` and `gated` say
 * how it splits.
 */
export interface PowerStat {
  /** 1..20. */
  level: number
  /** Points behind the level: `open + gated`, after mitigations, >= 0. */
  points: number
  /** Points of a maxed-out config for this stat (POWER_MAX). */
  max: number
  /** points / max, clamped to 0..1: how much of the possible power the agent has. */
  fill: number
  /** Points whose capability runs without approval (mitigations taken off these first). */
  open: number
  /** Points whose capability needs approval. */
  gated: number
  /** True when open / max >= POWER_HIGH_OPEN_SHARE (0.6): much of this runs without anyone asking. */
  high: boolean
  /** Sum of factor points, mitigations included (can be negative). */
  rawPoints: number
  factors: StatFactor[]
}

/** Raw maturity counts read from the agent's file. */
export interface AgentExperienceInputs {
  /**
   * Contexts of work, summed over every loop the file knows (main, side loops,
   * deleted loops whose stream sits in adf_audit): archived loop snapshots
   * (a snapshot of at least half the loop's compaction threshold is one
   * context, a smaller one its share) or, with loop audit off, live compaction
   * summaries; plus each loop's current fill (context baseline, else row
   * bytes / 4) as a 0..1 share of its compaction threshold. Fractional.
   */
  contextsWorked: number
  /** adf_files rows changed after the agent was created (template starter files and `mind/` excluded). */
  filesWritten: number
  /** Approximate tokens in `mind/` files: SUM(size) less the seeded `mind/log.md` header, / 4, rounded. */
  memoryTokens: number
  /** `local_*` tables. */
  localTables: number
  /** Total rows across `local_*` tables (the first 50 by name). */
  localRows: number
  /** Distinct skills the agent installed or changed. */
  skills: number
  /** Tracked agents whose adf_parent_did names this agent. null when not known yet. */
  agentsSpawned: number | null
  /**
   * Loop messages ever written, every loop current and past: adf_loop's
   * AUTOINCREMENT high-water mark. seq is one sequence shared by all loops,
   * so the table-wide mark already is the sum; compaction, clears and loop
   * deletion do not lower it.
   */
  messages: number
  /** Days since adf_created_at. */
  ageDays: number
}

export interface ExperienceSignal {
  id: keyof AgentExperienceInputs
  label: string
  /** Raw count. */
  value: number
  /** XP this signal adds. */
  xp: number
}

export interface ExperienceStat {
  /** >= 1. Largest L with xpForLevel(L) <= score (EXPERIENCE_CURVE). */
  level: number
  /** 0..1 within the current level. */
  progress: number
  /** Total XP (sum of signal XP). */
  score: number
  /** XP at which the current level starts and the next one starts. */
  levelStart: number
  nextLevelAt: number
  breakdown: ExperienceSignal[]
  /** What one more level takes, in units of the cheapest signals. `xp` = nextLevelAt - score. */
  nextLevel: { xp: number; contexts: number; memoryTokens: number; skills: number; hint: string }
}

/**
 * Plain inputs for Reach / Access / Autonomy. Built from AgentConfig plus a
 * few table reads by `powerInputsFromConfig`; scoring never touches IO.
 */
export interface AgentPowerInputs {
  tools: Array<{ name: string; enabled: boolean; restricted?: boolean }>
  autonomous: boolean
  autostart: boolean
  messaging: {
    receive: boolean
    mode: MessagingMode
    visibility: Visibility
    allowListCount: number
  }
  security: { allowUnsigned: boolean; requireSignature: boolean }
  serving: { publicEnabled: boolean; apiRouteCount: number; sharedEnabled: boolean }
  /** Enabled channel adapters. `restrictedDm` when the DM policy is allowlist or none. */
  adapters: Array<{ type: string; restrictedDm: boolean }>
  /** Enabled config.ws_connections entries. */
  wsConnectionCount: number
  mcpServers: Array<{ name: string; restricted: boolean; hasCredentials: boolean }>
  npmPackageCount: number
  codeNetwork: boolean
  compute: { enabled: boolean; hostAccess: boolean; allowedTargets: string[] }
  /** Enabled triggers with at least one target, on_chat excluded. */
  triggers: Array<{ type: string; targets: number }>
  sideLoopCount: number
  /** adf_identity rows outside `crypto:*`. Sealed = encryption_algo other than 'plain'. */
  credentials: { plain: number; sealed: number }
  privateKey: 'none' | 'sealed' | 'plain'
  /** Non-expired adf_timers rows. */
  timers: { active: number; fastestIntervalMs?: number }
}

export interface AgentStats {
  reach: PowerStat
  access: PowerStat
  autonomy: PowerStat
  experience: ExperienceStat
}

/** Result of `adf:agent:vitals`. */
export interface AgentVitals {
  filePath: string
  /** ms epoch the slow part (stats, counts) was computed. */
  computedAt: number
  /** True when read from a workspace already open in this process (running agent or the file open in Studio). */
  live: boolean
  handle: string
  name?: string
  did?: string
  agentId?: string
  model?: string
  /** ISO adf_created_at. */
  createdAt?: string
  ageDays: number
  /** adf_meta `status`: the agent's own status line. Absent when unset or blank. */
  status?: string
  /** config.description, the ALF card's `description`. Absent when blank. */
  description?: string
  /** config.serving.public.enabled, the ALF card's `public`. */
  public: boolean
  /**
   * An owner attestation about the agent's current DID is stored, unexpired
   * and its signature verifies (published on the card or not).
   */
  ownerVerified: boolean
  /** Live executors only: last API-reported context size. */
  contextTokens?: number
  contextThreshold?: number
  /** Earliest next_wake_at among non-expired timers (ms epoch). */
  nextWakeAt?: number
  /** USD over the last 7 local days, summed from the priced adf_loop rows (the Activity chart's cost). Absent when no row in the window has a price. */
  cost7dUsd?: number
  /** True when some calls in the window had no recorded price or were compacted (cost7dUsd is then a lower bound). */
  cost7dPartial?: boolean
  /** adf_meta rows keyed `metric:<name>`, by key, at most 20 (parsed by `src/shared/utils/agent-metrics.ts`). Not part of any stat. */
  metrics: AgentMetric[]
  stats: AgentStats
  maturity: AgentExperienceInputs
}

/**
 * One `metric:<name>` adf_meta row. The stored value is a plain string or a
 * JSON object `{value, label?, unit?, min?, max?, target?}`; a plain string
 * (or anything not such an object) gives `value` = `raw`, `label` = `name`.
 */
export interface AgentMetric {
  /** Key without the `metric:` prefix. */
  name: string
  /** The object's `label`, else `name`. */
  label: string
  value: number | string
  unit?: string
  /** Bar start when `max` is set (0 when absent). */
  min?: number
  max?: number
  target?: number
  /** The stored value as is. */
  raw: string
}

// =============================================================================
// Activity (the overview's lower sections)
// =============================================================================

/** Longest `input` / `prompt` an UpcomingWake carries; longer text is cut and ends in `…`. */
export const UPCOMING_TEXT_MAX = 1000

/**
 * One timer due soon, as raw pieces; the renderer formats the row.
 * system: `lambda` runs with `input` (the timer payload).
 * agent: `loop` wakes with `prompt` (the timer payload).
 */
export interface UpcomingWake {
  id: number
  /** next_wake_at, ms epoch. */
  at: number
  /** 'system' runs a lambda; 'agent' wakes a loop. */
  scope: 'system' | 'agent'
  /** system: lambda reference, e.g. `lib/sync.ts:run`. */
  lambda?: string
  /** system: payload passed to the lambda, as stored (at most UPCOMING_TEXT_MAX chars). */
  input?: string
  /** agent: loop the wake dispatches to (`main` when the row names none). */
  loop?: string
  /** agent: payload the loop wakes with (at most UPCOMING_TEXT_MAX chars). */
  prompt?: string
}

/** One local calendar day of the activity sparkline. */
export interface ActivityDay {
  /** Local `YYYY-MM-DD`. */
  date: string
  /**
   * adf_loop rows (every role: user input, replies, tool calls and results)
   * created that day, plus that day's estimated share of compacted rows
   * archived in adf_audit.
   */
  messages: number
  /** Some of the day's messages are compacted history whose timing is estimated. */
  estimated?: boolean
  /** USD of the day's priced adf_loop rows. Absent when none had a price. */
  costUsd?: number
  /** Some calls that day had no recorded price, or were compacted (costUsd, if present, is a lower bound). */
  costPartial?: boolean
}

/** Memory strata bands, oldest first: the order the Overview strip draws them. */
export const MEMORY_STRATA_BANDS = ['older', 'quarter', 'month', 'week'] as const
export type MemoryStratum = typeof MEMORY_STRATA_BANDS[number]

/**
 * Upper age, in days, of each band but `older`: a file last updated at most
 * this many days ago (inclusive) falls in the youngest band that holds it.
 */
export const MEMORY_STRATA_DAYS = { week: 7, month: 30, quarter: 90 } as const

/** Approximate tokens of `mind/` per age band of the file's updated_at. */
export type MemoryStrata = Record<MemoryStratum, number>

/** One skill's size, from its files under `skills/<name>/`. */
export interface SkillSize {
  name: string
  tokens: number
  files: number
}

/** One `mind/` file: memory tokens (memoryBytes / 4) and its updated_at. */
export interface MemoryFileSize {
  path: string
  tokens: number
  updatedAt: string
}

/** One `local_*` table: row and column counts. */
export interface TableSize {
  name: string
  rows: number
  columns: number
}

/**
 * What the agent's file holds, in three groups. Tokens are approximate
 * (bytes / 4, rounded) and given for mind and skills only: table data is
 * rarely read into context, so its size is not comparable. Each group's
 * `items` lists its members for the Overview's bookshelves; absent from
 * older readers.
 */
export interface AgentContents {
  /**
   * Files under `mind/`: count, SUM(size) / 4, files with updated_at in the
   * last 7 days, and `strata`: the same tokens (less the seeded `mind/log.md`
   * header) split by each file's updated_at into MEMORY_STRATA_DAYS bands.
   * `items`: every file, most recently updated first.
   */
  mind: { files: number; tokens: number; updatedThisWeek: number; strata: MemoryStrata; items?: MemoryFileSize[] }
  /**
   * Skills the agent installed or changed (the Experience stat's rule) and
   * the tokens of every file under those skills' directories. Registry
   * entries without files count but add no tokens. `items`: each of those
   * skills with its own tokens and file count, largest first.
   */
  skills: { count: number; tokens: number; items?: SkillSize[] }
  /**
   * `local_*` tables (at most 50 read) and their total rows. `items`: those
   * tables, most rows first; `unread`: tables past the 50 (not counted).
   */
  tables: { count: number; rows: number; items?: TableSize[]; unread?: number }
}

/** Result of `adf:agent:activity` and `GET /agents/:id/activity`. */
export interface AgentActivity {
  filePath: string
  /** ms epoch this read was computed. */
  computedAt: number
  live: boolean
  /** Next (at most 3) non-expired timers, soonest first. */
  upcoming: UpcomingWake[]
  /** 14 local days, oldest first; the last is today. */
  daily: ActivityDay[]
  contents: AgentContents
}
