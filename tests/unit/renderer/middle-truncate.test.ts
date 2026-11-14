import { describe, expect, it } from 'vitest'
import { middleSplit } from '../../../src/renderer/components/common/MiddleTruncate'

describe('middleSplit', () => {
  it('keeps the part that tells model names apart', () => {
    expect(middleSplit('claude-opus-5-5')).toEqual(['claude-opus', '-5-5'])
    expect(middleSplit('qwen2.5-coder-32b-instruct-q4_K_M')).toEqual(['qwen2.5-coder-32b-instruct', '-q4_K_M'])
    expect(middleSplit('hf.co/bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_K_M')).toEqual(['hf.co/bartowski/Llama-3.2-3B-Instruct', '-GGUF:Q4_K_M'])
    expect(middleSplit('llama3.1:8b')).toEqual(['llama3', '.1:8b'])
  })

  it('without a separator near the end, keeps the last few characters', () => {
    expect(middleSplit('averyveryverylongmodelname')).toEqual(['averyveryverylongmod', 'elname'])
  })

  it('leaves very short names whole', () => {
    expect(middleSplit('ab')).toEqual(['ab', ''])
    expect(middleSplit('')).toEqual(['', ''])
  })

  it('always rejoins to the original', () => {
    for (const name of ['gpt-4o', 'x', 'a/b/c/d/e/f/g/h', 'model_without-much']) {
      expect(middleSplit(name).join('')).toBe(name)
    }
  })
})
