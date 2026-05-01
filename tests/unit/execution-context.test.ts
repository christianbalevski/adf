/**
 * AsyncLocalStorage execution-context tests.
 * The dev-mode assertion for "system:unknown" outside any wrap is covered
 * indirectly — if it fires spuriously, other tests will break.
 */

import { describe, it, expect } from 'vitest'
import { withSource, currentSource, currentAgentId, currentSourceOrUnknown } from '../../src/main/runtime/execution-context'

describe('execution-context', () => {
  it('withSource establishes the context for the sync duration of the callback', () => {
    withSource('agent:t1', 'agent-1', () => {
      expect(currentSource()).toBe('agent:t1')
      expect(currentAgentId()).toBe('agent-1')
    })
  })

  it('withSource preserves context across async boundaries inside the callback', async () => {
    await withSource('lambda:foo.ts:bar', 'agent-1', async () => {
      expect(currentSource()).toBe('lambda:foo.ts:bar')
      await new Promise(r => setTimeout(r, 1))
      expect(currentSource()).toBe('lambda:foo.ts:bar')
    })
  })

  it('nested withSource — innermost wins', () => {
    withSource('agent:outer', 'a', () => {
      expect(currentSource()).toBe('agent:outer')
      withSource('lambda:inner', 'a', () => {
        expect(currentSource()).toBe('lambda:inner')
      })
      expect(currentSource()).toBe('agent:outer')
    })
  })

  it('currentSourceOrUnknown returns system:unknown outside any wrap without throwing', () => {
    // Runs at the top level — no context. Dev-mode currentSource() would throw.
    expect(currentSourceOrUnknown()).toBe('system:unknown')
  })

  it('withSource accepts no agentId variant', () => {
    withSource('system:daemon', () => {
      expect(currentSource()).toBe('system:daemon')
      expect(currentAgentId()).toBeUndefined()
    })
  })
})
