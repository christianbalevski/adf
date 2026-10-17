/**
 * The pure background event mapping (W1-F). The byte-for-byte behaviour is
 * pinned against the manager by background-event-mapping.characterization.test.ts;
 * this suite covers what daemon mode (W2-C) relies on: purity, JSON round trips
 * of executor events arriving over SSE, and step ordering.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  applyBackgroundEvent,
  mapBackgroundEvent,
  type BackgroundMappedEvent,
  type BackgroundMappingState,
  type BackgroundSourceEvent,
} from '../../../src/main/runtime/background-event-mapping'
import { RECORDED_EVENTS } from './background-event-mapping.fixture'

const FILE_PATH = '/agents/agent-1.adf'
const NOW = 1_700_000_000_000
const now = (): number => NOW

function freshState(): BackgroundMappingState {
  return { state: 'idle', loopStates: new Map(), activeLoops: 0, accumulatedText: '' }
}

const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** Map a whole sequence, returning every step. */
function mapAll(events: BackgroundSourceEvent[]): { steps: unknown[]; emitted: BackgroundMappedEvent[]; final: BackgroundMappingState } {
  const state = freshState()
  const steps: unknown[] = []
  const emitted: BackgroundMappedEvent[] = []
  for (const event of events) {
    for (const step of mapBackgroundEvent(FILE_PATH, event, state, now)) {
      steps.push({ ...step, patch: { ...step.patch, ...(step.patch.loopStates ? { loopStates: [...step.patch.loopStates] } : {}) } })
      Object.assign(state, step.patch)
      if (step.event) emitted.push(step.event)
    }
  }
  return { steps, emitted, final: state }
}

