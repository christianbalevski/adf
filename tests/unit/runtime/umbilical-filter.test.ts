import { describe, expect, it, vi } from 'vitest'
import {
  compileEventTypeMatcher,
  compileUmbilicalFilter,
  hasWildcardEventTypes,
} from '../../../src/main/runtime/umbilical-filter'
import type { UmbilicalEvent } from '../../../src/main/runtime/umbilical-bus'

function event(overrides: Partial<UmbilicalEvent> = {}): UmbilicalEvent {
  return {
    seq: 1,
    event_type: 'db.write',
    timestamp: 1,
    source: 'agent:agent-1',
    payload: {},
    ...overrides,
  }
}

const opts = { whenFilename: 'test:when' }

describe('umbilical-filter event type matching', () => {
  it('matches exact types, prefix wildcards, and "*"', () => {
    const exact = compileEventTypeMatcher(['db.write'])
    expect(exact('db.write')).toBe(true)
    expect(exact('db.writes')).toBe(false)
    expect(exact('tool.completed')).toBe(false)

    const prefix = compileEventTypeMatcher(['tool.*'])
    expect(prefix('tool.completed')).toBe(true)
    expect(prefix('tool.failed')).toBe(true)
    // The trailing dot is kept, so "tools.x" must not match "tool.*".
    expect(prefix('tools.completed')).toBe(false)
    expect(prefix('db.write')).toBe(false)

    const any = compileEventTypeMatcher(['*'])
    expect(any('anything.at.all')).toBe(true)
  })

  it('treats absent or empty event_types as "*"', () => {
    expect(compileEventTypeMatcher(undefined)('db.write')).toBe(true)
    expect(compileEventTypeMatcher([])('db.write')).toBe(true)
  })

  it('identifies wildcard subscriptions for the schema gate', () => {
    expect(hasWildcardEventTypes(['*'])).toBe(true)
    expect(hasWildcardEventTypes(['tool.*'])).toBe(true)
    expect(hasWildcardEventTypes(['db.write', 'tool.completed'])).toBe(false)
  })
})

describe('umbilical-filter when expressions', () => {
  // Ported from tests/unit/tap-manager.test.ts — the tap and stream-bind call
  // sites now share this implementation, so the cases must hold here too.
  it('evaluates the expression against the event payload', () => {
    const filter = compileUmbilicalFilter({
      event_types: ['db.write'],
      when: "event.payload.sql.includes('local_orders')",
    }, opts)

    expect(filter.test(event({ payload: { sql: 'INSERT INTO local_other VALUES (1)' } }))).toBe(false)
    expect(filter.test(event({ payload: { sql: 'INSERT INTO local_orders VALUES (1)' } }))).toBe(true)
    expect(filter.test(event({ event_type: 'tool.completed', payload: { sql: 'local_orders' } }))).toBe(false)
  })

  it('does not evaluate expressions in the main-process global scope', () => {
    const filter = compileUmbilicalFilter({
      event_types: ['db.write'],
      when: "typeof process !== 'undefined'",
    }, opts)
    expect(filter.test(event())).toBe(false)
  })

  it('fails closed when the expression throws', () => {
    const filter = compileUmbilicalFilter({ when: 'event.payload.missing.deep' }, opts)
    expect(filter.test(event())).toBe(false)
  })

  it('wraps compile errors with the caller-supplied message', () => {
    expect(() => compileUmbilicalFilter({ when: 'this is not (valid' }, {
      ...opts,
      wrapCompileError: err => new Error(`Invalid when expression for tap "orders": ${err}`),
    })).toThrow(/Invalid when expression for tap "orders"/)
  })
})

describe('umbilical-filter guards', () => {
  it('suppresses events from an excluded source', () => {
    const filter = compileUmbilicalFilter({
      event_types: ['db.write'],
      exclude_source: 'lambda:lib/tap.ts:onEvent',
    }, opts)

    expect(filter.test(event({ source: 'lambda:lib/tap.ts:onEvent' }))).toBe(false)
    expect(filter.test(event({ source: 'agent:agent-1' }))).toBe(true)
  })

  it('rate limits with a token bucket and reports overruns', () => {
    const onRateLimited = vi.fn()
    const filter = compileUmbilicalFilter({ event_types: ['db.write'], max_rate_per_sec: 1 }, {
      ...opts,
      onRateLimited,
    })

    expect(filter.test(event())).toBe(true)
    expect(filter.test(event())).toBe(false)
    expect(onRateLimited).toHaveBeenCalledTimes(1)
  })

  it('does not rate limit when no rate is configured', () => {
    const filter = compileUmbilicalFilter({ event_types: ['db.write'] }, opts)
    for (let i = 0; i < 500; i += 1) expect(filter.test(event())).toBe(true)
  })

  it('applies the suppress veto first, without spending a rate-limit token', () => {
    const filter = compileUmbilicalFilter({ event_types: ['db.write'], max_rate_per_sec: 1 }, {
      ...opts,
      suppress: candidate => candidate.payload.binding_id === 'binding-1',
    })

    expect(filter.test(event({ payload: { binding_id: 'binding-1' } }))).toBe(false)
    // The suppressed event must not have consumed the single token.
    expect(filter.test(event({ payload: { binding_id: 'binding-2' } }))).toBe(true)
  })
})
