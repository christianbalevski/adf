/**
 * The state a new agent is shown in must be the state the runtime actually
 * starts it in: one resolution (`resolveStartInState`) drives both the
 * startup-turn decision and the initial display state.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHeadlessAgent, MockLLMProvider, type HeadlessAgent } from '../../../src/main/runtime/headless'
import { clearAllUmbilicalBuses } from '../../../src/main/runtime/umbilical-bus'
import { AGENT_DEFAULTS, resolveStartInState, type StartInState } from '../../../src/shared/types/adf-v02.types'

describe('resolveStartInState', () => {
  it('unset resolves to active, matching AGENT_DEFAULTS.state', () => {
    expect(resolveStartInState({})).toBe('active')
    expect(resolveStartInState({ start_in_state: null })).toBe('active')
    expect(AGENT_DEFAULTS.state).toBe('active')
  })

  it.each(['active', 'idle', 'hibernate'] as const)('explicit %s resolves to itself', (s) => {
    expect(resolveStartInState({ start_in_state: s })).toBe(s)
  })
})

describe('assembled agent: displayed initial state == runtime start behaviour', () => {
  const agents: HeadlessAgent[] = []
  beforeEach(() => clearAllUmbilicalBuses())
  afterEach(() => {
    for (const agent of agents.splice(0)) agent.dispose()
    clearAllUmbilicalBuses()
  })

  const cases: Array<[StartInState | undefined, StartInState, boolean]> = [
    [undefined, 'active', true],
    ['active', 'active', true],
    ['idle', 'idle', false],
    ['hibernate', 'hibernate', false],
  ]

  it.each(cases)('start_in_state=%s → shown %s, startup turn %s', async (startIn, shown, turns) => {
    const agent = createHeadlessAgent({
      name: 'agent-1',
      provider: new MockLLMProvider(),
      profile: 'benchmark',
      createOptions: startIn === undefined ? {} : { start_in_state: startIn },
    })
    agents.push(agent)
    expect(agent.workspace.getAgentConfig().start_in_state).toBe(startIn)
    vi.spyOn(agent.executor, 'executeTurn').mockResolvedValue(undefined)

    expect(agent.triggerEvaluator.getDisplayState()).toBe(shown)
    expect(await agent.dispatchStartup()).toBe(turns)
  })
})
