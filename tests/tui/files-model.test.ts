import { describe, expect, it } from 'vitest'
import {
  buildRows, describeDiff, diffLines, findMatches, fuzzyBest, fuzzyScore, hexDump, looksBinary, markRanges,
  nextProtection, prepareContent, styleLines, targetFromKey, targetKey, wrapSegments,
} from '../../src/main/tui/views/files/model'
import { resolveEditor, splitCommand } from '../../src/main/tui/util/editor'
import type { FileListEntry } from '../../src/main/tui/api/types'

const entry = (path: string, size = 10): FileListEntry => ({ path, size, protection: 'none', authorized: false, created_at: '', updated_at: '' })
const FILES = ['mind.md', 'notes/api.md', 'notes/2026/q3.md', 'data/config.json', 'README.md'].map(p => entry(p))

describe('files model: tree', () => {
  it('pins document + mind, lists folders first and nests children', () => {
    const rows = buildRows(FILES, new Set())
    expect(rows.slice(0, 2).map(r => r.kind)).toEqual(['document', 'mind'])
    expect(rows.map(r => `${'  '.repeat(r.depth)}${r.name}`)).toEqual([
      'document', 'mind', 'data', '  config.json', 'notes', '  2026', '    q3.md', '  api.md', 'mind.md', 'README.md',
    ])
    const notes = rows.find(r => r.key === 'dir:notes')!
    expect(notes.fileCount).toBe(2)
    expect(notes.size).toBe(20)
  })

  it('hides collapsed folders and flattens matches while filtering', () => {
    expect(buildRows(FILES, new Set(['notes'])).some(r => r.path.startsWith('notes/'))).toBe(false)
    const filtered = buildRows(FILES, new Set(['notes']), 'q3')
    expect(filtered.map(r => r.name)).toEqual(['notes/2026/q3.md'])
    expect(buildRows(FILES, new Set(), 'mind').map(r => r.key)).toEqual(['mind:', 'file:mind.md'])
  })

  it('round-trips target keys and cycles protection', () => {
    for (const key of ['doc:', 'mind:', 'file:notes/api.md']) expect(targetKey(targetFromKey(key)!)).toBe(key)
    expect(targetFromKey('dir:notes')).toBeNull()
    expect(nextProtection('none')).toBe('read_only')
    expect(nextProtection('read_only')).toBe('no_delete')
    expect(nextProtection('no_delete')).toBe('none')
  })
})

describe('files model: fuzzy', () => {
  it('ranks exact basename and substring hits above scattered subsequences', () => {
    expect(fuzzyScore('xyz', 'notes/api.md')).toBeNull()
    expect(fuzzyBest('api', ['data/api-old/x.md', 'notes/api.md'])).toBe('notes/api.md')
    expect(fuzzyBest('nq3', FILES.map(f => f.path))).toBe('notes/2026/q3.md')
    expect(fuzzyBest('cfg', FILES.map(f => f.path))).toBe('data/config.json')
  })
})

describe('files model: content', () => {
  it('pretty-prints minified JSON and leaves formatted JSON alone', () => {
    const minified = prepareContent('{"a":1,"b":[true,null]}', 'x.json')
    expect(minified.pretty).toBe(true)
    expect(minified.lines).toEqual(['{', '  "a": 1,', '  "b": [', '    true,', '    null', '  ]', '}'])
    const formatted = prepareContent('{\n    "a": 1\n}\n', 'x.json')
    expect(formatted.pretty).toBe(false)
    expect(formatted.lines).toEqual(['{', '    "a": 1', '}'])
  })

  it('detects binary text and dumps hex', () => {
    expect(looksBinary('hello\nworld')).toBe(false)
    expect(looksBinary('PNG\u0000\u0001')).toBe(true)
    expect(hexDump(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))[0]).toMatch(/^00000000 {2}89 50 4e 47 +\.PNG$/)
  })

  it('styles markdown lines without dropping characters', () => {
    const lines = ['# Title', '- **bold** and `code`', '```', 'const x = 1', '```', '> quote']
    const styled = styleLines(lines, 'markdown')
    styled.forEach((segs, i) => expect(segs.map(s => s.text).join('')).toBe(lines[i]))
    expect(styled[0][1]).toMatchObject({ text: 'Title', tone: 'accent', bold: true })
    expect(styled[3][0].tone).toBe('live')
  })

  it('marks search hits and wraps styled segments', () => {
    const lines = ['alpha beta alpha']
    const hits = findMatches(lines, 'ALPHA')
    expect(hits).toEqual([{ line: 0, start: 0, end: 5 }, { line: 0, start: 11, end: 16 }])
    const marked = markRanges([{ text: lines[0], tone: 'text' }], hits.map((h, i) => ({ ...h, current: i === 1 })))
    expect(marked.map(s => [s.text, s.match])).toEqual([['alpha', 'hit'], [' beta ', undefined], ['alpha', 'current']])
    const rows = wrapSegments(marked, 7)
    expect(rows.map(r => r.map(s => s.text).join(''))).toEqual(['alpha b', 'eta alp', 'ha'])
  })
})

describe('files model: diff', () => {
  it('counts added and removed lines around common prefix/suffix', () => {
    const diff = diffLines('a\nb\nc\nd', 'a\nB\nc\nd\ne')
    expect([diff.added, diff.removed]).toEqual([2, 1])
    expect(diff.changes).toEqual([
      { sign: '+', text: 'B', line: 2 },
      { sign: '-', text: 'b', line: 2 },
      { sign: '+', text: 'e', line: 5 },
    ])
    const summary = describeDiff('x', 'x\ny')
    expect(summary.summary).toBe('+1 -0 lines, 1 -> 3 bytes')
    expect(summary.lines[0]).toContain('+   2 y')
  })
})

describe('files editor resolution', () => {
  it('prefers $VISUAL, then $EDITOR, then a platform default', () => {
    expect(resolveEditor({ VISUAL: 'code --wait', EDITOR: 'vim' }, 'linux')).toEqual(['code', '--wait'])
    expect(resolveEditor({ EDITOR: '"C:\\Program Files\\Editor\\ed.exe" -n' }, 'win32')).toEqual(['C:\\Program Files\\Editor\\ed.exe', '-n'])
    expect(resolveEditor({}, 'win32')).toEqual(['notepad'])
    expect(['nano', 'vi']).toContain(resolveEditor({ PATH: '' }, 'linux')[0])
    expect(splitCommand(`node 'a b.js' x`)).toEqual(['node', 'a b.js', 'x'])
  })
})
