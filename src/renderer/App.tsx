import { useCallback, useEffect, useState, Component, type ReactNode } from 'react'
import { AppShell } from './components/layout/AppShell'
import { useAppStore, isUiScale, resolveUiFontStack, isUiFont, type SettingsSection } from './stores/app.store'
import { useDocumentStore } from './stores/document.store'
import { useMessageQueueStore } from './stores/message-queue.store'
import { useEditorTabsStore } from './stores/editor-tabs.store'
import { saveActiveEditorTab } from './utils/editor-save'
import { startEditRecovery, stashUnsavedEditors } from './utils/edit-recovery'
import { useAgentEvents } from './hooks/useAgent'
import { useMeshEvents } from './hooks/useMesh'
import { useBrowserSessionEvents } from './hooks/useBrowserSession'
import { useBackgroundAgentEvents } from './hooks/useBackgroundAgents'
import { useRuntimeFeeds } from './hooks/useRuntimeFeeds'
import { runtimeLabel, useRuntimesStore } from './stores/runtimes.store'
import { requestSettingsRuntime } from './stores/settings-runtime.store'
import { openApi } from './utils/runtime-api'
import { useApprovalEvents, useApprovalDeepLink } from './hooks/useApprovals'
import { useAdfFile } from './hooks/useAdfFile'
import { useTrackedDirs } from './hooks/useTrackedDirs'
import { isAgentAvatarMode } from './components/orbital/agent-avatar'
import { RemotePickerHost } from './components/common/RemotePickerDialog'
import { useAgentStore } from './stores/agent.store'
import { reportFailure } from './stores/failure-notices.store'
import { agentWindowFile, agentWindowsAvailable, isAgentWindow, openAgentWindow, windowRuntime } from './utils/window-kind'
import { openWindowAgent, startQueueHandover, startQueueMirror } from './utils/agent-window'
import { IS_MAC } from './utils/platform'
import { isPrimaryModifier } from './utils/keyboard'
import { useKeyboardStore } from './stores/keyboard.store'
import { AgentSwitcher } from './components/common/AgentSwitcher'
import { KeyboardShortcutsDialog } from './components/common/KeyboardShortcutsDialog'

// Once-per-page-load guard for the session resync below — StrictMode's double
// mount must not race two concurrent FILE_OPENs for the same path.
let sessionResyncDone = false

class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ADF ErrorBoundary]', error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 32, fontFamily: 'monospace' }}>
          <h2 style={{ color: '#dc2626' }}>Something went wrong</h2>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 13, marginTop: 12 }}>
            {this.state.error.message}
          </pre>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 11, color: '#666', marginTop: 8 }}>
            {this.state.error.stack}
          </pre>
          <button
            onClick={() => this.setState({ error: null })}
            style={{ marginTop: 16, padding: '6px 16px', cursor: 'pointer' }}
          >
            Retry
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

