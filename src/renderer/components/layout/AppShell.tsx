import { TitleBar } from './TitleBar'
import { SubHeader } from './SubHeader'
import { Sidebar } from './Sidebar'
import { StatusBar } from './StatusBar'
import { EditorPanel } from '../editor/EditorPanel'
import { AgentLoop } from '../agent/AgentLoop'
import { AgentConfig } from '../agent/AgentConfig'
import { MindPanel } from '../mind/MindPanel'
import { InboxPanel } from '../inbox/InboxPanel'
import { AgentTimers } from '../agent/AgentTimers'
import { AgentFiles } from '../agent/AgentFiles'
import { IdentityPanel } from '../agent/IdentityPanel'
import { SettingsPage } from '../settings/SettingsPage'
import { HomeDashboard } from '../home/HomeDashboard'
import { NetworkingPanel } from '../home/NetworkingPanel'
import { TrackedDirectoriesPanel } from '../home/TrackedDirectoriesPanel'
import { PasswordDialog } from '../common/PasswordDialog'
import { OwnerMismatchDialog } from '../common/OwnerMismatchDialog'
import { AgentReviewDialog } from '../common/AgentReviewDialog'
import { ShutdownOverlay } from '../common/ShutdownOverlay'
import { BottomPanel } from './BottomPanel'
import { MeshGraphView } from '../mesh/MeshGraphView'
import { useAppStore } from '../../stores/app.store'
import { useDocumentStore } from '../../stores/document.store'
import { useInboxStore } from '../../stores/inbox.store'
import { useAdfFile } from '../../hooks/useAdfFile'
import { useTrackedDirs } from '../../hooks/useTrackedDirs'
import { useMeshStore } from '../../stores/mesh.store'
import { useMesh } from '../../hooks/useMesh'
import { useEffect, useState, useCallback, useRef } from 'react'
import type { AgentState } from '../../../shared/types/ipc.types'

const RIGHT_PANEL_MIN = 260
const RIGHT_PANEL_MAX = 600
const RIGHT_PANEL_DEFAULT = 320

