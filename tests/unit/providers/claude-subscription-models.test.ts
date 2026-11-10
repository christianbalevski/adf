import { beforeEach, describe, expect, it, vi } from 'vitest'

// Each query() answers supportedModels() with the next queued result.
const answers: Array<() => Promise<Array<{ value: string; resolvedModel?: string }>>> = []
let probes = 0

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => {
    probes++
    const next = answers.shift() ?? (() => Promise.resolve([]))
    return { supportedModels: next, close: () => {} }
  },
}))

vi.mock('../../../src/main/providers/claude-subscription/claude-code', () => ({
  requireClaudeCode: async () => ({ path: '/fake/claude', version: '9.9.9' }),
  claudeCodeEnv: (extra: Record<string, string>) => extra,
}))

const { listClaudeSubscriptionModels, CLAUDE_SUBSCRIPTION_MODELS } = await import('../../../src/main/providers/claude-subscription')
const { invalidateSupportedModels } = await import('../../../src/main/providers/claude-subscription/session')

const ok = (...ids: string[]) => () => Promise.resolve(ids.map((value) => ({ value })))
const fail = (message: string) => () => Promise.reject(new Error(message))

describe('Claude Code model list', () => {
  beforeEach(() => {
    invalidateSupportedModels()
    answers.length = 0
    probes = 0
  })

  it('caches the list and asks again on refresh', async () => {
    answers.push(ok('claude-a'), ok('claude-a', 'claude-b'))
    expect(await listClaudeSubscriptionModels()).toEqual({ models: ['claude-a'] })
    expect(await listClaudeSubscriptionModels()).toEqual({ models: ['claude-a'] })
    expect(probes).toBe(1)
    expect(await listClaudeSubscriptionModels({ refresh: true })).toEqual({ models: ['claude-a', 'claude-b'] })
    expect(probes).toBe(2)
  })

  it('shares a probe in flight, refresh or not', async () => {
    answers.push(ok('claude-a'))
    const [a, b, c] = await Promise.all([
      listClaudeSubscriptionModels(),
      listClaudeSubscriptionModels({ refresh: true }),
      listClaudeSubscriptionModels({ refresh: true }),
    ])
    expect(probes).toBe(1)
    expect([a, b, c]).toEqual([{ models: ['claude-a'] }, { models: ['claude-a'] }, { models: ['claude-a'] }])
  })

  it('keeps the last list when a refresh fails, and says so', async () => {
    answers.push(ok('claude-a', 'claude-b'), fail('Claude Code did not list models in time.'))
    await listClaudeSubscriptionModels()
    const refreshed = await listClaudeSubscriptionModels({ refresh: true })
    expect(refreshed.models).toEqual(['claude-a', 'claude-b'])
    expect(refreshed.error).toBe('Claude Code could not list models: Claude Code did not list models in time. Showing the last list.')
    // The failed probe did not replace the cache.
    expect(await listClaudeSubscriptionModels()).toEqual({ models: ['claude-a', 'claude-b'] })
  })

  it('falls back to the built-in list with an error when Claude Code never answered', async () => {
    answers.push(fail('not signed in'))
    const result = await listClaudeSubscriptionModels()
    expect(result.models).toEqual(CLAUDE_SUBSCRIPTION_MODELS)
    expect(result.error).toBe('Claude Code could not list models: not signed in. Showing the built-in list.')
  })
})
