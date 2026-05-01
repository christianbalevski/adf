import { useCallback } from 'react'
import { useDocumentStore } from '../../stores/document.store'
import { useAgentStore } from '../../stores/agent.store'
import { useMeshStore } from '../../stores/mesh.store'
import { useBackgroundAgentsStore } from '../../stores/background-agents.store'

export function TitleBar() {
  const fileName = useDocumentStore((s) => s.fileName)
  const isDirty = useDocumentStore((s) => s.isDirty)
  const agentState = useAgentStore((s) => s.state)
  const meshEnabled = useMeshStore((s) => s.enabled)
  const backgroundAgentCount = useBackgroundAgentsStore((s) => s.agents.length)

  const foregroundActive = agentState !== 'off'
  const isAnythingRunning = foregroundActive || backgroundAgentCount > 0 || meshEnabled
  const isMac = window.adfApi?.platform === 'darwin'

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
      className="h-10 bg-neutral-100 dark:bg-neutral-800 border-b border-neutral-200 dark:border-neutral-700 flex items-center justify-center select-none"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      {/* Left spacer — mac: traffic lights; win/linux: none (overlay controls are on the right) */}
      <div className={isMac ? 'w-20' : 'w-3'} />
      <div className="flex-1 text-center flex items-center justify-center gap-2">
        <span className="text-lg">📄</span>
        <span className="text-sm text-neutral-600 dark:text-neutral-300 font-medium">
          {fileName ? `${fileName}${isDirty ? ' •' : ''}` : 'ADF'}
        </span>
      </div>
      {/* Right side — mac: pr-3; win/linux: pad 140px for native overlay (min/max/close) */}
      <div
        className="flex items-center justify-end"
        style={{ paddingRight: isMac ? 12 : 152, width: isMac ? 112 : 260 }}
      >
        <button
          onClick={isAnythingRunning ? handleEmergencyStop : undefined}
          disabled={!isAnythingRunning}
          className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] font-medium uppercase tracking-wider transition-colors ${
            isAnythingRunning
              ? 'text-red-500 hover:text-white hover:bg-red-500 cursor-pointer'
              : 'text-neutral-300 dark:text-neutral-600 cursor-default'
          }`}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          title={isAnythingRunning ? 'Stop all agents and disable mesh' : 'Nothing running'}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="1" y="1" width="8" height="8" rx="1" fill="currentColor" />
          </svg>
          Kill
        </button>
      </div>
    </div>
  )
}
