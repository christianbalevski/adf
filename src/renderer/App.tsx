import { useCallback, useEffect, useState, Component, type ReactNode } from 'react'
import { AppShell } from './components/layout/AppShell'
import { useAppStore, isUiScale, resolveUiFontStack, isUiFont } from './stores/app.store'
import { useDocumentStore } from './stores/document.store'
import { useEditorTabsStore } from './stores/editor-tabs.store'
import { useAgentEvents } from './hooks/useAgent'
import { useMeshEvents } from './hooks/useMesh'
import { useBrowserSessionEvents } from './hooks/useBrowserSession'
import { useBackgroundAgentEvents } from './hooks/useBackgroundAgents'
import { useApprovalEvents, useApprovalDeepLink } from './hooks/useApprovals'
import { useAdfFile } from './hooks/useAdfFile'
import { useTrackedDirs } from './hooks/useTrackedDirs'

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
    window.adfApi?.getCurrentFile?.().then((session) => {
      if (session?.filePath && !useDocumentStore.getState().filePath) {
        openFile(session.filePath)
      }
    }).catch(() => { /* older main without the handler */ })
    // Run once on mount — openFile's identity is stable enough for this purpose
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Flush the active editor tab and save the document (Cmd/Ctrl+S + File > Save)
  const saveActiveDocument = useCallback(() => {
    const tabStore = useEditorTabsStore.getState()
    const activeTab = tabStore.tabs.find((t) => t.path === tabStore.activeTabPath)
    if (activeTab && activeTab.isDirty) {
      const path = activeTab.path
      const content = activeTab.content
      if (path === 'README.md') {
        window.adfApi?.setDocument(content)
      } else {
        window.adfApi?.writeInternalFile(path, content)
      }
      tabStore.markTabSaved(path)
    }
    window.adfApi?.saveFile().then((result) => {
      if (result?.success) {
        useDocumentStore.getState().setDirty(false)
      }
    })
  }, [])

  // Listen for open-file requests from main (double-click .adf in Finder)
  useEffect(() => {
    const unsubscribe = window.adfApi?.onOpenFileRequest(({ filePath }) => {
      openFile(filePath)
    })
    // Drain any request queued before this listener existed — main's one-shot
    // did-finish-load push can fire before the React effect registers (the
    // pull clears main's queue on read, so push + pull never double-open).
    window.adfApi?.getPendingOpenFile?.().then((pending) => {
      const filePath = pending?.filePath
      if (filePath && useDocumentStore.getState().filePath !== filePath) {
        openFile(filePath)
      }
    }).catch(() => { /* pull is best-effort; the push path still works */ })
    return unsubscribe
  }, [openFile])

  // Keep the open document's path current when an .adf file is renamed on
  // disk (immediate rename, or a deferred one applied after the agent stops)
  useEffect(() => {
    return window.adfApi?.onFileRenamed?.(({ oldPath, newPath }) => {
      const store = useDocumentStore.getState()
      if (store.filePath === oldPath) store.setFilePath(newPath)
    })
  }, [])

  const setShowSettings = useAppStore((s) => s.setShowSettings)
  const setShowMeshGraph = useAppStore((s) => s.setShowMeshGraph)

  // Application menu actions (File > New/Open/Add Directory, app menu > Settings)
  useEffect(() => {
    return window.adfApi?.onMenuAction(async (action) => {
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
          await addDirectory()
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
      }
    })
  }, [openFile, createFile, closeFile, addDirectory, saveActiveDocument, setShowMeshGraph, setShowSettings])
  const theme = useAppStore((s) => s.theme)
  const setTheme = useAppStore((s) => s.setTheme)
  const uiFont = useAppStore((s) => s.uiFont)
  const uiFontCustom = useAppStore((s) => s.uiFontCustom)
  const uiScale = useAppStore((s) => s.uiScale)
  const setUiFont = useAppStore((s) => s.setUiFont)
  const setUiFontCustom = useAppStore((s) => s.setUiFontCustom)
  const setUiScale = useAppStore((s) => s.setUiScale)
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
      setAppearanceLoaded(true)
    })
  }, [setTheme, setUiFont, setUiFontCustom, setUiScale])

  // Interface typeface: rewrite the CSS token the html/body rule reads.
  useEffect(() => {
    document.documentElement.style.setProperty('--adf-font-ui', resolveUiFontStack(uiFont, uiFontCustom))
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

  // Keyboard shortcut for settings
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault()
        setShowSettings(true)
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        saveActiveDocument()
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'w') {
        e.preventDefault()
        // On the center stage's chat tab, Ctrl+W does exactly what its X does:
        // send the chat back to the side dock. Closing whichever file tab
        // happens to be behind it would be the shortcut acting on something the
        // user cannot even see.
        const app = useAppStore.getState()
        if (app.chatPlacement === 'center' && app.centerChatTabActive) {
          app.setChatPlacement('side')
          return
        }
        const tabStore = useEditorTabsStore.getState()
        if (tabStore.activeTabPath) {
          tabStore.closeTab(tabStore.activeTabPath)
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [setShowSettings, saveActiveDocument])

  return (
    <ErrorBoundary>
      <AppShell />
    </ErrorBoundary>
  )
}


