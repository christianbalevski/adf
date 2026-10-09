/**
 * How a live orbital moves for each agent state. Motion explains state
 * (BRAND.md section 8): a resting agent is still, a thinking one turns
 * slowly with its phase cycling, one running tools cycles its phase faster.
 */

import type { AgentState } from '../../../shared/types/ipc.types'
import { CALM_MOOD, type CreatureMood, type CreatureOptions } from './orbital-creature'

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

const MOODS = {
  idle: CALM_MOOD,
  thinking: { ...CALM_MOOD, turn: 2.5, phase: 2, beats: false, awake: true, active: true },
  tool: { ...CALM_MOOD, turn: 3, phase: 4, beats: false, awake: true, spins: true, active: true },
  waiting: { ...CALM_MOOD, phase: 1.2, beats: false, awake: true, attentive: true },
  error: { ...CALM_MOOD, turn: 0.3, phase: 0.3, alpha: 0.8, beats: false },
  off: { ...CALM_MOOD, beats: false, sleep: 1 },
  hibernate: { ...CALM_MOOD, beats: false, sleep: 2 }
} satisfies Record<string, CreatureMood>

/**
 * How an alive orbital acts out an agent's state, on top of its own life
 * (OrbitalCreature.setMood): thinking turns and cycles faster, a tool faster
 * still with an occasional spin, waiting on the user (approval, ask) perks up
 * and looks at them, an error goes still-ish and a little dim, stopped dozes,
 * hibernating dozes deeper. Returns shared constants: compare by identity.
 */
export function creatureMoodFor(state: OrbitalMotionState, waiting = false): CreatureMood {
  if (waiting && state !== 'off' && state !== 'suspended' && state !== 'hibernate') return MOODS.waiting
  switch (state) {
    case 'thinking':
    case 'tool':
    case 'error':
    case 'hibernate':
      return MOODS[state]
    case 'off':
    case 'suspended':
      return MOODS.off
    case 'idle':
    default:
      return MOODS.idle
  }
}

/** The quieter creature of a small (about 64 px) header orbital, e.g. the agent overview. */
export const QUIET_CREATURE: Omit<CreatureOptions, 'size'> = {
  amplitude: 0.55,
  gazeRange: 0.7,
  beatMinMs: 10_000,
  beatSpreadMs: 10_000,
  dozeAfterMs: 30_000
}
