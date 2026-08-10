/**
 * The opt-in, in-memory umbilical replay window.
 *
 * Fences here:
 *   - opt-in — no config, no buffer (this is the default for every agent);
 *   - nothing is persisted: the ring is process state, not agent state;
 *   - exclusions (built-in + configured) never enter the window;
 *   - oversize payloads are stubbed and flagged, not retained whole;
 *   - the ring stays bounded and evicts oldest-first;
 *   - `getSince` / `range` give a client enough to detect a gap and re-snapshot.
 */

import { afterEach, describe, expect, it } from 'vitest'

import {
  clearAllUmbilicalBuses,
  ensureUmbilicalBus,
  type UmbilicalBus,
  type UmbilicalEvent,
} from '../../../src/main/runtime/umbilical-bus'
import {
  DEFAULT_UMBILICAL_REPLAY_MAX_EVENTS,
  UMBILICAL_REPLAY_PREVIEW_CHARS,
  createUmbilicalReplayBuffer,
  resolveUmbilicalReplaySettings,
  type UmbilicalReplayBuffer,
} from '../../../src/main/runtime/umbilical-replay-buffer'
import type { UmbilicalConfig } from '../../../src/shared/types/adf-v02.types'

const AGENT_ID = 'agent-1'

describe('umbilical replay buffer', () => {
  afterEach(() => {
    clearAllUmbilicalBuses()
  })

  function attachBuffer(umbilical: UmbilicalConfig | undefined): {
    bus: UmbilicalBus
    buffer: UmbilicalReplayBuffer | null
    publish: (event_type: string, payload?: Record<string, unknown>) => UmbilicalEvent
  } {
    const bus = ensureUmbilicalBus(AGENT_ID)
    const buffer = createUmbilicalReplayBuffer({ agentId: AGENT_ID, config: umbilical })
    buffer?.attach(bus)
    return {
      bus,
      buffer,
      publish: (event_type, payload = {}) => bus.publish({
        event_type,
        timestamp: 1_700_000_000_000,
        source: 'system:test',
        agent_id: AGENT_ID,
        payload,
      }),
    }
  }

  it('is off by default — no config means no buffer', () => {
    const { buffer, publish } = attachBuffer(undefined)

    publish('tool.completed', { name: 'fs_read' })

    expect(buffer).toBeNull()
    expect(resolveUmbilicalReplaySettings(undefined)).toBeNull()
    expect(resolveUmbilicalReplaySettings({ stream_deltas: true })).toBeNull()
    expect(resolveUmbilicalReplaySettings({ log: { enabled: false } })).toBeNull()
  })

  it('defaults max_events and ignores a nonsense value', () => {
    expect(resolveUmbilicalReplaySettings({ log: { enabled: true } })).toEqual(
      expect.objectContaining({ maxEvents: DEFAULT_UMBILICAL_REPLAY_MAX_EVENTS }),
    )
    expect(resolveUmbilicalReplaySettings({ log: { enabled: true, max_events: 0 } })).toEqual(
      expect.objectContaining({ maxEvents: DEFAULT_UMBILICAL_REPLAY_MAX_EVENTS }),
    )
    expect(resolveUmbilicalReplaySettings({ log: { enabled: true, max_events: 50 } })).toEqual(
      expect.objectContaining({ maxEvents: 50 }),
    )
  })

  it('records events published on the bus, in order, with the full envelope', () => {
    const { buffer, publish } = attachBuffer({ log: { enabled: true } })

    const first = publish('agent.loaded', { handle: 'agent-1' })
    const second = publish('tool.completed', { name: 'fs_read', ok: true })

    expect(buffer!.getSince(0, 100)).toEqual([
      {
        seq: first.seq,
        event_type: 'agent.loaded',
        timestamp: 1_700_000_000_000,
        source: 'system:test',
        payload: { handle: 'agent-1' },
        truncated: false,
      },
      {
        seq: second.seq,
        event_type: 'tool.completed',
        timestamp: 1_700_000_000_000,
        source: 'system:test',
        payload: { name: 'fs_read', ok: true },
        truncated: false,
      },
    ])
  })

  it('excludes turn.delta and binding.flow_summary always, plus configured types', () => {
    const { buffer, publish } = attachBuffer({
      log: { enabled: true, exclude_types: ['mcp.log'] },
    })

    publish('turn.delta', { text: 'hel' })
    publish('binding.flow_summary', { bytes: 12 })
    publish('mcp.log', { name: 'server' })
    publish('turn.completed', { tokens: 42 })

    expect(buffer!.getSince(0, 100).map(e => e.event_type)).toEqual(['turn.completed'])
  })

  it('truncates oversize payloads into a preview stub and flags the event', () => {
    const { buffer, publish } = attachBuffer({ log: { enabled: true } })

    publish('tool.completed', { name: 'fs_read', content: 'x'.repeat(20_000) })
    publish('tool.completed', { name: 'small' })

    const [truncated, plain] = buffer!.getSince(0, 100)
    expect(truncated.truncated).toBe(true)
    const stub = truncated.payload as { _truncated: boolean; preview: string }
    expect(stub._truncated).toBe(true)
    expect(stub.preview.length).toBe(UMBILICAL_REPLAY_PREVIEW_CHARS)
    expect(stub.preview.startsWith('{"name":"fs_read"')).toBe(true)
    expect(plain.truncated).toBe(false)
  })

  it('caps the ring at max_events, evicting the oldest first', () => {
    const { buffer, publish } = attachBuffer({ log: { enabled: true, max_events: 5 } })

    const seqs: number[] = []
    for (let i = 0; i < 12; i++) seqs.push(publish('tool.completed', { i }).seq)

    const events = buffer!.getSince(0, 100)
    expect(buffer!.size).toBe(5)
    expect(events.map(e => e.seq)).toEqual(seqs.slice(-5))
    expect(events.map(e => (e.payload as { i: number }).i)).toEqual([7, 8, 9, 10, 11])
  })

  it('reports the retained window through range(), tracking eviction', () => {
    const { buffer, publish } = attachBuffer({ log: { enabled: true, max_events: 3 } })

    expect(buffer!.range()).toBeNull()

    const seqs = [0, 1, 2].map(() => publish('tool.completed').seq)
    expect(buffer!.range()).toEqual({ oldest_seq: seqs[0], newest_seq: seqs[2] })

    const fourth = publish('tool.completed').seq
    // The window has slid: a client whose cursor sits below oldest_seq - 1 has
    // fallen off the back and must re-snapshot.
    expect(buffer!.range()).toEqual({ oldest_seq: seqs[1], newest_seq: fourth })
  })

  it('getSince returns only events strictly after the cursor, honouring limit', () => {
    const { buffer, publish } = attachBuffer({ log: { enabled: true } })

    const seqs = [0, 1, 2, 3].map(i => publish('tool.completed', { i }).seq)

    expect(buffer!.getSince(seqs[1], 100).map(e => e.seq)).toEqual([seqs[2], seqs[3]])
    expect(buffer!.getSince(seqs[3], 100)).toEqual([])
    expect(buffer!.getSince(0, 2).map(e => e.seq)).toEqual([seqs[0], seqs[1]])
    expect(buffer!.getSince(0, 0)).toEqual([])
    // A cursor from before the window still yields everything retained.
    expect(buffer!.getSince(0, 100).map(e => e.seq)).toEqual(seqs)
  })

  it('stops recording after detach but keeps the window readable', () => {
    const { buffer, publish } = attachBuffer({ log: { enabled: true } })

    const first = publish('agent.loaded').seq
    buffer!.detach()
    publish('tool.completed', { name: 'fs_read' })

    expect(buffer!.getSince(0, 100).map(e => e.seq)).toEqual([first])
  })

  it('survives an unserializable payload without breaking emission', () => {
    const { buffer, publish } = attachBuffer({ log: { enabled: true } })

    const circular: Record<string, unknown> = { name: 'loop' }
    circular.self = circular

    expect(() => publish('tool.completed', circular)).not.toThrow()
    const [event] = buffer!.getSince(0, 100)
    expect(event.truncated).toBe(true)
    expect(event.payload).toEqual({ _truncated: true, preview: '[unserializable payload]' })
  })
})
