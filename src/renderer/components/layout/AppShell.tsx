import { TitleBar } from './TitleBar'
import { Sidebar } from './Sidebar'
import { SidebarFrame } from './SidebarFrame'
import { StatusBar } from './StatusBar'
import { MeshTrafficBar } from './MeshTrafficBar'
import { RightDock, RightDockIconBar } from './RightDock'
import { HomeScreen } from '../home/HomeScreen'
import { PasswordDialog } from '../common/PasswordDialog'
import { OwnerMismatchDialog } from '../common/OwnerMismatchDialog'
import { AgentReviewDialog } from '../common/AgentReviewDialog'
import { ProviderSetupDialog } from '../common/ProviderSetupDialog'
import { ShareAgentDialog } from '../common/ShareAgentDialog'
import { AgentReviewBanner } from '../common/AgentReviewBanner'
import { ShutdownOverlay } from '../common/ShutdownOverlay'
import { BottomPanel } from './BottomPanel'
import { ApprovalToasts } from './ApprovalsMenu'
import { useAppStore } from '../../stores/app.store'
import { useDocumentStore } from '../../stores/document.store'
import { useInboxStore } from '../../stores/inbox.store'
import { useMeshStore } from '../../stores/mesh.store'
import { useDragResize } from '../../hooks/useDragResize'
import { RIGHT_PANEL_WIDTH_KEY, loadStoredSize, saveStoredSize } from '../../utils/stored-size'
import { useEffect, useState, useCallback, useRef, lazy, Suspense } from 'react'
import type { AgentState } from '../../../shared/types/ipc.types'

const RIGHT_PANEL_MIN = 260
const RIGHT_PANEL_MAX = 600
const RIGHT_PANEL_DEFAULT = 320

// The three heavy main-content views are split out of the startup chunk. None
// of them is on the first-paint path — a cold start has no file open, so the
// Home screen renders first — and all three are warmed on idle below, so the
// fallback only ever shows if a view is opened before its chunk lands.
const SettingsPage = lazy(() =>
  import('../settings/SettingsPage').then((m) => ({ default: m.SettingsPage }))
)
const MeshGraphView = lazy(() =>
  import('../mesh/MeshGraphView').then((m) => ({ default: m.MeshGraphView }))
)
const EditorPanel = lazy(() =>
  import('../editor/EditorPanel').then((m) => ({ default: m.EditorPanel }))
)

/** The app's spinner, centred in whatever area the pending view will fill. */
function ViewFallback() {
  return (
    <div className="h-full w-full flex items-center justify-center">
      <svg
        className="h-8 w-8 animate-spin text-neutral-400 dark:text-neutral-500"
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path
          className="opacity-75"
          fill="currentColor"
          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
        />
      </svg>
    </div>
  )
}

export function AppShell() {
  const rightPanelCollapsed = useAppStore((s) => s.rightPanelCollapsed)
  const showSettings = useAppStore((s) => s.showSettings)
  const showMeshGraph = useAppStore((s) => s.showMeshGraph)
  const filePath = useDocumentStore((s) => s.filePath)
  const [rightPanelWidth, setRightPanelWidth] = useState(() =>
    loadStoredSize(RIGHT_PANEL_WIDTH_KEY, RIGHT_PANEL_DEFAULT, RIGHT_PANEL_MIN, RIGHT_PANEL_MAX)
  )
  // The drag writes the width straight to the panel element and only commits
  // to state on mouseup — a setState per mousemove re-renders the whole shell
  // at pointer rate.
  const rightPanelRef = useRef<HTMLDivElement>(null)

  const handleMouseDown = useDragResize({
    axis: 'x',
    grow: -1,
    min: RIGHT_PANEL_MIN,
    max: RIGHT_PANEL_MAX,
    getStart: () => rightPanelWidth,
    onDrag: (w) => { if (rightPanelRef.current) rightPanelRef.current.style.width = `${w}px` },
    onCommit: (w) => {
      setRightPanelWidth(w)
      saveStoredSize(RIGHT_PANEL_WIDTH_KEY, w)
    }
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
    window.adfApi?.getOutbox?.().then((result) => {
      if (result?.outbox?.messages) {
        setOutboxMessages(result.outbox.messages)
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

  // Warm the split chunks once the first paint is done, so opening a file,
  // Settings or the fleet map looks exactly as instant as it did before.
  useEffect(() => {
    const warm = () => {
      void import('../editor/EditorPanel')
      void import('../mesh/MeshGraphView')
      void import('../settings/SettingsPage')
    }
    const ric = (window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
    }).requestIdleCallback
    if (ric) {
      const id = ric(warm, { timeout: 3000 })
      return () => (window as unknown as { cancelIdleCallback?: (h: number) => void })
        .cancelIdleCallback?.(id)
    }
    const t = setTimeout(warm, 1000)
    return () => clearTimeout(t)
  }, [])

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
              <Suspense fallback={<ViewFallback />}>
                <MeshGraphView />
              </Suspense>
            </div>
            {/* Same Logs/Tasks drawer the editor gets — the status-bar
                toggles otherwise point at a panel the map paints over */}
            {showLogsPanel && filePath && <BottomPanel />}
          </div>
        ) : (
          <div className="flex-1 flex flex-col overflow-hidden bg-surface-1">
            <div className="flex-1 flex flex-col overflow-hidden">
              <Suspense fallback={<ViewFallback />}>
                {showSettings ? (
                  <SettingsPage />
                ) : filePath ? (
                  <EditorPanel />
                ) : (
                  <HomeScreen />
                )}
              </Suspense>
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
              ref={rightPanelRef}
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

