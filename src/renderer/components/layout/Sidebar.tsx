import { useState, useEffect, useMemo, useCallback, useRef, memo } from 'react'
import { useAppStore } from '../../stores/app.store'
import { useDocumentStore } from '../../stores/document.store'
import { useMessageQueueStore } from '../../stores/message-queue.store'
import { useAgentStore } from '../../stores/agent.store'
import { useAdfFile } from '../../hooks/useAdfFile'
import { useTrackedDirs, useAutoRefresh } from '../../hooks/useTrackedDirs'
import { useTrackedDirsStore } from '../../stores/tracked-dirs.store'
import { useMeshStore } from '../../stores/mesh.store'
import { useBackgroundAgentsStore } from '../../stores/background-agents.store'
import { toDisplayState } from '../../hooks/useAgent'
import { startForegroundAgent } from '../../utils/start-agent'
import { useShareDrag } from '../../hooks/useShareDrag'
import { useDragResize } from '../../hooks/useDragResize'
import { useKeyboardContextMenu } from '../../hooks/useKeyboardContextMenu'
import { ContextMenu, type ContextMenuItem } from '../common/ContextMenu'
import { agentWindowsAvailable, openAgentWindow } from '../../utils/window-kind'
import { Tooltip } from '../common/Tooltip'
import { HoverLabel } from '../common/HoverLabel'
import { RemoteMark } from '../common/RemoteMark'
import { CloneDialog } from '../common/CloneDialog'
import { Dialog } from '../common/Dialog'
import { Button } from '../ui'
import { IS_MAC, REVEAL_IN_FOLDER_LABEL } from '../../utils/platform'
import { ACCELERATORS, formatKey } from '../../../shared/constants/keyboard-shortcuts'
import { collectRunningAgents, collectRailAgents, type RunningAgentRow } from '../../utils/running-agents'
import { useApprovalsStore } from '../../stores/approvals.store'
import { reportFailure, agentNameOf, failureReason } from '../../stores/failure-notices.store'
import { useInAgentWindow, useTrackAgentWindows } from '../../stores/open-agent-windows.store'
import { SIDEBAR_RUNNING_CAP_KEY, loadStoredSize, saveStoredSize } from '../../utils/stored-size'
import { OrbitalAvatar, useAgentAvatarMode } from '../orbital/OrbitalAvatar'
import { orbitalSeedFor } from '../orbital/orbital-seed'
import type { AgentState, MeshAgentStatus, BackgroundAgentStatus } from '../../../shared/types/ipc.types'
import type { TrackedDirEntry } from '../../../shared/types/ipc.types'
import type { RuntimeView } from '../../../shared/types/connection.types'
import { LOCAL_RUNTIME, type RuntimeId } from '../../../shared/runtime-tag'
import { agentKey } from '../../../shared/types/agent-ref'
import { apiFor, openApi } from '../../utils/runtime-api'
import { runtimeHeader, useMultiRuntime, useRuntimes } from '../../stores/runtimes.store'
import { selectTrackedSlice } from '../../stores/tracked-dirs.store'
import { selectBackgroundAgents } from '../../stores/background-agents.store'
import { selectMeshSlice } from '../../stores/mesh.store'
import { trackedDirsActions } from '../../hooks/useTrackedDirs'
import { CONNECTION_STATE_LABELS } from '../../../shared/types/connection.types'

/** A runtime other than This computer: its rows, calls and keys name it (docs/design/multi-runtime.md §5.2). Omitted: This computer. */
type RowRuntime = RuntimeId | undefined

/** The key of an agent of `runtimeId` in the spinner sets, queues and maps: its path on This computer. */
const rowKey = (runtimeId: RowRuntime, filePath: string): string => agentKey({ runtimeId, filePath })

/** Why another runtime's row does not drag out (multi-runtime.md §8.3): a drag-out is a file of this computer. */
export const REMOTE_DRAG_TIP = 'Drag out: Local only'

/**
 * Keep only entries whose name (file name, agent display name, or path
 * relative to the tracked directory) contains `query`. Directories survive
 * only if something below them matches. `query` must already be lowercased.
 */
function filterTree(entries: TrackedDirEntry[], query: string, rootPath: string): TrackedDirEntry[] {
  const out: TrackedDirEntry[] = []
  for (const entry of entries) {
    if (entry.isDirectory) {
      const children = filterTree(entry.children || [], query, rootPath)
      if (children.length > 0) out.push({ ...entry, children })
      continue
    }
    const relPath = entry.filePath.startsWith(rootPath)
      ? entry.filePath.slice(rootPath.length + 1)
      : entry.filePath
    const haystack = `${entry.fileName}\n${entry.pendingName ?? ''}\n${relPath}`.toLowerCase()
    if (haystack.includes(query)) out.push(entry)
  }
  return out
}

/**
 * Start every non-running agent in `files`, one at a time. All queued paths are
 * marked as starting up front so the sidebar shows a spinner on each pending
 * agent immediately, not just the one currently being started.
 */
async function startAgentsSequentially(
  files: TrackedDirEntry[],
  currentFilePath: string | null,
  foregroundRunning: boolean,
  backgroundAgentMap: Map<string, BackgroundAgentStatus>,
  runtimeId?: RowRuntime
): Promise<void> {
  const app = useAppStore.getState()
  const toStart = files.filter((f) =>
    f.filePath === currentFilePath ? !foregroundRunning : !backgroundAgentMap.has(f.filePath)
  )
  for (const file of toStart) app.addStartingFilePath(rowKey(runtimeId, file.filePath))
  try {
    // One failure is shown and the rest still start.
    for (const file of toStart) {
      const name = file.agentName ?? agentNameOf(file.filePath)
      try {
        if (file.filePath === currentFilePath) {
          const result = await openApi().startAgent()
          if (result.success) {
            useAgentStore.getState().setState(toDisplayState(result.agentState ?? 'idle'))
          } else {
            reportFailure(`${name} did not start`, result.error)
          }
        } else {
          const result = await apiFor(runtimeId).startBackgroundAgent(file.filePath)
          if (!result.success) reportFailure(`${name} did not start`, result.error)
        }
      } catch (err) {
        reportFailure(`${name} did not start`, err)
      } finally {
        app.removeStartingFilePath(rowKey(runtimeId, file.filePath))
      }
    }
  } finally {
    for (const file of toStart) app.removeStartingFilePath(rowKey(runtimeId, file.filePath))
  }
}

/**
 * Stop every running agent in `files`, one at a time, marking all of them as
 * stopping up front so each pending shutoff is visible immediately. A stop
 * that fails is shown (unless `report` is off) and the rest still stop; the
 * failures are returned.
 */
async function stopAgentsSequentially(
  files: TrackedDirEntry[],
  currentFilePath: string | null,
  backgroundAgentMap: Map<string, BackgroundAgentStatus>,
  { report = true, runtimeId }: { report?: boolean; runtimeId?: RowRuntime } = {}
): Promise<string[]> {
  const failures: string[] = []
  const app = useAppStore.getState()
  const toStop = files.filter((f) =>
    f.filePath === currentFilePath || backgroundAgentMap.has(f.filePath)
  )
  for (const file of toStop) app.addStoppingFilePath(rowKey(runtimeId, file.filePath))
  try {
    for (const file of toStop) {
      try {
        if (file.filePath === currentFilePath) {
          await openApi().stopAgent()
          useAgentStore.getState().setState('off')
        } else {
          await apiFor(runtimeId).stopBackgroundAgent(file.filePath)
        }
      } catch (err) {
        const what = `${file.agentName ?? agentNameOf(file.filePath)} did not stop`
        failures.push(what)
        if (report) reportFailure(what, err)
        else console.warn(`[Sidebar] ${what}:`, err)
      } finally {
        app.removeStoppingFilePath(rowKey(runtimeId, file.filePath))
      }
    }
  } finally {
    for (const file of toStop) app.removeStoppingFilePath(rowKey(runtimeId, file.filePath))
  }
  return failures
}

/**
 * Review gate for starting the FOREGROUND agent. Opens the review dialog and
 * returns true when the agent must be reviewed before it may start; a failed
 * check falls through to false so a flaky IPC never blocks the toggle.
 */
async function needsReviewBeforeStart(isActive: boolean): Promise<boolean> {
  if (!isActive) return false
  try {
    const review = await openApi().checkAgentReview()
    if (review?.needsReview) {
      useAppStore.getState().setAgentReviewDialog(true, review.configSummary)
      return true
    }
  } catch { /* fall through */ }
  return false
}

/**
 * Start or stop one agent. The foreground file goes through the foreground
 * start/stop API and mirrors the result into the agent store; every other
 * file uses the background manager. The starting/stopping path sets drive the
 * row spinner for the duration.
 */
async function toggleAgent(filePath: string, isActive: boolean, isRunning: boolean, name: string = agentNameOf(filePath), runtimeId?: RowRuntime): Promise<void> {
  const app = useAppStore.getState()
  const key = rowKey(runtimeId, filePath)
  const api = apiFor(runtimeId)
  if (isRunning) app.addStoppingFilePath(key)
  else app.addStartingFilePath(key)
  try {
    if (isActive) {
      if (isRunning) {
        await openApi().stopAgent()
        useAgentStore.getState().setState('off')
      } else {
        await startForegroundAgent({ skipReviewGate: true })
      }
    } else if (isRunning) {
      await api.stopBackgroundAgent(filePath)
    } else {
      let result = await api.startBackgroundAgent(filePath)
      // Same provider-at-need as the foreground path: connect one, retry once.
      // The sheet sets up This computer's providers: another runtime's refusal is said as it is.
      let cancelled = false
      if (!runtimeId && !result.success && (result.code === 'provider_missing' || result.code === 'provider_unconfigured')) {
        const connected = await app.requestProviderSetup(result.code, filePath)
        if (connected) result = await api.startBackgroundAgent(filePath)
        else cancelled = true
      }
      // A background agent has no chat on screen: the reason is shown here.
      if (!result.success && !cancelled) reportFailure(`${name} did not start`, result.error)
    }
  } catch (err) {
    // The foreground start reports in its chat and does not throw; this is a stop, or the IPC itself.
    reportFailure(`${name} did not ${isRunning ? 'stop' : 'start'}`, err)
  } finally {
    if (isRunning) app.removeStoppingFilePath(key)
    else app.removeStartingFilePath(key)
  }
}

/** Same localStorage idiom as the chat placement pref: best-effort, non-fatal. */
const RUNNING_COLLAPSED_KEY = 'adf-sidebar-running-collapsed'

function loadRunningCollapsed(): boolean {
  try {
    return localStorage.getItem(RUNNING_COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * The Running list's height is a cap, not a size: the list is as tall as its
 * rows until it reaches the cap, then scrolls. Dragging the section's bottom
 * edge moves the cap. The default is the old fixed `max-h-36`, about six rows.
 */
const RUNNING_CAP_DEFAULT = 144
const RUNNING_CAP_STORED_MAX = 4000
const RUNNING_ROW_FALLBACK = 22
/** Height the agent tree always keeps, however far the Running list is dragged. */
const TREE_MIN_HEIGHT = 120

function saveRunningCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(RUNNING_COLLAPSED_KEY, collapsed ? '1' : '0')
  } catch { /* storage full/unavailable — the pref just won't stick */ }
}

/**
 * Folder open/closed state survives restarts the same way. Stored as the set
 * of COLLAPSED paths: a newly tracked folder opens without needing an entry,
 * and the set stays as small as the number of folders the user closed.
 */
const COLLAPSED_FOLDERS_KEY = 'adf-sidebar-collapsed-folders'

function loadCollapsedFolders(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_FOLDERS_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : [])
  } catch {
    return new Set()
  }
}

