/**
 * Pure helpers for the agent overview panel: level bars, tooltip one-liners,
 * popover sections, the facts line, level-up decisions and where a stat
 * factor's config lives. No React, no IO; unit-tested in
 * tests/unit/renderer/agent-overview-model.test.ts.
 */

import type { AgentState } from '../../../../shared/types/ipc.types'
import type { ActivityDay, AgentContents, ExperienceStat, PowerStat, StatFactor, UpcomingWake } from '../../../../shared/types/agent-vitals.types'

// =============================================================================
// Level bar
// =============================================================================

/** Words for the warn colour (brand: a status colour always carries a label). */
export const HIGH_POWER_LABEL = 'Much of this runs without asking'

export interface LevelBarParts {
  /** Width of the solid (open) fill, 0..100. */
  openPct: number
  /** Width of the light (gated) fill after it, 0..100. openPct + gatedPct = progress. */
  gatedPct: number
  /** Draw the open fill in the warn colour. */
  high: boolean
}

function toPct(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n * 100)) : 0
}

/**
 * The bar shows progress to the next level. For a power stat the fill splits
 * by the stat's open share: solid for what runs without asking, light for
 * what asks first. Experience (no open/gated) is all solid.
 */
export function levelBarParts(stat: { progress: number; open?: number; gated?: number; high?: boolean }): LevelBarParts {
  const total = toPct(stat.progress)
  const open = Math.max(0, stat.open ?? 0)
  const gated = Math.max(0, stat.gated ?? 0)
  const share = open + gated > 0 ? open / (open + gated) : stat.gated === undefined ? 1 : 0
  const openPct = Math.round(total * share * 10) / 10
  return { openPct, gatedPct: Math.round((total - openPct) * 10) / 10, high: !!stat.high }
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

function stripParenthetical(label: string): string {
  return label.replace(/\s*\([^)]*\)\s*$/, '')
}

/** "Lv 7, mostly asks you first · serves a public web page, 3 HTTP API routes" */
export function powerTooltip(stat: PowerStat, maxFactors = 2): string {
  let head = `Lv ${stat.level}`
  if (stat.points > 0 && stat.gated > 0) {
    const share = stat.gated / stat.points
    head += share >= 0.99 ? ', all asks you first' : share >= 0.5 ? ', mostly asks you first' : ', some asks you first'
  }
  if (stat.high) head += `. ${HIGH_POWER_LABEL}`
  const top = stat.factors
    .filter((f) => f.points > 0)
    .slice()
    .sort((a, b) => b.points - a.points)
    .slice(0, maxFactors)
    // Parentheticals (event lists, "needs approval") belong in the popover.
    .map((f) => lowerFirst(stripParenthetical(f.label)))
  return top.length ? `${head} · ${top.join(', ')}` : head
}

/** "340 XP to Lv 22" */
export function experienceHeadline(exp: ExperienceStat): string {
  return `${compactCount(Math.ceil(exp.nextLevel.xp))} XP to Lv ${exp.level + 1}`
}

/** "Memory ~12k tokens" */
export function memoryLine(tokens: number): string {
  return `Memory ~${compactCount(tokens)} tokens`
}

/** 0.02 -> "<0.1 contexts of work", 0.4 -> "~0.4 contexts of work", 1 -> "~1 context of work", 150.3 -> "~150 contexts of work". */
export function contextsLine(contexts: number): string {
  const n = Number.isFinite(contexts) && contexts > 0 ? contexts : 0
  if (n > 0 && n < 0.05) return '<0.1 contexts of work'
  const text = n < 10 ? trimZero(n.toFixed(1)) : compactCount(n)
  return `~${text} ${text === '1' ? 'context' : 'contexts'} of work`
}

/** A signal's raw value as the "How XP adds up" table shows it. */
export function experienceValueText(signal: { id: string; value: number }): string {
  if (signal.id === 'contextsWorked' && signal.value < 10) return trimZero(signal.value.toFixed(1))
  return compactCount(signal.value)
}

