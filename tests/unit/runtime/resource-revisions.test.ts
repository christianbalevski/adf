/**
 * W3-F resource revisions (src/main/runtime/resource-revisions.ts): one
 * revision per agent and resource, moved by any change of content, never
 * reused, and naming who made the change.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  configRevision,
  currentResourceWriter,
  documentRevision,
  fileRevision,
  observeRevision,
  parseBaseRevision,
  runAsWriter,
  staleRevision,
  staleRevisionMessage,
  type RevisionedWorkspace,
} from '../../../src/main/runtime/resource-revisions'

/** The workspace surface revisions read, in memory. */
function workspace(initial: Record<string, string> = { 'README.md': '# agent-1' }) {
  const files = new Map(Object.entries(initial))
  let config: Record<string, unknown> = { id: 'f0d6c1a2-5b3e-4c7d-8e9f-0a1b2c3d4e5f', name: 'agent-1' }
  const ws: RevisionedWorkspace & { files: Map<string, string>; setConfig(c: Record<string, unknown>): void } = {
    files,
    getAgentConfig: () => config,
    setConfig: (c) => { config = c },
    readDocument: () => files.get('README.md') ?? '',
    getDocumentPath: () => 'README.md',
    readFileBuffer: (path) => (files.has(path) ? Buffer.from(files.get(path)!, 'utf-8') : null),
  }
  return ws
}

afterEach(() => vi.useRealTimers())

describe('resource revisions', () => {
  it('keeps the revision while the content stays, and takes a higher one on any change', () => {
    const ws = workspace({ 'README.md': '# agent-1', 'notes.md': 'a' })
    const first = fileRevision(ws, 'notes.md')
    expect(fileRevision(ws, 'notes.md').revision).toBe(first.revision)
    expect(first.writer).toBeNull() // first sight: nobody is known to have written it

    // A write nobody announced (shell redirection, sys_code) is seen at the next look, as the agent's.
    ws.files.set('notes.md', 'b')
    const second = fileRevision(ws, 'notes.md')
    expect(second.revision).toBeGreaterThan(first.revision)
    expect(second.writer).toEqual({ kind: 'agent' })

    // Back to the first content: a new revision, never the old one (no ABA reuse).
    ws.files.set('notes.md', 'a')
    expect(fileRevision(ws, 'notes.md').revision).toBeGreaterThan(second.revision)
  })

  it('is per agent and per resource: config, the document and each file move on their own', () => {
    const one = workspace({ 'README.md': 'doc', 'a.md': 'a', 'b.md': 'b' })
    const two = workspace({ 'README.md': 'doc', 'a.md': 'a', 'b.md': 'b' })
    const before = { config: configRevision(one).revision, doc: documentRevision(one).revision, a: fileRevision(one, 'a.md').revision, b: fileRevision(one, 'b.md').revision, twoA: fileRevision(two, 'a.md').revision }
    one.files.set('a.md', 'a2')
    expect(fileRevision(one, 'a.md').revision).not.toBe(before.a)
    expect(fileRevision(one, 'b.md').revision).toBe(before.b)
    expect(documentRevision(one).revision).toBe(before.doc)
    expect(configRevision(one).revision).toBe(before.config)
    expect(fileRevision(two, 'a.md').revision).toBe(before.twoA)
    // The document is the file at its document path: one revision for both names.
    expect(fileRevision(one, 'README.md').revision).toBe(before.doc)
    one.setConfig({ id: 'f0d6c1a2-5b3e-4c7d-8e9f-0a1b2c3d4e5f', name: 'agent-1', description: 'changed' })
    expect(configRevision(one).revision).toBeGreaterThan(before.config)
  })

  it('a missing file has a revision too, so creating it can be conditional', () => {
    const ws = workspace()
    const absent = fileRevision(ws, 'new.md')
    expect(absent.hash).toBe('absent')
    ws.files.set('new.md', 'x')
    expect(fileRevision(ws, 'new.md').revision).toBeGreaterThan(absent.revision)
  })

  it('records the writer of a write made inside runAsWriter, and only there', () => {
    const ws = workspace({ 'README.md': 'doc', 'notes.md': 'a' })
    fileRevision(ws, 'notes.md')
    runAsWriter({ kind: 'client', client: 'tui' }, () => {
      ws.files.set('notes.md', 'from the tui')
      // The observation right after the write passes the writer of the write running now.
      expect(observeRevision(ws, 'file:notes.md', ws.readFileBuffer('notes.md'), currentResourceWriter()).writer).toEqual({ kind: 'client', client: 'tui' })
    })
    expect(fileRevision(ws, 'notes.md').writer).toEqual({ kind: 'client', client: 'tui' })
    expect(currentResourceWriter()).toEqual({ kind: 'agent' })
    ws.files.set('notes.md', 'from the agent')
    expect(fileRevision(ws, 'notes.md').writer).toEqual({ kind: 'agent' })
  })

  it('starts above the wall clock, so a restarted daemon never hands out an earlier run\'s revision', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-14T12:00:00Z'))
    const ws = workspace()
    const rev = documentRevision(ws).revision
    expect(rev).toBeGreaterThanOrEqual(Date.parse('2026-10-14T12:00:00Z') * 1000)
    expect(Number.isSafeInteger(rev)).toBe(true)
    // A clock that went back does not make revisions go back.
    vi.setSystemTime(new Date('2026-10-14T11:00:00Z'))
    ws.files.set('README.md', 'later')
    expect(documentRevision(ws).revision).toBeGreaterThan(rev)
  })

  it('parses a base revision from a number, a query string or an If-Match header', () => {
    expect(parseBaseRevision(undefined)).toBeUndefined()
    expect(parseBaseRevision('')).toBeUndefined()
    expect(parseBaseRevision(1792000000000001)).toBe(1792000000000001)
    expect(parseBaseRevision('1792000000000001')).toBe(1792000000000001)
    expect(parseBaseRevision('"1792000000000001"')).toBe(1792000000000001)
    expect(parseBaseRevision('W/"17"')).toBe(17)
    expect(parseBaseRevision('*')).toBeUndefined() // If-Match: * names any current version: no base
    expect(parseBaseRevision('abc')).toBeNull()
    expect(parseBaseRevision(-1)).toBeNull()
    expect(parseBaseRevision(1.5)).toBeNull()
    expect(parseBaseRevision({})).toBeNull()
  })

  it('a stale base is refused with the current revision, its writer, size and hash; no base never is', () => {
    const ws = workspace({ 'README.md': 'doc', 'notes.md': 'a' })
    const base = fileRevision(ws, 'notes.md').revision
    expect(staleRevision('notes.md', fileRevision(ws, 'notes.md'), base, 1)).toBeNull()
    expect(staleRevision('notes.md', fileRevision(ws, 'notes.md'), undefined, 1)).toBeNull()
    ws.files.set('notes.md', 'b')
    const current = fileRevision(ws, 'notes.md')
    const stale = staleRevision('notes.md', current, base, 1)
    expect(stale).toEqual({ resource: 'notes.md', revision: current.revision, baseRevision: base, writer: { kind: 'agent' }, size: 1, hash: current.hash })
    expect(staleRevisionMessage(stale!)).toBe(`"notes.md" changed by the agent since revision ${base} (now ${current.revision}). Reload it, or save again with baseRevision ${current.revision} to overwrite.`)
  })
})
