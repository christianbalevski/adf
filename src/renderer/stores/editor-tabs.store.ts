import { create } from 'zustand'

export interface BrowserTabMeta {
  agentFilePath: string
  containerName: string
  /** Host loopback port serving the container's noVNC viewer. */
  hostPort: number
  /** Bumped by reloadBrowserTab — the viewer reloads when it changes. */
  reloadNonce?: number
}

export interface EditorTab {
  path: string
  content: string
  savedContent: string
  isDirty: boolean
  isBinary: boolean
  extension: string
  kind: 'file' | 'browser'
  browserMeta?: BrowserTabMeta
}

/** Identifies one external (agent) write so consumers can tell repeats apart. */
export interface ExternalWriteMark {
  path: string
  seq: number
}

interface EditorTabsState {
  tabs: EditorTab[]
  activeTabPath: string | null
  /**
   * Bumped by updateTabFromExternal. The save layer watches it to drop a queued
   * write the agent has already superseded — without this the editor shows the
   * agent's text while a stale debounce puts the pre-agent text back on disk.
   */
  lastExternalWrite: ExternalWriteMark | null

  openTab: (path: string, content: string, isBinary: boolean) => void
  /**
   * `activate: false` adds/refreshes the tab without taking the stage — used
   * by the auto-open on agent startup so it doesn't yank the user off the chat.
   */
  openBrowserTab: (meta: BrowserTabMeta, opts?: { activate?: boolean }) => void
  reloadBrowserTab: (path: string) => void
  closeTab: (path: string) => void
  setActiveTab: (path: string) => void
  updateTabContent: (path: string, content: string) => void
  markTabSaved: (path: string) => void
  updateTabFromExternal: (path: string, content: string) => void
  reset: () => void
}

function getExtension(path: string): string {
  const dot = path.lastIndexOf('.')
  return dot >= 0 ? path.slice(dot + 1).toLowerCase() : ''
}

let externalWriteSeq = 0

export const useEditorTabsStore = create<EditorTabsState>((set, get) => ({
  tabs: [],
  activeTabPath: null,
  lastExternalWrite: null,

  openTab: (path, content, isBinary) => {
    const { tabs } = get()
    const existing = tabs.find((t) => t.path === path)
    if (existing) {
      // Re-opening reloads from disk, but only over a clean tab — unsaved local
      // edits outrank whatever the caller read. Refreshing also lets the editor
      // re-evaluate the large-file gate, which it can't do without new content.
      if (!existing.isDirty && existing.content !== content) {
        set({
          tabs: tabs.map((t) => (t.path === path ? { ...t, content, savedContent: content, isBinary } : t)),
          activeTabPath: path
        })
        return
      }
      set({ activeTabPath: path })
      return
    }
    const tab: EditorTab = {
      path,
      content,
      savedContent: content,
      isDirty: false,
      isBinary,
      extension: getExtension(path),
      kind: 'file'
    }
    set({ tabs: [...tabs, tab], activeTabPath: path })
  },

  openBrowserTab: (meta, opts) => {
    const activate = opts?.activate ?? true
    const path = `browser://${meta.agentFilePath}`
    const { tabs, activeTabPath } = get()
    const existing = tabs.find((t) => t.path === path)
    if (existing) {
      // The port changes when the container is recreated — refresh in place.
      set({
        tabs: tabs.map((t) => (t.path === path ? { ...t, browserMeta: meta } : t)),
        activeTabPath: activate ? path : activeTabPath
      })
      return
    }
    const tab: EditorTab = {
      path,
      content: '',
      savedContent: '',
      isDirty: false,
      isBinary: false,
      extension: '',
      kind: 'browser',
      browserMeta: meta
    }
    set({ tabs: [...tabs, tab], activeTabPath: activate ? path : activeTabPath })
  },

  reloadBrowserTab: (path) => {
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.path === path && t.kind === 'browser' && t.browserMeta
          ? { ...t, browserMeta: { ...t.browserMeta, reloadNonce: (t.browserMeta.reloadNonce ?? 0) + 1 } }
          : t
      )
    }))
  },

  closeTab: (path) => {
    const { tabs, activeTabPath } = get()
    const idx = tabs.findIndex((t) => t.path === path)
    if (idx === -1) return
    const newTabs = tabs.filter((t) => t.path !== path)
    let newActive = activeTabPath
    if (activeTabPath === path) {
      if (newTabs.length === 0) {
        newActive = null
      } else if (idx < newTabs.length) {
        newActive = newTabs[idx].path
      } else {
        newActive = newTabs[newTabs.length - 1].path
      }
    }
    set({ tabs: newTabs, activeTabPath: newActive })
  },

  setActiveTab: (path) => {
    set({ activeTabPath: path })
  },

  updateTabContent: (path, content) => {
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.path === path
          ? { ...t, content, isDirty: content !== t.savedContent }
          : t
      )
    }))
  },

  markTabSaved: (path) => {
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.path === path
          ? { ...t, savedContent: t.content, isDirty: false }
          : t
      )
    }))
  },

  updateTabFromExternal: (path, content) => {
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.path === path
          ? { ...t, content, savedContent: content, isDirty: false }
          : t
      ),
      // Marked unconditionally: the save layer needs to know the file changed
      // underneath it even when no tab is currently showing it.
      lastExternalWrite: { path, seq: ++externalWriteSeq }
    }))
  },

  reset: () => {
    set({ tabs: [], activeTabPath: null, lastExternalWrite: null })
  }
}))

/**
 * Agent-switch window. DOC_WRITE_INTERNAL_FILE carries no agent identity — it
 * writes into whatever workspace the main process has open when it arrives — so
 * a save that fires while the workspace is being swapped lands in the wrong
 * agent's file. The switch is marked from before main swaps until the incoming
 * agent's tabs are loaded, and the save layer drops anything scheduled inside
 * it. Module state, not store state: nothing should re-render on this.
 *
 * A counter rather than a boolean because openFile brackets the whole switch
 * and loadFileContents, which it calls, brackets its own half.
 */
let agentSwitchDepth = 0

export function beginAgentSwitch(): void {
  agentSwitchDepth++
}

export function endAgentSwitch(): void {
  if (agentSwitchDepth > 0) agentSwitchDepth--
}

export function isAgentSwitching(): boolean {
  return agentSwitchDepth > 0
}
