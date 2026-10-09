/**
 * Pure helpers for the agent overview panel: power-bar segments, tooltip
 * one-liners, the facts line, level-up decisions and where a stat factor's
 * config lives. No React, no IO; unit-tested in
 * tests/unit/renderer/agent-overview-model.test.ts.
 */

import type { AgentState } from '../../../../shared/types/ipc.types'
import type { ExperienceStat, PowerStat } from '../../../../shared/types/agent-vitals.types'

export const POWER_SEGMENTS = 5

/**
 * One drawn segment. `open` = solid ink, `open-high` = open at position 4 or
 * 5 (warn colour), `gated` = outlined (needs approval), `empty` = track.
 */
export type SegmentKind = 'open' | 'open-high' | 'gated' | 'empty'

/** Open segments fill first, then gated; the rest stay empty. */
export function powerSegments(stat: Pick<PowerStat, 'open' | 'gated'>): SegmentKind[] {
  const open = clampInt(stat.open, 0, POWER_SEGMENTS)
  const gated = clampInt(stat.gated, 0, POWER_SEGMENTS - open)
  const out: SegmentKind[] = []
  for (let i = 0; i < POWER_SEGMENTS; i++) {
    if (i < open) out.push(i >= 3 ? 'open-high' : 'open')
    else if (i < open + gated) out.push('gated')
    else out.push('empty')
  }
  return out
}

function clampInt(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo
  return Math.max(lo, Math.min(hi, Math.round(n)))
}

/** 950 → "950", 1234 → "1.2k", 12_345 → "12k", 1_500_000 → "1.5M". */
export function compactCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0'
  if (n < 1000) return String(Math.round(n))
  if (n < 10_000) return `${trimZero((n / 1000).toFixed(1))}k`
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  if (n < 10_000_000) return `${trimZero((n / 1_000_000).toFixed(1))}M`
  return `${Math.round(n / 1_000_000)}M`
}

