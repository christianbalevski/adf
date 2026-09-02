import { describe, it, expect } from 'vitest'
import { AgentExecutor } from '../../../src/main/runtime/agent-executor'
import { DEFAULT_DYNAMIC_PROMPTS } from '../../../src/shared/constants/adf-defaults'

/**
 * Dynamic instruction templates: settings override → default resolution and
 * lenient {{token}} substitution, exercised through the executor's private
 * dynamicPrompt helper (its only dependency is the toolPrompts record, so
 * the executor is constructed with stubs).
 */
function makeExecutor(toolPrompts: Record<string, string> = {}) {
  const stub = {} as never
  return new AgentExecutor({ tools: [] } as never, stub, stub, stub, '', toolPrompts)
}

function dyn(executor: AgentExecutor, key: string, vars?: Record<string, string>): string {
  return (executor as unknown as { dynamicPrompt(k: string, v?: Record<string, string>): string }).dynamicPrompt(key, vars)
}

describe('dynamic instruction templates', () => {
  it('substitutes placeholders into the default template', () => {
    const text = dyn(makeExecutor(), 'dyn_inbox_hint', { unread: '3' })
    expect(text).toBe('[Inbox: 3 unread] msg_read to read; msg_send with parent_id to reply.')
  })

  it('a settings override replaces the default and still substitutes', () => {
    const ex = makeExecutor({ dyn_inbox_hint: 'You have {{unread}} new messages.' })
    expect(dyn(ex, 'dyn_inbox_hint', { unread: '7' })).toBe('You have 7 new messages.')
  })

  it('is lenient: unknown tokens stay verbatim, extra vars are ignored', () => {
    const ex = makeExecutor({ dyn_mesh_update: 'Agents: {{agent_list}} at {{no_such_token}}' })
    expect(dyn(ex, 'dyn_mesh_update', { agent_list: '- a', unused: 'x' })).toBe('Agents: - a at {{no_such_token}}')
  })

  it('a blanked template resolves empty so the injection is suppressed', () => {
    const ex = makeExecutor({ dyn_idle_reminder: '' })
    expect(dyn(ex, 'dyn_idle_reminder')).toBe('')
  })

  it('context warnings substitute all three counters', () => {
    const text = dyn(makeExecutor(), 'dyn_context_warning_imminent', {
      chat_tokens: '96,000', threshold: '100,000', tokens_until: '4,000'
    })
    expect(text).toContain('96,000 tokens (threshold: 100,000)')
    expect(text).toContain('4,000 tokens away')
    expect(text).not.toContain('{{')
  })

  it('every default template exists for its executor lookup key', () => {
    // dyn_inbox_reply_routing is deliberately blank by default (routing lives in
    // the msg_send tool schema) — the key still exists so settings can override it.
    for (const key of ['dyn_inbox_hint', 'dyn_inbox_reply_routing', 'dyn_context_warning_soft', 'dyn_context_warning_imminent', 'dyn_mesh_update', 'dyn_mesh_update_empty', 'dyn_idle_reminder']) {
      expect(key in DEFAULT_DYNAMIC_PROMPTS, key).toBe(true)
    }
    expect(DEFAULT_DYNAMIC_PROMPTS.dyn_inbox_hint).toBeTruthy()
    expect(DEFAULT_DYNAMIC_PROMPTS.dyn_inbox_reply_routing).toBe('')
  })
})
