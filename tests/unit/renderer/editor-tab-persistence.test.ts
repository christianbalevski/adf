import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useEditorTabsStore } from '../../../src/renderer/stores/editor-tabs.store'
import {
  saveOpenTabs,
  loadOpenTabs,
  suspendTabPersistence,
  resumeTabPersistence,
} from '../../../src/renderer/utils/editor-tab-persistence'

// localStorage stub (no jsdom in the node test environment)
const storage = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => { storage.set(k, v) },
  removeItem: (k: string) => { storage.delete(k) },
})

/** The EditorPanel persistence subscriber, verbatim. */
let currentFilePath: string | null = null
function attachPersistenceSubscriber(): () => void {
  return useEditorTabsStore.subscribe((state) => {
    if (!currentFilePath) return
    saveOpenTabs(
      currentFilePath,
      state.tabs.filter((t) => t.kind === 'file').map((t) => t.path),
      state.activeTabPath
    )
  })
}

/**
 * The loadFileContents switch flow, verbatim (minus IPC): filePath flips
 * first, then the README content-sync fires into the tab store (EditorPanel's
 * document-store subscription) while the OLD agent's tabs are still present —
 * this is the mutation that used to clobber the new agent's saved list.
 */
function switchToAgent(filePath: string, doc: string, readInternalFile: (p: string) => string | null): void {
  currentFilePath = filePath
  suspendTabPersistence()
  try {
    // EditorPanel's doc-sync: setDocumentContent → updateTabFromExternal
    const preTabs = useEditorTabsStore.getState()
    const docTab = preTabs.tabs.find((t) => t.path === 'README.md')
    if (docTab && docTab.content !== doc) {
      preTabs.updateTabFromExternal('README.md', doc)
    }

    const saved = loadOpenTabs(filePath)
    const tabStore = useEditorTabsStore.getState()
    tabStore.reset()
    let restoredAny = false
    for (const path of saved?.paths ?? []) {
      if (path === 'README.md') {
        tabStore.openTab('README.md', doc, false)
        restoredAny = true
      } else if (!path.startsWith('browser://')) {
        const content = readInternalFile(path)
        if (content != null) {
          tabStore.openTab(path, content, false)
          restoredAny = true
        }
      }
    }
    if (!restoredAny) {
      tabStore.openTab('README.md', doc, false)
    } else if (saved?.active && useEditorTabsStore.getState().tabs.some((t) => t.path === saved.active)) {
      tabStore.setActiveTab(saved.active)
    }

    resumeTabPersistence()
    const state = useEditorTabsStore.getState()
    saveOpenTabs(filePath, state.tabs.filter((t) => t.kind === 'file').map((t) => t.path), state.activeTabPath)
  } finally {
    resumeTabPersistence()
  }
}

describe('editor tab persistence across agent switches', () => {
  beforeEach(() => {
    storage.clear()
    currentFilePath = null
    suspendTabPersistence()
    useEditorTabsStore.getState().reset()
    resumeTabPersistence()
  })

  it('restores tabs after switching away and back (README sync does not clobber)', () => {
    const unsub = attachPersistenceSubscriber()
    try {
      switchToAgent('/agents/a.adf', 'doc A', () => null)
      useEditorTabsStore.getState().openTab('notes/foo.md', 'foo', false)
      expect(loadOpenTabs('/agents/a.adf')?.paths).toEqual(['README.md', 'notes/foo.md'])

      switchToAgent('/agents/b.adf', 'doc B', () => null)
      // B must not inherit A's tab list via the README content-sync clobber
      expect(loadOpenTabs('/agents/b.adf')?.paths).toEqual(['README.md'])
      expect(useEditorTabsStore.getState().tabs.map((t) => t.path)).toEqual(['README.md'])

      switchToAgent('/agents/a.adf', 'doc A', (p) => (p === 'notes/foo.md' ? 'foo' : null))
      expect(useEditorTabsStore.getState().tabs.map((t) => t.path)).toEqual(['README.md', 'notes/foo.md'])
      expect(useEditorTabsStore.getState().activeTabPath).toBe('notes/foo.md')
    } finally {
      unsub()
    }
  })

  it('drops deleted files but keeps the rest', () => {
    const unsub = attachPersistenceSubscriber()
    try {
      switchToAgent('/agents/a.adf', 'doc A', () => null)
      useEditorTabsStore.getState().openTab('gone.md', 'x', false)
      useEditorTabsStore.getState().openTab('kept.md', 'y', false)

      switchToAgent('/agents/b.adf', 'doc B', () => null)
      switchToAgent('/agents/a.adf', 'doc A', (p) => (p === 'kept.md' ? 'y' : null))
      expect(useEditorTabsStore.getState().tabs.map((t) => t.path)).toEqual(['README.md', 'kept.md'])
    } finally {
      unsub()
    }
  })

  it('falls back to README when nothing is saved', () => {
    const unsub = attachPersistenceSubscriber()
    try {
      switchToAgent('/agents/fresh.adf', 'doc', () => null)
      expect(useEditorTabsStore.getState().tabs.map((t) => t.path)).toEqual(['README.md'])
    } finally {
      unsub()
    }
  })
})
