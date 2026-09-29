// Tracked agents that are not loaded: every .adf in the daemon's tracked
// folders (GET /tracked-dirs/agents/all) that is not running in this daemon,
// listed next to the loaded ones like Studio's sidebar. They are selectable
// under a `file:<path>` key (the agent has no daemon id until it loads).
// Pure helpers: no React, no store.

import type { FolderAgent, TrackedAgentsList } from '../api/types'
import type { AgentSummary } from '../api/types'
import type { TuiState } from './types'

export const TRACKED_PREFIX = 'file:'

/** Selection key of a not-loaded tracked agent. */
export function trackedKey(filePath: string): string {
  return `${TRACKED_PREFIX}${filePath}`
}

export function isTrackedKey(id: string | null | undefined): id is string {
  return !!id && id.startsWith(TRACKED_PREFIX)
}

export function trackedPath(key: string): string {
  return key.slice(TRACKED_PREFIX.length)
}

const FOLD_CASE = process.platform === 'win32' || process.platform === 'darwin'

/** A path for comparison: forward slashes, no trailing separator, case-folded where the file system is. */
export function normPath(p: string): string {
  const n = p.replace(/\\/g, '/').replace(/\/+$/, '')
  return FOLD_CASE ? n.toLowerCase() : n
}

export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && normPath(a) === normPath(b)
}

/** `file` relative to `folder` (forward slashes), or the file name when it is not under it. */
export function relativeTo(folder: string, file: string): string {
  const f = file.replace(/\\/g, '/')
  const root = folder.replace(/\\/g, '/').replace(/\/+$/, '')
  if (normPath(f).startsWith(`${normPath(root)}/`)) return f.slice(root.length + 1)
  return f.slice(f.lastIndexOf('/') + 1)
}

/** Last path segment of a folder (its display name). */
export function folderName(folder: string): string {
  const parts = folder.replace(/\\/g, '/').replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || folder
}

export interface TrackedAgent {
  /** `file:<filePath>`: the selection key. */
  key: string
  /** The tracked folder it was found under, as stored. */
  folder: string
  /** Path inside that folder (`sub/agent-2.adf`). */
  relPath: string
  agent: FolderAgent
}

export interface TrackedFolder {
  path: string
  exists: boolean
  agentCount: number
  /** Agents of this folder loaded in the daemon. */
  loadedCount: number
}

export interface TrackedState {
  folders: TrackedFolder[]
  /** Not-loaded agents, by folder (stored order) then relative path. */
  stopped: TrackedAgent[]
  /** Load / start errors this TUI saw, by file path; kept until the agent loads. */
  errors: Record<string, string>
  /** What is in progress for a file (`loading`, `starting`), shown as a spinner. */
  busy: Record<string, string>
  at: number
  /** The last read failed (the list is the previous one). */
  error?: string
}

export const EMPTY_TRACKED: TrackedState = { folders: [], stopped: [], errors: {}, busy: {}, at: 0 }

/** Where a not-loaded agent stands, in two words (sidebar / table state column). */
export function stoppedLabel(entry: TrackedAgent, errors: Record<string, string> = {}): string {
  const a = entry.agent
  if (a.status === 'unreadable') return 'unreadable'
  if (a.error || errors[a.filePath]) return 'load error'
  switch (a.status) {
    case 'needs_review': return 'needs review'
    case 'password_protected': return 'locked'
    default: return 'stopped'
  }
}

/** The error to show for a not-loaded agent, if any. */
export function stoppedError(entry: TrackedAgent, errors: Record<string, string> = {}): string | undefined {
  return errors[entry.agent.filePath] ?? entry.agent.error
}

