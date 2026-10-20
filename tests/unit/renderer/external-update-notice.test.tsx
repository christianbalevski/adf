import { beforeEach, describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { useEditorTabsStore } from '../../../src/renderer/stores/editor-tabs.store'
import { ChangedElsewhereNotice, ExternalUpdateNotice, compareLines, foldUnchanged } from '../../../src/renderer/components/editor/ChangedElsewhereNotice'

/**
 * Someone else's change reaching an editor tab, made visible:
 * - a clean tab still takes their text, and now remembers what it showed so
 *   the "Updated by … · Undo" strip can put it back (as an unsaved edit);
 * - the "changed elsewhere" notice offers Compare when both texts are known.
 */

;(globalThis as { React?: typeof React }).React = React

const s = () => useEditorTabsStore.getState()
const tab = (path: string) => s().tabs.find((t) => t.path === path)!

beforeEach(() => { s().reset() })

describe('a clean tab replaced by someone else', () => {
  it('takes their text and records what it showed, and who wrote', () => {
    s().openTab('notes.md', 'mine', false, undefined, 100)
    s().updateTabFromExternal('notes.md', 'theirs', { revision: 101, writer: { kind: 'agent' } })
    expect(tab('notes.md')).toMatchObject({ content: 'theirs', isDirty: false, revision: 101 })
    expect(tab('notes.md').replaced).toMatchObject({ previous: 'mine', writer: { kind: 'agent' } })
  })

  it('the same text again is not a replacement', () => {
    s().openTab('notes.md', 'same', false, undefined, 100)
    s().updateTabFromExternal('notes.md', 'same', { revision: 101, writer: { kind: 'agent' } })
    expect(tab('notes.md').replaced).toBeUndefined()
  })

  it('Undo puts the previous text back as an unsaved edit over their revision', () => {
    s().openTab('notes.md', 'mine', false, undefined, 100)
    s().updateTabFromExternal('notes.md', 'theirs', { revision: 101, writer: { kind: 'agent' } })
    expect(s().undoExternalReplace('notes.md')).toBe('mine')
    expect(tab('notes.md')).toMatchObject({ content: 'mine', savedContent: 'theirs', isDirty: true, revision: 101 })
    expect(tab('notes.md').replaced).toBeUndefined()
    expect(s().undoExternalReplace('notes.md')).toBeNull()
  })

  it('typing ends the offer; dismiss clears it', () => {
    s().openTab('a.md', 'one', false, undefined, 1)
    s().updateTabFromExternal('a.md', 'two', { revision: 2, writer: null })
    s().updateTabContent('a.md', 'two!')
    expect(tab('a.md').replaced).toBeUndefined()

    s().openTab('b.md', 'one', false, undefined, 1)
    s().updateTabFromExternal('b.md', 'two', { revision: 2, writer: null })
    s().dismissExternalReplace('b.md')
    expect(tab('b.md').replaced).toBeUndefined()
  })

  it('unsaved text still gets the conflict notice, not a replacement', () => {
    s().openTab('notes.md', 'base', false, undefined, 100)
    s().updateTabContent('notes.md', 'base + edit')
    s().updateTabFromExternal('notes.md', 'theirs', { revision: 101, writer: { kind: 'agent' } })
    expect(tab('notes.md').conflict).toBeDefined()
    expect(tab('notes.md').replaced).toBeUndefined()
  })

  it('the strip names the writer and offers Undo', () => {
    const html = renderToStaticMarkup(
      <ExternalUpdateNotice writer={{ kind: 'agent' }} seq={1} onUndo={() => {}} onDismiss={() => {}} />
    )
    expect(html).toContain('Updated by the agent')
    expect(html).toContain('Undo')
  })
})

describe('Compare on the changed-elsewhere notice', () => {
  it('is offered only when both texts are known', () => {
    const base = { what: 'notes.md', writer: { kind: 'agent' as const }, onReload: () => {}, onKeep: () => {} }
    expect(renderToStaticMarkup(<ChangedElsewhereNotice {...base} mine="a" theirs="b" />)).toContain('Compare')
    expect(renderToStaticMarkup(<ChangedElsewhereNotice {...base} mine="a" theirs={null} />)).not.toContain('Compare')
    expect(renderToStaticMarkup(<ChangedElsewhereNotice {...base} />)).not.toContain('Compare')
  })

  it('diffs mine against theirs by line', () => {
    expect(compareLines('a\nmine\nc\n', 'a\ntheirs\nc\n')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'theirs', text: 'theirs' },
      { kind: 'mine', text: 'mine' },
      { kind: 'same', text: 'c' },
    ])
  })

  it('folds long unchanged runs, keeping three lines of context', () => {
    const theirs = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n')
    const mine = theirs.replace('l10', 'changed')
    const rows = foldUnchanged(compareLines(mine, theirs))
    const kinds = rows.map((r) => r.kind)
    expect(kinds[0]).toBe('fold')
    expect(rows.filter((r) => r.kind === 'fold')).toHaveLength(2)
    expect(rows.filter((r) => r.kind === 'same')).toHaveLength(6)
  })
})
