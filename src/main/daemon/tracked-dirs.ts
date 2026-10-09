/**
 * Tracked agent folders over the daemon API — Studio's TRACKED_DIRS_* IPC
 * (ipc/index.ts) without the native dialog. The list lives in settings
 * `trackedDirectories` (string[]), exactly where Studio and the daemon boot
 * read it; tracking never touches the files themselves.
 */

import { existsSync, statSync } from 'node:fs'
import { basename, isAbsolute } from 'node:path'
import { AdfDatabase } from '../adf/adf-database'
import { isConfigReviewed } from '../services/agent-review'
import { canonicalizePath, containsPath, isSameOrSubPath } from '../utils/tracked-paths'
import type { RuntimeAutostartReport, RuntimeAutostartSkipped, RuntimeService } from '../runtime/runtime-service'

export interface TrackedDirsSettings {
  get(key: string): unknown
  set?(key: string, value: unknown): void
}

export interface TrackedDirEntry {
  /** As stored in settings.trackedDirectories. */
  path: string
  exists: boolean
  /** .adf files an autostart scan finds under it (maxDirectoryScanDepth). */
  agentCount: number
  /** Of those, how many are loaded in this daemon now. */
  loadedCount: number
}

export interface TrackedDirsList {
  maxDepth: number
  directories: TrackedDirEntry[]
}

/**
 * Where one .adf in a tracked folder stands, and what the owner can do next:
 * - loaded: running in this daemon
 * - needs_review: never reviewed here; review it (GET /agents/review), accept
 *   (POST /agents/review/accept), then load
 * - not_autostart: reviewed, not set to autostart; load it by hand
 * - stopped: reviewed autostart agent that is not loaded (stopped, or its load failed: `error`)
 * - password_protected: its identity is password-encrypted; autostart skips it
 * - unreadable: not a readable .adf (`error` says why)
 */
export type FolderAgentStatus = 'loaded' | 'needs_review' | 'not_autostart' | 'stopped' | 'password_protected' | 'unreadable'

export interface FolderAgent {
  filePath: string
  /** The agent's name (file name when unreadable). */
  name: string
  agentId?: string
  status: FolderAgentStatus
  autostart: boolean
  reviewed: boolean
  /** Why it is not running, when known: unreadable file, or the load error from this track's autostart pass. */
  error?: string
}

export interface FolderAgentsList {
  /** The tracked folder, as stored. */
  path: string
  agents: FolderAgent[]
}

export interface TrackDirResult {
  entry: TrackedDirEntry
  /** The full tracked list after the change. */
  directories: string[]
  /** Previously tracked subfolders the new folder now covers (Studio: a parent absorbs them). */
  absorbed: string[]
  /** The autostart pass over the new folder (same rules as daemon boot / POST /agents/autostart). */
  autostart: RuntimeAutostartReport
  /** Autostart agents skipped because the owner has not reviewed them yet (POST /agents/review/accept). */
  needsReview: RuntimeAutostartSkipped[]
  /** Every agent in the folder after the autostart pass and where it stands (as GET /tracked-dirs/agents). */
  agents: FolderAgent[]
}

export interface UntrackDirResult {
  removed: string
  directories: string[]
  unloaded: Array<{ agentId: string; filePath: string; name: string }>
}

/** GET /tracked-dirs/agents/all: every tracked folder with its agents (the fleet sidebar's "all agents" list). */
export interface TrackedAgentsList {
  maxDepth: number
  folders: Array<TrackedDirEntry & { agents: FolderAgent[] }>
}

/** Caller-visible failure; `statusCode` is the HTTP status to answer with. */
export class TrackedDirError extends Error {
  constructor(message: string, readonly statusCode: 400 | 404 | 405 | 409, readonly details?: Record<string, unknown>) {
    super(message)
    this.name = 'TrackedDirError'
  }
}

/** settings.trackedDirectories, non-empty strings only. */
export function storedDirs(settings: TrackedDirsSettings): string[] {
  const raw = settings.get('trackedDirectories')
  return Array.isArray(raw) ? raw.filter((d): d is string => typeof d === 'string' && d.length > 0) : []
}

