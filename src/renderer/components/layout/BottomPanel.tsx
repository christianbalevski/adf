import { useAppStore, LOGS_PANEL_HEIGHT_MIN, LOGS_PANEL_HEIGHT_MAX, LOGS_PANEL_HEIGHT_DEFAULT } from '../../stores/app.store'
import { useDragResize } from '../../hooks/useDragResize'
import { LOGS_PANEL_HEIGHT_KEY, saveStoredSize } from '../../utils/stored-size'
import { LogsPanel } from '../logs/LogsPanel'
import { TasksPanel } from '../tasks/TasksPanel'

export function BottomPanel() {
  const toggleLogsPanel = useAppStore((s) => s.toggleLogsPanel)
  const panelHeight = useAppStore((s) => s.logsPanelHeight)
  const setPanelHeight = useAppStore((s) => s.setLogsPanelHeight)
  const activeTab = useAppStore((s) => s.bottomPanelTab)
  const setActiveTab = useAppStore((s) => s.setBottomPanelTab)

  const handleResizeMouseDown = useDragResize({
    axis: 'y',
    grow: -1,
    min: LOGS_PANEL_HEIGHT_MIN,
    max: LOGS_PANEL_HEIGHT_MAX,
    getStart: () => panelHeight,
    onChange: setPanelHeight,
    onCommit: (h) => saveStoredSize(LOGS_PANEL_HEIGHT_KEY, h)
  })

  const resetHeight = () => {
    setPanelHeight(LOGS_PANEL_HEIGHT_DEFAULT)
    saveStoredSize(LOGS_PANEL_HEIGHT_KEY, LOGS_PANEL_HEIGHT_DEFAULT)
  }

  return (
    <div style={{ height: panelHeight }} className="flex flex-col border-t border-hairline bg-neutral-950 shrink-0">
      {/* Resize handle */}
      <div
        onMouseDown={handleResizeMouseDown}
        onDoubleClick={resetHeight}
        className="h-1 cursor-row-resize hover:bg-blue-500/40 transition-colors bg-transparent shrink-0"
      />

      {/* Tab bar */}
      <div className="flex items-center gap-0 px-2 bg-neutral-900 border-b border-white/5 text-xs shrink-0">
        <TabButton
          label="Logs"
          active={activeTab === 'logs'}
          onClick={() => setActiveTab('logs')}
        />
        <TabButton
          label="Tasks"
          active={activeTab === 'tasks'}
          onClick={() => setActiveTab('tasks')}
        />

        <div className="flex-1" />

        {/* Close button */}
        <button
          onClick={toggleLogsPanel}
          className="hover:bg-neutral-800 text-neutral-500 hover:text-neutral-300 px-1 py-0.5 rounded"
          title="Close panel"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Content */}
      {activeTab === 'logs' ? <LogsPanel /> : <TasksPanel />}
    </div>
  )
}

function TabButton({
  label,
  active,
  onClick
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 font-medium transition-colors ${
        active
          ? 'text-neutral-100 border-b-2 border-blue-500'
          : 'text-neutral-500 hover:text-neutral-300 border-b-2 border-transparent'
      }`}
    >
      {label}
    </button>
  )
}
