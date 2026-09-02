import { describe, it, expect, beforeEach } from 'vitest'
import { useAgentStore, selectLoopSlice, MAIN_LOOP } from '../../../src/renderer/stores/agent.store'

/**
 * Per-loop token/context usage — what the status-bar gauge and the breakdown
 * modal read.
 *
 * `response_metadata` is already stamped with `loop`, and usage is CURRENT
 * context, which is a per-executor fact. So it routes to the emitting loop's
 * slice. The same two opposing invariants as the state routing apply:
 *
 *   - a side loop's usage MUST land somewhere the modal can read it, and
 *   - it must NEVER move the agent-level (= main's) figures that every
 *     pre-existing consumer reads off the store root.
 *
 * What is deliberately NOT built here is cumulative spend across loops: no
 * event carries it, so nothing sums these slices (RT-F12).
 */

const mainUsage = {
  input: 42000,
  output: 1200,
  cache_read: 40000,
  cache_write: 800,
  reasoning: 300,
  cost_usd: 0.0042
}

const loopUsage = { input: 7000, output: 250, cost_usd: 0.0009 }

beforeEach(() => {
  useAgentStore.getState().reset()
})

describe('per-loop token usage routing', () => {
  it('lands a side loop\'s usage on that loop, leaving main\'s alone', () => {
    useAgentStore.getState().setTokenUsage(mainUsage)
    useAgentStore.getState().setTokenUsage(loopUsage, 'reflector')

    const store = useAgentStore.getState()
    expect(selectLoopSlice(store, 'reflector').tokenUsage).toEqual(loopUsage)
    // The invariant: the store root stays MAIN's, for every existing consumer.
    expect(store.tokenUsage).toEqual(mainUsage)
    expect(selectLoopSlice(store, MAIN_LOOP).tokenUsage).toEqual(mainUsage)
  })

  it('routes pre-flight estimates per loop too', () => {
    useAgentStore.getState().setTokenEstimate(52300)
    useAgentStore.getState().setTokenEstimate(9100, 'reflector')

    let store = useAgentStore.getState()
    expect(store.tokenEstimate).toBe(52300)
    expect(selectLoopSlice(store, 'reflector').tokenEstimate).toBe(9100)

    // A side loop's real post-call metadata retires only ITS estimate.
    useAgentStore.getState().setTokenUsage(loopUsage, 'reflector')
    useAgentStore.getState().setTokenEstimate(null, 'reflector')
    store = useAgentStore.getState()
    expect(selectLoopSlice(store, 'reflector').tokenEstimate).toBeNull()
    expect(store.tokenEstimate).toBe(52300)
  })

  it('an estimate never clobbers that same loop\'s last real breakdown', () => {
    useAgentStore.getState().setTokenUsage(loopUsage, 'reflector')
    useAgentStore.getState().setTokenEstimate(9100, 'reflector')
    const slice = selectLoopSlice(useAgentStore.getState(), 'reflector')
    expect(slice.tokenUsage).toEqual(loopUsage)
    expect(slice.tokenEstimate).toBe(9100)
  })

  it('reads zeroes for a loop that has never reported', () => {
    expect(useAgentStore.getState().sideLoops.reflector).toBeUndefined()
    const slice = selectLoopSlice(useAgentStore.getState(), 'reflector')
    expect(slice.tokenUsage).toEqual({ input: 0, output: 0 })
    expect(slice.tokenEstimate).toBeNull()
  })

  it('drops a side loop\'s usage with its slice, leaving main\'s intact', () => {
    useAgentStore.getState().setTokenUsage(mainUsage)
    useAgentStore.getState().setTokenUsage(loopUsage, 'reflector')

    useAgentStore.getState().dropLoop('reflector')
    const store = useAgentStore.getState()
    expect(selectLoopSlice(store, 'reflector').tokenUsage).toEqual({ input: 0, output: 0 })
    expect(store.tokenUsage).toEqual(mainUsage)
  })

  it('reset clears every loop\'s figures', () => {
    useAgentStore.getState().setTokenUsage(mainUsage)
    useAgentStore.getState().setTokenEstimate(52300)
    useAgentStore.getState().setTokenUsage(loopUsage, 'reflector')

    useAgentStore.getState().reset()
    const store = useAgentStore.getState()
    expect(store.tokenUsage).toEqual({ input: 0, output: 0 })
    expect(store.tokenEstimate).toBeNull()
    expect(store.sideLoops).toEqual({})
  })
})

describe('viewedLoop', () => {
  it('starts on main and follows the selected tab', () => {
    expect(useAgentStore.getState().viewedLoop).toBe(MAIN_LOOP)
    useAgentStore.getState().setViewedLoop('reflector')
    expect(useAgentStore.getState().viewedLoop).toBe('reflector')
  })

  it('falls back to main when the viewed loop is dropped', () => {
    useAgentStore.getState().setState('active', 'reflector')
    useAgentStore.getState().setViewedLoop('reflector')
    useAgentStore.getState().dropLoop('reflector')
    expect(useAgentStore.getState().viewedLoop).toBe(MAIN_LOOP)
  })

  it('leaves the viewed loop alone when a DIFFERENT loop is dropped', () => {
    useAgentStore.getState().setState('active', 'auditor')
    useAgentStore.getState().setViewedLoop('reflector')
    useAgentStore.getState().dropLoop('auditor')
    expect(useAgentStore.getState().viewedLoop).toBe('reflector')
  })

  it('reset returns the view to main', () => {
    useAgentStore.getState().setViewedLoop('reflector')
    useAgentStore.getState().reset()
    expect(useAgentStore.getState().viewedLoop).toBe(MAIN_LOOP)
  })
})
