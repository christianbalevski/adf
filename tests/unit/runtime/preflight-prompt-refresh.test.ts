import { beforeEach, describe, expect, it } from 'vitest'
import { createHeadlessAgent } from '../../../src/main/runtime/headless'
import { clearAllUmbilicalBuses } from '../../../src/main/runtime/umbilical-bus'
import { createDispatch, createEvent } from '../../../src/shared/types/adf-event.types'
import type { CreateMessageOptions, LLMProvider } from '../../../src/main/providers/provider.interface'
import type { LLMResponse } from '../../../src/shared/types/provider.types'

class RecordingProvider implements LLMProvider {
  readonly name = 'provider-1'
  readonly modelId = 'prompt-refresh-model'
  readonly requests: { system: string; dynamicInstructions?: string; promptCacheKey?: string }[] = []
  compactionCalls = 0
  compactionOneShot: boolean[] = []

  constructor(private readonly failCompaction = false) {}

  async validateConfig() { return { valid: true } }

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    if (options.system === 'Summarize the transcript.') {
      this.compactionCalls++
      this.compactionOneShot.push(options.oneShot === true)
      return {
        id: 'summary',
        content: this.failCompaction ? [] : [{ type: 'text', text: 'Continue the pending task.' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 10 },
      }
    }
    this.requests.push({ system: options.system, dynamicInstructions: options.dynamicInstructions, promptCacheKey: options.promptCacheKey })
    return {
      id: `reply-${this.requests.length}`,
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      // Near the threshold after the first call, so the next call builds a
      // one-shot warning before the newly appended message forces compaction.
      usage: { input_tokens: this.requests.length === 1 ? 38_000 : 100, output_tokens: 10 },
    }
  }
}

function chat(text: string) {
  return createDispatch(createEvent({
    type: 'chat', source: 'test',
    data: { message: { seq: 0, role: 'user', content_json: [{ type: 'text', text }], created_at: Date.now() } },
  }), { scope: 'agent' })
}

function build(provider: RecordingProvider) {
  const agent = createHeadlessAgent({
    name: 'agent-1',
    profile: 'benchmark',
    provider,
    basePrompt: 'Your memory: {{mind.md}}',
    toolPrompts: { _skills: 'Your skills: {{skills-registry.json}}' },
    compactionPrompt: 'Summarize the transcript.',
    createOptions: {
      context: { compact_threshold: 50_000 },
      messaging: { receive: true },
      tools: [{ name: 'loop_compact', enabled: true, visible: true }],
    },
  })
  agent.workspace.writeFile('mind.md', 'old-memory')
  agent.workspace.writeFile('skills-registry.json', '{"skills":["old-skill"]}')
  return agent
}

const oversizedMessage = 'A newly received message with many details. '.repeat(7_000)

beforeEach(() => clearAllUmbilicalBuses())

describe('preflight compaction prompt refresh', () => {
  it('sends refreshed memory/catalog immediately and records the same prompt sent to the provider', async () => {
    const provider = new RecordingProvider()
    const agent = build(provider)
    const peers = [{ handle: 'agent-2', description: 'existing collaborator' }]
    agent.executor.setMeshContext(() => peers)
    try {
      await agent.executor.executeTurn(chat('start'))
      expect(provider.requests[0].system).toContain('old-memory')
      expect(provider.requests[0].system).toContain('old-skill')

      peers.push({ handle: 'agent-3', description: 'new collaborator' })
      agent.workspace.writeFile('mind.md', 'new-memory')
      agent.workspace.writeFile('skills-registry.json', '{"skills":["new-skill"]}')
      await agent.executor.executeTurn(chat(oversizedMessage))

      expect(provider.compactionCalls).toBe(1)
      // The summary is never sent again: no cache write. Turns keep one cache key.
      expect(provider.compactionOneShot).toEqual([true])
      expect(provider.requests).toHaveLength(2)
      expect(provider.requests[0].promptCacheKey).toMatch(/^adf-[0-9a-f]{32}$/)
      expect(provider.requests[1].promptCacheKey).toBe(provider.requests[0].promptCacheKey)
      const firstAfterCompaction = provider.requests[1]
      expect(firstAfterCompaction.system).toContain('new-memory')
      expect(firstAfterCompaction.system).toContain('new-skill')
      expect(firstAfterCompaction.system).not.toContain('old-memory')
      expect(firstAfterCompaction.dynamicInstructions).toContain('agent-3')
      expect(firstAfterCompaction.dynamicInstructions).not.toContain('tokens (threshold:')
      const auditTexts = agent.workspace.getLoop().flatMap(row => row.content_json
        .filter(block => block.type === 'text').map(block => block.text))
      expect(auditTexts).toContain(`[Context: system_prompt] ${firstAfterCompaction.system}`)
      expect(auditTexts).toContain(`[Context: dynamic_instructions] ${firstAfterCompaction.dynamicInstructions}`)
      expect(agent.executor.getContextBreakdown()?.dynamic_instructions_tokens).toBeGreaterThan(0)

      await agent.executor.executeTurn(chat('continue'))
      expect(provider.compactionCalls).toBe(1)
      expect(provider.requests[2].system).toBe(firstAfterCompaction.system)
      expect(provider.requests[2].dynamicInstructions).toBeUndefined()
    } finally {
      await agent.disposeAsync()
    }
  })

  it('keeps the original snapshot and one-shot warning when compaction fails', async () => {
    const provider = new RecordingProvider(true)
    const agent = build(provider)
    try {
      await agent.executor.executeTurn(chat('start'))
      agent.workspace.writeFile('mind.md', 'new-memory')
      await agent.executor.executeTurn(chat(oversizedMessage))

      expect(provider.compactionCalls).toBe(1)
      expect(provider.requests).toHaveLength(2)
      expect(provider.requests[1].system).toBe(provider.requests[0].system)
      expect(provider.requests[1].dynamicInstructions).toContain('tokens (threshold: 50,000)')
      const auditText = JSON.stringify(agent.workspace.getLoop())
      expect(auditText).toContain('[Context: dynamic_instructions]')
      expect(auditText).not.toContain('[Loop Compacted')
    } finally {
      await agent.disposeAsync()
    }
  })
})
