import { describe, expect, it, vi } from 'vitest'
import { createHeadlessAgent, MockLLMProvider } from '../../../src/main/runtime/headless'
import { createDispatch, createEvent } from '../../../src/shared/types/adf-event.types'
import type { ContentBlock } from '../../../src/shared/types/provider.types'
import type { AgentExecutionEvent } from '../../../src/shared/types/ipc.types'

const malformed: ContentBlock[] = [
  { type: 'tool_use', name: 'sys_code', input: {} },
  { type: 'tool_use', id: 'call-1', input: {} },
]

describe('provider tool-call validation', () => {
  it.each(malformed)('rejects a tool call missing its id or name before execution: %j', async (block) => {
    const provider = new MockLLMProvider()
    vi.spyOn(provider, 'createMessage').mockResolvedValue({ id: 'reply-1', content: [block], stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } })
    const agent = createHeadlessAgent({ name: 'agent-1', provider, profile: 'benchmark', registerTools() {} })
    const execute = vi.spyOn(agent.registry, 'executeTool')
    const events: AgentExecutionEvent[] = []
    agent.executor.on('event', (event: AgentExecutionEvent) => events.push(event))
    try {
      await agent.executor.executeTurn(createDispatch(createEvent({ type: 'chat', source: 'test', data: { message: { seq: 0, role: 'user', content_json: [{ type: 'text', text: 'hello' }], created_at: 1234 } } }), { scope: 'agent' }))
      expect(execute).not.toHaveBeenCalled()
      expect(agent.executor.getState()).toBe('error')
      expect(JSON.stringify(events.filter((event) => event.type === 'error'))).toContain('Provider returned a tool call without a valid id and name')
    } finally { await agent.disposeAsync({ mode: 'immediate' }) }
  })
})
