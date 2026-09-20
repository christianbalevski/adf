import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createChatGPTSubscriptionProvider,
  describeCodexRequest,
  patchCodexRequestBody,
  INSTRUCTIONS_ID_HEADER,
} from '../../../src/main/providers/chatgpt-subscription'

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

  it('skips the deep walk when the caller pre-scanned and found nothing repairable', () => {
    const half = '🚀'.slice(0, 1)
    const body = sdkBody({ input: [{ role: 'user', content: [{ type: 'input_text', text: half }] }] })
    const { repairedStrings } = patchCodexRequestBody(body, SYSTEM, undefined, { repairStrings: false })
    expect(repairedStrings).toBe(0)
    const text = (body.input as Array<{ content: Array<{ text: string }> }>)[0].content[0].text
    expect(text).toBe(half) // untouched — the opt-out is the caller's promise, not a guess
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

/**
 * The fetch wrapper pre-scans the serialized body instead of deep-walking it on
 * every turn. The repair itself must stay effective — a lone surrogate reaching
 * the codex backend is an opaque 400.
 */
/** Drive the real fetch wrapper end to end and return the exact bytes it sent. */
async function captureWireBody(
  text: string,
  instructions?: string,
  extraParams?: Record<string, unknown>
): Promise<string> {
  const fetchSpy = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('request captured'))
  vi.stubGlobal('fetch', fetchSpy)
  const { provider, beginRequest } = createChatGPTSubscriptionProvider({
    getValidAccessToken: async () => 'test-token',
    getAccountId: () => 'test-account',
  }, extraParams)
  // Production path: instructions are bound to THIS request via a private
  // header id, the way AiSdkProvider passes them.
  const scope = beginRequest(instructions)

  try {
    await expect(provider.responses('gpt-5.4').doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text }] }],
      headers: scope.headers,
    })).rejects.toThrow('request captured')
  } finally {
    scope.release()
  }

  // The private routing header must never leave the process.
  const sentHeaders = new Headers(fetchSpy.mock.calls[0][1]?.headers)
  expect(sentHeaders.get(INSTRUCTIONS_ID_HEADER)).toBeNull()

  return String(fetchSpy.mock.calls[0][1]?.body)
}

describe('surrogate repair through the fetch wrapper', () => {
  afterEach(() => vi.unstubAllGlobals())

  async function sendPrompt(text: string, instructions?: string): Promise<Record<string, unknown>> {
    return JSON.parse(await captureWireBody(text, instructions))
  }

  it('still repairs a lone surrogate in the input text', async () => {
    const body = await sendPrompt('cut mid-emoji ' + '🚀'.slice(0, 1))
    const sent = JSON.stringify(body)
    expect(sent).not.toMatch(/\\ud83d(?!\\ud)/i)
    expect(sent).toContain('�')
  })

  it('still repairs a lone surrogate that arrives only via the request instructions', async () => {
    const body = await sendPrompt('hi', 'sys ' + '🚀'.slice(0, 1))
    expect(body.instructions).toBe('sys �')
  })

  it('leaves a well-formed body — including paired astral characters — intact', async () => {
    const body = await sendPrompt('hi 🚀 done', 'Reply briefly.')
    expect(JSON.stringify(body)).not.toContain('�')
    expect(body.instructions).toBe('Reply briefly.')
    expect(body.store).toBe(false)
    expect(body.stream).toBe(true)
  })
})

/**
 * Wire-byte lock. These golden strings are the EXACT bytes the fetch wrapper
 * put on the socket, captured from the implementation as of 2026-09-20. Any
 * refactor of the body-patching path (e.g. moving it out of the fetch wrapper
 * into an SDK body-transform hook) must reproduce them byte for byte — key
 * order included, because the codex backend is unforgiving and its 400s are
 * opaque. Regenerate only with a deliberate, reviewed wire change.
 */
describe('wire-byte identity', () => {
  afterEach(() => vi.unstubAllGlobals())

  const HALF_ROCKET = '🚀'.slice(0, 1) // lone high surrogate — an opaque 400 if it escapes
  const HEAD = '{"model":"gpt-5.4","input":[{"role":"user","content":[{"type":"input_text","text":'

  const CASES: Array<{
    name: string
    args: [string, (string | undefined)?, (Record<string, unknown> | undefined)?]
    wire: string
  }> = [
    {
      name: 'plain request (no instructions, no extraParams)',
      args: ['hi'],
      wire: HEAD + '"hi"}]}],"stream":true,"store":false,"instructions":"You are a helpful assistant."}',
    },
    {
      name: 'instructions bound to the request',
      args: ['hi', 'Reply briefly.'],
      wire: HEAD + '"hi"}]}],"stream":true,"store":false,"instructions":"Reply briefly."}',
    },
    {
      name: 'extraParams (added key + null-deleted key)',
      args: ['hi', 'Reply briefly.', { reasoning: { effort: 'low' }, max_output_tokens: null }],
      wire: HEAD + '"hi"}]}],"stream":true,"store":false,"instructions":"Reply briefly.","reasoning":{"effort":"low"}}',
    },
    {
      name: 'lone surrogate in the input text',
      args: ['cut mid-emoji ' + HALF_ROCKET],
      wire: HEAD + '"cut mid-emoji �"}]}],"stream":true,"store":false,"instructions":"You are a helpful assistant."}',
    },
    {
      name: 'lone surrogate arriving only via the request instructions',
      args: ['hi', 'sys ' + HALF_ROCKET],
      wire: HEAD + '"hi"}]}],"stream":true,"store":false,"instructions":"sys �"}',
    },
    {
      name: 'paired astral characters pass through untouched',
      args: ['hi 🚀 done', 'Reply 🚀 briefly.'],
      wire: HEAD + '"hi 🚀 done"}]}],"stream":true,"store":false,"instructions":"Reply 🚀 briefly."}',
    },
  ]

  for (const { name, args, wire } of CASES) {
    it(`sends identical bytes — ${name}`, async () => {
      expect(await captureWireBody(...args)).toBe(wire)
    })
  }

  it('never puts a bare \\udXXX escape on the wire', async () => {
    for (const { args } of CASES) {
      expect(await captureWireBody(...args)).not.toMatch(/\\u[dD][89abAB][0-9a-fA-F]{2}/)
      vi.unstubAllGlobals()
    }
  })
})
