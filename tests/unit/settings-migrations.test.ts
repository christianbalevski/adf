import { describe, it, expect } from 'vitest'
import { applySettingsMigrations, LEGACY_MIND_PROMPT_SECTION } from '../../src/shared/utils/settings-migrations'
import { MIND_PROMPT_SECTION, SOUL_PROMPT_SECTION, DEFAULT_TOOL_PROMPTS, DEFAULT_DYNAMIC_PROMPTS } from '../../src/shared/constants/adf-defaults'

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

describe('settings migrations — toolPrompts backfill and stale-key removal', () => {
  it('backfills missing tool prompt AND dynamic instruction keys from defaults', () => {
    const data: Record<string, unknown> = { toolPrompts: { code_execution: 'my custom section' } }
    const result = applySettingsMigrations(data)
    expect(result.changedKeys).toContain('toolPrompts')
    const prompts = data.toolPrompts as Record<string, string>
    // Custom value preserved, missing keys backfilled from both records.
    expect(prompts.code_execution).toBe('my custom section')
    expect(prompts._messaging).toBe(DEFAULT_TOOL_PROMPTS._messaging)
    expect(prompts._autonomous).toBe(DEFAULT_TOOL_PROMPTS._autonomous)
    expect(prompts.dyn_inbox_hint).toBe(DEFAULT_DYNAMIC_PROMPTS.dyn_inbox_hint)
    expect(prompts.dyn_idle_reminder).toBe(DEFAULT_DYNAMIC_PROMPTS.dyn_idle_reminder)
  })

  it('removes the stale adf_shell key — its guide moved into the ShellTool description', () => {
    const data: Record<string, unknown> = {
      toolPrompts: { ...DEFAULT_TOOL_PROMPTS, ...DEFAULT_DYNAMIC_PROMPTS, adf_shell: '## Shell\n\nold guide' }
    }
    const result = applySettingsMigrations(data)
    expect(result.changedKeys).toContain('toolPrompts')
    expect('adf_shell' in (data.toolPrompts as Record<string, string>)).toBe(false)
  })

  it('is idempotent — a second run changes nothing', () => {
    const data: Record<string, unknown> = { toolPrompts: { adf_shell: 'x' } }
    applySettingsMigrations(data)
    const after = JSON.stringify(data.toolPrompts)
    const second = applySettingsMigrations(data)
    expect(second.changedKeys).not.toContain('toolPrompts')
    expect(JSON.stringify(data.toolPrompts)).toBe(after)
  })

  it('leaves an absent toolPrompts record alone — defaults apply at read time', () => {
    const data: Record<string, unknown> = {}
    const result = applySettingsMigrations(data)
    expect('toolPrompts' in data).toBe(false)
    expect(result.changedKeys).not.toContain('toolPrompts')
  })
})
