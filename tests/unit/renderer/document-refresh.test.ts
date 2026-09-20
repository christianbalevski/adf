import { describe, it, expect } from 'vitest'
import {
  shouldRefreshDocument,
  deriveToolTargetPaths,
  normalizeVfsPath
} from '../../../src/shared/utils/document-target'

/**
 * The chat panel used to re-read the whole document over IPC after EVERY
 * `fs_write` result, because the result event carried only name/id/result — it
 * could not tell a write to `notes/scratch.md` from a write to the document the
 * user is looking at. Main now derives the write's target path(s) and hands
 * over the agent's document path with them.
 *
 * The narrowing is only safe because the fallback is unchanged: when the target
 * cannot be known — shell redirection, `sys_code`/`sys_lambda` writes, an
 * unknown tool shape — the refresh still happens. A stale document on screen is
 * a correctness bug; an extra read is only a cost. Every case below is written
 * from that asymmetry.
 */

describe('deriveToolTargetPaths', () => {
  it('reads the target of fs_write and fs_delete', () => {
    expect(deriveToolTargetPaths('fs_write', { mode: 'write', path: 'notes.md', content: 'x' })).toEqual(['notes.md'])
    expect(deriveToolTargetPaths('fs_delete', { path: 'old/thing.md' })).toEqual(['old/thing.md'])
  })

  it('never carries the write content — paths only', () => {
    const targets = deriveToolTargetPaths('fs_write', { path: 'a.md', content: 'x'.repeat(100_000) })
    expect(JSON.stringify(targets).length).toBeLessThan(50)
  })

  it('uses fs_transfer save_as when given, and the source path otherwise', () => {
    expect(deriveToolTargetPaths('fs_transfer', { from: 'host', to: 'vfs', path: 'a.md', save_as: 'b.md' })).toEqual(['b.md'])
    expect(deriveToolTargetPaths('fs_transfer', { from: 'host', to: 'vfs', path: 'a.md' })).toEqual(['a.md'])
  })

  it('reports "touches nothing" for a transfer OUT of the VFS', () => {
    expect(deriveToolTargetPaths('fs_transfer', { from: 'vfs', to: 'isolated', path: 'a.md' })).toEqual([])
  })

  it('returns undefined — "I do not know" — for everything that can write opaquely', () => {
    expect(deriveToolTargetPaths('adf_shell', { command: 'echo hi > README.md' })).toBeUndefined()
    expect(deriveToolTargetPaths('sys_code', { source: 'fs.write(...)' })).toBeUndefined()
    expect(deriveToolTargetPaths('sys_lambda', { source: 'lib.js:run' })).toBeUndefined()
    expect(deriveToolTargetPaths('mcp_something_write', { file: 'README.md' })).toBeUndefined()
  })

  it('returns undefined for a malformed or missing path', () => {
    expect(deriveToolTargetPaths('fs_write', { content: 'x' })).toBeUndefined()
    expect(deriveToolTargetPaths('fs_write', { path: '   ' })).toBeUndefined()
    expect(deriveToolTargetPaths('fs_write', { path: 42 })).toBeUndefined()
    expect(deriveToolTargetPaths('fs_write', undefined)).toBeUndefined()
  })
})

describe('normalizeVfsPath', () => {
  it('folds the spellings that mean the same file', () => {
    expect(normalizeVfsPath('./README.md')).toBe('readme.md')
    expect(normalizeVfsPath('docs\\spec.md')).toBe('docs/spec.md')
    expect(normalizeVfsPath('/notes.md')).toBe('notes.md')
    expect(normalizeVfsPath('  Notes.MD  ')).toBe('notes.md')
  })
})

describe('shouldRefreshDocument', () => {
  it('refreshes on a match', () => {
    expect(shouldRefreshDocument({ name: 'fs_write', targetPaths: ['README.md'], documentPath: 'README.md' })).toBe(true)
  })

  it('does not refresh when the write went somewhere else', () => {
    expect(shouldRefreshDocument({ name: 'fs_write', targetPaths: ['notes/scratch.md'], documentPath: 'README.md' })).toBe(false)
    expect(shouldRefreshDocument({ name: 'fs_write', targetPaths: ['mind.md'], documentPath: 'README.md' })).toBe(false)
  })

  it('matches a CUSTOM document path — the case only this refresh covers', () => {
    // `document_updated` fires only for README.md/document.md, and
    // `file_updated` refreshes open editor tabs, not the document store. An
    // agent whose document is `spec.md` depends entirely on this decision.
    expect(shouldRefreshDocument({ name: 'fs_write', targetPaths: ['spec.md'], documentPath: 'spec.md' })).toBe(true)
    expect(shouldRefreshDocument({ name: 'fs_write', targetPaths: ['README.md'], documentPath: 'spec.md' })).toBe(false)
  })

  it('treats README.md and document.md as the same document', () => {
    expect(shouldRefreshDocument({ name: 'fs_write', targetPaths: ['document.md'], documentPath: 'README.md' })).toBe(true)
    expect(shouldRefreshDocument({ name: 'fs_write', targetPaths: ['README.md'], documentPath: 'document.md' })).toBe(true)
    // …but not as an alias for a custom document.
    expect(shouldRefreshDocument({ name: 'fs_write', targetPaths: ['document.md'], documentPath: 'spec.md' })).toBe(false)
  })

  it('matches across path spellings', () => {
    expect(shouldRefreshDocument({ name: 'fs_write', targetPaths: ['./docs/Spec.md'], documentPath: 'docs/spec.md' })).toBe(true)
  })

  it('refreshes when ANY target of a multi-target call matches', () => {
    expect(shouldRefreshDocument({ name: 'fs_transfer', targetPaths: ['a.md', 'spec.md'], documentPath: 'spec.md' })).toBe(true)
  })

  it('refreshes when the target is undeterminable and the tool is fs_write', () => {
    expect(shouldRefreshDocument({ name: 'fs_write' })).toBe(true)
  })

  it('refreshes when the target is known but the document path is not', () => {
    expect(shouldRefreshDocument({ name: 'fs_write', targetPaths: ['anything.md'] })).toBe(true)
  })

  it('leaves non-write tools exactly as they were — no new refreshes', () => {
    expect(shouldRefreshDocument({ name: 'fs_read' })).toBe(false)
    expect(shouldRefreshDocument({ name: 'adf_shell' })).toBe(false)
    expect(shouldRefreshDocument({ name: 'sys_lambda' })).toBe(false)
  })

  it('does not refresh for a call that declared it touches nothing', () => {
    expect(shouldRefreshDocument({ name: 'fs_transfer', targetPaths: [], documentPath: 'README.md' })).toBe(false)
  })
})
