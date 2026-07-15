import { AgentLoop } from '../agent/AgentLoop'
import { AgentConfig } from '../agent/AgentConfig'
import { MindPanel } from '../mind/MindPanel'
import { InboxPanel } from '../inbox/InboxPanel'
import { AgentTimers } from '../agent/AgentTimers'
import { AgentFiles } from '../agent/AgentFiles'
import { IdentityPanel } from '../agent/IdentityPanel'
import { useAppStore } from '../../stores/app.store'
import { useDocumentStore } from '../../stores/document.store'
import { useInboxStore } from '../../stores/inbox.store'

/**
 * The right-hand agent dock — tab switcher (Loop / Inbox / Files / Agent),
 * agent sub-tabs, and the active panel. All state lives in the app store so
 * the SAME dock instance semantics apply wherever it's mounted: AppShell's
 * sidebar slot in normal layout, or docked inside the fleet map's immersive
 * (full-screen) container. Panels read the open document themselves, so
 * switching agents swaps the context while the chosen tab stays put.
 */
export function RightDock() {
  const rightPanel = useAppStore((s) => s.rightPanel)
  const setRightPanel = useAppStore((s) => s.setRightPanel)
  const agentSubTab = useAppStore((s) => s.agentSubTab)
  const setAgentSubTab = useAppStore((s) => s.setAgentSubTab)
  const toggleRightPanel = useAppStore((s) => s.toggleRightPanel)
  const filePath = useDocumentStore((s) => s.filePath)
  const unreadInboxCount = useInboxStore((s) => s.unreadCount)

  return (
    <>
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
    </>
  )
}

function RightDockIconButton({
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

/** Collapsed dock — one icon per tab; clicking expands straight to it. */
export function RightDockIconBar() {
  const rightPanel = useAppStore((s) => s.rightPanel)
  const agentSubTab = useAppStore((s) => s.agentSubTab)
  const expandRightPanelToTab = useAppStore((s) => s.expandRightPanelToTab)
  const toggleRightPanel = useAppStore((s) => s.toggleRightPanel)
  const unreadInboxCount = useInboxStore((s) => s.unreadCount)

  const isActive = (panel: string, subTab?: string) => {
    if (panel === 'agent' && subTab) return rightPanel === 'agent' && agentSubTab === subTab
    return rightPanel === panel && (panel !== 'agent' || !subTab)
  }

  return (
    <div className="w-10 shrink-0 border-l border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 flex flex-col items-center py-2 gap-1">
      {/* Loop */}
      <RightDockIconButton title="Loop" active={isActive('loop')} onClick={() => expandRightPanelToTab('loop')}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      </RightDockIconButton>

      {/* Inbox */}
      <RightDockIconButton title="Inbox" active={isActive('inbox')} onClick={() => expandRightPanelToTab('inbox')}>
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
      </RightDockIconButton>

      {/* Files */}
      <RightDockIconButton title="Files" active={isActive('files')} onClick={() => expandRightPanelToTab('files')}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
      </RightDockIconButton>

      {/* Divider */}
      <div className="w-5 border-t border-neutral-200 dark:border-neutral-700 my-1" />

      {/* Mind */}
      <RightDockIconButton title="Mind" active={isActive('agent', 'mind')} onClick={() => expandRightPanelToTab('agent', 'mind')}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 18h6" />
          <path d="M10 22h4" />
          <path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14" />
        </svg>
      </RightDockIconButton>

      {/* Timers */}
      <RightDockIconButton title="Timers" active={isActive('agent', 'timers')} onClick={() => expandRightPanelToTab('agent', 'timers')}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
      </RightDockIconButton>

      {/* Identity */}
      <RightDockIconButton title="Identity" active={isActive('agent', 'identity')} onClick={() => expandRightPanelToTab('agent', 'identity')}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        </svg>
      </RightDockIconButton>

      {/* Config */}
      <RightDockIconButton title="Config" active={isActive('agent', 'config')} onClick={() => expandRightPanelToTab('agent', 'config')}>
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
      </RightDockIconButton>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Expand */}
      <RightDockIconButton title="Expand Panel" onClick={toggleRightPanel}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="15 18 9 12 15 6" />
        </svg>
      </RightDockIconButton>
    </div>
  )
}
