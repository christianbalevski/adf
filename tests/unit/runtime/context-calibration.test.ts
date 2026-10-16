import { describe, it, expect } from 'vitest'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import type { LanguageModel } from 'ai'
import { AiSdkProvider } from '../../../src/main/providers/ai-sdk-provider'
import { ClaudeSubscriptionProvider } from '../../../src/main/providers/claude-subscription/provider'
import type { TurnResult } from '../../../src/main/providers/claude-subscription/session'
import { buildLlmCallMetadata, callLlmWithMetadata, loopTokensFromLlmMetadata } from '../../../src/main/runtime/llm-call-metadata'
import { findLastCall } from '../../../src/main/runtime/context-breakdown'
import type { LLMProvider } from '../../../src/main/providers/provider.interface'
import type { LLMResponse } from '../../../src/shared/types/provider.types'
import type { LoopTokenUsage } from '../../../src/shared/types/adf-v02.types'

describe('findLastCall', () => {
  const messages = [{ seq: 1 }, { seq: 2 }, { seq: 3 }, { seq: 4 }]
  const row = (seq: number, tokens: LoopTokenUsage) => ({ seq, tokens })

  it('cuts at the newest usage row and returns its real prompt size', () => {
    expect(findLastCall([row(2, { input: 50_000 }), row(3, { input: 94_000, output: 300 })], messages, false))
      .toEqual({ index: 2, promptTokens: 94_000 })
  })

  it('returns null with no recorded usage', () => {
    expect(findLastCall([], messages, false)).toBeNull()
    expect(findLastCall([row(3, { input: 0, output: 0 })], messages, false)).toBeNull()
  })

  it('returns null when the provider reported no usage (char estimate)', () => {
    expect(findLastCall([row(3, { input: 94_000, estimated: true })], messages, false)).toBeNull()
  })

  it('returns null after a compaction or clear (estimated baseline)', () => {
    expect(findLastCall([row(3, { input: 94_000 })], messages, true)).toBeNull()
  })

  it('returns null when the row is no longer in the session', () => {
    expect(findLastCall([row(9, { input: 94_000 })], messages, false)).toBeNull()
  })
})

/**
 * Every provider path must record the TOTAL prompt size as `input`: Anthropic
 * `input_tokens` excludes cache reads/writes; OpenAI / OpenRouter
 * `prompt_tokens` / `input_tokens` already include cached tokens. A real
 * prompt of 94,100 tokens: 100 uncached + 90,000 cache read + 4,000 cache write.
 */
describe('real prompt size per provider usage shape', () => {
  const REAL = 94_100
  const jsonFetch = (body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch

  async function recordedTokens(provider: LLMProvider): Promise<LoopTokenUsage> {
    const { metadata } = await callLlmWithMetadata(provider, {
      system: 'sys',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
    } as never)
    return loopTokensFromLlmMetadata(metadata)
  }
  const wrap = (model: unknown, type: string) =>
    new AiSdkProvider(model as LanguageModel, 'p', 'm', 0, { providerId: 'p', providerType: type as never })

  it('anthropic: input_tokens + cache read + cache write', async () => {
    const anthropic = createAnthropic({
      apiKey: 'k',
      fetch: jsonFetch({
        id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5',
        content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 100, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 4_000, output_tokens: 50 },
      }),
    })
    const t = await recordedTokens(wrap(anthropic('claude-opus-5-5'), 'anthropic'))
    expect(t.input).toBe(REAL)
    expect(t.cache_read).toBe(90_000)
    expect(t.estimated).toBeUndefined()
  })

  it('openai / chatgpt-subscription (Responses API): input_tokens already counts cached', async () => {
    const openai = createOpenAI({
      apiKey: 'k',
      fetch: jsonFetch({
        id: 'resp_1', object: 'response', created_at: 1, status: 'completed', model: 'gpt-5',
        output: [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok', annotations: [] }] }],
        usage: { input_tokens: REAL, input_tokens_details: { cached_tokens: 90_000 }, output_tokens: 50, output_tokens_details: { reasoning_tokens: 20 } },
      }),
    })
    const t = await recordedTokens(wrap(openai.responses('gpt-5'), 'openai'))
    expect(t.input).toBe(REAL)
    expect(t.cache_read).toBe(90_000)
    expect(t.reasoning).toBe(20)
  })

  const chatCompletion = {
    id: 'c1', object: 'chat.completion', created: 1, model: 'm',
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: REAL, completion_tokens: 50, total_tokens: REAL + 50, prompt_tokens_details: { cached_tokens: 90_000 } },
  }

  it('openrouter: prompt_tokens already counts cached', async () => {
    const openrouter = createOpenRouter({ apiKey: 'k', fetch: jsonFetch(chatCompletion) })
    const t = await recordedTokens(wrap(openrouter('anthropic/claude-opus-5-5'), 'openrouter'))
    expect(t.input).toBe(REAL)
  })

  it('custom (openai-compatible): prompt_tokens already counts cached', async () => {
    const custom = createOpenAICompatible({ name: 'custom', baseURL: 'http://127.0.0.1:1/v1', fetch: jsonFetch(chatCompletion) })
    const t = await recordedTokens(wrap(custom('m'), 'openai-compatible'))
    expect(t.input).toBe(REAL)
  })

  it('custom without usage: flagged estimated, so the breakdown is not calibrated to it', async () => {
    const custom = createOpenAICompatible({
      name: 'custom', baseURL: 'http://127.0.0.1:1/v1',
      fetch: jsonFetch({ ...chatCompletion, usage: undefined }),
    })
    const t = await recordedTokens(wrap(custom('m'), 'openai-compatible'))
    expect(t.estimated).toBe(true)
    expect(findLastCall([{ seq: 1, tokens: t }], [{ seq: 1 }], false)).toBeNull()
  })

  it('claude-subscription: input + cache read + cache write', () => {
    const provider = new ClaudeSubscriptionProvider({ providerId: 'p', displayName: 'p', modelId: 'claude-opus-5-5' })
    const turn: TurnResult = {
      messageId: 'm1', content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn', injections: [],
      usage: { input: 100, cacheRead: 90_000, cacheWrite: 4_000, output: 50, reasoning: 30 },
    }
    const response = (provider as unknown as { toResponse(r: TurnResult): LLMResponse }).toResponse(turn)
    const t = loopTokensFromLlmMetadata(buildLlmCallMetadata(provider, response, 1))
    expect(t.input).toBe(REAL)
    expect(t.cache_read).toBe(90_000)
    expect(t.reasoning).toBe(30)
  })
})
