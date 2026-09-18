import { create } from 'zustand'
import type { AgentConfigSummary } from '../../shared/types/ipc.types'

export type RightPanel = 'loop' | 'inbox' | 'files' | 'agent'
type AgentSubTab = 'config' | 'timers' | 'identity' | 'skills'
/**
 * Where the Loops chat panel is mounted. `side` = the right dock's Loops tab
 * (the original, and still the default); `center` = a pinned first tab on the
 * center stage, peer to the document/browser tabs, so a multi-loop agent gets
 * the full window width. One component, two mount points — see AgentLoop.
 */
export type ChatPlacement = 'side' | 'center'

/**
 * How wide the chat's message column is allowed to get. Only consulted in
 * `center` placement: on the stage, with both side panels collapsed, the chat
 * spans the whole window and lines get unreadably long. `comfortable` (the
 * default) caps the stream and composer to a centred reading column;
 * `full` is the un-capped, original behaviour. In `side` placement the dock
 * is already narrow, so the preference is ignored entirely.
 */
export type ChatWidth = 'comfortable' | 'full'

/**
 * Global, persisted (settings store): interface typeface. Presets are just
 * family stacks that fall back to the system stack when the face is not
 * installed — nothing is bundled or fetched. `custom` reads `uiFontCustom`.
 */
export type UiFont = 'system' | 'segoe' | 'inter' | 'roboto' | 'sf' | 'calibri' | 'verdana' | 'georgia' | 'custom'
export const UI_FONT_SYSTEM_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif"
export const UI_FONT_STACKS: Record<Exclude<UiFont, 'custom'>, string> = {
  system: UI_FONT_SYSTEM_STACK,
  segoe: `'Segoe UI Variable', 'Segoe UI', ${UI_FONT_SYSTEM_STACK}`,
  inter: `'Inter', ${UI_FONT_SYSTEM_STACK}`,
  roboto: `'Roboto', ${UI_FONT_SYSTEM_STACK}`,
  sf: `-apple-system, 'SF Pro Text', 'SF Pro Display', ${UI_FONT_SYSTEM_STACK}`,
  calibri: `'Calibri', ${UI_FONT_SYSTEM_STACK}`,
  verdana: `'Verdana', ${UI_FONT_SYSTEM_STACK}`,
  georgia: `'Georgia', serif`,
}
/**
 * Picker rows. `family` is the face to probe for on this machine (null for
 * the system stack, which always resolves) so the picker can flag presets
 * that would silently fall back — on Windows, Inter/SF/Roboto usually would.
 */
