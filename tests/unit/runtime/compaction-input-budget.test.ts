import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHeadlessAgent, type HeadlessAgent } from '../../../src/main/runtime/headless'
import { clearAllUmbilicalBuses } from '../../../src/main/runtime/umbilical-bus'
import { getTokenCounterService } from '../../../src/main/services/token-counter.service'
import type { CreateMessageOptions, LLMProvider } from '../../../src/main/providers/provider.interface'
import type { LLMResponse } from '../../../src/shared/types/provider.types'
import type { ModelConfig } from '../../../src/shared/types/adf-v02.types'

class CompactionProvider implements LLMProvider {
  readonly name = 'compaction-budget-test'
  readonly calls: CreateMessageOptions[] = []
  constructor(readonly modelId = 'main-model', readonly providerType: 'openai' | 'anthropic' = 'openai') {}
  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    this.calls.push(structuredClone(options))
    return {
      id: `summary-${this.calls.length}`,
      content: [{ type: 'text', text: 'The experiment remains ongoing; continue from the retained evidence.' }],
      stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 20 },
    }
  }
  async validateConfig() { return { valid: true } }
}

function build(threshold?: number, override?: ModelConfig) {
  const provider = new CompactionProvider()
  const agent = createHeadlessAgent({
    provider, profile: 'benchmark', basePrompt: '', registerTools: () => {},
    createOptions: { model: { provider: 'openai', model_id: 'main-model' } },
  })
  const config = agent.workspace.getAgentConfig()
  delete config.model.compact_threshold
  config.context = { ...config.context }
  if (threshold === undefined) delete config.context.compact_threshold
  else config.context.compact_threshold = threshold
  if (override) config.context.compaction_model = override
  else delete config.context.compaction_model
  agent.executor.updateConfig(config)
  return { agent, provider }
}

function userText(call: CreateMessageOptions): string {
  const content = call.messages[0].content
  return typeof content === 'string' ? content : content.map(block => block.text ?? '').join('\n')
}

function inputLog(agent: HeadlessAgent) {
  const entry = agent.workspace.getLogs().find(log => log.event === 'compaction_input')
  expect(entry).toBeDefined()
  return JSON.parse(entry!.data!) as {
    input_budget_tokens: number
    estimated_input_tokens: number
    original_transcript_chars: number
    transcript_chars: number
    omitted_characters: number
    max_output_tokens: number
  }
}

