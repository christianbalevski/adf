import { TitleBar } from './TitleBar'
import { Sidebar } from './Sidebar'
import { SidebarFrame } from './SidebarFrame'
import { StatusBar } from './StatusBar'
import { MeshTrafficBar } from './MeshTrafficBar'
import { EditorPanel } from '../editor/EditorPanel'
import { RightDock, RightDockIconBar } from './RightDock'
import { SettingsPage } from '../settings/SettingsPage'
import { HomeScreen } from '../home/HomeScreen'
import { PasswordDialog } from '../common/PasswordDialog'
import { OwnerMismatchDialog } from '../common/OwnerMismatchDialog'
import { AgentReviewDialog } from '../common/AgentReviewDialog'
import { ProviderSetupDialog } from '../common/ProviderSetupDialog'
import { ShareAgentDialog } from '../common/ShareAgentDialog'
import { AgentReviewBanner } from '../common/AgentReviewBanner'
import { ShutdownOverlay } from '../common/ShutdownOverlay'
import { BottomPanel } from './BottomPanel'
import { MeshGraphView } from '../mesh/MeshGraphView'
import { ApprovalToasts } from './ApprovalsMenu'
import { useAppStore } from '../../stores/app.store'
import { useDocumentStore } from '../../stores/document.store'
import { useInboxStore } from '../../stores/inbox.store'
import { useMeshStore } from '../../stores/mesh.store'
import { useDragResize } from '../../hooks/useDragResize'
import { RIGHT_PANEL_WIDTH_KEY, loadStoredSize, saveStoredSize } from '../../utils/stored-size'
import { useEffect, useState, useCallback } from 'react'
import type { AgentState } from '../../../shared/types/ipc.types'

const RIGHT_PANEL_MIN = 260
const RIGHT_PANEL_MAX = 600
const RIGHT_PANEL_DEFAULT = 320

