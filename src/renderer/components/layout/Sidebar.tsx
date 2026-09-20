import { useState, useEffect, useMemo, useCallback, useRef, memo } from 'react'
import { useAppStore } from '../../stores/app.store'
import { useDocumentStore } from '../../stores/document.store'
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
import { ContextMenu, type ContextMenuItem } from '../common/ContextMenu'
import { Tooltip } from '../common/Tooltip'
import { CloneDialog } from '../common/CloneDialog'
import { Dialog } from '../common/Dialog'
import { Button } from '../ui'
import { REVEAL_IN_FOLDER_LABEL } from '../../utils/platform'
import { collectRunningAgents, type RunningAgentRow } from '../../utils/running-agents'
import { SIDEBAR_RUNNING_CAP_KEY, loadStoredSize, saveStoredSize } from '../../utils/stored-size'
import { pickAgentIcon } from '../../../shared/constants/agent-icons'
import type { AgentState, MeshAgentStatus, BackgroundAgentStatus } from '../../../shared/types/ipc.types'
import type { TrackedDirEntry } from '../../../shared/types/ipc.types'

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
    const haystack = `${entry.fileName}\n${entry.agentName ?? ''}\n${relPath}`.toLowerCase()
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
  backgroundAgentMap: Map<string, BackgroundAgentStatus>
): Promise<void> {
  const app = useAppStore.getState()
  const toStart = files.filter((f) =>
    f.filePath === currentFilePath ? !foregroundRunning : !backgroundAgentMap.has(f.filePath)
  )
  for (const file of toStart) app.addStartingFilePath(file.filePath)
  try {
    for (const file of toStart) {
      try {
        if (file.filePath === currentFilePath) {
          const result = await window.adfApi.startAgent()
          if (result.success) {
            useAgentStore.getState().setState(toDisplayState(result.agentState ?? 'idle'))
          }
        } else {
          await window.adfApi.startBackgroundAgent(file.filePath)
        }
      } finally {
        app.removeStartingFilePath(file.filePath)
      }
    }
  } finally {
    for (const file of toStart) app.removeStartingFilePath(file.filePath)
  }
}

/**
 * Stop every running agent in `files`, one at a time, marking all of them as
 * stopping up front so each pending shutoff is visible immediately.
 */
async function stopAgentsSequentially(
  files: TrackedDirEntry[],
  currentFilePath: string | null,
  backgroundAgentMap: Map<string, BackgroundAgentStatus>
): Promise<void> {
  const app = useAppStore.getState()
  const toStop = files.filter((f) =>
    f.filePath === currentFilePath || backgroundAgentMap.has(f.filePath)
  )
  for (const file of toStop) app.addStoppingFilePath(file.filePath)
  try {
    for (const file of toStop) {
      try {
        if (file.filePath === currentFilePath) {
          await window.adfApi.stopAgent()
          useAgentStore.getState().setState('off')
        } else {
          await window.adfApi.stopBackgroundAgent(file.filePath)
        }
      } finally {
        app.removeStoppingFilePath(file.filePath)
      }
    }
  } finally {
    for (const file of toStop) app.removeStoppingFilePath(file.filePath)
  }
}

/**
 * Review gate for starting the FOREGROUND agent. Opens the review dialog and
 * returns true when the agent must be reviewed before it may start; a failed
 * check falls through to false so a flaky IPC never blocks the toggle.
 */
