import { describe, it, expect, beforeEach } from 'vitest'
import { useAgentStore, selectAggregateLogVersion, MAIN_LOOP } from '../../../src/renderer/stores/agent.store'
import { nanoid } from 'nanoid'

/**
 * The center chat tab's unread dot (B1/B10). The dot is driven by a COARSE
 * signal — `selectAggregateLogVersion`, the sum of every loop slice's
 * `logVersion` — watched imperatively so streaming deltas never re-render the
 * editor. The hook itself needs a DOM to test; what is unit-testable here is the
 * contract it stands on:
 *   - the signal moves on any loop's mutation (so "something happened" is
 *     detectable across main + side loops), and
 *   - re-anchoring the seen-baseline after an agent switch clears the stale dot
 *     (B10) — the switch resets the store, so the baseline the hook captures
 *     right after must equal the fresh aggregate, i.e. no phantom unread.
 */

const entry = (content = '') => ({ id: nanoid(), type: 'text' as const, content, timestamp: Date.now() })

beforeEach(() => {
  useAgentStore.getState().reset()
})

describe('selectAggregateLogVersion (unread signal)', () => {
  it('starts at zero on a fresh store', () => {
    expect(selectAggregateLogVersion(useAgentStore.getState())).toBe(0)
  })

  it('moves when the MAIN loop mutates', () => {
    const before = selectAggregateLogVersion(useAgentStore.getState())
    useAgentStore.getState().addLogEntry(entry('hi'))
    expect(selectAggregateLogVersion(useAgentStore.getState())).toBeGreaterThan(before)
  })

  it('moves when a SIDE loop mutates — the dot is not main-only', () => {
    const before = selectAggregateLogVersion(useAgentStore.getState())
    useAgentStore.getState().addLogEntry(entry('reflecting'), 'reflector')
    expect(selectAggregateLogVersion(useAgentStore.getState())).toBeGreaterThan(before)
  })

  it('sums across main and every side loop', () => {
    const s = useAgentStore.getState()
    s.addLogEntry(entry(), MAIN_LOOP)
    s.addLogEntry(entry(), 'a')
    s.addLogEntry(entry(), 'a')
    s.addLogEntry(entry(), 'b')
    const st = useAgentStore.getState()
    const expected = st.logVersion + st.sideLoops.a.logVersion + st.sideLoops.b.logVersion
    expect(selectAggregateLogVersion(st)).toBe(expected)
    expect(selectAggregateLogVersion(st)).toBe(4)
  })
})

describe('unread transition + reset semantics', () => {
  // Mirrors the hook's rule: unread flips true only when the live aggregate
  // diverges from the baseline captured while the tab was last seen.
  const isUnread = (seen: number) => selectAggregateLogVersion(useAgentStore.getState()) !== seen

  it('flips unread when a hidden loop mutates after the baseline is taken', () => {
    const seen = selectAggregateLogVersion(useAgentStore.getState())
    expect(isUnread(seen)).toBe(false)
    useAgentStore.getState().addLogEntry(entry('while away'), 'reflector')
    expect(isUnread(seen)).toBe(true)
  })

  it('re-anchoring the baseline (open the tab) clears the dot', () => {
    useAgentStore.getState().addLogEntry(entry('activity'))
    // Opening the tab re-captures the baseline at the current aggregate.
    const seen = selectAggregateLogVersion(useAgentStore.getState())
    expect(isUnread(seen)).toBe(false)
  })

  it('an agent switch does not carry a stale dot (B10)', () => {
    // Old agent accrued activity...
    useAgentStore.getState().addLogEntry(entry('old agent'))
    useAgentStore.getState().addLogEntry(entry('old side'), 'reflector')
    const staleSeen = selectAggregateLogVersion(useAgentStore.getState())
    expect(staleSeen).toBeGreaterThan(0)

    // Switching agents resets the store; the hook re-anchors its baseline to the
    // fresh aggregate. If it (wrongly) kept the old baseline, the dot would show.
    useAgentStore.getState().reset()
    const freshSeen = selectAggregateLogVersion(useAgentStore.getState())
    expect(freshSeen).toBe(0)
    expect(isUnread(freshSeen)).toBe(false)
    // The stale baseline WOULD have mis-fired — proving the reset is load-bearing.
    expect(freshSeen).not.toBe(staleSeen)
  })
})
