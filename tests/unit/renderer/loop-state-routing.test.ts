import { describe, it, expect, beforeEach } from 'vitest'
import { useAgentStore, selectLoopSlice, MAIN_LOOP } from '../../../src/renderer/stores/agent.store'

/**
 * Per-loop display state — what the loop tab strip's status dot reads.
 *
 * The dot is per LOOP, not per agent: `main` resolves to the store root (which
 * IS the agent-level state, §6.3) and a side loop to its own slice. Two things
 * must hold at once and pull in opposite directions:
 *
 *   - a side loop's `state_changed` MUST land somewhere the tab can see it
 *     (otherwise every side-loop dot is permanently grey), and
 *   - it must NEVER move the agent-level state (a reflector thinking in the
 *     background does not make the agent "active" in the sidebar, the title
 *     bar or the fleet).
 */

beforeEach(() => {
  useAgentStore.getState().reset()
})

describe('per-loop display state', () => {
  it('lands a side loop state on that loop, leaving the agent-level state alone', () => {
    useAgentStore.getState().setState('idle')
    useAgentStore.getState().setState('active', 'reflector')

    const store = useAgentStore.getState()
    expect(selectLoopSlice(store, 'reflector').state).toBe('active')
    // The invariant: agent-level state is MAIN's, and only main's.
    expect(store.state).toBe('idle')
    expect(selectLoopSlice(store, MAIN_LOOP).state).toBe('idle')
  })

  it('creates a side loop slice lazily on its first state event', () => {
    // A declared loop that has never emitted has no slice — the tab reads the
    // default ('idle'), which is what it should show before anything happens.
    expect(useAgentStore.getState().sideLoops.reflector).toBeUndefined()
    expect(selectLoopSlice(useAgentStore.getState(), 'reflector').state).toBe('idle')

    useAgentStore.getState().setState('active', 'reflector')
    expect(useAgentStore.getState().sideLoops.reflector).toBeDefined()
    expect(selectLoopSlice(useAgentStore.getState(), 'reflector').state).toBe('active')
  })

  it("keeps each loop's state independent, main included", () => {
    useAgentStore.getState().setState('active', 'reflector')
    useAgentStore.getState().setState('error', 'auditor')
    useAgentStore.getState().setState('active')

    const store = useAgentStore.getState()
    expect(store.state).toBe('active')
    expect(selectLoopSlice(store, 'reflector').state).toBe('active')
    expect(selectLoopSlice(store, 'auditor').state).toBe('error')

    // Main going idle is not every loop going idle.
    useAgentStore.getState().setState('idle')
    expect(selectLoopSlice(useAgentStore.getState(), 'reflector').state).toBe('active')
    expect(useAgentStore.getState().state).toBe('idle')
  })

  it('drops a disabled loop\'s slice without touching main', () => {
    useAgentStore.getState().setState('active', 'reflector')
    useAgentStore.getState().setState('active')

    useAgentStore.getState().dropLoop('reflector')
    expect(useAgentStore.getState().sideLoops.reflector).toBeUndefined()
    // A dropped loop reads the default again — grey, not stale amber.
    expect(selectLoopSlice(useAgentStore.getState(), 'reflector').state).toBe('idle')
    expect(useAgentStore.getState().state).toBe('active')

    // main is not droppable — dropLoop('main') must be a no-op, not a wipe.
    useAgentStore.getState().dropLoop(MAIN_LOOP)
    expect(useAgentStore.getState().state).toBe('active')
  })
})
