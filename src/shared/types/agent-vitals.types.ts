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
  /** Power points this factor adds (uncapped). Negative for mitigations. */
  points: number
  /** True when the capability needs human approval (restricted tool, sealed secret). */
  gated: boolean
  /** Config path (or table) that controls this factor. */
  configPath: string
}

/**
 * Reach / Access / Autonomy. A level on the shared curve in
 * `src/shared/utils/agent-stats.ts` (POWER_CURVE), from uncapped points.
 * Gated points count toward the level; `open` and `gated` say how it splits.
 */
export interface PowerStat {
  /** >= 1. */
  level: number
  /** 0..1 within the current level. */
  progress: number
  /** Points behind the level: `open + gated`, after mitigations, >= 0. */
  points: number
  /** Points whose capability runs without approval (mitigations taken off these first). */
  open: number
  /** Points whose capability needs approval. */
  gated: number
  /** Points at which the current level starts and the next one starts. */
  levelStart: number
  nextLevelAt: number
  /** Level the open points alone would reach. */
  openLevel: number
  /** True when `openLevel >= POWER_HIGH_OPEN_LEVEL`: much of this runs without anyone asking. */
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
  /** USD over the last 7 local days, from the per-agent usage ledger. Absent when the ledger has no rows for this agent. */
  cost7dUsd?: number
  /** True when some calls in the window had no price (cost7dUsd is then a lower bound). */
  cost7dPartial?: boolean
  /** adf_meta rows keyed `metric:<name>`, by key, at most 20. Shown as is; not part of any stat. */
  metrics: AgentMetric[]
  stats: AgentStats
  maturity: AgentExperienceInputs
}

/** One `metric:<name>` adf_meta row. */
export interface AgentMetric {
  /** Key without the `metric:` prefix. */
  name: string
  value: string
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
  /** Finished turns (assistant rows without a tool call) still in adf_loop. */
  turns: number
  /** USD from the per-agent usage ledger. Absent when the ledger has no rows that day. */
  costUsd?: number
  /** Some calls that day had no price (costUsd is a lower bound). */
  costPartial?: boolean
}

/**
 * What the agent's file holds, in three groups. Tokens are approximate
 * (bytes / 4, rounded) and given for mind and skills only: table data is
 * rarely read into context, so its size is not comparable.
 */
export interface AgentContents {
  /** Files under `mind/`: count and SUM(size) / 4. */
  mind: { files: number; tokens: number }
  /**
   * Skills the agent installed or changed (the Experience stat's rule) and
   * the tokens of every file under those skills' directories. Registry
   * entries without files count but add no tokens.
   */
  skills: { count: number; tokens: number }
  /** `local_*` tables (at most 50 read) and their total rows. */
  tables: { count: number; rows: number }
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
  /**
   * True when the per-day scan stopped at its row cap before reaching the
   * window's first day, or compaction removed rows inside the window: the
   * oldest days may read low.
   */
  dailyPartial: boolean
  contents: AgentContents
}