/** "~150 contexts of work · 18 files · 3 skills · memory ~12k tokens · 340 XP to Lv 22" */
export function experienceTooltip(exp: ExperienceStat): string {
  const value = (id: string): number => exp.breakdown.find((b) => b.id === id)?.value ?? 0
  const parts: string[] = []
  const contexts = value('contextsWorked')
  const files = value('filesWritten')
  const skills = value('skills')
  const memory = value('memoryTokens')
  if (contexts > 0) parts.push(contextsLine(contexts))
  if (files > 0) parts.push(plural(files, 'file'))
  if (skills > 0) parts.push(plural(skills, 'skill'))
  if (memory > 0) parts.push(lowerFirst(memoryLine(memory)))
  parts.push(experienceHeadline(exp))
  return parts.join(' · ')
}

const CONTRIBUTOR_NOUN: Record<string, [string, string]> = {
  filesWritten: ['file written', 'files written'],
  skills: ['skill', 'skills'],
  localTables: ['database table', 'database tables'],
  localRows: ['database row', 'database rows'],
  agentsSpawned: ['agent created', 'agents created'],
  messages: ['message', 'messages'],
  ageDays: ['day', 'days']
}

/** Contributors that always get their own line when non-zero, even outside the top `max`. */
const ALWAYS_LISTED = new Set(['skills', 'memoryTokens', 'messages', 'ageDays'])

/**
 * Plain lines for what earned the most XP, largest first: "~150 contexts of
 * work", "Memory ~20k tokens", "10 skills", "30k messages", "120 days".
 * Skills, memory, messages and days are listed whenever they add XP.
 */
export function experienceContributors(exp: ExperienceStat, max = 5): string[] {
  const ranked = exp.breakdown.filter((b) => b.value > 0).slice().sort((a, b) => b.xp - a.xp)
  const top = new Set(ranked.filter((b) => b.xp >= 0.5).slice(0, max))
  return ranked
    .filter((b) => top.has(b) || (ALWAYS_LISTED.has(b.id) && b.xp > 0))
    .map((b) => {
      if (b.id === 'memoryTokens') return memoryLine(b.value)
      if (b.id === 'contextsWorked') return contextsLine(b.value)
      const noun = CONTRIBUTOR_NOUN[b.id] ?? [b.label.toLowerCase(), b.label.toLowerCase()]
      return plural(b.value, noun[0], noun[1])
    })
}

// =============================================================================
// Power popover sections
// =============================================================================

/** Items shown per section before "N more". */
export const SECTION_LIMIT = 5

export interface PowerItem {
  /** Stable React key: the fold group, or the factor id. */
  key: string
  text: string
  /** Factors folded into this line. */
  count: number
  /** Where the first folded factor is configured. */
  configPath: string
  /** Sum of the folded points. Sort key only; never shown. */
  points: number
}

export interface PowerSections {
  /** "Runs without asking" */
  open: PowerItem[]
  /** "Asks you first" */
  gated: PowerItem[]
  /** "Limits": mitigations. */
  limits: PowerItem[]
}

/** Tool factors that fold into one line per kind. */
const TOOL_GROUP: Record<string, string> = {
  fs_read: 'files',
  fs_write: 'files',
  fs_delete: 'files',
  db_execute: 'files',
  fs_transfer: 'files',
  sys_code: 'code',
  sys_lambda: 'code',
  adf_shell: 'code',
  sys_fetch: 'network',
  ws_connect: 'network',
  stream_bind: 'network'
}

const GROUP_PHRASE: Record<string, (n: number) => string> = {
  files: (n) => `${n} file and data tools`,
  code: (n) => `${n} code tools`,
  network: (n) => `${n} network tools`,
  mcp: (n) => `${n} MCP servers`,
  'mcp-credentials': (n) => `${n} MCP servers hold credentials`,
  adapters: (n) => `${n} chat channels`
}

