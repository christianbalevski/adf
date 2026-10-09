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
  /** Lifetime adf_loop rows (AUTOINCREMENT high-water mark; compaction and clears do not lower it). */
  loopEntries: number
  /** adf_files rows changed after the agent was created (template starter files and `mind/` excluded). */
  filesWritten: number
  /** Approximate tokens in `mind/` files: SUM(size) / 4, rounded. */
  memoryTokens: number
  /** `local_*` tables. */
  localTables: number
  /** Total rows across `local_*` tables. */
  localRows: number
  /** Distinct skills the agent installed or changed. */
  skills: number
  /** Loop compactions (archived loop snapshots in adf_audit, or the live summary row when loop audit is off). */
  compactions: number
  /** Tracked agents whose adf_parent_did names this agent. null when not known yet. */
  agentsSpawned: number | null
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
  nextLevel: { xp: number; loopEntries: number; files: number; skills: number; hint: string }
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

/** One timer due soon. */
export interface UpcomingWake {
  id: number
  /** next_wake_at, ms epoch. */
  at: number
  /** 'system' runs a lambda; 'agent' wakes a loop. */
  scope: 'system' | 'agent'
  /** Payload, else lambda, else the schedule kind. At most 80 chars. */
  label: string
}

export type ActivityEventKind = 'turn' | 'tool' | 'message_in' | 'message_out' | 'file' | 'error'

/** One line of "Recent activity". */
export interface ActivityEvent {
  kind: ActivityEventKind
  /** ms epoch (the latest of a group). */
  at: number
  /**
   * tool: the tool name. message_in / message_out: the other party.
   * file: the path. error: a short message. turn: the loop name.
   */
  label: string
  /** Consecutive same-tool calls folded into this line (tool only, >= 2). */
  count?: number
  /** adf_loop seq for loop-derived events. */
  seq?: number
  /** Loop the event came from (loop-derived events). */
  loop?: string
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

export interface KnowledgeTable {
  name: string
  rows: number
}

export interface KnowledgeFile {
  path: string
  /** ISO updated_at. */
  updatedAt: string
  size: number
}

/** Result of `adf:agent:activity` and `GET /agents/:id/activity`. */
export interface AgentActivity {
  filePath: string
  /** ms epoch this read was computed. */
  computedAt: number
  live: boolean
  /** Next (at most 3) non-expired timers, soonest first. */
  upcoming: UpcomingWake[]
  /** Most recent first, at most 8, consecutive same-tool calls grouped. */
  recent: ActivityEvent[]
  /** 14 local days, oldest first; the last is today. */
  daily: ActivityDay[]
  /**
   * True when the per-day scan stopped at its row cap before reaching the
   * window's first day, or compaction removed rows inside the window: the
   * oldest days may read low.
   */
  dailyPartial: boolean
  knowledge: {
    /** Skills the agent installed or changed (starter skills excluded), by name. At most 50. */
    skills: string[]
    /** `local_*` tables with row counts, by name. At most 50. */
    tables: KnowledgeTable[]
    /** Files the agent wrote, newest first (starter files and skills-registry.json excluded). At most 20. */
    files: KnowledgeFile[]
    /** All files the agent wrote (the same rule), for "N more". */
    filesTotal: number
  }
}
