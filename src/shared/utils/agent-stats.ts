/**
 * Agent stat scoring for the overview card. Pure: no IO, no clock reads
 * (callers pass ages in), so every number here is reproducible in a test.
 *
 * Reach, Access and Autonomy are 5-segment power bars. Each capability adds a
 * fixed number of points from the tables below; mitigations add negative
 * points. The total is capped at 5 segments. A factor is `gated` when using it
 * needs human approval (a `restricted` tool, a sealed secret); the bar shows
 * open segments first because those run without anyone asking.
 *
 * Experience is a level derived from what is in the file right now, so it can
 * go down when the agent deletes its own work. See EXPERIENCE_WEIGHTS.
 */

import type { AgentConfig, TimerSchedule } from '../types/adf-v02.types'
import type {
  AgentExperienceInputs,
  AgentPowerInputs,
  AgentStats,
  ExperienceSignal,
  ExperienceStat,
  PowerStat,
  StatFactor
} from '../types/agent-vitals.types'

export const MAX_SEGMENTS = 5

// =============================================================================
// Points tables
// =============================================================================

/**
 * Access: what the agent can do. A default agent (files, sandbox code,
 * sys_fetch, a sealed key) lands at about 2 segments.
 */
export const ACCESS_TOOL_POINTS: Record<string, { points: number; label: string }> = {
  fs_read: { points: 0.25, label: 'Reads its own files' },
  fs_write: { points: 0.25, label: 'Writes its own files' },
  fs_delete: { points: 0.25, label: 'Deletes its own files' },
  sys_code: { points: 0.5, label: 'Runs code in the sandbox' },
  sys_lambda: { points: 0.25, label: 'Runs stored lambdas' },
  sys_fetch: { points: 0.5, label: 'Fetches URLs over HTTP' },
  db_execute: { points: 0.25, label: 'Writes to its database tables' },
  adf_shell: { points: 0.5, label: 'Runs shell commands in its workspace' },
  ws_connect: { points: 0.5, label: 'Opens WebSocket connections' },
  stream_bind: { points: 0.5, label: 'Binds network streams' },
  fs_transfer: { points: 0.5, label: 'Transfers files to other agents' },
  mcp_install: { points: 1, label: 'Installs MCP servers' },
  compute_exec: { points: 1, label: 'Runs commands on compute targets' }
}

export const ACCESS_POINTS = {
  mcpServer: 0.5,
  mcpCredentials: 0.25,
  npmPackage: 0.25,
  npmPackageCap: 1,
  codeNetwork: 1,
  computeEnabled: 0.5,
  hostAccess: 2,
  computeHostTarget: 1.5,
  credential: 0.25,
  credentialCap: 1.5,
  privateKeyPlain: 1,
  privateKeySealed: 0.5
} as const

/**
 * Reach: who can reach the agent and whom it reaches. Inbound points scale
 * with messaging.visibility; a default agent (localhost, proactive) is 2.
 */
export const VISIBILITY_POINTS: Record<string, number> = {
  off: 0,
  directory: 0.5,
  localhost: 1,
  lan: 2,
  public: 3
}

export const REACH_POINTS = {
  sendProactive: 1,
  sendRespondOnly: 0.5,
  publicPage: 2,
  apiRoute: 0.5,
  apiRouteCap: 1.5,
  sharedFiles: 0.5,
  adapter: 1,
  adapterRestrictedDm: 0.5,
  wsConnection: 0.5,
  wsConnectionCap: 1,
  /** Mitigation: messages must be signed. */
  signedOnly: -0.5
} as const

/** Autonomy: how much it does with nobody in the chat. */
export const AUTONOMY_POINTS = {
  autonomous: 1.5,
  autostart: 1,
  timers: 0.5,
  timerFast: 1, // fastest interval <= 5 min
  timerHourly: 0.5, // fastest interval <= 1 h
  trigger: 0.25,
  triggerCap: 1,
  proactive: 0.5,
  createAgents: 1,
  updateConfig: 0.5,
  sideLoop: 0.25,
  sideLoopCap: 0.5,
  /** Mitigation per enabled restricted tool. */
  restrictedTool: -0.25,
  restrictedToolCap: -1
} as const

// =============================================================================
// Power bar arithmetic
// =============================================================================

