import { describe, it, expect, beforeEach } from 'vitest'
import { useAgentStore, selectLoopSlice, MAIN_LOOP } from '../../../src/renderer/stores/agent.store'
import { createAgentEventHandler } from '../../../src/renderer/hooks/useAgent'
import type { AgentExecutionEvent } from '../../../src/shared/types/ipc.types'
import { stoppedNotice } from '../../../src/renderer/components/agent/overview/agent-overview-model'
import { timerFires, wakeFires } from '../../../src/shared/utils/trigger-gate'

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

describe('trigger gate beside the display state', () => {
  const ev = (state: string): AgentExecutionEvent => ({ type: 'state_changed', payload: { state }, timestamp: 1 } as AgentExecutionEvent)

  it('a turn waiting on an approval or ask shows as suspended but gates as active; a real suspend gates as suspended', () => {
    const handle = createAgentEventHandler()
    for (const s of ['awaiting_approval', 'awaiting_ask']) {
      handle(ev(s))
      expect(useAgentStore.getState().state, s).toBe('suspended')
      expect(useAgentStore.getState().gate, s).toBe('active')
    }
    handle(ev('suspended'))
    expect(useAgentStore.getState().state).toBe('suspended')
    expect(useAgentStore.getState().gate).toBe('suspended')
  })

  // A non-autostart agent with one system-scope timer waiting.
  const view = () => {
    const { gate } = useAgentStore.getState()
    return {
      notice: stoppedNotice({ gate, autostart: false, waitingTimers: 1, serving: false, starting: false }),
      rowCountdown: wakeFires({ scope: 'system', scopes: ['system'] }, gate),
      timersTabCountdown: timerFires(['system'], gate),
    }
  }

  it("the executor's hard abort (still loaded) gates stopped: no notice, system timers still fire", () => {
    const handle = createAgentEventHandler()
    handle(ev('idle'))
    handle(ev('stopped'))
    expect(useAgentStore.getState().state).toBe('off')
    expect(useAgentStore.getState().gate).toBe('stopped')
    expect(view()).toEqual({ notice: null, rowCountdown: true, timersTabCountdown: true })
  })

  it("the bridge's unload (off, after the executor's own stopped or off) gates off: the notice shows, no countdowns", () => {
    for (const last of ['stopped', 'off']) {
      useAgentStore.getState().reset()
      const handle = createAgentEventHandler()
      handle(ev('idle'))
      handle(ev(last))
      handle(ev('off')) // event-bridge foregroundStopped
      expect(useAgentStore.getState().state, last).toBe('off')
      expect(useAgentStore.getState().gate, last).toBe('off')
      const v = view()
      expect(v.notice, last).not.toBeNull()
      expect(v.rowCountdown, last).toBe(false)
      expect(v.timersTabCountdown, last).toBe(false)
    }
  })

  it('a display state set directly gates as itself', () => {
    useAgentStore.getState().setState('off')
    expect(useAgentStore.getState().gate).toBe('off')
    useAgentStore.getState().setState('active')
    expect(useAgentStore.getState().gate).toBe('active')
  })
})
