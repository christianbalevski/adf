import { useEffect, useState } from 'react'
import type { MeshEvent } from '../../../shared/types/ipc.types'
import {
  addMeshTrafficPulse,
  isInterAgentTraffic,
  MESH_TRAFFIC_PULSE_MS,
  type MeshTrafficPulse,
} from '../../utils/mesh-traffic'

/** Mounted while mesh is enabled. Idle is a quiet line; deliveries create pulses. */
export function MeshTrafficBar() {
  const [pulses, setPulses] = useState<MeshTrafficPulse[]>([])

  useEffect(() => window.adfApi?.onMeshEvent((event: MeshEvent) => {
    if (isInterAgentTraffic(event)) {
      const now = Date.now()
      setPulses((previous) => addMeshTrafficPulse(previous, now))
    }
  }), [])

  return (
    <div className="mesh-traffic-bar" aria-hidden="true">
      {pulses.map(({ startedAt }) => (
        <span
          key={startedAt}
          className="mesh-traffic-pulse"
          style={{ animationDuration: `${MESH_TRAFFIC_PULSE_MS}ms` }}
          onAnimationEnd={() => setPulses((previous) => previous.filter((pulse) => pulse.startedAt !== startedAt))}
        />
      ))}
    </div>
  )
}
