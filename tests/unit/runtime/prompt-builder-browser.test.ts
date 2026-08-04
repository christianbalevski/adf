import { describe, expect, it } from 'vitest'
import { assemblePrompt } from '../../../src/main/runtime/prompt-builder'

describe('visible browser prompt', () => {
  it('instructs an isolated browser agent to hand security checks to its principal', () => {
    const prompt = assemblePrompt({
      config: { compute: { enabled: true, browser: true } } as any,
      basePrompt: '',
      toolPrompts: { _browser: 'Pause for CAPTCHA or MFA and ask your principal.' },
      enabledTools: new Set(),
      shellEnabled: false,
    })
    expect(prompt).toContain('Pause for CAPTCHA or MFA')
  })

  it('does not inject browser guidance when the visible browser is disabled', () => {
    const prompt = assemblePrompt({
      config: { compute: { enabled: true, browser: false } } as any,
      basePrompt: '',
      toolPrompts: { _browser: 'browser guidance' },
      enabledTools: new Set(),
      shellEnabled: false,
    })
    expect(prompt).not.toContain('browser guidance')
  })
})