/** settings.maxDirectoryScanDepth (default 5). */
export function maxDepthOf(settings: TrackedDirsSettings): number {
  const raw = settings.get('maxDirectoryScanDepth')
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 5
}

/** Same folder, after canonicalization (case/separators/symlinks/8.3 names). */
function sameDir(a: string, b: string): boolean {
  try { return isSameOrSubPath(a, b) && isSameOrSubPath(b, a) } catch { return false }
}

function isDirectory(p: string): boolean {
  try { return existsSync(p) && statSync(p).isDirectory() } catch { return false }
}

function loadedUnder(runtime: RuntimeService, dir: string): Array<{ agentId: string; filePath: string; name: string }> {
  const root = canonicalizePath(dir)
  const out: Array<{ agentId: string; filePath: string; name: string }> = []
  for (const agent of runtime.listAgents()) {
    if (!agent.filePath) continue
    let file: string
    try { file = canonicalizePath(agent.filePath) } catch { continue }
    if (containsPath(root, file)) out.push({ agentId: agent.id, filePath: agent.filePath, name: agent.name })
  }
  return out
}

// --- Peek cache ---------------------------------------------------------------
// Listing a folder's agents peeks each .adf's config (one readonly open). The
// fleet sidebar lists every tracked folder on a poll, so the peek is kept per
// file and reused while the file and its -wal sidecar are unchanged (mtime +
// size): a steady poll opens nothing. Only files that are not loaded here are
// ever peeked by the pollers' callers anyway; a readonly peek never modifies
// the .adf (sidecars it created are reaped by peekReadonly).

type PeekResult = ReturnType<typeof AdfDatabase.peekBootStatusDetailed>
const PEEK_CACHE_MAX = 2000
const peekCache = new Map<string, { stamp: string; result: PeekResult }>()

function statStamp(path: string): string {
  try {
    const st = statSync(path)
    return `${st.mtimeMs}:${st.size}`
  } catch {
    return '-'
  }
}

/** `AdfDatabase.peekBootStatusDetailed`, cached by the file's (and its WAL's) mtime + size. */
export function peekBootStatusCached(filePath: string): PeekResult {
  const stamp = `${statStamp(filePath)}|${statStamp(`${filePath}-wal`)}`
  const hit = peekCache.get(filePath)
  if (hit && hit.stamp === stamp) return hit.result
  const result = AdfDatabase.peekBootStatusDetailed(filePath)
  // A failed peek (busy, mid-write) is not cached: keep serving the last good
  // one, like Studio's sidebar, and try again next time.
  if (!result.status) return hit?.result.status ? hit.result : result
  // A peek may create and reap sidecars: stamp after it, so the next poll hits.
  const after = `${statStamp(filePath)}|${statStamp(`${filePath}-wal`)}`
  peekCache.delete(filePath)
  if (peekCache.size >= PEEK_CACHE_MAX) peekCache.delete(peekCache.keys().next().value as string)
  peekCache.set(filePath, { stamp: after, result })
  return result
}

/** Test hook: forget cached peeks. */
export function clearPeekCache(): void {
  peekCache.clear()
}

// --- Last load failures ---------------------------------------------------------
// An autostart pass (daemon boot, POST /agents/autostart, tracking a folder)
// knows why an agent did not load; later listings only see "not loaded".
// Remember the last failure per file so the fleet shows the error until the
// agent loads (or another pass succeeds).

const loadFailures = new Map<string, string>()

function failureKey(filePath: string): string {
  try { return canonicalizePath(filePath) } catch { return filePath }
}

/** Record an autostart report's failures (and clear the ones that started). */
export function noteAutostartReport(report: Pick<RuntimeAutostartReport, 'started' | 'failed'>): void {
  for (const s of report.started) if (s.filePath) loadFailures.delete(failureKey(s.filePath))
  for (const f of report.failed) if (f.filePath) loadFailures.set(failureKey(f.filePath), f.error)
}