function saveFolderCollapsed(path: string, collapsed: boolean): void {
  try {
    const set = loadCollapsedFolders()
    if (collapsed) set.add(path)
    else set.delete(path)
    localStorage.setItem(COLLAPSED_FOLDERS_KEY, JSON.stringify([...set]))
  } catch { /* storage full/unavailable — the pref just won't stick */ }
}

/** Expanded flag for one folder row, read once on mount and written on toggle. */
function useFolderExpanded(path: string): [boolean, () => void] {
  const [expanded, setExpanded] = useState(() => !loadCollapsedFolders().has(path))
  const toggle = useCallback(() => {
    setExpanded((p) => {
      saveFolderCollapsed(path, p)
      return !p
    })
  }, [path])
  return [expanded, toggle]
}

interface RowTarget {
  file: TrackedDirEntry
  dirPath: string
  /** The row's runtime; omitted for This computer. */
  runtimeId?: RowRuntime
}

/** A row's context menu: the row's file, its tracked root and (another runtime than This computer) its runtime. */
/** Open a row's agent on its runtime (omitted: This computer). */
type OpenFileHandler = (filePath: string, runtimeId?: RowRuntime) => void

type FileContextMenuHandler = (e: React.MouseEvent, file: TrackedDirEntry, dirPath: string, runtimeId?: RowRuntime) => void

/** No runtime besides This computer: the sidebar is the one before. */
const NO_RUNTIMES: RuntimeView[] = []

/** Shared empty list so a leaf TreeNode's memo stays identity-stable. */
const EMPTY_ENTRIES: TrackedDirEntry[] = []

/** Every non-directory entry under one node, depth-first. */
function collectSubtreeFiles(node: TrackedDirEntry): TrackedDirEntry[] {
  if (!node.isDirectory) return [node]
  const out: TrackedDirEntry[] = []
  const walk = (entries: TrackedDirEntry[]) => {
    for (const e of entries) {
      if (e.isDirectory) walk(e.children || [])
      else out.push(e)
    }
  }
  walk(node.children || [])
  return out
}

/**
 * Keeps a derived Map referentially stable while its contents are unchanged.
 * The mesh and background stores hand out a fresh agent array on every event;
 * a new Map per event would invalidate every memo'd tree row for nothing.
 */
function useStableMap<V>(entries: [string, V][]): Map<string, V> {
  const mapRef = useRef<Map<string, V> | undefined>(undefined)
  const srcRef = useRef<[string, V][] | undefined>(undefined)
  if (!mapRef.current || srcRef.current !== entries) {
    srcRef.current = entries
    const next = new Map(entries)
    const prev = mapRef.current
    let same = prev !== undefined && prev.size === next.size
    if (same && prev) {
      for (const [k, v] of next) {
        if (prev.get(k) !== v) { same = false; break }
      }
    }
    if (!same) mapRef.current = next
  }
  return mapRef.current!
}

