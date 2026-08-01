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

interface EditorTabsState {
  tabs: EditorTab[]
  activeTabPath: string | null

  openTab: (path: string, content: string, isBinary: boolean) => void
  openBrowserTab: (meta: BrowserTabMeta) => void
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

export const useEditorTabsStore = create<EditorTabsState>((set, get) => ({
  tabs: [],
  activeTabPath: null,

  openTab: (path, content, isBinary) => {
    const { tabs } = get()
    const existing = tabs.find((t) => t.path === path)
    if (existing) {
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

  openBrowserTab: (meta) => {
    const path = `browser://${meta.agentFilePath}`
    const { tabs } = get()
    const existing = tabs.find((t) => t.path === path)
    if (existing) {
      // The port changes when the container is recreated — refresh in place.
      set({
        tabs: tabs.map((t) => (t.path === path ? { ...t, browserMeta: meta } : t)),
        activeTabPath: path
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
    set({ tabs: [...tabs, tab], activeTabPath: path })
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
      )
    }))
  },

  reset: () => {
    set({ tabs: [], activeTabPath: null })
  }
}))
