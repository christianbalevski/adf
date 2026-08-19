import { describe, expect, it } from 'vitest'

import { isTransientProviderError, isAuthError, retryAfterMs } from '../../../src/main/runtime/agent-executor'
import { toProviderError } from '../../../src/main/providers/ai-sdk-provider'

function err(props: Record<string, unknown>, message = 'x'): Error {
  const e = new Error(message)
  Object.assign(e, props)
  return e
}

describe('isTransientProviderError', () => {
  it('treats 408/429/5xx status as transient', () => {
    expect(isTransientProviderError(err({ statusCode: 429 }), 'x')).toBe(true)
    expect(isTransientProviderError(err({ statusCode: 529 }), 'x')).toBe(true)
    expect(isTransientProviderError(err({ statusCode: 408 }), 'x')).toBe(true)
    expect(isTransientProviderError(err({ status: 503 }), 'x')).toBe(true)
  })

  it('a known non-transient status is authoritative — message keywords cannot override it', () => {
    // 400 whose body mentions a standalone "500" (token count) and "timeout"
    const msg = 'you requested about 4500 tokens (4000 of text input, 500 in the output); request timeout budget exceeded'
    expect(isTransientProviderError(err({ statusCode: 400 }, msg), msg)).toBe(false)
    expect(isTransientProviderError(err({ statusCode: 404 }), 'gateway timeout')).toBe(false)
  })

  it('classifies statusless SDK RetryError text (bare statusText) as transient', () => {
    expect(isTransientProviderError(new Error('x'), 'Failed after 4 attempts. Last error: Too Many Requests')).toBe(true)
    expect(isTransientProviderError(new Error('x'), 'Failed after 4 attempts. Last error: Service Unavailable')).toBe(true)
    expect(isTransientProviderError(new Error('x'), '529 Overloaded')).toBe(true)
  })

  it('honors AI_RetryError name and network codes; rejects unrelated errors', () => {
    const retryErr = new Error('opaque')
    retryErr.name = 'AI_RetryError'
    expect(isTransientProviderError(retryErr, 'opaque')).toBe(true)
    expect(isTransientProviderError(err({ code: 'ECONNRESET' }), 'x')).toBe(true)
    expect(isTransientProviderError(new Error('something broke'), 'something broke')).toBe(false)
  })
})

describe('isAuthError', () => {
  it('treats 401/402/403 as auth', () => {
    expect(isAuthError(err({ statusCode: 401 }), 'Unauthorized')).toBe(true)
    expect(isAuthError(err({ statusCode: 402 }), 'x')).toBe(true)
  })

  it('never classifies a definitive transient status as auth, regardless of billing wording', () => {
    const gemini = 'You exceeded your current quota, please check your plan and billing details.'
    expect(isAuthError(err({ statusCode: 429 }, gemini), gemini)).toBe(false)
    expect(isAuthError(err({ statusCode: 503 }), 'billing system unavailable')).toBe(false)
  })

  it('falls back to message matching only when no status is present', () => {
    expect(isAuthError(new Error('invalid api key'), 'invalid api key')).toBe(true)
    expect(isAuthError(new Error('x'), 'harmless message')).toBe(false)
  })

  it('classifies OpenAI insufficient_quota as auth even though it ships as HTTP 429', () => {
    const msg = '429 insufficient_quota: You exceeded your current quota, please check your plan and billing details.'
    expect(isAuthError(err({ statusCode: 429 }, msg), msg)).toBe(true)
    // ...while a Gemini per-minute rate limit (same prose, no token) stays transient.
    const gemini = 'You exceeded your current quota, please check your plan and billing details.'
    expect(isAuthError(err({ statusCode: 429 }, gemini), gemini)).toBe(false)
  })

  it('classifies statusless subscription token-refresh failures as auth', () => {
    for (const msg of ['Not authenticated — sign in first', 'Session expired — please sign in again']) {
      expect(isAuthError(new Error(msg), msg)).toBe(true)
      expect(isTransientProviderError(new Error(msg), msg)).toBe(false)
    }
  })
})

describe('retryAfterMs', () => {
  const withHeader = (v: string) => err({ responseHeaders: { 'retry-after': v } })

  it('parses delta-seconds (case-insensitive header)', () => {
    expect(retryAfterMs(withHeader('5'))).toBe(5000)
    expect(retryAfterMs(err({ responseHeaders: { 'Retry-After': '30' } }))).toBe(30000)
  })

  it('parses HTTP-date, clamping past dates to 0', () => {
    const future = new Date(Date.now() + 60_000).toUTCString()
    const ms = retryAfterMs(withHeader(future))
    expect(ms).toBeGreaterThan(50_000)
    expect(ms).toBeLessThanOrEqual(61_000)
    expect(retryAfterMs(withHeader('Wed, 21 Oct 2015 07:28:00 GMT'))).toBe(0)
  })

  it('returns null for absent, empty, or unparseable values', () => {
    expect(retryAfterMs(err({}))).toBe(null)
    expect(retryAfterMs(withHeader(''))).toBe(null)
    expect(retryAfterMs(withHeader('soon-ish'))).toBe(null)
    expect(retryAfterMs(null)).toBe(null)
  })
})

describe('toProviderError — RetryError unwrapping', () => {
  it('hoists status and headers from the last inner error of an AI_RetryError', () => {
    const inner = err(
      { statusCode: 429, responseHeaders: { 'retry-after': '30' }, responseBody: '{"error":{"message":"rate limited"}}' },
      'Too Many Requests'
    )
    const retryError = new Error('Failed after 4 attempts. Last error: Too Many Requests')
    retryError.name = 'AI_RetryError'
    ;(retryError as unknown as { errors: unknown[] }).errors = [err({ statusCode: 500 }), inner]

    const enriched = toProviderError(retryError) as Error & Record<string, unknown>
    expect(enriched.statusCode).toBe(429)
    expect(enriched.responseHeaders).toEqual({ 'retry-after': '30' })
    expect(enriched.name).toBe('AI_RetryError')
    expect(enriched.message).toContain('Failed after 4 attempts')
  })

  it('copies metadata from plain API errors and preserves the name', () => {
    const apiErr = err({ statusCode: 400, responseBody: 'bad request' }, 'Bad Request')
    apiErr.name = 'AI_APICallError'
    const enriched = toProviderError(apiErr) as Error & Record<string, unknown>
    expect(enriched.statusCode).toBe(400)
    expect(enriched.name).toBe('AI_APICallError')
  })

  it('is idempotent', () => {
    const once = toProviderError(err({ statusCode: 429 }))
    expect(toProviderError(once)).toBe(once)
  })
})