export function Sidebar() {
  const collapsed = useAppStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useAppStore((s) => s.toggleSidebar)
  const showSettings = useAppStore((s) => s.showSettings)
  const setShowSettings = useAppStore((s) => s.setShowSettings)
  const showMeshGraph = useAppStore((s) => s.showMeshGraph)
  const setShowMeshGraph = useAppStore((s) => s.setShowMeshGraph)
  // The open agent and its runtime. `filePath` is This computer's open agent, the one
  // its tree marks: null while the open agent is on another runtime (multi-runtime.md §1.3).
  const openPath = useDocumentStore((s) => s.filePath)
  const openRuntime = useDocumentStore((s) => s.runtimeId)
  const filePath = openRuntime === LOCAL_RUNTIME ? openPath : null
  const showHome = useAppStore((s) => s.showHome)
  const setShowHome = useAppStore((s) => s.setShowHome)
  const { openFile, createFile, closeFile } = useAdfFile()
  // Which agents have their own window (daemon mode), for the row marker.
  useTrackAgentWindows()
  const { loadDirectories, rescanDirectory, removeDirectory, addDirectory } = useTrackedDirs()
  const directories = useTrackedDirsStore((s) => s.directories)
  const filesByDir = useTrackedDirsStore((s) => s.filesByDir)

  useAutoRefresh()

  useEffect(() => {
    loadDirectories()
  }, [])

  const foregroundAgentState = useAgentStore((s) => s.state)

  const meshEnabled = useMeshStore((s) => s.enabled)
  const meshAgents = useMeshStore((s) => s.agents)
  const agentStatusMap = useStableMap(
    useMemo(() => meshAgents.map((a) => [a.filePath, a] as [string, MeshAgentStatus]), [meshAgents])
  )
  const backgroundAgents = useBackgroundAgentsStore((s) => s.agents)
  const backgroundAgentMap = useStableMap(
    useMemo(
      () => backgroundAgents.map((a) => [a.filePath, a] as [string, BackgroundAgentStatus]),
      [backgroundAgents]
    )
  )
  const dirScrollRef = useRef<HTMLDivElement>(null)

  // Every runtime of the set while there is more than one (§5.4); none otherwise, so this
  // sidebar is exactly the one before.
  const multi = useMultiRuntime()
  const runtimes = useRuntimes()
  const remotes = useMemo(() => (multi ? runtimes.filter((r) => r.id !== LOCAL_RUNTIME) : NO_RUNTIMES), [multi, runtimes])
  const trackedByRuntime = useTrackedDirsStore((s) => s.byRuntime)
  const backgroundByRuntime = useBackgroundAgentsStore((s) => s.byRuntime)
  const meshByRuntime = useMeshStore((s) => s.byRuntime)

  const [agentSearch, setAgentSearch] = useState('')
  const searchQuery = agentSearch.trim().toLowerCase()
  const searching = searchQuery.length > 0
  const visibleFilesByDir = useMemo(() => {
    if (!searching) return filesByDir
    const out: Record<string, TrackedDirEntry[]> = {}
    for (const dirPath of directories) {
      out[dirPath] = filterTree(filesByDir[dirPath] ?? [], searchQuery, dirPath)
    }
    return out
  }, [searching, searchQuery, filesByDir, directories])
  const visibleDirectories = searching
    ? directories.filter((d) => (visibleFilesByDir[d]?.length ?? 0) > 0)
    : directories

  const startingPaths = useAppStore((s) => s.startingFilePaths)
  // Pinned "Running" list: every running agent across all roots, flat. Built
  // from the unfiltered trees so it does not depend on folder state; hidden
  // while searching because search already flattens the tree.
  const localRunningRows = useMemo(() => collectRunningAgents({
    directories,
    filesByDir,
    currentFilePath: filePath,
    // A running agent being opened is marked starting for the whole switch
    // (main takes it off the background list, then the foreground state is
    // reset to 'off'); counting it keeps its row and rail avatar in place
    // instead of leaving and coming back.
    foregroundRunning: foregroundAgentState !== 'off' || (filePath !== null && startingPaths.has(filePath)),
    isBackgroundRunning: (fp) => backgroundAgentMap.has(fp) || startingPaths.has(fp)
  }), [directories, filesByDir, filePath, foregroundAgentState, backgroundAgentMap, startingPaths])
  // Other runtimes' running agents follow, each named by its runtime (§5.4).
  const runningRows = useMemo(() => {
    if (remotes.length === 0) return localRunningRows
    const rows: RunningAgentRow[] = [...localRunningRows]
    for (const rt of remotes) {
      const slice = selectTrackedSlice({ directories: [], filesByDir: {}, byRuntime: trackedByRuntime }, rt.id)
      const background = new Set(selectBackgroundAgents({ agents: [], byRuntime: backgroundByRuntime }, rt.id).map((a) => a.filePath))
      const current = openRuntime === rt.id ? openPath : null
      for (const row of collectRunningAgents({
        directories: slice.directories,
        filesByDir: slice.filesByDir,
        currentFilePath: current,
        foregroundRunning: foregroundAgentState !== 'off' || (current !== null && startingPaths.has(rowKey(rt.id, current))),
        isBackgroundRunning: (fp) => background.has(fp) || startingPaths.has(rowKey(rt.id, fp)),
      })) {
        rows.push({ ...row, runtimeId: rt.id, folderHint: row.folderHint ? `${rt.name} · ${row.folderHint}` : rt.name })
      }
    }
    return rows
  }, [localRunningRows, remotes, trackedByRuntime, backgroundByRuntime, openRuntime, openPath, foregroundAgentState, startingPaths])
  // The Running list's lookups by agent key: This computer's by path, as before, then every other runtime's.
  const runningStatusMap = useStableMap(useMemo(() => {
    const entries: [string, MeshAgentStatus][] = meshAgents.map((a) => [a.filePath, a])
    for (const rt of remotes) for (const a of selectMeshSlice({ enabled: false, enabledRev: 0, agents: [], byRuntime: meshByRuntime }, rt.id).agents) entries.push([rowKey(rt.id, a.filePath), a])
    return entries
  }, [meshAgents, remotes, meshByRuntime]))
  const runningBackgroundMap = useStableMap(useMemo(() => {
    const entries: [string, BackgroundAgentStatus][] = backgroundAgents.map((a) => [a.filePath, a])
    for (const rt of remotes) for (const a of backgroundByRuntime[rt.id] ?? []) entries.push([rowKey(rt.id, a.filePath), a])
    return entries
  }, [backgroundAgents, remotes, backgroundByRuntime]))
  /** The open agent's key, which the Running list and the rail mark. */
  const openKey = openPath ? rowKey(openRuntime === LOCAL_RUNTIME ? undefined : openRuntime, openPath) : null
  // The collapsed rail: the same agents as avatars, plus the open one.
  const railAgents = useMemo(
    () => (collapsed ? collectRailAgents(runningRows, { directories, filesByDir, currentFilePath: filePath }) : []),
    [collapsed, runningRows, directories, filesByDir, filePath]
  )

  const handleOpenFile = useCallback((fp: string, runtimeId?: RowRuntime) => {
    const runtime = runtimeId ?? LOCAL_RUNTIME
    if (showSettings) setShowSettings(false)
    if (showMeshGraph) setShowMeshGraph(false)
    // The open agent, from Home: back to it, nothing is reopened.
    if (showHome && fp === openPath && runtime === openRuntime) { setShowHome(false); return }
    const scrollTop = dirScrollRef.current?.scrollTop ?? 0
    openFile(fp, runtime).then(() => {
      requestAnimationFrame(() => {
        if (dirScrollRef.current) {
          dirScrollRef.current.scrollTop = scrollTop
        }
      })
    })
  }, [openFile, showSettings, showMeshGraph, setShowSettings, setShowMeshGraph, showHome, openPath, openRuntime, setShowHome])

  const handleCreateFile = useCallback(async () => {
    const result = await createFile('Untitled')
    if (result?.success) setShowMeshGraph(false)
  }, [createFile, setShowMeshGraph])

  const handleOpenFromPicker = useCallback(async () => {
    const result = await openFile()
    if (result?.success) setShowMeshGraph(false)
  }, [openFile, setShowMeshGraph])

  // The folder button: open one agent file, or track a whole folder. A
  // small menu under the button; the File menu carries the same two.
  const [folderMenu, setFolderMenu] = useState<{ x: number; y: number } | null>(null)
  const openFolderMenu = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    setFolderMenu({ x: r.left, y: r.bottom + 4 })
  }, [])
  const closeFolderMenu = useCallback(() => setFolderMenu(null), [])
  const folderMenuItems = useMemo<ContextMenuItem[]>(() => [
    { label: 'Open agent…', onSelect: () => { void handleOpenFromPicker() } },
    { label: 'Track folder…', onSelect: () => { addDirectory().catch((err) => reportFailure('Folder not tracked', err)) } },
  ], [addDirectory, handleOpenFromPicker])

  // Row context menu + the dialogs it opens. One instance of each lives here,
  // keyed by the target file, instead of one per row.
  const [menu, setMenu] = useState<(RowTarget & { x: number; y: number }) | null>(null)
  // Right-click on a tracked folder's header row: its own short menu. This
  // is where a folder stops being tracked; nothing on the home screen lists
  // the folders any more.
  const [dirMenu, setDirMenu] = useState<{ dirPath: string; runtimeId?: RowRuntime; x: number; y: number } | null>(null)
  const [untrackTarget, setUntrackTarget] = useState<{ dirPath: string; runtimeId?: RowRuntime } | null>(null)
  const [renameTarget, setRenameTarget] = useState<RowTarget | null>(null)
  const updateFileEntry = useTrackedDirsStore((s) => s.updateFileEntry)

  // Every agent file under the folder about to be untracked, and which of
  // them run. An untracked folder has no rows, so nothing may keep running
  // from it: the confirm stops them all before the folder goes.
  // The folder's runtime: its tree, its running agents, and the open agent when it is on that runtime.
  const untrackRuntime = untrackTarget?.runtimeId
  const untrackSlice = untrackRuntime ? selectTrackedSlice({ directories, filesByDir, byRuntime: trackedByRuntime }, untrackRuntime) : { directories, filesByDir }
  const untrackCurrent = untrackRuntime ? (openRuntime === untrackRuntime ? openPath : null) : filePath
  const untrackBackground = useMemo(
    () => (untrackRuntime ? new Map((backgroundByRuntime[untrackRuntime] ?? []).map((a) => [a.filePath, a] as [string, BackgroundAgentStatus])) : backgroundAgentMap),
    [untrackRuntime, backgroundByRuntime, backgroundAgentMap]
  )
  const untrackFiles = useMemo(() => {
    if (!untrackTarget) return [] as TrackedDirEntry[]
    const root = untrackTarget.dirPath
    const out: TrackedDirEntry[] = []
    const walk = (entries: TrackedDirEntry[]) => {
      for (const e of entries) {
        if (e.isDirectory) walk(e.children ?? [])
        else out.push(e)
      }
    }
    for (const d of untrackSlice.directories) {
      if (d === root || d.startsWith(`${root}/`)) walk(untrackSlice.filesByDir[d] ?? [])
    }
    return out
  }, [untrackTarget, untrackSlice])
  const untrackRunning = useMemo(
    () => untrackFiles.filter((f) => (f.filePath === untrackCurrent ? foregroundAgentState !== 'off' : untrackBackground.has(f.filePath))),
    [untrackFiles, untrackCurrent, foregroundAgentState, untrackBackground]
  )
  const handleUntrack = useCallback(async () => {
    if (!untrackTarget) return
    const root = untrackTarget.dirPath
    // A folder whose agent did not stop stays tracked: its row is the only Stop left.
    const failed = await stopAgentsSequentially(untrackFiles, untrackCurrent, untrackBackground, { report: false, runtimeId: untrackRuntime })
    if (failed.length > 0) throw new Error(`${failed.join('; ')}. The folder is still tracked.`)
    // The open file is one of the rows about to vanish; close it so the
    // editor cannot start it again from a folder the sidebar no longer shows.
    if (untrackCurrent && (untrackCurrent === root || untrackCurrent.startsWith(`${root}/`))) await closeFile()
    // Tracked roots nested inside this one go with it.
    const remove = untrackRuntime ? trackedDirsActions(untrackRuntime).removeDirectory : removeDirectory
    for (const d of untrackSlice.directories) {
      if (d === root || d.startsWith(`${root}/`)) await remove(d)
    }
    setUntrackTarget(null)
  }, [untrackTarget, untrackFiles, untrackCurrent, untrackBackground, untrackRuntime, untrackSlice, closeFile, removeDirectory])

  /** Rescan a tracked root on its runtime. */
  const rescanOn = useCallback((dirPath: string, runtimeId?: RowRuntime) => (runtimeId ? trackedDirsActions(runtimeId).rescanDirectory(dirPath) : rescanDirectory(dirPath)), [rescanDirectory])

  const handleRenamed = useCallback(async (target: RowTarget, newPath: string, name: string, deferred: boolean) => {
    setRenameTarget(null)
    if (target.file.filePath === openPath && (target.runtimeId ?? LOCAL_RUNTIME) === openRuntime) {
      useDocumentStore.getState().setFilePath(newPath)
      const cfg = useAgentStore.getState().config
      if (cfg) useAgentStore.getState().setConfig({ ...cfg, name })
    }
    // A running agent's file cannot move until it stops. The row keeps the
    // file's name, which is still the old one, and shows the new one as
    // pending; the rescan below confirms either outcome from disk.
    if (deferred) updateFileEntry(newPath, { pendingName: name }, target.runtimeId)
    await rescanOn(target.dirPath, target.runtimeId)
  }, [openPath, openRuntime, rescanOn, updateFileEntry])
  const [cloneTarget, setCloneTarget] = useState<RowTarget | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<RowTarget | null>(null)
  const startingFilePaths = useAppStore((s) => s.startingFilePaths)
  const stoppingFilePaths = useAppStore((s) => s.stoppingFilePaths)

  const handleFileContextMenu = useCallback((e: React.MouseEvent, file: TrackedDirEntry, dirPath: string, runtimeId?: RowRuntime) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ file, dirPath, ...(runtimeId ? { runtimeId } : {}), x: e.clientX, y: e.clientY })
  }, [])
  const closeMenu = useCallback(() => setMenu(null), [])
  const handleDirContextMenu = useCallback((e: React.MouseEvent, dirPath: string, runtimeId?: RowRuntime) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu(null)
    setDirMenu({ dirPath, ...(runtimeId ? { runtimeId } : {}), x: e.clientX, y: e.clientY })
  }, [])
  const closeDirMenu = useCallback(() => setDirMenu(null), [])

  const dirMenuItems = useMemo<ContextMenuItem[]>(() => {
    if (!dirMenu) return []
    const { dirPath, runtimeId } = dirMenu
    return [
      { label: 'Rescan', onSelect: () => { rescanOn(dirPath, runtimeId).catch((err) => reportFailure('Folder not rescanned', err)) } },
      { label: REVEAL_IN_FOLDER_LABEL, onSelect: () => { apiFor(runtimeId).revealInFolder(dirPath).catch(() => {}) } },
      { label: 'Untrack folder…', separatorBefore: true, onSelect: () => setUntrackTarget({ dirPath, ...(runtimeId ? { runtimeId } : {}) }) }
    ]
  }, [dirMenu, rescanOn])

  const menuItems = useMemo<ContextMenuItem[]>(() => {
    if (!menu) return []
    const { file, dirPath, runtimeId } = menu
    const fp = file.filePath
    // The row's runtime: the open agent is this row only on that runtime (§1.3).
    const isActive = fp === openPath && (runtimeId ?? LOCAL_RUNTIME) === openRuntime
    const running = runtimeId ? (backgroundByRuntime[runtimeId] ?? []).some((a) => a.filePath === fp) : backgroundAgentMap.has(fp)
    const isRunning = isActive ? foregroundAgentState !== 'off' : running
    const busy = startingFilePaths.has(rowKey(runtimeId, fp)) || stoppingFilePaths.has(rowKey(runtimeId, fp))
    return [
      {
        label: isRunning ? 'Stop' : 'Start',
        disabled: busy,
        onSelect: async () => {
          if (!isRunning && await needsReviewBeforeStart(isActive)) return
          await toggleAgent(fp, isActive, isRunning, file.agentName ?? agentNameOf(fp), runtimeId)
        }
      },
      // Daemon mode: the agent in its own window (agent-windows.md).
      ...(agentWindowsAvailable ? [{ label: 'Open in new window', onSelect: () => openAgentWindow({ filePath: fp, agentId: file.agentId ?? null, ...(file.agentName ? { name: file.agentName } : {}), ...(runtimeId ? { runtimeId } : {}) }) }] : []),
      { label: 'Rename…', onSelect: () => setRenameTarget({ file, dirPath, runtimeId }) },
      { label: 'Clone…', onSelect: () => setCloneTarget({ file, dirPath, runtimeId }) },
      // Share copies This computer's file: a path of another runtime never reaches a local file call (§8.3).
      ...(runtimeId ? [] : [{ label: 'Share…', onSelect: () => useAppStore.getState().openShareDialog(fp) }]),
      {
        label: REVEAL_IN_FOLDER_LABEL,
        onSelect: () => { apiFor(runtimeId).revealInFolder(fp).catch(() => {}) }
      },
      {
        label: 'Delete…',
        danger: true,
        separatorBefore: true,
        onSelect: () => setDeleteTarget({ file, dirPath, runtimeId })
      }
    ]
  }, [menu, openPath, openRuntime, foregroundAgentState, backgroundAgentMap, backgroundByRuntime, startingFilePaths, stoppingFilePaths])

  /** Track Folder from a runtime's group header: on that runtime (§5.4). */
  const trackOn = useCallback((runtimeId: RuntimeId) => {
    const add = runtimeId === LOCAL_RUNTIME ? addDirectory : trackedDirsActions(runtimeId).addDirectory
    add().catch((err) => reportFailure('Folder not tracked', err))
  }, [addDirectory])

  const handleDeleted = useCallback(async (target: RowTarget) => {
    setDeleteTarget(null)
    // Main has already closed the file; drop the renderer's document/agent state.
    if (target.file.filePath === openPath && (target.runtimeId ?? LOCAL_RUNTIME) === openRuntime) await closeFile()
    // The directory watcher also emits TRACKED_DIRS_CHANGED on unlink; this
    // rescan just removes the row without waiting on it.
    await rescanOn(target.dirPath, target.runtimeId)
  }, [openPath, openRuntime, closeFile, rescanOn])

  // Menus and dialogs a row can open; the rail's avatars open them too.
  const overlays = (
    <>
        <ContextMenu
          position={menu ? { x: menu.x, y: menu.y } : null}
          items={menuItems}
          onClose={closeMenu}
        />
        <ContextMenu
          position={dirMenu ? { x: dirMenu.x, y: dirMenu.y } : null}
          items={dirMenuItems}
          onClose={closeDirMenu}
        />
        <ContextMenu position={folderMenu} items={folderMenuItems} onClose={closeFolderMenu} />
        {untrackTarget && (
          <UntrackFolderDialog
            dirPath={untrackTarget.dirPath}
            runningCount={untrackRunning.length}
            onClose={() => setUntrackTarget(null)}
            onConfirm={handleUntrack}
          />
        )}
        {renameTarget && (
          <RenameAgentDialog
            target={renameTarget}
            onClose={() => setRenameTarget(null)}
            onRenamed={handleRenamed}
          />
        )}
        {cloneTarget && (
          <CloneDialog
            open
            onClose={() => setCloneTarget(null)}
            filePath={cloneTarget.file.filePath}
            dirPath={cloneTarget.dirPath}
            runtimeId={cloneTarget.runtimeId}
            onCloned={() => rescanOn(cloneTarget.dirPath, cloneTarget.runtimeId)}
          />
        )}
        {deleteTarget && (
          <DeleteAgentDialog
            target={deleteTarget}
            onClose={() => setDeleteTarget(null)}
            onDeleted={handleDeleted}
          />
        )}
    </>
  )

  if (collapsed) {
    return (
      <div className="w-10 bg-surface-2 border-r border-hairline flex flex-col items-center py-2 gap-1 min-h-0">
        <Tooltip tip="Expand sidebar" shortcut={formatKey(ACCELERATORS.toggleSidebar, IS_MAC)} placement="right" className="flex shrink-0">
          <button
            onClick={toggleSidebar}
            aria-label="Expand sidebar"
            className="w-7 h-7 shrink-0 flex items-center justify-center rounded-md text-[var(--adf-ui-text-subtle)] hover:bg-neutral-200 dark:hover:bg-neutral-700 hover:text-neutral-600 dark:hover:text-neutral-300 transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        </Tooltip>
        {/* Running agents, and the open one; only these scroll. */}
        <div className="scrollbar-none flex-1 min-h-0 w-full overflow-y-auto flex flex-col items-center gap-1 pt-1">
          {railAgents.map((a, i) => (
            <div key={rowKey(a.runtimeId, a.file.filePath)} className="contents">
              <RailAvatar
                file={a.file}
                dirPath={a.dirPath}
                isActive={rowKey(a.runtimeId, a.file.filePath) === openKey}
                backgroundStatus={runningBackgroundMap.get(rowKey(a.runtimeId, a.file.filePath))}
                onOpenFile={handleOpenFile}
                onFileContextMenu={handleFileContextMenu}
                runtimeId={a.runtimeId}
              />
              {a.openOnly && i < railAgents.length - 1 && <div className="w-5 shrink-0 border-t border-hairline my-0.5" />}
            </div>
          ))}
        </div>
        {overlays}
      </div>
    )
  }

  return (
    <div className="w-full bg-surface-2 border-r border-hairline flex flex-col overflow-hidden">
      {/* Single header row: search · new · open · collapse. The search box
          doubles as the panel's title, so there is no separate label. */}
      <div className="h-9 px-2.5 flex items-center gap-1 shrink-0">
        <div className="relative flex-1 min-w-0">
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="absolute left-1.5 top-1/2 -translate-y-1/2 text-[var(--adf-ui-text-subtle)] pointer-events-none"
          >
            <circle cx="11" cy="11" r="7" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            value={agentSearch}
            onChange={(e) => setAgentSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setAgentSearch('')
            }}
            disabled={directories.length === 0}
            placeholder="Search agents…"
            aria-label="Search agents"
            className="w-full h-6 text-[11px] pl-6 pr-2 border border-[var(--adf-ui-border)] rounded bg-[var(--adf-ui-surface)] text-[var(--adf-ui-text)] placeholder:text-[var(--adf-ui-text-subtle)] outline-none focus:border-[var(--adf-ui-accent)] min-w-0 disabled:opacity-50 disabled:bg-transparent"
          />
        </div>
        <Tooltip tip="New agent" shortcut={formatKey(ACCELERATORS.newAgent, IS_MAC)} className="flex">
          <button
            onClick={handleCreateFile}
            aria-label="New agent"
            className="w-6 h-6 flex items-center justify-center rounded text-neutral-500 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-100 hover:bg-neutral-200 dark:hover:bg-neutral-700 transition-colors"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
        </Tooltip>
        <Tooltip tip="Open agent or track folder" className="flex" disabled={folderMenu !== null}>
          <button
            onClick={openFolderMenu}
            aria-label="Open agent or track folder"
            aria-haspopup="menu"
            aria-expanded={folderMenu !== null}
            className="w-6 h-6 flex items-center justify-center rounded text-neutral-500 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-100 hover:bg-neutral-200 dark:hover:bg-neutral-700 transition-colors"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
          </button>
        </Tooltip>
        <Tooltip tip="Collapse sidebar" shortcut={formatKey(ACCELERATORS.toggleSidebar, IS_MAC)} className="flex">
          <button
            onClick={toggleSidebar}
            aria-label="Collapse sidebar"
            className="w-7 h-7 flex items-center justify-center rounded-md text-[var(--adf-ui-text-subtle)] hover:bg-neutral-200 dark:hover:bg-neutral-700 hover:text-neutral-600 dark:hover:text-neutral-300 transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
        </Tooltip>
      </div>

      {!searching && runningRows.length > 0 && (
        <RunningSection
          rows={runningRows}
          currentFilePath={openKey}
          meshEnabled={meshEnabled}
          agentStatusMap={runningStatusMap}
          backgroundAgentMap={runningBackgroundMap}
          onOpenFile={handleOpenFile}
          onFileContextMenu={handleFileContextMenu}
          treeRef={dirScrollRef}
        />
      )}

      {/* Only the agent tree scrolls; the title and actions remain visible.
          The min height is what a short window leaves it: the Running list
          above gives up its rows first. */}
      <div
        ref={dirScrollRef}
        style={{ minHeight: TREE_MIN_HEIGHT }}
        className="scrollbar-autohide flex-1 overflow-y-auto"
      >
        {multi ? (
          // One group per runtime, in the set's order (multi-runtime.md §5.4).
          // The dividers sit between servers here, not between their folders.
          <div className="pb-1">
            {runtimes.map((rt, index) => (
              <div key={rt.id}>
              {index > 0 && <div data-runtime-divider="" className="border-t border-hairline mb-1" />}
              <RuntimeGroup runtime={rt} onTrack={() => trackOn(rt.id)}>
                {rt.id === LOCAL_RUNTIME ? (
                  directories.length > 0 ? visibleDirectories.map((dirPath) => (
              <div key={dirPath}>
                <DirectorySection
                  dirPath={dirPath}
                  files={visibleFilesByDir[dirPath] ?? []}
                  currentFilePath={filePath}
                  meshEnabled={meshEnabled}
                  agentStatusMap={agentStatusMap}
                  backgroundAgentMap={backgroundAgentMap}
                  foregroundAgentState={foregroundAgentState}
                  onOpenFile={handleOpenFile}
                  onFileContextMenu={handleFileContextMenu}
                  onDirContextMenu={handleDirContextMenu}
                  forceExpanded={searching}
                />
              </div>
            )) : (
                    <p className="pl-6 pr-3 py-[3px] text-[11px] leading-4 italic text-[var(--adf-ui-text-subtle)]">No agents</p>
                  )
                ) : (
                  <RemoteRuntimeTree
                    runtime={rt}
                    searchQuery={searchQuery}
                    openPath={openPath}
                    openRuntime={openRuntime}
                    foregroundAgentState={foregroundAgentState}
                    onOpenFile={handleOpenFile}
                    onFileContextMenu={handleFileContextMenu}
                    onDirContextMenu={handleDirContextMenu}
                  />
                )}
              </RuntimeGroup>
              </div>
            ))}
          </div>
        ) : directories.length > 0 ? (
          <div className="pb-1">
            {visibleDirectories.map((dirPath, index) => (
              <div key={dirPath}>
                {index > 0 && <div className="border-t border-hairline my-1" />}
                <DirectorySection
                  dirPath={dirPath}
                  files={visibleFilesByDir[dirPath] ?? []}
                  currentFilePath={filePath}
                  meshEnabled={meshEnabled}
                  agentStatusMap={agentStatusMap}
                  backgroundAgentMap={backgroundAgentMap}
                  foregroundAgentState={foregroundAgentState}
                  onOpenFile={handleOpenFile}
                  onFileContextMenu={handleFileContextMenu}
                  onDirContextMenu={handleDirContextMenu}
                  forceExpanded={searching}
                />
              </div>
            ))}
            {searching && visibleDirectories.length === 0 && (
              <p className="px-3 py-4 text-[11px] leading-4 text-[var(--adf-ui-text-subtle)]">
                No agents match "{agentSearch.trim()}".
              </p>
            )}
          </div>
        ) : (
          <div className="px-3 py-4 text-[11px] leading-4 text-[var(--adf-ui-text-subtle)]">
            <p className="font-medium text-[var(--adf-ui-text-muted)]">No agents</p>
            <p>
              Create one in the composer on{' '}
              <button type="button" onClick={() => setShowHome(true)} className="text-[var(--adf-ui-accent)] hover:underline">Home</button>.
            </p>
          </div>
        )}
      </div>

      {overlays}
    </div>
  )
}

