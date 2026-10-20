/**
 * The terminal app reads the same loop as Studio: text the model streamed
 * before an interrupt is kept and labelled, live and after a reload.
 */
import { describe, expect, it } from 'vitest'
import { applyEventToItems, historyToItems } from '../../src/main/tui/state/transcript'
import type { UmbilicalEvent } from '../../src/main/tui/api/types'
import type { TranscriptItem } from '../../src/main/tui/state/types'

const ev = (event_type: string, payload: Record<string, unknown>): UmbilicalEvent =>
  ({ seq: 1, event_type, timestamp: 1, source: 'agent:agent-1', agent_id: '7c1e2d3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f', payload } as UmbilicalEvent)

describe('interrupted output in the terminal app', () => {
  it('a reload shows the partial text marked interrupted', () => {
    const items = historyToItems([
      { seq: 1, role: 'user', content_json: [{ type: 'text', text: 'Write an essay.' }], created_at: 1 },
      { seq: 2, role: 'assistant', content_json: [{ type: 'text', text: 'The essay begins', interrupted: true }], created_at: 2 },
      { seq: 3, role: 'user', content_json: [{ type: 'text', text: '[System] Turn interrupted by user.' }], created_at: 3 },
    ] as never)
    const assistant = items.find(i => i.kind === 'assistant')
    expect(assistant).toMatchObject({ text: 'The essay begins', interrupted: true })
  })

  it('live: the streaming text is marked when the interrupted turn saved it', () => {
    let items: TranscriptItem[] = [{ id: 'a', at: 1, local: true, kind: 'assistant', text: 'The essay begins', streaming: true }]
    items = applyEventToItems(items, ev('turn.completed', { content: [], interrupted: true, partial: true, seq: 2 }))
    expect(items[0]).toMatchObject({ streaming: false, interrupted: true })

    // A normal end, or an interrupt with nothing streamed, marks nothing.
    let plain: TranscriptItem[] = [{ id: 'b', at: 1, local: true, kind: 'assistant', text: 'Done.', streaming: true }]
    plain = applyEventToItems(plain, ev('turn.completed', { content: [] }))
    expect((plain[0] as { interrupted?: boolean }).interrupted).toBeUndefined()
  })
})
