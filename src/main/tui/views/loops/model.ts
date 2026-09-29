// Pure logic for the loops manager: names, tool sets, templates, schedules,
// timer/trigger targeting and diffs. No React, no daemon calls — unit-tested
// directly (tests/tui/loops/model.test.ts).

import * as cronParserNs from 'cron-parser'
import { cjs } from '../../interop'
import { MAIN_LOOP } from '../../api/types'
import type { AgentConfig, LoopConfig, LoopEntry, LoopPatch, Timer, TimerInput } from '../../api/types'
import type {
  DEFAULT_NEW_LOOP_TOOLS as SharedDefaultTools,
  LOOP_PROHIBITED_TOOLS as SharedProhibitedTools,
  TriggerConfig,
  TriggerTarget,
  TriggersConfigV3,
  TriggerTypeV3,
} from '../../../../shared/types/adf-v02.types'

const { CronExpressionParser } = cjs(cronParserNs)

// Mirrors of shared constants. The `typeof` annotations make tsc fail if the
// shared tuples change, so these cannot drift silently.
export const DEFAULT_NEW_LOOP_TOOLS: typeof SharedDefaultTools = ['loop_send', 'loop_list', 'sys_set_state']
export const LOOP_PROHIBITED_TOOLS: typeof SharedProhibitedTools = ['sys_update_config', 'loop_manage', 'sys_create_adf']
/** Same rule as adf-schema LOOP_NAME_PATTERN. */
export const LOOP_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/
export const LOOP_GOAL_MAX_CHARS = 4000
export const TRIGGER_TYPES: readonly TriggerTypeV3[] = [
  'on_startup', 'on_inbox', 'on_outbox', 'on_file_change', 'on_chat',
  'on_timer', 'on_tool_call', 'on_task_create', 'on_task_complete', 'on_logs',
  'on_llm_call',
]

export type { TriggerConfig, TriggerTarget, TriggersConfigV3, TriggerTypeV3 }

// --- names --------------------------------------------------------------------

export function validateLoopName(name: string, existing: string[] = []): string | null {
  if (!name) return 'Name is required'
  if (name === MAIN_LOOP) return '"main" is the implicit host loop'
  if (!LOOP_NAME_PATTERN.test(name)) return '1-32 chars: lowercase letters, digits, _ or -, starting with a letter or digit'
  if (existing.includes(name)) return `A loop named "${name}" already exists`
  return null
}

export function validateGoal(goal: string): string | null {
  if (!goal.trim()) return 'Goal is required: it becomes the loop\'s whole system instruction'
  if (goal.length > LOOP_GOAL_MAX_CHARS) return `Goal is ${goal.length} chars; the limit is ${LOOP_GOAL_MAX_CHARS}`
  return null
}

// --- tools --------------------------------------------------------------------

/** Tools the host could grant an inner loop (enabled, not restricted, not prohibited). Null when unknown. */
export function hostLoopTools(config: AgentConfig | undefined): string[] | null {
  if (!config || !Array.isArray(config.tools)) return null
  const prohibited = new Set<string>(LOOP_PROHIBITED_TOOLS)
  const out = new Set<string>()
  for (const decl of config.tools) {
    if (decl.enabled && !decl.restricted && !prohibited.has(decl.name)) out.add(decl.name)
  }
  return [...out].sort()
}

export interface ToolOption {
  name: string
  /** Not grantable on this host today (disabled / unknown); kept by name only. */
  unavailable?: boolean
}

/** Checklist options: the host's grantable tools, plus any wanted name the host does not grant (flagged). */
export function toolOptions(host: string[] | null, wanted: string[]): ToolOption[] {
  const base = host ?? [...new Set([...DEFAULT_NEW_LOOP_TOOLS, ...wanted])].sort()
  const set = new Set(base)
  const extra = wanted.filter(name => !set.has(name)).sort().map(name => ({ name, unavailable: true }))
  return [...base.map(name => ({ name, unavailable: host !== null ? false : undefined })), ...extra]
}

/** Default tick-set for a new loop: the shared defaults the host can grant. */
export function defaultTools(host: string[] | null): string[] {
  return DEFAULT_NEW_LOOP_TOOLS.filter(name => !host || host.includes(name))
}

// --- durations / schedules -------------------------------------------------------

const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }

/** "15m", "2h", "1h30m", "90s", "1d", bare number = minutes. */
export function parseDuration(text: string): number | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, '')
  if (!t) return null
  if (/^\d+$/.test(t)) return Number(t) * 60_000
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/g
  let total = 0
  let consumed = 0
  for (const match of t.matchAll(re)) {
    if (match.index !== consumed) return null
    consumed += match[0].length
    total += match[2] === 'ms' ? Number(match[1]) : Number(match[1]) * UNIT_MS[match[2]]
  }
  if (consumed !== t.length || total <= 0) return null
  return Math.round(total)
}

