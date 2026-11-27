/**
 * A tool call with no recorded result stays visible to the model, with its
 * outcome unknown, wherever it sits in the history, and the request stays valid
 * (every tool_use is answered in the next user message).
 */
import { describe, it, expect } from 'vitest'
import { AgentSession } from '../../../src/main/runtime/agent-session'
import type { LLMMessage, ContentBlock } from '../../../src/shared/types/provider.types'

const text = (t: string) => [{ type: 'text' as const, text: t }]
const use = (id: string) => ({ type: 'tool_use' as const, id, name: 'fs_write', input: { path: 'a.md', content: 'x' } })
const res = (id: string) => ({ type: 'tool_result' as const, tool_use_id: id, content: 'ok' })
const blocks = (m: LLMMessage) => (Array.isArray(m.content) ? m.content : []) as ContentBlock[]

function restore(rows: LLMMessage[]): LLMMessage[] {
  const s = new AgentSession({} as never)
  s.restoreMessages(rows.map(r => ({ ...r, content: Array.isArray(r.content) ? [...r.content] : r.content })))
  return s.getMessages()
}
/** Every tool_use is answered by a tool_result in the next message, and every result has a call. */
function valid(msgs: LLMMessage[]): boolean {
  for (let i = 0; i < msgs.length; i++) {
    const ids = blocks(msgs[i]).flatMap(b => b.type === 'tool_use' ? [b.id] : [])
    if (ids.length === 0) continue
    const next = msgs[i + 1]
    if (!next || next.role !== 'user') return false
    const answered = new Set(blocks(next).flatMap(b => b.type === 'tool_result' ? [b.tool_use_id] : []))
    if (!ids.every(id => answered.has(id))) return false
  }
  return true
}
const callVisible = (msgs: LLMMessage[], id: string) =>
  msgs.some(m => blocks(m).some(b => b.type === 'tool_use' && b.id === id)) &&
  msgs.some(m => blocks(m).some(b => b.type === 'tool_result' && b.tool_use_id === id && b.is_error))

describe('a tool call with no recorded result', () => {
  it('at the tail: stays visible and the request is valid', () => {
    const out = restore([{ role: 'user', content: text('hi') }, { role: 'assistant', content: [use('a')] }])
    expect(valid(out)).toBe(true)
    expect(callVisible(out, 'a')).toBe(true)
  })
  it('in the middle, followed by an owner message: stays visible after the next restore', () => {
    const out = restore([
      { role: 'user', content: text('hi') },
      { role: 'assistant', content: [{ type: 'text', text: 'writing' }, use('a')] },
      { role: 'user', content: text('did it work?') },
      { role: 'assistant', content: text('not sure') },
      { role: 'user', content: text('Continue.') },
    ])
    expect(valid(out)).toBe(true)
    expect(callVisible(out, 'a')).toBe(true)
    expect(out.some(m => blocks(m).some(b => b.type === 'text' && b.text === 'did it work?'))).toBe(true)
  })
  it('in the middle, followed by another assistant row: a result row is inserted', () => {
    const out = restore([
      { role: 'user', content: text('hi') },
      { role: 'assistant', content: [use('a')] },
      { role: 'assistant', content: text('later') },
      { role: 'user', content: text('Continue.') },
    ])
    expect(valid(out)).toBe(true)
    expect(callVisible(out, 'a')).toBe(true)
  })
  it('one of two parallel calls has no result: the missing one is answered, the recorded one kept', () => {
    const out = restore([
      { role: 'user', content: text('hi') },
      { role: 'assistant', content: [use('a'), use('b')] },
      { role: 'user', content: [res('a')] },
      { role: 'assistant', content: text('done') },
      { role: 'user', content: text('Continue.') },
    ])
    expect(valid(out)).toBe(true)
    expect(callVisible(out, 'b')).toBe(true)
    expect(out.some(m => blocks(m).some(b => b.type === 'tool_result' && b.tool_use_id === 'a' && b.content === 'ok'))).toBe(true)
  })
  it('the repair is stable: restoring the repaired history again changes nothing', () => {
    const rows: LLMMessage[] = [
      { role: 'user', content: text('hi') }, { role: 'assistant', content: [use('a')] },
      { role: 'user', content: text('did it work?') }, { role: 'assistant', content: text('ok') },
    ]
    const once = restore(rows)
    expect(JSON.stringify(restore(once))).toBe(JSON.stringify(once))
  })
})