function trimZero(s: string): string {
  return s.endsWith('.0') ? s.slice(0, -2) : s
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n === 1 ? '1' : compactCount(n)} ${n === 1 ? one : many}`
}

function lowerFirst(s: string): string {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s
}

/** "4 of 5, 3 gated · serves a public web page, 3 HTTP API routes" */
export function powerTooltip(stat: PowerStat, maxFactors = 2): string {
  const head = stat.gated > 0
    ? `${stat.segments} of ${POWER_SEGMENTS}, ${stat.gated} gated`
    : `${stat.segments} of ${POWER_SEGMENTS}`
  const top = stat.factors
    .filter((f) => f.points > 0)
    .slice()
    .sort((a, b) => b.points - a.points)
    .slice(0, maxFactors)
    // Parentheticals (event lists, "needs approval") belong in the popover.
    .map((f) => lowerFirst(f.label.replace(/\s*\([^)]*\)\s*$/, '')))
  return top.length ? `${head} · ${top.join(', ')}` : head
}

/** "1.2k loop messages · 18 files · 3 skills · next level in 40 XP" */
export function experienceTooltip(exp: ExperienceStat): string {
  const value = (id: string): number => exp.breakdown.find((b) => b.id === id)?.value ?? 0
  const parts: string[] = []
  const loops = value('loopEntries')
  const files = value('filesWritten')
  const skills = value('skills')
  if (loops > 0) parts.push(plural(loops, 'loop message'))
  if (files > 0) parts.push(plural(files, 'file'))
  if (skills > 0) parts.push(plural(skills, 'skill'))
  parts.push(`next level in ${compactCount(Math.ceil(exp.nextLevel.xp))} XP`)
  return parts.join(' · ')
}

/** Signed points for the popover: "+1", "+0.5", "-0.25". */
export function formatPoints(points: number): string {
  const r = Math.round(points * 100) / 100
  return r > 0 ? `+${r}` : String(r)
}

// =============================================================================
// Facts line
// =============================================================================

export function formatCost(usd: number): string {
  if (usd < 0.01) return '<$0.01'
  if (usd < 100) return `$${usd.toFixed(2)}`
  return `$${Math.round(usd).toLocaleString('en-US')}`
}

export function formatAge(ageDays: number): string {
  const d = Math.floor(ageDays)
  if (d < 1) return 'created today'
  return `${plural(d, 'day')} old`
}

export function formatWake(nextWakeAt: number, now: number): string {
  const ms = nextWakeAt - now
  if (ms <= 0) return 'wake due'
  const min = Math.round(ms / 60_000)
  if (min < 1) return 'wakes in under a minute'
  if (min < 60) return `wakes in ${min} min`
  const h = Math.round(ms / 3_600_000)
  if (h < 48) return `wakes in ${h} h`
  return `wakes in ${Math.round(ms / 86_400_000)} days`
}

export interface FactsInput {
  cost7dUsd?: number
  createdAt?: string
  ageDays: number
  nextWakeAt?: number
}

export interface Fact {
  id: 'cost' | 'age' | 'wake'
  text: string
}

/** Known, non-zero facts in display order. */
export function overviewFacts(v: FactsInput, now: number): Fact[] {
  const out: Fact[] = []
  if (typeof v.cost7dUsd === 'number' && v.cost7dUsd > 0) out.push({ id: 'cost', text: `${formatCost(v.cost7dUsd)} / 7d` })
  if (v.createdAt && Number.isFinite(v.ageDays)) out.push({ id: 'age', text: formatAge(v.ageDays) })
  if (typeof v.nextWakeAt === 'number' && Number.isFinite(v.nextWakeAt)) out.push({ id: 'wake', text: formatWake(v.nextWakeAt, now) })
  return out
}

// =============================================================================
// Header
// =============================================================================

/** "did:key:z6MkhaXg…Y9fQ" → "did:key:z6Mk…Y9fQ". */
export function shortDid(did: string): string {
  const cut = did.lastIndexOf(':')
  const prefix = did.slice(0, cut + 1)
  const id = did.slice(cut + 1)
  if (id.length <= 10) return did
  return `${prefix}${id.slice(0, 4)}…${id.slice(-4)}`
}

export function agentStatusLabel(
  state: AgentState | null | undefined,
  opts: { starting?: boolean; waiting?: boolean; toolName?: string | null } = {}
): string {
  if (opts.starting) return 'Starting'
  switch (state) {
    case 'active':
      if (opts.waiting) return 'Waiting for approval'
      return opts.toolName ? `Running ${opts.toolName}` : 'Thinking'
    case 'idle':
      return 'Idle'
    case 'hibernate':
      return 'Hibernating'
    case 'suspended':
      return 'Suspended'
    case 'error':
      return 'Error'
    default:
      return 'Stopped'
  }
}

// =============================================================================
// Level up
// =============================================================================

export const LEVELS_STORAGE_KEY = 'adf-agent-levels'

/**
 * Pulse only when the level rose past what Studio last saw for this DID.
 * First sight stores the level without pulsing. A lower level never lowers
 * the stored one, so climbing back does not pulse again.
 */
export function decideLevelUp(stored: number | undefined, level: number): { pulse: boolean; store: number } {
  if (stored === undefined || !Number.isFinite(stored)) return { pulse: false, store: level }
  if (level > stored) return { pulse: true, store: level }
  return { pulse: false, store: stored }
}

export function parseStoredLevels(raw: string | null): Record<string, number> {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

// =============================================================================
// Config targets
// =============================================================================

export interface ConfigTarget {
  subTab: 'config' | 'identity' | 'timers'
  /** AgentConfig section title to open and scroll to. */
  section?: string
}

/** Where the setting behind a stat factor's `configPath` is edited. */
export function configTargetFor(configPath: string): ConfigTarget {
  const p = configPath
  const head = p.split(/[.[]/, 1)[0]
  if (head === 'adf_identity') return { subTab: 'identity' }
  if (head === 'adf_timers') return { subTab: 'timers' }
  const section: Record<string, string> = {
    tools: 'Tools',
    compute: 'Compute',
    code_execution: 'Code Execution',
    mcp: 'MCP Servers',
    messaging: 'Messaging',
    security: 'Security',
    serving: 'Serving',
    adapters: 'Channels',
    ws_connections: 'WebSocket Connections',
    triggers: 'Triggers',
    loops: 'Loops',
    autonomous: 'Identity',
    autostart: 'Identity',
    model: 'Model'
  }
  return section[head] ? { subTab: 'config', section: section[head] } : { subTab: 'config' }
}
