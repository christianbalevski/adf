import { create } from 'zustand'

export interface EditorTab {
  path: string
  content: string
  savedContent: string
  isDirty: boolean
  isBinary: boolean
  extension: string
}

interface EditorTabsState {
  tabs: EditorTab[]
  activeTabPath: string | null

  openTab: (path: string, content: string, isBinary: boolean) => void
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
      extension: getExtension(path)
    }
    set({ tabs: [...tabs, tab], activeTabPath: path })
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