/**
 * Each .adf under `dir` (the autostart scan's walk) and where it stands.
 * `failures` (filePath -> error) carries load errors from an autostart pass
 * that just ran, so they reach the owner instead of a bare "not loaded".
 */
function folderAgents(
  runtime: RuntimeService,
  settings: TrackedDirsSettings,
  dir: string,
  maxDepth: number,
  failures: Map<string, string> = new Map(),
): FolderAgent[] {
  if (!isDirectory(dir)) return []
  const loaded = new Map<string, { id: string; name: string }>()
  for (const agent of runtime.listAgents()) {
    if (!agent.filePath) continue
    try { loaded.set(canonicalizePath(agent.filePath), { id: agent.id, name: agent.name }) } catch { /* path gone */ }
  }
  const reviewedRaw = settings.get('reviewedAgents')
  return runtime.scanAdfFiles([dir], maxDepth).map((filePath): FolderAgent => {
    const fallbackName = basename(filePath, '.adf')
    let key = filePath
    try { key = canonicalizePath(filePath) } catch { /* keep as scanned */ }
    const running = loaded.get(key)
    if (running) loadFailures.delete(key)
    const failure = failures.get(filePath) ?? loadFailures.get(key)
    const peek = peekBootStatusCached(filePath)
    const boot = peek.status
    if (!boot || !peek.config) {
      if (running) return { filePath, name: running.name, agentId: running.id, status: 'loaded', autostart: false, reviewed: true }
      return {
        filePath,
        name: fallbackName,
        status: 'unreadable',
        autostart: false,
        reviewed: false,
        error: peek.error ? `Not a readable .adf: ${peek.error}` : 'Not a readable .adf.',
      }
    }
    const reviewed = isConfigReviewed(reviewedRaw, peek.config)
    const base = { filePath, name: boot.agentName || fallbackName, agentId: running?.id ?? boot.agentId, autostart: boot.autostart, reviewed }
    if (running) return { ...base, status: 'loaded' }
    const status: FolderAgentStatus = boot.hasEncryptedIdentity
      ? 'password_protected'
      : !reviewed ? 'needs_review' : boot.autostart ? 'stopped' : 'not_autostart'
    return failure ? { ...base, status, error: failure } : { ...base, status }
  })
}

/** The stored entry for `raw`: the exact string first (a missing folder cannot be canonicalized), then the same folder under any spelling. */
function storedMatch(existing: string[], raw: string): string | undefined {
  return existing.find(d => d === raw) ?? (isAbsolute(raw) ? existing.find(d => sameDir(d, raw)) : undefined)
}

/** GET /tracked-dirs/agents: the agents in one tracked folder and where each stands. */
export function listFolderAgents(runtime: RuntimeService, settings: TrackedDirsSettings, input: unknown): FolderAgentsList {
  if (typeof input !== 'string' || input.trim() === '') throw new TrackedDirError('path is required', 400)
  const raw = input.trim()
  const match = storedMatch(storedDirs(settings), raw)
  if (match === undefined) throw new TrackedDirError(`Not a tracked folder: ${raw}`, 404)
  return { path: match, agents: folderAgents(runtime, settings, match, maxDepthOf(settings)) }
}

/**
 * GET /tracked-dirs/agents/all: every tracked folder with its agents and
 * where each stands (one scan per folder; peeks are cached by mtime).
 */
export function listTrackedAgents(runtime: RuntimeService, settings: TrackedDirsSettings): TrackedAgentsList {
  const maxDepth = maxDepthOf(settings)
  return {
    maxDepth,
    folders: storedDirs(settings).map(dir => {
      const agents = folderAgents(runtime, settings, dir, maxDepth)
      return {
        path: dir,
        exists: isDirectory(dir),
        agentCount: agents.length,
        loadedCount: agents.filter(a => a.status === 'loaded').length,
        agents,
      }
    }),
  }
}

