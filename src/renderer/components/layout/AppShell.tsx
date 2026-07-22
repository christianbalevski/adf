import { TitleBar } from './TitleBar'
import { Sidebar } from './Sidebar'
import { StatusBar } from './StatusBar'
import { EditorPanel } from '../editor/EditorPanel'
import { RightDock, RightDockIconBar } from './RightDock'
import { SettingsPage } from '../settings/SettingsPage'
import { HomeDashboard } from '../home/HomeDashboard'
import { NetworkingPanel } from '../home/NetworkingPanel'
import { TrackedDirectoriesPanel } from '../home/TrackedDirectoriesPanel'
import { FleetMapCallout } from '../home/FleetMapCallout'
import { PasswordDialog } from '../common/PasswordDialog'
import { OwnerMismatchDialog } from '../common/OwnerMismatchDialog'
import { AgentReviewDialog } from '../common/AgentReviewDialog'
import { ShutdownOverlay } from '../common/ShutdownOverlay'
import { BottomPanel } from './BottomPanel'
import { MeshGraphView } from '../mesh/MeshGraphView'
import { useAppStore } from '../../stores/app.store'
import { useDocumentStore } from '../../stores/document.store'
import { useInboxStore } from '../../stores/inbox.store'
import { useTrackedDirs } from '../../hooks/useTrackedDirs'
import { useMeshStore } from '../../stores/mesh.store'
import { useMesh } from '../../hooks/useMesh'
import { useEffect, useState, useCallback, useRef } from 'react'
import type { AgentState } from '../../../shared/types/ipc.types'

const RIGHT_PANEL_MIN = 260
const RIGHT_PANEL_MAX = 600
const RIGHT_PANEL_DEFAULT = 320

export function AppShell() {
  const rightPanelCollapsed = useAppStore((s) => s.rightPanelCollapsed)
  const showSettings = useAppStore((s) => s.showSettings)
  const showMeshGraph = useAppStore((s) => s.showMeshGraph)
  const filePath = useDocumentStore((s) => s.filePath)
  const [rightPanelWidth, setRightPanelWidth] = useState(RIGHT_PANEL_DEFAULT)
  const isDragging = useRef(false)

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isDragging.current = true
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const onMouseMove = (ev: MouseEvent) => {
      if (!isDragging.current) return
      const newWidth = window.innerWidth - ev.clientX
      setRightPanelWidth(Math.max(RIGHT_PANEL_MIN, Math.min(RIGHT_PANEL_MAX, newWidth)))
    }

    const onMouseUp = () => {
      isDragging.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
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

  // Initial fetch on file open (push events handle subsequent updates)
  useEffect(() => {
    if (!filePath) {
      clearInboxMessages()
      return
    }
    window.adfApi?.getInbox().then((result) => {
      applyInboxData(result?.inbox)
    })
    window.adfApi?.getOutbox?.().then((result: { outbox?: { messages?: unknown[] } } | undefined) => {
      if (result?.outbox?.messages) {
        setOutboxMessages(result.outbox.messages as import('../../../shared/types/adf.types').RendererOutboxMessage[])
      }
    })
  }, [filePath, clearInboxMessages, applyInboxData, setOutboxMessages])

  const meshEnabled = useMeshStore((s) => s.enabled)
  const showLogsPanel = useAppStore((s) => s.showLogsPanel)

  return (
    <div className="h-full flex flex-col">
      {/* The fleet map brings its own top bar (nav + drag region), so the
          app titlebar would just double up. */}
      {!showMeshGraph && <TitleBar />}

      <div className="flex-1 flex overflow-hidden">
        {/* Settings has its own navigation; the workspace tree stays out of
            the way. The fleet map hides it too — opening a file from the tree
            leaves the map anyway, so the tree is dead weight there. */}
        {!showSettings && !showMeshGraph && <Sidebar />}

        {showMeshGraph ? (
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="flex-1 overflow-hidden">
              <MeshGraphView />
            </div>
            {/* Same Logs/Tasks drawer the editor gets — the status-bar
                toggles otherwise point at a panel the map paints over */}
            {showLogsPanel && filePath && <BottomPanel />}
          </div>
        ) : (
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="flex-1 flex flex-col overflow-hidden">
              {showSettings ? (
                <SettingsPage />
              ) : filePath ? (
                <EditorPanel />
              ) : (
                <WelcomeScreen />
              )}
            </div>
            {showLogsPanel && filePath && !showSettings && <BottomPanel />}
          </div>
        )}

        {/* Right panel — visible in both mesh and editor views. In mesh view
            the real titlebar is hidden, so the dock is the window's top-right
            element and must clear the native window-controls overlay itself. */}
        {filePath && !showSettings && rightPanelCollapsed && (
          <RightDockIconBar reserveWindowControls={showMeshGraph} />
        )}
        {filePath && !showSettings && !rightPanelCollapsed && (
          <>
            {/* Resize handle */}
            <div
              onMouseDown={handleMouseDown}
              className="shrink-0 w-1 cursor-col-resize hover:bg-blue-300 active:bg-blue-400 transition-colors bg-transparent"
            />
            <div
              style={{ width: rightPanelWidth }}
              className="shrink-0 border-l border-neutral-200 dark:border-neutral-700 flex flex-col bg-white dark:bg-neutral-900"
            >
              <RightDock reserveWindowControls={showMeshGraph} />
            </div>
          </>
        )}
      </div>

      {meshEnabled && !showSettings && <div className="mesh-pulse-bar" />}
      {!showSettings && <StatusBar />}
      <PasswordDialog />
      <OwnerMismatchDialog />
      <AgentReviewDialog />
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

function WelcomeScreen() {
  const { loadDirectories } = useTrackedDirs()
  const { enableMesh } = useMesh()

  // Auto-enable mesh on launch if the user had it on last session.
  // Also kick off a tracked-directories load so the Sidebar/dashboard
  // see the latest list. (Same boot behaviour as the old WelcomeScreen.)
  useEffect(() => {
    loadDirectories()
    window.adfApi?.getSettings().then((s) => {
      if (s?.meshEnabled) {
        enableMesh()
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="flex-1 flex flex-col items-center justify-start gap-4 text-neutral-500 dark:text-neutral-400 overflow-y-auto py-6">
      <FleetMapCallout />

      {/* Application-state dashboard (incl. Getting Started strip) */}
      <HomeDashboard />

      {/* Networking */}
      <NetworkingPanel />

      {/* Tracked directories — file browser + Add Directory */}
      <TrackedDirectoriesPanel />
    </div>
  )
}
