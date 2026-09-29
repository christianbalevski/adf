// Pure fleet helpers: state derivation, loop schedules, fuzzy agent lookup and
// filesystem path completion. No React, no store — unit-testable.

import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { MAIN_LOOP, type Timer } from '../../api/types'
import { isBusyState } from '../../state/reducer'
import type { AgentEntry, LoopState, TuiState } from '../../state/types'

export type AgentKind = 'busy' | 'waiting' | 'active' | 'idle' | 'hibernate' | 'suspended' | 'off' | 'error' | 'unknown'

export interface AgentView {
  kind: AgentKind
  /** Short state label: idle, thinking, tool_use, awaiting_approval, off, error, … */
  label: string
  /** A turn is running in main or any inner loop. */
  busy: boolean
  /** Loops currently running (main included). */
  runningLoops: string[]
}

export function agentName(agent: AgentEntry): string {
  return agent.summary.handle || agent.summary.name || agent.summary.id
}

export function loopRunning(loop: LoopState): boolean {
  return loop.info.status === 'running' || isBusyState(loop.executorState)
}

export function describeAgent(agent: AgentEntry): AgentView {
  const state = agent.executorState ?? agent.status?.runtimeState
  const runningLoops: string[] = []
  if (isBusyState(agent.executorState)) runningLoops.push(MAIN_LOOP)
  for (const loop of agent.loops ?? []) {
    if (!loop.info.isMain && loop.info.enabled && loopRunning(loop)) runningLoops.push(loop.info.name)
  }
  const busy = runningLoops.length > 0
  if (agent.error || state === 'error') return { kind: 'error', label: 'error', busy, runningLoops }
  if (state === 'awaiting_approval' || state === 'awaiting_ask') return { kind: 'waiting', label: state === 'awaiting_ask' ? 'asking' : 'approval', busy, runningLoops }
  if (isBusyState(state)) return { kind: 'busy', label: state ?? 'busy', busy: true, runningLoops }
  if (busy) return { kind: 'busy', label: `${runningLoops.join(',')}`, busy, runningLoops }
  switch (state) {
    case 'active': return { kind: 'active', label: 'active', busy, runningLoops }
    case 'idle': return { kind: 'idle', label: 'idle', busy, runningLoops }
    case 'hibernate': return { kind: 'hibernate', label: 'hibernate', busy, runningLoops }
    case 'suspended': return { kind: 'suspended', label: 'suspended', busy, runningLoops }
    case 'off':
    case 'stopped': return { kind: 'off', label: state, busy, runningLoops }
    default: return { kind: 'unknown', label: state ?? '…', busy, runningLoops }
  }
}

export type LoopKind = 'running' | 'idle' | 'disabled'

export function describeLoop(agent: AgentEntry, loop: LoopState): { kind: LoopKind; label: string } {
  if (!loop.info.enabled) return { kind: 'disabled', label: 'off' }
  if (loop.info.isMain) {
    const state = agent.executorState
    return isBusyState(state) ? { kind: 'running', label: state ?? 'running' } : { kind: 'idle', label: 'idle' }
  }
  if (loopRunning(loop)) return { kind: 'running', label: loop.executorState && isBusyState(loop.executorState) ? loop.executorState : 'running' }
  return { kind: 'idle', label: 'idle' }
}

// --- schedules --------------------------------------------------------------

/** The loop a timer wakes (absent = main); null for system-scope-only timers. */
export function timerLoop(timer: Timer): string | null {
  const scope = (timer.scope ?? []) as string[]
  if (scope.length > 0 && !scope.includes('agent')) return null
  return timer.loop || MAIN_LOOP
}

export function liveTimers(timers: Timer[] | undefined): Timer[] {
  return (timers ?? []).filter(t => !t.expired)
}

