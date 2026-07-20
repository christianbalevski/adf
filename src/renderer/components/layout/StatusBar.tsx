import { useState, useEffect } from 'react'
import { useAgentStore } from '../../stores/agent.store'
import { useDocumentStore } from '../../stores/document.store'
import { useMeshStore } from '../../stores/mesh.store'
import { useBackgroundAgentsStore } from '../../stores/background-agents.store'
import { useAppStore } from '../../stores/app.store'
import { AgentStatus } from '../agent/AgentStatus'

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

function tokenUsageTooltip(u: { input: number; output: number; cache_read?: number; cache_write?: number; reasoning?: number; estimated?: boolean }): string | undefined {
  if (u.estimated) return 'Pre-flight estimate — the actual count arrives when the call completes'
  if (u.input <= 0) return undefined
  const parts = [`in ${u.input.toLocaleString()}`, `out ${u.output.toLocaleString()}`]
  if (u.cache_read !== undefined) parts.push(`cache read ${u.cache_read.toLocaleString()}`)
  if (u.cache_write !== undefined) parts.push(`cache write ${u.cache_write.toLocaleString()}`)
  if (u.reasoning !== undefined) parts.push(`reasoning ${u.reasoning.toLocaleString()}`)
  return `Last LLM call — ${parts.join(' · ')}`
}

function MeshIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
      <path d="M8.5 15.5a5 5 0 0 1 0-7" strokeLinecap="round" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7" strokeLinecap="round" />
      <path d="M6 18a9 9 0 0 1 0-12" strokeLinecap="round" />
      <path d="M18 6a9 9 0 0 1 0 12" strokeLinecap="round" />
    </svg>
  )
}

export function StatusBar() {
  const config = useAgentStore((s) => s.config)
  const tokenUsage = useAgentStore((s) => s.tokenUsage)
  const [appVersion, setAppVersion] = useState('')
  useEffect(() => {
    window.adfApi?.getAppVersion().then(setAppVersion).catch(() => {})
  }, [])
  const isDirty = useDocumentStore((s) => s.isDirty)
  const agentState = useAgentStore((s) => s.state)
  const meshEnabled = useMeshStore((s) => s.enabled)
  const meshAgents = useMeshStore((s) => s.agents)
  const backgroundAgentCount = useBackgroundAgentsStore((s) => s.agents.length)
  const showLogsPanel = useAppStore((s) => s.showLogsPanel)
  const toggleLogsPanel = useAppStore((s) => s.toggleLogsPanel)
  const bottomPanelTab = useAppStore((s) => s.bottomPanelTab)
  const setBottomPanelTab = useAppStore((s) => s.setBottomPanelTab)
  const activeAgentCount = meshAgents.filter((a) => a.participating).length
  const isAnythingRunning = agentState !== 'off' || backgroundAgentCount > 0 || meshEnabled

  const handleSave = async () => {
    const result = await window.adfApi?.saveFile()
    if (result?.success) {
      useDocumentStore.getState().setDirty(false)
    }
  }

  const handleEmergencyStop = async () => {
    try {
      await window.adfApi.emergencyStop()
    } catch (err) {
      console.error('[StatusBar] Emergency stop failed:', err)
    }
    useAgentStore.getState().setState('off')
    useMeshStore.getState().reset()
    useBackgroundAgentsStore.getState().reset()
  }

  return (
    <div className="h-7 bg-neutral-100 dark:bg-neutral-800 border-t border-neutral-200 dark:border-neutral-700 flex items-center px-3 gap-4 text-xs text-neutral-500 dark:text-neutral-400">
      <AgentStatus />
      <div className="w-px h-3.5 bg-neutral-300 dark:bg-neutral-600" />
      <span>{config?.model?.model_id ?? 'No model'}</span>
      <div className="w-px h-3.5 bg-neutral-300 dark:bg-neutral-600" />
      <button
        onClick={handleSave}
        className="hover:text-neutral-700 dark:hover:text-neutral-200"
        title="Save"
      >
        {isDirty ? 'Unsaved changes' : 'Saved'}
      </button>
      <div className="w-px h-3.5 bg-neutral-300 dark:bg-neutral-600" />
      <span title={tokenUsageTooltip(tokenUsage)}>
        {tokenUsage.input > 0
          ? `${tokenUsage.estimated ? '~' : ''}${formatTokens(tokenUsage.input + tokenUsage.output)} tokens${tokenUsage.estimated ? ' (est.)' : ''}`
          : '– tokens'}
      </span>
      <div className="w-px h-3.5 bg-neutral-300 dark:bg-neutral-600" />
      <button
        onClick={() => {
          if (showLogsPanel && bottomPanelTab === 'logs') {
            toggleLogsPanel()
          } else {
            setBottomPanelTab('logs')
            if (!showLogsPanel) toggleLogsPanel()
          }
        }}
        className={`flex items-center gap-1 hover:text-neutral-700 dark:hover:text-neutral-200 ${showLogsPanel && bottomPanelTab === 'logs' ? 'text-blue-500' : ''}`}
        title="Toggle Logs Panel"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="4 17 10 11 4 5" />
          <line x1="12" y1="19" x2="20" y2="19" />
        </svg>
        Logs
      </button>
      <button
        onClick={() => {
          if (showLogsPanel && bottomPanelTab === 'tasks') {
            toggleLogsPanel()
          } else {
            setBottomPanelTab('tasks')
            if (!showLogsPanel) toggleLogsPanel()
          }
        }}
        className={`flex items-center gap-1 hover:text-neutral-700 dark:hover:text-neutral-200 ${showLogsPanel && bottomPanelTab === 'tasks' ? 'text-blue-500' : ''}`}
        title="Toggle Tasks Panel"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 11l3 3L22 4" />
          <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
        </svg>
        Tasks
      </button>
      <span
        className="ml-auto tabular-nums text-neutral-400 dark:text-neutral-500"
        title="ADF Studio version"
      >
        {appVersion ? `v${appVersion}` : ''}
      </span>
      <span
        role="status"
        className={`flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium ${
            meshEnabled
              ? 'bg-green-100 text-green-700 dark:bg-green-900/35 dark:text-green-300'
              : 'bg-neutral-200 text-neutral-500 dark:bg-neutral-700 dark:text-neutral-400'
        }`}
        title={meshEnabled ? `Mesh is running with ${activeAgentCount} participating agents` : 'Mesh is off; manage it in Settings > Networking'}
      >
        <MeshIcon />
        {meshEnabled ? `Mesh (${activeAgentCount})` : 'Mesh off'}
      </span>
      <button
        onClick={isAnythingRunning ? handleEmergencyStop : undefined}
        disabled={!isAnythingRunning}
        className={`flex items-center gap-1.5 rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider transition-colors ${
          isAnythingRunning
            ? 'text-red-600 hover:bg-red-500 hover:text-white dark:text-red-400'
            : 'cursor-default text-neutral-300 dark:text-neutral-600'
        }`}
        title={isAnythingRunning ? 'Stop all agents and disable mesh' : 'Nothing running'}
      >
        <svg width="9" height="9" viewBox="0 0 10 10" fill="none" aria-hidden="true">
          <rect x="1" y="1" width="8" height="8" rx="1" fill="currentColor" />
        </svg>
        Kill
      </button>
    </div>
  )
}
