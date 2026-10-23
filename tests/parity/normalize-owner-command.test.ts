import { describe, expect, it } from 'vitest'
import { normalizeRecording, type NormalizationContext } from './harness/normalize'
import type { ComparableRecording } from './harness/recording'

const ctx: NormalizationContext = { rootSpellings: [], ports: [], named: [], fixtureIds: [], window: { from: 0, to: 0 } }
function recording(duration: number, status = 'ok', result = 'hi'): ComparableRecording {
  const header = { v: 1, id: 'command-1', command: '/echo hi', lambda: 'a.ts:echo', authorized: false, status, duration_ms: duration }
  const row = `[Owner command] ${JSON.stringify(header)}\n${result}`
  return {
    scenario: 'commands', steps: [{ kind: 'invoke', channel: 'adf:agent:run-command', args: [], pushes: { before: 0, after: 1 }, result: { id: 'command-1', name: 'echo', loop: 'main', status, authorized: false, result, durationMs: duration, deferred: false } }],
    pushes: { 'adf:agent:event': [
      { type: 'context_injected', payload: { content: row, category: 'owner_command', ownerCommand: header } },
      { type: 'response_metadata', payload: { model: 'test', estimated: true, usage: { input: 100 + String(duration).length, output: 0 } } },
      { type: 'response_metadata', payload: { model: 'test', usage: { input: 100, output: 10 } } },
    ] }, timelines: {}, local: [],
    llm: [{ model: 'test', stream: true, tools: [], system: '', messages: [{ role: 'user', text: row }] }],
    state: { adf: { 'agent.adf': { tables: { adf_loop: { columns: [], rows: [{ role: 'user', content: JSON.stringify([{ type: 'text', text: row }]) }] }, adf_logs: { columns: [], rows: [{ origin: 'command', event: 'run', message: `${status} (${duration}ms)`, data: JSON.stringify({ duration_ms: duration, status }) }] } } } }, userDataJson: {}, leases: {}, tree: [] },
  }
}

describe('R24 command duration normalization', () => {
  it('normalizes the transport, durable/display headers, logs and derived estimate across correct runs', () => {
    const first = normalizeRecording(recording(10.3), ctx)
    const second = normalizeRecording(recording(250.67), ctx)
    expect(first).toEqual(second)
    expect(JSON.stringify(first)).toContain('<duration>')
    expect(JSON.stringify(first)).toContain('<command-history-estimate>')
  })
  it('retains outcomes, returned output and actual provider usage', () => {
    expect(normalizeRecording(recording(10, 'error'), ctx)).not.toEqual(normalizeRecording(recording(10), ctx))
    const body = '{"duration_ms":42}'
    expect(normalizeRecording(recording(10, 'ok', body), ctx).llm[0].messages[0].text).toContain(body)
    const changed = recording(10)
    ;(changed.pushes['adf:agent:event'][2] as any).payload.usage.input++
    expect(normalizeRecording(changed, ctx)).not.toEqual(normalizeRecording(recording(10), ctx))
  })
  it('does not normalize estimates with no owner-command history', () => {
    const first = recording(10); first.llm = []
    const second = recording(100); second.llm = []
    expect(normalizeRecording(first, ctx)).not.toEqual(normalizeRecording(second, ctx))
  })
})
