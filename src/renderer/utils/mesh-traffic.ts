import type { MeshEvent } from '../../shared/types/ipc.types'

export const MESH_TRAFFIC_PULSE_MS = 1400
const BURST_WINDOW_MS = 120
const MAX_PULSES = 4

export interface MeshTrafficPulse {
  startedAt: number
}

/** Only agent-to-agent routes: local deliveries and traffic to/from peer runtimes. */
export function isInterAgentTraffic(event: MeshEvent): boolean {
  if (event.type !== 'message_routed') return false
  const from = event.payload.filePath
  const targets = event.payload.toFilePaths
  if (typeof from !== 'string' || !from || !Array.isArray(targets)) return false

  const isAgent = (id: string) => !id.startsWith('station:')
  const isPeer = (id: string) => id.startsWith('station:peer:')
  return targets.some((to: unknown) => {
    if (typeof to !== 'string' || !to || to === from) return false
    return (isAgent(from) && (isAgent(to) || isPeer(to)))
      || (isPeer(from) && isAgent(to))
  })
}

/** Merge bursts and bound the animation work even on a very busy mesh. */
export function addMeshTrafficPulse(pulses: MeshTrafficPulse[], now: number): MeshTrafficPulse[] {
  const last = pulses.at(-1)
  if (last && now - last.startedAt < BURST_WINDOW_MS) return pulses
  return [
    ...pulses.filter((pulse) => now - pulse.startedAt < MESH_TRAFFIC_PULSE_MS).slice(-(MAX_PULSES - 1)),
    { startedAt: now },
  ]
}
