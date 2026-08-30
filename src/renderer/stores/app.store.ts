import { create } from 'zustand'
import type { AgentConfigSummary } from '../../shared/types/ipc.types'

export type RightPanel = 'loop' | 'inbox' | 'files' | 'agent'
type AgentSubTab = 'config' | 'timers' | 'identity'
/**
 * Where the Loops chat panel is mounted. `side` = the right dock's Loops tab
 * (the original, and still the default); `center` = a pinned first tab on the
 * center stage, peer to the document/browser tabs, so a multi-loop agent gets
 * the full window width. One component, two mount points — see AgentLoop.
 */
export type ChatPlacement = 'side' | 'center'

/** Same localStorage idiom the editor's line-wrap / open-tabs prefs use. */
const CHAT_PLACEMENT_KEY = 'adf-chat-placement'

function loadChatPlacement(): ChatPlacement {
  try {
    return localStorage.getItem(CHAT_PLACEMENT_KEY) === 'center' ? 'center' : 'side'
  } catch {
    return 'side'
  }
}

function saveChatPlacement(placement: ChatPlacement): void {
  try {
    localStorage.setItem(CHAT_PLACEMENT_KEY, placement)
  } catch { /* storage full/unavailable — non-fatal, the pref just won't stick */ }
}
/** Settings tab key, kept in sync with SettingsPage's `activeTab` union. */
export type SettingsSection = 'general' | 'identity' | 'providers' | 'packages' | 'mcps' | 'channels' | 'networking' | 'compute' | 'about'

export interface AppState {
  showSettings: boolean
  /**
   * Optional initial tab to focus when SettingsPage mounts. Set by
   * dashboard tile clicks via `openSettingsAt`. SettingsPage reads it
   * once on mount and clears it.
   */
  pendingSettingsSection: SettingsSection | null
  rightPanel: RightPanel
  agentSubTab: AgentSubTab
  /** Global, persisted: which slot the Loops chat panel is mounted in. */
  chatPlacement: ChatPlacement
  /**
   * Center-stage tab selection for the chat tab. Only meaningful while the
   * chat is placed in the center; the editor's own `activeTabPath` keeps
   * pointing at the last file, so leaving the chat restores it untouched.
   */
  centerChatTabActive: boolean
  sidebarCollapsed: boolean
  rightPanelCollapsed: boolean
  theme: 'light' | 'dark' | 'system'
  passwordDialogOpen: boolean
  passwordDialogFilePath: string | null
  ownerMismatchDialogOpen: boolean
  ownerMismatchFileOwnerDid: string | null
  /** FilePaths with an in-flight agent start (visible in sidebar as spinner) */
  startingFilePaths: Set<string>
  /** FilePaths with a registered but not yet completed stop (sidebar spinner) */
  stoppingFilePaths: Set<string>
  showMeshGraph: boolean
  agentReviewDialogOpen: boolean
  agentReviewSummary: AgentConfigSummary | null
  /** Open agent still needs review (dialog was dismissed) — drives the banner. */
  agentNeedsReview: boolean
  /** Post-accept warning: the .adf couldn't be moved out of a temp folder. */
  fileMoveWarning: string | null
  showLogsPanel: boolean
  logsAutoRefresh: boolean
  logsPanelHeight: number
  bottomPanelTab: 'logs' | 'tasks'
  shuttingDown: boolean

  setShowSettings: (show: boolean) => void
  /**
   * Open SettingsPage and jump to a specific tab on mount.
   * Used by home dashboard tile clicks.
   */
  openSettingsAt: (section: SettingsSection) => void
  /** Cleared by SettingsPage after it consumes the pending section. */
  consumePendingSettingsSection: () => SettingsSection | null
  setRightPanel: (panel: RightPanel) => void
  setAgentSubTab: (tab: AgentSubTab) => void
  /**
   * Move the chat between the dock and the center stage. Persists the choice
   * and lands the user on the chat in its new slot: to `center` it selects the
   * center chat tab (and moves the dock off its now-absent Loops tab); to
   * `side` it reveals the dock on Loops. Manual dock collapse is otherwise
   * untouched — this reveal is the same "expand to a destination" idiom
   * `expandRightPanelToTab` already uses.
   */
  setChatPlacement: (placement: ChatPlacement) => void
  setCenterChatTabActive: (active: boolean) => void
  /**
   * Uncollapse the right panel WITHOUT changing which tab it shows —
   * opening an agent keeps the user's current view (config, timers, inbox…)
   * and just swaps the agent context. Use expandRightPanelToTab only when
   * a specific destination is the point (e.g. founding → loop briefing).
   */
  revealRightPanel: () => void
  toggleSidebar: () => void
  toggleRightPanel: () => void
  setTheme: (theme: 'light' | 'dark' | 'system') => void
  setPasswordDialogOpen: (open: boolean, filePath?: string | null) => void
  setOwnerMismatchDialogOpen: (open: boolean, fileOwnerDid?: string | null) => void
  addStartingFilePath: (filePath: string) => void
  removeStartingFilePath: (filePath: string) => void
  addStoppingFilePath: (filePath: string) => void
  removeStoppingFilePath: (filePath: string) => void
  setShowMeshGraph: (show: boolean) => void
  expandRightPanelToTab: (panel: RightPanel, subTab?: AgentSubTab) => void
  setAgentReviewDialog: (open: boolean, summary?: AgentConfigSummary | null) => void
  setAgentNeedsReview: (v: boolean) => void
  setFileMoveWarning: (msg: string | null) => void
  /** Clear all review state — call when a file opens or closes. */
  resetAgentReview: () => void
  toggleLogsPanel: () => void
  setLogsAutoRefresh: (on: boolean) => void
  setLogsPanelHeight: (h: number) => void
  setBottomPanelTab: (tab: 'logs' | 'tasks') => void
  setShuttingDown: (v: boolean) => void
}

