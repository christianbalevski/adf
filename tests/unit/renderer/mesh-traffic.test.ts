import { describe, expect, it } from 'vitest'
import { addMeshTrafficPulse, getMeshTrafficDirection, MESH_TRAFFIC_PULSE_MS } from '../../../src/renderer/utils/mesh-traffic'
import type { MeshEvent } from '../../../src/shared/types/ipc.types'

function route(from: string, to: unknown): MeshEvent {
  return { type: 'message_routed', payload: { filePath: from, toFilePaths: to }, timestamp: 1 }
}

describe('mesh traffic pulses', () => {
  it.each([
    ['/agents/artemis.adf', ['/agents/gardener.adf'], 'send'],
    ['/agents/artemis.adf', ['station:peer:other-runtime'], 'send'],
    ['station:peer:other-runtime', ['/agents/artemis.adf'], 'receive'],
  ])('classifies interagent delivery from %s', (from, to, direction) => {
    expect(getMeshTrafficDirection(route(from, to))).toBe(direction)
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
    expect(getMeshTrafficDirection(route(from, to))).toBeNull()
  })

  it('ignores lifecycle events and internal loop messages', () => {
    for (const type of ['agent_joined', 'agent_left', 'agent_state_changed'] as const) {
      expect(getMeshTrafficDirection({ type, payload: { filePath: '/agents/artemis.adf' }, timestamp: 1 })).toBeNull()
    }
    // Inner-loop delivery uses agent events, never a routed mesh message.
    expect(getMeshTrafficDirection({ type: 'loop_message', payload: {}, timestamp: 1 } as unknown as MeshEvent)).toBeNull()
  })

  it('merges bursts without restarting ripples already diffusing', () => {
    const pulses = addMeshTrafficPulse([], 1000, 'send')
    expect(addMeshTrafficPulse(pulses, 1100, 'send')).toBe(pulses)
    expect(addMeshTrafficPulse(pulses, 1250, 'send')).toEqual([
      { startedAt: 1000, direction: 'send' },
      { startedAt: 1250, direction: 'send' },
    ])
  })

  it('preserves opposite-direction traffic in the same frame', () => {
    const sent = addMeshTrafficPulse([], 1000, 'send')
    const both = addMeshTrafficPulse(sent, 1000, 'receive')
    expect(both).toEqual([
      { startedAt: 1000, direction: 'send' },
      { startedAt: 1000, direction: 'receive' },
    ])
    expect(addMeshTrafficPulse(both, 1100, 'send')).toBe(both)
    expect(addMeshTrafficPulse(both, 1100, 'receive')).toBe(both)
  })

  it('lets activity build over several seconds before diffusing away', () => {
    const first = addMeshTrafficPulse([], 1000, 'send')
    const later = addMeshTrafficPulse(first, 21_000, 'receive')
    expect(later).toHaveLength(2)
    expect(later[0]).toBe(first[0])
    expect(addMeshTrafficPulse(later, 1000 + MESH_TRAFFIC_PULSE_MS, 'send')).toEqual([
      { startedAt: 21_000, direction: 'receive' },
      { startedAt: 1000 + MESH_TRAFFIC_PULSE_MS, direction: 'send' },
    ])
  })

  it('bounds simultaneous ripples and drops expired ones', () => {
    let pulses = addMeshTrafficPulse([], 1000, 'send')
    for (let now = 1250; now <= 5000; now += 250) pulses = addMeshTrafficPulse(pulses, now, 'send')
    expect(pulses).toHaveLength(10)
    expect(addMeshTrafficPulse(pulses, 5000 + MESH_TRAFFIC_PULSE_MS, 'receive')).toEqual([
      { startedAt: 5000 + MESH_TRAFFIC_PULSE_MS, direction: 'receive' },
    ])
  })
})
