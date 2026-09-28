// Loop rows and transcript items for the tool-rendering tests (`_reason`,
// `_async`, `say`, `ask`, status lines), layered on the shared mock daemon
// without editing it.

import type { ToolItem } from '../../../src/main/tui/state/types'
import type { MockDaemon } from './mock-daemon'

interface Block { type: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: string; is_error?: boolean }

let seq = 200_000

export function pushRow(mock: MockDaemon, agentId: string, loop: string, role: 'user' | 'assistant', blocks: Block[], at = Date.now()): void {
  const agent = mock.agents.get(agentId)
  if (!agent) throw new Error(`no agent ${agentId}`)
  ;(agent.history[loop] ??= []).push({ seq: seq++, role, content_json: blocks as never, created_at: at, ...(role === 'assistant' ? { model: 'mock-model' } : {}) })
}

/** A tool call row + its result row. */
export function pushToolCall(mock: MockDaemon, agentId: string, loop: string, call: { id: string; name: string; input: unknown; result?: string; isError?: boolean }, at = Date.now()): void {
  pushRow(mock, agentId, loop, 'assistant', [{ type: 'tool_use', id: call.id, name: call.name, input: call.input }], at)
  if (call.result !== undefined) pushRow(mock, agentId, loop, 'user', [{ type: 'tool_result', tool_use_id: call.id, content: call.result, ...(call.isError ? { is_error: true } : {}) }], at + 1)
}

export const TASK_REF = JSON.stringify({ task_id: 'task_bg1', status: 'running', tool: 'sys_fetch' })

/** One of every tool presentation, persisted in `loop` (default main). */
export function seedToolHistory(mock: MockDaemon, agentId: string, loop = 'main', start = Date.now() - 10 * 60_000): void {
  let at = start
  const next = () => (at += 1000)
  pushToolCall(mock, agentId, loop, { id: 'tu_reason', name: 'msg_read', input: { _reason: 'Reconcile delivery state', status: 'unread' }, result: '3 messages' }, next())
  pushToolCall(mock, agentId, loop, { id: 'tu_plain', name: 'fs_list', input: { prefix: 'notes/' }, result: 'notes/api.md' }, next())
  pushToolCall(mock, agentId, loop, { id: 'tu_async', name: 'sys_fetch', input: { url: 'https://example.com/docs', _async: true, _reason: 'Fetch the docs in the background' }, result: TASK_REF }, next())
  pushToolCall(mock, agentId, loop, { id: 'tu_say', name: 'say', input: { message: 'The weekly report is **ready**.', _reason: 'Tell the owner' }, result: 'Message delivered' }, next())
  pushToolCall(mock, agentId, loop, { id: 'tu_meta', name: 'sys_set_meta', input: { key: 'status', value: 'Reconciling inbox' }, result: 'ok' }, next())
  pushToolCall(mock, agentId, loop, { id: 'tu_state', name: 'sys_set_state', input: { state: 'idle', _reason: 'Nothing left to do' }, result: 'State set to idle' }, next())
  pushToolCall(mock, agentId, loop, { id: 'tu_ask', name: 'ask', input: { question: 'Ship the release today?' }, result: 'Human answered: yes, after lunch' }, next())
}

let n = 0

export function toolItem(patch: Partial<ToolItem> & { name: string }): ToolItem {
  n += 1
  return { id: `t:${n}`, at: n, kind: 'tool', input: {}, status: 'ok', ...patch }
}
