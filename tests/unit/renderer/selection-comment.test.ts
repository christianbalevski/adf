import { describe, it, expect } from 'vitest'
import { formatSelectionComment, selectionCommentHeader, withSelectionComments, type SelectionComment } from '../../../src/renderer/utils/selection-comment'
import { useDocumentStore } from '../../../src/renderer/stores/document.store'

const comment = (over: Partial<SelectionComment> = {}): SelectionComment => ({
  id: 'c1', path: 'notes.md', quote: 'the sky is green', comment: 'it is blue', ...over,
})

describe('selection comment text', () => {
  it('names the file, and the lines when the editor knows them', () => {
    expect(selectionCommentHeader({ path: 'notes.md' })).toBe('notes.md (rendered text, not file text)')
    expect(selectionCommentHeader({ path: 'src/a.ts', startLine: 3, endLine: 3 })).toBe('src/a.ts (line 3)')
    expect(selectionCommentHeader({ path: 'src/a.ts', startLine: 3, endLine: 7 })).toBe('src/a.ts (lines 3-7)')
  })

  it('quotes the selection in triple quotes, then the comment', () => {
    expect(formatSelectionComment(comment({ startLine: 12, endLine: 14 }))).toBe(
      'notes.md (lines 12-14)\n"""\nthe sky is green\n"""\ncomment: it is blue',
    )
  })

  it('leaves the comment line out when there is no comment', () => {
    expect(formatSelectionComment(comment({ startLine: 1, endLine: 1, comment: '  ' }))).toBe('notes.md (line 1)\n"""\nthe sky is green\n"""')
  })

  it('fences a quote that holds triple quotes with a longer run', () => {
    const quote = 'def f():\n    """Doc."""'
    expect(formatSelectionComment(comment({ path: 'a.py', startLine: 1, endLine: 2, quote, comment: '' }))).toBe(
      'a.py (lines 1-2)\n""""\n' + quote + '\n""""',
    )
  })

  it('puts every comment ahead of the typed message', () => {
    const two = [comment({ startLine: 2, endLine: 2 }), comment({ id: 'c2', path: 'b.md', startLine: 5, endLine: 5, quote: 'x', comment: '' })]
    expect(withSelectionComments(two, 'fix both')).toBe(
      'notes.md (line 2)\n"""\nthe sky is green\n"""\ncomment: it is blue\n\nb.md (line 5)\n"""\nx\n"""\n\nfix both',
    )
    expect(withSelectionComments([], 'just text')).toBe('just text')
    expect(withSelectionComments([comment({ startLine: 2, endLine: 2 })], '')).toBe('notes.md (line 2)\n"""\nthe sky is green\n"""\ncomment: it is blue')
  })
})

describe('waiting comments in the document store', () => {
  it('are kept per agent and cleared with the drafts on reset', () => {
    const docs = useDocumentStore.getState()
    docs.setDraftComments('a', [comment()])
    docs.setDraftComments('b', [comment({ id: 'c2' })])
    expect(Object.keys(useDocumentStore.getState().draftComments)).toEqual(['a', 'b'])
    docs.setDraftComments('a', [])
    expect(useDocumentStore.getState().draftComments).toEqual({ b: [comment({ id: 'c2' })] })
    docs.reset()
    expect(useDocumentStore.getState().draftComments).toEqual({})
  })
})
