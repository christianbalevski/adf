import { describe, expect, it, vi } from 'vitest'
import { createHeadlessAgent, MockLLMProvider } from '../../../src/main/runtime/headless'
import { createDispatch, createEvent } from '../../../src/shared/types/adf-event.types'
import type { ContentBlock, LLMMessage } from '../../../src/shared/types/provider.types'
import type { AgentExecutionEvent } from '../../../src/shared/types/ipc.types'

const malformed: ContentBlock[] = [
  { type: 'tool_use', name: 'sys_code', input: {} },
  { type: 'tool_use', id: 'call-1', input: {} },
]

describe('provider tool-call validation', () => {
  it('checks only appended tool blocks and discards old IDs after a session reset', async () => {
    const agent = createHeadlessAgent({ name: 'agent-1', provider: new MockLLMProvider(), profile: 'benchmark' })
    const initialContent = vi.fn(() => 'hello')
    const original: LLMMessage = { role: 'user', get content() { return initialContent() } }
    const result: LLMMessage = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'joined', content: 'done' }] }
    const repair = vi.spyOn(agent.session, 'repairToolPairing')
    try {
      agent.session.addMessage(original, undefined, { skipLoop: true })
      agent.session.addMessage({ role: 'assistant', content: [{ type: 'tool_use', id: 'joined', name: 'tool', input: {} }] }, undefined, { skipLoop: true })
      agent.session.addMessage(result, undefined, { skipLoop: true })
      agent.executor['checkToolPairing']()
      expect(initialContent).toHaveBeenCalled()
      expect(repair).not.toHaveBeenCalled()

      initialContent.mockClear()
      agent.session.addMessage(result, undefined, { skipLoop: true })
      agent.executor['checkToolPairing']()
      expect(initialContent).not.toHaveBeenCalled()
      expect(repair).not.toHaveBeenCalled()

      agent.session.reset()
      agent.session.addMessage({ role: 'user', content: 'new session' }, undefined, { skipLoop: true })
      agent.session.addMessage(result, undefined, { skipLoop: true })
      agent.executor['checkToolPairing']()
      expect(repair).toHaveBeenCalledOnce()
      expect(result.content).toEqual([{ type: 'text', text: '[Tool result removed — no matching call in history]' }])
    } finally { await agent.disposeAsync({ mode: 'immediate' }) }
  })

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