/**
 * A runtime's group (multi-runtime.md §5.4): its name, and its state while
 * it is down; its tracked folders inside. Collapsible like a folder; its
 * context menu tracks a folder on that runtime. The header sticks to the top
 * of the tree while its group scrolls under it, until the next group's header
 * pushes it up; its background is the sidebar's, so no row shows through.
 */
function RuntimeGroup({ runtime, onTrack, children }: { runtime: RuntimeView; onTrack: () => void; children: React.ReactNode }) {
  const [expanded, toggle] = useFolderExpanded(`runtime:${runtime.id}`)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const items = useMemo<ContextMenuItem[]>(() => [
    { label: 'Track folder…', disabled: runtime.state !== 'connected', onSelect: onTrack },
  ], [runtime.state, onTrack])
  return (
    <div className="mb-1">
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={toggle}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() } }}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY }) }}
        data-runtime-header=""
        className="sticky top-0 z-10 w-full pl-3 pr-1.5 pt-[5px] pb-[3px] text-[11px] leading-4 text-left flex items-center gap-1.5 text-[var(--adf-ui-text)] bg-surface-2 hover:bg-[var(--adf-ui-surface-hover)] cursor-pointer select-none"
      >
        <Chevron expanded={expanded} />
        {runtime.kind === 'remote' && <RemoteMark size={11} />}
        <Tooltip tip={runtime.url ?? runtime.name} className="flex-1 min-w-0">
          <span className={`block font-semibold truncate ${runtime.state === 'connected' ? '' : 'text-[var(--adf-ui-text-subtle)]'}`}>{runtimeHeader(runtime)}</span>
        </Tooltip>
      </div>
      {expanded && children}
      <ContextMenu position={menu} items={items} onClose={() => setMenu(null)} />
    </div>
  )
}

/**
 * The tracked folders of a runtime other than This computer, from its slice
 * of the stores (useRuntimeFeeds). While it is down its folders stay from
 * the last list, greyed and inert (§3.6); one that never connected shows
 * its header only.
 */
const RemoteRuntimeTree = memo(function RemoteRuntimeTree({
  runtime,
  searchQuery,
  openPath,
  openRuntime,
  foregroundAgentState,
  onOpenFile,
  onFileContextMenu,
  onDirContextMenu,
}: {
  runtime: RuntimeView
  searchQuery: string
  openPath: string | null
  openRuntime: RuntimeId
  foregroundAgentState: string
  onOpenFile: OpenFileHandler
  onFileContextMenu: FileContextMenuHandler
  onDirContextMenu: (e: React.MouseEvent, dirPath: string, runtimeId?: RowRuntime) => void
}) {
  const slice = useTrackedDirsStore((s) => selectTrackedSlice(s, runtime.id))
  const background = useBackgroundAgentsStore((s) => selectBackgroundAgents(s, runtime.id))
  const mesh = useMeshStore((s) => selectMeshSlice(s, runtime.id))
  const backgroundMap = useStableMap(useMemo(() => background.map((a) => [a.filePath, a] as [string, BackgroundAgentStatus]), [background]))
  const statusMap = useStableMap(useMemo(() => mesh.agents.map((a) => [a.filePath, a] as [string, MeshAgentStatus]), [mesh.agents]))
  const current = openRuntime === runtime.id ? openPath : null
  const searching = searchQuery.length > 0
  const visibleFilesByDir = useMemo(() => {
    if (!searching) return slice.filesByDir
    const out: Record<string, TrackedDirEntry[]> = {}
    for (const dirPath of slice.directories) out[dirPath] = filterTree(slice.filesByDir[dirPath] ?? [], searchQuery, dirPath)
    return out
  }, [searching, searchQuery, slice])
  const visibleDirectories = searching ? slice.directories.filter((d) => (visibleFilesByDir[d]?.length ?? 0) > 0) : slice.directories
  const down = runtime.state !== 'connected'
  if (slice.directories.length === 0) {
    return down ? null : <p className="pl-6 pr-3 py-[3px] text-[11px] leading-4 italic text-[var(--adf-ui-text-subtle)]">No agents</p>
  }
  return (
    <div
      className={down ? 'opacity-50 pointer-events-none' : undefined}
      aria-disabled={down || undefined}
      title={down ? CONNECTION_STATE_LABELS[runtime.state] : undefined}
    >
      {visibleDirectories.map((dirPath) => (
        <div key={dirPath}>
          <DirectorySection
            dirPath={dirPath}
            files={visibleFilesByDir[dirPath] ?? []}
            currentFilePath={current}
            meshEnabled={mesh.enabled}
            agentStatusMap={statusMap}
            backgroundAgentMap={backgroundMap}
            foregroundAgentState={current ? foregroundAgentState : 'off'}
            onOpenFile={onOpenFile}
            onFileContextMenu={onFileContextMenu}
            onDirContextMenu={onDirContextMenu}
            forceExpanded={searching}
            runtimeId={runtime.id}
          />
        </div>
      ))}
    </div>
  )
})