/** 5400000 → "1h30m", 900000 → "15m". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return `${ms}ms`
  const parts: string[] = []
  let rest = ms
  for (const [unit, size] of [['d', 86_400_000], ['h', 3_600_000], ['m', 60_000], ['s', 1000]] as const) {
    if (rest >= size) {
      const n = Math.floor(rest / size)
      parts.push(`${n}${unit}`)
      rest -= n * size
    }
  }
  if (rest > 0) parts.push(`${rest}ms`)
  return parts.join('')
}

export function parseClock(text: string): { h: number; m: number } | null {
  const match = text.trim().match(/^(\d{1,2}):(\d{2})$/)
  if (!match) return null
  const h = Number(match[1])
  const m = Number(match[2])
  if (h > 23 || m > 59) return null
  return { h, m }
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/** "HH:MM" (next occurrence), "YYYY-MM-DD HH:MM" or "+15m" → epoch ms. */
export function parseWhen(text: string, now = Date.now()): number | null {
  const t = text.trim()
  if (t.startsWith('+')) {
    const ms = parseDuration(t.slice(1))
    return ms === null ? null : now + ms
  }
  const clock = parseClock(t)
  if (clock) {
    const d = new Date(now)
    d.setHours(clock.h, clock.m, 0, 0)
    if (d.getTime() <= now) d.setDate(d.getDate() + 1)
    return d.getTime()
  }
  const full = t.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/)
  if (full) {
    const d = new Date(Number(full[1]), Number(full[2]) - 1, Number(full[3]), Number(full[4]), Number(full[5]), 0, 0)
    return Number.isNaN(d.getTime()) ? null : d.getTime()
  }
  return null
}

