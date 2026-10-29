import { describe, expect, it, vi } from 'vitest'
import { DaemonClient } from '../../src/main/tui/api/client'
import type { LoopEntry } from '../../src/main/tui/api/types'
import { createTuiStore } from '../../src/main/tui/state/store'
import { initialState, tuiReducer } from '../../src/main/tui/state/reducer'
import { transcriptKey, type TuiState } from '../../src/main/tui/state/types'
import { AGENT_1_ID, startMockDaemon } from './fixtures/mock-daemon'

const key = transcriptKey(AGENT_1_ID, 'main')
const row = (seq: number, text = `row ${seq}`, created_at = seq): LoopEntry => ({ seq, role: 'user', content_json: [{ type: 'text', text }], created_at })
const base = () => tuiReducer(initialState('http://test'), { type: 'agents/loaded', agents: [{ id: AGENT_1_ID, filePath: null, name: 'agent', autostart: false }] })
const history = (s: TuiState, entries: LoopEntry[], offset = 0, total = entries.length + offset, mode: 'replace' | 'prepend' = 'replace') => tuiReducer(s, { type: 'transcript/history', key, entries, offset, total, mode })
const event = (s: TuiState, type: string, payload: Record<string, unknown> = {}) => tuiReducer(s, { type: 'event', frame: { cursor: 1, event: { seq: 1, source: 'agent:test', agent_id: AGENT_1_ID, event_type: type, timestamp: 100, payload } } })
const seqs = (s: TuiState) => s.transcripts[key].items.filter(i => !i.local).map(i => i.seq)

async function until(check: () => boolean) {
  await vi.waitFor(() => expect(check()).toBe(true), { timeout: 3000, interval: 10 })
}

describe('transcript history boundaries', () => {
  it('replaces a complete snapshot after compaction and preserves daemon display order on repeated refresh', () => {
    let s = history(base(), [row(1), row(2)])
    const compacted = [row(3, '[Loop Compacted] summary', 50), row(2)]
    for (let i = 0; i < 4; i++) {
      s = history(s, compacted)
      expect(seqs(s)).toEqual([3, 2])
      expect(s.transcripts[key].total).toBe(2)
    }
  })

  it('keeps paginated older rows using their position, including high-seq summaries', () => {
    let s = history(base(), [row(2), row(3)], 1, 3)
    s = history(s, [row(4, '[Loop Compacted] summary')], 0, 3, 'prepend')
    s = history(s, [row(3), row(5)], 2, 4)
    expect(seqs(s)).toEqual([4, 2, 3, 5])
    expect(s.transcripts[key].oldestOffset).toBe(0)
    // A new page beyond the previous snapshot also retains loaded pages.
    s = history(s, [row(6), row(7)], 4, 6)
    expect(seqs(s)).toEqual([4, 2, 3, 5, 6, 7])
  })

  it.each(['loop.cleared', 'loop.compacted'])('%s removes old local rows but retains queued input and new deltas', type => {
    let s = history(base(), [row(1)])
    s = event(s, 'turn.delta', { text: 'deleted live response' })
    s = tuiReducer(s, { type: 'transcript/append', key, item: { id: 'queued', at: 101, local: true, kind: 'user', text: 'next message', origin: 'owner', pending: true } })
    s = event(s, type, { method: 'clear' })
    s = event(s, 'turn.delta', { text: 'new response' })
    s = history(s, [])
    expect(seqs(s)).toEqual([])
    expect(s.transcripts[key].items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'queued', text: 'next message' }),
      expect.objectContaining({ kind: 'assistant', text: 'new response' }),
    ]))
    expect(s.transcripts[key].items.some(i => 'text' in i && i.text.includes('deleted'))).toBe(false)
  })

  it.each(['replace', 'prepend'] as const)('ignores an in-flight %s response from before an external clear', async mode => {
    const mock = await startMockDaemon()
    const client = new DaemonClient({ baseUrl: mock.url })
    const store = createTuiStore({ client, clientSessions: false })
    let finish!: (page: { entries: LoopEntry[]; offset: number; total: number }) => void
    try {
      await store.start()
      store.dispatch({ type: 'transcript/history', key, entries: [row(2)], offset: 1, total: 2, mode: 'replace' })
      const read = vi.spyOn(client, 'loopHistory').mockImplementationOnce(() => new Promise(resolve => { finish = resolve })).mockResolvedValue({ entries: [], offset: 0, total: 0 })
      const pending = mode === 'replace' ? store.actions.loadTranscript(AGENT_1_ID, 'main') : store.actions.loadOlder(AGENT_1_ID, 'main')
      mock.emit({ event_type: 'loop.cleared', agent_id: AGENT_1_ID, payload: { method: 'clear' } })
      mock.emit({ event_type: 'turn.delta', agent_id: AGENT_1_ID, payload: { text: 'new live output' } })
      await until(() => store.getState().transcripts[key].items.some(i => 'text' in i && i.text === 'new live output'))
      finish({ entries: [row(1, 'stale response')], offset: 0, total: 2 })
      await pending
      await until(() => read.mock.calls.length === 2 && !store.getState().transcripts[key].loading)
      const items = store.getState().transcripts[key].items
      expect(items.some(i => 'text' in i && i.text === 'stale response')).toBe(false)
      expect(items).toContainEqual(expect.objectContaining({ text: 'new live output' }))
    } finally {
      store.stop()
      await mock.close()
    }
  })
})
