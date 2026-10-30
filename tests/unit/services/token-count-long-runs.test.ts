import { describe, expect, it } from 'vitest'
import { TokenCounterService } from '../../../src/main/services/token-counter.service'

const tc = new TokenCounterService()

// BPE on one long chunk is quadratic: 4 MB without whitespace used to hold the
// thread for hours. These finish in well under a second each.
describe('countTokens on long runs without whitespace', () => {
  for (const [name, provider, model] of [['gpt', 'openai', 'gpt-5'], ['anthropic', 'anthropic', 'claude-opus-5-5']] as const) {
    it(`${name}: a 4 MB run is estimated, not tokenized`, () => {
      const started = performance.now()
      const tokens = tc.countTokens('x'.repeat(4_300_000), provider, model)
      expect(performance.now() - started).toBeLessThan(1_000)
      expect(tokens).toBe(Math.ceil(4_300_000 / 3))
    })

    it(`${name}: the prose around a long run is still tokenized`, () => {
      const prose = 'Write the attached file to disk and report back. '
      const run = 'A'.repeat(10_000)
      const alone = tc.countTokens(prose, provider, model)
      expect(tc.countTokens(prose + run + ' ' + prose, provider, model))
        .toBe(alone + Math.ceil(run.length / 3) + tc.countTokens(' ' + prose, provider, model))
    })

    it(`${name}: text without long runs counts exactly as before`, () => {
      const text = 'The quick brown fox jumps over the lazy dog. '.repeat(200)
      expect(tc.countTokens(text, provider, model)).toBeGreaterThan(1_000)
      expect(tc.countTokens(text, provider, model)).toBeLessThan(text.length / 2)
    })
  }
})
