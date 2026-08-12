import { useEffect, useRef, useCallback, useState } from 'react'
import { useEditorTabsStore } from '../../stores/editor-tabs.store'
import { useDocumentStore } from '../../stores/document.store'
import { saveOpenTabs } from '../../utils/editor-tab-persistence'
import { TabBar } from './TabBar'
import { MarkdownEditor } from './MarkdownEditor'
import { CodeMirrorEditor } from './CodeMirrorEditor'
import { BinaryFilePlaceholder } from './BinaryFilePlaceholder'
import { BrowserViewer } from './BrowserViewer'

const MD_EXTENSIONS = new Set(['md', 'markdown'])

const LINE_WRAP_STORAGE_KEY = 'adf-editor-line-wrap'

export function EditorPanel() {
  const tabs = useEditorTabsStore((s) => s.tabs)
  const activeTabPath = useEditorTabsStore((s) => s.activeTabPath)
  const setActiveTab = useEditorTabsStore((s) => s.setActiveTab)
  const closeTab = useEditorTabsStore((s) => s.closeTab)
  const updateTabContent = useEditorTabsStore((s) => s.updateTabContent)
  const markTabSaved = useEditorTabsStore((s) => s.markTabSaved)
  const reloadBrowserTab = useEditorTabsStore((s) => s.reloadBrowserTab)

  const activeTab = tabs.find((t) => t.path === activeTabPath) ?? null
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [lineWrap, setLineWrap] = useState(() => localStorage.getItem(LINE_WRAP_STORAGE_KEY) !== '0')
  const toggleLineWrap = useCallback(() => {
    setLineWrap((prev) => {
      localStorage.setItem(LINE_WRAP_STORAGE_KEY, prev ? '0' : '1')
      return !prev
    })
  }, [])

  // Debounced auto-save
  const scheduleSave = useCallback((path: string, content: string) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      performSave(path, content)
    }, 300)
  }, [])

  // README.md is the only file with a dedicated store/IPC pair — it backs the
  // document store the rest of the UI reads. Every other workspace file,
  // mind.md and soul.md included, round-trips through the generic
  // internal-file path and stays in sync via `file_updated`.
  const performSave = useCallback((path: string, content: string) => {
    if (path === 'README.md') {
      window.adfApi?.setDocument(content)
    } else {
      window.adfApi?.writeInternalFile(path, content)
    }
    markTabSaved(path)
  }, [markTabSaved])

  // Handle content changes from editors
  const handleChange = useCallback((path: string, content: string) => {
    updateTabContent(path, content)

    // Sync README.md changes to the document store
    if (path === 'README.md') {
      useDocumentStore.getState().setDocumentContent(content)
    }

    scheduleSave(path, content)
  }, [updateTabContent, scheduleSave])

  // Sync document store changes back to the README.md tab
  useEffect(() => {
    const unsub = useDocumentStore.subscribe((state, prev) => {
      if (state.documentContent !== prev.documentContent) {
        const tabStore = useEditorTabsStore.getState()
        const docTab = tabStore.tabs.find((t) => t.path === 'README.md')
        if (docTab && docTab.content !== state.documentContent) {
          tabStore.updateTabFromExternal('README.md', state.documentContent)
        }
      }
    })
    return unsub
  }, [])

  // Flush pending saves on unmount
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [])

  // Persist the open-tab set per agent so returning to an agent (or
  // restarting the app) restores the same files. saveOpenTabs dedupes, so
  // per-keystroke store notifications don't hit localStorage.
  useEffect(() => {
    return useEditorTabsStore.subscribe((state) => {
      const agentFilePath = useDocumentStore.getState().filePath
      if (!agentFilePath) return
      saveOpenTabs(
        agentFilePath,
        state.tabs.filter((t) => t.kind === 'file').map((t) => t.path),
        state.activeTabPath
      )
    })
  }, [])

  // Empty state
  if (!activeTab) {
    return (
      <div className="h-full flex flex-col">
        <TabBar tabs={tabs} activeTabPath={activeTabPath} onSelect={setActiveTab} onClose={closeTab} />
        <div className="flex-1 flex items-center justify-center text-neutral-400 dark:text-neutral-500 text-sm">
          No file open
        </div>
      </div>
    )
  }

  const isMarkdown = MD_EXTENSIONS.has(activeTab.extension)

  return (
    <div className="h-full flex flex-col">
      <TabBar tabs={tabs} activeTabPath={activeTabPath} onSelect={setActiveTab} onClose={closeTab} onReload={reloadBrowserTab} />
      <div className="flex-1 overflow-hidden">
        {activeTab.kind === 'browser' && activeTab.browserMeta ? (
          <BrowserViewer key={activeTab.path} hostPort={activeTab.browserMeta.hostPort} reloadNonce={activeTab.browserMeta.reloadNonce} />
        ) : activeTab.isBinary ? (
          <BinaryFilePlaceholder filePath={activeTab.path} />
        ) : isMarkdown ? (
          <MarkdownEditor
            key={activeTab.path}
            filePath={activeTab.path}
            content={activeTab.content}
            onChange={(content) => handleChange(activeTab.path, content)}
          />
        ) : (
          <div className="relative h-full">
            <CodeMirrorEditor
              key={activeTab.path}
              filePath={activeTab.path}
              content={activeTab.content}
              onChange={(content) => handleChange(activeTab.path, content)}
              lineWrap={lineWrap}
            />
            <button
              onClick={toggleLineWrap}
              title={lineWrap ? 'Line wrap on — click to disable' : 'Line wrap off — click to enable'}
              aria-pressed={lineWrap}
              className={`absolute top-1.5 right-4 z-10 px-1.5 py-0.5 rounded text-[10px] font-mono font-medium border transition-colors ${
                lineWrap
                  ? 'bg-blue-50 dark:bg-blue-900/40 border-blue-300 dark:border-blue-700 text-blue-600 dark:text-blue-300'
                  : 'bg-white/80 dark:bg-neutral-800/80 border-neutral-200 dark:border-neutral-700 text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-300'
              }`}
            >
              wrap
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
