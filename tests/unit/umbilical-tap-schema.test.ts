/**
 * umbilical_taps Zod validation — the wildcard gate.
 */

import { describe, it, expect } from 'vitest'
import { AgentConfigSchema } from '../../src/main/adf/adf-schema'

function baseConfig(): Record<string, unknown> {
  return {
    adf_version: '0.2',
    id: '00000000-0000-0000-0000-000000000001',
    name: 'Test',
    model: { provider: 'anthropic', model_id: '' },
    instructions: 'test',
    context: {},
    tools: [],
    triggers: {},
    messaging: { send: true, receive: true },
    security: { allow_unsigned: true },
    limits: {},
    metadata: { author: 'test', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), version: '1' },
  }
}

describe('umbilical_taps schema', () => {
  it('accepts a narrow tap without allow_wildcard', () => {
    const parsed = AgentConfigSchema.safeParse({
      ...baseConfig(),
      umbilical_taps: [{
        name: 'narrow',
        lambda: 'lib/t.ts:fn',
        filter: { event_types: ['db.write'] }
      }]
    })
    expect(parsed.success).toBe(true)
  })

  it('accepts an exact-match-only wildcard-like string without gate (e.g. "tool.specific")', () => {
    const parsed = AgentConfigSchema.safeParse({
      ...baseConfig(),
      umbilical_taps: [{
        name: 'exact',
        lambda: 'lib/t.ts:fn',
        filter: { event_types: ['tool.started'] }
      }]
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects bare-prefix wildcard without allow_wildcard', () => {
    const parsed = AgentConfigSchema.safeParse({
      ...baseConfig(),
      umbilical_taps: [{
        name: 'prefix',
        lambda: 'lib/t.ts:fn',
        filter: { event_types: ['tool.*'] }
      }]
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects "*" without allow_wildcard', () => {
    const parsed = AgentConfigSchema.safeParse({
      ...baseConfig(),
      umbilical_taps: [{
        name: 'star',
        lambda: 'lib/t.ts:fn',
        filter: { event_types: ['*'] }
      }]
    })
    expect(parsed.success).toBe(false)
  })

  it('accepts "*" with allow_wildcard: true', () => {
    const parsed = AgentConfigSchema.safeParse({
      ...baseConfig(),
      umbilical_taps: [{
        name: 'star-ok',
        lambda: 'lib/t.ts:fn',
        filter: { event_types: ['*'], allow_wildcard: true }
      }]
    })
    expect(parsed.success).toBe(true)
  })

  it('applies defaults for exclude_own_origin and max_rate_per_sec', () => {
    const parsed = AgentConfigSchema.parse({
      ...baseConfig(),
      umbilical_taps: [{
        name: 'defaults',
        lambda: 'lib/t.ts:fn',
        filter: { event_types: ['db.write'] }
      }]
    })
    const tap = parsed.umbilical_taps![0]
    expect(tap.exclude_own_origin).toBe(true)
    expect(tap.max_rate_per_sec).toBe(100)
  })
})