describe('compaction input budgeting at the provider boundary', () => {
  beforeEach(() => clearAllUmbilicalBuses())
  afterEach(() => vi.restoreAllMocks())

  it('retains a large transcript and full tool evidence when a 300k-token allowance fits it', async () => {
    const { agent, provider } = build(300_000)
    agent.session.addMessage({ role: 'user', content: 'Investigate the unresolved mechanism.\n' + 'earlier evidence '.repeat(8_000) })
    agent.session.addMessage({ role: 'user', content: 'MIDDLE_OBJECTIVE: compare the two unexplained outcomes before choosing a new hypothesis.' })
    agent.session.addMessage({ role: 'assistant', content: [
      { type: 'thinking', thinking: 'working rationale '.repeat(40) + 'THINKING_TAIL' },
      { type: 'tool_use', id: 'experiment-17', name: 'run_experiment', input: { argument: 'a'.repeat(800) + 'ARGUMENT_TAIL' } },
    ] })
    agent.session.addMessage({ role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'experiment-17', is_error: true, content: 'r'.repeat(900) + 'RESULT_EVIDENCE_TAIL' },
    ] })
    agent.session.addMessage({ role: 'assistant', content: 'later evidence '.repeat(8_000) })
    try {
      expect(await agent.executor.compactNow('budget test')).toEqual({ success: true })
      expect(provider.calls).toHaveLength(1)
      const text = userText(provider.calls[0])
      expect(text.length).toBeGreaterThan(200_000)
      expect(text).toContain('MIDDLE_OBJECTIVE')
      expect(text).toContain('ARGUMENT_TAIL')
      expect(text).toContain('RESULT_EVIDENCE_TAIL')
      expect(text).toContain('THINKING_TAIL')
      expect(text).toContain('Called run_experiment id=experiment-17')
      expect(text).toContain('Result id=experiment-17 error:')
      expect(text).not.toContain('Middle of transcript omitted')
      expect(inputLog(agent)).toMatchObject({ input_budget_tokens: 270_784, omitted_characters: 0 })
    } finally { await agent.disposeAsync() }
  })

  it('uses the legacy 100k allowance when neither context nor model config supplies one', async () => {
    const { agent, provider } = build()
    agent.session.addMessage({ role: 'user', content: 'Retain this ongoing objective.' })
    try {
      expect((await agent.executor.compactNow('default allowance')).success).toBe(true)
      expect(provider.calls[0].maxTokens).toBe(28_192)
      expect(inputLog(agent)).toMatchObject({ input_budget_tokens: 70_784, max_output_tokens: 28_192 })
    } finally { await agent.disposeAsync() }
  })

  it.each([
    { compact_threshold: undefined, max_tokens: undefined, expectedInput: 70_784, expectedOutput: 28_192 },
    { compact_threshold: undefined, max_tokens: 60_000, expectedInput: 70_784, expectedOutput: 28_192 },
    { compact_threshold: 64_000, max_tokens: 4_096, expectedInput: 58_880, expectedOutput: 4_096 },
  ])('budgets a different compactor independently ($expectedInput tokens)', async scenario => {
    const { agent, provider: main } = build(300_000, {
      provider: 'anthropic', model_id: 'small-compactor',
      ...(scenario.compact_threshold === undefined ? {} : { compact_threshold: scenario.compact_threshold }),
      ...(scenario.max_tokens === undefined ? {} : { max_tokens: scenario.max_tokens }),
    })
    const summarizer = new CompactionProvider('small-compactor', 'anthropic')
    agent.executor.setModelProviderFactory(() => summarizer)
    // Deliberately distinct tokenizer densities expose accidental use of the
    // host tokenizer. The assertions inspect the actual summarizer request.
    const counter = vi.spyOn(getTokenCounterService(), 'countTokens').mockImplementation((text, provider) =>
      Math.ceil(text.length / (provider === 'anthropic' ? 1 : 4)))
    agent.session.addMessage({ role: 'user', content: 'INITIAL_OBJECTIVE\n' + 'x'.repeat(180_000) + '\nRECENT_RESULT' })
    try {
      expect((await agent.executor.compactNow('different summarizer')).success).toBe(true)
      expect(main.calls).toHaveLength(0)
      expect(summarizer.calls).toHaveLength(1)
      const request = summarizer.calls[0]
      expect(request.maxTokens).toBe(scenario.expectedOutput)
      expect(counter).toHaveBeenCalledWith(request.system, 'anthropic', 'small-compactor')
      expect(counter).toHaveBeenCalledWith(userText(request), 'anthropic', 'small-compactor')
      const measured = request.system.length + userText(request).length + 16
      expect(measured).toBeLessThanOrEqual(scenario.expectedInput)
      const log = inputLog(agent)
      expect(log).toMatchObject({
        input_budget_tokens: scenario.expectedInput, estimated_input_tokens: measured,
        max_output_tokens: scenario.expectedOutput,
      })
      expect(log.omitted_characters).toBeGreaterThan(0)
      expect(userText(request)).toContain('INITIAL_OBJECTIVE')
      expect(userText(request)).toContain('RECENT_RESULT')
    } finally { await agent.disposeAsync() }
  })

  it('still compacts with a small trigger threshold rather than assigning a negative input budget', async () => {
    const { agent, provider } = build(100)
    agent.session.addMessage({ role: 'user', content: 'Small thresholds request frequent compaction; preserve this question.' })
    try {
      expect((await agent.executor.compactNow('small trigger')).success).toBe(true)
      expect(provider.calls).toHaveLength(1)
      expect(userText(provider.calls[0])).toContain('preserve this question')
      expect(inputLog(agent)).toMatchObject({ input_budget_tokens: 8_192, omitted_characters: 0 })
    } finally { await agent.disposeAsync() }
  })

  it('bounds a huge tool result while retaining the initial mandate and recent result tail', async () => {
    const { agent, provider } = build()
    vi.spyOn(getTokenCounterService(), 'countTokens').mockImplementation(text => Math.ceil(text.length / 4))
    agent.session.addMessage({ role: 'user', content: 'INITIAL_MANDATE: continue searching after each finished experiment.' })
    agent.session.addMessage({ role: 'assistant', content: [
      { type: 'tool_use', id: 'huge-result', name: 'run_experiment', input: { trial: 19 } },
    ] })
    agent.session.addMessage({ role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'huge-result', content: 'RESULT_HEAD\n' + 'x'.repeat(900_000) + '\nRESULT_TAIL' },
    ] })
    try {
      expect((await agent.executor.compactNow('oversized result')).success).toBe(true)
      const request = provider.calls[0]
      const text = userText(request)
      expect(text).toContain('INITIAL_MANDATE')
      expect(text).toContain('RESULT_HEAD')
      expect(text).toContain('RESULT_TAIL')
      expect(text).toContain('Middle of transcript omitted')
      const log = inputLog(agent)
      expect(log.original_transcript_chars).toBeGreaterThan(900_000)
      expect(log.omitted_characters).toBeGreaterThan(0)
      expect(log.transcript_chars).toBeLessThan(log.original_transcript_chars)
      expect(Math.ceil(request.system.length / 4) + Math.ceil(text.length / 4) + 16).toBe(log.estimated_input_tokens)
      expect(log.estimated_input_tokens).toBeLessThanOrEqual(log.input_budget_tokens)
    } finally { await agent.disposeAsync() }
  })
})
