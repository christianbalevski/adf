import { useEffect, useRef, useCallback } from 'react'
import { useEditorTabsStore } from '../../stores/editor-tabs.store'
import { useDocumentStore } from '../../stores/document.store'
import { TabBar } from './TabBar'
import { MarkdownEditor } from './MarkdownEditor'
import { CodeMirrorEditor } from './CodeMirrorEditor'
import { BinaryFilePlaceholder } from './BinaryFilePlaceholder'

const MD_EXTENSIONS = new Set(['md', 'markdown'])

export function EditorPanel() {
  const tabs = useEditorTabsStore((s) => s.tabs)
  const activeTabPath = useEditorTabsStore((s) => s.activeTabPath)
  const setActiveTab = useEditorTabsStore((s) => s.setActiveTab)
  const closeTab = useEditorTabsStore((s) => s.closeTab)
  const updateTabContent = useEditorTabsStore((s) => s.updateTabContent)
  const markTabSaved = useEditorTabsStore((s) => s.markTabSaved)

  const activeTab = tabs.find((t) => t.path === activeTabPath) ?? null
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Debounced auto-save
  const scheduleSave = useCallback((path: string, content: string) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      performSave(path, content)
    }, 300)
  }, [])

  const performSave = useCallback((path: string, content: string) => {
    if (path === 'document.md') {
      window.adfApi?.setDocument(content)
    } else if (path === 'mind.md') {
      window.adfApi?.setMind(content)
    } else {
      window.adfApi?.writeInternalFile(path, content)
    }
    markTabSaved(path)
  }, [markTabSaved])

  // Handle content changes from editors
  const handleChange = useCallback((path: string, content: string) => {
    updateTabContent(path, content)

    // Sync document.md changes to the document store
    if (path === 'document.md') {
      useDocumentStore.getState().setDocumentContent(content)
    } else if (path === 'mind.md') {
      useDocumentStore.getState().setMindContent(content)
    }

    scheduleSave(path, content)
  }, [updateTabContent, scheduleSave])

  // Sync document store changes back to the document.md tab
  useEffect(() => {
    const unsub = useDocumentStore.subscribe((state, prev) => {
      if (state.documentContent !== prev.documentContent) {
        const tabStore = useEditorTabsStore.getState()
        const docTab = tabStore.tabs.find((t) => t.path === 'document.md')
        if (docTab && docTab.content !== state.documentContent) {
          tabStore.updateTabFromExternal('document.md', state.documentContent)
        }
      }
      if (state.mindContent !== prev.mindContent) {
        const tabStore = useEditorTabsStore.getState()
        const mindTab = tabStore.tabs.find((t) => t.path === 'mind.md')
        if (mindTab && mindTab.content !== state.mindContent) {
          tabStore.updateTabFromExternal('mind.md', state.mindContent)
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
      <TabBar tabs={tabs} activeTabPath={activeTabPath} onSelect={setActiveTab} onClose={closeTab} />
      <div className="flex-1 overflow-hidden">
        {activeTab.isBinary ? (
          <BinaryFilePlaceholder filePath={activeTab.path} />
        ) : isMarkdown ? (
          <MarkdownEditor
            key={activeTab.path}
            content={activeTab.content}
            onChange={(content) => handleChange(activeTab.path, content)}
          />
        ) : (
          <CodeMirrorEditor
            key={activeTab.path}
            filePath={activeTab.path}
            content={activeTab.content}
            onChange={(content) => handleChange(activeTab.path, content)}
          />
        )}
      </div>
    </div>
  )
}