/**
 * Whether the chat should be rendered in the center stage *right now*. The
 * fleet map replaces the center stage wholesale, so while it is open the
 * preference yields and the chat falls back to its dock tab — otherwise
 * center-mode users would lose the chat entirely on the map.
 */
export const selectChatInCenter = (s: AppState): boolean =>
  s.chatPlacement === 'center' && !s.showMeshGraph

export const useAppStore = create<AppState>((set) => ({
  showSettings: false,
  pendingSettingsSection: null,
  rightPanel: 'loop',
  agentSubTab: 'timers',
  chatPlacement: loadChatPlacement(),
  centerChatTabActive: loadChatPlacement() === 'center',
  sidebarCollapsed: false,
  rightPanelCollapsed: false,
  theme: 'system',
  passwordDialogOpen: false,
  passwordDialogFilePath: null,
  ownerMismatchDialogOpen: false,
  ownerMismatchFileOwnerDid: null,
  startingFilePaths: new Set(),
  stoppingFilePaths: new Set(),
  showMeshGraph: false,
  agentReviewDialogOpen: false,
  agentReviewSummary: null,
  agentNeedsReview: false,
  fileMoveWarning: null,
  showLogsPanel: false,
  logsAutoRefresh: false,
  logsPanelHeight: 200,
  bottomPanelTab: 'logs',
  shuttingDown: false,

  setShowSettings: (show) => set({
    showSettings: show,
    ...(show ? { showMeshGraph: false } : {})
  }),
  openSettingsAt: (section) =>
    set({ showSettings: true, showMeshGraph: false, pendingSettingsSection: section }),
  consumePendingSettingsSection: () => {
    const current = useAppStore.getState().pendingSettingsSection
    if (current) set({ pendingSettingsSection: null })
    return current
  },
  setRightPanel: (panel) => set({ rightPanel: panel }),
  setAgentSubTab: (tab) => set({ agentSubTab: tab }),
  setChatPlacement: (placement) => {
    saveChatPlacement(placement)
    set((s) => {
      if (placement === 'center') {
        return {
          chatPlacement: placement,
          centerChatTabActive: true,
          // The dock keeps every other tab; only Loops leaves. If Loops was the
          // one showing, fall through to the next tab rather than a blank dock.
          rightPanel: s.rightPanel === 'loop' ? ('inbox' as RightPanel) : s.rightPanel
        }
      }
      return {
        chatPlacement: placement,
        centerChatTabActive: false,
        rightPanel: 'loop' as RightPanel,
        rightPanelCollapsed: false
      }
    })
  },
  setCenterChatTabActive: (active) => set({ centerChatTabActive: active }),
  revealRightPanel: () => set({ rightPanelCollapsed: false }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  toggleRightPanel: () =>
    set((s) => ({ rightPanelCollapsed: !s.rightPanelCollapsed })),
  setTheme: (theme) => set({ theme }),
  setPasswordDialogOpen: (open, filePath) =>
    set({ passwordDialogOpen: open, passwordDialogFilePath: filePath ?? null }),
  setOwnerMismatchDialogOpen: (open, fileOwnerDid) =>
    set({ ownerMismatchDialogOpen: open, ownerMismatchFileOwnerDid: fileOwnerDid ?? null }),
  addStartingFilePath: (filePath) =>
    set((s) => ({ startingFilePaths: new Set(s.startingFilePaths).add(filePath) })),
  removeStartingFilePath: (filePath) =>
    set((s) => {
      const next = new Set(s.startingFilePaths)
      next.delete(filePath)
      return { startingFilePaths: next }
    }),
  addStoppingFilePath: (filePath) =>
    set((s) => ({ stoppingFilePaths: new Set(s.stoppingFilePaths).add(filePath) })),
  removeStoppingFilePath: (filePath) =>
    set((s) => {
      const next = new Set(s.stoppingFilePaths)
      next.delete(filePath)
      return { stoppingFilePaths: next }
    }),
  setShowMeshGraph: (show) => set({ showMeshGraph: show }),
  expandRightPanelToTab: (panel, subTab) =>
    set((s) => {
      // "Take me to the chat" has to land wherever the chat actually is. In
      // center placement the dock has no Loops tab, so route to the stage tab.
      if (panel === 'loop' && s.chatPlacement === 'center') {
        return { centerChatTabActive: true }
      }
      return {
        rightPanelCollapsed: false,
        rightPanel: panel,
        ...(subTab ? { agentSubTab: subTab } : {})
      }
    }),
  setAgentReviewDialog: (open, summary) =>
    set((s) => ({
      agentReviewDialogOpen: open,
      // Closing without an explicit summary keeps the last one so the
      // needs-review banner can reopen the dialog without another IPC fetch.
      agentReviewSummary: summary !== undefined ? summary : s.agentReviewSummary,
      // Every open means main said the agent needs review; accept clears it.
      ...(open ? { agentNeedsReview: true } : {})
    })),
  setAgentNeedsReview: (v) => set({ agentNeedsReview: v }),
  setFileMoveWarning: (msg) => set({ fileMoveWarning: msg }),
  resetAgentReview: () =>
    set({ agentReviewDialogOpen: false, agentReviewSummary: null, agentNeedsReview: false, fileMoveWarning: null }),
  toggleLogsPanel: () => set((s) => ({ showLogsPanel: !s.showLogsPanel })),
  setLogsAutoRefresh: (on) => set({ logsAutoRefresh: on }),
  setLogsPanelHeight: (h) => set({ logsPanelHeight: h }),
  setBottomPanelTab: (tab) => set({ bottomPanelTab: tab }),
  setShuttingDown: (v) => set({ shuttingDown: v })
}))
