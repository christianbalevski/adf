import { describe, expect, it } from 'vitest'
import { TokenCounterService } from '../../../src/main/services/token-counter.service'

const tc = new TokenCounterService()

/** Estimate for a single user message carrying one content block. */
function estimateBlock(block: Record<string, unknown>): number {
  return tc.estimateMessagesTokens([{ role: 'user', content: [block] }])
}

/** Role overhead only — the floor every message pays (16 chars / 3.5). */
const ROLE_OVERHEAD = tc.estimateMessagesTokens([{ role: 'user', content: [] }])

const bigBase64 = 'A'.repeat(200_000)

describe('estimateMessagesTokens — multimodal blocks', () => {
  it('charges image_url data URIs instead of counting them as zero', () => {
    const tokens = estimateBlock({
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${bigBase64}` }
    })
    expect(tokens).toBeGreaterThan(ROLE_OVERHEAD)
    // ~100 chars/token for binary payloads: 200k chars → ~2k tokens.
    expect(tokens - ROLE_OVERHEAD).toBeGreaterThan(1000)
    // ...and nowhere near the prose rate, which would swallow a context window.
    expect(tokens).toBeLessThan(10_000)
  })

  it('charges input_audio payloads', () => {
    const tokens = estimateBlock({
      type: 'input_audio',
      input_audio: { data: bigBase64, format: 'wav' }
    })
    expect(tokens - ROLE_OVERHEAD).toBeGreaterThan(1000)
  })

  it('charges video_url data URIs', () => {
    const tokens = estimateBlock({
      type: 'video_url',
      video_url: { url: `data:video/mp4;base64,${bigBase64}` }
    })
    expect(tokens - ROLE_OVERHEAD).toBeGreaterThan(1000)
  })

  it('charges thinking text and preserved reasoning_details', () => {
    const textOnly = estimateBlock({ type: 'thinking', thinking: 'x'.repeat(3500) })
    expect(textOnly - ROLE_OVERHEAD).toBe(1000)

    const withDetails = estimateBlock({
      type: 'thinking',
      thinking: 'x'.repeat(3500),
      reasoning_details: [{ type: 'reasoning.encrypted', data: 'y'.repeat(3500) }]
    })
    expect(withDetails).toBeGreaterThan(textOnly)
  })

  it('still returns zero-ish for blocks with no payload', () => {
    expect(estimateBlock({ type: 'image_url' })).toBe(ROLE_OVERHEAD)
    expect(estimateBlock({ type: 'thinking' })).toBe(ROLE_OVERHEAD)
  })
})

describe('estimateMessagesTokens — tool_use JSON overhead', () => {
  it('counts JSON quotes around string values', () => {
    const withQuotes = tc.estimateMessagesTokens([
      { role: 'assistant', content: [{ type: 'tool_use', name: 'sys_read', input: { path: 'a' } }] }
    ])
    const naive = tc.estimateMessagesTokens([
      { role: 'assistant', content: [{ type: 'tool_use', name: 'sys_read', input: {} }] }
    ])
    expect(withQuotes).toBeGreaterThanOrEqual(naive)
    // 'path' (4) + quotes (2) + 'a' (1) + quotes (2) + separators (2) > bare {}
    expect(
      tc.estimateMessagesTokens([{ role: 'user', content: [{ type: 'tool_use', name: '', input: { k: 'v'.repeat(350) } }] }])
    ).toBeGreaterThan(100)
  })

  it('never decreases relative to raw text of the same size', () => {
    const payload = 'z'.repeat(7000)
    const asText = tc.estimateMessagesTokens([{ role: 'user', content: [{ type: 'text', text: payload }] }])
    const asToolInput = tc.estimateMessagesTokens([
      { role: 'user', content: [{ type: 'tool_use', name: '', input: payload }] }
    ])
    expect(asToolInput).toBeGreaterThanOrEqual(asText)
  })
})

describe('resolveTokenizer — provider types', () => {
  it('counts a Claude subscription with the Anthropic tokenizer, whatever the settings key', () => {
    const counter = new TokenCounterService()
    counter.registerProviderType('custom:claude1', 'claude-subscription')
    expect(counter.resolveTokenizer('custom:claude1', 'opus')).toBe('anthropic')
    expect(counter.resolveTokenizer('claude-subscription')).toBe('anthropic')
  })
})

describe('estimateMessagesTokensSplit — API-reported reasoning', () => {
  const thinkingMsg = (seq: number) => ({
    role: 'assistant',
    seq,
    content: [
      { type: 'thinking', thinking: 'x'.repeat(3500) },
      { type: 'text', text: 'y'.repeat(350) },
    ],
  })

  it('counts recorded reasoning tokens instead of the summarized thinking text', () => {
    const split = tc.estimateMessagesTokensSplit([thinkingMsg(7)], new Map([[7, 4000]]))
    expect(split.reported).toBe(4000)
    // Only role overhead + the text block are char-estimated.
    expect(split.estimated).toBe(Math.ceil((16 + 350) / 3.5))
  })

  it('falls back to the thinking text when the row recorded no reasoning', () => {
    const split = tc.estimateMessagesTokensSplit([thinkingMsg(7)], new Map([[8, 4000]]))
    expect(split.reported).toBe(0)
    expect(split.estimated).toBe(tc.estimateMessagesTokens([thinkingMsg(7)]))
  })

  it('ignores reasoning for a message without thinking blocks, and user rows', () => {
    const plain = { role: 'assistant', seq: 3, content: [{ type: 'text', text: 'hi' }] }
    const user = { role: 'user', seq: 4, content: [{ type: 'thinking', thinking: 'z' }] }
    const split = tc.estimateMessagesTokensSplit([plain, user], new Map([[3, 900], [4, 900]]))
    expect(split.reported).toBe(0)
    expect(split.estimated).toBe(tc.estimateMessagesTokens([plain, user]))
  })
})

describe('resendsReasoning', () => {
  it('is true for the Anthropic family only', () => {
    expect(tc.resendsReasoning('anthropic', 'claude-opus-5-5')).toBe(true)
    expect(tc.resendsReasoning('claude-subscription', 'claude-opus-5-5')).toBe(true)
    expect(tc.resendsReasoning('openrouter', 'anthropic/claude-opus-5-5')).toBe(true)
    expect(tc.resendsReasoning('openai', 'gpt-5')).toBe(false)
    expect(tc.resendsReasoning('chatgpt-subscription', 'gpt-5.6')).toBe(false)
    expect(tc.resendsReasoning('openrouter', 'openai/gpt-5')).toBe(false)
  })
})
