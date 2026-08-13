import { describe, it, expect } from 'vitest'
import { applySettingsMigrations, LEGACY_MIND_PROMPT_SECTION } from '../../src/shared/utils/settings-migrations'
import { MIND_PROMPT_SECTION, SOUL_PROMPT_SECTION } from '../../src/shared/constants/adf-defaults'

const CUSTOM_BASE = 'You are a custom agent. Do custom things.'

describe('settings migrations — globalSystemPrompt mind section', () => {
  it('replaces the legacy mind section verbatim with the new mind-wiki section', () => {
    const data: Record<string, unknown> = {
      globalSystemPrompt: CUSTOM_BASE + SOUL_PROMPT_SECTION + LEGACY_MIND_PROMPT_SECTION
    }
    const result = applySettingsMigrations(data)
    expect(result.changedKeys).toContain('globalSystemPrompt')
    const prompt = data.globalSystemPrompt as string
    expect(prompt).toBe(CUSTOM_BASE + SOUL_PROMPT_SECTION + MIND_PROMPT_SECTION)
    expect(prompt).not.toContain(LEGACY_MIND_PROMPT_SECTION)
    expect(prompt).toContain('{{mind.md}}')
  })

  it('replaces a legacy section that is not at the end of the prompt', () => {
    const trailing = '\n\n## Extra Custom Section\n\nMore rules.'
    const data: Record<string, unknown> = {
      globalSystemPrompt: CUSTOM_BASE + SOUL_PROMPT_SECTION + LEGACY_MIND_PROMPT_SECTION + trailing
    }
    applySettingsMigrations(data)
    expect(data.globalSystemPrompt).toBe(CUSTOM_BASE + SOUL_PROMPT_SECTION + MIND_PROMPT_SECTION + trailing)
  })

  it('appends the new section when the prompt lacks {{mind.md}} entirely', () => {
    const data: Record<string, unknown> = {
      globalSystemPrompt: CUSTOM_BASE + SOUL_PROMPT_SECTION
    }
    const result = applySettingsMigrations(data)
    expect(result.changedKeys).toContain('globalSystemPrompt')
    expect(data.globalSystemPrompt).toBe(CUSTOM_BASE + SOUL_PROMPT_SECTION + MIND_PROMPT_SECTION)
  })

  it('leaves a customized prompt that already contains {{mind.md}} untouched', () => {
    const custom = CUSTOM_BASE + SOUL_PROMPT_SECTION + '\n\n## My Own Mind Rules\n\nDo it my way.\n\n{{mind.md}}'
    const data: Record<string, unknown> = { globalSystemPrompt: custom }
    applySettingsMigrations(data)
    expect(data.globalSystemPrompt).toBe(custom)
  })

  it('replaces a CRLF-saved legacy section (line-ending agnostic match)', () => {
    const crlfLegacy = LEGACY_MIND_PROMPT_SECTION.replace(/\n/g, '\r\n')
    const data: Record<string, unknown> = {
      globalSystemPrompt: CUSTOM_BASE + SOUL_PROMPT_SECTION + crlfLegacy
    }
    const result = applySettingsMigrations(data)
    expect(result.changedKeys).toContain('globalSystemPrompt')
    const prompt = data.globalSystemPrompt as string
    // Output is the normalized (LF) prompt with the new section in place.
    expect(prompt).toBe(CUSTOM_BASE + SOUL_PROMPT_SECTION + MIND_PROMPT_SECTION)
    expect(prompt).not.toContain('\r\n')
    expect(prompt).toContain('{{mind.md}}')
  })

  it('is idempotent — a second run changes nothing', () => {
    const data: Record<string, unknown> = {
      globalSystemPrompt: CUSTOM_BASE + SOUL_PROMPT_SECTION + LEGACY_MIND_PROMPT_SECTION
    }
    applySettingsMigrations(data)
    const once = data.globalSystemPrompt
    const second = applySettingsMigrations(data)
    expect(data.globalSystemPrompt).toBe(once)
    expect(second.changedKeys).not.toContain('globalSystemPrompt')
  })

  it('ignores a missing/non-string globalSystemPrompt', () => {
    const data: Record<string, unknown> = {}
    const result = applySettingsMigrations(data)
    expect('globalSystemPrompt' in data).toBe(false)
    expect(result.changedKeys).not.toContain('globalSystemPrompt')
  })

  it('backfills soul before mind so both sections land in soul-then-mind order', () => {
    const data: Record<string, unknown> = { globalSystemPrompt: CUSTOM_BASE }
    applySettingsMigrations(data)
    expect(data.globalSystemPrompt).toBe(CUSTOM_BASE + SOUL_PROMPT_SECTION + MIND_PROMPT_SECTION)
  })
})