/** The fold group a factor belongs to, or null when it stands alone. */
export function factorGroup(id: string): string | null {
  if (id.startsWith('tool:')) return TOOL_GROUP[id.slice(5)] ?? null
  if (/^mcp:.+:credentials$/.test(id)) return 'mcp-credentials'
  if (id.startsWith('mcp:')) return 'mcp'
  if (id.startsWith('adapter:')) return 'adapters'
  return null
}

/** Fold same-kind factors into one line with a count; a group of one keeps its own label. */
export function foldFactors(factors: StatFactor[]): PowerItem[] {
  const items: PowerItem[] = []
  const byGroup = new Map<string, PowerItem>()
  for (const f of factors) {
    const group = factorGroup(f.id)
    const existing = group ? byGroup.get(group) : undefined
    if (group && existing) {
      existing.count++
      existing.points += f.points
      existing.text = GROUP_PHRASE[group](existing.count)
      continue
    }
    const item: PowerItem = { key: group ?? f.id, text: stripParenthetical(f.label), count: 1, configPath: f.configPath, points: f.points }
    if (group) byGroup.set(group, item)
    items.push(item)
  }
  return items
}

/** Split factors into the popover's three sections, folded, heaviest first. */
export function powerSections(stat: Pick<PowerStat, 'factors'>): PowerSections {
  const positive = stat.factors.filter((f) => f.points > 0)
  const byWeight = (a: PowerItem, b: PowerItem): number => b.points - a.points
  return {
    open: foldFactors(positive.filter((f) => !f.gated)).sort(byWeight),
    gated: foldFactors(positive.filter((f) => f.gated)).sort(byWeight),
    limits: foldFactors(stat.factors.filter((f) => f.points < 0)).sort((a, b) => a.points - b.points)
  }
}

/** Metrics shown before "+N", so the overview fits without scrolling. */
export const OVERVIEW_ROW_LIMIT = 3

/** Coming up rows shown before "+N" (in the section title row). */
export const COMING_UP_ROW_LIMIT = 2

