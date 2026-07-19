import { describe, expect, it } from 'vitest'
import { sanitizeReasoningText, createReasoningDeltaSanitizer } from '../../../src/main/providers/ai-sdk-provider'

// Codex "experimental" reasoning summaries (gpt-5.6 family) ship sections as
// "**Headline**\n\n<!-- -->" — the body placeholder must never reach the UI.
describe('sanitizeReasoningText', () => {
  it('strips the empty-comment body placeholder', () => {
    expect(sanitizeReasoningText('**Planning audit sending and claim inclusion**\n\n<!-- -->'))
      .toBe('**Planning audit sending and claim inclusion**')
  })

  it('collapses blank-line runs left behind by stripped placeholders', () => {
    expect(sanitizeReasoningText('**A**\n\n<!-- -->\n\n**B**\n\n<!-- -->'))
      .toBe('**A**\n\n**B**')
  })

  it('leaves ordinary reasoning prose untouched', () => {
    const text = 'First I compare x < y, then check the <div> markup.\n\nSecond paragraph.'
    expect(sanitizeReasoningText(text)).toBe(text)
  })

  it('keeps non-empty HTML comments (only the empty placeholder is codex noise)', () => {
    const text = 'The file contains <!-- TODO --> markers.'
    expect(sanitizeReasoningText(text)).toBe(text)
  })
})

describe('createReasoningDeltaSanitizer', () => {
  it('strips a placeholder split across deltas (observed codex chunking)', () => {
    const s = createReasoningDeltaSanitizer()
    // Real chunks from gpt-5.6: "**Headline**\n\n<!--" then " -->"
    const out = s.push('**Confirming solution with CRT**\n\n<!--') + s.push(' -->') + s.flush()
    expect(out).toBe('**Confirming solution with CRT**\n\n')
  })

  it('strips a placeholder contained in a single delta', () => {
    const s = createReasoningDeltaSanitizer()
    expect(s.push('**A**\n\n<!-- -->tail') + s.flush()).toBe('**A**\n\ntail')
  })

  it('releases held text that turns out not to be a placeholder', () => {
    const s = createReasoningDeltaSanitizer()
    const out = s.push('compare a <') + s.push(' b in the loop') + s.flush()
    expect(out).toBe('compare a < b in the loop')
  })

  it('flushes a trailing partial marker at stream end', () => {
    const s = createReasoningDeltaSanitizer()
    const out = s.push('unfinished <!--') + s.flush()
    expect(out).toBe('unfinished <!--')
  })
})
