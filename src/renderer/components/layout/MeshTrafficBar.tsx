import { useEffect, useState } from 'react'
import type { MeshEvent } from '../../../shared/types/ipc.types'
import {
  addMeshTrafficPulse,
  getMeshTrafficDirection,
  MESH_TRAFFIC_PULSE_MS,
  type MeshTrafficPulse,
} from '../../utils/mesh-traffic'

/** A bounded set of overlapping ripples. CSS animates only transform and opacity. */
export function MeshTrafficBar() {
  const [pulses, setPulses] = useState<MeshTrafficPulse[]>([])

  useEffect(() => window.adfApi?.onMeshEvent((event: MeshEvent) => {
    const direction = getMeshTrafficDirection(event)
    if (direction) {
      const now = performance.now()
      setPulses((previous) => addMeshTrafficPulse(previous, now, direction))
    }
  }), [])

  return (
    <div className="mesh-traffic-bar" aria-hidden="true">
      {pulses.map((pulse) => (
        <span
          key={`${pulse.direction}:${pulse.startedAt}`}
          className="mesh-traffic-pulse"
          data-direction={pulse.direction}
          style={{ animationDuration: `${MESH_TRAFFIC_PULSE_MS}ms` }}
          onAnimationEnd={(event) => {
            // Child crests finish separately; retain the disturbance until its
            // own slow fade ends, without timers or per-frame React updates.
            if (event.target === event.currentTarget) {
              setPulses((previous) => previous.filter((item) => item !== pulse))
            }
          }}
        >
          <span className="mesh-traffic-wave" />
          <span className="mesh-traffic-wave" />
          <span className="mesh-traffic-wave" />
        </span>
      ))}
    </div>
  )
}