export function AppShell() {
  const rightPanel = useAppStore((s) => s.rightPanel)
  const setRightPanel = useAppStore((s) => s.setRightPanel)
  const agentSubTab = useAppStore((s) => s.agentSubTab)
  const setAgentSubTab = useAppStore((s) => s.setAgentSubTab)
  const rightPanelCollapsed = useAppStore((s) => s.rightPanelCollapsed)
  const toggleRightPanel = useAppStore((s) => s.toggleRightPanel)
  const expandRightPanelToTab = useAppStore((s) => s.expandRightPanelToTab)
  const showSettings = useAppStore((s) => s.showSettings)
  const showMeshGraph = useAppStore((s) => s.showMeshGraph)
  const filePath = useDocumentStore((s) => s.filePath)
  const [rightPanelWidth, setRightPanelWidth] = useState(RIGHT_PANEL_DEFAULT)
  const isDragging = useRef(false)
  const [unreadInboxCount, setUnreadInboxCount] = useState(0)

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

  // Helper to apply inbox data to stores
  const applyInboxData = useCallback((inboxData: { messages?: { status: string }[] } | null | undefined) => {
    if (inboxData) {
      setInboxData(inboxData)
      const unread = inboxData.messages?.filter((m) => m.status === 'unread').length || 0
      setUnreadInboxCount(unread)
    } else {
      clearInboxMessages()
      setUnreadInboxCount(0)
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
      setUnreadInboxCount(0)
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
      <TitleBar />
      <SubHeader />

      <div className="flex-1 flex overflow-hidden">
        {/* Left sidebar — always visible */}
        <Sidebar />

        {showMeshGraph ? (
          <div className="flex-1 overflow-hidden">
            <MeshGraphView />
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

        {/* Right panel — visible in both mesh and editor views */}
        {filePath && !showSettings && rightPanelCollapsed && (
          <RightIconBar
            rightPanel={rightPanel}
            agentSubTab={agentSubTab}
            unreadInboxCount={unreadInboxCount}
            expandRightPanelToTab={expandRightPanelToTab}
            toggleRightPanel={toggleRightPanel}
          />
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
              {/* Top-level tab switcher */}
              <div className="flex items-center border-b border-neutral-200 dark:border-neutral-700">
                <div className="flex-1 flex justify-center gap-1">
                  {(['loop', 'inbox', 'files', 'agent'] as const).map((tab) => (
                    <button
                      key={tab}
                      onClick={() => setRightPanel(tab)}
                      className={`px-4 py-2 text-xs font-medium ${
                        rightPanel === tab
                          ? 'text-blue-600 border-b-2 border-blue-500'
                          : 'text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200'
                      }`}
                    >
                      {tab === 'loop' ? 'Loop' : tab === 'inbox' ? (
                        <span className="flex items-center gap-1.5">
                          Inbox
                          {unreadInboxCount > 0 && (
                            <span className="inline-flex items-center justify-center min-w-[16px] h-4 px-1 text-[10px] font-semibold text-white bg-red-500 rounded-full">
                              {unreadInboxCount}
                            </span>
                          )}
                        </span>
                      ) : tab === 'files' ? 'Files' : 'Agent'}
                    </button>
                  ))}
                </div>
                <button
                  onClick={toggleRightPanel}
                  title="Collapse Panel"
                  className="shrink-0 px-1.5 py-2 text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-300"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                </button>
              </div>
              {/* Agent sub-tabs */}
              {rightPanel === 'agent' && (
                <div className="flex border-b border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800/50">
                  {(['mind', 'timers', 'identity', 'config'] as const).map((sub) => (
                    <button
                      key={sub}
                      onClick={() => setAgentSubTab(sub)}
                      className={`flex-1 px-2 py-1.5 text-[11px] font-medium ${
                        agentSubTab === sub
                          ? 'text-blue-600 dark:text-blue-400 bg-white dark:bg-neutral-900'
                          : 'text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-300'
                      }`}
                    >
                      {sub === 'mind' ? 'Mind' : sub === 'identity' ? 'Identity' : sub === 'timers' ? 'Timers' : 'Config'}
                    </button>
                  ))}
                </div>
              )}
              {/* Panel content */}
              <div className="flex-1 overflow-auto min-w-0 relative">
                {rightPanel === 'loop' && <AgentLoop key={filePath ?? ''} />}
                {rightPanel === 'inbox' && <InboxPanel />}
                {rightPanel === 'files' && <AgentFiles />}
                {rightPanel === 'agent' && agentSubTab === 'mind' && <MindPanel />}
                {rightPanel === 'agent' && agentSubTab === 'config' && <AgentConfig />}
                {rightPanel === 'agent' && agentSubTab === 'timers' && <AgentTimers />}
                {rightPanel === 'agent' && agentSubTab === 'identity' && <IdentityPanel />}
              </div>
            </div>
          </>
        )}
      </div>

      {meshEnabled && <div className="mesh-pulse-bar" />}
      <StatusBar />
      <PasswordDialog />
      <OwnerMismatchDialog />
      <AgentReviewDialog />
      <ShutdownOverlay />
    </div>
  )
}

function RightIconBarButton({
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
      className={`w-8 h-8 flex items-center justify-center rounded-md ${
        active
          ? 'bg-blue-100 text-blue-600 dark:bg-blue-900 dark:text-blue-400'
          : 'text-neutral-500 dark:text-neutral-400 hover:bg-neutral-200 dark:hover:bg-neutral-700'
      }`}
    >
      {children}
    </button>
  )
}

function RightIconBar({
  rightPanel,
  agentSubTab,
  unreadInboxCount,
  expandRightPanelToTab,
  toggleRightPanel
}: {
  rightPanel: string
  agentSubTab: string
  unreadInboxCount: number
  expandRightPanelToTab: (panel: 'loop' | 'inbox' | 'files' | 'agent', subTab?: 'mind' | 'config' | 'timers' | 'identity') => void
  toggleRightPanel: () => void
}) {
  const isActive = (panel: string, subTab?: string) => {
    if (panel === 'agent' && subTab) return rightPanel === 'agent' && agentSubTab === subTab
    return rightPanel === panel && (panel !== 'agent' || !subTab)
  }

  return (
    <div className="w-10 shrink-0 border-l border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 flex flex-col items-center py-2 gap-1">
      {/* Loop */}
      <RightIconBarButton title="Loop" active={isActive('loop')} onClick={() => expandRightPanelToTab('loop')}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </RightIconBarButton>

      {/* Inbox */}
      <RightIconBarButton title="Inbox" active={isActive('inbox')} onClick={() => expandRightPanelToTab('inbox')}>
        <span className="relative">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
            <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
          </svg>
          {unreadInboxCount > 0 && (
            <span className="absolute -top-1.5 -right-1.5 inline-flex items-center justify-center min-w-[14px] h-3.5 px-0.5 text-[9px] font-semibold text-white bg-red-500 rounded-full">
              {unreadInboxCount}
            </span>
          )}
        </span>
      </RightIconBarButton>

      {/* Files */}
      <RightIconBarButton title="Files" active={isActive('files')} onClick={() => expandRightPanelToTab('files')}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
      </RightIconBarButton>

      {/* Divider */}
      <div className="w-5 border-t border-neutral-200 dark:border-neutral-700 my-1" />

      {/* Mind */}
      <RightIconBarButton title="Mind" active={isActive('agent', 'mind')} onClick={() => expandRightPanelToTab('agent', 'mind')}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 18h6" />
          <path d="M10 22h4" />
          <path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14" />
        </svg>
      </RightIconBarButton>

      {/* Timers */}
      <RightIconBarButton title="Timers" active={isActive('agent', 'timers')} onClick={() => expandRightPanelToTab('agent', 'timers')}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
      </RightIconBarButton>

      {/* Identity */}
      <RightIconBarButton title="Identity" active={isActive('agent', 'identity')} onClick={() => expandRightPanelToTab('agent', 'identity')}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        </svg>
      </RightIconBarButton>

      {/* Config */}
      <RightIconBarButton title="Config" active={isActive('agent', 'config')} onClick={() => expandRightPanelToTab('agent', 'config')}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="4" y1="21" x2="4" y2="14" />
          <line x1="4" y1="10" x2="4" y2="3" />
          <line x1="12" y1="21" x2="12" y2="12" />
          <line x1="12" y1="8" x2="12" y2="3" />
          <line x1="20" y1="21" x2="20" y2="16" />
          <line x1="20" y1="12" x2="20" y2="3" />
          <line x1="1" y1="14" x2="7" y2="14" />
          <line x1="9" y1="8" x2="15" y2="8" />
          <line x1="17" y1="16" x2="23" y2="16" />
        </svg>
      </RightIconBarButton>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Expand */}
      <RightIconBarButton title="Expand Panel" onClick={toggleRightPanel}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="15 18 9 12 15 6" />
        </svg>
      </RightIconBarButton>
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
  const { createFile, openFile } = useAdfFile()
  const openSettingsAt = useAppStore((s) => s.openSettingsAt)
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

  const handleCreate = async () => {
    await createFile('Untitled')
  }

  const handleOpen = async () => {
    await openFile()
  }

  return (
    <div className="flex-1 flex flex-col items-center justify-start gap-4 text-neutral-500 dark:text-neutral-400 overflow-y-auto py-6">
      {/* Compact header — replaces the old hero card */}
      <div className="w-full max-w-3xl px-4 flex items-start justify-between">
        <div className="flex items-center gap-3">
          <span className="text-2xl leading-none">📄</span>
          <div>
            <div className="text-sm font-semibold text-neutral-700 dark:text-neutral-200 leading-tight">
              ADF
            </div>
            <div className="text-xs text-neutral-500 dark:text-neutral-400 leading-tight">
              Agent Document Format ·{' '}
              <button
                onClick={() => openSettingsAt('about')}
                className="text-blue-500 hover:underline"
              >
                How it works
              </button>
            </div>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleCreate}
            className="px-3 py-1.5 text-xs bg-blue-500 text-white rounded-md hover:bg-blue-600"
          >
            + New .adf
          </button>
          <button
            onClick={handleOpen}
            className="px-3 py-1.5 text-xs border border-neutral-300 dark:border-neutral-600 text-neutral-700 dark:text-neutral-300 rounded-md hover:bg-neutral-50 dark:hover:bg-neutral-800"
          >
            Open .adf
          </button>
        </div>
      </div>

      {/* Application-state dashboard (incl. Getting Started strip) */}
      <HomeDashboard />

      {/* Networking */}
      <NetworkingPanel />

      {/* Tracked directories — file browser + Add Directory */}
      <TrackedDirectoriesPanel />
    </div>
  )
}

