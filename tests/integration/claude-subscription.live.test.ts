/**
 * Live test against the user's installed, signed-in Claude Code. Uses the
 * Claude plan's limits, so it only runs when explicitly asked for:
 *
 *   ADF_CLAUDE_LIVE=1 npx vitest run tests/integration/claude-subscription.live.test.ts
 */
import { describe, it, expect, afterAll, vi } from 'vitest'
import { createClaudeSubscriptionProvider } from '../../src/main/providers/claude-subscription'
import { closeAllClaudeSessions } from '../../src/main/providers/claude-subscription/provider'
import { ClaudeCodeSession } from '../../src/main/providers/claude-subscription/session'
import type { LLMMessage, LLMResponse } from '../../src/shared/types/provider.types'
import type { ToolProviderFormat } from '../../src/shared/types/tool.types'

const live = process.env.ADF_CLAUDE_LIVE === '1'
const model = process.env.ADF_CLAUDE_LIVE_MODEL ?? 'claude-haiku-4-5'

const weatherTool: ToolProviderFormat = {
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
}

const text = (r: LLMResponse) => r.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
const toolUses = (r: LLMResponse) => r.content.filter((b) => b.type === 'tool_use')

describe.skipIf(!live)('claude-subscription (live)', () => {
  const provider = createClaudeSubscriptionProvider({ providerId: 'test', displayName: 'Claude', modelId: model })
  const system = 'You are a terse test assistant. Always use tools when asked about weather.'

  afterAll(() => closeAllClaudeSessions())

  it('validates the sign-in', async () => {
    expect(await provider.validateConfig()).toEqual({ valid: true })
  })

  it('runs a tool loop on one live session, then a follow-up turn', async () => {
    const starts = vi.spyOn(ClaudeCodeSession, 'start')
    const messages: LLMMessage[] = [{ role: 'user', content: 'What is the weather in Oslo?' }]
    let deltas = ''
    const first = await provider.createMessage({ system, messages, tools: [weatherTool], onTextDelta: (d) => { deltas += d } })
    expect(first.stop_reason).toBe('tool_use')
    const call = toolUses(first)[0]
    expect(call.name).toBe('get_weather')
    expect(call.input).toMatchObject({ city: expect.stringMatching(/oslo/i) })

    messages.push({ role: 'assistant', content: first.content })
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id!, content: 'Snow, -7C' }] })
    const second = await provider.createMessage({ system, messages, tools: [weatherTool], onTextDelta: (d) => { deltas += d } })
    expect(second.stop_reason).toBe('end_turn')
    expect(text(second)).toMatch(/-7|snow/i)
    expect(deltas.length).toBeGreaterThan(0)
    expect(second.usage.input_tokens).toBeGreaterThan(0)

    messages.push({ role: 'assistant', content: second.content })
    messages.push({ role: 'user', content: 'Which city did I ask about? One word.' })
    const third = await provider.createMessage({ system, messages, tools: [weatherTool] })
    expect(text(third)).toMatch(/oslo/i)
    // All three calls ran on the one Claude Code process.
    expect(starts).toHaveBeenCalledTimes(1)
    starts.mockRestore()
    // What Claude Code added on its own is reported for the loop.
    const injected = [first, second, third].flatMap((r) => (r.providerMetadata?.adf as { contextInjections?: string[] }).contextInjections ?? [])
    expect(injected.join('\n')).toMatch(/Today's date is/)
    expect(injected.join('\n')).toMatch(/Claude Code system prompt prefix/)
    expect(injected.join('\n')).not.toMatch(/total_tokens/)
  }, 120_000)

  it('handles several tool calls in one response', async () => {
    const messages: LLMMessage[] = [{ role: 'user', content: 'Get the weather in Oslo, Lima and Rome. Call the tool for all three cities at once, in a single response.' }]
    const first = await provider.createMessage({ system, messages, tools: [weatherTool], signal: AbortSignal.timeout(60_000) })
    expect(first.stop_reason).toBe('tool_use')
    const calls = toolUses(first)
    expect(calls.length).toBeGreaterThanOrEqual(2)
    messages.push({ role: 'assistant', content: first.content })
    messages.push({ role: 'user', content: calls.map((c, i) => ({ type: 'tool_result' as const, tool_use_id: c.id!, content: `${10 + i}C` })) })
    const second = await provider.createMessage({ system, messages, tools: [weatherTool], signal: AbortSignal.timeout(60_000) })
    expect(second.stop_reason).toBe('end_turn')
    expect(text(second)).toMatch(/10/)
  }, 150_000)

  it('passes an image returned with a tool result on the live session', async () => {
    // 8x8 solid red PNG.
    const red = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC'
    const shotTool: ToolProviderFormat = { name: 'take_screenshot', description: 'Take a screenshot.', input_schema: { type: 'object', properties: {} } }
    const messages: LLMMessage[] = [{ role: 'user', content: 'Take a screenshot, then tell me its main color in one word.' }]
    const first = await provider.createMessage({ system, messages, tools: [shotTool], signal: AbortSignal.timeout(60_000) })
    expect(first.stop_reason).toBe('tool_use')
    messages.push({ role: 'assistant', content: first.content })
    messages.push({ role: 'user', content: [
      { type: 'tool_result', tool_use_id: toolUses(first)[0].id!, content: 'Screenshot attached.' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${red}` } },
    ] })
    const second = await provider.createMessage({ system, messages, tools: [shotTool], signal: AbortSignal.timeout(60_000) })
    expect(text(second)).toMatch(/red/i)
  }, 150_000)

  it('re-delivers instructions that went away and came back', async () => {
    const di = 'The secret word is TANGERINE. If asked for the secret word, answer with it.'
    const messages: LLMMessage[] = [{ role: 'user', content: 'Say OK.' }]
    const a = await provider.createMessage({ system, messages, dynamicInstructions: di, signal: AbortSignal.timeout(60_000) })
    messages.push({ role: 'assistant', content: a.content }, { role: 'user', content: 'Say OK again.' })
    const b = await provider.createMessage({ system, messages, signal: AbortSignal.timeout(60_000) })
    messages.push({ role: 'assistant', content: b.content }, { role: 'user', content: 'What is the secret word right now? One word.' })
    const c = await provider.createMessage({ system, messages, dynamicInstructions: di, signal: AbortSignal.timeout(60_000) })
    expect(text(c)).toMatch(/tangerine/i)
  }, 150_000)

  it('delivers per-turn instructions on a tool-result continuation', async () => {
    const messages: LLMMessage[] = [{ role: 'user', content: 'What is the weather in Rome?' }]
    const dynamicInstructions = 'Inbox: 1 unread message from agent-2.'
    const first = await provider.createMessage({ system, messages, tools: [weatherTool], dynamicInstructions, signal: AbortSignal.timeout(60_000) })
    expect(first.stop_reason).toBe('tool_use')
    const call = toolUses(first)[0]
    messages.push({ role: 'assistant', content: first.content })
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id!, content: 'Sun, 24C' }] })
    const second = await provider.createMessage({
      system, messages, tools: [weatherTool],
      dynamicInstructions: 'Inbox: 2 unread messages from agent-2. Mention the unread count in your answer.',
      signal: AbortSignal.timeout(60_000),
    })
    expect(second.stop_reason).toBe('end_turn')
    expect(text(second)).toMatch(/24/)
  }, 120_000)

  it('resumes ADF history (with tool calls) in a fresh session', async () => {
    const messages: LLMMessage[] = [
      { role: 'user', content: 'My name is Zed.' },
      { role: 'assistant', content: [{ type: 'text', text: 'Noted, Zed.' }] },
      { role: 'user', content: 'Weather in Lima?' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_hist_1', name: 'get_weather', input: { city: 'Lima' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_hist_1', content: 'Fog, 16C' }] },
    ]
    // A different system prompt can't match any pooled session → cold start;
    // the trailing tool result is replayed and the model continues.
    const r = await provider.createMessage({ system: `${system} (cold)`, messages, tools: [weatherTool] })
    expect(r.stop_reason).toBe('end_turn')
    expect(text(r)).toMatch(/fog|16/i)

    messages.push({ role: 'assistant', content: r.content })
    messages.push({ role: 'user', content: 'What is my name? One word.' })
    const r2 = await provider.createMessage({ system: `${system} (cold)`, messages, tools: [weatherTool] })
    expect(text(r2)).toMatch(/zed/i)
  }, 120_000)

  it('a small max tokens with high-effort thinking still gets a reply', async () => {
    const r = await provider.createMessage({
      system,
      messages: [{ role: 'user', content: 'Think carefully: how many primes are there below 200? Then reply with just the number.' }],
      maxTokens: 512,
      reasoning: { effort: 'high' },
      signal: AbortSignal.timeout(120_000),
    })
    expect(r.stop_reason).toBe('end_turn')
    expect(text(r)).toMatch(/46/)
  }, 150_000)

  it('streams thinking when reasoning is enabled', async () => {
    let thinking = ''
    const r = await provider.createMessage({
      system,
      messages: [{ role: 'user', content: 'Is 391 prime? Answer yes or no.' }],
      reasoning: { effort: 'high' },
      onThinkingDelta: (d) => { thinking += d },
    })
    expect(text(r)).toMatch(/no/i)
    // Adaptive thinking may skip thinking on an easy prompt; when it does
    // think, the trace streams and is counted.
    if (thinking.length > 0) {
      expect((r.providerMetadata?.adf as { reasoningTokens?: number }).reasoningTokens).toBeGreaterThan(0)
    }
  }, 120_000)
})
