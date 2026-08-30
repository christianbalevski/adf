import { useEffect, useRef, useCallback, useState } from 'react'
import { useEditorTabsStore, isAgentSwitching } from '../../stores/editor-tabs.store'
import { useDocumentStore } from '../../stores/document.store'
import { useAppStore, selectChatInCenter, type AppState } from '../../stores/app.store'
import { useAgentStore, selectAggregateLogVersion } from '../../stores/agent.store'
import { AgentLoop } from '../agent/AgentLoop'
import { DEFAULT_OPEN_TABS } from '../../hooks/useAdfFile'
import { saveOpenTabs } from '../../utils/editor-tab-persistence'
import { TabBar } from './TabBar'
import { MarkdownEditor } from './MarkdownEditor'
import { CodeMirrorEditor } from './CodeMirrorEditor'
import { BinaryFilePlaceholder } from './BinaryFilePlaceholder'
import { BrowserViewer } from './BrowserViewer'
import { estimateTokens, formatTokenCount } from '../../utils/token-estimate'

const MD_EXTENSIONS = new Set(['md', 'markdown'])

const LINE_WRAP_STORAGE_KEY = 'adf-editor-line-wrap'

/**
 * Aggregate unread indicator for the center chat tab. Deliberately a heuristic,
 * not a read-receipt system: any loop's log mutating while the tab is not
 * showing means "something happened in there". Opening the tab clears it.
 * Sub-tab (per-loop) detail stays on the loop strip inside the panel.
 *
 * Perf (B1): the old version summed logVersion via a store SELECTOR, so every
 * delta of every loop (~80/s) re-rendered the whole editor subtree — and it did
 * so even in dock mode where the dot is never shown. This version does no work
 * unless the chat is in the center AND hidden AND not already flagged: it then
 * subscribes to the store (no render) and flips `unread` once, on a real
 * transition. The subscription drops the instant the dot is up or the tab is
 * shown. The seen-baseline resets on agent switch (B10: a switch must not carry
 * a stale dot), on the tab becoming visible, and on leaving center mode.
 */
function useAggregateChatUnread(chatInCenter: boolean, chatVisible: boolean, agentFilePath: string | null): boolean {
  const [unread, setUnread] = useState(false)
  const seen = useRef(0)

  // Baseline reset — clears any stale dot and re-anchors "seen" to now.
  useEffect(() => {
    seen.current = selectAggregateLogVersion(useAgentStore.getState())
    setUnread(false)
  }, [agentFilePath, chatVisible, chatInCenter])

  // Watch for a real transition, but only while the dot could actually appear.
  useEffect(() => {
    if (!chatInCenter || chatVisible || unread) return
    return useAgentStore.subscribe((s) => {
      if (selectAggregateLogVersion(s) !== seen.current) setUnread(true)
    })
  }, [chatInCenter, chatVisible, unread])

  return unread
}

