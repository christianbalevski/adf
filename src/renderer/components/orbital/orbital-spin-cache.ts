/**
 * A Creature that keeps the projected grid for SPIN_STEPS spins around the
 * axis instead of only the last one. Projecting the grid costs 10 to 20 ms at
 * the large size, so an orbital that turns all the time (home's) would pay it
 * every frame; with this it pays it once per step for the first turn and
 * then nothing. The fill and contour snap to the nearest step (4 deg); the
 * dots and the core still move continuously. About 120 kB per step.
 */

import { Creature } from '../../lib/brand/orbital.js'

export const SPIN_STEPS = 90
const STEP = (2 * Math.PI) / SPIN_STEPS

export class SpinCachedCreature extends Creature {
  private readonly grids = new Map<number, unknown>()

  override gridFor(spin: number, FN: number, ZS: number): unknown {
    const i = ((Math.round(spin / STEP) % SPIN_STEPS) + SPIN_STEPS) % SPIN_STEPS
    const key = FN * SPIN_STEPS + i
    const hit = this.grids.get(key)
    if (hit) {
      this.grid = hit
      return hit
    }
    const g = super.gridFor(i * STEP, FN, ZS)
    this.grids.set(key, g)
    return g
  }
}
