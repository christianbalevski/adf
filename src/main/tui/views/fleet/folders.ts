// Tracked agent folders (the daemon's settings.trackedDirectories — Studio's
// tracked directories). Tracking a folder loads its autostart agents right
// away through the daemon's autostart pass (review gate included); untracking
// never touches files and, only when asked, unloads the folder's agents.

import { DaemonError, type TrackDirResult, type TrackedDirEntry, type UntrackDirResult } from '../../api/types'
import type { TuiStore } from '../../state/store'
import type { TuiState } from '../../state/types'
import { completePath, type PathCompletionOptions } from './model'

export const TRACK_OVERLAY = 'fleet.track'
export const UNTRACK_OVERLAY = 'fleet.untrack'

/** viewState key: the last known tracked folders (+ a revision bumped on every change, so pages reload). */
export const FOLDERS_STATE_KEY = 'fleet.folders'

export interface FoldersCache {
  rev: number
  /** Last list read from the daemon (null = never read). */
  directories: TrackedDirEntry[] | null
  at?: number
}

export function readFolders(state: Pick<TuiState, 'viewState'>): FoldersCache {
  const raw = state.viewState[FOLDERS_STATE_KEY] as Partial<FoldersCache> | undefined
  return { rev: raw?.rev ?? 0, directories: raw?.directories ?? null, at: raw?.at }
}

function writeFolders(store: TuiStore, patch: Partial<FoldersCache>, bump: boolean): void {
  const current = readFolders(store.getState())
  store.actions.setViewState(FOLDERS_STATE_KEY, { ...current, ...patch, rev: current.rev + (bump ? 1 : 0) })
}

/** Read the tracked folders into the cache (for completion and the Runtime › Folders tab). */
export async function loadFolders(store: TuiStore): Promise<TrackedDirEntry[]> {
  const { directories } = await store.client.trackedDirs()
  writeFolders(store, { directories, at: Date.now() }, false)
  return directories
}

let inflight: Promise<unknown> | null = null
/** Completion is synchronous: answer from the cache, refresh it in the background. */
export function completeTrackedFolders(store: TuiStore, partial: string): string[] {
  const cache = readFolders(store.getState())
  if (!inflight && (!cache.at || Date.now() - cache.at > 5000)) {
    inflight = loadFolders(store).catch(() => undefined).finally(() => { inflight = null })
  }
  const q = partial.trim().toLowerCase()
  return (cache.directories ?? []).map(d => d.path).filter(p => p.toLowerCase().startsWith(q) || p.toLowerCase().includes(q))
}

/** Directory-only Tab completion (the Track dialog and `/track`). */
export function completeFolder(input: string, options: PathCompletionOptions = {}) {
  return completePath(input, { ...options, dirsOnly: true })
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** One line for the toast: what tracking the folder did. */
export function describeTrack(result: TrackDirResult): { text: string; level: 'success' | 'warn' } {
  const started = result.autostart.started.length
  const review = result.needsReview.length
  const failed = result.autostart.failed.length
  const parts = [
    `Tracking ${result.entry.path}`,
    `${plural(result.entry.agentCount, 'agent')} found`,
    `loaded ${started}`,
    review ? `${review} need${review === 1 ? 's' : ''} review (${result.needsReview.map(r => r.name).join(', ')}: /load <file> --review)` : '',
    failed ? `${failed} failed (${result.autostart.failed.map(f => `${f.name}: ${f.error}`).join('; ')})` : '',
    result.absorbed.length ? `now covers ${plural(result.absorbed.length, 'tracked subfolder')}` : '',
  ].filter(Boolean)
  return { text: parts.join(' · '), level: review || failed ? 'warn' : 'success' }
}

export type TrackOutcome =
  | { ok: true; result: TrackDirResult }
  /** `inline`: a problem with the path the user can fix in the dialog (400 / 409). */
  | { ok: false; error: string; inline: boolean }

/** Track a folder; reports success as a toast, returns path problems for the dialog to show. */
export async function trackFolder(store: TuiStore, path: string, options: { toastProblems?: boolean } = {}): Promise<TrackOutcome> {
  let result: TrackDirResult
  try {
    result = await store.client.trackDir(path)
  } catch (err) {
    if (err instanceof DaemonError && err.unreachable) store.dispatch({ type: 'daemon/reachable', reachable: false })
    const error = err instanceof Error ? err.message : String(err)
    const inline = err instanceof DaemonError && (err.status === 400 || err.status === 409)
    if (!inline || options.toastProblems) store.actions.toast(`Track folder: ${error}`, err instanceof DaemonError && err.status === 409 ? 'warn' : 'error', 6000)
    return { ok: false, error, inline }
  }
  const { text, level } = describeTrack(result)
  store.actions.toast(text, level, 8000)
  writeFolders(store, { directories: null, at: undefined }, true)
  await store.actions.refreshAgents()
  return { ok: true, result }
}

/** Stop tracking a folder (files untouched); `unload` also unloads its agents. */
export async function untrackFolder(store: TuiStore, path: string, unload: boolean): Promise<UntrackDirResult | null> {
  try {
    const result = await store.client.untrackDir(path, { unload })
    const names = result.unloaded.map(a => a.name).join(', ')
    store.actions.toast(
      `Stopped tracking ${result.removed}${unload ? ` · unloaded ${result.unloaded.length}${names ? ` (${names})` : ''}` : ' · its agents keep running'}`,
      'success',
      6000,
    )
    writeFolders(store, { directories: null, at: undefined }, true)
    if (result.unloaded.length) await store.actions.refreshAgents()
    return result
  } catch (err) {
    if (err instanceof DaemonError && err.unreachable) store.dispatch({ type: 'daemon/reachable', reachable: false })
    store.actions.toast(`Untrack folder: ${err instanceof Error ? err.message : String(err)}`, 'error', 6000)
    return null
  }
}

/** Open the untrack dialog (asks; offers to unload the folder's agents). */
export function askUntrack(store: TuiStore, path: string): void {
  store.actions.pushOverlay({ kind: UNTRACK_OVERLAY, props: { path } })
}
