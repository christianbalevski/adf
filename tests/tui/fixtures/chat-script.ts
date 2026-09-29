// Scripted data for the chat view tests, layered on the shared mock daemon
// without editing it: extra history rows, pending approvals/asks, and a fetch
// wrapper for endpoints the mock does not implement (POST /trigger).

import type { MockDaemon } from './mock-daemon'

let seq = 100_000

export function seedHistory(mock: MockDaemon, agentId: string, loop: string, count: number, startAt = Date.now() - 30 * 60_000): void {
  const agent = mock.agents.get(agentId)
  if (!agent) throw new Error(`no agent ${agentId}`)
  const rows = (agent.history[loop] ??= [])
  for (let i = 0; i < count; i++) {
    const role: 'user' | 'assistant' = i % 2 === 0 ? 'user' : 'assistant'
    rows.push({ seq: seq++, role, content_json: [{ type: 'text', text: `${role === 'user' ? 'question' : 'answer'} ${i}` }], created_at: startAt + i * 1000, ...(role === 'assistant' ? { model: 'mock-model' } : {}) })
  }
}

export function addPendingTask(mock: MockDaemon, agentId: string, task: { id: string; tool: string; args: Record<string, unknown>; loop?: string }): void {
  const agent = mock.agents.get(agentId)!
  agent.tasks.push({ id: task.id, tool: task.tool, args: JSON.stringify(task.args), status: 'pending_approval', created_at: Date.now(), ...(task.loop ? { origin: `loop:${task.loop}` } : {}), approval_meta: { reason: 'restricted' } })
  mock.emit({ event_type: 'hil.requested', agent_id: agentId, loop: task.loop, payload: { request_id: task.id, task_id: task.id, tool: task.tool, reason: 'restricted', input: task.args } })
}

export function addAsk(mock: MockDaemon, agentId: string, requestId: string, question: string, loop?: string): void {
  mock.agents.get(agentId)!.asks.push({ requestId, question, ...(loop ? { loop } : {}) })
  mock.emit({ event_type: 'ask.requested', agent_id: agentId, loop, payload: { request_id: requestId, question } })
}

export interface CapturedCall {
  method: string
  path: string
  body: unknown
}

/** fetch that answers POST /agents/:id/trigger itself and passes everything else to the mock. */
export function triggerFetch(calls: CapturedCall[], next: typeof fetch = globalThis.fetch.bind(globalThis)): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const method = init?.method ?? 'GET'
    if (method === 'POST' && /^\/agents\/[^/]+\/trigger$/.test(url.pathname)) {
      calls.push({ method, path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      return new Response(JSON.stringify({ accepted: true, turnId: 'trigger_test1' }), { status: 202, headers: { 'Content-Type': 'application/json' } })
    }
    return next(input, init)
  }) as typeof fetch
}
