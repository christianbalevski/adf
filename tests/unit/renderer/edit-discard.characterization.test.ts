import { beforeEach, describe, expect, it } from 'vitest'
import { useEditorTabsStore } from '../../../src/renderer/stores/editor-tabs.store'

/**
 * Characterization (rule E3), both backends: what happens to unsaved text in
 * an editor tab when someone else changes the file.
 *
 * 1. Before W3-F (written late: the W3-F change, 4db10a14, landed first, so
 *    the old store is transcribed here from 84fb96a6): an external write
 *    replaced the tab's text and cleared its dirty flag, so the user's
 *    unsaved text was gone without a word.
 * 2. As of 4db10a14 (before the close / switch / quit guard): the text is
 *    kept and the tab carries a `conflict`, but closing the tab or switching
 *    agent (the store's reset) drops it without asking, and nothing survives
 *    a quit.
 */

const s = () => useEditorTabsStore.getState()

/** editor-tabs.store.ts updateTabFromExternal at 84fb96a6, verbatim apart from the store plumbing. */
function preW3fUpdateTabFromExternal(tabs: Array<{ path: string; content: string; savedContent: string; isDirty: boolean }>, path: string, content: string) {
  return tabs.map((t) => (t.path === path ? { ...t, content, savedContent: content, isDirty: false } : t))
}

beforeEach(() => s().reset())

describe('before W3-F', () => {
  it('an agent write over unsaved text replaced it: the text was lost, the tab clean', () => {
    const tabs = [{ path: 'notes.md', content: 'base + my edit', savedContent: 'base', isDirty: true }]
    expect(preW3fUpdateTabFromExternal(tabs, 'notes.md', 'agent text')).toEqual([
      { path: 'notes.md', content: 'agent text', savedContent: 'agent text', isDirty: false },
    ])
  })
})

describe('as of 4db10a14', () => {
  const conflicted = () => {
    s().openTab('notes.md', 'base', false, undefined, 1)
    s().updateTabContent('notes.md', 'base + my edit')
    s().updateTabFromExternal('notes.md', 'agent text', { revision: 2, writer: { kind: 'agent' } })
    expect(s().tabs[0].conflict).toBeDefined()
  }

  it('closing a conflicted tab drops the unsaved text without asking', () => {
    conflicted()
    s().closeTab('notes.md')
    expect(s().tabs).toEqual([])
  })

  it('an agent switch (the store reset) drops it too', () => {
    conflicted()
    s().reset()
    expect(s().tabs).toEqual([])
  })
})