/**
 * One disclosure chevron for the whole tree, rotated instead of swapped for a
 * second glyph, so open and closed rows keep identical metrics. The fixed 12px
 * box is what the indent guides line up on (see `.tree-children` in globals).
 */
function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <span className="w-3 h-3 shrink-0 flex items-center justify-center text-[var(--adf-ui-text-subtle)]">
      <svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={`transition-transform ${expanded ? 'rotate-90' : ''}`}
      >
        <polyline points="9 18 15 12 9 6" />
      </svg>
    </span>
  )
}

/**
 * Run control shared by agent and folder rows. Hover-only on purpose: the
 * status dot is the single running indicator, so a row at rest carries no
 * chrome at all and the tree reads as names.
 */
function runButtonClass(stop: boolean): string {
  // Tinted at reveal, full strength under the pointer: stop leans red, play
  // takes the app's running green. `[&>svg]` opacity keeps the row-hover reveal
  // (opacity on the button) and the tint (opacity on the glyph) independent.
  const tone = stop
    ? 'text-[var(--adf-ui-danger)] hover:bg-[var(--adf-ui-danger-subtle)]'
    : 'text-[var(--adf-ui-success)] hover:bg-[var(--adf-ui-success-subtle)]'
  return (
    'w-4 h-4 shrink-0 rounded flex items-center justify-center transition-opacity outline-none ' +
    '[&>svg]:opacity-70 hover:[&>svg]:opacity-100 ' +
    'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 ' +
    'focus-visible:ring-1 focus-visible:ring-[var(--adf-ui-focus)] ' +
    tone
  )
}

function StopIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="4" y="4" width="16" height="16" rx="3" />
    </svg>
  )
}

function PlayIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M7 4l13 8-13 8z" />
    </svg>
  )
}

/**
 * Pinned above the directory tree: a flat list of every running agent, so
 * finding what is on never depends on which folders happen to be open. Rows
 * are the same AgentFileRow the tree uses, so open, toggle, and the context
 * menu behave identically. Grows with its rows up to a cap the user can drag
 * (about six rows by default), then scrolls on its own.
 */
const RunningSection = memo(function RunningSection({
  rows,
  currentFilePath,
  meshEnabled,
  agentStatusMap,
  backgroundAgentMap,
  onOpenFile,
  onFileContextMenu,
  treeRef
}: {
  rows: RunningAgentRow[]
  currentFilePath: string | null
  meshEnabled: boolean
  agentStatusMap: Map<string, MeshAgentStatus>
  backgroundAgentMap: Map<string, BackgroundAgentStatus>
  onOpenFile: OpenFileHandler
  onFileContextMenu: FileContextMenuHandler
  /** The agent tree below, which the drag must leave TREE_MIN_HEIGHT of. */
  treeRef: React.RefObject<HTMLDivElement | null>
}) {
  const [collapsed, setCollapsed] = useState(loadRunningCollapsed)
  const [cap, setCap] = useState(() =>
    loadStoredSize(SIDEBAR_RUNNING_CAP_KEY, RUNNING_CAP_DEFAULT, RUNNING_ROW_FALLBACK, RUNNING_CAP_STORED_MAX)
  )
  const listRef = useRef<HTMLDivElement>(null)
  const capAtDragStart = useRef(cap)
  const dragLimit = useRef(cap)

  // A drag pinned at its upper limit must not lower the cap. The list can sit
  // below its cap (three agents under a six-row cap, or a short window
  // squeezing it); tugging the edge down then changes nothing on screen, and
  // must not quietly leave a three-row cap for the next ten agents.
  const resolveCap = (dragged: number): number =>
    dragged >= dragLimit.current ? Math.max(dragged, capAtDragStart.current) : dragged

  const handleResizeMouseDown = useDragResize({
    axis: 'y',
    grow: 1,
    // Never less than one row.
    min: () => listRef.current?.firstElementChild?.getBoundingClientRect().height ?? RUNNING_ROW_FALLBACK,
    // Never past the last row (dragging further would change nothing on
    // screen), and never into the tree's minimum.
    max: () => {
      const list = listRef.current
      if (!list) return RUNNING_CAP_DEFAULT
      const spare = (treeRef.current?.clientHeight ?? TREE_MIN_HEIGHT) - TREE_MIN_HEIGHT
      dragLimit.current = Math.min(list.scrollHeight, list.clientHeight + Math.max(0, spare))
      return dragLimit.current
    },
    // From the height on screen, not the stored cap: with few agents running
    // the list sits below its cap, and starting there would be a dead zone.
    getStart: () => {
      capAtDragStart.current = cap
      return listRef.current?.clientHeight ?? cap
    },
    // Straight to the element while dragging; rows re-render on state only
    // once, at release.
    onDrag: (h) => { if (listRef.current) listRef.current.style.maxHeight = `${h}px` },
    onCommit: (h) => {
      const resolved = resolveCap(h)
      // When the cap is kept, state does not change and React re-renders
      // nothing, so put the element back on the real cap by hand.
      if (listRef.current) listRef.current.style.maxHeight = `${resolved}px`
      setCap(resolved)
      saveStoredSize(SIDEBAR_RUNNING_CAP_KEY, resolved)
    }
  })

  const resetCap = useCallback(() => {
    setCap(RUNNING_CAP_DEFAULT)
    saveStoredSize(SIDEBAR_RUNNING_CAP_KEY, RUNNING_CAP_DEFAULT)
  }, [])
  const toggle = useCallback(() => {
    setCollapsed((p) => {
      saveRunningCollapsed(!p)
      return !p
    })
  }, [])

  return (
    <div className="relative min-h-0 flex flex-col border-b border-hairline pb-1">
      <div
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        onClick={toggle}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() } }}
        className="w-full shrink-0 px-3 py-[3px] text-[11px] leading-4 text-left flex items-center gap-1.5 text-[var(--adf-ui-text-muted)] hover:bg-[var(--adf-ui-surface-hover)] cursor-pointer select-none"
      >
        <Chevron expanded={!collapsed} />
        <span className="relative shrink-0 w-2 h-2">
          <span className="absolute inset-0 rounded-full bg-green-400" />
        </span>
        <span className="font-medium flex-1 truncate">Running</span>
        <span className="text-[10px] tabular-nums text-[var(--adf-ui-text-subtle)]">{rows.length}</span>
      </div>
      {!collapsed && (
        <div ref={listRef} style={{ maxHeight: cap }} className="scrollbar-autohide min-h-0 overflow-y-auto">
          {rows.map(({ file, dirPath, folderHint, runtimeId }) => (
            // Keys, the open agent and the maps are by agent key: the path on This computer.
            <AgentFileRow
              key={rowKey(runtimeId, file.filePath)}
              file={file}
              depth={0}
              isActive={rowKey(runtimeId, file.filePath) === currentFilePath}
              meshEnabled={meshEnabled}
              status={agentStatusMap.get(rowKey(runtimeId, file.filePath))}
              backgroundStatus={backgroundAgentMap.get(rowKey(runtimeId, file.filePath))}
              folderHint={folderHint}
              dirPath={dirPath}
              onOpenFile={onOpenFile}
              onFileContextMenu={onFileContextMenu}
              runtimeId={runtimeId}
            />
          ))}
        </div>
      )}
      {/* Straddles the bottom border rather than adding a row of its own. */}
      {!collapsed && (
        <div
          onMouseDown={handleResizeMouseDown}
          onDoubleClick={resetCap}
          className="absolute inset-x-0 -bottom-0.5 z-10 h-1 cursor-row-resize hover:bg-blue-300 active:bg-blue-400 transition-colors bg-transparent"
        />
      )}
    </div>
  )
})

const DirectorySection = memo(function DirectorySection({
  dirPath,
  files,
  currentFilePath,
  meshEnabled,
  agentStatusMap,
  backgroundAgentMap,
  foregroundAgentState,
  onOpenFile,
  onFileContextMenu,
  onDirContextMenu,
  forceExpanded = false,
  runtimeId
}: {
  dirPath: string
  files: TrackedDirEntry[]
  currentFilePath: string | null
  meshEnabled: boolean
  agentStatusMap: Map<string, MeshAgentStatus>
  backgroundAgentMap: Map<string, BackgroundAgentStatus>
  foregroundAgentState: string
  onOpenFile: OpenFileHandler
  onFileContextMenu: FileContextMenuHandler
  onDirContextMenu: (e: React.MouseEvent, dirPath: string, runtimeId?: RowRuntime) => void
  /** Show children regardless of the user's collapse state (used while searching). */
  forceExpanded?: boolean
  /** The folder's runtime; omitted for This computer. */
  runtimeId?: RowRuntime
}) {
  const [userExpanded, toggleExpanded] = useFolderExpanded(rowKey(runtimeId, dirPath))
  const expanded = forceExpanded || userExpanded
  const [toggling, setToggling] = useState(false)
  // Split on both separators: a Windows path has no forward slashes, so a
  // '/'-only split would print the whole C:\... path as the folder name.
  const dirName = dirPath.split(/[\\/]/).filter(Boolean).pop() ?? dirPath

  const allFiles = useMemo(() => {
    const collectFiles = (entries: TrackedDirEntry[]): TrackedDirEntry[] => {
      const result: TrackedDirEntry[] = []
      for (const entry of entries) {
        if (entry.isDirectory) {
          result.push(...collectFiles(entry.children || []))
        } else {
          result.push(entry)
        }
      }
      return result
    }
    return collectFiles(files)
  }, [files])
  const totalCount = allFiles.length

  const foregroundInTree = currentFilePath !== null && allFiles.some((f) => f.filePath === currentFilePath)
  const foregroundRunning = foregroundInTree && foregroundAgentState !== 'off'

  const nonForegroundFiles = allFiles.filter((f) => f.filePath !== currentFilePath)
  const nonForegroundActiveCount = nonForegroundFiles.filter((f) => backgroundAgentMap.has(f.filePath)).length
  const activeCount = nonForegroundActiveCount + (foregroundInTree && foregroundRunning ? 1 : 0)
  const allActive = totalCount > 0 && activeCount === totalCount

  const handleDirToggle = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (toggling) return
    setToggling(true)
    try {
      if (allActive) {
        await stopAgentsSequentially(allFiles, currentFilePath, backgroundAgentMap, { runtimeId })
      } else {
        await startAgentsSequentially(allFiles, currentFilePath, foregroundRunning, backgroundAgentMap, runtimeId)
      }
    } catch (err) {
      reportFailure(`${dirName}: ${allActive ? 'Stop all' : 'Start all'} failed`, err)
    } finally {
      setToggling(false)
    }
  }, [allActive, toggling, allFiles, currentFilePath, foregroundInTree, foregroundRunning, backgroundAgentMap, runtimeId])

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        onClick={toggleExpanded}
        onKeyDown={(e) => {
          // Only the row itself: the run button is a focusable child, and
          // preventDefault here would bubble-cancel its own Enter/Space
          // activation while still toggling the folder.
          if (e.target !== e.currentTarget) return
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleExpanded() }
        }}
        onContextMenu={(e) => onDirContextMenu(e, dirPath, runtimeId)}
        className="group w-full pl-3 pr-1.5 py-[3px] text-[11px] leading-4 text-left flex items-center gap-1.5 text-[var(--adf-ui-text-muted)] hover:bg-[var(--adf-ui-surface-hover)] cursor-pointer select-none"
      >
        <Chevron expanded={expanded} />
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
        {/* The full path is the hint here; a native title never renders in
            this window, so it hangs off the portal tooltip instead. */}
        <Tooltip tip={dirPath} className="flex-1 min-w-0">
          <span className="block font-medium truncate">{dirName}</span>
        </Tooltip>
        <span className="flex items-center gap-1.5">
          <span className="text-[10px] tabular-nums text-[var(--adf-ui-text-subtle)]">
            {activeCount > 0 ? `${activeCount}/${totalCount}` : totalCount}
          </span>
          {/* Same empty box as the agent row: the button steps aside while
              the folder is mid-flip, the slot keeps the count from shifting. */}
          {totalCount > 0 && (toggling ? (
            <span className="w-4 h-4 shrink-0" />
          ) : (
            <Tooltip tip={allActive ? 'Stop all' : 'Start all'} className="flex shrink-0">
              <button
                onClick={handleDirToggle}
                aria-label={allActive ? 'Stop all agents in folder' : 'Start all agents in folder'}
                className={runButtonClass(allActive)}
              >
                {allActive ? <StopIcon /> : <PlayIcon />}
              </button>
            </Tooltip>
          ))}
        </span>
      </div>
      {expanded && (
        // The indent guide lives on the children container, not on each row,
        // so it draws as one unbroken line instead of gapping between rows.
        // x = the centre of this folder's own 12px chevron box.
        <div className="tree-children">
          <span className="tree-guide" aria-hidden="true" style={{ left: '18px' }} />
          {files.length === 0 && (
            <div
              className="py-[3px] pr-3 text-[11px] leading-4 italic text-[var(--adf-ui-text-subtle)]"
              style={{ paddingLeft: '28px' }}
            >
              No agents
            </div>
          )}
          {files.map((entry) => (
            <TreeNode
              key={entry.filePath}
              entry={entry}
              depth={1}
              dirPath={dirPath}
              currentFilePath={currentFilePath}
              meshEnabled={meshEnabled}
              agentStatusMap={agentStatusMap}
              backgroundAgentMap={backgroundAgentMap}
              foregroundAgentState={foregroundAgentState}
              onOpenFile={onOpenFile}
              onFileContextMenu={onFileContextMenu}
              forceExpanded={forceExpanded}
              runtimeId={runtimeId}
            />
          ))}
        </div>
      )}
    </div>
  )
})