/** "14:30", "tomorrow 09:00", "Mon 3 Oct 09:00" relative to `now` (local time). */
export function formatWhen(at: number, now = Date.now()): string {
  const d = new Date(at)
  const clock = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diffDays = Math.round((day(d) - day(new Date(now))) / 86_400_000)
  if (diffDays === 0) return clock
  if (diffDays === 1) return `tomorrow ${clock}`
  if (diffDays === -1) return `yesterday ${clock}`
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${clock}`
}

/** "in 15m", "3h ago". */
export function formatRelative(at: number, now = Date.now()): string {
  const delta = at - now
  const abs = Math.abs(delta)
  const text = abs < 60_000 ? `${Math.max(1, Math.round(abs / 1000))}s` : formatDuration(Math.round(abs / 60_000) * 60_000).replace(/^(\d+[dh])\d+m$/, '$1')
  return delta >= 0 ? `in ${text}` : `${text} ago`
}

export type ScheduleKind = 'none' | 'every' | 'daily' | 'cron' | 'in' | 'at'

export const SCHEDULE_KINDS: ScheduleKind[] = ['none', 'every', 'daily', 'cron', 'in', 'at']

export const SCHEDULE_KIND_LABEL: Record<ScheduleKind, string> = {
  none: 'none (on demand)',
  every: 'every N (interval)',
  daily: 'daily at HH:MM',
  cron: 'cron expression',
  in: 'once, after a delay',
  at: 'once, at a time',
}

/** What the user typed for a schedule. `value` is interpreted per kind. */
export interface ScheduleDraft {
  kind: ScheduleKind
  /** every/in: duration ("15m"); daily: "HH:MM"; cron: expression; at: "HH:MM" | "YYYY-MM-DD HH:MM". */
  value: string
  payload: string
  /** Optional run cap for recurring schedules. */
  maxRuns?: string
}

export const EMPTY_SCHEDULE: ScheduleDraft = { kind: 'none', value: '', payload: '' }

/** "0 9 * * *" → { h: 9, m: 0 } when the cron is a plain daily time. */
export function dailyFromCron(cron: string): { h: number; m: number } | null {
  const match = cron.trim().match(/^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/)
  if (!match) return null
  const m = Number(match[1])
  const h = Number(match[2])
  return h <= 23 && m <= 59 ? { h, m } : null
}

export function nextCron(cron: string, now = Date.now()): number | null {
  try {
    return CronExpressionParser.parse(cron, { currentDate: new Date(now) }).next().getTime()
  } catch {
    return null
  }
}

export interface ScheduleResult {
  input?: TimerInput
  error?: string
  /** Human preview: "every 15m, next at 14:30". */
  preview: string
  nextAt?: number
}

/** Build the POST /timers body for a draft aimed at `loop` (absent/main = main). */
export function scheduleToTimer(draft: ScheduleDraft, loop: string | undefined, options: { scope?: Array<'agent' | 'system'>; lambda?: string; now?: number } = {}): ScheduleResult {
  const now = options.now ?? Date.now()
  const scope = options.scope ?? ['agent']
  const base: Partial<TimerInput> = {
    scope,
    ...(draft.payload.trim() ? { payload: draft.payload.trim() } : {}),
    ...(loop && loop !== MAIN_LOOP && scope.includes('agent') ? { loop } : {}),
    ...(options.lambda ? { lambda: options.lambda } : {}),
  }
  let maxRuns: number | undefined
  if (draft.maxRuns?.trim()) {
    const n = Number(draft.maxRuns.trim())
    if (!Number.isInteger(n) || n <= 0) return { error: 'Max runs must be a positive whole number', preview: '' }
    maxRuns = n
  }
  const withRuns = maxRuns ? { max_runs: maxRuns } : {}
  const runsText = maxRuns ? `, ${maxRuns} run${maxRuns === 1 ? '' : 's'} max` : ''
  const value = draft.value.trim()
  switch (draft.kind) {
    case 'none':
      return { preview: 'no schedule: runs on demand (send, trigger or another loop)' }
    case 'every': {
      const ms = parseDuration(value)
      if (!ms) return { error: 'Interval like 15m, 2h, 1h30m or 1d', preview: '' }
      if (ms < 5000) return { error: 'Timers tick every 5s; use 5s or more', preview: '' }
      const nextAt = now + ms
      return { input: { ...base, mode: 'interval', every_ms: ms, ...withRuns } as TimerInput, nextAt, preview: `every ${formatDuration(ms)}, next at ${formatWhen(nextAt, now)}${runsText}` }
    }
    case 'daily': {
      const clock = parseClock(value)
      if (!clock) return { error: 'Time like 03:00 or 21:30', preview: '' }
      const cron = `${clock.m} ${clock.h} * * *`
      const nextAt = nextCron(cron, now) ?? undefined
      return { input: { ...base, mode: 'cron', cron, ...withRuns } as TimerInput, nextAt, preview: `daily at ${pad2(clock.h)}:${pad2(clock.m)}${nextAt ? `, next ${formatWhen(nextAt, now)}` : ''}${runsText}` }
    }
    case 'cron': {
      if (!value) return { error: 'Cron expression like "0 */6 * * *"', preview: '' }
      const nextAt = nextCron(value, now)
      if (nextAt === null) return { error: `Not a valid cron expression: ${value}`, preview: '' }
      return { input: { ...base, mode: 'cron', cron: value, ...withRuns } as TimerInput, nextAt, preview: `${describeCron(value)}, next ${formatWhen(nextAt, now)}${runsText}` }
    }
    case 'in': {
      const ms = parseDuration(value)
      if (!ms) return { error: 'Delay like 10m or 2h', preview: '' }
      const nextAt = now + ms
      return { input: { ...base, mode: 'once_delay', delay_ms: ms } as TimerInput, nextAt, preview: `once, in ${formatDuration(ms)} (${formatWhen(nextAt, now)})` }
    }
    case 'at': {
      const at = parseWhen(value, now)
      if (at === null) return { error: 'Time like 14:30, 2026-10-01 09:00 or +2h', preview: '' }
      if (at <= now) return { error: 'That time is in the past', preview: '' }
      return { input: { ...base, mode: 'once_at', at } as TimerInput, nextAt: at, preview: `once at ${formatWhen(at, now)}` }
    }
  }
}

export function describeCron(cron: string): string {
  const daily = dailyFromCron(cron)
  if (daily) return `daily at ${pad2(daily.h)}:${pad2(daily.m)}`
  return `cron ${cron}`
}

/** "every 1h", "daily at 03:00", "cron 0 * * * *", "once at 14:30". */
export function describeTimer(timer: Pick<Timer, 'schedule'>, now = Date.now()): string {
  const s = timer.schedule
  switch (s.mode) {
    case 'interval': return `every ${formatDuration(s.every_ms)}${s.max_runs ? ` (max ${s.max_runs})` : ''}`
    case 'cron': return `${describeCron(s.cron)}${s.max_runs ? ` (max ${s.max_runs})` : ''}`
    case 'once': return `once at ${formatWhen(s.at, now)}`
    default: return 'unknown schedule'
  }
}

/** Timer → editable draft (inverse of scheduleToTimer, best effort). */
export function timerToDraft(timer: Timer): ScheduleDraft {
  const s = timer.schedule
  const payload = timer.payload ?? ''
  const maxRuns = s.mode !== 'once' && s.max_runs ? String(s.max_runs) : undefined
  switch (s.mode) {
    case 'interval': return { kind: 'every', value: formatDuration(s.every_ms), payload, maxRuns }
    case 'cron': {
      const daily = dailyFromCron(s.cron)
      return daily ? { kind: 'daily', value: `${pad2(daily.h)}:${pad2(daily.m)}`, payload, maxRuns } : { kind: 'cron', value: s.cron, payload, maxRuns }
    }
    case 'once': {
      const d = new Date(s.at)
      return { kind: 'at', value: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`, payload }
    }
    default: return { ...EMPTY_SCHEDULE, payload }
  }
}

