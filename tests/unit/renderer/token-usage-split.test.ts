import { describe, it, expect, beforeEach } from 'vitest'
import { useAgentStore } from '../../../src/renderer/stores/agent.store'

/**
 * tokenUsage / tokenEstimate split.
 *
 * FIXED BUG: the pre-flight `estimated: true` response_metadata event carries
 * only {input, output: 0}, and the old whole-object setTokenUsage replace
 * wiped the last real call's cache/cost breakdown at the start of every turn.
 * Estimates now live in their own `tokenEstimate` field; `tokenUsage` is
 * always the last REAL call's full breakdown.
 */

const realUsage = {
  input: 42000,
  output: 1200,
  cache_read: 40000,
  cache_write: 800,
  reasoning: 300,
  cost_usd: 0.0042
}

beforeEach(() => {
  useAgentStore.getState().reset()
})

describe('tokenUsage / tokenEstimate split', () => {
  it('a pre-flight estimate does not clobber the last real call breakdown', () => {
    const store = useAgentStore.getState()
    store.setTokenUsage(realUsage)
    // What useAgent does for an `estimated: true` response_metadata event
    store.setTokenEstimate(52300)
    expect(useAgentStore.getState().tokenUsage).toEqual(realUsage)
    expect(useAgentStore.getState().tokenEstimate).toBe(52300)
  })

  it('a real call replaces the breakdown and retires the estimate', () => {
    const store = useAgentStore.getState()
    store.setTokenUsage(realUsage)
    store.setTokenEstimate(52300)
    // What useAgent does for a post-call response_metadata event
    const next = { input: 52500, output: 900, cost_usd: 0.005 }
    store.setTokenUsage(next)
    store.setTokenEstimate(null)
    expect(useAgentStore.getState().tokenUsage).toEqual(next)
    expect(useAgentStore.getState().tokenEstimate).toBeNull()
  })

  it('reset clears both', () => {
    const store = useAgentStore.getState()
    store.setTokenUsage(realUsage)
    store.setTokenEstimate(52300)
    store.reset()
    expect(useAgentStore.getState().tokenUsage).toEqual({ input: 0, output: 0 })
    expect(useAgentStore.getState().tokenEstimate).toBeNull()
  })
})