const TreeNode = memo(function TreeNode({
  entry,
  depth,
  dirPath,
  currentFilePath,
  meshEnabled,
  agentStatusMap,
  backgroundAgentMap,
  foregroundAgentState,
  onOpenFile,
  onFileContextMenu,
  forceExpanded = false,
  runtimeId
}: {
  entry: TrackedDirEntry
  depth: number
  /** Tracked root this node belongs to (what the clone/delete rescan targets). */
  dirPath: string
  currentFilePath: string | null
  meshEnabled: boolean
  agentStatusMap: Map<string, MeshAgentStatus>
  backgroundAgentMap: Map<string, BackgroundAgentStatus>
  foregroundAgentState: string
  onOpenFile: OpenFileHandler
  onFileContextMenu: FileContextMenuHandler
  forceExpanded?: boolean
  runtimeId?: RowRuntime
}) {
  const [userExpanded, toggleExpanded] = useFolderExpanded(rowKey(runtimeId, entry.filePath))
  const expanded = forceExpanded || userExpanded
  const [toggling, setToggling] = useState(false)

  // Hooks stay unconditional — the directory branch below used to call
  // useCallback inside its `if`, which breaks the Rules of Hooks the moment a
  // rescan flips a node between file and folder.
  const allFiles = useMemo(
    () => (entry.isDirectory ? collectSubtreeFiles(entry) : EMPTY_ENTRIES),
    [entry]
  )
  // One pass for the three counts the folder row needs, instead of a
  // some/filter/filter chain per folder per render.
  const counts = useMemo(() => {
    let foregroundInSubtree = false
    let backgroundActive = 0
    for (const f of allFiles) {
      if (f.filePath === currentFilePath) foregroundInSubtree = true
      else if (backgroundAgentMap.has(f.filePath)) backgroundActive++
    }
    return { foregroundInSubtree, backgroundActive }
  }, [allFiles, currentFilePath, backgroundAgentMap])

  const totalCount = allFiles.length
  const foregroundInSubtree = counts.foregroundInSubtree
  const foregroundRunning = foregroundInSubtree && foregroundAgentState !== 'off'
  const activeCount = counts.backgroundActive + (foregroundRunning ? 1 : 0)
  const allActive = totalCount > 0 && activeCount === totalCount

  const handleDirToggle = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (toggling) return
    setToggling(true)
    try {
      if (allActive) {
        await stopAgentsSequentially(allFiles, currentFilePath, backgroundAgentMap, { runtimeId })
      } else {
        await startAgentsSequentially(allFiles, currentFilePath, foregroundRunning, backgroundAgentMap, runtimeId)
      }
    } catch (err) {
      reportFailure(`${entry.fileName}: ${allActive ? 'Stop all' : 'Start all'} failed`, err)
    } finally {
      setToggling(false)
    }
  }, [allActive, toggling, allFiles, currentFilePath, foregroundRunning, backgroundAgentMap, runtimeId])

  if (entry.isDirectory) {
    return (
      <div>
        <div
          role="button"
          tabIndex={0}
          onClick={toggleExpanded}
          onKeyDown={(e) => {
            // Only the row itself: the run button is a focusable child, and
            // preventDefault here would bubble-cancel its own Enter/Space
            // activation while still toggling the folder.
            if (e.target !== e.currentTarget) return
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleExpanded() }
          }}
          className="group flex items-center gap-1.5 py-[3px] text-[11px] leading-4 cursor-pointer text-[var(--adf-ui-text-muted)] hover:bg-[var(--adf-ui-surface-hover)]"
          style={{ paddingLeft: `${12 + depth * 16}px`, paddingRight: '6px' }}
        >
          <Chevron expanded={expanded} />
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
          <span className="font-medium flex-1 truncate">{entry.fileName}</span>

          <span className="flex items-center gap-1.5">
            <span className="text-[10px] tabular-nums text-[var(--adf-ui-text-subtle)]">
              {activeCount > 0 ? `${activeCount}/${totalCount}` : totalCount}
            </span>
            {/* Same empty box as the agent row: the button steps aside while
                the folder is mid-flip, the slot keeps the count from shifting. */}
            {totalCount > 0 && (toggling ? (
              <span className="w-4 h-4 shrink-0" />
            ) : (
              <Tooltip tip={allActive ? 'Stop all' : 'Start all'} className="flex shrink-0">
                <button
                  onClick={handleDirToggle}
                  aria-label={allActive ? 'Stop all agents in folder' : 'Start all agents in folder'}
                  className={runButtonClass(allActive)}
                >
                  {allActive ? <StopIcon /> : <PlayIcon />}
                </button>
              </Tooltip>
            ))}
          </span>
        </div>
        {expanded && entry.children && (
          // Guide on the container, at the centre of this folder's chevron box.
          <div className="tree-children">
            <span className="tree-guide" aria-hidden="true" style={{ left: `${18 + depth * 16}px` }} />
            {entry.children.map((child) => (
              <TreeNode
                key={child.filePath}
                entry={child}
                depth={depth + 1}
                dirPath={dirPath}
                currentFilePath={currentFilePath}
                meshEnabled={meshEnabled}
                agentStatusMap={agentStatusMap}
                backgroundAgentMap={backgroundAgentMap}
                foregroundAgentState={foregroundAgentState}
                onOpenFile={onOpenFile}
                onFileContextMenu={onFileContextMenu}
                forceExpanded={forceExpanded}
                runtimeId={runtimeId}
              />
            ))}
          </div>
        )}
      </div>
    )
  }

  const status = agentStatusMap.get(entry.filePath)
  const backgroundStatus = backgroundAgentMap.get(entry.filePath)
  const isActive = entry.filePath === currentFilePath

  return (
    <AgentFileRow
      file={entry}
      depth={depth}
      isActive={isActive}
      meshEnabled={meshEnabled}
      status={status}
      backgroundStatus={backgroundStatus}
      dirPath={dirPath}
      onOpenFile={onOpenFile}
      onFileContextMenu={onFileContextMenu}
      runtimeId={runtimeId}
    />
  )
})

