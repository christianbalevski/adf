import { describe, it, expect } from 'vitest'
import { foldAgentStatuses } from '../../../src/renderer/utils/background-agent-statuses'
import type { BackgroundAgentStatus, RendererBackgroundAgentEvent } from '../../../src/shared/types/ipc.types'

const status = (filePath: string, over: Partial<BackgroundAgentStatus> = {}): BackgroundAgentStatus => ({
  filePath,
  handle: filePath.split('/').pop()!.replace('.adf', ''),
  state: 'idle',
  activeLoops: 0,
  ...over
})

const loops = (filePath: string, activeLoops: number): RendererBackgroundAgentEvent => ({
  type: 'agent_loops_changed',
  payload: { filePath, activeLoops },
  timestamp: 1
})

describe('foldAgentStatuses — inner loop counts', () => {
  const agents = [status('/w/alpha.adf'), status('/w/beta.adf', { state: 'active' })]

  it('updates activeLoops for the matching agent only', () => {
    const next = foldAgentStatuses(agents, [loops('/w/beta.adf', 2)])
    expect(next.map((a) => a.activeLoops)).toEqual([0, 2])
    expect(next[0]).toBe(agents[0])
    expect(next[1].state).toBe('active')
  })

  it('keeps the array reference when the count is unchanged', () => {
    const next = foldAgentStatuses(agents, [loops('/w/alpha.adf', 0)])
    expect(next).toBe(agents)
  })

  it('ignores a count for an agent that is not in the list', () => {
    expect(foldAgentStatuses(agents, [loops('/w/ghost.adf', 3)])).toBe(agents)
  })

  it('folds a whole batch down to the last count', () => {
    const next = foldAgentStatuses(agents, [
      loops('/w/alpha.adf', 1),
      loops('/w/alpha.adf', 2),
      loops('/w/alpha.adf', 0)
    ])
    expect(next[0].activeLoops).toBe(0)
  })

  it('seeds a started agent at zero', () => {
    const next = foldAgentStatuses([], [{
      type: 'agent_started',
      payload: { filePath: '/w/gamma.adf', handle: 'gamma', state: 'idle' },
      timestamp: 1
    }])
    expect(next).toEqual([status('/w/gamma.adf', { handle: 'gamma' })])
  })

  it('drops the entry, counts and all, when the agent stops', () => {
    const running = foldAgentStatuses(agents, [loops('/w/beta.adf', 2)])
    const next = foldAgentStatuses(running, [{
      type: 'agent_stopped',
      payload: { filePath: '/w/beta.adf' },
      timestamp: 2
    }])
    expect(next.map((a) => a.filePath)).toEqual(['/w/alpha.adf'])
  })

  it('leaves the array alone when a stop names an agent it never held', () => {
    expect(foldAgentStatuses(agents, [{
      type: 'agent_stopped',
      payload: { filePath: '/w/ghost.adf' },
      timestamp: 2
    }])).toBe(agents)
  })

  it('still folds plain state changes', () => {
    const next = foldAgentStatuses(agents, [{
      type: 'agent_state_changed',
      payload: { filePath: '/w/alpha.adf', state: 'active' },
      timestamp: 3
    }])
    expect(next[0].state).toBe('active')
    expect(foldAgentStatuses(next, [{
      type: 'agent_state_changed',
      payload: { filePath: '/w/alpha.adf', state: 'active' },
      timestamp: 4
    }])).toBe(next)
  })
})