export function timerLoop(timer: Pick<Timer, 'loop' | 'scope'>): string | null {
  if (!timer.scope?.includes('agent')) return null
  return timer.loop ?? MAIN_LOOP
}

/** Active timers that wake `loop`, soonest first. */
export function timersForLoop(timers: Timer[], loop: string): Timer[] {
  return timers.filter(t => !t.expired && timerLoop(t) === loop).sort((a, b) => a.next_wake_at - b.next_wake_at)
}

// --- triggers -------------------------------------------------------------------

export interface LoopTriggerRef {
  type: TriggerTypeV3
  enabled: boolean
  targetIndex: number
}

/** Agent-scope trigger targets that wake `loop` (absent target loop = main). */
export function triggersForLoop(triggers: TriggersConfigV3 | undefined, loop: string): LoopTriggerRef[] {
  const out: LoopTriggerRef[] = []
  if (!triggers) return out
  for (const type of TRIGGER_TYPES) {
    const cfg = triggers[type]
    if (!cfg) continue
    cfg.targets.forEach((target, targetIndex) => {
      if (target.scope === 'agent' && (target.loop ?? MAIN_LOOP) === loop) out.push({ type, enabled: cfg.enabled, targetIndex })
    })
  }
  return out
}

/** Will an agent-scope timer actually wake a loop? (on_timer must be on with an agent target.) */
export function timerTriggerWarning(config: AgentConfig | undefined): string | null {
  const t = config?.triggers?.on_timer
  if (!config?.triggers) return null
  if (!t || !t.enabled) return 'on_timer trigger is off: timers will not wake any loop until it is enabled (Triggers tab)'
  if (!t.targets.some(x => x.scope === 'agent')) return 'on_timer has no agent-scope target: timers will not wake a loop'
  return null
}

export function describeTarget(target: TriggerTarget): string {
  const parts: string[] = [target.scope]
  if (target.scope === 'agent') parts.push(`loop ${target.loop ?? MAIN_LOOP}`)
  if (target.lambda) parts.push(`lambda ${target.lambda}`)
  if (target.command) parts.push(`cmd ${target.command}`)
  if (target.debounce_ms) parts.push(`debounce ${formatDuration(target.debounce_ms)}`)
  if (target.interval_ms) parts.push(`interval ${formatDuration(target.interval_ms)}`)
  if (target.batch_ms) parts.push(`batch ${formatDuration(target.batch_ms)}${target.batch_count ? `/${target.batch_count}` : ''}`)
  if (target.filter && Object.keys(target.filter).length > 0) parts.push(`filter ${JSON.stringify(target.filter)}`)
  if (target.locked) parts.push('locked')
  return parts.join(' · ')
}

// --- diffs ----------------------------------------------------------------------

export interface FieldChange {
  field: string
  before: string
  after: string
}

function show(value: unknown): string {
  if (value === undefined) return '(unset)'
  if (value === null) return '(inherit)'
  if (Array.isArray(value)) return value.length ? value.join(', ') : '(none)'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function same(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i])
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

export type LoopPatchFields = LoopPatch

/** Only the fields that change, for PATCH /loops/:name. */
export function loopPatch(before: LoopConfig, after: LoopPatchFields): { patch: LoopPatchFields; changes: FieldChange[] } {
  const patch: LoopPatchFields = {}
  const changes: FieldChange[] = []
  for (const field of ['goal', 'enabled', 'autostart', 'autonomous', 'model', 'compact_threshold', 'tools'] as const) {
    if (!(field in after)) continue
    const next = after[field]
    const prev = before[field]
    const prevNorm = field === 'autostart' || field === 'autonomous' ? prev ?? false : prev
    const nextNorm = field === 'autostart' || field === 'autonomous' ? next ?? false : next
    if (same(prevNorm, nextNorm)) continue
    ;(patch as Record<string, unknown>)[field] = next
    changes.push({ field, before: show(prev), after: show(next) })
  }
  return { patch, changes }
}

