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

export function Sidebar() {
  const collapsed = useAppStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useAppStore((s) => s.toggleSidebar)
  const showSettings = useAppStore((s) => s.showSettings)
  const setShowSettings = useAppStore((s) => s.setShowSettings)
  const showMeshGraph = useAppStore((s) => s.showMeshGraph)
  const setShowMeshGraph = useAppStore((s) => s.setShowMeshGraph)
  const filePath = useDocumentStore((s) => s.filePath)
  const { openFile, createFile } = useAdfFile()
  const { loadDirectories } = useTrackedDirs()
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

  if (collapsed) {
    return (
      <div className="w-10 bg-surface-2 flex flex-col items-center py-2 gap-1">
        <button
          onClick={toggleSidebar}
          title="Expand Sidebar"
          className="w-8 h-8 flex items-center justify-center rounded-md text-neutral-500 dark:text-neutral-400 hover:bg-neutral-200 dark:hover:bg-neutral-700"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
        <div className="flex-1" />
      </div>
    )
  }

  return (
    <div className="w-60 bg-surface-2 flex flex-col overflow-hidden">
      <div className="h-9 px-2.5 flex items-center gap-1 shrink-0">
        <span className="flex-1 min-w-0 text-[10px] font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
          Agents
        </span>
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
          onClick={handleOpenFromPicker}
          title="Open agent"
          className="h-6 px-1.5 flex items-center gap-1 rounded text-[10px] font-medium text-neutral-500 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-100 hover:bg-neutral-200 dark:hover:bg-neutral-700 transition-colors"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
          Open
        </button>
        <button
          onClick={toggleSidebar}
          title="Collapse sidebar"
          aria-label="Collapse sidebar"
          className="w-6 h-6 flex items-center justify-center rounded text-neutral-400 dark:text-neutral-500 hover:bg-neutral-200 dark:hover:bg-neutral-700 transition-colors"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
      </div>

      {directories.length > 0 && (
        <div className="px-2.5 pb-2 shrink-0">
          <input
            value={agentSearch}
            onChange={(e) => setAgentSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setAgentSearch('')
            }}
            placeholder="Search…"
            aria-label="Search agents"
            className="w-full text-xs px-2 py-1 border border-neutral-200 dark:border-neutral-700 rounded bg-white dark:bg-neutral-900 text-neutral-800 dark:text-neutral-200 placeholder:text-neutral-400 dark:placeholder:text-neutral-500 outline-none focus:border-blue-400 min-w-0"
          />
        </div>
      )}

      {/* Only the agent tree scrolls; the title and actions remain visible. */}
      <div ref={dirScrollRef} className="scrollbar-autohide flex-1 min-h-0 overflow-y-auto">
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
                  forceExpanded={searching}
                />
              </div>
            ))}
            {searching && visibleDirectories.length === 0 && (
              <p className="px-3 py-4 text-xs text-neutral-400 dark:text-neutral-600">
                No agents match "{agentSearch.trim()}".
              </p>
            )}
          </div>
        ) : (
          <p className="px-3 py-4 text-xs text-neutral-400 dark:text-neutral-600">
            Open an agent to get started.
          </p>
        )}
      </div>
    </div>
  )
}

