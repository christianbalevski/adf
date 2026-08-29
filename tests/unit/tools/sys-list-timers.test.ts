import { describe, it, expect } from 'vitest'
import { GetTimersTool } from '../../../src/main/tools/built-in/sys-list-timers.tool'
import type { Timer } from '../../../src/shared/types/adf-v02.types'

/** `loop` is the cognition stream the caller is bound to — main unless stated. */
function makeWorkspace(timers: Timer[], loop = 'main') {
  return { getTimers: () => timers, getLoopName: () => loop } as any
}

const active: Timer = {
  id: 1,
  schedule: { mode: 'once', at: Date.now() + 60_000 },
  next_wake_at: Date.now() + 60_000,
  payload: 'ping later',
  scope: ['agent'],
  run_count: 0,
  created_at: Date.now() - 1000,
}

const expired: Timer = {
  id: 2,
  schedule: { mode: 'once', at: Date.now() - 60_000 },
  next_wake_at: Date.now() - 60_000,
  payload: 'already done',
  scope: ['agent'],
  run_count: 1,
  created_at: Date.now() - 120_000,
  last_fired_at: Date.now() - 60_000,
  expired: true,
}

describe('sys_list_timers', () => {
  const tool = new GetTimersTool()

  it('lists only active timers by default and notes hidden expired ones', async () => {
    const result = await tool.execute({}, makeWorkspace([active, expired]))
    expect(result.isError).toBe(false)
    expect(result.content).toContain('ID: 1')
    expect(result.content).not.toContain('ID: 2')
    expect(result.content).toContain('1 expired timer not shown')
    expect(result.content).toContain('include_expired')
  })

  it('includes expired timers when include_expired is true', async () => {
    const result = await tool.execute({ include_expired: true }, makeWorkspace([active, expired]))
    expect(result.content).toContain('ID: 1')
    expect(result.content).toContain('ID: 2')
    expect(result.content).toContain('Expired timers')
    expect(result.content).toContain('already done')
  })

  it('mentions expired history when no active timers exist', async () => {
    const result = await tool.execute({}, makeWorkspace([expired]))
    expect(result.content).toContain('no timers scheduled')
    expect(result.content).toContain('1 expired timer')
  })

  it('handles the fully empty case', async () => {
    const result = await tool.execute({}, makeWorkspace([]))
    expect(result.content).toBe('(no timers scheduled)')
  })

  it('tolerates undefined input (no args)', async () => {
    const result = await tool.execute(undefined, makeWorkspace([active]))
    expect(result.isError).toBe(false)
    expect(result.content).toContain('ID: 1')
  })

  it('shows a side loop only its own timers', async () => {
    const loopTimer: Timer = { ...active, id: 3, loop: 'reflector', payload: 'loop ping' }
    // The table is agent-wide, so an unscoped list would hand a side loop
    // main's charter timers along with the ids to delete them.
    const result = await tool.execute({}, makeWorkspace([active, loopTimer], 'reflector'))
    expect(result.content).toContain('ID: 3')
    expect(result.content).not.toContain('ID: 1')
  })

  it('shows main every loop\'s timers — the agent\'s schedule is main\'s business', async () => {
    const loopTimer: Timer = { ...active, id: 3, loop: 'reflector' }
    const result = await tool.execute({}, makeWorkspace([active, loopTimer], 'main'))
    expect(result.content).toContain('ID: 1')
    expect(result.content).toContain('ID: 3')
  })
})
