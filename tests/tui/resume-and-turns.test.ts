// SSE resume verdicts (stream.hello / stream.gap) and chat turn correlation
// (turnId -> event.turn_id) as the terminal app uses them.
import { afterEach, describe, expect, it } from 'vitest'
import { DaemonClient } from '../../src/main/tui/api/client'
import { EventStream, type ResumeInfo } from '../../src/main/tui/api/sse'
import type { DaemonEventFrame, UmbilicalEvent } from '../../src/main/tui/api/types'
import { markOwnTurns, applyEventToItems } from '../../src/main/tui/state/transcript'
import type { TranscriptItem, UserItem } from '../../src/main/tui/state/types'
import { queuedItems } from '../../src/main/tui/views/chat/model'
import { AGENT_1_ID, startMockDaemon, type MockDaemon } from './fixtures/mock-daemon'

let mock: MockDaemon | null = null
afterEach(async () => { await mock?.close(); mock = null })

async function until<T>(check: () => T | undefined | false, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = check()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('condition not met in time')
}

function stream(m: MockDaemon, frames: DaemonEventFrame[], resumes: ResumeInfo[]): EventStream {
  return new EventStream({ baseUrl: m.url, minBackoffMs: 10, maxBackoffMs: 20, onEvent: f => frames.push(f), onResume: r => resumes.push(r) }).start()
}

describe('EventStream resume verdicts', () => {
  it('an exact resume reports exact and sends the epoch back', async () => {
    mock = await startMockDaemon({ stepMs: 5 })
    const frames: DaemonEventFrame[] = []
    const resumes: ResumeInfo[] = []
    const s = stream(mock, frames, resumes)
    try {
      await until(() => s.connection.state === 'open')
      mock.emit({ event_type: 'agent.state.changed', agent_id: AGENT_1_ID, payload: { state: 'thinking' } })
      await until(() => frames.length === 1)
      mock.dropEventStreams()
      mock.emit({ event_type: 'agent.state.changed', agent_id: AGENT_1_ID, payload: { state: 'idle' } })
      await until(() => resumes.length === 1)
      expect(resumes[0]).toEqual({ exact: true, epoch: mock.epoch })
      await until(() => frames.length === 2)
      expect(mock.requests.filter(r => r.startsWith('GET /events')).at(-1)).toMatch(/since=1&epoch=mock-epoch-1/)
    } finally {
      s.close()
    }
  })

  it('frames evicted while away report a gap (evicted)', async () => {
    mock = await startMockDaemon({ stepMs: 5, bufferSize: 2 })
    const frames: DaemonEventFrame[] = []
    const resumes: ResumeInfo[] = []
    const s = stream(mock, frames, resumes)
    try {
      await until(() => s.connection.state === 'open')
      mock.emit({ event_type: 'agent.state.changed', agent_id: AGENT_1_ID, payload: { state: 'thinking' } })
      await until(() => frames.length === 1)
      mock.dropEventStreams()
      for (let i = 0; i < 5; i++) mock.emit({ event_type: 'agent.state.changed', agent_id: AGENT_1_ID, payload: { state: i % 2 ? 'idle' : 'thinking' } })
      await until(() => resumes.length === 1)
      expect(resumes).toEqual([{ exact: false, reason: 'evicted', epoch: mock.epoch }])
    } finally {
      s.close()
    }
  })

  it('a daemon restart reports epoch_changed and replays the new run from the start', async () => {
    mock = await startMockDaemon({ stepMs: 5 })
    const frames: DaemonEventFrame[] = []
    const resumes: ResumeInfo[] = []
    const s = stream(mock, frames, resumes)
    try {
      await until(() => s.connection.state === 'open')
      mock.emit({ event_type: 'agent.state.changed', agent_id: AGENT_1_ID, payload: { state: 'thinking' } })
      mock.emit({ event_type: 'agent.state.changed', agent_id: AGENT_1_ID, payload: { state: 'idle' } })
      await until(() => frames.length === 2)
      mock.restart()
      mock.emit({ event_type: 'agent.loaded', agent_id: 'agent-9' })
      await until(() => resumes.length === 1)
      expect(resumes[0]).toEqual({ exact: false, reason: 'epoch_changed', epoch: 'mock-epoch-2' })
      await until(() => frames.some(f => f.event.event_type === 'agent.loaded'))
      expect(s.cursor).toBe(1)
    } finally {
      s.close()
    }
  })
})

