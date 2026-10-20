import type { TrackedDirEntry } from '../../shared/types/ipc.types'

/**
 * Go to agent (Cmd/Ctrl+K): the tracked agents, ranked for a query. Agents
 * that need you come first, then running agents, then the rest; a query
 * keeps only the agents whose name matches it.
 */

export interface SwitcherAgent {
  filePath: string
  name: string
  /** Folder that holds the file, to tell agents with one name apart. */
  folder: string
  running: boolean
  /** Pending approvals and questions. */
  needsYou: number
}

export interface SwitcherMatch {
  agent: SwitcherAgent
  /** Indices of `agent.name` the query matched, for highlighting. */
  matched: number[]
}

export interface SwitcherInput {
  directories: string[]
  filesByDir: Record<string, TrackedDirEntry[]>
  /** The agent open in this window, whose state lives in the agent store. */
  currentFilePath: string | null
  foregroundRunning: boolean
  isBackgroundRunning: (filePath: string) => boolean
  /** filePath of each pending approval or question. */
  pendingFilePaths: string[]
}

function folderOf(filePath: string): string {
  const parts = filePath.split(/[\\/]/)
  return parts.length > 1 ? parts[parts.length - 2] : ''
}

/** Every tracked agent once (the first tracked root that lists it wins). */
export function collectSwitcherAgents(input: SwitcherInput): SwitcherAgent[] {
  const pending = new Map<string, number>()
  for (const fp of input.pendingFilePaths) pending.set(fp, (pending.get(fp) ?? 0) + 1)
  const seen = new Set<string>()
  const out: SwitcherAgent[] = []
  const walk = (entries: TrackedDirEntry[]): void => {
    for (const e of entries) {
      if (e.isDirectory) { walk(e.children ?? []); continue }
      if (!e.fileName.toLowerCase().endsWith('.adf') || seen.has(e.filePath)) continue
      seen.add(e.filePath)
      out.push({
        filePath: e.filePath,
        name: e.agentName?.trim() || e.fileName.replace(/\.adf$/i, ''),
        folder: folderOf(e.filePath),
        running: e.filePath === input.currentFilePath ? input.foregroundRunning : input.isBackgroundRunning(e.filePath),
        needsYou: pending.get(e.filePath) ?? 0,
      })
    }
  }
  for (const dir of input.directories) walk(input.filesByDir[dir] ?? [])
  return out
}

const BOUNDARY = /[\s\-_./\\]/

export interface FuzzyResult {
  /** 3 prefix, 2 substring at a word start, 1 any substring, 0 scattered characters. */
  quality: number
  /** Within one quality, higher is better. */
  score: number
  matched: number[]
}

/**
 * Fuzzy match `query` against `text`, ignoring case and spaces: every query
 * character in order. Null when it does not match. Within one quality,
 * consecutive characters, word starts and an early first match score higher.
 */
export function fuzzyMatch(query: string, text: string): FuzzyResult | null {
  const q = query.toLowerCase().replace(/\s+/g, '')
  if (!q) return { quality: 0, score: 0, matched: [] }
  const t = text.toLowerCase()
  const at = t.indexOf(q)
  if (at >= 0) {
    const quality = at === 0 ? 3 : BOUNDARY.test(t[at - 1]) ? 2 : 1
    return { quality, score: -at, matched: Array.from({ length: q.length }, (_, i) => at + i) }
  }
  const matched: number[] = []
  let score = 0
  let from = 0
  // Whether q[qi..] still matches in order from t[pos].
  const restMatches = (qi: number, pos: number): boolean => {
    for (let i = qi; i < q.length; i++) {
      pos = t.indexOf(q[i], pos)
      if (pos < 0) return false
      pos++
    }
    return true
  }
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi]
    const next = t.indexOf(ch, from)
    if (next < 0) return null
    const prev = matched[matched.length - 1]
    let found = next
    // Not continuing a run: take a later word start with this character when the rest still matches after it.
    if (prev === undefined || next !== prev + 1) {
      for (let i = next; i < t.length; i++) {
        if (t[i] === ch && (i === 0 || BOUNDARY.test(t[i - 1])) && restMatches(qi + 1, i + 1)) { found = i; break }
      }
    }
    score += 10
    if (prev !== undefined && found === prev + 1) score += 15
    if (found === 0 || BOUNDARY.test(t[found - 1])) score += 20
    if (prev !== undefined) score -= Math.min(found - prev - 1, 10)
    matched.push(found)
    from = found + 1
  }
  return { quality: 0, score: score - matched[0], matched }
}

function tier(agent: SwitcherAgent): number {
  return agent.needsYou > 0 ? 0 : agent.running ? 1 : 2
}

/**
 * The switcher's list. No query: needs you, running, the rest, each by name.
 * A query: matching agents by match quality (prefix, word start, substring,
 * scattered), then in that same order, then by score.
 */
export function rankAgents(agents: SwitcherAgent[], query: string): SwitcherMatch[] {
  const byName = (a: SwitcherAgent, b: SwitcherAgent) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.filePath.localeCompare(b.filePath)
  if (!query.trim()) {
    return [...agents]
      .sort((a, b) => tier(a) - tier(b) || byName(a, b))
      .map((agent) => ({ agent, matched: [] }))
  }
  const scored: Array<SwitcherMatch & FuzzyResult> = []
  for (const agent of agents) {
    const m = fuzzyMatch(query, agent.name)
    if (m) scored.push({ agent, ...m })
  }
  return scored
    .sort((a, b) => b.quality - a.quality || tier(a.agent) - tier(b.agent) || b.score - a.score || byName(a.agent, b.agent))
    .map(({ agent, matched }) => ({ agent, matched }))
}
