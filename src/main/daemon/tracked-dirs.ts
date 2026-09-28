/**
 * Tracked agent folders over the daemon API — Studio's TRACKED_DIRS_* IPC
 * (ipc/index.ts) without the native dialog. The list lives in settings
 * `trackedDirectories` (string[]), exactly where Studio and the daemon boot
 * read it; tracking never touches the files themselves.
 */

import { existsSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
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
}

export interface UntrackDirResult {
  removed: string
  directories: string[]
  unloaded: Array<{ agentId: string; filePath: string; name: string }>
}

/** Caller-visible failure; `statusCode` is the HTTP status to answer with. */
export class TrackedDirError extends Error {
  constructor(message: string, readonly statusCode: 400 | 404 | 405 | 409, readonly details?: Record<string, unknown>) {
    super(message)
    this.name = 'TrackedDirError'
  }
}

function storedDirs(settings: TrackedDirsSettings): string[] {
  const raw = settings.get('trackedDirectories')
  return Array.isArray(raw) ? raw.filter((d): d is string => typeof d === 'string' && d.length > 0) : []
}

function maxDepthOf(settings: TrackedDirsSettings): number {
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
  return {
    entry: describe(runtime, dir, maxDepth),
    directories,
    absorbed,
    autostart,
    needsReview: autostart.skipped.filter(s => s.reason === 'unreviewed'),
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
  // Exact stored string first (a folder that no longer exists cannot be
  // canonicalized to match), then the same folder under any spelling.
  const match = existing.find(d => d === raw) ?? (isAbsolute(raw) ? existing.find(d => sameDir(d, raw)) : undefined)
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
