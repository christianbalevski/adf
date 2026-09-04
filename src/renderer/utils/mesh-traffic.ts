import type { MeshEvent } from '../../shared/types/ipc.types'

export const MESH_TRAFFIC_PULSE_MS = 30_000
const BURST_WINDOW_MS = 250
const MAX_PULSES = 10

export type MeshTrafficDirection = 'send' | 'receive'

export interface MeshTrafficPulse {
  startedAt: number
  direction: MeshTrafficDirection
}

/** Direction is relative to this runtime; same-runtime deliveries count once as sends. */
export function getMeshTrafficDirection(event: MeshEvent): MeshTrafficDirection | null {
  if (event.type !== 'message_routed') return null
  const from = event.payload.filePath
  const targets = event.payload.toFilePaths
  if (typeof from !== 'string' || !from || !Array.isArray(targets)) return null

  const isAgent = (id: string) => !id.startsWith('station:')
  const isPeer = (id: string) => id.startsWith('station:peer:')
  const interAgent = targets.some((to: unknown) => {
    if (typeof to !== 'string' || !to || to === from) return false
    return (isAgent(from) && (isAgent(to) || isPeer(to)))
      || (isPeer(from) && isAgent(to))
  })
  return interAgent ? (isPeer(from) ? 'receive' : 'send') : null
}

/** Merge bursts and bound the animation work even on a very busy mesh. */
export function addMeshTrafficPulse(
  pulses: MeshTrafficPulse[],
  now: number,
  direction: MeshTrafficDirection,
): MeshTrafficPulse[] {
  // Opposite directions can overlap, including sends and receives in one frame.
  const last = [...pulses].reverse().find((pulse) => pulse.direction === direction)
  if (last && now - last.startedAt < BURST_WINDOW_MS) return pulses
  return [
    ...pulses.filter((pulse) => now - pulse.startedAt < MESH_TRAFFIC_PULSE_MS).slice(-(MAX_PULSES - 1)),
    { startedAt: now, direction },
  ]
}