export const UI_FONT_PRESETS: { value: Exclude<UiFont, 'custom'>; label: string; family: string | null }[] = [
  { value: 'system', label: 'System default', family: null },
  { value: 'segoe', label: 'Segoe UI', family: 'Segoe UI' },
  { value: 'inter', label: 'Inter', family: 'Inter' },
  { value: 'roboto', label: 'Roboto', family: 'Roboto' },
  { value: 'sf', label: 'SF Pro', family: 'SF Pro Text' },
  { value: 'calibri', label: 'Calibri', family: 'Calibri' },
  { value: 'verdana', label: 'Verdana', family: 'Verdana' },
  { value: 'georgia', label: 'Georgia (serif)', family: 'Georgia' },
]
export function isUiFont(value: unknown): value is UiFont {
  return value === 'custom' || UI_FONT_PRESETS.some((preset) => preset.value === value)
}
/** Resolves the `--adf-font-ui` stack for a font choice; empty custom = system. */
export function resolveUiFontStack(font: UiFont, custom: string): string {
  if (font !== 'custom') return UI_FONT_STACKS[font]
  const family = custom.trim().replace(/["']/g, '')
  return family ? `'${family}', ${UI_FONT_SYSTEM_STACK}` : UI_FONT_SYSTEM_STACK
}

/** Global, persisted (settings store): Electron zoom factor for the whole UI. */
export const UI_SCALE_OPTIONS = [0.9, 1, 1.1, 1.25] as const
export type UiScale = (typeof UI_SCALE_OPTIONS)[number]
export function isUiScale(value: unknown): value is UiScale {
  return typeof value === 'number' && (UI_SCALE_OPTIONS as readonly number[]).includes(value)
}

/** Same localStorage idiom the editor's line-wrap / open-tabs prefs use. */
const CHAT_PLACEMENT_KEY = 'adf-chat-placement'
const CHAT_WIDTH_KEY = 'adf-chat-width'

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

function loadChatWidth(): ChatWidth {
  try {
    return localStorage.getItem(CHAT_WIDTH_KEY) === 'full' ? 'full' : 'comfortable'
  } catch {
    return 'comfortable'
  }
}

function saveChatWidth(width: ChatWidth): void {
  try {
    localStorage.setItem(CHAT_WIDTH_KEY, width)
  } catch { /* storage full/unavailable — non-fatal, the pref just won't stick */ }
}
/** Settings tab key, kept in sync with SettingsPage's `activeTab` union. */
export type SettingsSection = 'general' | 'identity' | 'agents' | 'template' | 'providers' | 'packages' | 'mcps' | 'skills' | 'channels' | 'networking' | 'compute' | 'about'

export type ProviderSetupReason = 'provider_missing' | 'provider_unconfigured'

export interface ProviderSetupRequest {
  reason: ProviderSetupReason
  /** The agent whose start was blocked (null when unknown). */
  filePath: string | null
  resolve: (connected: boolean) => void
}

export interface AppState {
  showSettings: boolean
  /**
   * Optional initial tab to focus when SettingsPage mounts. Set by
   * dashboard tile clicks via `openSettingsAt`. SettingsPage reads it
   * once on mount and clears it.
   */
  pendingSettingsSection: SettingsSection | null
  /** Optional `data-settings-anchor` inside that section to scroll into view once it renders. */
  pendingSettingsAnchor: string | null
  rightPanel: RightPanel
  agentSubTab: AgentSubTab
  /** Global, persisted: which slot the Loops chat panel is mounted in. */
  chatPlacement: ChatPlacement
  /** Global, persisted: reading-column width of the chat. Center placement only. */
  chatWidth: ChatWidth
  /**
   * Center-stage tab selection for the chat tab. Only meaningful while the
   * chat is placed in the center; the editor's own `activeTabPath` keeps
   * pointing at the last file, so leaving the chat restores it untouched.
   */
  centerChatTabActive: boolean
  sidebarCollapsed: boolean
  rightPanelCollapsed: boolean
  theme: 'light' | 'dark' | 'system'
  uiFont: UiFont
  uiFontCustom: string
  uiScale: UiScale
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
  /**
   * A start that failed for want of a provider is parked here while the
   * provider setup sheet is up. `resolve(true)` means a provider was
   * connected and applied to the agent — the caller retries the start.
   */
  providerSetupRequest: ProviderSetupRequest | null
  /** Share dialog: null = closed; otherwise the file to feature, or '' for the whole list. */
  shareDialogFilePath: string | null
  /**
   * A message typed into the home composer, waiting for the agent it created
   * to mount. The loop panel takes it (once, by file path) and sends it
   * through its ordinary send path, so the first message goes through the
   * same start gates as any other.
   */
  pendingFirstMessage: { filePath: string; text: string; files?: File[] } | null
  /** Provider chip picked on the home strip for the next new agent; null = the app default. Session only. */
  homeProviderId: string | null
  /** Folder chip picked on the home composer for the next new agent; null = the agents folder. Session only. */
  homeFolder: string | null
  /** Unsent text in the home composer, kept across navigation. Session only. */
  homeDraft: string
  /** Files attached in the home composer, waiting for the agent that will receive them. Session only. */
  homeFiles: File[]
  /** Name the next new agent will get; null until the composer draws one. Session only. */
  homeName: string | null
  /** Template chip on the home composer; null = the default template (settings.defaultTemplateId). Session only. */
  homeTemplateId: string | null
  /** Model chosen in the provider chip; null = the provider's default model. Session only. */
  homeModelId: string | null
  /**
   * A template awaiting the owner's review (foreign or stripped file dropped into the
   * templates folder). AgentReviewDialog renders it in template mode; `onDone` gets
   * true when the owner accepted, false on cancel.
   */
  templateReview: { id: string; summary: AgentConfigSummary; onDone?: (accepted: boolean) => void } | null
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
  openSettingsAt: (section: SettingsSection, anchor?: string) => void
  /** Cleared by SettingsPage after it consumes the pending section. */
  consumePendingSettingsSection: () => SettingsSection | null
  consumePendingSettingsAnchor: () => string | null
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
  /** Persisted; only observable while the chat is on the center stage. */
  setChatWidth: (width: ChatWidth) => void
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
  setUiFont: (font: UiFont) => void
  setUiFontCustom: (family: string) => void
  setUiScale: (scale: UiScale) => void
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
  /** Open the provider setup sheet; resolves when it closes (true = connected). */
  requestProviderSetup: (reason: ProviderSetupReason, filePath: string | null) => Promise<boolean>
  resolveProviderSetup: (connected: boolean) => void
  openShareDialog: (filePath?: string) => void
  setPendingFirstMessage: (pending: { filePath: string; text: string; files?: File[] } | null) => void
  /** Claim the pending message for this file; null if it belongs to another file or was taken. */
  takePendingFirstMessage: (filePath: string) => { filePath: string; text: string } | null
  setHomeProviderId: (id: string | null) => void
  setHomeFolder: (folder: string | null) => void
  setHomeDraft: (text: string) => void
  setHomeFiles: (files: File[]) => void
  setHomeName: (name: string | null) => void
  setHomeTemplateId: (id: string | null) => void
  setHomeModelId: (id: string | null) => void
  openTemplateReview: (id: string, summary: AgentConfigSummary, onDone?: (accepted: boolean) => void) => void
  closeTemplateReview: (accepted: boolean) => void
  closeShareDialog: () => void
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

/**
 * Whether the chat's message column + composer should be capped to a centred
 * reading width *right now*. The dock is narrow by construction, so the width
 * preference is a center-stage concern only — one selector so the layout and
 * the toggle button can never disagree about when the cap applies.
 */
export const selectChatColumnCapped = (s: AppState): boolean =>
  selectChatInCenter(s) && s.chatWidth === 'comfortable'

/**
 * Which tab the right dock should actually SHOW right now. Two corrections over
 * the raw `rightPanel`:
 *  - center placement removes the Loops tab, so a dock still parked on 'loop'
 *    falls through to 'inbox';
 *  - center placement that has YIELDED to the fleet map (B6) temporarily regains
 *    its Loops tab, so it shows the chat that yielded rather than the non-loop
 *    tab parked under it — making boot-on-map and toggle-to-map agree.
 */
export const selectActiveDockPanel = (s: AppState): RightPanel => {
  const inCenter = selectChatInCenter(s)
  if (inCenter && s.rightPanel === 'loop') return 'inbox'
  if (!inCenter && s.chatPlacement === 'center') return 'loop'
  return s.rightPanel
}

/**
 * Whether the "promote chat to the center stage" affordance should be offered.
 * Only the dock offers it, and never while the fleet map holds the stage —
 * promoting there would send the chat to a covered stage and it would vanish
 * (B2). So: dock placement AND not on the map.
 */
export const selectCanPromoteChat = (s: AppState): boolean =>
  s.chatPlacement !== 'center' && !s.showMeshGraph

export const useAppStore = create<AppState>((set) => ({
  showSettings: false,
  pendingSettingsSection: null,
  pendingSettingsAnchor: null,
  rightPanel: 'loop',
  agentSubTab: 'timers',
  chatPlacement: loadChatPlacement(),
  chatWidth: loadChatWidth(),
  centerChatTabActive: loadChatPlacement() === 'center',
  sidebarCollapsed: false,
  rightPanelCollapsed: false,
  theme: 'system',
  uiFont: 'system',
  uiFontCustom: '',
  uiScale: 1,
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
  providerSetupRequest: null,
  shareDialogFilePath: null,
  pendingFirstMessage: null,
  homeProviderId: null,
  homeFolder: null,
  homeDraft: '',
  homeFiles: [],
  homeName: null,
  homeTemplateId: null,
  homeModelId: null,
  templateReview: null,
  showLogsPanel: false,
  logsAutoRefresh: false,
  logsPanelHeight: 200,
  bottomPanelTab: 'logs',
  shuttingDown: false,

  setShowSettings: (show) => set({
    showSettings: show,
    ...(show ? { showMeshGraph: false } : {})
  }),
  openSettingsAt: (section, anchor) =>
    set({ showSettings: true, showMeshGraph: false, pendingSettingsSection: section, pendingSettingsAnchor: anchor ?? null }),
  consumePendingSettingsAnchor: () => {
    const current = useAppStore.getState().pendingSettingsAnchor
    if (current) set({ pendingSettingsAnchor: null })
    return current
  },
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
  setChatWidth: (width) => {
    saveChatWidth(width)
    set({ chatWidth: width })
  },
  setCenterChatTabActive: (active) => set({ centerChatTabActive: active }),
  revealRightPanel: () => set({ rightPanelCollapsed: false }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  toggleRightPanel: () =>
    set((s) => ({ rightPanelCollapsed: !s.rightPanelCollapsed })),
  setTheme: (theme) => set({ theme }),
  setUiFont: (uiFont) => set({ uiFont }),
  setUiFontCustom: (uiFontCustom) => set({ uiFontCustom }),
  setUiScale: (uiScale) => set({ uiScale }),
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
      // "Take me to the chat" has to land wherever the chat actually IS right
      // now, not where the raw preference says (B3). While the fleet map holds
      // the center stage, a center-mode chat has yielded to the dock's Loops
      // tab — routing to the (covered) stage tab would land the click nowhere.
      // selectChatInCenter is false in that case, so we fall through to the
      // dock branch and reveal Loops there.
      if (panel === 'loop' && selectChatInCenter(s)) {
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
  requestProviderSetup: (reason, filePath) =>
    new Promise<boolean>((resolve) => {
      set((s) => {
        // A second request while one is up loses: resolve it as cancelled
        // rather than stacking two sheets.
        s.providerSetupRequest?.resolve(false)
        return { providerSetupRequest: { reason, filePath, resolve } }
      })
    }),
  resolveProviderSetup: (connected) =>
    set((s) => {
      s.providerSetupRequest?.resolve(connected)
      return { providerSetupRequest: null }
    }),
  openShareDialog: (filePath) => set({ shareDialogFilePath: filePath ?? '' }),
  closeShareDialog: () => set({ shareDialogFilePath: null }),
  setPendingFirstMessage: (pending) => set({ pendingFirstMessage: pending }),
  setHomeProviderId: (id) => set({ homeProviderId: id }),
  setHomeFolder: (folder) => set({ homeFolder: folder }),
  setHomeDraft: (text) => set({ homeDraft: text }),
  setHomeFiles: (files) => set({ homeFiles: files }),
  setHomeName: (name) => set({ homeName: name }),
  setHomeTemplateId: (id) => set({ homeTemplateId: id }),
  setHomeModelId: (id) => set({ homeModelId: id }),
  openTemplateReview: (id, summary, onDone) => set({ templateReview: { id, summary, onDone } }),
  closeTemplateReview: (accepted) => {
    const current = useAppStore.getState().templateReview
    set({ templateReview: null })
    current?.onDone?.(accepted)
  },
  takePendingFirstMessage: (filePath) => {
    const pending = useAppStore.getState().pendingFirstMessage
    if (!pending || pending.filePath !== filePath) return null
    set({ pendingFirstMessage: null })
    return pending
  },
  toggleLogsPanel: () => set((s) => ({ showLogsPanel: !s.showLogsPanel })),
  setLogsAutoRefresh: (on) => set({ logsAutoRefresh: on }),
  setLogsPanelHeight: (h) => set({ logsPanelHeight: h }),
  setBottomPanelTab: (tab) => set({ bottomPanelTab: tab }),
  setShuttingDown: (v) => set({ shuttingDown: v })
}))
