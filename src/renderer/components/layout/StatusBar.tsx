import { useAgentStore } from '../../stores/agent.store'
import { useDocumentStore } from '../../stores/document.store'
import { useMeshStore } from '../../stores/mesh.store'
import { useMesh } from '../../hooks/useMesh'
import { useAppStore } from '../../stores/app.store'
import { AgentStatus } from '../agent/AgentStatus'

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
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
  const isDirty = useDocumentStore((s) => s.isDirty)
  const meshEnabled = useMeshStore((s) => s.enabled)
  const meshAgents = useMeshStore((s) => s.agents)
  const { enableMesh, disableMesh } = useMesh()
  const showLogsPanel = useAppStore((s) => s.showLogsPanel)
  const toggleLogsPanel = useAppStore((s) => s.toggleLogsPanel)
  const bottomPanelTab = useAppStore((s) => s.bottomPanelTab)
  const setBottomPanelTab = useAppStore((s) => s.setBottomPanelTab)
  const activeAgentCount = meshAgents.filter((a) => a.participating).length

  const handleSave = async () => {
    const result = await window.adfApi?.saveFile()
    if (result?.success) {
      useDocumentStore.getState().setDirty(false)
    }
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
      <span>
        {tokenUsage.input > 0 ? `${formatTokens(tokenUsage.input)} tokens` : '– tokens'}
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
      <div className="ml-auto">
        <button
          onClick={meshEnabled ? disableMesh : enableMesh}
          className={`flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-medium transition-colors ${
            meshEnabled
              ? 'bg-green-500 text-white hover:bg-green-600'
              : 'bg-neutral-200 text-neutral-600 hover:bg-neutral-300 dark:bg-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-600'
          }`}
        >
          <span className={meshEnabled ? 'text-white' : 'text-neutral-400 dark:text-neutral-500'}>
            <MeshIcon />
          </span>
          {meshEnabled ? `Mesh (${activeAgentCount})` : 'Enable Mesh'}
        </button>
      </div>
    </div>
  )
}