describe('background event mapping: purity', () => {
  it('imports nothing but types, the display-state map and the main-loop name', () => {
    const source = readFileSync(join(__dirname, '../../../src/main/runtime/background-event-mapping.ts'), 'utf-8')
    const specifiers = [...source.matchAll(/^import\s.*?from\s+'([^']+)'/gm)].map(m => m[1])
    expect(specifiers.sort()).toEqual(['../../shared/types/ipc.types', '../adf/derive-loop-config', './display-state'])
    expect(source).not.toMatch(/\brequire\(/)
  })

  it('does not mutate the state it is given', () => {
    const current: BackgroundMappingState = {
      state: 'active',
      loopStates: new Map([['loop-a', 'active' as const]]),
      activeLoops: 1,
      accumulatedText: 'abc',
    }
    const loopStates = current.loopStates
    const steps = [
      ...mapBackgroundEvent(FILE_PATH, { type: 'state_changed', payload: { state: 'idle' }, timestamp: 1, loop: 'loop-b' }, current, now),
      ...mapBackgroundEvent(FILE_PATH, { type: 'state_changed', payload: { state: 'stopped' }, timestamp: 2 }, current, now),
      ...mapBackgroundEvent(FILE_PATH, { type: 'text_delta', payload: { delta: 'd' }, timestamp: 3 }, current, now),
    ]
    expect(steps.length).toBeGreaterThan(0)
    expect(current.loopStates).toBe(loopStates)
    expect([...current.loopStates]).toEqual([['loop-a', 'active']])
    expect(current).toMatchObject({ state: 'active', activeLoops: 1, accumulatedText: 'abc' })
  })
})

describe('background event mapping: JSON round trip', () => {
  it('maps every recorded event identically after JSON.parse(JSON.stringify(event))', () => {
    const direct = mapAll(RECORDED_EVENTS)
    const wired = mapAll(RECORDED_EVENTS.map(roundTrip))
    expect(wired.steps).toStrictEqual(direct.steps)
    expect(wired.final).toStrictEqual(direct.final)
    expect(direct.emitted.length).toBeGreaterThan(40)
  })

  it('commutes with JSON for payloads JSON cannot represent: only the payload values JSON changes differ', () => {
    class ToolOutput { constructor(public text: string) {} }
    const at = new Date('2026-10-14T00:00:00.000Z')
    const payload = {
      name: 'fs_read',
      id: undefined,
      input: { path: 'a.md', encoding: undefined },
      result: { content: new ToolOutput('t'), isError: false },
      at,
      tags: new Map([['k', 'v']]),
      seen: new Set(['x']),
      score: Number.NaN,
      limit: Number.POSITIVE_INFINITY,
      bytes: Buffer.from('hi'),
    }
    const event: BackgroundSourceEvent = { type: 'tool_call_result', payload, timestamp: 5, loop: undefined }
    const [direct] = mapAll([event]).emitted
    const [wired] = mapAll([roundTrip(event)]).emitted

    // The mapping commutes with a JSON round trip...
    expect(wired).toStrictEqual(roundTrip(direct))
    // ...and these are exactly the differences W2-B's wire format carries:
    expect('id' in direct.payload).toBe(true)
    expect('id' in wired.payload).toBe(false) // undefined keys are dropped
    expect('encoding' in (wired.payload.input as object)).toBe(false) // at any depth
    expect(direct.payload.at).toBe(at)
    expect(wired.payload.at).toBe('2026-10-14T00:00:00.000Z') // Date → ISO string
    expect(wired.payload.tags).toEqual({}) // Map → {}
    expect(wired.payload.seen).toEqual({}) // Set → {}
    expect(Object.getPrototypeOf((wired.payload.result as { content: object }).content)).toBe(Object.prototype) // class → plain
    expect(wired.payload.score).toBeNull() // NaN → null
    expect(wired.payload.limit).toBeNull() // Infinity → null
    expect(wired.payload.bytes).toEqual({ type: 'Buffer', data: [104, 105] }) // Buffer → toJSON shape
    // Fields the mapping itself reads are unaffected.
    expect(wired.type).toBe(direct.type)
    expect(wired.timestamp).toBe(direct.timestamp)
    expect(wired.payload.filePath).toBe(FILE_PATH)
  })

  it('treats a dropped `loop: undefined` and an explicit `loop: "main"` as the host loop', () => {
    const base = { type: 'state_changed', payload: { state: 'thinking' }, timestamp: 1 }
    const a = mapAll([{ ...base, loop: undefined }]).emitted
    const b = mapAll([roundTrip({ ...base, loop: undefined })]).emitted
    const c = mapAll([{ ...base, loop: 'main' }]).emitted
    expect(b).toStrictEqual(a)
    expect(c).toStrictEqual(a)
    expect(a).toEqual([{ type: 'agent_state_changed', payload: { filePath: FILE_PATH, state: 'active' }, timestamp: NOW }])
  })
})

describe('background event mapping: step order', () => {
  it('a listener sees the loop count cleared before main goes off, and `now` is read per step', () => {
    const target: BackgroundMappingState = {
      state: 'idle',
      loopStates: new Map([['loop-a', 'active' as const]]),
      activeLoops: 1,
      accumulatedText: '',
    }
    let clock = 10
    const seen: Array<{ type: string; timestamp: number; state: string; activeLoops: number; loops: number }> = []
    applyBackgroundEvent(target, FILE_PATH, { type: 'state_changed', payload: { state: 'stopped' }, timestamp: 1 }, (event) => {
      seen.push({ type: event.type, timestamp: event.timestamp, state: target.state, activeLoops: target.activeLoops, loops: target.loopStates.size })
      clock += 5 // a listener that takes time
    }, () => clock)
    expect(seen).toEqual([
      { type: 'agent_loops_changed', timestamp: 10, state: 'idle', activeLoops: 0, loops: 0 },
      { type: 'agent_state_changed', timestamp: 15, state: 'off', activeLoops: 0, loops: 0 },
    ])
  })

  it('clears accumulated text before tool_call_start is emitted and after turn_complete is emitted', () => {
    const target = { ...freshState(), accumulatedText: 'abc' }
    const textAtEmit: string[] = []
    const emit = (): void => { textAtEmit.push(target.accumulatedText) }
    applyBackgroundEvent(target, FILE_PATH, { type: 'tool_call_start', payload: { name: 'x' }, timestamp: 1 }, emit, now)
    target.accumulatedText = 'def'
    applyBackgroundEvent(target, FILE_PATH, { type: 'turn_complete', payload: { content: [] }, timestamp: 2 }, emit, now)
    expect(textAtEmit).toEqual(['', 'def'])
    expect(target.accumulatedText).toBe('')
  })
})