const AgentFileRow = memo(function AgentFileRow({
  file,
  depth,
  isActive,
  meshEnabled,
  status,
  backgroundStatus,
  folderHint,
  dirPath,
  onOpenFile,
  onFileContextMenu,
  runtimeId
}: {
  file: TrackedDirEntry
  depth: number
  isActive: boolean
  meshEnabled: boolean
  status: MeshAgentStatus | undefined
  backgroundStatus: BackgroundAgentStatus | undefined
  /** Muted parent-folder name shown after the agent name to tell same-named agents apart. */
  folderHint?: string
  /** Tracked root this row belongs to (what the context menu's rescan targets). */
  dirPath: string
  // The row binds these itself: fresh per-row closures from the parent would
  // make every render a new prop object and the memo would never hit.
  onOpenFile: OpenFileHandler
  onFileContextMenu: FileContextMenuHandler
  /** The row's runtime; omitted for This computer. */
  runtimeId?: RowRuntime
}) {
  const [toggling, setToggling] = useState(false)
  const key = rowKey(runtimeId, file.filePath)
  const handleOpen = useCallback(() => onOpenFile(file.filePath, runtimeId), [onOpenFile, file.filePath, runtimeId])
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => onFileContextMenu(e, file, dirPath, runtimeId),
    [onFileContextMenu, file, dirPath, runtimeId]
  )
  // Shift+F10 / the Menu key on the focused row opens the same menu.
  const rowMenu = useKeyboardContextMenu(handleContextMenu)
  const agentState = useAgentStore((s) => isActive ? s.state : 'off')
  // Inner loops only — main is the dot. A primitive selector, so a streaming
  // side loop re-renders the row on the count, not on every delta.
  const foregroundActiveLoops = useAgentStore((s) =>
    isActive ? Object.values(s.sideLoops).filter((l) => l.state === 'active').length : 0
  )
  const isStarting = useAppStore((s) => s.startingFilePaths.has(key))
  const isStopping = useAppStore((s) => s.stoppingFilePaths.has(key))
  const agentConfig = useAgentStore((s) => isActive ? s.config : null)
  // Same as the rail: the request the agent is blocked on, oldest first (on this row's runtime).
  const waiting = useApprovalsStore((s) => s.approvals.find((n) => n.filePath === file.filePath && n.runtimeId === runtimeId)?.kind ?? null)
  const inWindow = useInAgentWindow(file.filePath, file.agentId, runtimeId)
  // The open agent's review state is live; the others come from the folder scan.
  const needsReview = useAppStore((s) => isActive ? s.agentNeedsReview : file.reviewed === false)

  const isRunning = isActive
    ? agentState !== 'off'
    : backgroundStatus !== undefined

  const dotState: AgentState = isActive
    ? (agentState === 'off' ? 'not_participating' : agentState as AgentState)
    : (backgroundStatus ? toDisplayState(backgroundStatus.state) : 'not_participating')

  const activeLoops = !isRunning ? 0
    : isActive ? foregroundActiveLoops
    : backgroundStatus?.activeLoops ?? 0

  const isAutonomous = isActive
    ? (agentConfig?.autonomous ?? false)
    : (file.autonomous ?? false)

  // The agent's orbital, seeded the same way the fleet map seeds it. Emoji
  // mode draws the open agent's live config icon, else the listing's.
  const seed = orbitalSeedFor({ did: file.did, filePath: file.filePath })
  const icon = isActive ? agentConfig?.icon : file.icon
  const iconSeed = isActive ? (agentConfig?.id || file.filePath) : (file.agentId || file.filePath)

  const canReceive = isActive
    ? (agentConfig?.messaging?.receive ?? false)
    : (status?.canReceive ?? file.canReceive ?? false)
  const sendMode = isActive
    ? agentConfig?.messaging?.mode
    : (status?.sendMode ?? file.sendMode)

  // Drag the row out of the app: a consistent snapshot of the .adf lands
  // wherever it is dropped (Finder, a message, another Studio).
  // This computer's files only: a path of another runtime never reaches a local file call (multi-runtime.md §8.3).
  const shareDrag = useShareDrag(runtimeId ? null : file.filePath)

  const handleToggle = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation()
      if (toggling) return

      // Review gate: check before starting
      if (!isRunning && await needsReviewBeforeStart(isActive)) return

      setToggling(true)
      try {
        await toggleAgent(file.filePath, isActive, isRunning, file.agentName ?? agentNameOf(file.filePath), runtimeId)
      } finally {
        setToggling(false)
      }
    },
    [file.filePath, file.agentName, isActive, isRunning, toggling, runtimeId]
  )

  // Direction reads as a hover detail, not a permanent column: a leading glyph
  // slot pushed every name right even when the agent talks to no one.
  const direction =
    canReceive && sendMode === 'proactive' ? '\u21C5' :
    canReceive ? '\u2193' :
    sendMode === 'proactive' ? '\u2191' : ''
  const directionTip =
    direction === '\u21C5' ? 'Sends and receives messages' :
    direction === '\u2193' ? 'Receives messages' : 'Sends messages'

  // While the agent is mid-flip the dot carries a spinner, so the run button
  // steps aside; the empty box keeps the row from shifting under the cursor.
  const busy = toggling || isStarting || isStopping

  return (
    // The whole row opens the agent, not just the name: the avatar, the gap
    // and the markers are all part of the same target. Only the run button
    // (and its placeholder) opt out.
    <div
      {...shareDrag}
      onClick={handleOpen}
      onContextMenu={rowMenu.onContextMenu}
      onKeyDown={rowMenu.onKeyDown}
      data-active={isActive || undefined}
      className={`group flex items-center relative gap-1.5 py-[3px] text-[11px] leading-4 cursor-pointer transition-colors ${
        isActive
          ? 'bg-[var(--adf-ui-selection)] text-[var(--adf-ui-text)] [--row-bg:var(--adf-ui-selection)]'
          : `${isRunning ? 'text-[var(--adf-ui-text)]' : 'text-[var(--adf-ui-text-muted)]'} hover:bg-[var(--adf-ui-sidebar-hover)] [--row-bg:var(--adf-surface-2)] hover:[--row-bg:var(--adf-ui-sidebar-hover)]`
      }`}
      style={{ paddingLeft: `${12 + depth * 16}px`, paddingRight: '6px' }}
    >
      {isActive && <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-[var(--adf-ui-accent)]" />}
      <AgentAvatar
        seed={seed}
        icon={icon}
        iconSeed={iconSeed}
        running={isRunning}
        state={dotState}
        starting={(toggling && !isRunning) || isStarting}
        stopping={(toggling && isRunning) || isStopping}
        waiting={waiting}
        needsReview={needsReview}
      />

      {/* The full path is the hint; a native title never renders in this
          window, so the portal tooltip carries it instead. Another
          runtime's row does not drag out of the app: the hint says so. */}
      <Tooltip tip={runtimeId ? `${file.filePath} · ${REMOTE_DRAG_TIP}` : file.filePath} delay={1000} className="flex min-w-0 shrink">
        {/* No handler of its own: the click bubbles to the row. It stays a
            button so the row is reachable and openable from the keyboard. */}
        <button aria-current={isActive || undefined} className={`block w-full min-w-0 text-left truncate ${isActive ? 'font-medium' : ''}`}>
          {/* Always the file's name on disk, selected or not. The open
              agent's config.name is deliberately not used: it can run ahead
              of the file while a rename waits for the agent to stop. */}
          {file.agentName ?? file.fileName.replace(/\.adf$/i, '')}
          {file.pendingName && (
            <span className="ml-1 text-[10px] text-[var(--adf-ui-text-subtle)]">
              → {file.pendingName}
            </span>
          )}
          {folderHint && (
            <span className="ml-1 text-[10px] text-[var(--adf-ui-text-subtle)]">
              {folderHint}
            </span>
          )}
        </button>
      </Tooltip>

      {/* Inner loops mid-turn, written as an exponent on the name. Main is
          the status dot, never this count, and nothing renders at zero. The
          count sits outside the name's tooltip anchor so it can carry its own. */}
      {activeLoops > 0 && (
        <Tooltip
          tip={`${activeLoops} inner ${activeLoops === 1 ? 'loop' : 'loops'} working`}
          className="flex shrink-0 self-start -ml-1 pt-px"
        >
          {/* yellow-400 is the status dot's colour but ~1.5:1 as text on a
              light surface, so light mode takes the darker end of the hue. */}
          <span className="text-[9px] leading-none font-semibold text-amber-600 dark:text-yellow-400 tabular-nums">
            {activeLoops}
          </span>
        </Tooltip>
      )}
      <span className="flex-1" />

      {/* A sibling of the name, never a child of it: nesting one tooltip
          anchor inside another leaves the outer one open while the inner
          shows, so the bolt would raise two tips at once. */}
      {/* Trailing markers sit tighter than the row's own gap so the name
          keeps as much width as the sidebar allows. */}
      <span className="flex items-center gap-1 shrink-0">
        {inWindow && (
          <Tooltip tip="Open in its own window" className="flex shrink-0 text-[var(--adf-ui-text-subtle)]">
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-label="In its own window" role="img">
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <line x1="3" y1="9" x2="21" y2="9" />
            </svg>
          </Tooltip>
        )}

        {isAutonomous && (
          <Tooltip
            tip="Autonomous — keeps working until it sets itself idle"
            className="flex shrink-0 text-[var(--adf-ui-warning)] opacity-80"
          >
            <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
            </svg>
          </Tooltip>
        )}

        {direction && (
          <Tooltip
            tip={directionTip}
            className="flex shrink-0 text-[10px] leading-none text-[var(--adf-ui-text-subtle)] opacity-0 group-hover:opacity-100 transition-opacity"
          >
            {direction}
          </Tooltip>
        )}

        {busy ? (
          // Swallows the click: a second press on Start lands here once the
          // button has stepped aside, and must not open the agent instead.
          <span className="w-4 h-4 shrink-0" onClick={(e) => e.stopPropagation()} />
        ) : (
          <Tooltip tip={isRunning ? 'Stop' : 'Start'} className="flex shrink-0">
            <button
              onClick={handleToggle}
              aria-label={isRunning ? 'Stop agent' : 'Start agent'}
              // Pressing the run button is a start/stop gesture, not a share
              // drag — keep the row draggable but not this control.
              draggable={false}
              onDragStart={(e) => { e.preventDefault(); e.stopPropagation() }}
              className={runButtonClass(isRunning)}
            >
              {isRunning ? <StopIcon /> : <PlayIcon />}
            </button>
          </Tooltip>
        )}
      </span>
    </div>
  )
})

/**
 * The agent's orbital with the status dot as a corner badge, in the same
 * 16 px slot the emoji used. A stopped agent is drawn faded with no badge, so
 * a quiet tree stays muted and the running agents stand out; the badge then
 * adds the finer state. The orbital turns only while the agent is active.
 * In emoji mode the 12 px emoji sits in the same slot, desaturated when stopped.
 */
const RAIL_STATE_LABEL: Partial<Record<AgentState, string>> = {
  active: 'Working',
  idle: 'Idle',
  hibernate: 'Hibernating',
  suspended: 'Suspended',
  error: 'Error',
  not_participating: 'Not running'
}

/**
 * One agent on the collapsed rail: its avatar with the tree's status dot,
 * the inner-loop count, and an amber ring while it waits on the user. Click
 * opens it and right-click opens the row menu, exactly like its tree row.
 */
const RailAvatar = memo(function RailAvatar({
  file,
  dirPath,
  isActive,
  backgroundStatus,
  onOpenFile,
  onFileContextMenu,
  runtimeId
}: {
  file: TrackedDirEntry
  dirPath?: string
  isActive: boolean
  backgroundStatus: BackgroundAgentStatus | undefined
  onOpenFile: OpenFileHandler
  onFileContextMenu: FileContextMenuHandler
  runtimeId?: RowRuntime
}) {
  const agentState = useAgentStore((s) => isActive ? s.state : 'off')
  const foregroundActiveLoops = useAgentStore((s) =>
    isActive ? Object.values(s.sideLoops).filter((l) => l.state === 'active').length : 0
  )
  const agentConfig = useAgentStore((s) => isActive ? s.config : null)
  const isStarting = useAppStore((s) => s.startingFilePaths.has(rowKey(runtimeId, file.filePath)))
  const isStopping = useAppStore((s) => s.stoppingFilePaths.has(rowKey(runtimeId, file.filePath)))
  // Oldest first, like the snapshot: the request the agent is blocked on.
  const waiting = useApprovalsStore((s) => s.approvals.find((n) => n.filePath === file.filePath && n.runtimeId === runtimeId)?.kind ?? null)

  const isRunning = isActive ? agentState !== 'off' : backgroundStatus !== undefined
  const state: AgentState = isActive
    ? (agentState === 'off' ? 'not_participating' : agentState as AgentState)
    : (backgroundStatus ? toDisplayState(backgroundStatus.state) : 'not_participating')
  const activeLoops = !isRunning ? 0 : isActive ? foregroundActiveLoops : backgroundStatus?.activeLoops ?? 0
  const busy = isStarting || isStopping
  const showBadge = busy || state !== 'not_participating'

  const name = file.agentName ?? file.fileName.replace(/\.adf$/i, '')
  const status = [
    isStarting ? 'Starting' : isStopping ? 'Stopping' : RAIL_STATE_LABEL[state] ?? state,
    waitingLabel(waiting),
    activeLoops > 0 ? `${activeLoops} inner ${activeLoops === 1 ? 'loop' : 'loops'} working` : null
  ].filter(Boolean).join(' · ')
  // The visible label is only the name; screen readers still get the icon's status.
  const accessibleLabel = `${name} · ${status}`

  const emoji = useAgentAvatarMode() === 'emoji'
  const quiet = isRunning || busy ? '' : emoji ? 'grayscale opacity-70' : 'opacity-70'

  return (
    <HoverLabel name={name} className="flex shrink-0">
      <button
        type="button"
        onClick={() => onOpenFile(file.filePath, runtimeId)}
        onContextMenu={dirPath ? (e) => onFileContextMenu(e, file, dirPath, runtimeId) : undefined}
        aria-label={accessibleLabel}
        aria-current={isActive || undefined}
        className={`relative w-7 h-7 flex items-center justify-center rounded-md transition-colors ${
          isActive
            ? 'bg-[var(--adf-ui-selection)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--adf-ui-accent)_25%,transparent)] [--row-bg:var(--adf-ui-selection)]'
            : 'hover:bg-[var(--adf-ui-sidebar-hover)] focus-visible:bg-[var(--adf-ui-sidebar-hover)] [--row-bg:var(--adf-surface-2)] hover:[--row-bg:var(--adf-ui-sidebar-hover)] focus-visible:[--row-bg:var(--adf-ui-sidebar-hover)]'
        }`}
      >
        {isActive && <span aria-hidden className="absolute -left-1 top-1.5 bottom-1.5 w-0.5 rounded-full bg-[var(--adf-ui-accent)]" />}
        {waiting && (
          <span className="absolute inset-0.5 rounded-full ring-2 ring-amber-400 dark:ring-amber-400 animate-pulse" aria-hidden />
        )}
        <span className={`flex transition-[filter,opacity] ${quiet}`}>
          <OrbitalAvatar
            seed={orbitalSeedFor({ did: file.did, filePath: file.filePath })}
            icon={isActive ? agentConfig?.icon : file.icon}
            iconSeed={isActive ? (agentConfig?.id || file.filePath) : (file.agentId || file.filePath)}
            size={20}
            emojiSize={15}
            animated={state === 'active'}
          />
        </span>
        {showBadge && (
          <span className="absolute bottom-0.5 right-0.5 flex rounded-full shadow-[0_0_0_1.5px_var(--row-bg,var(--adf-surface-2))]">
            <StatusDot state={state} starting={isStarting} stopping={isStopping} bare />
          </span>
        )}
        {activeLoops > 0 && (
          <span className="absolute top-0 right-0 text-[9px] leading-none font-semibold text-amber-600 dark:text-yellow-400 tabular-nums">
            {activeLoops}
          </span>
        )}
      </button>
    </HoverLabel>
  )
})

