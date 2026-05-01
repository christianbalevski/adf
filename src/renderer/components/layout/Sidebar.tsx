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

export function Sidebar() {
  const collapsed = useAppStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useAppStore((s) => s.toggleSidebar)
  const showSettings = useAppStore((s) => s.showSettings)
  const setShowSettings = useAppStore((s) => s.setShowSettings)
  const showMeshGraph = useAppStore((s) => s.showMeshGraph)
  const setShowMeshGraph = useAppStore((s) => s.setShowMeshGraph)
  const filePath = useDocumentStore((s) => s.filePath)
  const { openFile } = useAdfFile()
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

  if (collapsed) {
    return (
      <div className="w-10 border-r border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900 flex flex-col items-center py-2 gap-1">
        <div className="flex-1" />
        <button
          onClick={toggleSidebar}
          title="Expand Sidebar"
          className="w-8 h-8 flex items-center justify-center rounded-md text-neutral-500 dark:text-neutral-400 hover:bg-neutral-200 dark:hover:bg-neutral-700"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      </div>
    )
  }

  return (
    <div className="w-60 border-r border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900 flex flex-col overflow-hidden">
      {/* Tracked directories — scrollable, fills all space */}
      <div ref={dirScrollRef} className="flex-1 min-h-0 overflow-y-auto">
        {directories.length > 0 && (
          <div>
            <div className="px-3 py-1.5 flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-neutral-400 dark:text-neutral-500">
                Tracked Directories
              </span>
              <button
                onClick={toggleSidebar}
                title="Collapse"
                className="w-5 h-5 flex items-center justify-center rounded text-neutral-400 dark:text-neutral-500 hover:bg-neutral-200 dark:hover:bg-neutral-700"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="15 18 9 12 15 6" />
                </svg>
              </button>
            </div>
            <div className="pb-1">
              {directories.map((dirPath, index) => (
                <div key={dirPath}>
                  {index > 0 && <div className="border-t border-neutral-200 dark:border-neutral-700 my-1" />}
                  <DirectorySection
                    dirPath={dirPath}
                    files={filesByDir[dirPath] ?? []}
                    currentFilePath={filePath}
                    meshEnabled={meshEnabled}
                    agentStatusMap={agentStatusMap}
                    backgroundAgentMap={backgroundAgentMap}
                    foregroundAgentState={foregroundAgentState}
                    onOpenFile={handleOpenFile}

                  />
                </div>
              ))}
            </div>
          </div>
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
  onOpenFile
}: {
  dirPath: string
  files: TrackedDirEntry[]
  currentFilePath: string | null
  meshEnabled: boolean
  agentStatusMap: Map<string, MeshAgentStatus>
  backgroundAgentMap: Map<string, BackgroundAgentStatus>
  foregroundAgentState: string
  onOpenFile: (filePath: string) => void
}) {
  const [expanded, setExpanded] = useState(true)
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
    const startedPaths: string[] = []
    try {
      if (allActive) {
        for (const file of allFiles) {
          if (file.filePath === currentFilePath) {
            await window.adfApi.stopAgent()
            useAgentStore.getState().setState('off')
          } else if (backgroundAgentMap.has(file.filePath)) {
            await window.adfApi.stopBackgroundAgent(file.filePath)
          }
        }
      } else {
        for (const file of allFiles) {
          if (file.filePath === currentFilePath && !foregroundRunning) {
            useAppStore.getState().addStartingFilePath(file.filePath)
            startedPaths.push(file.filePath)
            const result = await window.adfApi.startAgent()
            if (result.success) {
              useAgentStore.getState().setState(toDisplayState(result.agentState ?? 'idle'))
            }
          } else if (file.filePath !== currentFilePath && !backgroundAgentMap.has(file.filePath)) {
            useAppStore.getState().addStartingFilePath(file.filePath)
            startedPaths.push(file.filePath)
            await window.adfApi.startBackgroundAgent(file.filePath)
          }
        }
      }
    } catch (err) {
      console.error('[Sidebar] Directory toggle failed:', err)
    } finally {
      setToggling(false)
      for (const fp of startedPaths) useAppStore.getState().removeStartingFilePath(fp)
    }
  }, [allActive, toggling, allFiles, currentFilePath, foregroundInTree, foregroundRunning, backgroundAgentMap])

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        onClick={() => setExpanded((p) => !p)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded((p) => !p) } }}
        className="w-full px-3 py-1 text-xs text-left flex items-center gap-1.5 text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 cursor-pointer select-none"
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
              className={`relative shrink-0 w-7 h-4 rounded-full transition-colors ${
                allActive
                  ? 'bg-green-400'
                  : 'bg-neutral-300 dark:bg-neutral-600'
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
  onOpenFile
}: {
  entry: TrackedDirEntry
  depth: number
  currentFilePath: string | null
  meshEnabled: boolean
  agentStatusMap: Map<string, MeshAgentStatus>
  backgroundAgentMap: Map<string, BackgroundAgentStatus>
  foregroundAgentState: string
  onOpenFile: (filePath: string) => void
}) {
  const [expanded, setExpanded] = useState(true)
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
      const startedPaths: string[] = []
      try {
        if (allActive) {
          for (const file of allFiles) {
            if (file.filePath === currentFilePath) {
              await window.adfApi.stopAgent()
              useAgentStore.getState().setState('off')
            } else if (backgroundAgentMap.has(file.filePath)) {
              await window.adfApi.stopBackgroundAgent(file.filePath)
            }
          }
        } else {
          for (const file of allFiles) {
            if (file.filePath === currentFilePath && !foregroundRunning) {
              useAppStore.getState().addStartingFilePath(file.filePath)
              startedPaths.push(file.filePath)
              const result = await window.adfApi.startAgent()
              if (result.success) {
                useAgentStore.getState().setState(toDisplayState(result.agentState ?? 'idle'))
              }
            } else if (file.filePath !== currentFilePath && !backgroundAgentMap.has(file.filePath)) {
              useAppStore.getState().addStartingFilePath(file.filePath)
              startedPaths.push(file.filePath)
              await window.adfApi.startBackgroundAgent(file.filePath)
            }
          }
        }
      } catch (err) {
        console.error('[Sidebar] Subdirectory toggle failed:', err)
      } finally {
        setToggling(false)
        for (const fp of startedPaths) useAppStore.getState().removeStartingFilePath(fp)
      }
    }, [allActive, toggling, allFiles, currentFilePath, foregroundInSubtree, foregroundRunning, backgroundAgentMap])

    return (
      <div>
        <div
          role="button"
          tabIndex={0}
          onClick={() => setExpanded((p) => !p)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded((p) => !p) } }}
          className="flex items-center gap-1.5 py-1 text-xs cursor-pointer text-neutral-500 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          style={{ paddingLeft: `${12 + depth * 16}px`, paddingRight: '12px' }}
        >
          <span className="text-[10px]">
            {expanded ? '\u25BC' : '\u25B6'}
          </span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
          <span className="font-medium flex-1">{entry.fileName}</span>

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
                className={`relative shrink-0 w-7 h-4 rounded-full transition-colors ${
                  allActive
                    ? 'bg-green-400'
                    : 'bg-neutral-300 dark:bg-neutral-600'
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
      if (startingFp) useAppStore.getState().addStartingFilePath(startingFp)
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
      }
    },
    [file.filePath, isActive, isRunning, toggling]
  )

  return (
    <div
      className={`flex items-center gap-1.5 py-1 text-xs cursor-pointer ${
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

      <StatusDot state={dotState} starting={(toggling && !isRunning) || isStarting} />

      <button
        onClick={onOpen}
        className="flex-1 text-left truncate"
        title={file.filePath}
      >
        {file.fileName}
      </button>

      {showToggle && (
        <button
          onClick={handleToggle}
          disabled={toggling}
          role="switch"
          aria-checked={isRunning}
          className={`relative shrink-0 w-7 h-4 rounded-full transition-colors ${
            isRunning
              ? (isAutonomous ? 'bg-amber-400' : 'bg-green-400')
              : 'bg-neutral-300 dark:bg-neutral-600'
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

      <span className="shrink-0 w-2.5 text-center">
        {isAutonomous && (
          <span
            className="text-[10px] leading-none text-amber-500"
            title="Autonomous — starts automatically"
          >
            {'\u26A1'}
          </span>
        )}
      </span>
    </div>
  )
})

const StatusDot = memo(function StatusDot({ state, starting }: { state: AgentState; starting?: boolean }) {
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
