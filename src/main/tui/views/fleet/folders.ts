// Tracked agent folders (the daemon's settings.trackedDirectories — Studio's
// tracked directories). Tracking a folder loads its autostart agents right
// away through the daemon's autostart pass (review gate included); untracking
// never touches files and, only when asked, unloads the folder's agents.
// After tracking (and on Enter in Runtime › Folders) the folder's agents are
// listed with where each stands: loaded, needs review (review + accept + load
// from the list), not autostart, or not loaded with the daemon's error.

import { DaemonError, type FolderAgent, type TrackDirResult, type TrackedDirEntry, type UntrackDirResult } from '../../api/types'
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

/** One line for the toast: what tracking the folder did (the folder dialog has the detail). */
export function describeTrack(result: TrackDirResult): { text: string; level: 'success' | 'warn' } {
  const started = result.autostart.started.length
  const review = result.needsReview.length
  const failed = result.autostart.failed.length
  const parts = [
    `Tracking ${result.entry.path}`,
    `${plural(result.entry.agentCount, 'agent')} found`,
    `loaded ${started}`,
    review ? `${review} need${review === 1 ? 's' : ''} review` : '',
    failed ? `${failed} failed to load` : '',
    result.absorbed.length ? `now covers ${plural(result.absorbed.length, 'tracked subfolder')}` : '',
  ].filter(Boolean)
  return { text: parts.join(' · '), level: review || failed ? 'warn' : 'success' }
}

/** Props of the folder-agents view of the Track dialog (`TRACK_OVERLAY` with `folder`). */
export interface FolderOverlayProps {
  folder: string
  /** From a track that just happened: shown first (the dialog then re-reads from the daemon). */
  result?: TrackDirResult
}

/** Show a tracked folder's agents (what loaded, what needs review, errors). */
export function openFolderAgents(store: TuiStore, folder: string, result?: TrackDirResult): void {
  const props: FolderOverlayProps = { folder, ...(result ? { result } : {}) }
  store.actions.pushOverlay({ kind: TRACK_OVERLAY, props: props as unknown as Record<string, unknown> })
}

/** A short label for where an agent in a tracked folder stands. */
export function folderAgentLabel(agent: FolderAgent): string {
  switch (agent.status) {
    case 'loaded': return 'loaded'
    case 'needs_review': return 'needs review'
    case 'not_autostart': return agent.error ? 'failed to load' : 'not autostart'
    case 'stopped': return agent.error ? 'failed to load' : 'not loaded'
    case 'password_protected': return 'password-protected'
    case 'unreadable': return 'unreadable'
  }
}

/** What Enter does for this agent, in words (the dialog's next-step line). */
export function folderAgentNextStep(agent: FolderAgent): string {
  switch (agent.status) {
    case 'loaded': return 'Enter opens its chat.'
    case 'needs_review': return `Not reviewed on this daemon yet, so it was not loaded${agent.autostart ? ' (it is set to autostart)' : ''}. Enter reviews it: see what it can do, then accept and load it.`
    case 'not_autostart': return 'Not set to autostart, so it does not load on its own. Enter loads it now.'
    case 'stopped': return agent.error ? 'Enter tries to load it again.' : 'Set to autostart but not loaded (stopped). Enter loads and starts it.'
    case 'password_protected': return 'Its identity is password-protected, so autostart skips it. Load it with /load <file> and unlock it.'
    case 'unreadable': return 'Not a loadable agent file.'
  }
}

/** "4 agents: 1 loaded · 1 needs review · …" */
export function folderAgentsSummary(agents: FolderAgent[]): string {
  if (agents.length === 0) return 'No agent files (.adf) in this folder.'
  const counts = new Map<string, number>()
  for (const a of agents) counts.set(folderAgentLabel(a), (counts.get(folderAgentLabel(a)) ?? 0) + 1)
  const order = ['loaded', 'needs review', 'failed to load', 'not loaded', 'not autostart', 'password-protected', 'unreadable']
  const parts = order.filter(l => counts.get(l)).map(l => `${counts.get(l)} ${l}`)
  return `${plural(agents.length, 'agent')}: ${parts.join(' · ')}`
}

export type FolderLoadOutcome = { ok: true; agentId: string } | { ok: false; error: string }

/**
 * Load one agent of a tracked folder: accept its review first when asked
 * (the owner saw the summary), load with the review gate on, and start it
 * when it is set to autostart (what tracking does for reviewed agents).
 */
export async function loadFolderAgent(store: TuiStore, agent: FolderAgent, options: { accept?: boolean } = {}): Promise<FolderLoadOutcome> {
  try {
    if (options.accept) await store.client.acceptReview(agent.filePath)
    const ref = await store.client.load(agent.filePath, true)
    const name = ref.config?.handle || ref.config?.name || agent.name
    let started = ''
    if (agent.autostart) {
      try {
        await store.client.start(ref.id)
        started = ' and started it'
      } catch (err) {
        started = ` (start failed: ${err instanceof Error ? err.message : String(err)})`
      }
    }
    store.actions.toast(`${options.accept ? 'Reviewed and loaded' : 'Loaded'} ${name}${started}`, started.startsWith(' (') ? 'warn' : 'success', 5000)
    writeFolders(store, {}, true)
    await store.actions.refreshAgents()
    return { ok: true, agentId: ref.id }
  } catch (err) {
    if (err instanceof DaemonError && err.unreachable) store.dispatch({ type: 'daemon/reachable', reachable: false })
    const reviewRequired = err instanceof DaemonError && err.status === 403
    const error = reviewRequired ? 'It needs review first.' : err instanceof Error ? err.message : String(err)
    store.actions.toast(`Load ${agent.name}: ${error}`, 'error', 6000)
    return { ok: false, error }
  }
}

export type TrackOutcome =
  | { ok: true; result: TrackDirResult }
  /** `inline`: a problem with the path the user can fix in the dialog (400 / 409). */
  | { ok: false; error: string; inline: boolean }

/** Track a folder; reports success as a toast, returns path problems for the dialog to show. */
export async function trackFolder(store: TuiStore, path: string, options: { toastProblems?: boolean; showAgents?: boolean } = {}): Promise<TrackOutcome> {
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
  // What loaded, what needs review and why the rest did not: a list the owner
  // can act on (older daemons send no `agents`; the dialog then asks for them).
  // Nothing to act on (all loaded, or no agents): the toast says it all.
  const attention = result.agents
    ? result.agents.some(a => a.status !== 'loaded')
    : result.needsReview.length > 0 || result.autostart.failed.length > 0
  if (options.showAgents !== false && attention) openFolderAgents(store, result.entry.path, result)
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
