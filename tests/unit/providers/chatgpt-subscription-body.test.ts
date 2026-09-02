import { describe, expect, it } from 'vitest'
import { describeCodexRequest, patchCodexRequestBody } from '../../../src/main/providers/chatgpt-subscription'

const SYSTEM = 'You are an ADF agent — a learning system that gets better over time.'

function sdkBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: 'gpt-5.4',
    input: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    ],
    max_output_tokens: 4096,
    ...overrides,
  }
}

describe('patchCodexRequestBody', () => {
  it('does NOT duplicate the system prompt when it arrives via both pendingInstructions and input', () => {
    const body = sdkBody()
    patchCodexRequestBody(body, SYSTEM)

    expect(body.instructions).toBe(SYSTEM)
    // system item stripped from input, user message kept
    expect((body.input as unknown[]).length).toBe(1)
    expect((body.input as Array<{ role: string }>)[0].role).toBe('user')
  })

  it('uses the input system message when no pendingInstructions were set', () => {
    const body = sdkBody()
    patchCodexRequestBody(body, undefined)
    expect(body.instructions).toBe(SYSTEM)
    expect((body.input as unknown[]).length).toBe(1)
  })

  it('uses pendingInstructions when input has no system message', () => {
    const body = sdkBody({ input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] })
    patchCodexRequestBody(body, SYSTEM)
    expect(body.instructions).toBe(SYSTEM)
  })

  it('appends genuinely different system content instead of dropping it', () => {
    const notice = 'System notice: the workspace was reset.'
    const body = sdkBody({ input: [
      { role: 'system', content: notice },
      { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    ] })
    patchCodexRequestBody(body, SYSTEM)
    expect(body.instructions).toBe(SYSTEM + '\n\n' + notice)
  })

  it('handles array-form system content parts', () => {
    const body = sdkBody({ input: [
      { role: 'system', content: [{ type: 'input_text', text: SYSTEM }] },
      { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    ] })
    patchCodexRequestBody(body, SYSTEM)
    expect(body.instructions).toBe(SYSTEM)
  })

  it('does NOT duplicate the system prompt when the SDK emits it as role "developer" (reasoning models)', () => {
    const body = sdkBody({ input: [
      { role: 'developer', content: SYSTEM },
      { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    ] })
    patchCodexRequestBody(body, SYSTEM)
    expect(body.instructions).toBe(SYSTEM)
    expect((body.input as unknown[]).length).toBe(1)
    expect((body.input as Array<{ role: string }>)[0].role).toBe('user')
  })

  it('handles developer-role array-form content parts', () => {
    const body = sdkBody({ input: [
      { role: 'developer', content: [{ type: 'input_text', text: SYSTEM }] },
      { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    ] })
    patchCodexRequestBody(body, SYSTEM)
    expect(body.instructions).toBe(SYSTEM)
    expect((body.input as unknown[]).length).toBe(1)
  })

  it('sets backend-required fields and strips max_output_tokens', () => {
    const body = sdkBody()
    patchCodexRequestBody(body, SYSTEM)
    expect(body.store).toBe(false)
    expect(body.stream).toBe(true)
    expect('max_output_tokens' in body).toBe(false)
  })

  it('falls back to a default instructions string when nothing is provided', () => {
    const body = sdkBody({ input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] })
    patchCodexRequestBody(body, undefined)
    expect(body.instructions).toBe('You are a helpful assistant.')
  })

  it('applies extraParams last, with null deleting keys', () => {
    const body = sdkBody()
    patchCodexRequestBody(body, SYSTEM, { reasoning: { effort: 'low' }, stream: null })
    expect(body.reasoning).toEqual({ effort: 'low' })
    expect('stream' in body).toBe(false)
  })

  it('repairs lone UTF-16 surrogates anywhere in the body (codex 400s on them)', () => {
    const half = '🚀'.slice(0, 1)
    const body = sdkBody({ input: [
      { role: 'user', content: [{ type: 'input_text', text: 'transcript cut mid-emoji ' + half }] },
    ] })
    const { repairedStrings } = patchCodexRequestBody(body, 'sys ' + half)
    expect(repairedStrings).toBe(2)
    expect(body.instructions).toBe('sys �')
    const text = (body.input as Array<{ content: Array<{ text: string }> }>)[0].content[0].text
    expect(text.endsWith('�')).toBe(true)
    // JSON.stringify would otherwise emit a bare \ud83d escape
    expect(JSON.stringify(body)).not.toMatch(/\\ud83d(?!\\ud)/i)
  })

  it('leaves well-formed bodies untouched', () => {
    const body = sdkBody({ input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi 🚀' }] }] })
    expect(patchCodexRequestBody(body, SYSTEM).repairedStrings).toBe(0)
  })

  it('describeCodexRequest summarizes the request shape', () => {
    const body = sdkBody()
    patchCodexRequestBody(body, SYSTEM)
    const summary = describeCodexRequest(body, 1234)
    expect(summary).toContain('model=gpt-5.4')
    expect(summary).toContain('input_items=1')
    expect(summary).toContain(`instructions_chars=${SYSTEM.length}`)
    expect(summary).toContain('tools=0')
    expect(summary).toContain('body_chars=1234')
  })
})
