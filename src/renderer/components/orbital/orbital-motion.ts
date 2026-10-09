/**
 * How a live orbital moves for each agent state. Motion explains state
 * (BRAND.md section 8): a resting agent is still, a thinking one turns
 * slowly with its phase cycling, one running tools cycles its phase faster.
 */

import type { AgentState } from '../../../shared/types/ipc.types'

/** States LiveOrbital distinguishes; 'active' splits on what the turn is doing. */
export type OrbitalMotionState =
  | 'off'
  | 'suspended'
  | 'hibernate'
  | 'idle'
  | 'thinking'
  | 'tool'
  | 'error'

export interface OrbitalMotion {
  /** Spin rate about the orbital's axis, rad/s. 0 = still. */
  spin: number
  /** Multiplier on the spec's own phase speed. 0 = phase frozen at t = 0. */
  phase: number
  /** Overall opacity 0..1. */
  alpha: number
}

const STILL: OrbitalMotion = { spin: 0, phase: 0, alpha: 1 }

export function orbitalMotion(state: OrbitalMotionState): OrbitalMotion {
  switch (state) {
    case 'off':
    case 'suspended':
      return { ...STILL, alpha: 0.5 }
    case 'hibernate':
      return { ...STILL, alpha: 0.7 }
    case 'thinking':
      return { spin: 0.4, phase: 1, alpha: 1 }
    case 'tool':
      return { spin: 0.4, phase: 4, alpha: 1 }
    case 'idle':
    case 'error':
    default:
      return STILL
  }
}

/** Collapse an agent's display state (plus whether a tool is running) to a motion state. */
export function orbitalMotionStateFor(state: AgentState | null | undefined, toolRunning = false): OrbitalMotionState {
  switch (state) {
    case 'active':
      return toolRunning ? 'tool' : 'thinking'
    case 'idle':
    case 'hibernate':
    case 'suspended':
    case 'error':
    case 'off':
      return state
    default:
      return 'off'
  }
}

export function isOrbitalMoving(m: OrbitalMotion): boolean {
  return m.spin !== 0 || m.phase !== 0
}