export default function App() {
  // Listen to agent events from main process
  useAgentEvents()
  useMeshEvents()
  useBackgroundAgentEvents()
  // Every runtime other than This computer (multi-runtime.md §5.3); no call with This computer only.
  useRuntimeFeeds()
  useBrowserSessionEvents()
  // Global HIL approvals (every agent + loop, foreground and background)
  useApprovalEvents()
  // Clicks on the OS-level notifications those approvals raise
  useApprovalDeepLink()

  const { openFile, createFile, closeFile } = useAdfFile()
  const { addDirectory } = useTrackedDirs()

  // Session resync: main outlives the renderer, so after a window reload or
  // recreation it may still hold an open file with a running foreground agent
  // the fresh renderer knows nothing about (it would render Home with the
  // agent toggled off while the agent keeps running). Re-open that file
  // through the normal flow, which adopts the running agent and restores the
  // loop, state, and pending approvals.
  useEffect(() => {
    if (sessionResyncDone) return
    sessionResyncDone = true
    // An agent window opens its agent (agent-windows.md); a reload reopens the file its session has open.
    if (isAgentWindow) {
      void openWindowAgent(openFile)
      return
    }
    window.adfApi?.getCurrentFile?.().then((session) => {
      if (session?.filePath && !useDocumentStore.getState().filePath) {
        openFile(session.filePath)
      }
    }).catch(() => { /* older main without the handler */ })
    // Run once on mount — openFile's identity is stable enough for this purpose
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // W3-F: copies of unsaved text a "changed elsewhere" notice holds, so a quit keeps them.
  useEffect(() => startEditRecovery(), [])

  // Queued messages outlive an agent window: it mirrors them to main, the main window takes them when it closes.
  useEffect(() => {
    if (isAgentWindow) return startQueueMirror()
    if (agentWindowsAvailable) return startQueueHandover()
  }, [])

  // Flush the active editor tab and save the document (Cmd/Ctrl+S + File > Save).
  // The tab is saved through the editor's own save path (W3-F): over its
  // revision, never while its "changed elsewhere" notice is up (the notice
  // gets focus instead).
  const saveActiveDocument = useCallback(() => {
    saveActiveEditorTab()
    openApi()?.saveFile().then((result) => {
      if (result?.success) {
        useDocumentStore.getState().setDirty(false)
      }
    })
  }, [])

  // Listen for open-file requests from main (double-click .adf in Finder)
  useEffect(() => {
    // Main sends these to the main window; an agent window keeps its agent.
    if (isAgentWindow) return
    // `runtimeId`: Open Recent of another runtime (multi-runtime.md §6.6); absent, This computer's.
    const unsubscribe = window.adfApi?.onOpenFileRequest(({ filePath, runtimeId }) => {
      openFile(filePath, runtimeId || undefined)
    })
    // Drain any request queued before this listener existed — main's one-shot
    // did-finish-load push can fire before the React effect registers (the
    // pull clears main's queue on read, so push + pull never double-open).
    window.adfApi?.getPendingOpenFile?.().then((pending) => {
      const filePath = pending?.filePath
      const doc = useDocumentStore.getState()
      if (filePath && (doc.filePath !== filePath || (pending.runtimeId && doc.runtimeId !== pending.runtimeId))) {
        openFile(filePath, pending.runtimeId || undefined)
      }
    }).catch(() => { /* pull is best-effort; the push path still works */ })
    return unsubscribe
  }, [openFile])

  // Keep the open document's path current when an .adf file is renamed on
  // disk (immediate rename, or a deferred one applied after the agent stops)
  useEffect(() => {
    return window.adfApi?.onFileRenamed?.(({ oldPath, newPath }) => {
      const store = useDocumentStore.getState()
      // This window's runtime's rename: an agent of another runtime with the same path is not it (useRuntimeFeeds follows those).
      if (store.filePath === oldPath && (isAgentWindow || store.runtimeId === 'local')) store.setFilePath(newPath)
      // Queued messages follow their agent to its new path.
      useMessageQueueStore.getState().rekey(oldPath, newPath)
    })
  }, [])

  const setShowSettings = useAppStore((s) => s.setShowSettings)
  const setShowMeshGraph = useAppStore((s) => s.setShowMeshGraph)

  // Cmd/Ctrl+W and File > Close Tab. On the center stage's chat tab it does
  // exactly what that tab's X does: send the chat back to the side dock.
  // Closing whichever file tab happens to be behind it would be the shortcut
  // acting on something the user cannot even see. An agent window with no
  // tab left closes, as Close Agent does there (agent-windows.md).
  const closeActiveTab = useCallback(() => {
    const app = useAppStore.getState()
    if (app.chatPlacement === 'center' && app.centerChatTabActive) {
      app.setChatPlacement('side')
      return
    }
    const tabStore = useEditorTabsStore.getState()
    if (tabStore.activeTabPath) {
      tabStore.closeTab(tabStore.activeTabPath)
      return
    }
    if (isAgentWindow && tabStore.tabs.length === 0) void closeFile()
  }, [closeFile])

  // An agent window's title is its agent's name; with more than one runtime,
  // `<agent> · <runtime name>` (multi-runtime.md §5.5).
  const agentName = useAgentStore((s) => s.config?.name)
  const windowLabel = useRuntimesStore((s) => runtimeLabel(windowRuntime, s.runtimes))
  useEffect(() => {
    if (!isAgentWindow) return
    const fileName = agentWindowFile?.split(/[\\/]/).pop()?.replace(/\.adf$/i, '')
    const name = agentName || fileName
    document.title = name ? (windowLabel ? `${name} · ${windowLabel}` : name) : document.title
  }, [agentName, windowLabel])

  // Application menu actions (File > New/Open/Add Directory, app menu > Settings)
  useEffect(() => {
    const handle = async (action: string): Promise<void> => {
      // An agent window's Settings links open Settings in the main window (agent-windows.md).
      // Settings opens on that runtime (an agent window's Settings link, multi-runtime.md §6.3); the open action follows.
      if (action.startsWith('settings-runtime:')) {
        requestSettingsRuntime(action.slice('settings-runtime:'.length))
        return
      }
      if (action.startsWith('open-settings-at:')) {
        const [section, anchor] = action.slice('open-settings-at:'.length).split('#')
        useAppStore.getState().openSettingsAt(section as SettingsSection, anchor || undefined)
        return
      }
      switch (action) {
        case 'new-file': {
          const result = await createFile('Untitled')
          if (result?.success) setShowMeshGraph(false)
          break
        }
        case 'open-file': {
          const result = await openFile()
          if (result?.success) setShowMeshGraph(false)
          break
        }
        case 'add-directory':
          await addDirectory().catch((err: unknown) => reportFailure('Folder not tracked', err))
          break
        case 'save':
          saveActiveDocument()
          break
        case 'close-file':
          await closeFile()
          break
        case 'open-settings':
          setShowSettings(true)
          break
        case 'close-tab':
          closeActiveTab()
          break
        case 'go-to-agent':
          useKeyboardStore.getState().setSwitcherOpen(true)
          break
        case 'show-shortcuts':
          useKeyboardStore.getState().setShortcutsOpen(true)
          break
        // Home, the fleet map and the sidebar are the main window's (main sends these there).
        // Home only navigates: the open agent stays open (Close Agent closes it).
        case 'go-home':
          if (!isAgentWindow) useAppStore.getState().setShowHome(true)
          break
        case 'show-fleet-map':
          if (isAgentWindow) break
          setShowSettings(false)
          setShowMeshGraph(true)
          break
        case 'toggle-sidebar':
          if (!isAgentWindow) useAppStore.getState().toggleSidebar()
          break
        // The panel shows the open agent: with none, there is nothing to toggle.
        case 'toggle-panel':
          if (useDocumentStore.getState().filePath) useAppStore.getState().toggleRightPanel()
          break
        // An agent window already is the agent's window.
        case 'open-in-new-window': {
          const { filePath, runtimeId } = useDocumentStore.getState()
          const config = useAgentStore.getState().config
          if (agentWindowsAvailable && filePath) {
            openAgentWindow({ filePath, agentId: config?.id ?? null, ...(config?.name ? { name: config.name } : {}), runtimeId })
          }
          break
        }
        // Daemon mode: main restarts Studio after This computer's daemon connection failed; keep unsaved editors first.
        case 'stash-edits-and-reconnect':
        case 'stash-edits-and-use-embedded':
          await stashUnsavedEditors()
          await window.adfApi?.restartStudio(action === 'stash-edits-and-reconnect' ? 'reconnect' : 'embedded-session')
          break
        // An agent window before that restart: keep its unsaved editors; the main window restarts.
        case 'stash-edits':
          await stashUnsavedEditors()
          await window.adfApi?.agentWindowStashed()
          break
      }
    }
    const off = window.adfApi?.onMenuAction((action) => { void handle(action) })
    // Daemon mode: actions sent while this page loaded wait in main until it listens.
    if (isAgentWindow || agentWindowsAvailable) {
      void window.adfApi?.takePendingMenuActions?.().then((actions) => { for (const action of actions ?? []) void handle(action) }).catch(() => {})
    }
    return off
  }, [openFile, createFile, closeFile, addDirectory, saveActiveDocument, closeActiveTab, setShowMeshGraph, setShowSettings])
  const theme = useAppStore((s) => s.theme)
  const setTheme = useAppStore((s) => s.setTheme)
  const uiFont = useAppStore((s) => s.uiFont)
  const uiFontCustom = useAppStore((s) => s.uiFontCustom)
  const uiScale = useAppStore((s) => s.uiScale)
  const setUiFont = useAppStore((s) => s.setUiFont)
  const setUiFontCustom = useAppStore((s) => s.setUiFontCustom)
  const setUiScale = useAppStore((s) => s.setUiScale)
  const setAgentAvatars = useAppStore((s) => s.setAgentAvatars)
  // Zoom is only applied once the persisted value is known, so a saved 110%
  // never gets reset to 100% by the initial store default.
  const [appearanceLoaded, setAppearanceLoaded] = useState(false)

  // Load theme / font / scale from settings on mount
  useEffect(() => {
    window.adfApi?.getSettings().then((settings) => {
      const saved = settings.theme as string | undefined
      if (saved === 'dark' || saved === 'light' || saved === 'system') {
        setTheme(saved)
      }
      if (isUiFont(settings.uiFont)) setUiFont(settings.uiFont)
      if (typeof settings.uiFontCustom === 'string') setUiFontCustom(settings.uiFontCustom)
      if (isUiScale(settings.uiScale)) setUiScale(settings.uiScale)
      if (isAgentAvatarMode(settings.agentAvatars)) setAgentAvatars(settings.agentAvatars)
      setAppearanceLoaded(true)
    })
  }, [setTheme, setUiFont, setUiFontCustom, setUiScale, setAgentAvatars])

  // Appearance saved in another window (agent windows) applies here at once.
  useEffect(() => {
    return window.adfApi?.onAppearanceChanged?.((changed) => {
      const theme = changed.theme as string | undefined
      if (theme === 'dark' || theme === 'light' || theme === 'system') setTheme(theme)
      if (isUiFont(changed.uiFont)) setUiFont(changed.uiFont)
      if (typeof changed.uiFontCustom === 'string') setUiFontCustom(changed.uiFontCustom)
      if (isUiScale(changed.uiScale)) setUiScale(changed.uiScale)
      if (isAgentAvatarMode(changed.agentAvatars)) setAgentAvatars(changed.agentAvatars)
    })
  }, [setTheme, setUiFont, setUiFontCustom, setUiScale, setAgentAvatars])

  // Interface typeface: rewrite the CSS token the html/body rule reads.
  useEffect(() => {
    document.documentElement.style.setProperty('--adf-font-ui', resolveUiFontStack(uiFont, uiFontCustom))
    document.documentElement.dataset.uiFont = uiFont
  }, [uiFont, uiFontCustom])

  // UI scale via Electron zoom; Ctrl+= / Ctrl+- (menu roles) layer on top.
  useEffect(() => {
    if (!appearanceLoaded) return
    window.adfApi?.setZoomFactor?.(uiScale)
  }, [appearanceLoaded, uiScale])

  // Apply dark class to <html> and body classes whenever theme changes
  // For 'system', follow OS preference and listen for changes
  useEffect(() => {
    const applyTheme = (isDark: boolean) => {
      const html = document.documentElement
      const body = document.body
      // Brand tokens (brand-tokens.css) key on data-theme; `.dark` drives
      // Tailwind's dark variant. Always set the resolved value so an explicit
      // choice beats the OS prefers-color-scheme branch of the token file.
      html.dataset.theme = isDark ? 'dark' : 'light'
      if (isDark) {
        html.classList.add('dark')
        body.classList.remove('bg-neutral-50', 'text-neutral-900')
        body.classList.add('bg-neutral-950', 'text-neutral-100')
      } else {
        html.classList.remove('dark')
        body.classList.remove('bg-neutral-950', 'text-neutral-100')
        body.classList.add('bg-neutral-50', 'text-neutral-900')
      }
    }

    if (theme === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      applyTheme(mq.matches)
      const handler = (e: MediaQueryListEvent) => applyTheme(e.matches)
      mq.addEventListener('change', handler)
      return () => mq.removeEventListener('change', handler)
    } else {
      applyTheme(theme === 'dark')
    }
  }, [theme])

  // Settings, Save and Close Tab from the keyboard. The platform's command
  // modifier only (⌘ on macOS, Ctrl elsewhere): Ctrl+S on a Mac and Win+S on
  // Windows are not Save.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!isPrimaryModifier(e, IS_MAC) || e.altKey) return
      if (e.key === ',') {
        e.preventDefault()
        // An agent window opens them in the main window (app.store).
        setShowSettings(true)
      } else if (e.key === 's') {
        e.preventDefault()
        saveActiveDocument()
      } else if (e.key === 'w') {
        e.preventDefault()
        closeActiveTab()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [setShowSettings, saveActiveDocument, closeActiveTab])

  return (
    <ErrorBoundary>
      <AppShell />
      <RemotePickerHost />
      <AgentSwitcher />
      <KeyboardShortcutsDialog />
    </ErrorBoundary>
  )
}


