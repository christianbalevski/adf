import { describe, it, expect } from 'vitest'
import { anthropicOutputLimit } from '../../../src/main/providers/ai-sdk-provider'

describe('anthropicOutputLimit', () => {
  it('knows Claude models newer than the AI SDK table', () => {
    expect(anthropicOutputLimit('claude-opus-5-5')).toBe(128_000)
    expect(anthropicOutputLimit('claude-sonnet-5-5')).toBe(128_000)
    expect(anthropicOutputLimit('claude-opus-4-8')).toBe(128_000)
    expect(anthropicOutputLimit('claude-fable-5-1')).toBe(64_000)
  })

  it('leaves models the SDK already knows to the SDK', () => {
    expect(anthropicOutputLimit('claude-sonnet-4-5-20250929')).toBeUndefined()
    expect(anthropicOutputLimit('claude-haiku-4-5')).toBeUndefined()
    expect(anthropicOutputLimit('gpt-5')).toBeUndefined()
  })
})