async function needsReviewBeforeStart(isActive: boolean): Promise<boolean> {
  if (!isActive) return false
  try {
    const review = await window.adfApi.checkAgentReview()
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
async function toggleAgent(filePath: string, isActive: boolean, isRunning: boolean): Promise<void> {
  const app = useAppStore.getState()
  if (isRunning) app.addStoppingFilePath(filePath)
  else app.addStartingFilePath(filePath)
  try {
    if (isActive) {
      if (isRunning) {
        await window.adfApi.stopAgent()
        useAgentStore.getState().setState('off')
      } else {
        await startForegroundAgent({ skipReviewGate: true })
      }
    } else if (isRunning) {
      await window.adfApi.stopBackgroundAgent(filePath)
    } else {
      let result = await window.adfApi.startBackgroundAgent(filePath)
      // Same provider-at-need as the foreground path: connect one, retry once.
      if (!result.success && (result.code === 'provider_missing' || result.code === 'provider_unconfigured')) {
        const connected = await app.requestProviderSetup(result.code, filePath)
        if (connected) result = await window.adfApi.startBackgroundAgent(filePath)
      }
      if (!result.success && result.error) console.warn('[Sidebar] Background start failed:', result.error)
    }
  } finally {
    if (isRunning) app.removeStoppingFilePath(filePath)
    else app.removeStartingFilePath(filePath)
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
}

export function Sidebar() {
  const collapsed = useAppStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useAppStore((s) => s.toggleSidebar)
  const showSettings = useAppStore((s) => s.showSettings)
  const setShowSettings = useAppStore((s) => s.setShowSettings)
  const showMeshGraph = useAppStore((s) => s.showMeshGraph)
  const setShowMeshGraph = useAppStore((s) => s.setShowMeshGraph)
  const filePath = useDocumentStore((s) => s.filePath)
  const { openFile, createFile, closeFile } = useAdfFile()
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
  const agentStatusMap = useMemo(
    () => new Map(meshAgents.map((a) => [a.filePath, a])),
    [meshAgents]
  )
  const backgroundAgents = useBackgroundAgentsStore((s) => s.agents)
  const backgroundAgentMap = useMemo(
    () => new Map(backgroundAgents.map((a) => [a.filePath, a])),
    [backgroundAgents]
  )
  const dirScrollRef = useRef<HTMLDivElement>(null)

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

  // Pinned "Running" list: every running agent across all roots, flat. Built
  // from the unfiltered trees so it does not depend on folder state; hidden
  // while searching because search already flattens the tree.
  const runningRows = useMemo(() => collectRunningAgents({
    directories,
    filesByDir,
    currentFilePath: filePath,
    foregroundRunning: foregroundAgentState !== 'off',
    isBackgroundRunning: (fp) => backgroundAgentMap.has(fp)
  }), [directories, filesByDir, filePath, foregroundAgentState, backgroundAgentMap])

  const handleOpenFile = useCallback((fp: string) => {
    if (showSettings) setShowSettings(false)
    if (showMeshGraph) setShowMeshGraph(false)
    const scrollTop = dirScrollRef.current?.scrollTop ?? 0
    openFile(fp).then(() => {
      requestAnimationFrame(() => {
        if (dirScrollRef.current) {
          dirScrollRef.current.scrollTop = scrollTop
        }
      })
    })
  }, [openFile, showSettings, showMeshGraph, setShowSettings, setShowMeshGraph])

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
    { label: 'Track folder…', onSelect: () => { addDirectory().catch((err) => console.error('[Sidebar] Track folder failed:', err)) } },
  ], [addDirectory, handleOpenFromPicker])

  // Row context menu + the dialogs it opens. One instance of each lives here,
  // keyed by the target file, instead of one per row.
  const [menu, setMenu] = useState<(RowTarget & { x: number; y: number }) | null>(null)
  // Right-click on a tracked folder's header row: its own short menu. This
  // is where a folder stops being tracked; nothing on the home screen lists
  // the folders any more.
  const [dirMenu, setDirMenu] = useState<{ dirPath: string; x: number; y: number } | null>(null)
  const [untrackTarget, setUntrackTarget] = useState<string | null>(null)
  const [renameTarget, setRenameTarget] = useState<RowTarget | null>(null)
  const updateFileEntry = useTrackedDirsStore((s) => s.updateFileEntry)

  // Every agent file under the folder about to be untracked, and which of
  // them run. An untracked folder has no rows, so nothing may keep running
  // from it: the confirm stops them all before the folder goes.
  const untrackFiles = useMemo(() => {
    if (!untrackTarget) return [] as TrackedDirEntry[]
    const out: TrackedDirEntry[] = []
    const walk = (entries: TrackedDirEntry[]) => {
      for (const e of entries) {
        if (e.isDirectory) walk(e.children ?? [])
        else out.push(e)
      }
    }
    for (const d of directories) {
      if (d === untrackTarget || d.startsWith(`${untrackTarget}/`)) walk(filesByDir[d] ?? [])
    }
    return out
  }, [untrackTarget, directories, filesByDir])
  const untrackRunning = useMemo(
    () => untrackFiles.filter((f) => (f.filePath === filePath ? foregroundAgentState !== 'off' : backgroundAgentMap.has(f.filePath))),
    [untrackFiles, filePath, foregroundAgentState, backgroundAgentMap]
  )
  const handleUntrack = useCallback(async () => {
    const root = untrackTarget
    if (!root) return
    await stopAgentsSequentially(untrackFiles, filePath, backgroundAgentMap)
    // The open file is one of the rows about to vanish; close it so the
    // editor cannot start it again from a folder the sidebar no longer shows.
    if (filePath && (filePath === root || filePath.startsWith(`${root}/`))) await closeFile()
    // Tracked roots nested inside this one go with it.
    for (const d of directories) {
      if (d === root || d.startsWith(`${root}/`)) await removeDirectory(d)
    }
    setUntrackTarget(null)
  }, [untrackTarget, untrackFiles, filePath, backgroundAgentMap, closeFile, directories, removeDirectory])

  const handleRenamed = useCallback(async (target: RowTarget, newPath: string, name: string) => {
    setRenameTarget(null)
    if (target.file.filePath === filePath) {
      useDocumentStore.getState().setFilePath(newPath)
      const cfg = useAgentStore.getState().config
      if (cfg) useAgentStore.getState().setConfig({ ...cfg, name })
    }
    // A running agent keeps its old path until it stops (deferred rename);
    // the row shows the new name meanwhile.
    updateFileEntry(newPath, { agentName: name })
    await rescanDirectory(target.dirPath)
  }, [filePath, rescanDirectory, updateFileEntry])
  const [cloneTarget, setCloneTarget] = useState<RowTarget | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<RowTarget | null>(null)
  const startingFilePaths = useAppStore((s) => s.startingFilePaths)
  const stoppingFilePaths = useAppStore((s) => s.stoppingFilePaths)

  const handleFileContextMenu = useCallback((e: React.MouseEvent, file: TrackedDirEntry, dirPath: string) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ file, dirPath, x: e.clientX, y: e.clientY })
  }, [])
  const closeMenu = useCallback(() => setMenu(null), [])
  const handleDirContextMenu = useCallback((e: React.MouseEvent, dirPath: string) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu(null)
    setDirMenu({ dirPath, x: e.clientX, y: e.clientY })
  }, [])
  const closeDirMenu = useCallback(() => setDirMenu(null), [])

  const dirMenuItems = useMemo<ContextMenuItem[]>(() => {
    if (!dirMenu) return []
    const { dirPath } = dirMenu
    return [
      { label: 'Rescan', onSelect: () => { void rescanDirectory(dirPath) } },
      { label: REVEAL_IN_FOLDER_LABEL, onSelect: () => { window.adfApi.revealInFolder(dirPath).catch(() => {}) } },
      { label: 'Untrack folder…', separatorBefore: true, onSelect: () => setUntrackTarget(dirPath) }
    ]
  }, [dirMenu, rescanDirectory])

  const menuItems = useMemo<ContextMenuItem[]>(() => {
    if (!menu) return []
    const { file, dirPath } = menu
    const fp = file.filePath
    const isActive = fp === filePath
    const isRunning = isActive ? foregroundAgentState !== 'off' : backgroundAgentMap.has(fp)
    const busy = startingFilePaths.has(fp) || stoppingFilePaths.has(fp)
    return [
      {
        label: isRunning ? 'Stop' : 'Start',
        disabled: busy,
        onSelect: async () => {
          if (!isRunning && await needsReviewBeforeStart(isActive)) return
          try {
            await toggleAgent(fp, isActive, isRunning)
          } catch (err) {
            console.error('[Sidebar] Context menu toggle failed:', err)
          }
        }
      },
      { label: 'Rename…', onSelect: () => setRenameTarget({ file, dirPath }) },
      { label: 'Clone…', onSelect: () => setCloneTarget({ file, dirPath }) },
      { label: 'Share…', onSelect: () => useAppStore.getState().openShareDialog(fp) },
      {
        label: REVEAL_IN_FOLDER_LABEL,
        onSelect: () => { window.adfApi.revealInFolder(fp).catch(() => {}) }
      },
      {
        label: 'Delete…',
        danger: true,
        separatorBefore: true,
        onSelect: () => setDeleteTarget({ file, dirPath })
      }
    ]
  }, [menu, filePath, foregroundAgentState, backgroundAgentMap, startingFilePaths, stoppingFilePaths])

  const handleDeleted = useCallback(async (target: RowTarget) => {
    setDeleteTarget(null)
    // Main has already closed the file; drop the renderer's document/agent state.
    if (target.file.filePath === filePath) await closeFile()
    // The directory watcher also emits TRACKED_DIRS_CHANGED on unlink; this
    // rescan just removes the row without waiting on it.
    await rescanDirectory(target.dirPath)
  }, [filePath, closeFile, rescanDirectory])

  if (collapsed) {
    return (
      <div className="w-10 bg-surface-2 flex flex-col items-center py-2 gap-1">
        <button
          onClick={toggleSidebar}
          title="Expand sidebar"
          aria-label="Expand sidebar"
          className="w-7 h-7 flex items-center justify-center rounded-md text-neutral-400 dark:text-neutral-500 hover:bg-neutral-200 dark:hover:bg-neutral-700 hover:text-neutral-600 dark:hover:text-neutral-300 transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
        <div className="flex-1" />
      </div>
    )
  }

  return (
    <div className="w-full bg-surface-2 flex flex-col overflow-hidden">
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
            className="absolute left-1.5 top-1/2 -translate-y-1/2 text-neutral-400 dark:text-neutral-500 pointer-events-none"
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
        <button
          onClick={handleCreateFile}
          title="New agent"
          aria-label="New agent"
          className="w-6 h-6 flex items-center justify-center rounded text-neutral-500 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-100 hover:bg-neutral-200 dark:hover:bg-neutral-700 transition-colors"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
        <button
          onClick={openFolderMenu}
          title="Open agent or track folder"
          aria-label="Open agent or track folder"
          aria-haspopup="menu"
          aria-expanded={folderMenu !== null}
          className="w-6 h-6 flex items-center justify-center rounded text-neutral-500 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-100 hover:bg-neutral-200 dark:hover:bg-neutral-700 transition-colors"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
        </button>
        <button
          onClick={toggleSidebar}
          title="Collapse sidebar"
          aria-label="Collapse sidebar"
          className="w-7 h-7 flex items-center justify-center rounded-md text-neutral-400 dark:text-neutral-500 hover:bg-neutral-200 dark:hover:bg-neutral-700 hover:text-neutral-600 dark:hover:text-neutral-300 transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
      </div>

      {!searching && runningRows.length > 0 && (
        <RunningSection
          rows={runningRows}
          currentFilePath={filePath}
          meshEnabled={meshEnabled}
          agentStatusMap={agentStatusMap}
          backgroundAgentMap={backgroundAgentMap}
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
        {directories.length > 0 ? (
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
          <p className="px-3 py-4 text-[11px] leading-4 text-[var(--adf-ui-text-subtle)]">
            Open an agent to get started.
          </p>
        )}
      </div>

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
          dirPath={untrackTarget}
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
          onCloned={() => rescanDirectory(cloneTarget.dirPath)}
        />
      )}
      {deleteTarget && (
        <DeleteAgentDialog
          target={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDeleted={handleDeleted}
        />
      )}
    </div>
  )
}

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
  onOpenFile: (filePath: string) => void
  onFileContextMenu: (e: React.MouseEvent, file: TrackedDirEntry, dirPath: string) => void
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
    onChange: (h) => setCap(resolveCap(h)),
    onCommit: (h) => saveStoredSize(SIDEBAR_RUNNING_CAP_KEY, resolveCap(h))
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
          {rows.map(({ file, dirPath, folderHint }) => (
            <AgentFileRow
              key={file.filePath}
              file={file}
              depth={0}
              isActive={file.filePath === currentFilePath}
              meshEnabled={meshEnabled}
              status={agentStatusMap.get(file.filePath)}
              backgroundStatus={backgroundAgentMap.get(file.filePath)}
              folderHint={folderHint}
              onOpen={() => onOpenFile(file.filePath)}
              onContextMenu={(e) => onFileContextMenu(e, file, dirPath)}
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
  forceExpanded = false
}: {
  dirPath: string
  files: TrackedDirEntry[]
  currentFilePath: string | null
  meshEnabled: boolean
  agentStatusMap: Map<string, MeshAgentStatus>
  backgroundAgentMap: Map<string, BackgroundAgentStatus>
  foregroundAgentState: string
  onOpenFile: (filePath: string) => void
  onFileContextMenu: (e: React.MouseEvent, file: TrackedDirEntry, dirPath: string) => void
  onDirContextMenu: (e: React.MouseEvent, dirPath: string) => void
  /** Show children regardless of the user's collapse state (used while searching). */
  forceExpanded?: boolean
}) {
  const [userExpanded, toggleExpanded] = useFolderExpanded(dirPath)
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
        await stopAgentsSequentially(allFiles, currentFilePath, backgroundAgentMap)
      } else {
        await startAgentsSequentially(allFiles, currentFilePath, foregroundRunning, backgroundAgentMap)
      }
    } catch (err) {
      console.error('[Sidebar] Directory toggle failed:', err)
    } finally {
      setToggling(false)
    }
  }, [allActive, toggling, allFiles, currentFilePath, foregroundInTree, foregroundRunning, backgroundAgentMap])

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
        onContextMenu={(e) => onDirContextMenu(e, dirPath)}
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
              No .adf files
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
  forceExpanded = false
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
  onOpenFile: (filePath: string) => void
  onFileContextMenu: (e: React.MouseEvent, file: TrackedDirEntry, dirPath: string) => void
  forceExpanded?: boolean
}) {
  const [userExpanded, toggleExpanded] = useFolderExpanded(entry.filePath)
  const expanded = forceExpanded || userExpanded
  const [toggling, setToggling] = useState(false)

  if (entry.isDirectory) {
    const collectFiles = (node: TrackedDirEntry): TrackedDirEntry[] => {
      if (!node.isDirectory) return [node]
      return (node.children || []).flatMap(collectFiles)
    }
    const allFiles = collectFiles(entry)
    const totalCount = allFiles.length

    const foregroundInSubtree = currentFilePath !== null && allFiles.some((f) => f.filePath === currentFilePath)
    const foregroundRunning = foregroundInSubtree && foregroundAgentState !== 'off'

    const nonForegroundFiles = allFiles.filter((f) => f.filePath !== currentFilePath)
    const nonForegroundActiveCount = nonForegroundFiles.filter((f) => backgroundAgentMap.has(f.filePath)).length
    const activeCount = nonForegroundActiveCount + (foregroundInSubtree && foregroundRunning ? 1 : 0)

    const allActive = totalCount > 0 && activeCount === totalCount

    const handleDirToggle = useCallback(async (e: React.MouseEvent) => {
      e.stopPropagation()
      if (toggling) return
      setToggling(true)
      try {
        if (allActive) {
          await stopAgentsSequentially(allFiles, currentFilePath, backgroundAgentMap)
        } else {
          await startAgentsSequentially(allFiles, currentFilePath, foregroundRunning, backgroundAgentMap)
        }
      } catch (err) {
        console.error('[Sidebar] Subdirectory toggle failed:', err)
      } finally {
        setToggling(false)
      }
    }, [allActive, toggling, allFiles, currentFilePath, foregroundInSubtree, foregroundRunning, backgroundAgentMap])

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
      onOpen={() => onOpenFile(entry.filePath)}
      onContextMenu={(e) => onFileContextMenu(e, entry, dirPath)}
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
  onOpen,
  onContextMenu
}: {
  file: TrackedDirEntry
  depth: number
  isActive: boolean
  meshEnabled: boolean
  status: MeshAgentStatus | undefined
  backgroundStatus: BackgroundAgentStatus | undefined
  /** Muted parent-folder name shown after the agent name to tell same-named agents apart. */
  folderHint?: string
  onOpen: () => void
  onContextMenu: (e: React.MouseEvent) => void
}) {
  const [toggling, setToggling] = useState(false)
  const agentState = useAgentStore((s) => isActive ? s.state : 'off')
  // Inner loops only — main is the dot. A primitive selector, so a streaming
  // side loop re-renders the row on the count, not on every delta.
  const foregroundActiveLoops = useAgentStore((s) =>
    isActive ? Object.values(s.sideLoops).filter((l) => l.state === 'active').length : 0
  )
  const isStarting = useAppStore((s) => s.startingFilePaths.has(file.filePath))
  const isStopping = useAppStore((s) => s.stoppingFilePaths.has(file.filePath))
  const agentConfig = useAgentStore((s) => isActive ? s.config : null)

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

  // Same avatar the fleet map draws: the file's icon, else a stable pick
  // seeded by the agent id so the two surfaces never disagree.
  const icon = isActive
    ? (agentConfig?.icon || pickAgentIcon(agentConfig?.id || file.filePath))
    : (file.icon || pickAgentIcon(file.agentId || file.filePath))

  const canReceive = isActive
    ? (agentConfig?.messaging?.receive ?? false)
    : (status?.canReceive ?? file.canReceive ?? false)
  const sendMode = isActive
    ? agentConfig?.messaging?.mode
    : (status?.sendMode ?? file.sendMode)

  // Drag the row out of the app: a consistent snapshot of the .adf lands
  // wherever it is dropped (Finder, a message, another Studio).
  const shareDrag = useShareDrag(file.filePath)

  const handleToggle = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation()
      if (toggling) return

      // Review gate: check before starting
      if (!isRunning && await needsReviewBeforeStart(isActive)) return

      setToggling(true)
      try {
        await toggleAgent(file.filePath, isActive, isRunning)
      } catch (err) {
        console.error('[Sidebar] Toggle agent failed:', err)
      } finally {
        setToggling(false)
      }
    },
    [file.filePath, isActive, isRunning, toggling]
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
      onClick={onOpen}
      onContextMenu={onContextMenu}
      data-active={isActive || undefined}
      className={`group flex items-center gap-1.5 py-[3px] text-[11px] leading-4 cursor-pointer ${
        isActive
          ? 'bg-[var(--adf-ui-accent-subtle)] text-[var(--adf-ui-accent)] [--row-bg:var(--adf-ui-accent-subtle)]'
          : `${isRunning ? 'text-[var(--adf-ui-text)]' : 'text-[var(--adf-ui-text-muted)]'} hover:bg-[var(--adf-ui-surface-hover)] [--row-bg:var(--adf-surface-2)] hover:[--row-bg:var(--adf-ui-surface-hover)]`
      }`}
      style={{ paddingLeft: `${12 + depth * 16}px`, paddingRight: '6px' }}
    >
      <AgentAvatar
        icon={icon}
        running={isRunning}
        state={dotState}
        starting={(toggling && !isRunning) || isStarting}
        stopping={(toggling && isRunning) || isStopping}
      />

      {/* The full path is the hint; a native title never renders in this
          window, so the portal tooltip carries it instead. */}
      <Tooltip tip={file.filePath} delay={1000} className="flex min-w-0 shrink">
        {/* No handler of its own: the click bubbles to the row. It stays a
            button so the row is reachable and openable from the keyboard. */}
        <button className="block w-full min-w-0 text-left truncate">
          {(isActive ? agentConfig?.name : undefined) ?? file.agentName ?? file.fileName}
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
          <span className="text-[9px] leading-none font-bold text-amber-600 dark:text-yellow-400 tabular-nums">
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
 * Emoji avatar with the status dot as a corner badge. A stopped agent is
 * drawn desaturated with no badge, so a quiet tree stays grey and only the
 * running agents carry colour; the badge then adds the finer state.
 */