/** Build the tracked slice from the daemon's list, dropping agents that are loaded (by path). */
export function buildTracked(list: TrackedAgentsList, loaded: AgentSummary[], previous: TrackedState | null): TrackedState {
  const loadedPaths = new Set(loaded.map(a => a.filePath).filter((p): p is string => !!p).map(normPath))
  const seen = new Set<string>()
  const stopped: TrackedAgent[] = []
  for (const folder of list.folders) {
    const rows: TrackedAgent[] = []
    for (const agent of folder.agents) {
      const n = normPath(agent.filePath)
      if (agent.status === 'loaded' || loadedPaths.has(n) || seen.has(n)) continue
      seen.add(n)
      rows.push({ key: trackedKey(agent.filePath), folder: folder.path, relPath: relativeTo(folder.path, agent.filePath), agent })
    }
    rows.sort((a, b) => a.relPath.localeCompare(b.relPath))
    stopped.push(...rows)
  }
  // Errors stay until the file loads (or leaves the tracked folders).
  const errors: Record<string, string> = {}
  for (const [path, error] of Object.entries(previous?.errors ?? {})) if (seen.has(normPath(path))) errors[path] = error
  return {
    folders: list.folders.map(f => ({ path: f.path, exists: f.exists, agentCount: f.agentCount ?? f.agents.length, loadedCount: f.agentCount !== undefined ? f.loadedCount : f.agents.filter(a => a.status === 'loaded').length })),
    stopped,
    errors,
    busy: previous?.busy ?? {},
    at: Date.now(),
  }
}

/** Drop tracked entries whose files are now loaded (after an agent list refresh). */
export function pruneLoaded(tracked: TrackedState, loaded: AgentSummary[]): TrackedState {
  const loadedPaths = new Set(loaded.map(a => a.filePath).filter((p): p is string => !!p).map(normPath))
  const stopped = tracked.stopped.filter(t => !loadedPaths.has(normPath(t.agent.filePath)))
  if (stopped.length === tracked.stopped.length) return tracked
  const errors = { ...tracked.errors }
  for (const t of tracked.stopped) if (loadedPaths.has(normPath(t.agent.filePath))) delete errors[t.agent.filePath]
  return { ...tracked, stopped, errors }
}

/** Is `file` inside one of the tracked folders? */
export function underTrackedFolder(tracked: TrackedState | null, file: string): boolean {
  if (!tracked) return false
  const f = normPath(file)
  return tracked.folders.some(folder => f.startsWith(`${normPath(folder.path)}/`))
}

export function findTracked(state: Pick<TuiState, 'tracked'>, key: string | null | undefined): TrackedAgent | undefined {
  if (!key || !state.tracked) return undefined
  return state.tracked.stopped.find(t => t.key === key) ?? state.tracked.stopped.find(t => samePath(t.agent.filePath, trackedPath(key)))
}

/** The loaded agent id for a file path, if it is loaded. */
export function loadedIdForPath(state: Pick<TuiState, 'agents' | 'agentOrder'>, filePath: string): string | undefined {
  return state.agentOrder.find(id => samePath(state.agents[id]?.summary.filePath, filePath))
}

/**
 * Keep the selection on something real after the agent or tracked list
 * changed: a tracked key whose file loaded moves to the loaded agent; a
 * loaded agent that was unloaded moves to its tracked entry; else the first
 * agent (loaded first, then stopped).
 */
export function reconcileSelection(state: TuiState, previousSummaries: Record<string, AgentSummary | undefined> = {}, trackedFresh = false): string | null {
  const selected = state.selectedAgentId
  if (selected && !isTrackedKey(selected)) {
    if (state.agents[selected]) return selected
    const file = previousSummaries[selected]?.filePath
    if (file) {
      const t = findTracked(state, trackedKey(file))
      if (t) return t.key
      // Just unloaded: its tracked entry arrives with the next tracked read.
      if (underTrackedFolder(state.tracked, file)) return trackedKey(file)
    }
  } else if (selected) {
    const loadedId = loadedIdForPath(state, trackedPath(selected))
    if (loadedId) return loadedId
    const t = findTracked(state, selected)
    if (t) return t.key
    // The tracked list has not caught up (an unload just happened): keep it
    // while its folder is tracked, until a fresh tracked read says otherwise.
    if (!trackedFresh && (!state.tracked || underTrackedFolder(state.tracked, trackedPath(selected)))) return selected
  }
  return state.agentOrder[0] ?? state.tracked?.stopped[0]?.key ?? null
}
