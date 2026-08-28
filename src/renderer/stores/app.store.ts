import { create } from 'zustand'
import type { AgentConfigSummary } from '../../shared/types/ipc.types'

type RightPanel = 'loop' | 'inbox' | 'files' | 'agent'
type AgentSubTab = 'config' | 'timers' | 'identity' | 'skills'
/** Settings tab key, kept in sync with SettingsPage's `activeTab` union. */
export type SettingsSection = 'general' | 'identity' | 'providers' | 'packages' | 'mcps' | 'channels' | 'networking' | 'compute' | 'about'

interface AppState {
  showSettings: boolean
  /**
   * Optional initial tab to focus when SettingsPage mounts. Set by
   * dashboard tile clicks via `openSettingsAt`. SettingsPage reads it
   * once on mount and clears it.
   */
  pendingSettingsSection: SettingsSection | null
  rightPanel: RightPanel
  agentSubTab: AgentSubTab
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

export const useAppStore = create<AppState>((set) => ({
  showSettings: false,
  pendingSettingsSection: null,
  rightPanel: 'loop',
  agentSubTab: 'timers',
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
    set({
      rightPanelCollapsed: false,
      rightPanel: panel,
      ...(subTab ? { agentSubTab: subTab } : {})
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