describe('chat turn correlation', () => {
  const ev = (event_type: string, extra: Partial<UmbilicalEvent> = {}, payload: Record<string, unknown> = {}): UmbilicalEvent =>
    ({ seq: 1, event_type, timestamp: 1, source: 'agent:x', agent_id: AGENT_1_ID, payload, ...extra })
  const user = (id: string, turnId?: string): UserItem =>
    ({ id, at: 10, local: true, kind: 'user', text: id, origin: 'owner', pending: true, accepted: true, ...(turnId ? { turnId } : {}) })

  it('marks the own message taken, then answered, by turn_id', () => {
    let items: TranscriptItem[] = [user('a', 'turn_a'), user('b', 'turn_b')]
    expect(queuedItems(items, true, 0).map(i => i.id)).toEqual(['a', 'b'])
    items = markOwnTurns(items, ev('agent.state.changed', { turn_id: 'turn_a' }, { state: 'thinking' }))
    expect(queuedItems(items, true, 0).map(i => i.id)).toEqual(['b'])
    const same = markOwnTurns(items, ev('turn.delta', { turn_id: 'turn_a' }))
    expect(same).toBe(items)
    items = applyEventToItems(items, ev('turn.completed', { turn_id: 'turn_a' }, { content: 'done' }))
    expect(items.find(i => i.id === 'a')).toMatchObject({ answered: true, pending: false })
    expect(items.find(i => i.id === 'b')).toMatchObject({ pending: true })
    expect((items.find(i => i.id === 'b') as UserItem).answered).toBeUndefined()
  })

  it('an interrupted turn does not answer; absorbed ids do; an error ends the wait', () => {
    let items: TranscriptItem[] = [user('a', 'turn_a'), user('b', 'turn_b'), user('c', 'turn_c')]
    items = markOwnTurns(items, ev('turn.completed', { turn_id: 'turn_a' }, { interrupted: true }))
    expect((items[0] as UserItem).answered).toBeUndefined()
    items = markOwnTurns(items, ev('turn.completed', { turn_id: 'turn_x' }, { absorbed_turn_ids: ['turn_b'] }))
    expect(items[1]).toMatchObject({ answered: true, pending: false })
    items = markOwnTurns(items, ev('agent.error', { turn_id: 'turn_c' }))
    expect(items[2]).toMatchObject({ pending: false, taken: true })
    expect((items[2] as UserItem).answered).toBeUndefined()
  })

  it('several queued messages all leave [queued]: replay turn_id, chat.delivered, then absorbed ids', () => {
    // A burst of four while turn_a runs: a interrupts, b replays, c and d ride b.
    let items: TranscriptItem[] = [user('a', 'turn_a'), user('b', 'turn_b'), user('c', 'turn_c'), user('d', 'turn_d')]
    items = applyEventToItems(items, ev('agent.state.changed', { turn_id: 'turn_a' }, { state: 'thinking' }))
    expect(queuedItems(items, true, 0).map(i => i.id)).toEqual(['b', 'c', 'd'])
    items = applyEventToItems(items, ev('turn.completed', { turn_id: 'turn_a' }, { interrupted: true }))
    items = applyEventToItems(items, ev('agent.state.changed', { turn_id: 'turn_b' }, { state: 'thinking' }))
    expect(queuedItems(items, true, 0).map(i => i.id)).toEqual(['c', 'd'])
    items = applyEventToItems(items, ev('chat.delivered', { turn_id: 'turn_b' }, { delivery: 'turn_start', count: 2, turn_ids: ['turn_c', 'turn_d'] }))
    expect(queuedItems(items, true, 0)).toEqual([])
    expect(items.some(i => i.kind === 'notice')).toBe(false)
    items = applyEventToItems(items, ev('turn.completed', { turn_id: 'turn_b' }, { content: 'all four', absorbed_turn_ids: ['turn_a', 'turn_c', 'turn_d'] }))
    for (const id of ['a', 'b', 'c', 'd']) expect(items.find(i => i.id === id)).toMatchObject({ answered: true, pending: false })
  })

  it('a stop ends the wait of every queued message and says so', () => {
    let items: TranscriptItem[] = [user('a', 'turn_a'), user('b', 'turn_b'), user('c', 'turn_c')]
    items = applyEventToItems(items, ev('agent.state.changed', { turn_id: 'turn_a' }, { state: 'thinking' }))
    items = applyEventToItems(items, ev('chat.discarded', {}, { reason: 'stopped', count: 2, turn_ids: ['turn_b', 'turn_c'], unanswered_turn_ids: ['turn_a'] }))
    expect(queuedItems(items, true, 0)).toEqual([])
    expect(items.find(i => i.id === 'a')).toMatchObject({ taken: true, pending: false })
    expect((items.find(i => i.id === 'a') as UserItem).discarded).toBeUndefined()
    for (const id of ['b', 'c']) expect(items.find(i => i.id === id)).toMatchObject({ discarded: true, pending: false })
    expect(items.find(i => i.kind === 'notice')).toMatchObject({ level: 'warn', text: '2 queued messages discarded undelivered (agent stopped)' })
  })

  it('messages without a turnId (older daemon) keep the time-based queue rule', () => {
    const items: TranscriptItem[] = [user('old')]
    expect(queuedItems(items, true, 5).map(i => i.id)).toEqual(['old'])
    expect(queuedItems(items, true, 20)).toEqual([])
    expect(markOwnTurns(items, ev('turn.completed', { turn_id: 'turn_a' }))).toBe(items)
  })

  it('end to end: the chat 202 turnId comes back on the turn events of the mock daemon', async () => {
    mock = await startMockDaemon({ stepMs: 5 })
    const client = new DaemonClient({ baseUrl: mock.url })
    const frames: DaemonEventFrame[] = []
    const s = client.events({ onEvent: f => frames.push(f) }).start()
    try {
      await until(() => s.connection.state === 'open')
      const { turnId } = await client.chat(AGENT_1_ID, 'hello')
      await until(() => frames.some(f => f.event.event_type === 'turn.completed'))
      expect(frames.filter(f => f.event.agent_id === AGENT_1_ID).every(f => f.event.turn_id === turnId)).toBe(true)
    } finally {
      s.close()
    }
  })
})
