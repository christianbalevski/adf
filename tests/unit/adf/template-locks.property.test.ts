// Template locks propagate: whatever a template locks (a whole section, one
// field by its dotted path, or an item marked locked: true) an agent creating
// a child from it (sys_create_adf → mergeTemplateWithOverrides) cannot change,
// and the child keeps the locks. Leaving a locked field out, or setting it to
// the value it already has, is fine; only a change is refused.
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { mergeTemplateWithOverrides } from '../../../src/main/adf/adf-template'
import { createHeadlessAgent, MockLLMProvider } from '../../../src/main/runtime/headless'
import type { AgentConfig } from '../../../src/shared/types/adf-v02.types'

const base: AgentConfig = (() => {
  const agent = createHeadlessAgent({ provider: new MockLLMProvider() })
  const config = structuredClone(agent.workspace.getAgentConfig())
  agent.dispose()
  return config
})()

const get = (obj: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj)

// Every scalar field under the sections an override can touch, as dotted paths.
const SECTIONS = ['model', 'context', 'security', 'limits', 'messaging', 'code_execution'] as const
const leafPaths = SECTIONS.flatMap((section) => {
  const value = base[section] as Record<string, unknown> | undefined
  return value ? Object.keys(value).filter((k) => value[k] === null || typeof value[k] !== 'object').map((k) => `${section}.${k}`) : []
})
const TOP_LEVEL = ['description', 'instructions', 'icon', 'autonomous', 'autostart', 'start_in_state'] as const

const lockArb = fc.uniqueArray(fc.constantFrom<string>(...SECTIONS, ...TOP_LEVEL, ...leafPaths), { maxLength: 4 })
const scalar = fc.oneof(fc.boolean(), fc.integer({ min: 0, max: 100_000 }), fc.string({ maxLength: 8 }))

// Overrides that set some leaves, some top-level fields, and some tools.
const overridesArb = fc.record({
  leaves: fc.uniqueArray(fc.tuple(fc.constantFrom(...leafPaths), scalar), { maxLength: 4, selector: ([p]) => p }),
  top: fc.uniqueArray(fc.tuple(fc.constantFrom(...TOP_LEVEL), scalar), { maxLength: 2, selector: ([p]) => p }),
  tools: fc.uniqueArray(fc.tuple(fc.constantFrom(...base.tools.map((t) => t.name)), fc.boolean()), { maxLength: 3, selector: ([n]) => n }),
})
const toolLocksArb = fc.uniqueArray(fc.constantFrom(...base.tools.map((t) => t.name)), { maxLength: 3 })

describe('template locks (property)', () => {
  it('a child created from a template keeps every locked value and every lock', () => {
    fc.assert(
      fc.property(lockArb, toolLocksArb, overridesArb, (locks, lockedTools, o) => {
        const template: AgentConfig = {
          ...structuredClone(base),
          // The merge always forces this off unless the caller asks (a template
          // cannot pre-grant it); start from that so it compares equal.
          security: { ...base.security, allow_local_fetch: false },
          locked_fields: locks,
          tools: base.tools.map((t) => (lockedTools.includes(t.name) ? { ...t, locked: true } : t)),
        }
        const overrides: Record<string, unknown> = {}
        for (const [path, value] of o.leaves) {
          const [section, key] = path.split('.')
          overrides[section] = { ...(overrides[section] as object), [key]: value }
        }
        for (const [key, value] of o.top) overrides[key] = value
        if (o.tools.length) overrides.tools = o.tools.map(([name, enabled]) => ({ name, enabled }))

        const result = mergeTemplateWithOverrides(template, overrides)
        if (!result.ok) {
          // Refused only for an override that changes a locked value.
          const changed = [...o.leaves, ...o.top].some(([path, value]) =>
            locks.some((lock) => (path === lock || path.startsWith(`${lock}.`)) && !Object.is(value, get(template, path))))
          const toolChanged = o.tools.some(([name, enabled]) =>
            lockedTools.includes(name) && enabled !== template.tools.find((t) => t.name === name)?.enabled)
          expect(changed || toolChanged, `refused (${result.error}) with no locked value changed; overrides ${JSON.stringify(overrides)}`).toBe(true)
          return
        }
        const child = result.options as unknown as Record<string, unknown>
        for (const lock of locks) {
          expect(get(child, lock), `locked '${lock}' changed; overrides ${JSON.stringify(overrides)}`).toEqual(get(template, lock))
        }
        expect(child.locked_fields ?? []).toEqual(expect.arrayContaining(locks))
        for (const name of lockedTools) {
          const tool = (child.tools as AgentConfig['tools']).find((t) => t.name === name)
          expect(tool, `locked tool ${name}`).toEqual(template.tools.find((t) => t.name === name))
        }
      }),
      { numRuns: 500 },
    )
  })

  const locked = (locked_fields: string[], extra: Partial<AgentConfig> = {}): AgentConfig =>
    ({ ...structuredClone(base), security: { ...base.security, allow_local_fetch: false }, locked_fields, ...extra })

  it('omitting a locked field keeps the template value', () => {
    const result = mergeTemplateWithOverrides(locked(['model.model_id']), { model: { temperature: 0.2 } as AgentConfig['model'] })
    expect(result.ok && result.options.model.model_id).toBe(base.model.model_id)
    expect(result.ok && result.options.model.temperature).toBe(0.2)
  })

  it('setting a locked field to its current value is not a change', () => {
    const result = mergeTemplateWithOverrides(locked(['model.model_id']), { model: { model_id: base.model.model_id } as AgentConfig['model'] })
    expect(result.ok).toBe(true)
  })

  it('changing a locked field is refused and names it', () => {
    const result = mergeTemplateWithOverrides(locked(['model.model_id']), { model: { model_id: 'other' } as AgentConfig['model'] })
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error).toContain("'model.model_id'")
  })

  it('a section replaced whole keeps its locked field', () => {
    const template = locked(['logging.default_level'], { logging: { default_level: 'warn', max_rows: 100 } as AgentConfig['logging'] })
    const result = mergeTemplateWithOverrides(template, { logging: { max_rows: 5 } as AgentConfig['logging'] })
    expect(result.ok && result.options.logging).toEqual({ default_level: 'warn', max_rows: 5 })
  })
})
