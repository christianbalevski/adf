/**
 * Agent vitals: the per-agent overview card's data. Header facts (context,
 * next wake, 7-day cost, model, age) plus four stats scored by the pure
 * module in `src/shared/utils/agent-stats.ts`.
 */

import type { MessagingMode, Visibility } from './adf-v02.types'

/** One line of a stat's breakdown popover. */
export interface StatFactor {
  /** Stable id, e.g. `tool:compute_exec`, `mcp:github`, `visibility`. */
  id: string
  /** Plain technical English, shown as is. */
  label: string
  /** Contribution before the 5-segment cap. Negative for mitigations. */
  points: number
  /** True when the capability needs human approval (restricted tool, sealed secret). */
  gated: boolean
  /** Config path (or table) that controls this factor. */
  configPath: string
}

/** Reach / Access / Autonomy: a 5-segment power bar. */
export interface PowerStat {
  /** Filled segments, 0..5. Always `gated + open`. */
  segments: number
  /** Segments whose capability needs approval. */
  gated: number
  /** Segments whose capability runs without approval. */
  open: number
  /** Sum of factor points before the cap (mitigations included). */
  rawPoints: number
  factors: StatFactor[]
}

/** Raw maturity counts read from the agent's file. */
export interface AgentExperienceInputs {
  /** Lifetime adf_loop rows (AUTOINCREMENT high-water mark; compaction and clears do not lower it). */
  loopEntries: number
  /** adf_files rows changed after the agent was created (template starter files excluded). */
  filesWritten: number
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
  /** >= 1. floor(log2(score)). */
  level: number
  /** 0..1 within the current level. */
  progress: number
  /** Total XP (1 + sum of signal XP). */
  score: number
  /** XP at which the current level starts and the next one starts. */
  levelStart: number
  nextLevelAt: number
  breakdown: ExperienceSignal[]
  /** What one more level takes, in units of the cheapest signals. */
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
  stats: AgentStats
  maturity: AgentExperienceInputs
}
