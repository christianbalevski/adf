/**
 * Recorded executor/host event sequence for the background event mapping
 * (W1-F). Covers every `AgentExecutionEvent` type the executor emits, the
 * host-only `adf_file_created`, and the edge cases the mapping has to keep:
 * equal-valued state repeats (batcher collapse), unknown states, side-loop
 * counting and main-off clearing, payloads that carry their own `filePath`,
 * missing payloads, and large / non-string tool results (renderer stripping).
 *
 * Timestamps are fixed so the recording is deterministic.
 */

export interface RecordedEvent {
  type: string
  payload: unknown
  timestamp: number
  loop?: string
}

export const CHILD_PATH = '/agents/agent-2.adf'

let ts = 1_000
const ev = (type: string, payload: unknown, loop?: string): RecordedEvent =>
  loop === undefined ? { type, payload, timestamp: ts++ } : { type, payload, timestamp: ts++, loop }

export const RECORDED_EVENTS: RecordedEvent[] = [
  // Main turn: thinking → tool_use collapse to one display state.
  ev('state_changed', { state: 'thinking' }),
  ev('state_changed', { state: 'tool_use' }),
  ev('text_delta', { delta: 'Hel' }),
  ev('text_delta', { delta: 'lo' }),
  ev('text_delta_batch', { deltas: ['a', 'b'] }),
  ev('thinking_delta', { delta: 'hmm' }),
  ev('thinking_delta_batch', { deltas: ['x'] }),
  ev('tool_call_start', { name: 'fs_read', input: { path: 'a.md' }, id: 'toolu_1', seq: 7 }),
  // Large string result: kept whole on the manager's emitter, stripped for the renderer.
  ev('tool_call_result', {
    name: 'fs_read', id: 'toolu_1',
    result: { content: 'x'.repeat(200), isError: false },
    targetPaths: ['a.md'], documentPath: 'document.md',
  }),
  // Non-string content and an error flag that is truthy but not boolean.
  ev('tool_call_result', { name: 'sys_code', id: 'toolu_2', result: { content: [{ type: 'text', text: 'boom' }], isError: 1 } }),
  // Result with no result object at all.
  ev('tool_call_result', { name: 'noop', id: 'toolu_3' }),
  ev('tool_call_start', { name: 'ask', input: { question: 'ok?' }, id: 'toolu_4' }),
  ev('ask_request', { requestId: 'req-ask-1', question: 'ok?' }),
  ev('state_changed', { state: 'awaiting_ask' }),
  ev('ask_response', { requestId: 'req-ask-1', answer: 'yes' }),
  ev('tool_call_result', { name: 'ask', id: 'toolu_4', result: { content: 'Human answered: yes', isError: false } }),
  ev('tool_approval_request', {
    requestId: 'task-1', taskId: 'task-1', name: 'fs_write', input: { path: 'b.md' },
    reason: 'restricted', canAlwaysApprove: true,
  }),
  ev('state_changed', { state: 'awaiting_approval' }),
  ev('state_changed', { state: 'suspended' }),
  ev('tool_approval_resolved', { requestId: 'task-1', approved: true }),
  ev('response_metadata', { model: 'mock-model', usage: { input: 10, output: 2 } }),
  ev('response_metadata', { model: 'mock-model', usage: { input: 5, output: 0 }, estimated: true }),
  ev('turn_complete', { content: [{ type: 'text', text: 'Hello' }], seq: 9 }),
  ev('state_changed', { state: 'idle' }),
  // Error turn.
  ev('state_changed', { state: 'thinking' }),
  ev('error', { error: 'Provider unavailable', details: 'HTTP 503' }),
  ev('state_changed', { state: 'error' }),
  ev('turn_complete', { content: [], interrupted: true }),
  // Events the mapping drops.
  ev('autosaved', {}),
  ev('document_updated', { content: '# doc' }),
  ev('chat_updated', { messages: [] }),
  ev('inter_agent_message', { from: 'agent-2', content: 'hi' }),
  ev('suspend_request', {}),
  ev('trigger_message', { content: 'tick' }),
  ev('file_updated', { path: 'notes.md', content: 'n', previousContent: '' }),
  ev('context_injected', { category: 'System', content: 'notice' }),
  ev('loop_seq', { seq: 9, toolUseIds: ['toolu_1'] }),
  // Host event: a child agent file was created. Note `filePath` is the child.
  ev('adf_file_created', { filePath: CHILD_PATH, extra: 'dropped' }),
  // Payload with its own filePath: the spread puts it after the agent's path.
  ev('tool_call_start', { filePath: '/elsewhere/agent-3.adf', name: 'x', id: 'toolu_5' }),
  // Missing payloads.
  ev('error', undefined),
  ev('turn_complete', null),
  // Explicit main loop behaves as the implicit one.
  ev('state_changed', { state: 'active' }, 'main'),
  ev('state_changed', { state: 'hibernate' }),
  ev('state_changed', { state: 'not-a-state' }),
  ev('state_changed', { state: 'idle' }),
  // Side loops: counted apart, never move main's state or text.
  ev('state_changed', { state: 'thinking' }, 'loop-a'),
  ev('state_changed', { state: 'tool_use' }, 'loop-b'),
  ev('state_changed', { state: 'tool_use' }, 'loop-a'),
  ev('text_delta', { delta: 'side' }, 'loop-a'),
  ev('tool_call_start', { name: 'fs_read', id: 'toolu_s1' }, 'loop-a'),
  ev('tool_call_result', { name: 'fs_read', id: 'toolu_s1', result: { content: 's', isError: false } }, 'loop-a'),
  ev('ask_request', { requestId: 'req-side', question: 'side?' }, 'loop-b'),
  ev('error', { error: 'side failure' }, 'loop-b'),
  ev('turn_complete', { content: [] }, 'loop-a'),
  ev('adf_file_created', { filePath: CHILD_PATH }, 'loop-a'),
  ev('state_changed', { state: 'idle' }, 'loop-a'),
  // Main idle does not clear side loops; main off does.
  ev('state_changed', { state: 'idle' }),
  ev('state_changed', { state: 'stopped' }),
  // Off again with no side loops left: no loop event.
  ev('state_changed', { state: 'off' }),
  // Side loops all idle when main goes off: cleared, count unchanged, no loop event.
  ev('state_changed', { state: 'idle' }, 'loop-c'),
  ev('state_changed', { state: 'off' }),
  // A side loop reporting off, then main restarting.
  ev('state_changed', { state: 'thinking' }, 'loop-d'),
  ev('state_changed', { state: 'off' }, 'loop-d'),
  ev('state_changed', { state: 'thinking' }),
  ev('text_delta', { delta: 'again' }),
  ev('turn_complete', { content: [{ type: 'text', text: 'again' }] }),
]
