import { beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createHeadlessAgent, type HeadlessAgent } from '../../../src/main/runtime/headless'
import { clearAllUmbilicalBuses } from '../../../src/main/runtime/umbilical-bus'
import { createDispatch, createEvent } from '../../../src/shared/types/adf-event.types'
import type { CreateMessageOptions, LLMProvider } from '../../../src/main/providers/provider.interface'
import type { ContentBlock, LLMMessage, LLMResponse } from '../../../src/shared/types/provider.types'
import type { Tool } from '../../../src/main/tools/tool.interface'
import type { ToolResult } from '../../../src/shared/types/tool.types'

const NOTICE = '[System] Repeated tool pattern:'
const chat = (text = 'Run the experiment.') => createDispatch(createEvent({
  type: 'chat', source: 'test', data: {
    message: { seq: 0, role: 'user', content_json: [{ type: 'text', text }], created_at: Date.now() },
  },
}), { scope: 'agent' })

function notices(messages: LLMMessage[]): string[] {
  return messages.flatMap(message => Array.isArray(message.content)
    ? message.content.flatMap(block => block.type === 'text' && block.text?.startsWith(NOTICE) ? [block.text] : [])
    : [])
}

class RecordingProvider implements LLMProvider {
  readonly name = 'repetition-test'
  readonly modelId = 'scripted'
  readonly calls: LLMMessage[][] = []
  beforeCall?: (index: number) => Promise<void> | void

  constructor(private readonly batches: number, private readonly batchSize = 1) {}

  async createMessage(options: CreateMessageOptions): Promise<LLMResponse> {
    const index = this.calls.length
    this.calls.push(structuredClone(options.messages))
    await this.beforeCall?.(index)
    const content: ContentBlock[] = index < this.batches
      ? [
          { type: 'text', text: 'Running the experiment.' },
          ...Array.from({ length: this.batchSize }, (_, item): ContentBlock => ({
            type: 'tool_use', id: `call-${index}-${item}`, name: 'sys_fetch',
            input: { key: `private-argument-${item}`, _reason: `attempt ${index}` },
          })),
        ]
      : [{ type: 'text', text: 'Experiment complete.' }]
    return {
      id: `response-${index}`, content,
      stop_reason: index < this.batches ? 'tool_use' : 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }
  }

  async validateConfig() { return { valid: true } }
}

function harness(options: {
  batches?: number
  batchSize?: number
  autonomous?: boolean
  result?: (call: number, input: unknown) => ToolResult
} = {}): { agent: HeadlessAgent; provider: RecordingProvider; executions: () => number } {
  const provider = new RecordingProvider(options.batches ?? 4, options.batchSize)
  let executions = 0
  const tool: Tool = {
    name: 'sys_fetch', description: 'Test experiment tool', category: 'general',
    inputSchema: z.object({ key: z.string() }),
    async execute(input) {
      executions++
      return options.result?.(executions, input) ?? { content: 'private-result', isError: false }
    },
    toProviderFormat() {
      return {
        name: this.name, description: this.description,
        input_schema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
      }
    },
  }
  const agent = createHeadlessAgent({
    provider, profile: 'benchmark', basePrompt: '', toolPrompts: {},
    createOptions: {
      autonomous: options.autonomous ?? true,
      tools: [
        { name: 'sys_fetch', enabled: true, visible: true },
        { name: 'sys_set_state', enabled: false, visible: false },
      ],
    },
    registerTools: registry => registry.register(tool),
  })
  return { agent, provider, executions: () => executions }
}

describe('tool repetition feedback at the provider boundary', () => {
  beforeEach(() => clearAllUmbilicalBuses())

  it.each([false, true])('reports repeated complete batches once (error=%s)', async isError => {
    const { agent, provider, executions } = harness({
      batchSize: 2, result: () => ({ content: 'private-result', isError }),
    })
    try {
      await agent.executor.executeTurn(chat())
      expect(executions()).toBe(8)
      expect(provider.calls.slice(0, 3).every(messages => notices(messages).length === 0)).toBe(true)
      const firstNoticed = provider.calls[3]
      expect(notices(firstNoticed)).toHaveLength(1)
      const noticeIndex = firstNoticed.findIndex(message => notices([message]).length > 0)
      const previous = firstNoticed[noticeIndex - 1].content as ContentBlock[]
      expect(previous).toHaveLength(2)
      expect(previous.every(block => block.type === 'tool_result')).toBe(true)
      expect(notices(provider.calls.at(-1)!)).toHaveLength(1)
      const notice = notices(firstNoticed)[0]
      expect(notice).toContain('identical inputs and returned results (sys_fetch)')
      expect(notice).not.toContain('private-argument')
      expect(notice).not.toContain('private-result')
      // The only state tool is disabled; feedback must not suggest using it.
      expect(notice).not.toContain('sys_set_state')
    } finally { await agent.disposeAsync() }
  })

  it('does not flag identical calls that return new evidence', async () => {
    const { agent, provider, executions } = harness({ result: call => ({ content: `observation-${call}` }) })
    try {
      await agent.executor.executeTurn(chat())
      expect(executions()).toBe(4)
      expect(notices(provider.calls.at(-1)!)).toEqual([])
    } finally { await agent.disposeAsync() }
  })

  it('leaves interactive tool loops unchanged', async () => {
    const { agent, provider, executions } = harness({ autonomous: false })
    try {
      await agent.executor.executeTurn(chat())
      expect(executions()).toBe(4)
      expect(provider.calls).toHaveLength(5)
      expect(notices(provider.calls.at(-1)!)).toEqual([])
    } finally { await agent.disposeAsync() }
  })

  it('does not issue feedback when the repeated batch ends the turn', async () => {
    const { agent, provider, executions } = harness({
      result: call => ({ content: 'same result', endTurn: call === 3 }),
    })
    const feedback: string[] = []
    agent.executor.on('event', event => {
      if (event.type === 'context_injected' && event.payload.content.startsWith(NOTICE)) {
        feedback.push(event.payload.content)
      }
    })
    try {
      await agent.executor.executeTurn(chat())
      expect(executions()).toBe(3)
      expect(provider.calls).toHaveLength(3)
      expect(feedback).toEqual([])
    } finally { await agent.disposeAsync() }
  })

  it.each(['owner input', 'context reset', 'config update', 'injected context'] as const)('starts a fresh observation window after %s', async reset => {
    const { agent, provider, executions } = harness()
    provider.beforeCall = async index => {
      if (index !== 2) return
      if (reset === 'owner input') {
        await agent.executor.executeTurn(chat('Continue this intentional replication.'))
      } else if (reset === 'config update') {
        agent.executor.updateConfig({
          ...agent.workspace.getAgentConfig(), instructions: 'Continue the experiment with the revised instructions.',
        })
      } else if (reset === 'injected context') {
        agent.session.queueContextInjection({
          role: 'user', text: 'The replication parameters have been reviewed.', category: 'state', origin: 'code:test',
        })
      } else {
        agent.executor.resetContextState()
      }
    }
    try {
      await agent.executor.executeTurn(chat())
      expect(executions()).toBe(4)
      expect(notices(provider.calls.at(-1)!)).toEqual([])
      if (reset === 'owner input') {
        expect(JSON.stringify(provider.calls[3])).toContain('Continue this intentional replication.')
      } else if (reset === 'injected context') {
        expect(JSON.stringify(provider.calls[3])).toContain('The replication parameters have been reviewed.')
        expect(agent.session.hasPendingContextInjections()).toBe(false)
      }
    } finally { await agent.disposeAsync() }
  })
})
