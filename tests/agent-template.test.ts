import { describe, expect, it } from 'vitest'
import { DEFAULT_AGENT_CONFIG } from '../src/shared/constants/adf-defaults'
import { DEFAULT_TOOLS } from '../src/shared/types/adf-v02.types'
import { diffAgentTemplate, mergeAgentTemplate } from '../src/shared/utils/agent-template'

describe('mergeAgentTemplate', () => {
  it('returns the code defaults for an empty or missing template', () => {
    expect(mergeAgentTemplate(DEFAULT_AGENT_CONFIG, undefined)).toEqual(DEFAULT_AGENT_CONFIG)
    expect(mergeAgentTemplate(DEFAULT_AGENT_CONFIG, {})).toEqual(DEFAULT_AGENT_CONFIG)
  })

  it('starts new agents with blank instructions', () => {
    expect(DEFAULT_AGENT_CONFIG.instructions).toBe('')
    expect(mergeAgentTemplate(DEFAULT_AGENT_CONFIG, {}).instructions).toBe('')
  })

  it('does not share references with the defaults', () => {
    const merged = mergeAgentTemplate(DEFAULT_AGENT_CONFIG, {})
    expect(merged.tools).not.toBe(DEFAULT_AGENT_CONFIG.tools)
    expect(merged.limits).not.toBe(DEFAULT_AGENT_CONFIG.limits)
    expect(merged.triggers).not.toBe(DEFAULT_AGENT_CONFIG.triggers)
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

  it('merges nested sections (triggers) without touching sibling keys', () => {
    const merged = mergeAgentTemplate(DEFAULT_AGENT_CONFIG, { triggers: { on_timer: { enabled: false } } })
    expect(merged.triggers.on_timer).toEqual({ ...DEFAULT_AGENT_CONFIG.triggers.on_timer, enabled: false })
    expect(merged.triggers.on_inbox).toEqual(DEFAULT_AGENT_CONFIG.triggers.on_inbox)
    expect(merged.triggers.on_chat).toEqual(DEFAULT_AGENT_CONFIG.triggers.on_chat)
  })

  it('merges nested sections (serving) and adds sections the defaults lack', () => {
    const merged = mergeAgentTemplate(DEFAULT_AGENT_CONFIG, {
      serving: { public: { enabled: true } },
      recovery: { max_attempts: 7 },
    })
    expect(merged.serving).toEqual({ ...DEFAULT_AGENT_CONFIG.serving, public: { enabled: true } })
    expect(merged.recovery).toEqual({ max_attempts: 7 })
  })

  it('ignores seed files and per-agent keys', () => {
    const merged = mergeAgentTemplate(DEFAULT_AGENT_CONFIG, {
      files: { readme: '# Hi', mind: '# Mind' },
      ...({ name: 'nope', id: 'x', state: 'idle' } as object),
    })
    expect(merged).toEqual(DEFAULT_AGENT_CONFIG)
    expect('files' in merged).toBe(false)
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

  it('diffs nested sections down to the changed leaf', () => {
    const effective = mergeAgentTemplate(DEFAULT_AGENT_CONFIG, {
      triggers: { on_timer: { enabled: false } },
      serving: { public: { enabled: true } },
    })
    expect(diffAgentTemplate(DEFAULT_AGENT_CONFIG, effective)).toEqual({
      triggers: { on_timer: { enabled: false } },
      serving: { public: { enabled: true } },
    })
  })

  it('never emits per-agent keys', () => {
    const effective = { ...DEFAULT_AGENT_CONFIG, name: 'Other', description: 'd', state: 'idle' as const }
    expect(diffAgentTemplate(DEFAULT_AGENT_CONFIG, effective)).toEqual({})
  })

  it('round-trips through merge', () => {
    const template = {
      instructions: 'Do the thing.',
      messaging: { receive: false },
      model: { provider: 'p1' },
      triggers: { on_startup: { enabled: true } },
      logging: { default_level: 'debug' as const },
    }
    const effective = mergeAgentTemplate(DEFAULT_AGENT_CONFIG, template)
    expect(diffAgentTemplate(DEFAULT_AGENT_CONFIG, effective)).toEqual(template)
  })
})
