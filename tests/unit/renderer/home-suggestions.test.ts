import { describe, expect, it } from 'vitest'
import { SUGGESTION_POOL, pickSuggestions } from '../../../src/renderer/components/home/suggestions'

function seeded(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

describe('home suggestions', () => {
  it('has at least a hundred distinct prompts', () => {
    expect(SUGGESTION_POOL.length).toBeGreaterThanOrEqual(100)
    expect(new Set(SUGGESTION_POOL).size).toBe(SUGGESTION_POOL.length)
  })

  it('keeps the copy plain: no em dashes, no trailing punctuation', () => {
    for (const s of SUGGESTION_POOL) {
      expect(s).not.toContain('—')
      expect(s).not.toMatch(/[.!?]$/)
    }
  })

  it('picks the requested number of distinct prompts from the pool', () => {
    const picks = pickSuggestions(5, seeded(42))
    expect(picks).toHaveLength(5)
    expect(new Set(picks).size).toBe(5)
    for (const p of picks) expect(SUGGESTION_POOL).toContain(p)
  })

  it('varies between draws', () => {
    expect(pickSuggestions(4, seeded(1))).not.toEqual(pickSuggestions(4, seeded(2)))
  })

  it('caps at the pool size', () => {
    expect(pickSuggestions(SUGGESTION_POOL.length + 10, seeded(3))).toHaveLength(SUGGESTION_POOL.length)
  })
})
