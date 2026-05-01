import { useEffect, useMemo, useState } from 'react'
import { useAgentStore } from '../../stores/agent.store'
import { useAppStore } from '../../stores/app.store'
import { useDocumentStore } from '../../stores/document.store'
import { toDisplayState } from '../../hooks/useAgent'
import { AgentStatus } from './AgentStatus'

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
function firstGrapheme(str: string): string {
  return [...segmenter.segment(str)][0]?.segment ?? str[0] ?? ''
}

export function AgentPanel() {
  const state = useAgentStore((s) => s.state)
  const config = useAgentStore((s) => s.config)
  const statusText = useAgentStore((s) => s.statusText)
  const setState = useAgentStore((s) => s.setState)
  const setSessionId = useAgentStore((s) => s.setSessionId)
  const addLogEntry = useAgentStore((s) => s.addLogEntry)
  const setShowSettings = useAppStore((s) => s.setShowSettings)
  const filePath = useDocumentStore((s) => s.filePath)
  const [starting, setStarting] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [meshServerStatus, setMeshServerStatus] = useState<{ running: boolean; port: number; host: string }>({ running: false, port: 7295, host: '127.0.0.1' })

  const isServing = !!(config?.serving?.public?.enabled || config?.serving?.shared?.enabled || (config?.serving?.api && config.serving.api.length > 0))

  useEffect(() => {
    if (isServing) {
      window.adfApi?.getMeshServerStatus().then(setMeshServerStatus)
    }
  }, [isServing, state])

  const servingHandle = useMemo(() => {
    if (!isServing) return null
    return config?.handle || (filePath ? filePath.replace(/.*[\\/]/, '').replace(/\.adf$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') : 'agent')
  }, [isServing, config?.handle, filePath])

  const servingUrl = useMemo(() => {
    if (!servingHandle || !meshServerStatus.running) return null
    const displayHost = meshServerStatus.host === '0.0.0.0' ? '127.0.0.1' : meshServerStatus.host
    return `http://${displayHost}:${meshServerStatus.port}/${servingHandle}/`
  }, [servingHandle, meshServerStatus])

  const servingActive = isServing && meshServerStatus.running && state !== 'off'

  const summary = useMemo(() => {
    if (!config) return null
    const toolsEnabled = config.tools?.filter((t) => t.enabled).length ?? 0
    const toolsTotal = config.tools?.length ?? 0
    const triggers = Object.values(config.triggers ?? {}).filter((t) => t?.enabled).length
    const routes = config.serving?.api?.length ?? 0
    const mcp = config.mcp?.servers?.length ?? 0
    const adapters = Object.keys(config.adapters ?? {}).length
    return { toolsEnabled, toolsTotal, triggers, routes, mcp, adapters }
  }, [config])

  const handleStart = async () => {
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
        addLogEntry({
          id: `system-${Date.now()}`,
          type: 'system',
          content: 'Agent started',
          timestamp: Date.now()
        })
      } else {
        const errorMsg = result?.error ?? 'Unknown error'
        addLogEntry({
          id: `error-${Date.now()}`,
          type: 'error',
          content: errorMsg,
          timestamp: Date.now()
        })
        // If API key is missing, prompt settings
        if (errorMsg.includes('API key')) {
          setShowSettings(true)
        }
      }
    } finally {
      setStarting(false)
      if (fp) useAppStore.getState().removeStartingFilePath(fp)
    }
  }

  const handleStop = async () => {
    await window.adfApi?.stopAgent()
    setState('off')
    addLogEntry({
      id: `system-${Date.now()}`,
      type: 'system',
      content: 'Agent stopped',
      timestamp: Date.now()
    })
  }

  return (
    <div className="p-2">
      <div className="bg-white dark:bg-neutral-800 rounded-lg border border-neutral-200 dark:border-neutral-700 p-2 space-y-1.5">
        {/* Header: icon + name + model */}
        <div className="flex items-center gap-2">
          <span className="text-lg shrink-0">{firstGrapheme(config?.icon ?? '🤖')}</span>
          <div className="min-w-0 flex-1">
            <h3
              className="text-sm font-semibold text-neutral-800 dark:text-neutral-100 truncate cursor-default"
              title={config?.description || undefined}
            >
              {config?.name ?? 'No Agent'}
            </h3>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              {config?.model?.model_id ?? 'Not configured'}
            </p>
          </div>
        </div>

        {/* Status line: dot + state + serving URL */}
        <div className="flex items-center gap-1.5 text-xs min-w-0">
          <AgentStatus />
          {isServing && servingHandle && (
            <>
              <span className="text-neutral-300 dark:text-neutral-600 shrink-0">&middot;</span>
              {servingActive && servingUrl ? (
                <a
                  href={servingUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-500 hover:text-blue-600 dark:text-blue-400 dark:hover:text-blue-300 font-mono truncate"
                >
                  /{servingHandle}/
                </a>
              ) : (
                <span className="text-neutral-400 dark:text-neutral-500 font-mono truncate">
                  /{servingHandle}/
                </span>
              )}
            </>
          )}
        </div>

        {/* Status text */}
        {statusText && (
          <p className="text-xs text-neutral-700 dark:text-neutral-200 line-clamp-2">{statusText}</p>
        )}

        {/* Start/Stop button */}
        {state === 'off' ? (
          <button
            onClick={handleStart}
            disabled={starting}
            className="w-full px-3 py-1.5 text-sm bg-green-500 text-white rounded-md hover:bg-green-600 disabled:opacity-70 disabled:cursor-wait"
          >
            {starting ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Starting&hellip;
              </span>
            ) : 'Start Agent'}
          </button>
        ) : (
          <button
            onClick={handleStop}
            className="w-full px-3 py-1.5 text-sm bg-red-500 text-white rounded-md hover:bg-red-600"
          >
            Stop Agent
          </button>
        )}

        {/* Collapsible details */}
        {config && summary && (
          <>
            <button
              onClick={() => setDetailsOpen((prev) => !prev)}
              className="w-full flex items-center gap-1 text-[11px] text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-300 transition-colors pt-0.5"
            >
              <span className="text-[8px]">{detailsOpen ? '\u25BC' : '\u25B6'}</span>
              <span>Details</span>
            </button>
            {detailsOpen && (
              <div className="space-y-1.5 pt-0.5">
                {/* Mode badges */}
                <div className="flex items-center gap-1.5 text-[11px]">
                  <span className={`px-1.5 py-0.5 rounded font-medium ${config.autonomous ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300' : 'bg-neutral-100 text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300'}`}>
                    {config.autonomous ? 'Auto' : 'Manual'}
                  </span>
                  {config.autostart && (
                    <span className="px-1.5 py-0.5 rounded bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300 font-medium">
                      Autostart
                    </span>
                  )}
                </div>
                {/* Stats grid */}
                <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs">
                  <div className="flex justify-between">
                    <span className="text-neutral-500 dark:text-neutral-400">Tools</span>
                    <span className="text-neutral-700 dark:text-neutral-200 tabular-nums">{summary.toolsEnabled}/{summary.toolsTotal}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-neutral-500 dark:text-neutral-400">Triggers</span>
                    <span className="text-neutral-700 dark:text-neutral-200 tabular-nums">{summary.triggers}</span>
                  </div>
                  {summary.routes > 0 && (
                    <div className="flex justify-between">
                      <span className="text-neutral-500 dark:text-neutral-400">Routes</span>
                      <span className="text-neutral-700 dark:text-neutral-200 tabular-nums">{summary.routes}</span>
                    </div>
                  )}
                  {summary.mcp > 0 && (
                    <div className="flex justify-between">
                      <span className="text-neutral-500 dark:text-neutral-400">MCP</span>
                      <span className="text-neutral-700 dark:text-neutral-200 tabular-nums">{summary.mcp}</span>
                    </div>
                  )}
                  {summary.adapters > 0 && (
                    <div className="flex justify-between">
                      <span className="text-neutral-500 dark:text-neutral-400">Adapters</span>
                      <span className="text-neutral-700 dark:text-neutral-200 tabular-nums">{summary.adapters}</span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