export function EditorPanel() {
  const tabs = useEditorTabsStore((s) => s.tabs)
  const activeTabPath = useEditorTabsStore((s) => s.activeTabPath)
  const setActiveTab = useEditorTabsStore((s) => s.setActiveTab)
  const closeTab = useEditorTabsStore((s) => s.closeTab)
  const updateTabContent = useEditorTabsStore((s) => s.updateTabContent)
  const markTabSaved = useEditorTabsStore((s) => s.markTabSaved)
  const reloadBrowserTab = useEditorTabsStore((s) => s.reloadBrowserTab)

  // Chat-in-center: the Loops panel becomes a pinned first stage tab, peer to
  // the documents and the browser. Same AgentLoop component the dock mounts —
  // all its state is in stores, so the move is purely a change of mount point.
  const chatInCenter = useAppStore(selectChatInCenter)
  const centerChatTabActive = useAppStore((s: AppState) => s.centerChatTabActive)
  const setCenterChatTabActive = useAppStore((s: AppState) => s.setCenterChatTabActive)
  const agentFilePath = useDocumentStore((s) => s.filePath)
  const showChat = chatInCenter && centerChatTabActive
  const chatUnread = useAggregateChatUnread(chatInCenter, showChat, agentFilePath)

  const selectFileTab = useCallback((path: string) => {
    setCenterChatTabActive(false)
    setActiveTab(path)
  }, [setActiveTab, setCenterChatTabActive])

  // Closing the chat tab is not a destroy — the chat has exactly two homes, so
  // the X means "send it back to the dock". setChatPlacement('side') runs the
  // same reveal the header affordance does, so the chat is never left nowhere.
  const setChatPlacement = useAppStore((s: AppState) => s.setChatPlacement)
  const chatTab = chatInCenter
    ? {
        active: centerChatTabActive,
        unread: chatUnread,
        onSelect: () => setCenterChatTabActive(true),
        onClose: () => setChatPlacement('side')
      }
    : undefined

  // A file opened from anywhere else — the sidebar, the Files panel, the agent's
  // browser — has to take the stage, or the click looks like it did nothing.
  // Two exemptions: an agent switch (restoring the incoming agent's tabs is not
  // the user asking for a file) and a close (activeTabPath moving because a tab
  // went away must not yank the user off the chat).
  useEffect(() => {
    return useEditorTabsStore.subscribe((state, prev) => {
      if (
        state.activeTabPath &&
        state.activeTabPath !== prev.activeTabPath &&
        state.tabs.length >= prev.tabs.length &&
        !isAgentSwitching()
      ) {
        useAppStore.getState().setCenterChatTabActive(false)
      }
    })
  }, [])

  const activeTab = tabs.find((t) => t.path === activeTabPath) ?? null
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // `owner` is the agent this text belongs to. writeInternalFile has no agent
  // argument — it lands in whatever workspace main has open when it arrives —
  // so a save that outlives its agent has to be dropped, not delivered.
  const pendingSaveRef = useRef<{ path: string; content: string; owner: string | null } | null>(null)

  const [lineWrap, setLineWrap] = useState(() => localStorage.getItem(LINE_WRAP_STORAGE_KEY) !== '0')
  const toggleLineWrap = useCallback(() => {
    setLineWrap((prev) => {
      localStorage.setItem(LINE_WRAP_STORAGE_KEY, prev ? '0' : '1')
      return !prev
    })
  }, [])

  const cancelPendingSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = null
    pendingSaveRef.current = null
  }, [])

  // Debounced auto-save
  const scheduleSave = useCallback((path: string, content: string) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    // Mid-switch the workspace under us is already (or about to be) the next
    // agent's, and nothing here can reach the outgoing one — the edit is dropped
    // rather than written into a file it doesn't belong to.
    if (isAgentSwitching()) {
      pendingSaveRef.current = null
      saveTimerRef.current = null
      return
    }
    const owner = useDocumentStore.getState().filePath
    pendingSaveRef.current = { path, content, owner }
    saveTimerRef.current = setTimeout(() => {
      pendingSaveRef.current = null
      saveTimerRef.current = null
      performSave(path, content, owner)
    }, 300)
  }, [])

  // README.md is the only file with a dedicated store/IPC pair — it backs the
  // document store the rest of the UI reads. Every other workspace file,
  // mind.md and soul.md included, round-trips through the generic
  // internal-file path and stays in sync via `file_updated`.
  const performSave = useCallback((path: string, content: string, owner: string | null) => {
    // The agent moved on between scheduling and delivery. Writing now would put
    // one agent's text into another agent's file.
    if (owner !== useDocumentStore.getState().filePath || isAgentSwitching()) return
    if (path === 'README.md') {
      window.adfApi?.setDocument(content)
    } else {
      window.adfApi?.writeInternalFile(path, content)
    }
    markTabSaved(path)
  }, [markTabSaved])

  // Handle content changes from editors
  const handleChange = useCallback((path: string, content: string) => {
    // An editor teardown flush can land after the tab set was swapped for the
    // incoming agent. That text belongs to the outgoing agent and there is
    // nowhere left to put it: the store no longer holds its tab and the write
    // path can't address its workspace. Dropping the edit is the only option
    // that doesn't corrupt the other agent's file.
    if (isAgentSwitching()) return

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

  // Open the core set from the empty state. README's content is already in
  // the document store; the rest is read on demand and skipped if the agent
  // doesn't have it. README opens last in focus order regardless, since openTab
  // focuses whatever it opened most recently.
  const restoreCoreFiles = useCallback(async () => {
    const tabStore = useEditorTabsStore.getState()
    for (const path of DEFAULT_OPEN_TABS) {
      if (path === 'README.md') {
        tabStore.openTab('README.md', useDocumentStore.getState().documentContent, false)
        continue
      }
      try {
        const file = await window.adfApi?.readInternalFile(path)
        if (file?.content != null) {
          tabStore.openTab(path, file.binary ? '' : file.content, file.binary)
        }
      } catch { /* file gone — skip it */ }
    }
    tabStore.setActiveTab('README.md')
  }, [])

  // An agent write to a file we have a save queued for supersedes that save: the
  // tab (and the editor) already show the agent's text, so delivering our older
  // copy would silently revert it and leave the two out of sync.
  useEffect(() => {
    return useEditorTabsStore.subscribe((state, prev) => {
      const mark = state.lastExternalWrite
      if (!mark || mark === prev.lastExternalWrite) return
      if (pendingSaveRef.current?.path === mark.path) cancelPendingSave()
    })
  }, [cancelPendingSave])

  // Flush pending saves on unmount. Editors flush their own debounce as they tear
  // down, which lands here — writing it out is the last chance before the timer dies.
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      const pending = pendingSaveRef.current
      pendingSaveRef.current = null
      if (pending) performSave(pending.path, pending.content, pending.owner)
    }
  }, [performSave])

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

  // Chat tab selected — the stage shows the Loops panel instead of an editor.
  // Keyed by agent only (B5): a width toggle must NOT remount, or it would
  // discard the active loop tab, staged attachments, and expansion state and
  // refetch history. Width now reflows live (LoopStream reads
  // selectChatColumnCapped and re-measures the virtualiser itself); the mount
  // resets only when the agent changes.
  if (showChat) {
    return (
      <div className="h-full flex flex-col">
        <TabBar
          // The chat holds the stage, so no file tab may also look selected —
          // the editor's own activeTabPath is untouched and comes back on exit.
          tabs={tabs}
          activeTabPath={null}
          onSelect={selectFileTab}
          onClose={closeTab}
          onReload={reloadBrowserTab}
          chatTab={chatTab}
        />
        <div className="flex-1 min-h-0">
          <AgentLoop key={`center:${agentFilePath ?? ''}`} />
        </div>
      </div>
    )
  }

  // Empty state. Closing every tab persists an empty set and is respected on
  // the next open (see loadFileContents), so this is a state the user can stay
  // in — it needs a way back that doesn't require finding the Files tab.
  if (!activeTab) {
    return (
      <div className="h-full flex flex-col">
        <TabBar tabs={tabs} activeTabPath={activeTabPath} onSelect={selectFileTab} onClose={closeTab} chatTab={chatTab} />
        <div className="flex-1 flex flex-col items-center justify-center gap-3">
          <span className="text-neutral-400 dark:text-neutral-500 text-sm">No file open</span>
          <button
            onClick={restoreCoreFiles}
            className="px-3 py-1.5 text-xs font-medium rounded-md border border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            Open core files
          </button>
        </div>
      </div>
    )
  }

  const isMarkdown = MD_EXTENSIONS.has(activeTab.extension)
  // Text files only — one overlay here covers every editor mode (rich, source, code).
  const showTokens = activeTab.kind === 'file' && !activeTab.isBinary

  return (
    <div className="h-full flex flex-col">
      <TabBar tabs={tabs} activeTabPath={activeTabPath} onSelect={selectFileTab} onClose={closeTab} onReload={reloadBrowserTab} chatTab={chatTab} />
      <div className="flex-1 overflow-hidden relative">
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
        {showTokens && (
          <div
            aria-label={`${activeTab.content.length.toLocaleString()} characters — token count is an estimate`}
            // Decoration only: it sits over CodeMirror's horizontal scrollbar, so
            // it must never swallow a drag on it.
            className="pointer-events-none absolute bottom-1.5 right-4 z-10 select-none px-1.5 py-0.5 rounded text-[10px] font-mono bg-white/80 dark:bg-neutral-800/80 border border-neutral-200 dark:border-neutral-700 text-neutral-400 dark:text-neutral-500"
          >
            ~{formatTokenCount(estimateTokens(activeTab.content))} tokens
          </div>
        )}
      </div>
    </div>
  )
}
