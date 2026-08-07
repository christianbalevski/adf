import { describe, it, expect } from 'vitest'
import { toProviderError } from '../../../src/main/providers/ai-sdk-provider'

/** Shape mirrors the AI SDK's APICallError after a provider 4xx/5xx. */
function apiCallError(overrides: Record<string, unknown> = {}): Error {
  const err = new Error('Forbidden')
  Object.assign(err, {
    name: 'AI_APICallError',
    statusCode: 403,
    url: 'https://api.x.ai/v1/chat/completions',
    responseBody: '{"code":"personal-team-blocked:spending-limit","error":"You have run out of credits or need a Grok subscription."}',
    isRetryable: false,
    ...overrides,
  })
  return err
}

describe('toProviderError', () => {
  it('surfaces status code and response-body detail in the message', () => {
    const enriched = toProviderError(apiCallError())
    expect(enriched.message).toContain('403')
    expect(enriched.message).toContain('run out of credits')
  })

  it('preserves classification metadata for the executor', () => {
    const enriched = toProviderError(apiCallError()) as unknown as Record<string, unknown>
    expect(enriched.statusCode).toBe(403)
    expect(enriched.url).toBe('https://api.x.ai/v1/chat/completions')
    expect(typeof enriched.responseBody).toBe('string')
  })

  it('extracts nested error.message bodies (OpenAI shape)', () => {
    const enriched = toProviderError(apiCallError({
      statusCode: 429,
      message: 'Too Many Requests',
      responseBody: '{"error":{"message":"Rate limit reached for gpt-4o","type":"tokens"}}',
    }))
    expect(enriched.message).toContain('429')
    expect(enriched.message).toContain('Rate limit reached')
  })

  it('falls back to the raw body when it is not JSON', () => {
    const enriched = toProviderError(apiCallError({ responseBody: 'upstream connect error' }))
    expect(enriched.message).toContain('403')
    expect(enriched.message).toContain('upstream connect error')
  })

  it('is idempotent — re-wrapping does not double the status prefix', () => {
    const once = toProviderError(apiCallError())
    const twice = toProviderError(once)
    expect(twice).toBe(once)
  })

  it('passes plain errors through with their message intact', () => {
    const enriched = toProviderError(new Error('fetch failed'))
    expect(enriched.message).toBe('fetch failed')
  })

  it('handles non-object errors', () => {
    expect(toProviderError('boom').message).toBe('boom')
  })
})
