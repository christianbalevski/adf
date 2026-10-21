import { describe, expect, it } from 'vitest'
import { contextLabel, describeWake, mergeInstructionRows } from '../../../src/renderer/utils/loop-labels'
import { useAgentStore, type AgentLogEntry } from '../../../src/renderer/stores/agent.store'
import { createAgentEventHandler } from '../../../src/renderer/hooks/useAgent'
import { parseLoopToDisplay } from '../../../src/shared/utils/loop-parser'
import type { AgentExecutionEvent } from '../../../src/shared/types/ipc.types'

const wake = (triggerType: string, content: string): AgentLogEntry =>
  ({ id: 'w', type: 'trigger', content, timestamp: 1, metadata: { triggerType } })
const context = (id: string, metadata: Record<string, unknown>, content = 'text'): AgentLogEntry =>
  ({ id, type: 'context', content, timestamp: 1, metadata })

describe('describeWake', () => {
  it.each([
    ['timer', 'A scheduled timer has fired.\nPayload: check the deploy', { tag: 'Timer', detail: 'check the deploy' }],
    ['timer', 'A scheduled timer has fired.\nCheck your mind for context on what to do next.', { tag: 'Timer' }],
    ['inbox', '[Inbox notification] New messages.\n\n{\n  "unread": 3,\n  "read": 1\n}', { tag: 'Inbox', detail: '3 unread' }],
    ['file_change', 'A file has been modified: notes/plan.md\n\nChanges:\n\n+x', { tag: 'File change', detail: 'modified: notes/plan.md' }],
    ['task_complete', 'A task has completed.\nTask ID: t1\nTool: fs_write\nStatus: completed', { tag: 'Task done', detail: 'fs_write · completed' }],
    ['startup', 'Agent started. Review your mind for context and take any startup actions.', { tag: 'Startup' }],
    ['mystery', 'You have been triggered.', { tag: 'Wake' }],
  ])('%s', (type, content, expected) => {
    expect(describeWake(wake(type, content))).toEqual(expected)
  })
})

describe('contextLabel', () => {
  it('names who added the context', () => {
    expect(contextLabel(context('a', { category: 'provider_context', addedBy: 'Claude Code' }))).toBe('Added by Claude Code')
    expect(contextLabel(context('a', { category: 'provider_context' }))).toBe('Added by provider')
    expect(contextLabel(context('a', { category: 'injected', injectCategory: 'notes', origin: 'lambda:x.ts' }))).toBe('Agent added context · notes')
    expect(contextLabel(context('a', { category: 'injected', injectCategory: 'skills_registry', origin: 'system:skill_indexer' }))).toBe('Added by runtime · skills_registry')
    expect(contextLabel(context('a', { category: 'instructions' }))).toBe('Instructions updated')
  })
})

describe('mergeInstructionRows', () => {
  it('joins a system prompt and the dynamic instructions after it into one row', () => {
    const merged = mergeInstructionRows([
      context('sp', { category: 'system_prompt', seq: 4 }, 'You are an agent.'),
      context('di', { category: 'dynamic_instructions', seq: 5 }, '2 unread.'),
    ])
    expect(merged).toEqual([context('sp', { category: 'instructions', seq: 4 }, 'System prompt\n\nYou are an agent.\n\nDynamic instructions\n\n2 unread.')])
  })

  it('leaves a lone row alone', () => {
    const rows = [context('di', { category: 'dynamic_instructions' }), context('sp', { category: 'system_prompt' })]
    expect(mergeInstructionRows(rows)).toEqual(rows)
  })
})

describe('live loop rows', () => {
  const run = (events: AgentExecutionEvent[]) => {
    const g = globalThis as { window?: unknown }
    const before = g.window
    g.window = { adfApi: new Proxy({}, { get: () => async () => ({}) }) }
    try {
      useAgentStore.getState().reset()
      const handle = createAgentEventHandler()
      for (const event of events) handle(event)
      return useAgentStore.getState().log
    } finally {
      g.window = before
    }
  }

  it('an incoming message adds no row: it is in the inbox, not the loop, until msg_read', () => {
    expect(run([{ type: 'inter_agent_message', payload: { fromAgent: 'a', toAgent: 'b', content: 'secret plan', direction: 'incoming' }, timestamp: 1 } as AgentExecutionEvent])).toEqual([])
  })

  it('a loop_inject row reads the same live as on reload', () => {
    const text = '[Context: notes | loop_inject=v2 | origin=lambda:x.ts] remember'
    const [live] = run([{ type: 'context_injected', payload: { category: 'notes', origin: 'lambda:x.ts', content: text, seq: 9 }, timestamp: 1 } as AgentExecutionEvent])
    const [loaded] = parseLoopToDisplay([{ seq: 9, role: 'user', content_json: [{ type: 'text', text }], created_at: 1 }])
    expect(live.content).toBe(loaded.content)
    expect(live.metadata).toEqual(loaded.metadata)
  })

  it('a wake is named from its text, as on reload', () => {
    const [live] = run([{ type: 'trigger_message', payload: { content: 'A scheduled timer has fired.\nPayload: x', triggerType: 'timer' }, timestamp: 1 } as AgentExecutionEvent])
    expect(live).toMatchObject({ type: 'trigger', metadata: { triggerType: 'timer' } })
  })

  it('provider context keeps the provider name live', () => {
    const [live] = run([{ type: 'context_injected', payload: { category: 'provider_context', addedBy: 'Claude Code', content: 'Today is Tuesday.' }, timestamp: 1 } as AgentExecutionEvent])
    expect(contextLabel(live)).toBe('Added by Claude Code')
  })
})
