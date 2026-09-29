import { describe, expect, it } from 'vitest'
import { chatgptAccountIdFromJwt } from '../src/main/providers/chatgpt-subscription/auth-manager'

const jwt = (payload: Record<string, unknown>) =>
  `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`

describe('chatgptAccountIdFromJwt', () => {
  it('reads the account UUID nested under the OpenAI auth claim', () => {
    const token = jwt({
      sub: 'google-oauth2|123',
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct-uuid' },
    })
    expect(chatgptAccountIdFromJwt(token)).toBe('acct-uuid')
  })

  it('accepts a top-level claim', () => {
    expect(chatgptAccountIdFromJwt(jwt({ chatgpt_account_id: 'acct-uuid' }))).toBe('acct-uuid')
  })

  // Sending `sub` as ChatGPT-Account-ID bills a different bucket and fails
  // with a misleading usage_limit_reached.
  it('never falls back to sub', () => {
    expect(chatgptAccountIdFromJwt(jwt({ sub: 'google-oauth2|123' }))).toBe('')
  })

  it('returns empty for missing or malformed tokens', () => {
    expect(chatgptAccountIdFromJwt(undefined)).toBe('')
    expect(chatgptAccountIdFromJwt('garbage')).toBe('')
  })
})
