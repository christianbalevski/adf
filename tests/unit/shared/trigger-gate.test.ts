import { describe, expect, it } from 'vitest'
import { gateStateOf, scopeFires, timerFire, timerFireTime, wakeFireTime } from '../../../src/shared/utils/trigger-gate'

/** The context a loaded agent provides: on_timer admits both scopes, no inner loops. */
const CTX = { onTimer: { enabled: true, targets: [{ scope: 'system' as const }, { scope: 'agent' as const }] }, loops: [], loopFacts: {} }


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
    expect(scopeFires('agent', 'on_timer', { state: gate })).toBe(agentTimer)
    expect(scopeFires('agent', 'on_inbox', { state: gate })).toBe(agentInbox)
    expect(scopeFires('system', 'on_timer', { state: gate })).toBe(system)
    expect(scopeFires('system', 'on_inbox', { state: gate })).toBe(system)
  })

  it('in error, agent scope fires for main only, from the published recovery fact on', () => {
    expect(scopeFires('agent', 'on_inbox', { state: 'error', recoveryAt: 0 })).toBe(true)
    expect(scopeFires('agent', 'on_timer', { state: 'error', recoveryAt: 0 }, 'research')).toBe(false)
    expect(scopeFires('agent', 'on_timer', { state: 'error', recoveryAt: null })).toBe(false)
    expect(scopeFires('agent', 'on_timer', { state: 'error', recoveryAt: 2000 }, 'main', 1000)).toBe(false)
    expect(scopeFires('agent', 'on_timer', { state: 'error', recoveryAt: 2000 }, 'main', 2000)).toBe(true)
  })

  it('a row with an agent part fires when that part can be received; a system-only row unless off', () => {
    const due = 1000
    expect(timerFireTime(['agent'], { state: gateStateOf('awaiting_approval') }, due, null, CTX)).toBe(due)
    expect(timerFireTime(['agent'], { state: 'suspended' }, due, null, CTX)).toBeUndefined()
    // the whole row is held with its agent part
    expect(timerFireTime(['agent', 'system'], { state: 'suspended' }, due, null, CTX)).toBeUndefined()
    expect(timerFireTime(['system', 'agent'], { state: 'error', recoveryAt: null }, due, null, CTX)).toBeUndefined()
    expect(timerFireTime(['system', 'agent'], { state: 'error', recoveryAt: 5000 }, due, null, CTX)).toBe(5000)
    expect(timerFireTime(['system'], { state: 'error' }, due, null, CTX)).toBe(due)
    expect(timerFireTime(['agent', 'system'], { state: 'off' }, due, null, CTX)).toBeUndefined()
    // a row on_timer admits in no scope settles with nothing run (as the runtime does)
    expect(timerFireTime([], { state: 'idle' }, due, null, CTX)).toBe(due)
  })

  it('with a context: admitted scopes only, and an inner loop must be declared, enabled and able to receive', () => {
    const onTimer = { enabled: true, targets: [{ scope: 'system' as const }, { scope: 'agent' as const }] }
    const ctx = (loopFacts = {}) => ({ onTimer, loops: [{ name: 'side' }, { name: 'off', enabled: false }], loopFacts })
    expect(timerFireTime(['agent'], { state: 'idle' }, 10, 'side', ctx())).toBe(10)
    expect(timerFireTime(['agent'], { state: 'idle' }, 10, 'off', ctx())).toBeUndefined()
    // an undeclared (deleted) loop: the agent part is dropped, so the row fires as its other scopes do (round 3 F2)
    expect(timerFireTime(['agent'], { state: 'idle' }, 10, 'ghost', ctx())).toBe(10)
    expect(timerFireTime(['agent', 'system'], { state: 'suspended' }, 10, 'ghost', ctx())).toBe(10)
    expect(timerFireTime(['agent'], { state: 'off' }, 10, 'ghost', ctx())).toBeUndefined()
    // a disabled loop holds the row, lambda included
    expect(timerFireTime(['agent', 'system'], { state: 'idle' }, 10, 'off', ctx())).toBeUndefined()
    expect(timerFireTime(['agent'], { state: 'idle' }, 10, 'side', ctx({ side: { state: 'error', recoveryAt: null } }))).toBeUndefined()
    expect(timerFireTime(['agent'], { state: 'idle' }, 10, 'side', ctx({ side: { state: 'error', recoveryAt: 50 } }))).toBe(50)
    // on_timer admits only system: the agent part does not hold the row
    const sysOnly = { onTimer: { enabled: true, targets: [{ scope: 'system' as const }] }, loops: [], loopFacts: {} }
    expect(timerFireTime(['system', 'agent'], { state: 'suspended' }, 10, null, sysOnly)).toBe(10)
  })

  it('without a loaded config (no context) nothing is predicted (F4, round 2)', () => {
    expect(timerFireTime(['agent'], { state: 'idle' }, 10, null, undefined)).toBeUndefined()
    expect(timerFireTime(['system'], { state: 'idle' }, 10, null, undefined)).toBeUndefined()
    expect(wakeFireTime({ at: 10, scope: 'system' }, { state: 'idle' }, undefined)).toBeUndefined()
  })

  it('a stopped agent predicts no fire for a row on_timer admits in no scope (F4)', () => {
    const disabled = { onTimer: { enabled: false, targets: [] }, loops: [], loopFacts: {} }
    expect(timerFireTime(['agent'], { state: 'off' }, 10, null, disabled)).toBeUndefined()
    expect(timerFireTime(['system'], { state: 'off' }, 10, null, disabled)).toBeUndefined()
    expect(timerFireTime(['agent'], { state: 'idle' }, 10, null, disabled)).toBe(10)
  })

  it('an Upcoming row from an older daemon (no scopes) gates on its scope', () => {
    const agent = { id: 1, at: 0, scope: 'agent' as const }
    const system = { id: 2, at: 0, scope: 'system' as const }
    expect(wakeFireTime(agent, { state: 'idle' }, CTX)).toBe(0)
    expect(wakeFireTime(agent, { state: 'suspended' }, CTX)).toBeUndefined()
    expect(wakeFireTime(system, { state: 'suspended' }, CTX)).toBe(0)
    expect(wakeFireTime(system, { state: 'off' }, CTX)).toBeUndefined()
    expect(wakeFireTime({ ...agent, scopes: ['agent', 'system'] }, { state: 'suspended' }, CTX)).toBeUndefined()
  })

  describe('timerFire: the whole decision the runtime takes (round 14)', () => {
    const ctx = (loopFacts = {}) => ({ ...CTX, loops: [{ name: 'side' }], loopFacts })

    it('scopes: the admitted scopes that run; an agent-only on_timer drops system', () => {
      expect(timerFire(['system', 'agent'], { state: 'idle' }, 10, null, CTX)?.scopes).toEqual(['system', 'agent'])
      const agentOnly = { ...CTX, onTimer: { enabled: true, targets: [{ scope: 'agent' as const }] } }
      expect(timerFire(['system', 'agent'], { state: 'idle' }, 10, null, agentOnly)?.scopes).toEqual(['agent'])
    })

    it('dropsAgent: only for an inner loop that is not declared; the row then runs its other scopes', () => {
      const ghost = timerFire(['system', 'agent'], { state: 'idle' }, 10, 'ghost', ctx())
      expect(ghost).toEqual({ at: 10, scopes: ['system'], dropsAgent: true, recovery: false })
      expect(timerFire(['agent'], { state: 'idle' }, 10, 'side', ctx())?.dropsAgent).toBe(false)
      expect(timerFire(['agent'], { state: 'idle' }, 10, null, ctx())?.dropsAgent).toBe(false)
    })

    it('recovery: the agent part goes to a target in error that may take an attempt now', () => {
      expect(timerFire(['agent'], { state: 'error', recoveryAt: 0 }, 10, null, CTX)).toEqual({ at: 10, scopes: ['agent'], dropsAgent: false, recovery: true })
      expect(timerFire(['agent'], { state: 'idle' }, 10, 'side', ctx({ side: { state: 'error', recoveryAt: 5 } }))).toMatchObject({ at: 10, recovery: true })
      expect(timerFire(['agent'], { state: 'idle' }, 10, 'side', ctx())?.recovery).toBe(false)
      // a system-only row is never a recovery attempt, even in error
      expect(timerFire(['system'], { state: 'error', recoveryAt: null }, 10, null, CTX)?.recovery).toBe(false)
    })

    it('timerFireTime is its time', () => {
      expect(timerFireTime(['system', 'agent'], { state: 'error', recoveryAt: 50 }, 10, null, CTX)).toBe(timerFire(['system', 'agent'], { state: 'error', recoveryAt: 50 }, 10, null, CTX)?.at)
    })
  })
})