const AgentAvatar = memo(function AgentAvatar({
  icon,
  running,
  state,
  starting,
  stopping
}: {
  icon: string
  running: boolean
  state: AgentState
  starting?: boolean
  stopping?: boolean
}) {
  const busy = starting || stopping
  const showBadge = busy || state !== 'not_participating'
  return (
    <span className="relative shrink-0 w-4 h-4 flex items-center justify-center">
      <span
        aria-hidden="true"
        className={`text-[12px] leading-none select-none transition-[filter,opacity] ${
          running || busy ? '' : 'grayscale opacity-70'
        }`}
      >
        {icon}
      </span>
      {showBadge && (
        // A ring in the row's own colour lifts the badge off the glyph beneath
        // it; the row sets --row-bg for rest, hover and selected.
        <span className="absolute -bottom-0.5 -right-0.5 flex rounded-full shadow-[0_0_0_1.5px_var(--row-bg,var(--adf-surface-2))]">
          <StatusDot state={state} starting={starting} stopping={stopping} />
        </span>
      )}
    </span>
  )
})

const StatusDot = memo(function StatusDot({ state, starting, stopping }: { state: AgentState; starting?: boolean; stopping?: boolean }) {
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
      <Tooltip tip="Starting" className="relative shrink-0 w-2 h-2 flex">
        <span className="absolute inset-[-1px] rounded-full border border-yellow-400 border-t-transparent animate-spin" />
      </Tooltip>
    )
  }

  if (stopping) {
    return (
      <Tooltip tip="Stopping" className="relative shrink-0 w-2 h-2 flex">
        <span className="absolute inset-[-1px] rounded-full border border-neutral-400 dark:border-neutral-500 border-t-transparent animate-spin" />
      </Tooltip>
    )
  }

  return (
    <Tooltip tip={label} className="relative shrink-0 w-2 h-2 flex">
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
      setError(String(err))
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
  onRenamed: (target: RowTarget, newPath: string, name: string) => void
}) {
  const initial = target.file.agentName ?? target.file.fileName.replace(/\.adf$/i, '')
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
      const result = await window.adfApi.renameFile(target.file.filePath, trimmed)
      if (result.success && result.filePath) {
        onRenamed(target, result.filePath, trimmed)
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
      const result = await window.adfApi.deleteFile(target.file.filePath)
      if (result.success) {
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
