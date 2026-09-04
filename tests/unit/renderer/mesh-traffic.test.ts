import { describe, expect, it } from 'vitest'
import { addMeshTrafficPulse, isInterAgentTraffic, MESH_TRAFFIC_PULSE_MS } from '../../../src/renderer/utils/mesh-traffic'
import type { MeshEvent } from '../../../src/shared/types/ipc.types'

function route(from: string, to: unknown): MeshEvent {
  return { type: 'message_routed', payload: { filePath: from, toFilePaths: to }, timestamp: 1 }
}

describe('mesh traffic pulses', () => {
  it.each([
    ['/agents/artemis.adf', ['/agents/gardener.adf']],
    ['/agents/artemis.adf', ['station:peer:other-runtime']],
    ['station:peer:other-runtime', ['/agents/artemis.adf']],
  ])('pulses for interagent delivery from %s', (from, to) => {
    expect(isInterAgentTraffic(route(from, to))).toBe(true)
  })

  it.each([
    ['/agents/artemis.adf', ['/agents/artemis.adf']],
    ['/agents/artemis.adf', ['station:slack']],
    ['station:telegram', ['/agents/artemis.adf']],
    ['station:peer:one', ['station:peer:two']],
    ['', ['/agents/artemis.adf']],
    ['/agents/artemis.adf', []],
    ['/agents/artemis.adf', [null, '', 42]],
    ['/agents/artemis.adf', undefined],
  ])('ignores self, adapter, and incomplete routes from %s to %j', (from, to) => {
    expect(isInterAgentTraffic(route(from, to))).toBe(false)
  })

  it('ignores lifecycle events and internal loop messages', () => {
    for (const type of ['agent_joined', 'agent_left', 'agent_state_changed'] as const) {
      expect(isInterAgentTraffic({ type, payload: { filePath: '/agents/artemis.adf' }, timestamp: 1 })).toBe(false)
    }
    // Inner-loop delivery uses agent events, never a routed mesh message.
    expect(isInterAgentTraffic({ type: 'loop_message', payload: {}, timestamp: 1 } as unknown as MeshEvent)).toBe(false)
  })

  it('merges bursts without restarting the pulse already in progress', () => {
    const pulses = addMeshTrafficPulse([], 1000)
    expect(addMeshTrafficPulse(pulses, 1050)).toBe(pulses)
    expect(addMeshTrafficPulse(pulses, 1120)).toEqual([{ startedAt: 1000 }, { startedAt: 1120 }])
  })

  it('bounds simultaneous pulses and drops expired ones', () => {
    let pulses = addMeshTrafficPulse([], 1000)
    for (let now = 1200; now <= 2000; now += 200) pulses = addMeshTrafficPulse(pulses, now)
    expect(pulses).toHaveLength(4)
    expect(addMeshTrafficPulse(pulses, 2000 + MESH_TRAFFIC_PULSE_MS)).toEqual([{ startedAt: 2000 + MESH_TRAFFIC_PULSE_MS }])
  })
})
