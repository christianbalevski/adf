import { describe, it, expect } from 'vitest'
import { parseLoopToDisplay, parseLoopWithToolPairs } from '../../../src/shared/utils/loop-parser'
import type { LoopEntry } from '../../../src/shared/types/adf-v02.types'

/**
 * Where a loop row's whole-call usage lands on its display entries.
 *
 * FIXED BUG: every text / thinking / tool_call entry of an assistant row was
 * stamped with the same full-call `tokens`, and the thinking row rendered
 * `tokens.output` as if it were the size of the thinking — it is the size of
 * the whole answer plus every tool call. The usage now goes on ONE entry (the
 * row's last displayed block) and thinking rows carry the provider's exact
 * `reasoning` count separately when there is one.
 */

const usage = { input: 40_000, output: 900, reasoning: 350, cost_usd: 0.01 }

function assistantRow(seq: number, content: LoopEntry['content_json'], tokens?: LoopEntry['tokens']): LoopEntry {
  return { seq, role: 'assistant', content_json: content, model: 'm', tokens, created_at: 1 }
}

for (const [name, parse] of [
  ['parseLoopToDisplay', parseLoopToDisplay],
  ['parseLoopWithToolPairs', parseLoopWithToolPairs],
] as const) {
  describe(`${name}: token placement`, () => {
    it('stamps the whole-call usage on the last block of the row only', () => {
      const entries = parse([
        assistantRow(1, [
          { type: 'thinking', thinking: 'let me think' },
          { type: 'text', text: 'answer' },
          { type: 'tool_use', id: 't1', name: 'fs_read', input: {} },
        ], usage),
      ])
      expect(entries.map(e => e.type)).toEqual(['thinking', 'text', 'tool_call'])
      expect(entries[0].metadata?.tokens).toBeUndefined()
      expect(entries[1].metadata?.tokens).toBeUndefined()
      expect(entries[2].metadata?.tokens).toEqual(usage)
    })

    it('a text-only row puts the usage on the text entry', () => {
      const [text] = parse([assistantRow(1, [{ type: 'text', text: 'hi' }], usage)])
      expect(text.metadata?.tokens).toEqual(usage)
      expect(text.metadata?.model).toBe('m')
    })

    it('thinking rows carry the exact reasoning count, never the output count', () => {
      const [thinking, text] = parse([
        assistantRow(1, [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'ok' }], usage),
      ])
      expect(thinking.metadata?.reasoningTokens).toBe(350)
      expect(thinking.metadata?.tokens).toBeUndefined()
      expect(text.metadata?.reasoningTokens).toBeUndefined()
    })

    it('omits reasoningTokens when the provider reported none', () => {
      const [thinking] = parse([
        assistantRow(1, [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'ok' }], { input: 10, output: 5 }),
      ])
      expect(thinking.metadata).not.toHaveProperty('reasoningTokens')
    })

    it('a row without usage stamps nothing', () => {
      const entries = parse([assistantRow(1, [{ type: 'text', text: 'hi' }])])
      expect(entries[0].metadata).not.toHaveProperty('tokens')
    })

    it('never leaks a row\'s usage onto the previous row', () => {
      const entries = parse([
        assistantRow(1, [{ type: 'text', text: 'first' }], { input: 1, output: 1 }),
        // Whitespace-only text renders nothing, so this row has no display entry.
        assistantRow(2, [{ type: 'text', text: '   ' }], usage),
      ])
      expect(entries).toHaveLength(1)
      expect(entries[0].metadata?.tokens).toEqual({ input: 1, output: 1 })
    })
  })
}
