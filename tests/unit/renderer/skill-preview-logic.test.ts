import { describe, it, expect } from 'vitest'
import {
  MAX_PREVIEW_FIELDS,
  MAX_PREVIEW_FIELD_CHARS,
  sanitizeDisplayBlock,
  splitSkillDocument
} from '../../../src/renderer/utils/skill-preview'

/**
 * The decisions the catalog's SKILL.md preview depends on.
 *
 * What these are really guarding: the preview renders a document fetched from a
 * URL nobody in this process controls, BEFORE anyone has decided to trust it.
 * So the two questions are "what is safe to paint" (sanitizeDisplayBlock, which
 * must strip what the panel's single-line sanitizer strips while keeping the
 * line breaks that make a document readable) and "where does the header end"
 * (splitSkillDocument, which must never swallow a whole file into a key/value
 * table because it happened to open with a horizontal rule).
 */

describe('sanitizeDisplayBlock', () => {
  it('keeps newlines and tabs — the body is a document, not a table cell', () => {
    expect(sanitizeDisplayBlock('one\ntwo\n\tindented')).toBe('one\ntwo\n\tindented')
  })

  it('normalizes CRLF and lone CR to LF', () => {
    expect(sanitizeDisplayBlock('a\r\nb\rc')).toBe('a\nb\nc')
  })

  it('strips the bidi overrides that can make text read as something else', () => {
    // U+202E right-to-left override: renders "…nur" as "run…" in the preview.
    expect(sanitizeDisplayBlock('run \u202Egnp.dm')).toBe('run gnp.dm')
    expect(sanitizeDisplayBlock('a\u200Eb\u200Fc\u061Cd\u2066e\u2069f')).toBe('abcdef')
  })

  it('strips C0/C1 controls other than tab and newline', () => {
    expect(sanitizeDisplayBlock('a\u0000b\u0007c\u001Bde')).toBe('abcde')
  })

  it('is empty for empty, null and undefined input', () => {
    expect(sanitizeDisplayBlock('')).toBe('')
    expect(sanitizeDisplayBlock(null)).toBe('')
    expect(sanitizeDisplayBlock(undefined)).toBe('')
  })
})

describe('splitSkillDocument', () => {
  const doc = [
    '---',
    'name: soul-creation',
    'description: Give an agent a distinct voice.',
    '---',
    '',
    '# Soul creation',
    '',
    'Body text.'
  ].join('\n')

  it('splits a well-formed package into fields and body', () => {
    const parsed = splitSkillDocument(doc)
    expect(parsed.hasFrontmatter).toBe(true)
    expect(parsed.fields).toEqual([
      { key: 'name', value: 'soul-creation' },
      { key: 'description', value: 'Give an agent a distinct voice.' }
    ])
    expect(parsed.body).toBe('# Soul creation\n\nBody text.')
  })

  it('treats a document with no frontmatter as all body', () => {
    const parsed = splitSkillDocument('# Just a heading\n\nand prose.')
    expect(parsed.hasFrontmatter).toBe(false)
    expect(parsed.fields).toEqual([])
    expect(parsed.body).toBe('# Just a heading\n\nand prose.')
  })

  // A file that opens with a rule and never closes it is a document, not a
  // header — swallowing it would show a key/value table and no content at all.
  it('does not treat an unterminated opener as frontmatter', () => {
    const parsed = splitSkillDocument('---\nname: never-closed\n\nprose that follows')
    expect(parsed.hasFrontmatter).toBe(false)
    expect(parsed.body).toBe('---\nname: never-closed\n\nprose that follows')
  })

  it('handles CRLF documents', () => {
    const parsed = splitSkillDocument('---\r\nname: crlf\r\n---\r\n\r\nBody.\r\n')
    expect(parsed.fields).toEqual([{ key: 'name', value: 'crlf' }])
    expect(parsed.body).toBe('Body.')
  })

  it('splits only on the first colon, so a value may contain one', () => {
    const parsed = splitSkillDocument('---\ndescription: Use this: for that\n---\nx')
    expect(parsed.fields).toEqual([{ key: 'description', value: 'Use this: for that' }])
  })

  it('unquotes a quoted value once', () => {
    const parsed = splitSkillDocument('---\na: "quoted"\nb: \'single\'\nc: "un\'even\n---\nx')
    expect(parsed.fields).toEqual([
      { key: 'a', value: 'quoted' },
      { key: 'b', value: 'single' },
      { key: 'c', value: '"un\'even' }
    ])
  })

  it('folds indented continuations into the field above', () => {
    const parsed = splitSkillDocument('---\ndescription: first line\n  second line\n---\nx')
    expect(parsed.fields).toEqual([{ key: 'description', value: 'first line second line' }])
  })

  it('joins a block list into one readable row', () => {
    const parsed = splitSkillDocument('---\nrequires:\n  - fs_write\n  - sys_fetch\n---\nx')
    expect(parsed.fields).toEqual([{ key: 'requires', value: 'fs_write, sys_fetch' }])
  })

  it('skips comments and blank lines', () => {
    const parsed = splitSkillDocument('---\n# a comment\n\nname: kept\n---\nx')
    expect(parsed.fields).toEqual([{ key: 'name', value: 'kept' }])
  })

  it('collapses a repeated key in place, last value winning', () => {
    const parsed = splitSkillDocument('---\nname: first\nother: x\nname: second\n---\nx')
    expect(parsed.fields).toEqual([
      { key: 'name', value: 'second' },
      { key: 'other', value: 'x' }
    ])
  })

  it('sanitizes the header as well as the body', () => {
    const parsed = splitSkillDocument('---\nname: soul\u202Ecreation\n---\nbody\u0000text')
    expect(parsed.fields).toEqual([{ key: 'name', value: 'soulcreation' }])
    expect(parsed.body).toBe('bodytext')
  })

  // The header block is chrome. A remote document cannot make it the page.
  it('bounds how many fields and how much of a value it will show', () => {
    const rows = Array.from({ length: MAX_PREVIEW_FIELDS + 5 }, (_, i) => `k${i}: v${i}`)
    const long = 'x'.repeat(MAX_PREVIEW_FIELD_CHARS + 50)
    const parsed = splitSkillDocument(`---\n${rows.join('\n')}\nlong: ${long}\n---\nbody`)
    expect(parsed.fields).toHaveLength(MAX_PREVIEW_FIELDS)
    expect(parsed.body).toBe('body')

    const single = splitSkillDocument(`---\nlong: ${long}\n---\nbody`)
    expect(single.fields[0].value).toHaveLength(MAX_PREVIEW_FIELD_CHARS + 1)
    expect(single.fields[0].value.endsWith('…')).toBe(true)
  })

  it('is empty for empty input', () => {
    expect(splitSkillDocument('')).toEqual({ hasFrontmatter: false, fields: [], body: '' })
    expect(splitSkillDocument(null)).toEqual({ hasFrontmatter: false, fields: [], body: '' })
  })

  it('reports frontmatter with no body', () => {
    const parsed = splitSkillDocument('---\nname: header-only\n---\n')
    expect(parsed.hasFrontmatter).toBe(true)
    expect(parsed.body).toBe('')
  })
})
