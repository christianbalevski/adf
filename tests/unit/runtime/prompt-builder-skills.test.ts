import { describe, expect, it } from 'vitest'
import { assemblePrompt } from '../../../src/main/runtime/prompt-builder'
import { DEFAULT_TOOL_PROMPTS, TOOL_PROMPT_LABELS, TOOL_PROMPT_CONDITIONS } from '../../../src/shared/constants/adf-defaults'

const toolPrompts = { _skills: 'full skills doctrine' }

describe('skills prompt section', () => {
  it('injects the section for every agent, with no config to consult', () => {
    // There is no skills config any more: indexing and injection are
    // unconditional, so an empty config must still get the section.
    for (const config of [{}, { serving: {} }, { messaging: {} }]) {
      const prompt = assemblePrompt({
        config: config as never,
        basePrompt: '',
        toolPrompts,
        enabledTools: new Set(),
        shellEnabled: false,
      })
      expect(prompt).toContain('full skills doctrine')
    }
  })

  it('ships a default section carrying the registry placeholder', () => {
    // Without this token the section describes a catalog that never arrives.
    expect(DEFAULT_TOOL_PROMPTS._skills).toContain('{{skills-registry.json}}')
  })

  it('keeps no stub section, label, or condition behind', () => {
    expect(DEFAULT_TOOL_PROMPTS._skills_stub).toBeUndefined()
    expect(TOOL_PROMPT_LABELS._skills_stub).toBeUndefined()
    expect(TOOL_PROMPT_CONDITIONS._skills_stub).toBeUndefined()
    expect(TOOL_PROMPT_CONDITIONS._skills).toContain('Always injected')
  })

  it('states the file-based install and mute affordances, and the authority limit', () => {
    const section = DEFAULT_TOOL_PROMPTS._skills
    expect(section).toContain('skills-state.json')
    expect(section).toContain('sys_fetch')
    expect(section).toContain('rejected')
    expect(section).toContain('instructions, not authority')
    // Lean by instruction: the section is a short brief, not a manual.
    expect(section.split('\n').filter((line) => line.trim()).length).toBeLessThanOrEqual(12)
  })
})
