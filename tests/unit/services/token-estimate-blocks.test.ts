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
