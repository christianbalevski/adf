import { describe, it, expect } from 'vitest'
import { performance } from 'perf_hooks'
import { marked } from 'marked'
import { createIncrementalRenderer } from '../../src/renderer/utils/markdown-split'

/**
 * A streamed answer used to be re-parsed in full on every delta (~20/s), which
 * is quadratic in its length. `createIncrementalRenderer` parses each settled
 * block once and only re-parses the block still being written.
 *
 * The renderer under test is the parse half of utils/markdown.ts — the
 * DOMPurify half needs a DOM this suite does not have, and the whole claim
 * being checked (concatenating independently parsed blocks reproduces the
 * whole-document parse) lives in the parse.
 */

marked.use({ async: false, breaks: true })
const parse = (source: string): string => marked.parse(source) as string

const DELTA = 50

function streamingDoc(targetBytes: number): string {
  const blocks: string[] = []
  let size = 0
  let n = 0
  while (size < targetBytes) {
    const block = n % 4 === 3
      ? '```ts\nconst value' + n + ' = compute(' + n + ')\nexport default value' + n + '\n```'
      : n % 4 === 1
        ? '- point ' + n + ' about the thing\n- point ' + (n + 1) + ' about the other thing'
        : '## Section ' + n + '\n\nSome prose for section ' + n + ' that runs on for a while so the block has body.'
    blocks.push(block)
    size += block.length + 2
    n++
  }
  return blocks.join('\n\n')
}

describe('streaming markdown', () => {
  it('matches the whole-document parse at every delta boundary', () => {
    const doc = streamingDoc(4096)
    const render = createIncrementalRenderer(parse)
    for (let end = DELTA; end <= doc.length; end += DELTA) {
      const source = doc.slice(0, end)
      expect(render(source)).toBe(parse(source))
    }
    expect(render(doc)).toBe(parse(doc))
  })

  it('beats the full re-parse over a 20 KB stream', () => {
    const doc = streamingDoc(20 * 1024)

    const fullStart = performance.now()
    for (let end = DELTA; end <= doc.length; end += DELTA) parse(doc.slice(0, end))
    const fullMs = performance.now() - fullStart

    const render = createIncrementalRenderer(parse)
    const incrementalStart = performance.now()
    for (let end = DELTA; end <= doc.length; end += DELTA) render(doc.slice(0, end))
    const incrementalMs = performance.now() - incrementalStart

    console.log(
      `markdown stream ${doc.length}B in ${DELTA}B deltas — full: ${fullMs.toFixed(1)}ms, incremental: ${incrementalMs.toFixed(1)}ms`
    )
    expect(incrementalMs).toBeLessThan(fullMs / 2)
  })
})
