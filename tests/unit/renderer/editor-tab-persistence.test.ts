import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useEditorTabsStore } from '../../../src/renderer/stores/editor-tabs.store'
import type { AgentConfig } from '../../../src/shared/types/adf-v02.types'
import {
  saveTabState,
  restoredComputerTab,
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
    saveTabState(currentFilePath, state)
  })
}

/**
 * The loadFileContents switch flow, verbatim (minus IPC): filePath flips
 * first, then the README content-sync fires into the tab store (EditorPanel's
 * document-store subscription) while the OLD agent's tabs are still present —
 * this is the mutation that used to clobber the new agent's saved list.
 */
function switchToAgent(filePath: string, doc: string, readInternalFile: (p: string) => string | null, config: AgentConfig | null = null): void {
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
    const computerTab = `browser://${filePath}`
    for (const path of saved?.paths ?? []) {
      if (path.startsWith('browser://')) {
        const meta = restoredComputerTab(filePath, config)
        if (meta) {
          tabStore.openBrowserTab(meta)
          restoredAny = true
        }
      } else if (path === 'README.md') {
        tabStore.openTab('README.md', doc, false)
        restoredAny = true
      } else {
        const content = readInternalFile(path)
        if (content != null) {
          tabStore.openTab(path, content, false)
          restoredAny = true
        }
      }
    }
    if (!restoredAny) {
      tabStore.openTab('README.md', doc, false)
    } else {
      const active = saved?.active?.startsWith('browser://') ? computerTab : saved?.active
      if (active && useEditorTabsStore.getState().tabs.some((t) => t.path === active)) tabStore.setActiveTab(active)
    }

    resumeTabPersistence()
    saveTabState(filePath, useEditorTabsStore.getState())
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

  it('brings the Computer tab back, focused, even when saved under an older path', () => {
    const computer = { id: 'agent-a', name: 'a', compute: { enabled: true } } as AgentConfig
    const unsub = attachPersistenceSubscriber()
    try {
      switchToAgent('/agents/a.adf', 'doc A', () => null, computer)
      // Opened before a rename: the tab keeps the old path.
      useEditorTabsStore.getState().openBrowserTab({ agentFilePath: '/agents/old.adf', containerName: 'c', agentId: 'agent-a', agentName: 'a', hostPort: 5900 })
      expect(loadOpenTabs('/agents/a.adf')).toEqual({ paths: ['README.md', 'browser:///agents/old.adf'], active: 'browser:///agents/old.adf' })

      switchToAgent('/agents/b.adf', 'doc B', () => null)
      switchToAgent('/agents/a.adf', 'doc A', () => null, computer)
      const state = useEditorTabsStore.getState()
      expect(state.tabs.map((t) => t.path)).toEqual(['README.md', 'browser:///agents/a.adf'])
      expect(state.activeTabPath).toBe('browser:///agents/a.adf')
      // Identity only: the viewer asks the container for its port.
      expect(state.tabs[1].browserMeta).toMatchObject({ agentId: 'agent-a', hostPort: null, phase: 'ready' })
    } finally {
      unsub()
    }
  })

  it('drops the Computer tab when the agent no longer has a desktop', () => {
    expect(restoredComputerTab('/agents/a.adf', { id: 'x', name: 'a', compute: { enabled: true, browser: false } } as AgentConfig)).toBeNull()
    expect(restoredComputerTab('/agents/a.adf', { id: 'x', name: 'a' } as AgentConfig)).toBeNull()
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
