import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAgentStore } from '../../stores/agent.store'
import { useAppStore } from '../../stores/app.store'
import { useDocumentStore } from '../../stores/document.store'
import { useAdfFile } from '../../hooks/useAdfFile'
import { toDisplayState } from '../../hooks/useAgent'

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
function firstGrapheme(str: string): string {
  return [...segmenter.segment(str)][0]?.segment ?? str[0] ?? ''
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
    >
      {children}
    </button>
  )
}

export function SubHeader() {
  const filePath = useDocumentStore((s) => s.filePath)
  const showSettings = useAppStore((s) => s.showSettings)
  const setShowSettings = useAppStore((s) => s.setShowSettings)
  const showMeshGraph = useAppStore((s) => s.showMeshGraph)
  const setShowMeshGraph = useAppStore((s) => s.setShowMeshGraph)
  const { createFile, openFile, closeFile } = useAdfFile()

  // Agent state
  const agentState = useAgentStore((s) => s.state)
  const config = useAgentStore((s) => s.config)
  const statusText = useAgentStore((s) => s.statusText)
  const setState = useAgentStore((s) => s.setState)
  const setSessionId = useAgentStore((s) => s.setSessionId)
  const addLogEntry = useAgentStore((s) => s.addLogEntry)
  const [starting, setStarting] = useState(false)

  // Serving
  const isServing = !!(config?.serving?.public?.enabled || config?.serving?.shared?.enabled || (config?.serving?.api && config.serving.api.length > 0))
  const [meshServerStatus, setMeshServerStatus] = useState<{ running: boolean; port: number; host: string }>({ running: false, port: 7295, host: '127.0.0.1' })

  useEffect(() => {
    if (isServing) {
      window.adfApi?.getMeshServerStatus().then(setMeshServerStatus)
    }
  }, [isServing, agentState])

  const servingHandle = useMemo(() => {
    if (!isServing) return null
    return config?.handle || (filePath ? filePath.replace(/.*[\\/]/, '').replace(/\.adf$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') : 'agent')
  }, [isServing, config?.handle, filePath])

  const servingUrl = useMemo(() => {
    if (!servingHandle || !meshServerStatus.running) return null
    const displayHost = meshServerStatus.host === '0.0.0.0' ? '127.0.0.1' : meshServerStatus.host
    return `http://${displayHost}:${meshServerStatus.port}/${servingHandle}/`
  }, [servingHandle, meshServerStatus])

  const servingActive = isServing && meshServerStatus.running && agentState !== 'off'

  // State config for dot colors
  const stateColors: Record<string, { color: string; ring?: boolean; pulse?: boolean }> = {
    active: { color: 'bg-yellow-400', pulse: true },
    idle: { color: 'bg-green-400' },
    hibernate: { color: 'bg-purple-500' },
    suspended: { color: 'border-red-400', ring: true },
    error: { color: 'bg-red-400' },
    off: { color: 'bg-neutral-400' }
  }
  const dotConfig = stateColors[agentState] ?? stateColors.off

  const handleStart = useCallback(async () => {
    // Review gate: show review dialog if agent not yet reviewed
    try {
      const review = await window.adfApi?.checkAgentReview()
      if (review?.needsReview) {
        useAppStore.getState().setAgentReviewDialog(true, review.configSummary)
        return
      }
    } catch { /* fall through */ }

    const fp = useDocumentStore.getState().filePath
    setStarting(true)
    if (fp) useAppStore.getState().addStartingFilePath(fp)
    try {
      const result = await window.adfApi?.startAgent()
      if (result?.success) {
        setState(toDisplayState(result.agentState ?? 'idle'))
        setSessionId(result.sessionId ?? null)
        addLogEntry({ id: `system-${Date.now()}`, type: 'system', content: 'Agent started', timestamp: Date.now() })
      } else {
        const errorMsg = result?.error ?? 'Unknown error'
        addLogEntry({ id: `error-${Date.now()}`, type: 'error', content: errorMsg, timestamp: Date.now() })
        if (errorMsg.includes('API key')) {
          useAppStore.getState().setShowSettings(true)
        }
      }
    } finally {
      setStarting(false)
      if (fp) useAppStore.getState().removeStartingFilePath(fp)
    }
  }, [setState, setSessionId, addLogEntry])

  const handleStop = useCallback(async () => {
    await window.adfApi?.stopAgent()
    setState('off')
    addLogEntry({ id: `system-${Date.now()}`, type: 'system', content: 'Agent stopped', timestamp: Date.now() })
  }, [setState, addLogEntry])

  return (
    <div className="h-9 bg-neutral-50 dark:bg-neutral-850 border-b border-neutral-200 dark:border-neutral-700 flex items-center px-2 gap-1 select-none shrink-0"
      style={{ backgroundColor: 'var(--subheader-bg, inherit)' }}
    >
      {/* Left: Nav icons */}
      <div className="flex items-center gap-0.5 shrink-0">
        <NavButton
          title="Home"
          active={!filePath && !showSettings && !showMeshGraph}
          onClick={() => { setShowSettings(false); setShowMeshGraph(false); if (filePath) closeFile() }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            <polyline points="9 22 9 12 15 12 15 22" />
          </svg>
        </NavButton>
        <NavButton
          title="Mesh Graph"
          active={showMeshGraph}
          onClick={() => { setShowSettings(false); setShowMeshGraph(true) }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
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
      </div>

      {/* Divider */}
      <div className="w-px h-4 bg-neutral-200 dark:bg-neutral-700 mx-1 shrink-0" />

      {/* File actions */}
      <div className="flex items-center gap-0.5 shrink-0">
        <button
          onClick={() => createFile('Untitled')}
          title="New .adf"
          className="h-7 px-2 flex items-center gap-1 rounded-md text-xs text-neutral-600 dark:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-700 transition-colors"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          New
        </button>
        <button
          onClick={() => openFile()}
          title="Open .adf"
          className="h-7 px-2 flex items-center gap-1 rounded-md text-xs text-neutral-600 dark:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-700 transition-colors"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
          Open
        </button>
      </div>

      {/* Agent section — only when file is open */}
      {filePath && config && (
        <>
          {/* Divider */}
          <div className="w-px h-4 bg-neutral-200 dark:bg-neutral-700 mx-1 shrink-0" />

          {/* Agent info — this section shrinks */}
          <div className="flex items-center gap-1.5 min-w-0 flex-1 overflow-hidden">
            {/* Icon + name */}
            <span className="text-sm shrink-0" title={config.description || undefined}>{firstGrapheme(config.icon ?? '🤖')}</span>
            <span
              className="text-xs font-medium text-neutral-700 dark:text-neutral-200 shrink-0 cursor-default"
              title={config.description || undefined}
            >
              {config.name}
            </span>

            {/* State dot */}
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

            {/* Serving link */}
            {isServing && servingHandle && (
              servingActive && servingUrl ? (
                <a
                  href={servingUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={servingUrl}
                  className="shrink-0 text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300"
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

            {/* Status text — this is what truncates on narrow screens */}
            {statusText && (
              <>
                <span className="text-neutral-300 dark:text-neutral-600 shrink-0">&middot;</span>
                <span
                  className="text-xs text-neutral-500 dark:text-neutral-400 truncate"
                  title={statusText}
                >
                  {statusText}
                </span>
              </>
            )}
          </div>

          {/* Start/Stop button */}
          <div className="shrink-0 ml-1">
            {agentState === 'off' ? (
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
            )}
          </div>
        </>
      )}
    </div>
  )
}
