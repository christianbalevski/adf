import { describe, expect, it } from 'vitest'
import { gateStateOf, scopeFires, timerFires, wakeFires } from '../../../src/shared/utils/trigger-gate'

describe('trigger gate', () => {
  it('a turn in progress, including one waiting on an approval or ask, gates as active', () => {
    for (const s of ['thinking', 'tool_use', 'awaiting_approval', 'awaiting_ask']) expect(gateStateOf(s), s).toBe('active')
    for (const s of ['active', 'idle', 'hibernate', 'suspended', 'error', 'off']) expect(gateStateOf(s), s).toBe(s)
  })

  it.each([
    // gate,       agent on_timer, agent on_inbox, system
    ['active',     true,  true,  true],
    ['idle',       true,  true,  true],
    ['hibernate',  true,  false, true],
    ['suspended',  false, false, true],
    ['error',      false, false, true],
    ['stopped',    false, false, true],
    ['off',        false, false, false],
  ] as const)('in %s: agent on_timer %s, agent on_inbox %s, system %s', (gate, agentTimer, agentInbox, system) => {
    expect(scopeFires('agent', 'on_timer', gate)).toBe(agentTimer)
    expect(scopeFires('agent', 'on_inbox', gate)).toBe(agentInbox)
    expect(scopeFires('system', 'on_timer', gate)).toBe(system)
    expect(scopeFires('system', 'on_inbox', gate)).toBe(system)
  })

  it('a timer fires when any of its scopes does', () => {
    expect(timerFires(['agent'], gateStateOf('awaiting_approval'))).toBe(true)
    expect(timerFires(['agent'], 'suspended')).toBe(false)
    expect(timerFires(['agent', 'system'], 'suspended')).toBe(true)
    expect(timerFires(['system', 'agent'], 'error')).toBe(true)
    expect(timerFires(['agent', 'system'], 'off')).toBe(false)
    expect(timerFires([], 'idle')).toBe(false)
  })

  it('an Upcoming row from an older daemon (no scopes) gates on its scope', () => {
    const agent = { id: 1, at: 0, scope: 'agent' as const }
    const system = { id: 2, at: 0, scope: 'system' as const }
    expect(wakeFires(agent, 'idle')).toBe(true)
    expect(wakeFires(agent, 'suspended')).toBe(false)
    expect(wakeFires(system, 'suspended')).toBe(true)
    expect(wakeFires(system, 'off')).toBe(false)
    expect(wakeFires({ ...agent, scopes: ['agent', 'system'] }, 'suspended')).toBe(true)
  })
})