/** Earliest next wake per loop name. */
export function nextRunByLoop(timers: Timer[] | undefined): Record<string, number> {
  const out: Record<string, number> = {}
  for (const timer of liveTimers(timers)) {
    const loop = timerLoop(timer)
    if (!loop || !Number.isFinite(timer.next_wake_at)) continue
    if (out[loop] === undefined || timer.next_wake_at < out[loop]) out[loop] = timer.next_wake_at
  }
  return out
}

/** Human schedule of a timer: `every 1h`, `cron 0 * * * *`, `once`. */
export function describeSchedule(timer: Timer): string {
  const s = timer.schedule as { mode?: string; every_ms?: number; cron?: string }
  if (s?.mode === 'interval' && typeof s.every_ms === 'number') return `every ${formatSpan(s.every_ms)}`
  if (s?.mode === 'cron' && s.cron) return `cron ${s.cron}`
  return 'once'
}

/** `in 42m`, `in 3h`, `due` — time until an epoch-ms instant. */
export function formatIn(at: number, now = Date.now()): string {
  const ms = at - now
  if (ms <= 0) return 'due'
  return `in ${formatSpan(ms)}`
}

export function formatSpan(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.round(h / 24)}d`
}

export function formatUptime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const d = Math.floor(s / 86_400)
  const h = Math.floor((s % 86_400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d${h}h`
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`
  return `${m}m${String(s % 60).padStart(2, '0')}s`
}

// --- lookup -----------------------------------------------------------------

/** Subsequence score, 0 = no match. Prefix and contiguous hits rank higher. */
export function fuzzy(query: string, text: string): number {
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  if (!q) return 1
  if (t === q) return 1000
  if (t.startsWith(q)) return 500 - t.length
  if (t.includes(q)) return 200 - t.indexOf(q)
  let score = 0
  let from = 0
  for (const ch of q) {
    const at = t.indexOf(ch, from)
    if (at < 0) return 0
    score += at === from ? 3 : 1
    from = at + 1
  }
  return score
}

/** Best agent id for a handle / name / id / fuzzy fragment, or null. */
export function findAgent(state: Pick<TuiState, 'agents' | 'agentOrder'>, query: string): string | null {
  const q = query.trim()
  if (!q) return null
  let best: { id: string; score: number } | null = null
  for (const id of state.agentOrder) {
    const agent = state.agents[id]
    if (!agent) continue
    if (id === q) return id
    const score = Math.max(
      fuzzy(q, agent.summary.handle ?? ''),
      fuzzy(q, agent.summary.name ?? ''),
      id.toLowerCase().startsWith(q.toLowerCase()) ? 400 : 0,
    )
    if (score > 0 && (!best || score > best.score)) best = { id, score }
  }
  return best?.id ?? null
}

/** Best not-loaded tracked agent (its `file:<path>` key) for a name / fuzzy fragment, or null. */
export function findStopped(state: Pick<TuiState, 'tracked'>, query: string): string | null {
  const q = query.trim()
  if (!q || !state.tracked) return null
  let best: { key: string; score: number } | null = null
  for (const t of state.tracked.stopped) {
    const score = Math.max(fuzzy(q, t.agent.name), fuzzy(q, t.relPath))
    if (score > 0 && (!best || score > best.score)) best = { key: t.key, score }
  }
  return best?.key ?? null
}

/** Names of not-loaded tracked agents, fuzzy-filtered for completion (`/start`). */
export function completeStopped(state: Pick<TuiState, 'tracked'>, partial: string): string[] {
  const q = partial.trim()
  return (state.tracked?.stopped ?? [])
    .map(t => ({ name: t.agent.name, score: fuzzy(q, t.agent.name) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(x => x.name)
}

/** `agent-1/consolidator`, `agent-1:researcher` or `agent-1 researcher`. */
export function parseAgentLoopRef(text: string): { agent: string; loop?: string } {
  const trimmed = text.trim()
  const match = /^(.+?)(?:[/:]|\s+)([a-z0-9][a-z0-9_-]*)$/i.exec(trimmed)
  if (match && !/^[a-z]:$/i.test(match[1])) return { agent: match[1], loop: match[2] }
  return { agent: trimmed }
}

/** Handles (or names) of loaded agents, fuzzy-filtered for completion. */
export function completeAgents(state: Pick<TuiState, 'agents' | 'agentOrder'>, partial: string): string[] {
  const q = partial.trim()
  return state.agentOrder
    .map(id => state.agents[id])
    .filter((a): a is AgentEntry => !!a)
    .map(a => ({ name: agentName(a), score: fuzzy(q, agentName(a)) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(x => x.name)
}

// --- path completion ----------------------------------------------------------

export interface DirEntryLite {
  name: string
  dir: boolean
}

export interface PathCompletionOptions {
  cwd?: string
  home?: string
  /** Case-insensitive matching (Windows/macOS filesystems). Default: not linux. */
  ignoreCase?: boolean
  list?: (dir: string) => DirEntryLite[]
  /** Separator appended to a completed directory when the input has none yet. */
  separator?: string
  /** Complete directories only (the "Track a folder" dialog); default: dirs + .adf files. */
  dirsOnly?: boolean
}

export interface PathCompletion {
  /** The input after completion (unchanged when nothing matched). */
  value: string
  /** Matching entries in the directory being completed (dirs end with a separator). */
  candidates: string[]
}

export function listDir(dir: string): DirEntryLite[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).map(entry => {
      let isDir = entry.isDirectory()
      if (!isDir && entry.isSymbolicLink()) {
        try { isDir = statSync(resolve(dir, entry.name)).isDirectory() } catch { isDir = false }
      }
      return { name: entry.name, dir: isDir }
    })
  } catch {
    return []
  }
}

/** Expand `~` and resolve against `cwd`. The daemon gets absolute paths only. */
export function expandPath(input: string, options: Pick<PathCompletionOptions, 'cwd' | 'home'> = {}): string {
  const home = options.home ?? homedir()
  const trimmed = input.trim().replace(/^"(.*)"$/, '$1')
  const expanded = trimmed === '~' ? home : /^~[\\/]/.test(trimmed) ? home + trimmed.slice(1) : trimmed
  return resolve(options.cwd ?? process.cwd(), expanded)
}

/**
 * Shell-style Tab completion over directories and `.adf` files: one match
 * completes fully (dirs get a trailing separator), several complete to their
 * common prefix and are returned as candidates.
 */
export function completePath(input: string, options: PathCompletionOptions = {}): PathCompletion {
  const ignoreCase = options.ignoreCase ?? process.platform !== 'linux'
  const list = options.list ?? listDir
  const cut = Math.max(input.lastIndexOf('/'), input.lastIndexOf('\\'))
  const dirPart = cut >= 0 ? input.slice(0, cut + 1) : ''
  const base = input.slice(cut + 1)
  const sep = cut >= 0 ? input[cut] : options.separator ?? (process.platform === 'win32' ? '\\' : '/')
  const dirAbs = expandPath(dirPart || '.', options)
  const norm = (s: string) => (ignoreCase ? s.toLowerCase() : s)
  const matches = list(dirAbs)
    .filter(e => e.dir || (!options.dirsOnly && /\.adf$/i.test(e.name)))
    .filter(e => !e.name.startsWith('.') || base.startsWith('.'))
    .filter(e => norm(e.name).startsWith(norm(base)))
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
  const candidates = matches.map(e => e.name + (e.dir ? sep : ''))
  if (matches.length === 0) return { value: input, candidates }
  if (matches.length === 1) return { value: dirPart + candidates[0], candidates }
  let common = matches[0].name
  for (const m of matches.slice(1)) {
    let i = 0
    while (i < common.length && i < m.name.length && norm(common[i]) === norm(m.name[i])) i++
    common = common.slice(0, i)
  }
  return { value: dirPart + (common.length > base.length ? common : base), candidates }
}
