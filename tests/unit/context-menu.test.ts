import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: {}, Menu: {}, clipboard: {} }))

import { contextMenuTemplate, type ContextMenuActions, type ContextMenuInput } from '../../src/main/context-menu'

const allFlags = { canUndo: true, canRedo: true, canCut: true, canCopy: true, canPaste: true, canSelectAll: true, canDelete: true, canEditRichly: true }
const noFlags = { canUndo: false, canRedo: false, canCut: false, canCopy: false, canPaste: false, canSelectAll: false, canDelete: false, canEditRichly: false }

function input(over: Partial<ContextMenuInput> = {}): ContextMenuInput {
  return { isEditable: false, selectionText: '', misspelledWord: '', dictionarySuggestions: [], linkURL: '', editFlags: noFlags, ...over }
}

function actions(): ContextMenuActions & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    edit: (c) => calls.push(`edit:${c}`),
    replaceMisspelling: (w) => calls.push(`replace:${w}`),
    addToDictionary: (w) => calls.push(`add:${w}`),
    copyText: (t) => calls.push(`copy:${t}`)
  }
}

const labels = (t: ReturnType<typeof contextMenuTemplate>) => t.map((i) => i.type === 'separator' ? '—' : i.label)
const click = (t: ReturnType<typeof contextMenuTemplate>, label: string) =>
  (t.find((i) => i.label === label)?.click as () => void)()

describe('contextMenuTemplate', () => {
  it('shows nothing on plain, unselected, non-editable content', () => {
    expect(contextMenuTemplate(input(), actions())).toEqual([])
    expect(contextMenuTemplate(input({ selectionText: '  \n' }), actions())).toEqual([])
  })

  it('offers Copy for selected read-only text, sent to the clicked page', () => {
    const a = actions()
    const t = contextMenuTemplate(input({ selectionText: 'hello' }), a)
    expect(labels(t)).toEqual(['Copy'])
    click(t, 'Copy')
    expect(a.calls).toEqual(['edit:copy'])
  })

  it('gives editable fields the edit commands, enabled from editFlags', () => {
    const t = contextMenuTemplate(input({ isEditable: true, editFlags: { ...noFlags, canPaste: true, canSelectAll: true } }), actions())
    expect(labels(t)).toEqual(['Undo', 'Redo', '—', 'Cut', 'Copy', 'Paste', 'Select All'])
    expect(t.filter((i) => i.enabled).map((i) => i.label)).toEqual(['Paste', 'Select All'])
  })

  it('puts spelling suggestions first, with Add to Dictionary', () => {
    const a = actions()
    const t = contextMenuTemplate(input({
      isEditable: true,
      editFlags: allFlags,
      misspelledWord: 'teh',
      dictionarySuggestions: ['the', 'tech', 'ten']
    }), a)
    expect(labels(t).slice(0, 5)).toEqual(['the', 'tech', 'ten', 'Add to Dictionary', '—'])
    click(t, 'the')
    click(t, 'Add to Dictionary')
    expect(a.calls).toEqual(['replace:the', 'add:teh'])
  })

  it('says No Suggestions when the checker has none (or no dictionary is loaded)', () => {
    const t = contextMenuTemplate(input({ isEditable: true, editFlags: allFlags, misspelledWord: 'qzx' }), actions())
    expect(t[0]).toMatchObject({ label: 'No Suggestions', enabled: false })
    expect(t[1].label).toBe('Add to Dictionary')
  })

  it('adds Copy Link on links', () => {
    const a = actions()
    const t = contextMenuTemplate(input({ selectionText: 'docs', linkURL: 'https://example.com/a' }), a)
    expect(labels(t)).toEqual(['Copy', '—', 'Copy Link'])
    click(t, 'Copy Link')
    expect(a.calls).toEqual(['copy:https://example.com/a'])
  })
})