/** Collapse factors into segments: mitigations eat open points first, total capped at 5. */
export function toPowerStat(factors: StatFactor[]): PowerStat {
  let open = 0
  let gated = 0
  let mitigation = 0
  for (const f of factors) {
    if (f.points < 0) mitigation += f.points
    else if (f.gated) gated += f.points
    else open += f.points
  }
  open += mitigation
  if (open < 0) {
    gated = Math.max(0, gated + open)
    open = 0
  }
  const total = Math.min(MAX_SEGMENTS, open + gated)
  let segments = Math.round(total)
  if (total > 0 && segments === 0) segments = 1
  let openSeg = Math.min(segments, Math.round(Math.min(open, MAX_SEGMENTS)))
  if (open > 0 && openSeg === 0) openSeg = Math.min(segments, 1)
  const rawPoints = factors.reduce((s, f) => s + f.points, 0)
  return { segments, open: openSeg, gated: segments - openSeg, rawPoints, factors }
}

function toolMap(inputs: AgentPowerInputs): Map<string, { restricted: boolean }> {
  const map = new Map<string, { restricted: boolean }>()
  for (const t of inputs.tools) if (t.enabled) map.set(t.name, { restricted: !!t.restricted })
  return map
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

function formatInterval(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`
  return `${Math.round(ms / 3_600_000)} h`
}

// =============================================================================
// Access
// =============================================================================

export function scoreAccess(inputs: AgentPowerInputs): PowerStat {
  const tools = toolMap(inputs)
  const factors: StatFactor[] = []

  for (const [name, def] of Object.entries(ACCESS_TOOL_POINTS)) {
    const t = tools.get(name)
    if (!t) continue
    factors.push({
      id: `tool:${name}`,
      label: t.restricted ? `${def.label} (needs approval)` : def.label,
      points: def.points,
      gated: t.restricted,
      configPath: `tools.${name}`
    })
  }

  const exec = tools.get('compute_exec')
  if (exec && inputs.compute.allowedTargets.includes('host')) {
    factors.push({
      id: 'compute:host_target',
      label: 'compute_exec may run on the host machine',
      points: ACCESS_POINTS.computeHostTarget,
      gated: exec.restricted,
      configPath: 'compute.allowed_targets'
    })
  }
  if (inputs.compute.enabled) {
    factors.push({
      id: 'compute:enabled',
      label: 'Has its own compute container',
      points: ACCESS_POINTS.computeEnabled,
      gated: false,
      configPath: 'compute.enabled'
    })
  }
  if (inputs.compute.hostAccess) {
    factors.push({
      id: 'compute:host_access',
      label: 'May run MCP servers on the host machine',
      points: ACCESS_POINTS.hostAccess,
      gated: false,
      configPath: 'compute.host_access'
    })
  }
  if (inputs.codeNetwork) {
    factors.push({
      id: 'code:network',
      label: 'Sandbox code has direct network access',
      points: ACCESS_POINTS.codeNetwork,
      gated: false,
      configPath: 'code_execution.network'
    })
  }
  if (inputs.npmPackageCount > 0) {
    factors.push({
      id: 'code:packages',
      label: `${plural(inputs.npmPackageCount, 'npm package')} installed`,
      points: Math.min(ACCESS_POINTS.npmPackageCap, inputs.npmPackageCount * ACCESS_POINTS.npmPackage),
      gated: false,
      configPath: 'code_execution.packages'
    })
  }
  for (const s of inputs.mcpServers) {
    factors.push({
      id: `mcp:${s.name}`,
      label: s.restricted ? `MCP server ${s.name} (tools need approval)` : `MCP server ${s.name}`,
      points: ACCESS_POINTS.mcpServer,
      gated: s.restricted,
      configPath: 'mcp.servers'
    })
    if (s.hasCredentials) {
      factors.push({
        id: `mcp:${s.name}:credentials`,
        label: `MCP server ${s.name} holds credentials`,
        points: ACCESS_POINTS.mcpCredentials,
        gated: s.restricted,
        configPath: 'mcp.servers'
      })
    }
  }

  // Credentials share one cap; plain rows claim it first.
  let credBudget: number = ACCESS_POINTS.credentialCap
  const credPoints = (n: number): number => {
    const p = Math.min(credBudget, n * ACCESS_POINTS.credential)
    credBudget -= p
    return p
  }
  if (inputs.credentials.plain > 0) {
    factors.push({
      id: 'identity:credentials_plain',
      label: `${plural(inputs.credentials.plain, 'stored credential')}, unsealed`,
      points: credPoints(inputs.credentials.plain),
      gated: false,
      configPath: 'adf_identity'
    })
  }
  if (inputs.credentials.sealed > 0) {
    factors.push({
      id: 'identity:credentials_sealed',
      label: `${plural(inputs.credentials.sealed, 'stored credential')}, sealed`,
      points: credPoints(inputs.credentials.sealed),
      gated: true,
      configPath: 'adf_identity'
    })
  }
  if (inputs.privateKey === 'plain') {
    factors.push({
      id: 'identity:private_key',
      label: 'Signing key stored unsealed',
      points: ACCESS_POINTS.privateKeyPlain,
      gated: false,
      configPath: 'adf_identity.crypto:signing:private_key'
    })
  } else if (inputs.privateKey === 'sealed') {
    factors.push({
      id: 'identity:private_key',
      label: 'Signing key (sealed)',
      points: ACCESS_POINTS.privateKeySealed,
      gated: true,
      configPath: 'adf_identity.crypto:signing:private_key'
    })
  }

  return toPowerStat(factors)
}

// =============================================================================
// Reach
// =============================================================================

export function scoreReach(inputs: AgentPowerInputs): PowerStat {
  const tools = toolMap(inputs)
  const factors: StatFactor[] = []
  const m = inputs.messaging

  const inbound = m.receive ? VISIBILITY_POINTS[m.visibility] ?? 0 : 0
  if (inbound > 0) {
    factors.push({
      id: 'messaging:visibility',
      label: `Receives messages from ${m.visibility === 'directory' ? 'agents in its directory' : `the ${m.visibility} tier`}`,
      points: inbound,
      gated: false,
      configPath: 'messaging.visibility'
    })
    if (m.allowListCount > 0) {
      factors.push({
        id: 'messaging:allow_list',
        label: `Inbox limited to ${plural(m.allowListCount, 'allowed sender')}`,
        points: -inbound / 2,
        gated: false,
        configPath: 'messaging.allow_list'
      })
    }
    if (!inputs.security.allowUnsigned || inputs.security.requireSignature) {
      factors.push({
        id: 'security:signed_only',
        label: 'Only accepts signed messages',
        points: REACH_POINTS.signedOnly,
        gated: false,
        configPath: inputs.security.requireSignature ? 'security.require_signature' : 'security.allow_unsigned'
      })
    }
  }

  const send = tools.get('msg_send')
  if (send && m.mode !== 'listen_only') {
    const proactive = m.mode === 'proactive'
    factors.push({
      id: 'messaging:send',
      label: proactive ? 'Sends messages on its own' : 'Replies to messages it receives',
      points: proactive ? REACH_POINTS.sendProactive : REACH_POINTS.sendRespondOnly,
      gated: send.restricted,
      configPath: 'messaging.mode'
    })
  }

  if (inputs.serving.publicEnabled) {
    factors.push({
      id: 'serving:public',
      label: 'Serves a public web page',
      points: REACH_POINTS.publicPage,
      gated: false,
      configPath: 'serving.public.enabled'
    })
  }
  if (inputs.serving.apiRouteCount > 0) {
    factors.push({
      id: 'serving:api',
      label: `${plural(inputs.serving.apiRouteCount, 'HTTP API route')}`,
      points: Math.min(REACH_POINTS.apiRouteCap, inputs.serving.apiRouteCount * REACH_POINTS.apiRoute),
      gated: false,
      configPath: 'serving.api'
    })
  }
  if (inputs.serving.sharedEnabled) {
    factors.push({
      id: 'serving:shared',
      label: 'Shares files with peers',
      points: REACH_POINTS.sharedFiles,
      gated: false,
      configPath: 'serving.shared.enabled'
    })
  }
  for (const a of inputs.adapters) {
    factors.push({
      id: `adapter:${a.type}`,
      label: a.restrictedDm ? `${a.type} adapter (DMs restricted)` : `${a.type} adapter`,
      points: a.restrictedDm ? REACH_POINTS.adapterRestrictedDm : REACH_POINTS.adapter,
      gated: false,
      configPath: `adapters.${a.type}`
    })
  }
  if (inputs.wsConnectionCount > 0) {
    factors.push({
      id: 'ws_connections',
      label: `${plural(inputs.wsConnectionCount, 'standing WebSocket connection')}`,
      points: Math.min(REACH_POINTS.wsConnectionCap, inputs.wsConnectionCount * REACH_POINTS.wsConnection),
      gated: false,
      configPath: 'ws_connections'
    })
  }

  return toPowerStat(factors)
}

// =============================================================================
// Autonomy
// =============================================================================

export function scoreAutonomy(inputs: AgentPowerInputs): PowerStat {
  const tools = toolMap(inputs)
  const factors: StatFactor[] = []

  if (inputs.autonomous) {
    factors.push({ id: 'autonomous', label: 'Acts without waiting for a human', points: AUTONOMY_POINTS.autonomous, gated: false, configPath: 'autonomous' })
  }
  if (inputs.autostart) {
    factors.push({ id: 'autostart', label: 'Starts when the runtime starts', points: AUTONOMY_POINTS.autostart, gated: false, configPath: 'autostart' })
  }
  if (inputs.timers.active > 0) {
    factors.push({ id: 'timers', label: `${plural(inputs.timers.active, 'active timer')}`, points: AUTONOMY_POINTS.timers, gated: false, configPath: 'adf_timers' })
    const fastest = inputs.timers.fastestIntervalMs
    if (fastest !== undefined && fastest <= 3_600_000) {
      factors.push({
        id: 'timers:fastest',
        label: `Wakes every ${formatInterval(fastest)}`,
        points: fastest <= 300_000 ? AUTONOMY_POINTS.timerFast : AUTONOMY_POINTS.timerHourly,
        gated: false,
        configPath: 'adf_timers'
      })
    }
  }
  const triggerTargets = inputs.triggers.reduce((s, t) => s + t.targets, 0)
  if (triggerTargets > 0) {
    factors.push({
      id: 'triggers',
      label: `Wakes on ${plural(inputs.triggers.length, 'event type')} (${inputs.triggers.map((t) => t.type).join(', ')})`,
      points: Math.min(AUTONOMY_POINTS.triggerCap, triggerTargets * AUTONOMY_POINTS.trigger),
      gated: false,
      configPath: 'triggers'
    })
  }
  const send = tools.get('msg_send')
  if (send && inputs.messaging.mode === 'proactive') {
    factors.push({ id: 'messaging:proactive', label: 'Starts conversations', points: AUTONOMY_POINTS.proactive, gated: send.restricted, configPath: 'messaging.mode' })
  }
  const spawn = tools.get('sys_create_adf')
  if (spawn) {
    factors.push({ id: 'tool:sys_create_adf', label: spawn.restricted ? 'Creates new agents (needs approval)' : 'Creates new agents', points: AUTONOMY_POINTS.createAgents, gated: spawn.restricted, configPath: 'tools.sys_create_adf' })
  }
  const update = tools.get('sys_update_config')
  if (update) {
    factors.push({ id: 'tool:sys_update_config', label: update.restricted ? 'Changes its own config (needs approval)' : 'Changes its own config', points: AUTONOMY_POINTS.updateConfig, gated: update.restricted, configPath: 'tools.sys_update_config' })
  }
  if (inputs.sideLoopCount > 0) {
    factors.push({
      id: 'loops',
      label: `${plural(inputs.sideLoopCount, 'inner loop')}`,
      points: Math.min(AUTONOMY_POINTS.sideLoopCap, inputs.sideLoopCount * AUTONOMY_POINTS.sideLoop),
      gated: false,
      configPath: 'loops'
    })
  }
  const restricted = [...tools.values()].filter((t) => t.restricted).length
  if (restricted > 0) {
    factors.push({
      id: 'tools:restricted',
      label: `${plural(restricted, 'tool')} need${restricted === 1 ? 's' : ''} approval`,
      points: Math.max(AUTONOMY_POINTS.restrictedToolCap, restricted * AUTONOMY_POINTS.restrictedTool),
      gated: false,
      configPath: 'tools[].restricted'
    })
  }

  return toPowerStat(factors)
}

// =============================================================================
// Experience
// =============================================================================

/**
 * XP per unit. score = 1 + sum(signal XP); level = floor(log2(score)), at
 * least 1. Doubling the XP buys one level, so the log is applied once, at
 * the level, and the signals stay linear (local rows are square-rooted so a
 * bulk import cannot buy levels).
 *
 * Calibration (see tests):
 *   brand-new agent (no loop rows, template files only)      score 1      Lv 1
 *   first session (~60 loop rows, 3 files)                   score ~10    Lv 3
 *   heavy, months old (~30k rows, 200 files, 10 skills,
 *     8 tables / 20k rows, 150 compactions, 3 children)     score ~4000  Lv 11-12
 */
export const EXPERIENCE_WEIGHTS = {
  /** Per lifetime loop row (a turn is usually several rows). */
  loopEntries: 0.1,
  /** Per file written or changed after creation. */
  filesWritten: 1,
  /** Per skill installed or changed. Worth more than plain files. */
  skills: 8,
  /** Per `local_*` table. */
  localTables: 4,
  /** Multiplied by sqrt(total local rows). */
  localRowsSqrt: 2,
  /** Per loop compaction. */
  compactions: 3,
  /** Per child agent. */
  agentsSpawned: 15,
  /** Per day of age, scaled by activity = min(1, loopEntries / 1000) so an idle file does not level up by waiting. */
  ageDays: 0.5,
  ageActivityRows: 1000
} as const

const EXPERIENCE_LABELS: Record<keyof AgentExperienceInputs, string> = {
  loopEntries: 'Loop messages',
  filesWritten: 'Files written',
  skills: 'Skills',
  localTables: 'Database tables',
  localRows: 'Database rows',
  compactions: 'Compactions',
  agentsSpawned: 'Agents created',
  ageDays: 'Days active'
}

export function experienceSignals(inputs: AgentExperienceInputs): ExperienceSignal[] {
  const w = EXPERIENCE_WEIGHTS
  const n = (v: number | null | undefined): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
  const activity = Math.min(1, n(inputs.loopEntries) / w.ageActivityRows)
  const signals: ExperienceSignal[] = [
    { id: 'loopEntries', label: EXPERIENCE_LABELS.loopEntries, value: n(inputs.loopEntries), xp: n(inputs.loopEntries) * w.loopEntries },
    { id: 'filesWritten', label: EXPERIENCE_LABELS.filesWritten, value: n(inputs.filesWritten), xp: n(inputs.filesWritten) * w.filesWritten },
    { id: 'skills', label: EXPERIENCE_LABELS.skills, value: n(inputs.skills), xp: n(inputs.skills) * w.skills },
    { id: 'localTables', label: EXPERIENCE_LABELS.localTables, value: n(inputs.localTables), xp: n(inputs.localTables) * w.localTables },
    { id: 'localRows', label: EXPERIENCE_LABELS.localRows, value: n(inputs.localRows), xp: Math.sqrt(n(inputs.localRows)) * w.localRowsSqrt },
    { id: 'compactions', label: EXPERIENCE_LABELS.compactions, value: n(inputs.compactions), xp: n(inputs.compactions) * w.compactions }
  ]
  if (inputs.agentsSpawned !== null) {
    signals.push({ id: 'agentsSpawned', label: EXPERIENCE_LABELS.agentsSpawned, value: n(inputs.agentsSpawned), xp: n(inputs.agentsSpawned) * w.agentsSpawned })
  }
  signals.push({ id: 'ageDays', label: EXPERIENCE_LABELS.ageDays, value: Math.floor(n(inputs.ageDays)), xp: n(inputs.ageDays) * w.ageDays * activity })
  return signals
}

export function scoreExperience(inputs: AgentExperienceInputs): ExperienceStat {
  const breakdown = experienceSignals(inputs)
  const score = 1 + breakdown.reduce((s, b) => s + b.xp, 0)
  const raw = Math.floor(Math.log2(score))
  const level = Math.max(1, raw)
  // Level 1 also covers the clamped range [1, 2), so it spans [1, 4).
  const levelStart = level === 1 ? 1 : 2 ** level
  const nextLevelAt = 2 ** (level + 1)
  const progress = Math.min(1, Math.max(0, (score - levelStart) / (nextLevelAt - levelStart)))
  const xp = Math.max(0, nextLevelAt - score)
  const w = EXPERIENCE_WEIGHTS
  const loopEntries = Math.ceil(xp / w.loopEntries)
  const files = Math.ceil(xp / w.filesWritten)
  const skills = Math.ceil(xp / w.skills)
  return {
    level,
    progress,
    score,
    levelStart,
    nextLevelAt,
    breakdown,
    nextLevel: {
      xp,
      loopEntries,
      files,
      skills,
      hint: `Level ${level + 1} needs ${Math.ceil(xp)} more XP: about ${plural(loopEntries, 'loop message')}, ${plural(files, 'file')} or ${plural(skills, 'skill')}`
    }
  }
}

// =============================================================================
// Config → inputs
// =============================================================================

/** Shortest repeat interval of a schedule, when it has one. Cron is read only in its `*\/N` minute form. */
export function scheduleIntervalMs(schedule: TimerSchedule | null | undefined): number | undefined {
  if (!schedule) return undefined
  if (schedule.mode === 'interval') return schedule.every_ms > 0 ? schedule.every_ms : undefined
  if (schedule.mode === 'cron') {
    const minute = schedule.cron.trim().split(/\s+/)[0] ?? ''
    if (minute === '*') return 60_000
    const step = /^\*\/(\d+)$/.exec(minute)
    if (step) return Number(step[1]) * 60_000
    return undefined
  }
  return undefined
}

export interface PowerTableInputs {
  credentials: { plain: number; sealed: number }
  privateKey: 'none' | 'sealed' | 'plain'
  timers: { active: number; fastestIntervalMs?: number }
}

/** Plain inputs from a parsed config plus the table-derived parts. Tolerates partial configs. */
export function powerInputsFromConfig(config: Partial<AgentConfig>, tables: PowerTableInputs): AgentPowerInputs {
  const triggers: AgentPowerInputs['triggers'] = []
  for (const [type, t] of Object.entries(config.triggers ?? {})) {
    if (type === 'on_chat' || !t?.enabled) continue
    const targets = Array.isArray(t.targets) ? t.targets.length : 0
    if (targets > 0) triggers.push({ type, targets })
  }
  const mcpServers = (config.mcp?.servers ?? []).map((s) => ({
    name: s.name,
    restricted: !!s.restricted,
    hasCredentials: !!(
      s.oauth ||
      s.bearer_token_env_var ||
      (s.env_keys && s.env_keys.length > 0) ||
      (s.env_schema && s.env_schema.length > 0) ||
      (s.header_env && s.header_env.length > 0) ||
      (s.credential_files && s.credential_files.length > 0)
    )
  }))
  const adapters = Object.entries(config.adapters ?? {})
    .filter(([, a]) => a?.enabled)
    .map(([type, a]) => ({ type, restrictedDm: a.policy?.dm === 'allowlist' || a.policy?.dm === 'none' }))
  const allowedTargets = [...(config.compute?.allowed_targets ?? [])]
  if (config.compute?.target && !allowedTargets.includes(config.compute.target)) allowedTargets.push(config.compute.target)

  return {
    tools: (config.tools ?? []).map((t) => ({ name: t.name, enabled: !!t.enabled, restricted: !!t.restricted })),
    autonomous: !!config.autonomous,
    autostart: !!config.autostart,
    messaging: {
      receive: config.messaging?.receive ?? false,
      mode: config.messaging?.mode ?? 'proactive',
      visibility: config.messaging?.visibility ?? 'localhost',
      allowListCount: config.messaging?.allow_list?.length ?? 0
    },
    security: {
      allowUnsigned: config.security?.allow_unsigned ?? true,
      requireSignature: !!config.security?.require_signature
    },
    serving: {
      publicEnabled: !!config.serving?.public?.enabled,
      apiRouteCount: config.serving?.api?.length ?? 0,
      sharedEnabled: !!config.serving?.shared?.enabled
    },
    adapters,
    wsConnectionCount: (config.ws_connections ?? []).filter((c) => c?.enabled).length,
    mcpServers,
    npmPackageCount: config.code_execution?.packages?.length ?? 0,
    codeNetwork: !!config.code_execution?.network,
    compute: {
      enabled: !!config.compute?.enabled,
      hostAccess: !!config.compute?.host_access,
      allowedTargets
    },
    triggers,
    sideLoopCount: config.loops?.length ?? 0,
    credentials: tables.credentials,
    privateKey: tables.privateKey,
    timers: tables.timers
  }
}

export function scoreAgent(power: AgentPowerInputs, experience: AgentExperienceInputs): AgentStats {
  return {
    reach: scoreReach(power),
    access: scoreAccess(power),
    autonomy: scoreAutonomy(power),
    experience: scoreExperience(experience)
  }
}
