import { describe, it, expect } from 'vitest'
import { locateInSource, type RichSelection } from '../../../src/renderer/utils/selection-source'

const README = [
  '# Sage',
  '',
  'A guide to ADF and ADF Studio, in a file. Ask how **something** works.',
  '',
  '## Ask me',
  '',
  '- What is an `.adf` file, and what is inside it?',
  '- How does an agent remember things?',
  '',
  'See [the docs](adf-file://docs/guide.md) for more.',
  '',
  'A guide to ADF and ADF Studio, in a file. Ask how **something** works.',
].join('\n')

/** A selection inside one block, as the rich view reports it. */
function inBlock(block: string, text: string, position: number): RichSelection {
  return { text, startBlock: block, endBlock: block, sameBlock: true, startOffset: block.indexOf(text), position }
}

describe('locateInSource', () => {
  it('quotes plain text exactly, with its line', () => {
    const block = 'How does an agent remember things?'
    expect(locateInSource(README, inBlock(block, 'agent remember', 0.6))).toEqual({ text: 'agent remember', startLine: 8, endLine: 8 })
  })

  it('finds text inside markup exactly', () => {
    const block = 'What is an .adf file, and what is inside it?'
    expect(locateInSource(README, inBlock(block, 'inside it', 0.5))).toEqual({ text: 'inside it', startLine: 7, endLine: 7 })
  })

  it('quotes the whole source line when the selection crosses markup', () => {
    const block = 'What is an .adf file, and what is inside it?'
    expect(locateInSource(README, inBlock(block, 'an .adf file', 0.5))).toEqual({
      text: '- What is an `.adf` file, and what is inside it?', startLine: 7, endLine: 7,
    })
  })

  it('places link text by the link line', () => {
    const block = 'See the docs for more.'
    expect(locateInSource(README, inBlock(block, 'See the docs', 0.8))).toEqual({
      text: 'See [the docs](adf-file://docs/guide.md) for more.', startLine: 10, endLine: 10,
    })
  })

  it('picks the identical block nearest the selection', () => {
    const block = 'A guide to ADF and ADF Studio, in a file. Ask how something works.'
    expect(locateInSource(README, inBlock(block, 'A guide', 0.05))?.startLine).toBe(3)
    expect(locateInSource(README, inBlock(block, 'A guide', 0.95))?.startLine).toBe(12)
  })

  it('picks the repeated word nearest where the selection starts in its block', () => {
    const block = 'A guide to ADF and ADF Studio, in a file. Ask how something works.'
    const second = { ...inBlock(block, 'ADF', 0.05), startOffset: block.indexOf('ADF Studio') }
    expect(locateInSource(README, second)).toEqual({ text: 'ADF', startLine: 3, endLine: 3 })
  })

  it('quotes every source line of a selection across blocks', () => {
    const selection: RichSelection = {
      text: 'inside it?\nHow does an agent',
      startBlock: 'What is an .adf file, and what is inside it?',
      endBlock: 'How does an agent remember things?',
      sameBlock: false,
      startOffset: 34,
      position: 0.5,
    }
    expect(locateInSource(README, selection)).toEqual({
      text: '- What is an `.adf` file, and what is inside it?\n- How does an agent remember things?', startLine: 7, endLine: 8,
    })
  })

  it('follows a paragraph wrapped over several source lines', () => {
    const source = 'Intro\n\nThis paragraph is wrapped\nover two lines.\n'
    const block = 'This paragraph is wrapped over two lines.'
    expect(locateInSource(source, inBlock(block, 'over two', 0.5))).toEqual({ text: 'over two', startLine: 4, endLine: 4 })
  })

  it('reaches a later block whose text the start line also contains', () => {
    const across = (source: string, text: string, startBlock: string, endBlock: string) =>
      locateInSource(source, { text, startBlock, endBlock, sameBlock: false, startOffset: 0, position: 0 })
    expect(across('- Ship it on Friday\n- Friday', 'it on Friday\nFriday', 'Ship it on Friday', 'Friday'))
      .toEqual({ text: '- Ship it on Friday\n- Friday', startLine: 1, endLine: 2 })
    expect(across('- todo\n- todo', 'todo\ntodo', 'todo', 'todo'))
      .toEqual({ text: '- todo\n- todo', startLine: 1, endLine: 2 })
  })

  it('keeps cells of one table row on that row', () => {
    const source = '| name | role |\n| --- | --- |\n| sage | guide |'
    expect(locateInSource(source, { text: 'sage\nguide', startBlock: 'sage', endBlock: 'guide', sameBlock: false, startOffset: 0, position: 0.9 }))
      .toEqual({ text: '| sage | guide |', startLine: 3, endLine: 3 })
  })

  it('quotes lines inside one code block exactly', () => {
    const source = 'Intro\n\n```js\nconst a = 1\nconst b = 2\n```'
    const block = 'const a = 1\nconst b = 2'
    expect(locateInSource(source, inBlock(block, 'a = 1\nconst b', 0.5))).toEqual({ text: 'a = 1\nconst b', startLine: 4, endLine: 5 })
  })

  it('gives up on text the source does not have', () => {
    expect(locateInSource(README, inBlock('Not in the file', 'Not', 0.5))).toBeNull()
  })
})
