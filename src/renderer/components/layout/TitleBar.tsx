import { useCallback, useEffect, useMemo, useState } from 'react'
import { useDocumentStore } from '../../stores/document.store'
import { useAgentStore } from '../../stores/agent.store'
import { useAppStore } from '../../stores/app.store'
import { useMeshStore } from '../../stores/mesh.store'
import { useBackgroundAgentsStore } from '../../stores/background-agents.store'
import { useAdfFile } from '../../hooks/useAdfFile'
import { toDisplayState } from '../../hooks/useAgent'

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

function firstGrapheme(value: string): string {
  return [...segmenter.segment(value)][0]?.segment ?? value[0] ?? ''
}

function NavButton({
  title,
  active,
  onClick,
  children
}: {
  title: string
  active?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`w-7 h-7 flex items-center justify-center rounded-md transition-colors ${
        active
          ? 'bg-blue-100 text-blue-600 dark:bg-blue-900/40 dark:text-blue-400'
          : 'text-neutral-500 dark:text-neutral-400 hover:bg-neutral-200 dark:hover:bg-neutral-700'
      }`}
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      {children}
    </button>
  )
}

export function TitleBar() {
  const filePath = useDocumentStore((s) => s.filePath)
  const isDirty = useDocumentStore((s) => s.isDirty)
  const showSettings = useAppStore((s) => s.showSettings)
  const setShowSettings = useAppStore((s) => s.setShowSettings)
  const showMeshGraph = useAppStore((s) => s.showMeshGraph)
  const setShowMeshGraph = useAppStore((s) => s.setShowMeshGraph)
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed)
  const agentState = useAgentStore((s) => s.state)
  const config = useAgentStore((s) => s.config)
  const statusText = useAgentStore((s) => s.statusText)
  const setState = useAgentStore((s) => s.setState)
  const setSessionId = useAgentStore((s) => s.setSessionId)
  const addLogEntry = useAgentStore((s) => s.addLogEntry)
  const meshEnabled = useMeshStore((s) => s.enabled)
  const backgroundAgentCount = useBackgroundAgentsStore((s) => s.agents.length)
  const { closeFile } = useAdfFile()
  const [starting, setStarting] = useState(false)

  const foregroundActive = agentState !== 'off'
  const isAnythingRunning = foregroundActive || backgroundAgentCount > 0 || meshEnabled
  const isMac = window.adfApi?.platform === 'darwin'
  const leftPaneWidth = showSettings ? 256 : sidebarCollapsed ? null : 240

  const isServing = !!(
    config?.serving?.public?.enabled ||
    config?.serving?.shared?.enabled ||
    (config?.serving?.api && config.serving.api.length > 0)
  )
  const [meshServerStatus, setMeshServerStatus] = useState<{
    running: boolean
    port: number
    host: string
  }>({ running: false, port: 7295, host: '127.0.0.1' })

  useEffect(() => {
    if (isServing) {
      window.adfApi?.getMeshServerStatus().then(setMeshServerStatus)
    }
  }, [isServing, agentState])

  const servingHandle = useMemo(() => {
    if (!isServing) return null
    return config?.handle || (filePath
      ? filePath
          .replace(/.*[\\/]/, '')
          .replace(/\.adf$/, '')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
      : 'agent')
  }, [isServing, config?.handle, filePath])

  const servingUrl = useMemo(() => {
    if (!servingHandle || !meshServerStatus.running) return null
    const displayHost = meshServerStatus.host === '0.0.0.0' ? '127.0.0.1' : meshServerStatus.host
    return `http://${displayHost}:${meshServerStatus.port}/${servingHandle}/`
  }, [servingHandle, meshServerStatus])

  const servingActive = isServing && meshServerStatus.running && foregroundActive

  const stateColors: Record<string, { color: string; ring?: boolean; pulse?: boolean }> = {
    active: { color: 'bg-yellow-400', pulse: true },
    idle: { color: 'bg-green-400' },
    hibernate: { color: 'bg-purple-500' },
    suspended: { color: 'border-red-400', ring: true },
    error: { color: 'bg-red-400' },
    off: { color: 'bg-neutral-400' }
  }
  const dotConfig = stateColors[agentState] ?? stateColors.off

  const handleHome = useCallback(() => {
    setShowSettings(false)
    setShowMeshGraph(false)
    if (filePath) closeFile()
  }, [closeFile, filePath, setShowMeshGraph, setShowSettings])

  const handleStart = useCallback(async () => {
    try {
      const review = await window.adfApi?.checkAgentReview()
      if (review?.needsReview) {
        useAppStore.getState().setAgentReviewDialog(true, review.configSummary)
        return
      }
    } catch {
      // Review failures should not prevent the user from starting the agent.
    }

    const activeFilePath = useDocumentStore.getState().filePath
    setStarting(true)
    if (activeFilePath) useAppStore.getState().addStartingFilePath(activeFilePath)
    try {
      const result = await window.adfApi?.startAgent()
      if (result?.success) {
        setState(toDisplayState(result.agentState ?? 'idle'))
        setSessionId(result.sessionId ?? null)
        addLogEntry({
          id: `system-${Date.now()}`,
          type: 'system',
          content: 'Agent started',
          timestamp: Date.now()
        })
      } else {
        const errorMessage = result?.error ?? 'Unknown error'
        addLogEntry({
          id: `error-${Date.now()}`,
          type: 'error',
          content: errorMessage,
          timestamp: Date.now()
        })
        if (errorMessage.includes('API key')) setShowSettings(true)
      }
    } finally {
      setStarting(false)
      if (activeFilePath) useAppStore.getState().removeStartingFilePath(activeFilePath)
    }
  }, [addLogEntry, setSessionId, setShowSettings, setState])

  const handleStop = useCallback(async () => {
    await window.adfApi?.stopAgent()
    setState('off')
    addLogEntry({
      id: `system-${Date.now()}`,
      type: 'system',
      content: 'Agent stopped',
      timestamp: Date.now()
    })
  }, [addLogEntry, setState])

  const handleEmergencyStop = useCallback(async () => {
    try {
      await window.adfApi.emergencyStop()
    } catch (err) {
      console.error('[TitleBar] Emergency stop failed:', err)
    }
    useAgentStore.getState().setState('off')
    useMeshStore.getState().reset()
    useBackgroundAgentsStore.getState().reset()
  }, [])

  return (
    <div
      className="relative h-10 shrink-0 border-b border-neutral-200 dark:border-neutral-700 flex items-center select-none"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <div
        className={`h-full flex items-center shrink-0 ${
          leftPaneWidth
            ? 'bg-neutral-50 dark:bg-neutral-900 border-r border-neutral-200 dark:border-neutral-700'
            : 'bg-neutral-100 dark:bg-neutral-800'
        }`}
        style={leftPaneWidth ? { width: leftPaneWidth } : undefined}
      >
        <div
          className={isMac ? 'w-20 shrink-0' : 'shrink-0'}
          style={isMac ? undefined : { width: 'calc(12px + env(titlebar-area-x, 0px))' }}
        />

        <nav
          className="flex items-center gap-0.5 shrink-0"
          aria-label="Application navigation"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <NavButton
            title="Home"
            active={!filePath && !showSettings && !showMeshGraph}
            onClick={handleHome}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              <polyline points="9 22 9 12 15 12 15 22" />
            </svg>
          </NavButton>
          <NavButton
            title="Age of Agents"
            active={showMeshGraph}
            onClick={() => { setShowSettings(false); setShowMeshGraph(true) }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2l8.66 5v10L12 22l-8.66-5V7z" />
            </svg>
          </NavButton>
          <NavButton
            title="Settings"
            active={showSettings}
            onClick={() => { setShowMeshGraph(false); setShowSettings(true) }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </NavButton>
        </nav>
      </div>

      <div className="h-full flex-1 min-w-0 bg-neutral-100 dark:bg-neutral-800 flex items-center">

      <div className="flex-1 min-w-0 px-3 flex items-center justify-center pointer-events-none">
        {filePath && config ? (
          <div
            className="pointer-events-auto flex items-center justify-center gap-1.5 min-w-0 max-w-full text-xs"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <span className="text-sm shrink-0" title={config.description || undefined}>
              {firstGrapheme(config.icon ?? '🤖')}
            </span>
            <span
              className="shrink-0 max-w-56 font-medium text-neutral-700 dark:text-neutral-200 truncate"
              title={config.description || config.name}
            >
              {config.name}{isDirty ? ' •' : ''}
            </span>
            <span className="shrink-0 flex items-center">
              {dotConfig.ring ? (
                <span className={`w-2 h-2 rounded-full border-[1.5px] ${dotConfig.color}`} title={agentState} />
              ) : dotConfig.pulse ? (
                <span className="relative w-2 h-2" title={agentState}>
                  <span className={`absolute inset-0 rounded-full ${dotConfig.color} animate-ping opacity-75`} />
                  <span className={`relative block w-2 h-2 rounded-full ${dotConfig.color}`} />
                </span>
              ) : (
                <span className={`w-2 h-2 rounded-full ${dotConfig.color}`} title={agentState} />
              )}
            </span>
            {statusText && (
              <span className="min-w-0 flex-1 text-neutral-500 dark:text-neutral-400 truncate" title={statusText}>
                {statusText}
              </span>
            )}
            {isServing && servingHandle && (
              servingActive && servingUrl ? (
                <a
                  href={servingUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={servingUrl}
                  className="pointer-events-auto shrink-0 text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300"
                  style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="2" y1="12" x2="22" y2="12" />
                    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                  </svg>
                </a>
              ) : (
                <span className="shrink-0 text-neutral-400 dark:text-neutral-500" title={`/${servingHandle}/ (inactive)`}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="2" y1="12" x2="22" y2="12" />
                    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                  </svg>
                </span>
              )
            )}
          </div>
        ) : (
          <span className="text-sm text-neutral-600 dark:text-neutral-300 font-medium">
            ADF Studio
          </span>
        )}
      </div>

      <div
        className="flex items-center justify-end gap-1 shrink-0"
        style={{
          WebkitAppRegion: 'no-drag',
          paddingRight: isMac
            ? 8
            : 'calc(8px + max(0px, 100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw)))'
        } as React.CSSProperties}
      >
        {filePath && config && (
          agentState === 'off' ? (
            <button
              onClick={handleStart}
              disabled={starting}
              className="h-6 px-2.5 text-[11px] font-medium bg-green-500 text-white rounded hover:bg-green-600 disabled:opacity-70 disabled:cursor-wait flex items-center gap-1.5"
            >
              {starting ? (
                <>
                  <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Starting
                </>
              ) : (
                <>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                    <polygon points="6,4 20,12 6,20" />
                  </svg>
                  Start
                </>
              )}
            </button>
          ) : (
            <button
              onClick={handleStop}
              className="h-6 px-2.5 text-[11px] font-medium bg-red-500 text-white rounded hover:bg-red-600 flex items-center gap-1.5"
            >
              <svg width="8" height="8" viewBox="0 0 10 10" fill="none">
                <rect x="1" y="1" width="8" height="8" rx="1" fill="currentColor" />
              </svg>
              Stop
            </button>
          )
        )}

        <button
          onClick={isAnythingRunning ? handleEmergencyStop : undefined}
          disabled={!isAnythingRunning}
          className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-medium uppercase tracking-wider transition-colors ${
            isAnythingRunning
              ? 'text-red-500 hover:text-white hover:bg-red-500 cursor-pointer'
              : 'text-neutral-300 dark:text-neutral-600 cursor-default'
          }`}
          title={isAnythingRunning ? 'Stop all agents and disable mesh' : 'Nothing running'}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="1" y="1" width="8" height="8" rx="1" fill="currentColor" />
          </svg>
          Kill
        </button>
      </div>
      </div>
    </div>
  )
}
