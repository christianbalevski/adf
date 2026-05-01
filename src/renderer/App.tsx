import { useEffect, Component, type ReactNode } from 'react'
import { AppShell } from './components/layout/AppShell'
import { AboutDialog } from './components/common/AboutDialog'
import { useAppStore } from './stores/app.store'
import { useDocumentStore } from './stores/document.store'
import { useEditorTabsStore } from './stores/editor-tabs.store'
import { useAgentEvents } from './hooks/useAgent'
import { useMeshEvents } from './hooks/useMesh'
import { useBackgroundAgentEvents } from './hooks/useBackgroundAgents'
import { useAdfFile } from './hooks/useAdfFile'

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

  const { openFile } = useAdfFile()

  // Listen for open-file requests from main (double-click .adf in Finder)
  useEffect(() => {
    return window.adfApi?.onOpenFileRequest(({ filePath }) => {
      openFile(filePath)
    })
  }, [openFile])

  const showSettings = useAppStore((s) => s.showSettings)
  const setShowSettings = useAppStore((s) => s.setShowSettings)
  const showAbout = useAppStore((s) => s.showAbout)
  const setShowAbout = useAppStore((s) => s.setShowAbout)
  const theme = useAppStore((s) => s.theme)
  const setTheme = useAppStore((s) => s.setTheme)

  // Load theme from settings on mount
  useEffect(() => {
    window.adfApi?.getSettings().then((settings) => {
      const saved = settings.theme as string | undefined
      if (saved === 'dark' || saved === 'light' || saved === 'system') {
        setTheme(saved)
      }
    })
  }, [setTheme])

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
        // Flush and save active tab immediately
        const tabStore = useEditorTabsStore.getState()
        const activeTab = tabStore.tabs.find((t) => t.path === tabStore.activeTabPath)
        if (activeTab && activeTab.isDirty) {
          const path = activeTab.path
          const content = activeTab.content
          if (path === 'document.md') {
            window.adfApi?.setDocument(content)
          } else if (path === 'mind.md') {
            window.adfApi?.setMind(content)
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
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'w') {
        e.preventDefault()
        const tabStore = useEditorTabsStore.getState()
        if (tabStore.activeTabPath) {
          tabStore.closeTab(tabStore.activeTabPath)
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [setShowSettings])

  return (
    <ErrorBoundary>
      <AppShell />
      <AboutDialog
        open={showAbout}
        onClose={() => setShowAbout(false)}
      />
    </ErrorBoundary>
  )
}