/** The first `limit` items unless expanded, and how many are hidden. */
export function visibleItems<T>(items: T[], expanded: boolean, limit = SECTION_LIMIT): { shown: T[]; hidden: number } {
  if (expanded || items.length <= limit) return { shown: items, hidden: 0 }
  return { shown: items.slice(0, limit), hidden: items.length - limit }
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
  id: 'cost' | 'age' | 'wake' | 'turns'
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

export interface StatusOpts {
  starting?: boolean
  toolName?: string | null
  /** Pending approvals and asks, every loop. */
  approvals?: number
  asks?: number
  /** A suspend request waits for the user. */
  suspend?: boolean
  /** Earliest timer wake, shown after Idle / Hibernating. */
  nextWakeAt?: number
  now?: number
}

/**
 * The card face's state line: "Running fs_write", "Waiting for you ·
 * 2 approvals", "Idle · wakes in 56 min", "Stopped".
 */
export function agentStatusLabel(state: AgentState | null | undefined, opts: StatusOpts = {}): string {
  if (opts.starting) return 'Starting'
  const approvals = opts.approvals ?? 0
  const asks = opts.asks ?? 0
  if (state && state !== 'off' && (approvals > 0 || asks > 0 || opts.suspend)) {
    const parts: string[] = []
    if (approvals > 0) parts.push(plural(approvals, 'approval'))
    if (asks > 0) parts.push(plural(asks, 'question'))
    return parts.length > 0 ? `Waiting for you · ${parts.join(', ')}` : 'Waiting for you'
  }
  const wake = typeof opts.nextWakeAt === 'number' && Number.isFinite(opts.nextWakeAt) && typeof opts.now === 'number'
    ? ` · ${formatWake(opts.nextWakeAt, opts.now)}`
    : ''
  switch (state) {
    case 'active':
      return opts.toolName ? `Running ${opts.toolName}` : 'Thinking'
    case 'idle':
      return `Idle${wake}`
    case 'hibernate':
      return `Hibernating${wake}`
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

// =============================================================================
// Activity sections
// =============================================================================

/** "in 4 min", "in 3 h", "in 2 days", "due". */
export function formatUntil(at: number, now: number): string {
  const ms = at - now
  if (!Number.isFinite(ms) || ms <= 0) return 'due'
  const min = Math.round(ms / 60_000)
  if (min < 1) return 'in under a minute'
  if (min < 60) return `in ${min} min`
  const h = Math.round(ms / 3_600_000)
  if (h < 48) return `in ${h} h`
  return `in ${Math.round(ms / 86_400_000)} days`
}

const MAIN_LOOP_NAME = 'main'

/** The slice of an agent-store log entry `waitingItems` reads. */
export interface LiveLogEntry {
  type: string
  content: string
  timestamp: number
  metadata?: Record<string, unknown>
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function shortLine(s: string, max = 80): string {
  const line = s.trim().split(/\r?\n/, 1)[0] ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** Characters of a timer's input (system) or prompt (agent) shown on its row. */
export const TIMER_TEXT_MAX = 60

/** One "Coming up" timer row. */
export interface TimerRowText {
  /** system: `lambda` in mono. agent: the loop name as a tag. */
  kind: 'lambda' | 'loop' | 'none'
  /** Lambda (`lib/sync.ts:run`) or loop name. */
  head?: string
  /** Input (single-line JSON) or prompt start, at most TIMER_TEXT_MAX chars. */
  text?: string
  /** Full text for the tooltip; set only when `text` was shortened. */
  full?: string
  /** True when `text` is code (system input). */
  mono: boolean
}

/** Single-line JSON when `s` parses as JSON, else `s` with whitespace runs collapsed. */
export function compactInput(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s)) ?? s
  } catch {
    return s.replace(/\s+/g, ' ').trim()
  }
}

function clip(s: string, max: number): { text: string; full?: string } {
  return s.length > max ? { text: `${s.slice(0, max - 1)}…`, full: s } : { text: s }
}

/** Row text for one upcoming timer: lambda and input, or loop and prompt start. */
export function timerRowText(t: UpcomingWake, max = TIMER_TEXT_MAX): TimerRowText {
  if (t.scope === 'agent') {
    const prompt = t.prompt ? t.prompt.replace(/\s+/g, ' ').trim() : ''
    return { kind: 'loop', head: t.loop || MAIN_LOOP_NAME, ...(prompt ? clip(prompt, max) : {}), mono: false }
  }
  const input = t.input ? compactInput(t.input) : ''
  if (!t.lambda && !input) return { kind: 'none', text: 'System timer', mono: false }
  return { kind: t.lambda ? 'lambda' : 'none', head: t.lambda, ...(input ? clip(input, max) : {}), mono: true }
}

/** Something waiting on the user, from the agent store's pending maps. */
export interface WaitingItem {
  key: string
  text: string
  loop: string
}

/**
 * Pending approvals ("Approve fs_write") and asks ("Answer: <question>") for
 * every loop, main first. The tool name comes from the approval's log entry.
 */
export function waitingItems(slices: Array<{
  loop: string
  log: Array<LiveLogEntry & { id: string }>
  approvals: Iterable<string>
  asks: Iterable<[string, { question: string }]>
}>): WaitingItem[] {
  const out: WaitingItem[] = []
  for (const s of slices) {
    const where = s.loop === MAIN_LOOP_NAME ? '' : ` in ${s.loop}`
    for (const id of s.approvals) {
      const entry = s.log.find((e) => e.id === id)
      const name = str(entry?.metadata?.name)
      out.push({ key: `approval:${s.loop}:${id}`, text: `${name ? `Approve ${name}` : 'Approve a tool call'}${where}`, loop: s.loop })
    }
    for (const [id, ask] of s.asks) {
      const q = shortLine(ask.question, 60)
      out.push({ key: `ask:${s.loop}:${id}`, text: `${q ? `Answer: ${q}` : 'Answer a question'}${where}`, loop: s.loop })
    }
  }
  return out
}

/** Any finished turn or known cost in the window; the chart hides otherwise. */
export function hasActivity(daily: ActivityDay[]): boolean {
  return daily.some((d) => d.turns > 0 || (d.costUsd ?? 0) > 0)
}

/** The folded chart as a fact: "5 turns / 14d". */
export function sparkFact(daily: ActivityDay[]): string {
  const total = daily.reduce((n, d) => n + d.turns, 0)
  return `${total === 1 ? '1 turn' : `${compactCount(total)} turns`} / ${daily.length}d`
}

export function sparkSummary(daily: ActivityDay[]): string {
  const total = daily.reduce((n, d) => n + d.turns, 0)
  return `${total === 1 ? '1 turn' : `${compactCount(total)} turns`} in the last ${daily.length} days`
}

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Mon 6 Oct · 4 turns · $0.12" (cost only when the ledger has it). */
export function dayTooltip(day: ActivityDay, isToday = false): string {
  const [y, mo, d] = day.date.split('-').map(Number)
  const date = new Date(y, (mo || 1) - 1, d || 1)
  const head = isToday ? 'Today' : `${WEEKDAY[date.getDay()]} ${date.getDate()} ${MONTH[date.getMonth()]}`
  const parts = [head, day.turns === 1 ? '1 turn' : `${compactCount(day.turns)} turns`]
  if (typeof day.costUsd === 'number') parts.push(`${formatCost(day.costUsd)}${day.costPartial ? ' or more' : ''}`)
  return parts.join(' · ')
}

/** Bar heights in px for the sparkline: 0 for an empty day, at least 2 px otherwise. */
export function sparkHeights(daily: ActivityDay[], height: number): number[] {
  const max = daily.reduce((m, d) => Math.max(m, d.turns), 0)
  return daily.map((d) => (d.turns > 0 && max > 0 ? Math.max(2, Math.round((d.turns / max) * height)) : 0))
}

export function rowsLabel(n: number): string {
  return plural(n, 'row')
}

// =============================================================================
// Contents
// =============================================================================

/** Groups on the token meter, in fixed order. */
export type ContentsKey = 'mind' | 'skills'

export interface ContentsGroup {
  key: ContentsKey
  label: string
  tokens: number
  /** Segment and legend tooltip: "Mind 12 files · ~20k". */
  text: string
  /** Legend item on the single legend line: "Mind ~20k". */
  short: string
}

/** 850 → "~850", 12_345 → "~12k". */
export function approxTokens(n: number): string {
  return `~${compactCount(n)}`
}

export interface ContentsView {
  /** Non-empty meter groups (mind, skills), fixed order. */
  groups: ContentsGroup[]
  /** Mind + skills tokens. */
  total: number
  /** "Tables 3 · 2.1k rows", null without tables. Not on the meter. */
  tables: string | null
}

/** null when the file holds none of the three. */
export function contentsView(c: AgentContents): ContentsView | null {
  const groups: ContentsGroup[] = []
  if (c.mind.files > 0) groups.push({ key: 'mind', label: 'Mind', tokens: c.mind.tokens, text: `Mind ${plural(c.mind.files, 'file')} · ${approxTokens(c.mind.tokens)}`, short: `Mind ${approxTokens(c.mind.tokens)}` })
  if (c.skills.count > 0) groups.push({ key: 'skills', label: 'Skills', tokens: c.skills.tokens, text: `Skills ${compactCount(c.skills.count)} · ${approxTokens(c.skills.tokens)}`, short: `Skills ${approxTokens(c.skills.tokens)}` })
  const tables = c.tables.count > 0 ? `Tables ${compactCount(c.tables.count)} · ${rowsLabel(c.tables.rows)}` : null
  if (groups.length === 0 && !tables) return null
  return { groups, total: groups.reduce((n, g) => n + g.tokens, 0), tables }
}
