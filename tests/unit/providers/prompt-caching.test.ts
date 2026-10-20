import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProvider } from '../../../src/main/providers/provider-factory'
import { convertMessages } from '../../../src/main/providers/ai-sdk-provider'
import type { AgentConfig } from '../../../src/shared/types/adf-v02.types'
import type { ProviderConfig } from '../../../src/shared/types/ipc.types'
import type { LLMMessage } from '../../../src/shared/types/provider.types'

type CacheControl = { type: 'ephemeral'; ttl?: '5m' | '1h' }
type WirePart = { type: string; text?: string; cache_control?: CacheControl; [key: string]: unknown }
type WireMessage = { role: string; content: string | WirePart[] | null; cache_control?: CacheControl }
type Body = { system?: WirePart[]; messages: WireMessage[]; cache_control?: CacheControl }

function harness(type: 'anthropic' | 'openrouter' | 'custom', model: string, params?: Array<{ key: string; value: string }>) {
  const bodies: Body[] = []
  vi.stubGlobal('fetch', vi.fn(async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)))
    const response = type === 'anthropic'
      ? {
          id: 'msg_test', type: 'message', role: 'assistant', model,
          content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 1 },
        }
      : {
          id: 'chat_test', object: 'chat.completion', created: 1, model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
        }
    return new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } })
  }))
  const cfg: ProviderConfig = { id: 'cache-test', type, name: 'Cache test', apiKey: 'test-key', baseUrl: 'https://example.invalid/v1' }
  const agent = { model: { provider: cfg.id, model_id: model, ...(params ? { params } : {}) } } as AgentConfig
  return { bodies, provider: createProvider(agent, { getProvider: () => cfg }) }
}

/** Prefixes at actual serialized cache markers, ignoring marker metadata. */
function cachedPrefixes(body: Body): unknown[][] {
  const prefix: unknown[] = []
  const prefixes: unknown[][] = []
  const messages: WireMessage[] = [...(body.system ? [{ role: 'system', content: body.system }] : []), ...body.messages]
  for (const message of messages) {
    const content = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content ?? []
    for (const block of content) {
      const { cache_control: cache, ...value } = block
      prefix.push({ role: message.role, ...value })
      if (cache) prefixes.push(structuredClone(prefix))
    }
    if (message.cache_control) prefixes.push(structuredClone(prefix))
  }
  return prefixes
}

function countMarkers(value: unknown): number {
  if (!value || typeof value !== 'object') return 0
  return Object.entries(value).reduce((count, [key, item]) => count + (key === 'cache_control' ? 1 : countMarkers(item)), 0)
}

afterEach(() => vi.unstubAllGlobals())