export function AppShell() {
  const rightPanelCollapsed = useAppStore((s) => s.rightPanelCollapsed)
  const showSettings = useAppStore((s) => s.showSettings)
  const showMeshGraph = useAppStore((s) => s.showMeshGraph)
  const filePath = useDocumentStore((s) => s.filePath)
  const [rightPanelWidth, setRightPanelWidth] = useState(() =>
    loadStoredSize(RIGHT_PANEL_WIDTH_KEY, RIGHT_PANEL_DEFAULT, RIGHT_PANEL_MIN, RIGHT_PANEL_MAX)
  )

  const handleMouseDown = useDragResize({
    axis: 'x',
    grow: -1,
    min: RIGHT_PANEL_MIN,
    max: RIGHT_PANEL_MAX,
    getStart: () => rightPanelWidth,
    onChange: setRightPanelWidth,
    onCommit: (w) => saveStoredSize(RIGHT_PANEL_WIDTH_KEY, w)
  })

  const resetRightPanelWidth = useCallback(() => {
    setRightPanelWidth(RIGHT_PANEL_DEFAULT)
    saveStoredSize(RIGHT_PANEL_WIDTH_KEY, RIGHT_PANEL_DEFAULT)
  }, [])

  // Inbox + outbox updates: event-driven push + fallback poll
  const setInboxData = useInboxStore((s) => s.setInboxData)
  const clearInboxMessages = useInboxStore((s) => s.clearMessages)
  const setOutboxMessages = useInboxStore((s) => s.setOutboxMessages)

  // Helper to apply inbox data to stores (store derives the unread count)
  const applyInboxData = useCallback((inboxData: { messages?: { status: string }[] } | null | undefined) => {
    if (inboxData) {
      setInboxData(inboxData)
    } else {
      clearInboxMessages()
    }
  }, [setInboxData, clearInboxMessages])

  // Subscribe to push-based inbox updates from main process
  useEffect(() => {
    if (!filePath) return
    const unsubscribe = window.adfApi?.onInboxUpdated?.((data: { inbox?: unknown }) => {
      applyInboxData(data?.inbox as { messages?: { status: string }[] } | null)
    })
    return () => unsubscribe?.()
  }, [filePath, applyInboxData])

  const fetchOutbox = useCallback(() => {
    window.adfApi?.getOutbox?.().then((result: { outbox?: { messages?: unknown[] } } | undefined) => {
      if (result?.outbox?.messages) {
        setOutboxMessages(result.outbox.messages as import('../../../shared/types/adf.types').RendererOutboxMessage[])
      }
    })
  }, [setOutboxMessages])

  // Initial fetch on file open (push events handle subsequent updates)
  useEffect(() => {
    if (!filePath) {
      clearInboxMessages()
      return
    }
    window.adfApi?.getInbox().then((result) => {
      applyInboxData(result?.inbox)
    })
    fetchOutbox()
  }, [filePath, clearInboxMessages, applyInboxData, fetchOutbox])

  // Workspace data-change push: any inbox/outbox mutation of the open file
  // (agent tools, mesh delivery, adapters, lambdas) triggers a refetch, so the
  // panels stay live without switching agents.
  useEffect(() => {
    if (!filePath) return
    const unsubscribe = window.adfApi?.onWorkspaceDataChanged?.(({ scope }) => {
      if (scope === 'inbox') {
        window.adfApi?.getInbox().then((result) => {
          applyInboxData(result?.inbox)
        })
      } else if (scope === 'outbox') {
        fetchOutbox()
      }
    })
    return () => unsubscribe?.()
  }, [filePath, applyInboxData, fetchOutbox])

  const meshEnabled = useMeshStore((s) => s.enabled)
  const showLogsPanel = useAppStore((s) => s.showLogsPanel)

  // Only Windows floats the native controls over the dock's top-right corner
  // (titleBarOverlay). macOS puts its traffic lights on the map's left edge.
  const dockUnderWindowControls =
    showMeshGraph && window.adfApi?.platform === 'win32'

  return (
    <div className="h-full flex flex-col">
      {/* The fleet map brings its own top bar (nav + drag region), so the
          app titlebar would just double up. */}
      {!showMeshGraph && <TitleBar />}

      {/* Unreviewed-agent banner — main content area, right below the title
          bar. Hidden in Settings and on the fleet map (both replace the main
          content area). */}
      {!showMeshGraph && !showSettings && <AgentReviewBanner />}

      <div className="flex-1 flex overflow-hidden">
        {/* Settings has its own navigation; the workspace tree stays out of
            the way. The fleet map hides it too — opening a file from the tree
            leaves the map anyway, so the tree is dead weight there. */}
        {!showSettings && !showMeshGraph && <SidebarFrame><Sidebar /></SidebarFrame>}

        {showMeshGraph ? (
          <div className="flex-1 flex flex-col overflow-hidden bg-surface-1">
            <div className="flex-1 overflow-hidden">
              <MeshGraphView />
            </div>
            {/* Same Logs/Tasks drawer the editor gets — the status-bar
                toggles otherwise point at a panel the map paints over */}
            {showLogsPanel && filePath && <BottomPanel />}
          </div>
        ) : (
          <div className="flex-1 flex flex-col overflow-hidden bg-surface-1">
            <div className="flex-1 flex flex-col overflow-hidden">
              {showSettings ? (
                <SettingsPage />
              ) : filePath ? (
                <EditorPanel />
              ) : (
                <HomeScreen />
              )}
            </div>
            {showLogsPanel && filePath && !showSettings && <BottomPanel />}
          </div>
        )}

        {/* Right panel — visible in both mesh and editor views. In mesh view
            the real titlebar is hidden, so the dock is the window's top-right
            element and must clear the native window-controls overlay itself. */}
        {filePath && !showSettings && rightPanelCollapsed && (
          <RightDockIconBar reserveWindowControls={dockUnderWindowControls} />
        )}
        {filePath && !showSettings && !rightPanelCollapsed && (
          <>
            {/* Resize handle */}
            <div
              onMouseDown={handleMouseDown}
              onDoubleClick={resetRightPanelWidth}
              className="shrink-0 w-1 cursor-col-resize hover:bg-blue-300 active:bg-blue-400 transition-colors bg-transparent"
            />
            <div
              style={{ width: rightPanelWidth }}
              className="shrink-0 flex flex-col bg-surface-2"
            >
              <RightDock reserveWindowControls={dockUnderWindowControls} />
            </div>
          </>
        )}
      </div>

      {meshEnabled && !showSettings && <MeshTrafficBar />}
      {!showSettings && <StatusBar />}
      {/* Outside the view switch: an off-screen agent's approval must announce
          itself on the fleet map and in Settings too, not only in the editor. */}
      <ApprovalToasts />
      <PasswordDialog />
      <OwnerMismatchDialog />
      <AgentReviewDialog />
      <ProviderSetupDialog />
      <ShareAgentDialog />
      <ShutdownOverlay />
    </div>
  )
}

function StatusDot({ state }: { state: AgentState }) {
  const colors: Record<AgentState, string> = {
    active: 'bg-yellow-400',
    idle: 'bg-green-400',
    hibernate: 'bg-purple-500',
    suspended: 'border-red-400',
    off: 'bg-neutral-400',
    error: 'bg-red-400',
    not_participating: 'bg-neutral-300 dark:bg-neutral-600'
  }
  const isRing = state === 'suspended'
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full shrink-0 ${isRing ? `border-[1.5px] ${colors[state]}` : colors[state]}`}
      title={state}
    />
  )
}