function describe(runtime: RuntimeService, dir: string, maxDepth: number): TrackedDirEntry {
  const exists = isDirectory(dir)
  return {
    path: dir,
    exists,
    agentCount: exists ? runtime.scanAdfFiles([dir], maxDepth).length : 0,
    loadedCount: loadedUnder(runtime, dir).length,
  }
}

export function listTrackedDirs(runtime: RuntimeService, settings: TrackedDirsSettings): TrackedDirsList {
  const maxDepth = maxDepthOf(settings)
  return { maxDepth, directories: storedDirs(settings).map(dir => describe(runtime, dir, maxDepth)) }
}

/**
 * Track `input` now: validate, persist (settings.trackedDirectories), tell the
 * live daemon (`onChanged` → mesh tracked roots), then run the autostart pass
 * over it — review gate and all, exactly as at boot.
 */
export async function trackDir(
  runtime: RuntimeService,
  settings: TrackedDirsSettings,
  input: unknown,
  onChanged?: (dirs: string[]) => void,
): Promise<TrackDirResult> {
  if (!settings.set) throw new TrackedDirError('Settings store is read-only.', 405)
  if (typeof input !== 'string' || input.trim() === '') throw new TrackedDirError('path is required', 400)
  const raw = input.trim()
  if (!isAbsolute(raw)) throw new TrackedDirError('path must be an absolute path.', 400)
  if (!existsSync(raw)) throw new TrackedDirError(`path does not exist: ${raw}`, 400)
  if (!isDirectory(raw)) throw new TrackedDirError(`path is not a directory: ${raw}`, 400)
  const dir = canonicalizePath(raw)

  const existing = storedDirs(settings)
  const coveredBy = existing.find(d => { try { return isSameOrSubPath(d, dir) } catch { return false } })
  if (coveredBy !== undefined) {
    const same = sameDir(coveredBy, dir)
    throw new TrackedDirError(
      same ? `Already tracked: ${coveredBy}` : `Already tracked through its parent folder ${coveredBy}`,
      409,
      { coveredBy },
    )
  }
  const absorbed = existing.filter(d => { try { return isSameOrSubPath(dir, d) } catch { return false } })
  const directories = [...existing.filter(d => !absorbed.includes(d)), dir]
  settings.set('trackedDirectories', directories)
  onChanged?.(directories)

  const maxDepth = maxDepthOf(settings)
  const autostart = await runtime.autostartFromDirectories([dir], { maxDepth })
  noteAutostartReport(autostart)
  const failures = new Map(autostart.failed.map(f => [f.filePath, f.error] as const))
  return {
    entry: describe(runtime, dir, maxDepth),
    directories,
    absorbed,
    autostart,
    needsReview: autostart.skipped.filter(s => s.reason === 'unreviewed'),
    agents: folderAgents(runtime, settings, dir, maxDepth, failures),
  }
}

/** Untrack `input` (never deletes files). `unload` also unloads the agents loaded from under it. */
export async function untrackDir(
  runtime: RuntimeService,
  settings: TrackedDirsSettings,
  input: unknown,
  opts: { unload?: boolean } = {},
  onChanged?: (dirs: string[]) => void,
): Promise<UntrackDirResult> {
  if (!settings.set) throw new TrackedDirError('Settings store is read-only.', 405)
  if (typeof input !== 'string' || input.trim() === '') throw new TrackedDirError('path is required', 400)
  const raw = input.trim()
  const existing = storedDirs(settings)
  const match = storedMatch(existing, raw)
  if (match === undefined) throw new TrackedDirError(`Not a tracked folder: ${raw}`, 404)

  const directories = existing.filter(d => d !== match)
  settings.set('trackedDirectories', directories)
  onChanged?.(directories)

  const unloaded: UntrackDirResult['unloaded'] = []
  if (opts.unload) {
    for (const agent of loadedUnder(runtime, match)) {
      await runtime.unloadAgent(agent.agentId)
      unloaded.push(agent)
    }
  }
  return { removed: match, directories, unloaded }
}
