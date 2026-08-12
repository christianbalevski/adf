import { describe, it, expect } from 'vitest'
import { estimateTokens, formatTokenCount } from '../../../src/renderer/utils/token-estimate'

describe('estimateTokens', () => {
  it('is chars/4 rounded up', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('a')).toBe(1)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
    expect(estimateTokens('a'.repeat(547_000))).toBe(136_750)
  })
})

describe('formatTokenCount', () => {
  it('keeps the documented shapes', () => {
    expect(formatTokenCount(0)).toBe('0')
    expect(formatTokenCount(812)).toBe('812')
    expect(formatTokenCount(999)).toBe('999')
    expect(formatTokenCount(1000)).toBe('1.0k')
    expect(formatTokenCount(4200)).toBe('4.2k')
    expect(formatTokenCount(10_000)).toBe('10k')
    expect(formatTokenCount(137_200)).toBe('137k')
    expect(formatTokenCount(1_000_000)).toBe('1.0M')
  })

  // Was: the branch was picked from the raw value, so 9_999 took the toFixed(1)
  // path and printed "10.0k" — one decimal on a value that has already rolled
  // over to two significant digits.
  it('rolls 9_99x up to a whole-thousands label', () => {
    expect(formatTokenCount(9949)).toBe('9.9k')
    expect(formatTokenCount(9950)).toBe('10k')
    expect(formatTokenCount(9999)).toBe('10k')
  })

  // Was: 999_999 / 1000 rounded to 1000 and printed "1000k", never reaching
  // the M branch.
  it('rolls 999_99x up into M instead of printing "1000k"', () => {
    expect(formatTokenCount(999_499)).toBe('999k')
    expect(formatTokenCount(999_999)).toBe('1.0M')
    expect(formatTokenCount(1_400_000)).toBe('1.4M')
  })

  it('never emits a label wider than four characters plus the unit', () => {
    for (const n of [0, 1, 999, 1000, 9999, 10_000, 99_999, 999_999, 1_000_000, 9_999_999]) {
      expect(formatTokenCount(n)).not.toMatch(/^\d{4}[kM]$/)
    }
  })

  it('the 128k-char gate reads as ~32k tokens on the badge', () => {
    expect(formatTokenCount(estimateTokens('x'.repeat(128_001)))).toBe('32k')
  })
})
