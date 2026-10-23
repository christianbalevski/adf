import { z } from 'zod'
import { createHeadlessAgent, MockLLMProvider } from '../../../src/main/runtime/headless'
import { createDispatch, createEvent } from '../../../src/shared/types/adf-event.types'
import { describe, expect, it, vi } from 'vitest'
import { AgentSession } from '../../../src/main/runtime/agent-session'
import { formatOwnerCommandRow } from '../../../src/shared/utils/owner-command-row'
import { AgentExecutor } from '../../../src/main/runtime/agent-executor'
import type { AgentConfig } from '../../../src/shared/types/adf-v02.types'
function fixture(hydrated = true) {
  const messages: any[] = hydrated ? [{ role: 'user', content: 'history' }] : []
  let seq = 0
  const workspace = { getFilePath: () => '/agent.adf', insertLog: vi.fn(), appendToLoop: vi.fn(() => ++seq) }
  const session = { getWorkspace: () => workspace, getMessages: () => messages, addMessage: vi.fn((message: any, _: any, opts: any) => { message.seq = opts?.seq ?? ++seq; messages.push(message) }), flushToLoop: vi.fn() }
  const executor = new AgentExecutor({ id: 'a', name: 'a', model: { provider: 'anthropic', model_id: 'test' }, tools: [], triggers: {}, limits: { max_tool_result_tokens: 100, max_tool_result_preview_chars: 100 } } as unknown as AgentConfig, {} as never, {} as never, session as never)
  const events: any[] = []
  executor.on('event', e => events.push(e))
  return { executor, session, workspace, messages, events }
}
describe('owner command safe records', () => {
  it.each([true, false])('persists idle record without populating a swept session (%s)', hydrated => {
    const f = fixture(hydrated)
    expect(f.executor.recordOwnerCommand('record')).toEqual({ deferred: false, seq: 1 })
    expect(f.workspace.appendToLoop).toHaveBeenCalledWith('user', [{ type: 'text', text: 'record' }])
    expect(f.messages.length).toBe(hydrated ? 2 : 0)
    if (hydrated) expect(f.messages[1].seq).toBe(1)
  })
  it('defers active records and flushes oldest first at boundary', () => {
    const f = fixture()
    const internal = f.executor as any
    internal.activeTurnCount = 1
    expect(f.executor.recordOwnerCommand('first')).toEqual({ deferred: true })
    f.executor.recordOwnerCommand('second')
    expect(f.session.addMessage).not.toHaveBeenCalled()
    expect(f.workspace.appendToLoop).not.toHaveBeenCalled()
    internal.flushOwnerCommandRecords()
    expect(f.messages.slice(1).map(m => m.content[0].text)).toEqual(['first', 'second'])
    expect(f.session.flushToLoop).toHaveBeenCalledTimes(2)
  })
  it('flushes before teardown and ignores a late completion', () => {
    const f = fixture()
    const internal = f.executor as any
    internal.activeTurnCount = 1
    f.executor.recordOwnerCommand('queued')
    internal.discardQueuedChats('stopped')
    expect(f.messages[1].content[0].text).toBe('queued')
    f.executor.recordOwnerCommand('late')
    expect(f.messages).toHaveLength(2)
    expect(f.workspace.insertLog).toHaveBeenCalled()
  })
  it('restores the durable row as ordinary user content', () => {
    const text = formatOwnerCommandRow({ v: 1, id: 'cmd', command: '/test', lambda: 'a.ts:run', authorized: false, status: 'ok', duration_ms: 1 }, 'result')
    const session = new AgentSession({} as never)
    session.restoreMessages([{ role: 'user', content: [{ type: 'text', text }], seq: 7 }])
    expect(session.getMessages()).toHaveLength(1)
    expect(session.getMessages()[0]).toMatchObject({ seq: 7, content: [{ type: 'text', text }] })
  })
  it('bounds large command returns with existing tool truncation', () => {
    const f = fixture()
    const result = f.executor.boundToolResult('x'.repeat(1000000), '/big')
    expect(result).toContain('[TRUNCATED]')
    expect(result.length).toBeLessThan(2000)
  })
  it('keeps a swept session empty when an active system dispatch releases queued records', async () => {
    const provider = new MockLLMProvider()
    const agent = createHeadlessAgent({ name: 'system-records', provider, profile: 'benchmark', registerTools() {} })
    let release!: () => void
    let started!: () => void
    const entered = new Promise<void>(resolve => { started = resolve })
    const blocked = new Promise<void>(resolve => { release = resolve })
    agent.executor.setSystemScopeHandler({ execute: async () => { started(); await blocked } } as never)
    try {
      agent.session.addMessage({ role: 'user', content: [{ type: 'text', text: 'old history' }] })
      agent.session.flushToLoop()
      agent.session.restoreMessages([])
      const events: any[] = []
      agent.executor.on('event', event => events.push(event))
      const running = agent.executor.executeTurn(createDispatch(createEvent({ type: 'timer', source: 'test', data: {} }), { scope: 'system', lambda: 'tick.ts:run' }))
      await entered
      expect(agent.executor.recordOwnerCommand('command after sweep')).toEqual({ deferred: true })
      release()
      await running
      expect(agent.session.getMessages()).toHaveLength(0)
      const rows = agent.workspace.getLoop()
      expect(rows.map(row => row.content_json[0].text)).toEqual(['old history', 'command after sweep'])
      expect(events.find(event => event.type === 'context_injected' && event.payload.category === 'owner_command')?.payload.seq).toBe(rows[1].seq)
      agent.session.restoreMessages(rows.map(row => ({ role: row.role, content: row.content_json, seq: row.seq })))
      expect(agent.session.getMessages().map(message => (message.content as any)[0].text)).toEqual(['old history', 'command after sweep'])
    } finally { release(); await agent.disposeAsync({ mode: 'immediate' }) }
  })
  it.each([false, true])('never splits a real tool exchange, including stop (%s)', async stop => {
    let release!: () => void
    let started!: () => void
    const toolStarted = new Promise<void>(r => { started = r })
    const blocked = new Promise<void>(r => { release = r })
    const provider = new MockLLMProvider()
    let calls = 0
    vi.spyOn(provider, 'createMessage').mockImplementation(async () => ({ id: 'response', content: ++calls === 1 ? [{ type: 'tool_use', id: 'tool-1', name: 'fs_read', input: { path: 'a.txt' } }] : [{ type: 'text', text: 'done' }], stop_reason: calls === 1 ? 'tool_use' : 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }))
    const agent = createHeadlessAgent({ name: 'records', provider, profile: 'benchmark', createOptions: { tools: [{ name: 'fs_read', enabled: true, restricted: false }] }, registerTools(registry) {
      registry.register({ name: 'fs_read', description: 'hold', inputSchema: z.object({ path: z.string() }), toProviderFormat: () => ({ name: 'fs_read', description: 'hold', input_schema: { type: 'object' } }), execute: async () => { started(); await blocked; return { content: 'read', isError: false } } } as any)
    } })
    try {
      const running = agent.executor.executeTurn(createDispatch(createEvent({ type: 'chat', source: 'test', data: { message: { seq: 0, role: 'user', content_json: [{ type: 'text', text: 'hello' }], created_at: 1 } } }), { scope: 'agent' }))
      await toolStarted
      expect(agent.executor.recordOwnerCommand('durable command')).toEqual({ deferred: true })
      expect(JSON.stringify(agent.workspace.getLoop())).not.toContain('durable command')
      if (stop) agent.executor.abort()
      release()
      await running
      const rows = agent.workspace.getLoop()
      const toolUse = rows.findIndex(row => row.content_json.some(b => b.type === 'tool_use'))
      const toolResult = rows.findIndex(row => row.content_json.some(b => b.type === 'tool_result'))
      const command = rows.findIndex(row => row.content_json.some(b => b.text === 'durable command'))
      expect(toolUse).toBeGreaterThanOrEqual(0)
      expect(toolResult).toBeGreaterThan(toolUse)
      expect(command).toBeGreaterThan(toolResult)
    } finally { release(); await agent.disposeAsync({ mode: 'immediate' }) }
  })

})