describe('Claude cache breakpoints on the serialized request', () => {
  it.each([
    ['anthropic', 'claude-sonnet-4-20250514'],
    ['openrouter', 'anthropic/claude-sonnet-4'],
  ] as const)('%s caches stable system and growing persisted history before transient context', async (type, model) => {
    const { provider, bodies } = harness(type, model)
    const messages: LLMMessage[] = [{ role: 'user', content: 'First question' }]
    const original = structuredClone(messages)
    const convertedBefore = structuredClone(convertMessages(messages))
    await provider.createMessage({ system: 'Stable instructions', messages, dynamicInstructions: 'Clock: 12:00' })
    expect(messages).toEqual(original)
    expect(convertMessages(messages)).toEqual(convertedBefore)
    expect(countMarkers(bodies[0])).toBe(2)
    const firstPrefixes = cachedPrefixes(bodies[0])
    expect(firstPrefixes).toHaveLength(2)
    expect(JSON.stringify(firstPrefixes)).not.toContain('Clock:')
    expect(JSON.stringify(firstPrefixes[1])).toContain('First question')
    expect(JSON.stringify(bodies[0])).toContain('Clock: 12:00')
    expect(bodies[0].cache_control).toBeUndefined()

    messages.push({ role: 'assistant', content: 'First answer' }, { role: 'user', content: 'Second question' })
    await provider.createMessage({ system: 'Stable instructions', messages, dynamicInstructions: 'Clock: 12:01' })
    expect(countMarkers(bodies[1])).toBe(2)
    const nextPrefixes = cachedPrefixes(bodies[1])
    expect(nextPrefixes[0]).toEqual(firstPrefixes[0])
    expect(nextPrefixes[1].slice(0, firstPrefixes[1].length)).toEqual(firstPrefixes[1])
    expect(JSON.stringify(nextPrefixes[1])).toContain('Second question')
    expect(JSON.stringify(nextPrefixes)).not.toContain('Clock:')
    expect(JSON.stringify(bodies[1])).not.toContain('Clock: 12:00')
  })

  it.each([
    ['anthropic', 'claude-sonnet-4-20250514'],
    ['openrouter', 'anthropic/claude-sonnet-4'],
  ] as const)('%s adds only one history breakpoint to a large parallel tool batch', async (type, model) => {
    const { provider, bodies } = harness(type, model)
    const messages: LLMMessage[] = [
      { role: 'user', content: 'Run tools' },
      { role: 'assistant', content: Array.from({ length: 6 }, (_, i) => ({ type: 'tool_use', id: `call_${i}`, name: 'lookup', input: { i } })) },
      { role: 'user', content: Array.from({ length: 6 }, (_, i) => ({ type: 'tool_result', tool_use_id: `call_${i}`, content: `result_${i}` })) },
    ]
    const before = structuredClone(convertMessages(messages))
    await provider.createMessage({ system: 'Stable instructions', messages, dynamicInstructions: 'Temporary context' })
    expect(countMarkers(bodies[0])).toBe(2)
    expect(convertMessages(messages)).toEqual(before)
    const serialized = JSON.stringify(bodies[0])
    expect(serialized.lastIndexOf('cache_control')).toBeGreaterThan(serialized.indexOf('result_5'))
    expect(serialized.lastIndexOf('cache_control')).toBeLessThan(serialized.indexOf('Temporary context'))
  })

  it.each([
    ['openrouter', 'openai/gpt-4.1'],
    ['custom', 'local-model'],
  ] as const)('leaves %s/%s requests unmarked', async (type, model) => {
    const { provider, bodies } = harness(type, model)
    await provider.createMessage({ system: 'Instructions', messages: [{ role: 'user', content: 'Hi' }], dynamicInstructions: 'Now' })
    expect(countMarkers(bodies[0])).toBe(0)
  })

  for (const type of ['anthropic', 'openrouter'] as const) {
    it.each(['image-only', 'text-image', 'tool-image'] as const)(`${type} marks the final media part for %s history`, async kind => {
      const model = type === 'anthropic' ? 'claude-sonnet-4-20250514' : 'anthropic/claude-sonnet-4'
      const { provider, bodies } = harness(type, model)
      const image = { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB' } }
      const messages: LLMMessage[] = kind === 'tool-image'
        ? [
            { role: 'user', content: 'Read image' },
            { role: 'assistant', content: [{ type: 'tool_use', id: 'image_call', name: 'read', input: {} }] },
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'image_call', content: 'Image loaded' }, image] },
          ]
        : [{ role: 'user', content: kind === 'text-image' ? [{ type: 'text', text: 'Describe image' }, image] : [image] }]
      const original = structuredClone(messages)
      const converted = structuredClone(convertMessages(messages))
      const system = kind === 'image-only' ? '' : 'Stable instructions'
      await provider.createMessage({ system, messages, dynamicInstructions: 'Temporary context' })
      const prefixes = cachedPrefixes(bodies[0])
      expect(countMarkers(bodies[0])).toBe(system ? 2 : 1)
      expect(prefixes.at(-1)?.at(-1)).toMatchObject({ type: type === 'anthropic' ? 'image' : 'image_url' })
      expect(JSON.stringify(prefixes)).not.toContain('Temporary context')
      expect(messages).toEqual(original)
      expect(convertMessages(messages)).toEqual(converted)

      messages.push({ role: 'assistant', content: 'Image described' }, { role: 'user', content: 'Continue' })
      await provider.createMessage({ system, messages, dynamicInstructions: 'Updated context' })
      const priorHistory = prefixes.at(-1)!
      expect(cachedPrefixes(bodies[1]).at(-1)?.slice(0, priorHistory.length)).toEqual(priorHistory)
    })
  }

  it('preserves an explicit media breakpoint when projecting video markers into OpenRouter file parts', async () => {
    // This exercises serialization only; no assertion that Claude accepts video.
    const { provider, bodies } = harness('openrouter', 'anthropic/claude-sonnet-4')
    const messages: LLMMessage[] = [{ role: 'user', content: [
      { type: 'text', text: 'Describe video' },
      { type: 'video_url', video_url: { url: 'data:video/mp4;base64,AAAA' } },
    ] }]
    const converted = structuredClone(convertMessages(messages))
    await provider.createMessage({ system: 'Stable instructions', messages, dynamicInstructions: 'Temporary context' })
    expect(countMarkers(bodies[0])).toBe(2)
    expect(cachedPrefixes(bodies[0]).at(-1)?.at(-1)).toMatchObject({ type: 'video_url' })
    expect(JSON.stringify(cachedPrefixes(bodies[0]))).not.toContain('Temporary context')
    expect(convertMessages(messages)).toEqual(converted)
  })

  it.each(['anthropic', 'openrouter'] as const)('honors a custom %s cache policy without injecting default markers', async type => {
    const model = type === 'anthropic' ? 'claude-sonnet-4-20250514' : 'anthropic/claude-sonnet-4'
    const { provider, bodies } = harness(type, model, [{ key: 'cache_control', value: '{"type":"ephemeral","ttl":"1h"}' }])
    await provider.createMessage({ system: 'Instructions', messages: [{ role: 'user', content: 'Hi' }] })
    expect(bodies[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
    expect(countMarkers(bodies[0])).toBe(1)
  })

  it('honors an explicit cache_control deletion', async () => {
    const { provider, bodies } = harness('anthropic', 'claude-sonnet-4-20250514', [{ key: 'cache_control', value: '' }])
    await provider.createMessage({ system: 'Instructions', messages: [{ role: 'user', content: 'Hi' }] })
    expect(countMarkers(bodies[0])).toBe(0)
  })
})