/** Line diff of two JSON values (pretty-printed): '-' removed, '+' added, ' ' same. */
export function jsonLineDiff(before: unknown, after: unknown): Array<{ sign: ' ' | '-' | '+'; text: string }> {
  const a = JSON.stringify(before ?? null, null, 2).split('\n')
  const b = JSON.stringify(after ?? null, null, 2).split('\n')
  // LCS table; trigger configs are small.
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  }
  const out: Array<{ sign: ' ' | '-' | '+'; text: string }> = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push({ sign: ' ', text: a[i] }); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ sign: '-', text: a[i++] })
    else out.push({ sign: '+', text: b[j++] })
  }
  while (i < a.length) out.push({ sign: '-', text: a[i++] })
  while (j < b.length) out.push({ sign: '+', text: b[j++] })
  return out
}

/** Diff lines with a few lines of context around each change. */
export function compactDiff(lines: Array<{ sign: ' ' | '-' | '+'; text: string }>, context = 2): Array<{ sign: ' ' | '-' | '+' | '…'; text: string }> {
  const keep = new Set<number>()
  lines.forEach((line, index) => {
    if (line.sign === ' ') return
    for (let k = index - context; k <= index + context; k++) keep.add(k)
  })
  const out: Array<{ sign: ' ' | '-' | '+' | '…'; text: string }> = []
  let skipped = false
  lines.forEach((line, index) => {
    if (keep.has(index)) { out.push(line); skipped = false }
    else if (!skipped) { out.push({ sign: '…', text: '' }); skipped = true }
  })
  return out
}

// --- history entries -------------------------------------------------------------

export type EntryKind = 'text' | 'tool_use' | 'tool_result' | 'thinking' | 'context' | 'other'

export interface EntrySummary {
  kinds: EntryKind[]
  tools: string[]
  text: string
}

export function summarizeEntry(entry: LoopEntry): EntrySummary {
  const kinds = new Set<EntryKind>()
  const tools: string[] = []
  const parts: string[] = []
  for (const block of entry.content_json ?? []) {
    const b = block as { type: string; text?: string; name?: string; input?: unknown; content?: unknown; thinking?: string; is_error?: boolean }
    switch (b.type) {
      case 'text': {
        const text = b.text ?? ''
        kinds.add(text.startsWith('[Context:') ? 'context' : 'text')
        parts.push(text)
        break
      }
      case 'tool_use':
        kinds.add('tool_use')
        if (b.name) tools.push(b.name)
        parts.push(`${b.name ?? 'tool'}(${safeJson(b.input)})`)
        break
      case 'tool_result':
        kinds.add('tool_result')
        parts.push(`${b.is_error ? 'error: ' : '= '}${typeof b.content === 'string' ? b.content : safeJson(b.content)}`)
        break
      case 'thinking':
      case 'reasoning':
        kinds.add('thinking')
        parts.push(`(thinking) ${b.thinking ?? b.text ?? ''}`)
        break
      default:
        kinds.add('other')
        parts.push(`[${b.type}]`)
    }
  }
  return { kinds: [...kinds], tools, text: parts.join(' ').replace(/\s+/g, ' ').trim() }
}

export type RoleFilter = 'all' | 'user' | 'assistant' | 'tools'
export const ROLE_FILTERS: RoleFilter[] = ['all', 'user', 'assistant', 'tools']

export function entryMatches(entry: LoopEntry, role: RoleFilter, query: string): boolean {
  const summary = summarizeEntry(entry)
  if (role === 'user' && entry.role !== 'user') return false
  if (role === 'assistant' && entry.role !== 'assistant') return false
  if (role === 'tools' && !summary.kinds.includes('tool_use') && !summary.kinds.includes('tool_result')) return false
  if (!query) return true
  const q = query.toLowerCase()
  return summary.tools.some(t => t.toLowerCase().includes(q)) || summary.text.toLowerCase().includes(q)
}

export function formatTokens(entry: LoopEntry): string {
  const t = entry.tokens
  if (!t) return ''
  const parts: string[] = []
  if (t.input) parts.push(`in ${compact(t.input)}`)
  if (t.output) parts.push(`out ${compact(t.output)}`)
  if (t.cache_read) parts.push(`cache ${compact(t.cache_read)}`)
  if (t.cost_usd) parts.push(`$${t.cost_usd.toFixed(4)}`)
  return parts.join(' ')
}

function compact(n: number): string {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value) ?? '' } catch { return String(value) }
}
