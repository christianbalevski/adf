import { describe, expect, it } from 'vitest'
import { DEFAULT_AGENT_CONFIG } from '../src/shared/constants/adf-defaults'
import { DEFAULT_TOOLS } from '../src/shared/types/adf-v02.types'
import { diffAgentTemplate, mergeAgentTemplate } from '../src/shared/utils/agent-template'

describe('mergeAgentTemplate', () => {
  it('returns the code defaults for an empty or missing template', () => {
    expect(mergeAgentTemplate(DEFAULT_AGENT_CONFIG, undefined)).toEqual(DEFAULT_AGENT_CONFIG)
    expect(mergeAgentTemplate(DEFAULT_AGENT_CONFIG, {})).toEqual(DEFAULT_AGENT_CONFIG)
  })

  it('does not share references with the defaults', () => {
    const merged = mergeAgentTemplate(DEFAULT_AGENT_CONFIG, {})
    expect(merged.tools).not.toBe(DEFAULT_AGENT_CONFIG.tools)
    expect(merged.limits).not.toBe(DEFAULT_AGENT_CONFIG.limits)
  })

  it('deep-merges object sections and skips undefined', () => {
    const merged = mergeAgentTemplate(DEFAULT_AGENT_CONFIG, {
      model: { temperature: 0.2, model_id: undefined },
      limits: { execution_timeout_ms: 120_000 },
    })
    expect(merged.model).toEqual({ ...DEFAULT_AGENT_CONFIG.model, temperature: 0.2 })
    expect(merged.limits).toEqual({ ...DEFAULT_AGENT_CONFIG.limits, execution_timeout_ms: 120_000 })
  })

  it('replaces arrays instead of concatenating', () => {
    const tools = [{ name: 'fs_read', enabled: true, visible: true }]
    const merged = mergeAgentTemplate(DEFAULT_AGENT_CONFIG, { tools })
    expect(merged.tools).toEqual(tools)
    expect(merged.tools).not.toBe(tools)
  })

  it('treats null as a value', () => {
    const merged = mergeAgentTemplate(DEFAULT_AGENT_CONFIG, { limits: { max_active_turns: null } })
    expect(merged.limits.max_active_turns).toBeNull()
  })
})

describe('diffAgentTemplate', () => {
  it('is empty when nothing differs', () => {
    expect(diffAgentTemplate(DEFAULT_AGENT_CONFIG, mergeAgentTemplate(DEFAULT_AGENT_CONFIG, {}))).toEqual({})
  })

  it('keeps only the differing keys of object sections', () => {
    const effective = mergeAgentTemplate(DEFAULT_AGENT_CONFIG, { model: { max_tokens: 8192 }, autonomous: true })
    expect(diffAgentTemplate(DEFAULT_AGENT_CONFIG, effective)).toEqual({ model: { max_tokens: 8192 }, autonomous: true })
  })

  it('keeps a changed tool list whole', () => {
    const tools = DEFAULT_TOOLS.map((t) => (t.name === 'fs_delete' ? { ...t, enabled: true, visible: true } : t))
    const diff = diffAgentTemplate(DEFAULT_AGENT_CONFIG, { ...DEFAULT_AGENT_CONFIG, tools })
    expect(diff).toEqual({ tools })
  })

  it('round-trips through merge', () => {
    const template = { instructions: 'Do the thing.', messaging: { receive: false }, model: { provider: 'p1' } }
    const effective = mergeAgentTemplate(DEFAULT_AGENT_CONFIG, template)
    expect(diffAgentTemplate(DEFAULT_AGENT_CONFIG, effective)).toEqual(template)
  })
})
