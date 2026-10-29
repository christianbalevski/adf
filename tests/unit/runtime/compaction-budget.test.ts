import { describe, expect, it, vi } from 'vitest'
import { boundCompactionTranscript, buildCompactionUserMessage, fitCompactionTranscript } from '../../../src/main/runtime/compaction-prompt'
import { hasLoneSurrogate } from '../../../src/shared/utils/well-formed'

const options = {
  maxInputTokens: 1_000,
  system: 'Summarize the evidence.',
  entryCount: 20,
  countTokens: (text: string) => Math.ceil(text.length / 4),
}

describe('token-aware compaction transcript fitting', () => {
  it('retains text larger than 100k characters when the configured token allowance fits it', () => {
    const transcript = 'full evidence '.repeat(30_000)
    const fitted = fitCompactionTranscript(transcript, { ...options, maxInputTokens: 300_000 })
    expect(fitted.transcript).toBe(transcript)
    expect(fitted.omittedCharacters).toBe(0)
    expect(fitted.inputTokens).toBeLessThan(300_000)
  })

  it('counts complete rendered system, wrapper and instructions, not only transcript', () => {
    const instructions = 'Keep the unresolved investigation.'
    const transcript = 'Experiment result.'
    const fitted = fitCompactionTranscript(transcript, { ...options, instructions })
    expect(fitted.inputTokens).toBe(options.countTokens(options.system)
      + options.countTokens(buildCompactionUserMessage(transcript, options.entryCount, instructions)) + 16)
  })

  it.each([
    'a'.repeat(40_000),
    '字😀{},[]'.repeat(8_000),
    'DENSE'.repeat(10_000) + ' '.repeat(100_000) + 'DENSE'.repeat(30_000),
  ])('fits varied token density while retaining the start and recent history', data => {
    const transcript = `START ${data} END`
    // Deliberately nonuniform density: whitespace is cheap, other characters
    // cost one token, astral characters count by Unicode scalar value.
    const countTokens = (text: string) => Array.from(text).reduce((n, char) => n + (/\s/.test(char) ? 0.05 : 1), 0)
    const fitted = fitCompactionTranscript(transcript, { ...options, countTokens })
    expect(fitted.inputTokens).toBeLessThanOrEqual(options.maxInputTokens)
    expect(fitted.transcript.startsWith('START')).toBe(true)
    expect(fitted.transcript.endsWith('END')).toBe(true)
    expect(fitted.transcript).toContain('[Middle of transcript omitted')
    expect(fitted.omittedCharacters).toBeGreaterThan(0)
    expect(hasLoneSurrogate(fitted.transcript)).toBe(false)
  })

  it('makes room for long system prompts and compaction instructions', () => {
    const transcript = 'evidence '.repeat(20_000)
    const plain = fitCompactionTranscript(transcript, options)
    const fitted = fitCompactionTranscript(transcript, {
      ...options, system: 'system '.repeat(100), instructions: 'instructions '.repeat(50),
    })
    expect(fitted.inputTokens).toBeLessThanOrEqual(options.maxInputTokens)
    expect(fitted.transcript.length).toBeLessThan(plain.transcript.length)
  })

  it('fails clearly when fixed framing cannot fit, including for an empty transcript', () => {
    for (const transcript of ['', 'history '.repeat(1_000)]) {
      expect(() => fitCompactionTranscript(transcript, { ...options, maxInputTokens: 20 }))
        .toThrow('cannot fit the system prompt, instructions and message framing')
    }
  })

  it('does not silently return an empty excerpt when the marker and history cannot fit', () => {
    const framing = options.countTokens(options.system)
      + options.countTokens(buildCompactionUserMessage('', options.entryCount)) + 16
    expect(() => fitCompactionTranscript('history '.repeat(1_000), { ...options, maxInputTokens: framing + 1 }))
      .toThrow('nonempty transcript excerpt and omission marker')
  })

  it('bounds tokenizer invocations even when excerpt token density is adversarial', () => {
    // Every nonempty transcript candidate has the same high cost, forcing
    // the loop to its final minimal-excerpt check rather than converging.
    const countTokens = vi.fn((text: string) => {
      if (text === options.system) return 1
      if (text.includes('<transcript>\n\n</transcript>')) return 1
      return 1_050
    })
    expect(() => fitCompactionTranscript('x'.repeat(1_000_000), { ...options, countTokens }))
      .toThrow('cannot fit a nonempty transcript excerpt')
    // One system count, full request, empty framing, at most eight excerpts.
    expect(countTokens.mock.calls.length).toBeLessThanOrEqual(11)
  })

  it('rejects invalid budgets and token counts instead of returning an unchecked request', () => {
    expect(() => fitCompactionTranscript('history', { ...options, maxInputTokens: NaN })).toThrow('Invalid compaction input token budget')
    expect(() => fitCompactionTranscript('history', { ...options, countTokens: () => NaN })).toThrow('Invalid compaction token count')
  })
})

describe('explicit character-bound compaction excerpts', () => {
  it('keeps approximately 20% beginning and 80% recent text without splitting surrogate pairs', () => {
    const transcript = '🧪'.repeat(20_000)
    const bounded = boundCompactionTranscript(transcript, 2_001)
    const [head, tail] = bounded.split(/\n\n\[Middle of transcript omitted[^]*?\]\n\n/)
    expect(head.length / (head.length + tail.length)).toBeCloseTo(0.2, 2)
    expect(hasLoneSurrogate(bounded)).toBe(false)
    expect(bounded.length).toBeLessThanOrEqual(2_001)
  })

  it('keeps fitting text intact and requires enough room for an explicit omission marker', () => {
    expect(boundCompactionTranscript('small transcript', 100)).toBe('small transcript')
    expect(boundCompactionTranscript('', 0)).toBe('')
    expect(() => boundCompactionTranscript('x'.repeat(1_000), 5)).toThrow('omission marker')
  })
})
