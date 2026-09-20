import { describe, it, expect } from 'vitest'
import { stableBlockBoundary, UNSAFE_TO_SPLIT } from '../../../src/renderer/utils/markdown-split'

/**
 * A streamed answer is cut at the last block boundary that can be rendered on
 * its own, so only the block still being written is re-parsed per delta. Every
 * case here is about the cut being CONSERVATIVE — an early cut costs a parse, a
 * wrong one changes what the reader sees.
 */

/** The prefix a boundary hands to the parser, for readable assertions. */
function stablePrefix(source: string): string {
  const cut = stableBlockBoundary(source)
  return cut === UNSAFE_TO_SPLIT ? '' : source.slice(0, cut)
}

describe('stableBlockBoundary', () => {
  it('has no boundary until a blank line is followed by content', () => {
    expect(stableBlockBoundary('')).toBe(0)
    expect(stableBlockBoundary('a partial sentence')).toBe(0)
    expect(stableBlockBoundary('one paragraph\n\n')).toBe(0)
  })

  it('cuts after a finished paragraph', () => {
    expect(stablePrefix('first\n\nsecond')).toBe('first\n\n')
  })

  it('keeps the last of several finished blocks', () => {
    expect(stablePrefix('a\n\nb\n\nc')).toBe('a\n\nb\n\n')
  })

  it('never cuts inside an open code fence', () => {
    const source = 'intro\n\n```ts\nconst a = 1\n\nconst b = 2\n'
    expect(stablePrefix(source)).toBe('intro\n\n')
  })

  it('cuts past a closed fence', () => {
    const source = 'intro\n\n```ts\nconst a = 1\n```\n\nafter'
    expect(stablePrefix(source)).toBe('intro\n\n```ts\nconst a = 1\n```\n\n')
  })

  it('does not treat a tilde fence as closed by backticks', () => {
    const source = 'intro\n\n~~~\ntext\n```\n\nstill inside\n'
    expect(stablePrefix(source)).toBe('intro\n\n')
  })

  it('does not cut between items of a loose list', () => {
    const source = '- one\n\n- two\n\n- three'
    expect(stableBlockBoundary(source)).toBe(0)
  })

  it('does not cut between a list and its indented continuation', () => {
    const source = '- one\n  - nested\n\n    continued paragraph\n\n- two'
    expect(stableBlockBoundary(source)).toBe(0)
  })

  it('cuts between a heading and the list that follows it', () => {
    const source = '# Title\n\n- one\n- two'
    expect(stablePrefix(source)).toBe('# Title\n\n')
  })

  it('cuts after a list once a plain paragraph follows it', () => {
    const source = '- one\n- two\n\nAfterwards'
    expect(stablePrefix(source)).toBe('- one\n- two\n\n')
  })

  it('does not cut between consecutive blockquote chunks', () => {
    expect(stableBlockBoundary('> quoted\n\n> more')).toBe(0)
  })

  it('does not cut between table rows', () => {
    const source = '| a | b |\n| - | - |\n\n| 1 | 2 |'
    expect(stableBlockBoundary(source)).toBe(0)
  })

  it('refuses to split a document with reference-style link definitions', () => {
    const source = 'See [the docs][d]\n\n[d]: https://example.com\n\nmore'
    expect(stableBlockBoundary(source)).toBe(UNSAFE_TO_SPLIT)
  })

  it('handles CRLF line endings', () => {
    expect(stablePrefix('first\r\n\r\nsecond')).toBe('first\r\n\r\n')
    expect(stableBlockBoundary('intro\r\n\r\n```\r\ncode\r\n\r\nstill code\r\n')).toBe(
      'intro\r\n\r\n'.length
    )
  })

  it('treats a run of blank lines as one boundary', () => {
    expect(stablePrefix('first\n\n\n\nsecond')).toBe('first\n\n')
  })

  it('grows monotonically as a stream arrives', () => {
    const doc = '# Title\n\nFirst paragraph.\n\n- a\n- b\n\n```js\nx()\n```\n\nLast words here.'
    let previous = 0
    for (let end = 1; end <= doc.length; end++) {
      const cut = stableBlockBoundary(doc.slice(0, end))
      expect(cut).not.toBe(UNSAFE_TO_SPLIT)
      expect(cut).toBeGreaterThanOrEqual(previous)
      previous = cut
    }
  })

  it('never cuts a chunk into a piece that ends mid-fence', () => {
    const doc = 'intro\n\n```\nalpha\n\nbeta\n```\n\nouttro'
    for (let end = 1; end <= doc.length; end++) {
      const prefix = stablePrefix(doc.slice(0, end))
      const fences = (prefix.match(/```/g) ?? []).length
      expect(fences % 2).toBe(0)
    }
  })
})
