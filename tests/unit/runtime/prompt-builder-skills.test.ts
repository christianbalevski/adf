import { describe, expect, it } from 'vitest'
import { assemblePrompt } from '../../../src/main/runtime/prompt-builder'
import { DEFAULT_TOOL_PROMPTS } from '../../../src/shared/constants/adf-defaults'

const toolPrompts = { _skills: 'full skills doctrine', _skills_stub: 'skills stub pointer' }

describe('skills prompt section', () => {
  it('injects the full section when skills.enabled', () => {
    const prompt = assemblePrompt({
      config: { skills: { enabled: true } } as never,
      basePrompt: '',
      toolPrompts,
      enabledTools: new Set(),
      shellEnabled: false,
    })
    expect(prompt).toContain('full skills doctrine')
    expect(prompt).not.toContain('skills stub pointer')
  })

  it('injects the stub when skills is absent or disabled', () => {
    for (const config of [{}, { skills: { enabled: false } }]) {
      const prompt = assemblePrompt({
        config: config as never,
        basePrompt: '',
        toolPrompts,
        enabledTools: new Set(),
        shellEnabled: false,
      })
      expect(prompt).toContain('skills stub pointer')
      expect(prompt).not.toContain('full skills doctrine')
    }
  })

  it('ships a default section carrying the registry placeholder', () => {
    // Without this token the section describes a catalog that never arrives.
    expect(DEFAULT_TOOL_PROMPTS._skills).toContain('{{skills-registry.json}}')
    expect(DEFAULT_TOOL_PROMPTS._skills_stub).not.toContain('{{skills-registry.json}}')
  })
})
