import { create } from 'zustand'
import type { McpServerConfig } from '../../shared/types/adf-v02.types'
import type { AgentConfigSummary } from '../../shared/types/ipc.types'

type RightPanel = 'loop' | 'inbox' | 'files' | 'agent'
type AgentSubTab = 'mind' | 'config' | 'timers' | 'identity'

interface AppState {
  showSettings: boolean
  showAbout: boolean
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
  showMeshGraph: boolean
  missingMcpDialogOpen: boolean
  missingMcpServers: McpServerConfig[]
  agentReviewDialogOpen: boolean
  agentReviewSummary: AgentConfigSummary | null
  showLogsPanel: boolean
  logsAutoRefresh: boolean
  logsPanelHeight: number
  bottomPanelTab: 'logs' | 'tasks'
  shuttingDown: boolean

  setShowSettings: (show: boolean) => void
  setShowAbout: (show: boolean) => void
  setRightPanel: (panel: RightPanel) => void
  setAgentSubTab: (tab: AgentSubTab) => void
  toggleSidebar: () => void
  toggleRightPanel: () => void
  setTheme: (theme: 'light' | 'dark' | 'system') => void
  setPasswordDialogOpen: (open: boolean, filePath?: string | null) => void
  setOwnerMismatchDialogOpen: (open: boolean, fileOwnerDid?: string | null) => void
  addStartingFilePath: (filePath: string) => void
  removeStartingFilePath: (filePath: string) => void
  setShowMeshGraph: (show: boolean) => void
  expandRightPanelToTab: (panel: RightPanel, subTab?: AgentSubTab) => void
  setMissingMcpDialog: (open: boolean, servers?: McpServerConfig[]) => void
  setAgentReviewDialog: (open: boolean, summary?: AgentConfigSummary | null) => void
  toggleLogsPanel: () => void
  setLogsAutoRefresh: (on: boolean) => void
  setLogsPanelHeight: (h: number) => void
  setBottomPanelTab: (tab: 'logs' | 'tasks') => void
  setShuttingDown: (v: boolean) => void
}

export const useAppStore = create<AppState>((set) => ({
  showSettings: false,
  showAbout: false,
  rightPanel: 'loop',
  agentSubTab: 'mind',
  sidebarCollapsed: false,
  rightPanelCollapsed: false,
  theme: 'system',
  passwordDialogOpen: false,
  passwordDialogFilePath: null,
  ownerMismatchDialogOpen: false,
  ownerMismatchFileOwnerDid: null,
  startingFilePaths: new Set(),
  showMeshGraph: false,
  missingMcpDialogOpen: false,
  missingMcpServers: [],
  agentReviewDialogOpen: false,
  agentReviewSummary: null,
  showLogsPanel: false,
  logsAutoRefresh: false,
  logsPanelHeight: 200,
  bottomPanelTab: 'logs',
  shuttingDown: false,

  setShowSettings: (show) => set({ showSettings: show }),
  setShowAbout: (show) => set({ showAbout: show }),
  setRightPanel: (panel) => set({ rightPanel: panel }),
  setAgentSubTab: (tab) => set({ agentSubTab: tab }),
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
  setShowMeshGraph: (show) => set({ showMeshGraph: show }),
  expandRightPanelToTab: (panel, subTab) =>
    set({
      rightPanelCollapsed: false,
      rightPanel: panel,
      ...(subTab ? { agentSubTab: subTab } : {})
    }),
  setMissingMcpDialog: (open, servers) =>
    set({ missingMcpDialogOpen: open, missingMcpServers: servers ?? [] }),
  setAgentReviewDialog: (open, summary) =>
    set({ agentReviewDialogOpen: open, agentReviewSummary: summary ?? null }),
  toggleLogsPanel: () => set((s) => ({ showLogsPanel: !s.showLogsPanel })),
  setLogsAutoRefresh: (on) => set({ logsAutoRefresh: on }),
  setLogsPanelHeight: (h) => set({ logsPanelHeight: h }),
  setBottomPanelTab: (tab) => set({ bottomPanelTab: tab }),
  setShuttingDown: (v) => set({ shuttingDown: v })
}))
