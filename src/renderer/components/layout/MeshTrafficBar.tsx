import { useEffect, useState, type CSSProperties } from 'react'
import type { MeshEvent } from '../../../shared/types/ipc.types'
import {
  addMeshTrafficPulse,
  getMeshTrafficDirection,
  MESH_TRAFFIC_PULSE_MS,
  type MeshTrafficPulse,
} from '../../utils/mesh-traffic'

function TrafficRipple({ pulse, onComplete }: { pulse: MeshTrafficPulse; onComplete: () => void }) {
  // Sample once per disturbance, so incoming traffic and unrelated renders
  // never change the shape or pace of ripples that are already on the water.
  const [waves] = useState(() => Array.from({ length: 3 }, (_, index) => ({
    '--mesh-wave-travel': `${5.2 + Math.random() * 3.6}s`,
    '--mesh-wave-delay': `${index === 0 ? 0 : index * (0.25 + Math.random() * 0.8)}s`,
    '--mesh-wave-width': 0.65 + Math.random() * 0.65,
    '--mesh-wave-swell': 0.85 + Math.random() * 0.65,
    '--mesh-wave-light': 0.55 + Math.random() * 0.4,
    '--mesh-wave-shimmer': `${2.1 + Math.random() * 3.2}s`,
    '--mesh-wave-phase': `${-Math.random() * 5}s`,
    '--mesh-wave-drift': `${3.7 + Math.random() * 3.8}s`,
  }) as CSSProperties))

  return (
    <span
      className="mesh-traffic-pulse"
      data-direction={pulse.direction}
      style={{ '--mesh-traffic-duration': `${MESH_TRAFFIC_PULSE_MS}ms` } as CSSProperties}
      onAnimationEnd={(event) => {
        // Crests cycle independently; retain the disturbance until its
        // own 30-second fade ends, without timers or per-frame React updates.
        if (event.target === event.currentTarget) onComplete()
      }}
    >
      {waves.map((style, index) => <span key={index} className="mesh-traffic-wave" style={style} />)}
    </span>
  )
}

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
        <TrafficRipple
          key={`${pulse.direction}:${pulse.startedAt}`}
          pulse={pulse}
          onComplete={() => {
            setPulses((previous) => previous.filter((item) => item !== pulse))
          }}
        />
      ))}
    </div>
  )
}