const DirectorySection = memo(function DirectorySection({
  dirPath,
  files,
  currentFilePath,
  meshEnabled,
  agentStatusMap,
  backgroundAgentMap,
  foregroundAgentState,
  onOpenFile,
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
  /** Show children regardless of the user's collapse state (used while searching). */
  forceExpanded?: boolean
}) {
  const [userExpanded, setExpanded] = useState(true)
  const expanded = forceExpanded || userExpanded
  const [toggling, setToggling] = useState(false)
  const dirName = dirPath.split('/').pop() ?? dirPath

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
        onClick={() => setExpanded((p) => !p)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded((p) => !p) } }}
        className="group w-full px-3 py-1 text-xs text-left flex items-center gap-1.5 text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 cursor-pointer select-none"
      >
        <span className="text-[10px] text-neutral-400 dark:text-neutral-500">
          {expanded ? '\u25BC' : '\u25B6'}
        </span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
        <span className="font-medium flex-1 truncate" title={dirPath}>
          {dirName}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="text-[10px] text-neutral-400 dark:text-neutral-500">
            ({activeCount}/{totalCount})
          </span>
          {totalCount > 0 && (
            <button
              onClick={handleDirToggle}
              disabled={toggling}
              role="switch"
              aria-checked={allActive}
              className={`relative shrink-0 w-7 h-4 rounded-full transition-[background-color,opacity] ${
                allActive
                  ? 'bg-green-400'
                  : 'bg-neutral-300 dark:bg-neutral-600'
              } ${
                activeCount > 0 || toggling
                  ? ''
                  : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
              } ${toggling ? 'opacity-50' : ''}`}
              title={allActive ? 'All running — click to stop all' : 'Click to start all agents'}
            >
              <span
                className={`absolute top-[2px] left-[2px] w-3 h-3 rounded-full bg-white shadow-sm transition-transform ${
                  allActive ? 'translate-x-3' : 'translate-x-0'
                }`}
              />
            </button>
          )}
        </span>
      </div>
      {expanded && (
        <div>
          {files.length === 0 && (
            <div className="px-3 py-1 text-[10px] text-neutral-300 dark:text-neutral-600 italic">
              No .adf files
            </div>
          )}
          {files.map((entry) => (
            <TreeNode
              key={entry.filePath}
              entry={entry}
              depth={0}
              currentFilePath={currentFilePath}
              meshEnabled={meshEnabled}
              agentStatusMap={agentStatusMap}
              backgroundAgentMap={backgroundAgentMap}
              foregroundAgentState={foregroundAgentState}
              onOpenFile={onOpenFile}
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
  currentFilePath,
  meshEnabled,
  agentStatusMap,
  backgroundAgentMap,
  foregroundAgentState,
  onOpenFile,
  forceExpanded = false
}: {
  entry: TrackedDirEntry
  depth: number
  currentFilePath: string | null
  meshEnabled: boolean
  agentStatusMap: Map<string, MeshAgentStatus>
  backgroundAgentMap: Map<string, BackgroundAgentStatus>
  foregroundAgentState: string
  onOpenFile: (filePath: string) => void
  forceExpanded?: boolean
}) {
  const [userExpanded, setExpanded] = useState(true)
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
          onClick={() => setExpanded((p) => !p)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded((p) => !p) } }}
          className="group flex items-center gap-1.5 py-1 text-xs cursor-pointer text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          style={{ paddingLeft: `${12 + depth * 16}px`, paddingRight: '12px' }}
        >
          <span className="text-[10px]">
            {expanded ? '\u25BC' : '\u25B6'}
          </span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
          <span className="font-medium flex-1 truncate">{entry.fileName}</span>

          <span className="flex items-center gap-1.5">
            <span className="text-[10px] text-neutral-400 dark:text-neutral-500">
              ({activeCount}/{totalCount})
            </span>
            {totalCount > 0 && (
              <button
                onClick={handleDirToggle}
                disabled={toggling}
                role="switch"
                aria-checked={allActive}
                className={`relative shrink-0 w-7 h-4 rounded-full transition-[background-color,opacity] ${
                  allActive
                    ? 'bg-green-400'
                    : 'bg-neutral-300 dark:bg-neutral-600'
                } ${
                  activeCount > 0 || toggling
                    ? ''
                    : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
                } ${toggling ? 'opacity-50' : ''}`}
                title={allActive ? 'All running — click to stop all' : 'Click to start all agents'}
              >
                <span
                  className={`absolute top-[2px] left-[2px] w-3 h-3 rounded-full bg-white shadow-sm transition-transform ${
                    allActive ? 'translate-x-3' : 'translate-x-0'
                  }`}
                />
              </button>
            )}
          </span>
        </div>
        {expanded && entry.children && (
          <div>
            {entry.children.map((child) => (
              <TreeNode
                key={child.filePath}
                entry={child}
                depth={depth + 1}
                currentFilePath={currentFilePath}
                meshEnabled={meshEnabled}
                agentStatusMap={agentStatusMap}
                backgroundAgentMap={backgroundAgentMap}
                foregroundAgentState={foregroundAgentState}
                onOpenFile={onOpenFile}
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
  onOpen
}: {
  file: TrackedDirEntry
  depth: number
  isActive: boolean
  meshEnabled: boolean
  status: MeshAgentStatus | undefined
  backgroundStatus: BackgroundAgentStatus | undefined
  onOpen: () => void
}) {
  const [toggling, setToggling] = useState(false)
  const agentState = useAgentStore((s) => isActive ? s.state : 'off')
  const isStarting = useAppStore((s) => s.startingFilePaths.has(file.filePath))
  const isStopping = useAppStore((s) => s.stoppingFilePaths.has(file.filePath))
  const agentConfig = useAgentStore((s) => isActive ? s.config : null)

  const isRunning = isActive
    ? agentState !== 'off'
    : backgroundStatus !== undefined

  const dotState: AgentState = isActive
    ? (agentState === 'off' ? 'not_participating' : agentState as AgentState)
    : (backgroundStatus ? toDisplayState(backgroundStatus.state) : 'not_participating')

  const isAutonomous = isActive
    ? (agentConfig?.autonomous ?? false)
    : (file.autonomous ?? false)

  const canReceive = isActive
    ? (agentConfig?.messaging?.receive ?? false)
    : (status?.canReceive ?? file.canReceive ?? false)
  const sendMode = isActive
    ? agentConfig?.messaging?.mode
    : (status?.sendMode ?? file.sendMode)

  const showToggle = true

  const handleToggle = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation()
      if (toggling) return

      // Review gate: check before starting
      if (!isRunning) {
        try {
          const review = isActive
            ? await window.adfApi.checkAgentReview()
            : null
          if (review?.needsReview) {
            useAppStore.getState().setAgentReviewDialog(true, review.configSummary)
            return
          }
        } catch { /* fall through */ }
      }

      setToggling(true)
      const startingFp = !isRunning ? file.filePath : null
      const stoppingFp = isRunning ? file.filePath : null
      if (startingFp) useAppStore.getState().addStartingFilePath(startingFp)
      if (stoppingFp) useAppStore.getState().addStoppingFilePath(stoppingFp)
      try {
        if (isActive) {
          if (isRunning) {
            await window.adfApi.stopAgent()
            useAgentStore.getState().setState('off')
          } else {
            const result = await window.adfApi.startAgent()
            if (result.success) {
              useAgentStore.getState().setState(toDisplayState(result.agentState ?? 'idle'))
            }
          }
        } else {
          if (isRunning) {
            await window.adfApi.stopBackgroundAgent(file.filePath)
          } else {
            await window.adfApi.startBackgroundAgent(file.filePath)
          }
        }
      } catch (err) {
        console.error('[Sidebar] Toggle agent failed:', err)
      } finally {
        setToggling(false)
        if (startingFp) useAppStore.getState().removeStartingFilePath(startingFp)
        if (stoppingFp) useAppStore.getState().removeStoppingFilePath(stoppingFp)
      }
    },
    [file.filePath, isActive, isRunning, toggling]
  )

  return (
    <div
      className={`group flex items-center gap-1.5 py-1 text-xs cursor-pointer ${
        isActive
          ? 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300'
          : 'text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800'
      }`}
      style={{ paddingLeft: `${12 + depth * 16}px`, paddingRight: '12px' }}
    >
      <span className="shrink-0 w-3 text-center text-[11px] leading-none text-neutral-500 dark:text-neutral-400 font-bold">
        {canReceive && sendMode === 'proactive' ? '\u21C5' :
         canReceive ? '\u2193' :
         sendMode === 'proactive' ? '\u2191' : ''}
      </span>

      <StatusDot
        state={dotState}
        starting={(toggling && !isRunning) || isStarting}
        stopping={(toggling && isRunning) || isStopping}
      />

      <button
        onClick={onOpen}
        className="flex-1 min-w-0 text-left truncate"
        title={file.filePath}
      >
        {(isActive ? agentConfig?.name : undefined) ?? file.agentName ?? file.fileName}
        {isAutonomous && (
          <span
            className="ml-1 text-[10px] leading-none text-amber-500"
            title="Autonomous — starts automatically"
          >
            {'⚡'}
          </span>
        )}
      </button>

      {showToggle && (
        <button
          onClick={handleToggle}
          disabled={toggling}
          role="switch"
          aria-checked={isRunning}
          className={`relative shrink-0 w-7 h-4 rounded-full transition-[background-color,opacity] ${
            isRunning
              ? (isAutonomous ? 'bg-amber-400' : 'bg-green-400')
              : 'bg-neutral-300 dark:bg-neutral-600'
          } ${
            isRunning || toggling || isStarting
              ? ''
              : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
          } ${toggling ? 'cursor-wait' : ''}`}
          title={isRunning ? 'Running — click to stop' : 'Stopped — click to start'}
        >
          <span
            className={`absolute top-[2px] left-[2px] w-3 h-3 rounded-full bg-white shadow-sm transition-transform ${
              isRunning ? 'translate-x-3' : 'translate-x-0'
            } ${toggling ? 'animate-pulse' : ''}`}
          />
        </button>
      )}
    </div>
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

  if (starting) {
    return (
      <span className="relative shrink-0 w-2 h-2" title="Starting">
        <span className="absolute inset-[-1px] rounded-full border border-yellow-400 border-t-transparent animate-spin" />
      </span>
    )
  }

  if (stopping) {
    return (
      <span className="relative shrink-0 w-2 h-2" title="Stopping">
        <span className="absolute inset-[-1px] rounded-full border border-neutral-400 dark:border-neutral-500 border-t-transparent animate-spin" />
      </span>
    )
  }

  return (
    <span className="relative shrink-0 w-2 h-2" title={label}>
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
    </span>
  )
})
