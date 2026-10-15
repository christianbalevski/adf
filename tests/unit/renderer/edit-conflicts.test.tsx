import { beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { useEditorTabsStore } from '../../../src/renderer/stores/editor-tabs.store'
import { useDocumentStore } from '../../../src/renderer/stores/document.store'
import { createAgentEventHandler } from '../../../src/renderer/hooks/useAgent'
import { classifyConfigSave, classifySave, conflictMessage, saveTabContent, type SaveAnswer } from '../../../src/renderer/utils/edit-conflict'
import { ChangedElsewhereNotice } from '../../../src/renderer/components/editor/ChangedElsewhereNotice'
import type { AgentExecutionEvent } from '../../../src/shared/types/ipc.types'

/**
 * W3-F in the renderer, the same in both backends (Studio main answers the
 * same shapes, and both deliver the same file_updated / document_updated):
 *
 * - a change from elsewhere over unsaved text keeps the text and raises the
 *   "changed elsewhere" notice naming the writer; a clean tab updates;
 * - a save goes over the tab's revision; a refusal keeps the text and raises
 *   the notice; a refusal over unchanged text saves again without asking;
 * - Reload takes their text, Keep mine saves over their revision.
 *
 * No jsdom here: the notice renders to static markup.
 */

// Vitest compiles JSX with the classic runtime (the renderer build uses the automatic one).
;(globalThis as { React?: typeof React }).React = React

const s = () => useEditorTabsStore.getState()
const tab = (path: string) => s().tabs.find((t) => t.path === path)!
const agentEvent = (type: string, payload: Record<string, unknown>): AgentExecutionEvent => ({ type, payload, timestamp: 1 } as AgentExecutionEvent)

beforeEach(() => {
  s().reset()
  useDocumentStore.getState().reset()
})

describe('an external write reaching an open tab', () => {
  it('a clean tab takes the new text and its revision, as before', () => {
    s().openTab('notes.md', 'mine', false, undefined, 100)
    createAgentEventHandler()(agentEvent('file_updated', { path: 'notes.md', content: 'theirs', revision: 101, writer: { kind: 'agent' } }))
    expect(tab('notes.md')).toMatchObject({ content: 'theirs', savedContent: 'theirs', isDirty: false, revision: 101 })
    expect(tab('notes.md').conflict).toBeUndefined()
  })

  it('an agent write over unsaved text keeps the text and shows the notice naming the agent', () => {
    s().openTab('notes.md', 'base', false, undefined, 100)
    s().updateTabContent('notes.md', 'base + my edit')
    createAgentEventHandler()(agentEvent('file_updated', { path: 'notes.md', content: 'agent text', revision: 101, writer: { kind: 'agent' } }))
    expect(tab('notes.md')).toMatchObject({ content: 'base + my edit', isDirty: true, revision: 100 })
    expect(tab('notes.md').conflict).toEqual({ content: 'agent text', revision: 101, writer: { kind: 'agent' } })
    // The save layer is told, so it drops its queued write of the older text.
    expect(s().lastExternalWrite?.path).toBe('notes.md')

    const html = renderToStaticMarkup(<ChangedElsewhereNotice what="notes.md" writer={tab('notes.md').conflict!.writer} onReload={() => {}} onKeep={() => {}} />)
    expect(html).toContain('notes.md was changed by the agent while you were editing.')
    expect(html).toContain('>Reload<')
    expect(html).toContain('>Keep mine<')
  })

  it('the README tab: document_updated over unsaved text keeps it and names the writer (through the document store)', () => {
    // EditorPanel's document-store subscription, as mounted.
    const unsub = useDocumentStore.subscribe((state, prev) => {
      if (state.documentContent === prev.documentContent) return
      const docTab = s().tabs.find((t) => t.path === 'README.md')
      if (docTab && docTab.content !== state.documentContent) {
        const meta = state.documentRevision !== prev.documentRevision ? { revision: state.documentRevision, writer: state.documentWriter } : undefined
        s().updateTabFromExternal('README.md', state.documentContent, meta)
      }
    })
    try {
      s().openTab('README.md', '# doc', false, undefined, 200)
      s().updateTabContent('README.md', '# doc, edited')
      useDocumentStore.getState().setDocumentContent('# doc, edited')
      createAgentEventHandler()(agentEvent('document_updated', { content: '# agent doc', revision: 201, writer: { kind: 'client', client: 'tui' } }))
      expect(tab('README.md')).toMatchObject({ content: '# doc, edited', isDirty: true })
      expect(tab('README.md').conflict).toEqual({ content: '# agent doc', revision: 201, writer: { kind: 'client', client: 'tui' } })
      expect(conflictMessage('README.md', tab('README.md').conflict!.writer)).toBe('README.md was changed by the terminal app while you were editing.')
    } finally {
      unsub()
    }
  })
})

describe('saving over a revision', () => {
  it('a save sends the tab\'s revision and keeps the one it produced', async () => {
    s().openTab('notes.md', 'a', false, undefined, 100)
    s().updateTabContent('notes.md', 'b')
    const write = vi.fn(async (_text: string, _base: number | undefined): Promise<SaveAnswer> => ({ success: true, revision: 101 }))
    expect(await saveTabContent('notes.md', 'b', write)).toEqual({ kind: 'saved', revision: 101 })
    expect(write).toHaveBeenCalledWith('b', 100)
    expect(tab('notes.md')).toMatchObject({ savedContent: 'b', isDirty: false, revision: 101 })
  })

  it('refused because another session saved: the text stays, the notice offers Reload and Keep mine', async () => {
    s().openTab('notes.md', 'a', false, undefined, 100)
    s().updateTabContent('notes.md', 'mine')
    const answers: SaveAnswer[] = [
      { success: false, conflict: { resource: 'notes.md', revision: 105, writer: { kind: 'client', client: 'studio' }, content: 'theirs' } },
      { success: true, revision: 106 },
    ]
    const write = vi.fn(async () => answers.shift())
    const outcome = await saveTabContent('notes.md', 'mine', write)
    expect(outcome.kind).toBe('conflict')
    expect(tab('notes.md')).toMatchObject({ content: 'mine', savedContent: 'theirs', isDirty: true })
    expect(tab('notes.md').conflict).toEqual({ content: 'theirs', revision: 105, writer: { kind: 'client', client: 'studio' } })
    expect(conflictMessage('notes.md', tab('notes.md').conflict!.writer)).toBe('notes.md was changed by another Studio window while you were editing.')

    // Keep mine: based on their revision now, saved over it.
    s().resolveTabConflict('notes.md', 'keep')
    expect(tab('notes.md')).toMatchObject({ content: 'mine', isDirty: true, revision: 105 })
    expect(await saveTabContent('notes.md', 'mine', write)).toEqual({ kind: 'saved', revision: 106 })
    expect(write).toHaveBeenLastCalledWith('mine', 105)
    expect(tab('notes.md')).toMatchObject({ content: 'mine', isDirty: false, revision: 106 })
  })

  it('Reload takes their text and revision; nothing is written', async () => {
    s().openTab('notes.md', 'a', false, undefined, 100)
    s().updateTabContent('notes.md', 'mine')
    await saveTabContent('notes.md', 'mine', async () => ({ success: false, conflict: { resource: 'notes.md', revision: 105, writer: { kind: 'agent' }, content: 'theirs' } }))
    s().resolveTabConflict('notes.md', 'reload')
    expect(tab('notes.md')).toMatchObject({ content: 'theirs', savedContent: 'theirs', isDirty: false, revision: 105 })
    expect(tab('notes.md').conflict).toBeUndefined()
  })

  it('a refusal whose text is still what the edit started from saves again over the new revision, without asking', async () => {
    s().openTab('notes.md', 'a', false, undefined, 100) // e.g. the daemon restarted since the read
    s().updateTabContent('notes.md', 'mine')
    const write = vi.fn(async (_text: string, base: number | undefined): Promise<SaveAnswer> => base === 100
      ? { success: false, conflict: { resource: 'notes.md', revision: 900, writer: null, content: 'a' } }
      : { success: true, revision: 901 })
    expect(await saveTabContent('notes.md', 'mine', write)).toEqual({ kind: 'saved', revision: 901 })
    expect(write.mock.calls.map((c) => c[1])).toEqual([100, 900])
    expect(tab('notes.md').conflict).toBeUndefined()
  })

  it('a save racing an external write that already replaced the clean tab brings the user\'s text back with the notice', async () => {
    s().openTab('notes.md', 'a', false, undefined, 100)
    s().updateTabContent('notes.md', 'mine')
    let resolve!: (a: SaveAnswer) => void
    const pending = saveTabContent('notes.md', 'mine', () => new Promise((r) => { resolve = r }))
    // In flight the tab is still dirty: the agent's write arrives as a conflict, not a replacement.
    s().updateTabFromExternal('notes.md', 'agent', { revision: 101, writer: { kind: 'agent' } })
    resolve({ success: false, conflict: { resource: 'notes.md', revision: 101, writer: { kind: 'agent' }, content: 'agent' } })
    await pending
    expect(tab('notes.md')).toMatchObject({ content: 'mine', isDirty: true })
    expect(tab('notes.md').conflict?.content).toBe('agent')
  })

  it('without a revision (an older read) the save sends none: last write wins, as before', async () => {
    s().openTab('notes.md', 'a', false)
    const write = vi.fn(async (): Promise<SaveAnswer> => ({ success: true }))
    await saveTabContent('notes.md', 'b', write)
    expect(write).toHaveBeenCalledWith('b', undefined)
  })
})

describe('classifying answers', () => {
  it('text saves', () => {
    expect(classifySave({ success: true, revision: 3 }, 'base', 'mine')).toEqual({ kind: 'saved', revision: 3 })
    expect(classifySave(undefined, 'base', 'mine')).toEqual({ kind: 'saved', revision: undefined })
    const conflict = (content: string | null) => ({ success: false, conflict: { resource: 'x', revision: 9, writer: null, content } })
    expect(classifySave(conflict('mine'), 'base', 'mine')).toEqual({ kind: 'saved', revision: 9 })
    expect(classifySave(conflict('base'), 'base', 'mine')).toEqual({ kind: 'retry', baseRevision: 9 })
    expect(classifySave(conflict('theirs'), 'base', 'mine').kind).toBe('conflict')
    expect(classifySave(conflict(null), 'base', 'mine').kind).toBe('conflict')
  })

  it('config saves compare configs regardless of key order and of the stamped updated_at', () => {
    const base = { name: 'agent-1', description: 'a', metadata: { created_at: 'c', updated_at: 'u1' } }
    const mine = { ...base, description: 'mine' }
    const answer = (config: unknown) => ({ success: false, conflict: { resource: 'config', revision: 7, writer: { kind: 'agent' as const }, config } })
    expect(classifyConfigSave(answer({ metadata: { updated_at: 'u2', created_at: 'c' }, description: 'a', name: 'agent-1' }), base, mine)).toEqual({ kind: 'retry', baseRevision: 7 })
    expect(classifyConfigSave(answer({ ...mine, metadata: { ...mine.metadata, updated_at: 'u3' } }), base, mine)).toEqual({ kind: 'saved', revision: 7 })
    expect(classifyConfigSave(answer({ ...base, description: 'theirs' }), base, mine)).toEqual({ kind: 'conflict', conflict: { theirs: { ...base, description: 'theirs' }, revision: 7, writer: { kind: 'agent' } } })
    expect(classifyConfigSave(answer({ ...base }), null, mine).kind).toBe('conflict')
  })
})
