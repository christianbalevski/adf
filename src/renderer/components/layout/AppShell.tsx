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
import { RecoveredEditsNotice } from '../common/RecoveredEditsNotice'
import { IdentityRestoreBanner } from '../common/IdentityRestoreBanner'
import { NetworkNoticeBanner } from '../common/NetworkNoticeBanner'
import { ShutdownOverlay } from '../common/ShutdownOverlay'
import { BottomPanel } from './BottomPanel'
import { ApprovalToasts } from './ApprovalsMenu'
import { FailureNotices } from '../common/FailureNotices'
import { useAppStore } from '../../stores/app.store'
import { useDocumentStore } from '../../stores/document.store'
import { useInboxStore } from '../../stores/inbox.store'
import type { Inbox } from '../../../shared/types/adf.types'
import { useMeshStore } from '../../stores/mesh.store'
import { useDragResize } from '../../hooks/useDragResize'
import { RIGHT_PANEL_WIDTH_KEY, loadStoredSize, saveStoredSize } from '../../utils/stored-size'
import { useEffect, useState, useCallback, useRef, lazy, Suspense } from 'react'
import { isAgentWindow } from '../../utils/window-kind'
import { AgentWindowStatus } from './AgentWindowStatus'
import type { AgentState } from '../../../shared/types/ipc.types'

const RIGHT_PANEL_MIN = 260
/** Share of the window the dock may take: wide windows get a wide dock, and a width saved on one can't crowd out a small one. */
const RIGHT_PANEL_MAX_VW = 50
/** Ceiling for a stored width; the live limit is RIGHT_PANEL_MAX_VW of the window. */
const RIGHT_PANEL_STORED_MAX = 2400
const RIGHT_PANEL_DEFAULT = 320
const rightPanelMax = (): number => Math.max(RIGHT_PANEL_MIN, Math.round(window.innerWidth * RIGHT_PANEL_MAX_VW / 100))

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
  // An agent window (agent-windows.md) shows its agent only: no Settings, no fleet map, no sidebar.
  const showSettings = useAppStore((s) => s.showSettings) && !isAgentWindow
  const showMeshGraph = useAppStore((s) => s.showMeshGraph) && !isAgentWindow
  // Home with an agent still open: the agent's views step aside, nothing closes.
  const showHome = useAppStore((s) => s.showHome) && !isAgentWindow
  const filePath = useDocumentStore((s) => s.filePath)
  const agentOnStage = !!filePath && !showHome
  const [rightPanelWidth, setRightPanelWidth] = useState(() =>
    loadStoredSize(RIGHT_PANEL_WIDTH_KEY, RIGHT_PANEL_DEFAULT, RIGHT_PANEL_MIN, RIGHT_PANEL_STORED_MAX)
  )
  // The drag writes the width straight to the panel element and only commits
  // to state on mouseup — a setState per mousemove re-renders the whole shell
  // at pointer rate.
  const rightPanelRef = useRef<HTMLDivElement>(null)

  const handleMouseDown = useDragResize({
    axis: 'x',
    grow: -1,
    min: RIGHT_PANEL_MIN,
    max: rightPanelMax,
    // What is on screen: a stored width wider than this window allows shows clamped.
    getStart: () => rightPanelRef.current?.getBoundingClientRect().width || rightPanelWidth,
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
  const applyInboxData = useCallback((inboxData: Inbox | null | undefined) => {
    if (inboxData) {
      setInboxData(inboxData)
    } else {
      clearInboxMessages()
    }
  }, [setInboxData, clearInboxMessages])

  // Subscribe to push-based inbox updates from main process
  useEffect(() => {
    if (!filePath) return
    const unsubscribe = window.adfApi?.onInboxUpdated?.((data) => {
      applyInboxData(data.inbox)
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
      {!showMeshGraph && !showSettings && !showHome && <AgentReviewBanner />}
      {!showMeshGraph && !showSettings && <IdentityRestoreBanner />}
      {/* W3-F: unsaved versions a quit left under a "changed elsewhere" notice. */}
      {!showMeshGraph && !isAgentWindow && <RecoveredEditsNotice />}
      {/* Remote access paused on a network not allowed: non-modal, everywhere but the fleet map (it has its own bar). */}
      {!showMeshGraph && !isAgentWindow && <NetworkNoticeBanner />}

      <div className="flex-1 flex overflow-hidden">
        {/* Settings has its own navigation; the workspace tree stays out of
            the way. The fleet map hides it too — opening a file from the tree
            leaves the map anyway, so the tree is dead weight there. */}
        {!showSettings && !showMeshGraph && !isAgentWindow && <SidebarFrame><Sidebar /></SidebarFrame>}

        {/* Everything right of the tree, status bar included: the sidebar runs
            the full window height, and the status bar starts at the same left
            edge as the titlebar's agent name. With no tree (collapsed, fleet
            map) the column is the whole width and so is the bar. */}
        <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
          <div className="flex-1 flex overflow-hidden">
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
                    ) : agentOnStage ? (
                      <EditorPanel />
                    ) : isAgentWindow ? (
                      <AgentWindowStatus />
                    ) : (
                      <HomeScreen />
                    )}
                  </Suspense>
                </div>
                {showLogsPanel && agentOnStage && !showSettings && <BottomPanel />}
              </div>
            )}

            {/* Right panel — visible in both mesh and editor views. In mesh view
                the real titlebar is hidden, so the dock is the window's top-right
                element and must clear the native window-controls overlay itself. */}
            {agentOnStage && !showSettings && rightPanelCollapsed && (
              <RightDockIconBar reserveWindowControls={dockUnderWindowControls} />
            )}
            {agentOnStage && !showSettings && !rightPanelCollapsed && (
              <>
                {/* Resize handle */}
                <div
                  onMouseDown={handleMouseDown}
                  onDoubleClick={resetRightPanelWidth}
                  className="shrink-0 w-1 cursor-col-resize hover:bg-blue-300 active:bg-blue-400 transition-colors bg-transparent"
                />
                <div
                  ref={rightPanelRef}
                  style={{ width: rightPanelWidth, maxWidth: `max(${RIGHT_PANEL_MIN}px, ${RIGHT_PANEL_MAX_VW}vw)` }}
                  className="shrink-0 flex flex-col bg-[var(--adf-ui-surface)] border-l border-hairline"
                >
                  <RightDock reserveWindowControls={dockUnderWindowControls} />
                </div>
              </>
            )}
          </div>

          {meshEnabled && !showSettings && !isAgentWindow && <MeshTrafficBar />}
          {!showSettings && <StatusBar />}
        </div>
      </div>

      {/* Outside the view switch: an off-screen agent's approval must announce
          itself on the fleet map and in Settings too, not only in the editor. */}
      {/* An agent window shows its agent's requests in its chat; the main window has the toasts. */}
      {!isAgentWindow && <ApprovalToasts />}
      <FailureNotices />
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