/** What an amber ring means, on the rail and on a row. */
function waitingLabel(kind: 'approval' | 'ask' | null): string | null {
  return kind === 'approval' ? 'Waiting for your approval' : kind === 'ask' ? 'Has a question for you' : null
}

const AgentAvatar = memo(function AgentAvatar({
  seed,
  icon,
  iconSeed,
  running,
  state,
  starting,
  stopping,
  waiting = null,
  needsReview = false
}: {
  seed: string | null
  icon?: string
  iconSeed: string
  running: boolean
  state: AgentState
  starting?: boolean
  stopping?: boolean
  /** The agent waits on the user: the rail's amber ring, with its reason as the tip. */
  waiting?: 'approval' | 'ask' | null
  /** Not reviewed: an amber shield takes the avatar's place, with the same tip. */
  needsReview?: boolean
}) {
  const busy = starting || stopping
  const showBadge = busy || state !== 'not_participating'
  const emoji = useAgentAvatarMode() === 'emoji'
  const quiet = emoji
    ? `transition-[filter,opacity] ${running || busy ? '' : 'grayscale opacity-70'}`
    : `transition-opacity ${running || busy ? '' : 'opacity-70'}`
  const waitingTip = waitingLabel(waiting)
  const tip = [needsReview ? 'Not reviewed' : null, waitingTip].filter(Boolean).join(' · ')
  const avatar = (
    <span className="relative shrink-0 w-4 h-4 flex items-center justify-center">
      {waitingTip && (
        <span className="absolute -inset-0.5 rounded-full ring-2 ring-amber-400 dark:ring-amber-400 animate-pulse" aria-hidden />
      )}
      {needsReview ? (
        // Full strength, never faded like a stopped avatar: it is a warning.
        <span data-review-shield="" className="flex text-[var(--adf-ui-warning)]">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        </span>
      ) : (
        <span className={`flex ${quiet}`}>
          <OrbitalAvatar seed={seed} icon={icon} iconSeed={iconSeed} size={16} emojiSize={12} animated={state === 'active'} />
        </span>
      )}
      {showBadge && (
        // A ring in the row's own colour lifts the badge off the orbital beneath
        // it; the row sets --row-bg for rest, hover and selected.
        <span className="absolute -bottom-0.5 -right-0.5 flex rounded-full shadow-[0_0_0_1.5px_var(--row-bg,var(--adf-surface-2))]">
          {/* One tip at a time: while the avatar has a tip of its own the dot has none. */}
          <StatusDot state={state} starting={starting} stopping={stopping} bare={!!tip} />
        </span>
      )}
    </span>
  )
  if (!tip) return avatar
  return (
    <Tooltip tip={tip} delay={300} className="flex shrink-0">
      {/* The shield is a tab stop, so its tip also shows on keyboard focus. */}
      <span
        role="img"
        aria-label={tip}
        tabIndex={needsReview ? 0 : undefined}
        className={needsReview ? 'flex rounded outline-none focus-visible:ring-1 focus-visible:ring-[var(--adf-ui-focus)]' : 'flex'}
      >
        {avatar}
      </span>
    </Tooltip>
  )
})

/** `bare` drops the dot's own tooltip, for a dot inside a control that already has one. */
const StatusDot = memo(function StatusDot({ state, starting, stopping, bare }: { state: AgentState; starting?: boolean; stopping?: boolean; bare?: boolean }) {
  const config: Record<AgentState, { color: string; label: string; pulse?: boolean; ring?: boolean }> = {
    active: { color: 'bg-yellow-400', label: 'Active', pulse: true },
    idle: { color: 'bg-green-400', label: 'Idle' },
    hibernate: { color: 'bg-purple-500', label: 'Hibernate' },
    suspended: { color: 'border-red-400', label: 'Suspended', ring: true },
    off: { color: 'bg-neutral-400', label: 'Off' },
    error: { color: 'bg-red-400', label: 'Error' },
    not_participating: { color: 'bg-neutral-300 dark:bg-neutral-600', label: 'Not active' }
  }
  const { color, label, pulse, ring } = config[state] ?? config.off

  // The dot is the row's only permanent running indicator, so its hint has to
  // actually render: a native title never does in this window. The children
  // are all `absolute`, so the flex wrapper leaves the 8px box unchanged.
  if (starting) {
    return (
      <Tooltip tip="Starting" disabled={bare} className="relative shrink-0 w-2 h-2 flex">
        <span className="absolute inset-[-1px] rounded-full border border-yellow-400 border-t-transparent animate-spin" />
      </Tooltip>
    )
  }

  if (stopping) {
    return (
      <Tooltip tip="Stopping" disabled={bare} className="relative shrink-0 w-2 h-2 flex">
        <span className="absolute inset-[-1px] rounded-full border border-neutral-400 dark:border-neutral-500 border-t-transparent animate-spin" />
      </Tooltip>
    )
  }

  return (
    <Tooltip tip={label} disabled={bare} className="relative shrink-0 w-2 h-2 flex">
      {pulse && (
        <span
          className={`absolute inset-0 rounded-full ${color} animate-ping opacity-75`}
        />
      )}
      {ring ? (
        <span className={`absolute inset-0 rounded-full border-[1.5px] ${color}`} />
      ) : (
        <span className={`absolute inset-0 rounded-full ${color}`} />
      )}
    </Tooltip>
  )
})

/**
 * Confirmation for the context menu's Delete. Main stops the agent (foreground
 * or background) and unlinks the file plus its WAL; a failure is shown inline
 * and the dialog stays open.
 */
/**
 * Untracking a folder stops every agent running from it first: a folder
 * with no rows has no Stop toggle, so nothing may keep running out of one.
 * The dialog says exactly that, and that nothing on disk changes.
 */
function UntrackFolderDialog({ dirPath, runningCount, onClose, onConfirm }: {
  dirPath: string
  runningCount: number
  onClose: () => void
  onConfirm: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const name = dirPath.split('/').pop() ?? dirPath

  const handleConfirm = async () => {
    setBusy(true)
    setError(null)
    try {
      await onConfirm()
    } catch (err) {
      setError(failureReason(err) || String(err))
      setBusy(false)
    }
  }

  return (
    <Dialog open onClose={onClose} title="Untrack folder?" preventClose={busy}>
      <p className="text-sm text-[var(--adf-ui-text-muted)]">
        {runningCount > 0 ? (
          <>
            Stops the <span className="font-medium text-[var(--adf-ui-text)]">{runningCount}</span> {runningCount === 1 ? 'agent' : 'agents'} running
            in <span className="font-medium text-[var(--adf-ui-text)]">{name}</span>, then removes the folder and its subfolders from the sidebar.
          </>
        ) : (
          <>
            Removes <span className="font-medium text-[var(--adf-ui-text)]">{name}</span> and its subfolders from the sidebar.
          </>
        )}{' '}
        Nothing is deleted from disk. Track it again from the folder button.
      </p>
      {error && (
        <p className="mt-3 text-xs text-[var(--adf-ui-danger)]" role="alert">
          {error}
        </p>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant={runningCount > 0 ? 'danger' : 'primary'} onClick={handleConfirm} loading={busy} autoFocus>
          {runningCount > 0 ? 'Stop and untrack' : 'Untrack'}
        </Button>
      </div>
    </Dialog>
  )
}

/**
 * Rename from the row: the agent's name and its file name move together,
 * through the same IPC the Agent tab uses. A running agent keeps its file
 * name until it stops; the row shows the new name right away.
 */
function RenameAgentDialog({ target, onClose, onRenamed }: {
  target: RowTarget
  onClose: () => void
  onRenamed: (target: RowTarget, newPath: string, name: string, deferred: boolean) => void
}) {
  const initial = target.file.pendingName ?? target.file.agentName ?? target.file.fileName.replace(/\.adf$/i, '')
  const [name, setName] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed || trimmed === initial) { onClose(); return }
    setBusy(true)
    setError(null)
    try {
      const result = await apiFor(target.runtimeId).renameFile(target.file.filePath, trimmed)
      if (result.success && result.filePath) {
        onRenamed(target, result.filePath, trimmed, result.renameDeferred ?? false)
        return
      }
      setError(result.error ?? 'Rename failed')
    } catch (err) {
      setError(String(err))
    }
    setBusy(false)
  }

  return (
    <Dialog open onClose={onClose} title="Rename agent" preventClose={busy} lightDismiss={false}>
      <form onSubmit={submit}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          aria-label="Agent name"
          className="w-full rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-border)] bg-[var(--adf-ui-canvas)] px-2.5 py-1.5 text-sm text-[var(--adf-ui-text)] outline-none focus:border-[var(--adf-ui-accent)]"
        />
        <p className="mt-2 text-xs text-[var(--adf-ui-text-muted)]">
          The file is renamed to match. If the agent is running, the file keeps its old name until it stops.
        </p>
        {error && (
          <p className="mt-3 text-xs text-[var(--adf-ui-danger)]" role="alert">
            {error}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" loading={busy}>
            Rename
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

function DeleteAgentDialog({
  target,
  onClose,
  onDeleted
}: {
  target: RowTarget
  onClose: () => void
  onDeleted: (target: RowTarget) => void
}) {
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const name = target.file.agentName ?? target.file.fileName

  const handleConfirm = async () => {
    setDeleting(true)
    setError(null)
    try {
      const result = await apiFor(target.runtimeId).deleteFile(target.file.filePath)
      if (result.success) {
        // An agent created later at this path must not inherit its queue.
        useMessageQueueStore.getState().clearAgent(rowKey(target.runtimeId, target.file.filePath))
        onDeleted(target)
        return
      }
      setError(result.error ?? 'Delete failed')
    } catch (err) {
      setError(String(err))
    }
    setDeleting(false)
  }

  return (
    <Dialog open onClose={onClose} title="Delete agent?" preventClose={deleting}>
      <p className="text-sm text-[var(--adf-ui-text-muted)]">
        <span className="font-medium text-[var(--adf-ui-text)]">{name}</span> and everything in it — config,
        files, memory, history — will be deleted. This cannot be undone.
      </p>
      {error && (
        <p className="mt-3 text-xs text-[var(--adf-ui-danger)]" role="alert">
          {error}
        </p>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose} disabled={deleting}>
          Cancel
        </Button>
        <Button variant="danger" onClick={handleConfirm} loading={deleting} autoFocus>
          Delete
        </Button>
      </div>
    </Dialog>
  )
}
