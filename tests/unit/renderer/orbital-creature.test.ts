import { describe, expect, it } from 'vitest'
import {
  BEAT_MIN_MS,
  BEAT_SPREAD_MS,
  CALM_MOOD,
  DOZE_AFTER_MS,
  OrbitalCreature,
  TURN_RAD_S
} from '../../../src/renderer/components/orbital/orbital-creature'
import { creatureMoodFor, QUIET_CREATURE } from '../../../src/renderer/components/orbital/orbital-motion'

const FRAME_MS = 1000 / 60

/** Step the creature from `from` to `to` ms at 60 fps; returns the end time. */
function run(c: OrbitalCreature, from: number, to: number, each?: (now: number) => void): number {
  let now = from
  while (now < to) {
    now += FRAME_MS
    c.step(now, FRAME_MS / 1000)
    each?.(now)
  }
  return now
}

/** A fixed sequence of "random" numbers, repeating. */
function seq(...xs: number[]): () => number {
  let i = 0
  return () => xs[i++ % xs.length]
}

describe('OrbitalCreature', () => {
  it('turns slowly and cycles its phase at rest', () => {
    const c = new OrbitalCreature({ size: 112, rand: seq(0.99) })
    const o = c.step(0, 0)
    expect(o.spin).toBeCloseTo(TURN_RAD_S)
    expect(o.phase).toBe(1)
    expect(o.alpha).toBe(1)
  })

  it('reuses one output object and gaze array every step', () => {
    const c = new OrbitalCreature({ size: 112 })
    const o = c.step(0, 0)
    const gaze = o.gaze
    expect(c.step(16, 0.016)).toBe(o)
    expect(o.gaze).toBe(gaze)
  })

  it('schedules the first idle beat BEAT_MIN_MS in at the earliest', () => {
    // rand: 0 -> first beat at BEAT_MIN_MS; 0.5 -> a spin beat.
    const c = new OrbitalCreature({ size: 112, rand: seq(0, 0.5, 0) })
    let firstBeat = -1
    let kind: string | null = null
    run(c, 0, BEAT_MIN_MS + 1000, (now) => {
      if (firstBeat < 0 && c.beating) { firstBeat = now; kind = c.beating }
    })
    expect(kind).toBe('spin')
    expect(firstBeat).toBeGreaterThanOrEqual(BEAT_MIN_MS)
    expect(firstBeat).toBeLessThan(BEAT_MIN_MS + 2 * FRAME_MS)
  })

  it('never beats later than min + spread after the last one', () => {
    const c = new OrbitalCreature({ size: 112, rand: seq(0.999, 0.1, 0.999) })
    let beatAt = -1
    let now = 0
    // Keep it awake with activity far from the orbital (no "nearby" hold).
    while (now < BEAT_MIN_MS + BEAT_SPREAD_MS + 500 && beatAt < 0) {
      now = run(c, now, now + 1000)
      c.activity(now)
      if (c.hopping > 0 || c.beating) beatAt = now
    }
    expect(beatAt).toBeGreaterThan(BEAT_MIN_MS)
    expect(beatAt).toBeLessThanOrEqual(BEAT_MIN_MS + BEAT_SPREAD_MS + 1000)
  })

  it('holds idle beats while the pointer is near or the user is typing in a watched field', () => {
    const c = new OrbitalCreature({ size: 112, rand: seq(0, 0.5) })
    let beat = false
    run(c, 0, BEAT_MIN_MS + 3000, (now) => {
      c.pointer(now, 20, 10)
      if (c.beating || c.hopping) beat = true
    })
    expect(beat).toBe(false)
  })

  it('dozes after 20 s without activity and wakes on activity with a hop', () => {
    const c = new OrbitalCreature({ size: 112, rand: seq(0.99) })
    let now = run(c, 0, DOZE_AFTER_MS - 500)
    expect(c.doze).toBeLessThan(0.01)
    now = run(c, now, DOZE_AFTER_MS + 8000)
    expect(c.doze).toBeGreaterThan(0.9)
    const o = c.out
    expect(o.alpha).toBeLessThan(0.75)
    expect(o.spin).toBeLessThan(TURN_RAD_S * 0.5)
    expect(o.phase).toBeLessThan(0.5)
    expect(o.gaze[1]).toBeGreaterThan(0.4) // looks down
    c.activity(now)
    expect(c.hopping).toBe(1)
    run(c, now, now + 1500)
    expect(c.doze).toBeLessThan(0.01)
  })

  it('does not doze or beat while busy, and cycles its phase faster', () => {
    const c = new OrbitalCreature({ size: 112, rand: seq(0) })
    c.setBusy(true)
    run(c, 0, DOZE_AFTER_MS + 5000)
    expect(c.doze).toBe(0)
    expect(c.beating).toBeNull()
    expect(c.out.phase).toBeGreaterThan(1)
    expect(c.out.spin).toBeGreaterThan(TURN_RAD_S)
  })

  it('looks toward the pointer, bounded, and leans at most about 7 deg', () => {
    const c = new OrbitalCreature({ size: 112, rand: seq(0.99) })
    run(c, 0, 2000, (now) => c.pointer(now, 5000, 0))
    expect(c.out.gaze[0]).toBeGreaterThan(0.9)
    expect(c.out.gaze[0]).toBeLessThanOrEqual(1)
    expect(Math.abs(c.out.gaze[1])).toBeLessThan(0.1)
    expect(c.out.rot).toBeGreaterThan(0)
    expect(c.out.rot).toBeLessThanOrEqual(0.12 + 1e-9)
  })

  it('a glance wins over the pointer until it expires', () => {
    const c = new OrbitalCreature({ size: 112, rand: seq(0.99) })
    let now = run(c, 0, 500, (t) => c.pointer(t, 5000, 0))
    c.look(now, 0, 400, 1000)
    now = run(c, now, now + 800)
    expect(c.out.gaze[1]).toBeGreaterThan(0.8)
    run(c, now, now + 1500)
    expect(c.out.gaze[0]).toBeGreaterThan(0.8)
  })

  it('a hop lifts it and settles back; spin decays', () => {
    const c = new OrbitalCreature({ size: 100, rand: seq(0.99) })
    c.step(0, 0)
    c.hop(0, 0.2, 400)
    c.spin(6)
    let minY = 0
    const now = run(c, 0, 1400, () => { minY = Math.min(minY, c.out.y) })
    expect(minY).toBeLessThan(-15)
    expect(minY).toBeGreaterThanOrEqual(-20.5)
    expect(c.hopping).toBe(0)
    expect(Math.abs(c.out.y)).toBeLessThan(0.5)
    run(c, now, now + 5000)
    expect(c.out.spin).toBeCloseTo(TURN_RAD_S, 1)
  })

  it('keeps at most three hops, replacing the oldest', () => {
    const c = new OrbitalCreature({ size: 100 })
    c.step(0, 0)
    for (let i = 0; i < 5; i++) c.hop(i, 0.1, 300)
    expect(c.hopping).toBe(3)
  })

  it('perks up on hover', () => {
    const c = new OrbitalCreature({ size: 100, rand: seq(0.99) })
    run(c, 0, 100)
    const rest = c.out.sx
    c.perk(true)
    run(c, 100, 1000)
    expect(c.out.sx).toBeGreaterThan(rest)
    expect(c.out.y).toBeLessThan(0)
  })

  describe('quiet options', () => {
    it('scales hop height, lean and gaze down', () => {
      const loud = new OrbitalCreature({ size: 100, rand: seq(0.99) })
      const quiet = new OrbitalCreature({ size: 100, rand: seq(0.99), amplitude: 0.5, gazeRange: 0.6 })
      const peak = (c: OrbitalCreature) => {
        c.step(0, 0)
        c.hop(0, 0.2, 400)
        let minY = 0
        run(c, 0, 1400, () => { minY = Math.min(minY, c.out.y) })
        return minY
      }
      expect(peak(quiet)).toBeCloseTo(peak(loud) * 0.5, 0)
      run(loud, 1400, 3400, (t) => loud.pointer(t, 5000, 0))
      run(quiet, 1400, 3400, (t) => quiet.pointer(t, 5000, 0))
      expect(quiet.out.gaze[0]).toBeCloseTo(loud.out.gaze[0] * 0.6, 2)
      expect(quiet.out.rot).toBeCloseTo(loud.out.rot * 0.5, 3)
    })

    it('spaces idle beats by beatMinMs and dozes after dozeAfterMs', () => {
      const c = new OrbitalCreature({ size: 64, rand: seq(0, 0.5, 0), ...QUIET_CREATURE })
      let firstBeat = -1
      let now = 0
      while (now < 12_000) {
        now = run(c, now, now + 1000, (t) => { if (firstBeat < 0 && c.beating) firstBeat = t })
        c.activity(now)
      }
      expect(firstBeat).toBeGreaterThanOrEqual(QUIET_CREATURE.beatMinMs!)
      now = run(c, now, now + QUIET_CREATURE.dozeAfterMs! - 1000)
      expect(c.doze).toBeLessThan(0.01)
      run(c, now, now + 8000)
      expect(c.doze).toBeGreaterThan(0.9)
    })
  })

  describe('moods', () => {
    it('maps agent state to behaviour', () => {
      expect(creatureMoodFor('idle')).toBe(CALM_MOOD)
      const thinking = creatureMoodFor('thinking')
      const tool = creatureMoodFor('tool')
      expect(thinking.turn).toBeGreaterThan(1)
      expect(thinking.awake && thinking.active && !thinking.beats).toBe(true)
      expect(tool.phase).toBeGreaterThan(thinking.phase)
      expect(tool.spins).toBe(true)
      expect(creatureMoodFor('thinking', true).attentive).toBe(true)
      expect(creatureMoodFor('idle', true).attentive).toBe(true)
      expect(creatureMoodFor('error').alpha).toBeLessThan(1)
      expect(creatureMoodFor('error').turn).toBeLessThan(1)
      expect(creatureMoodFor('off').sleep).toBe(1)
      expect(creatureMoodFor('suspended').sleep).toBe(1)
      expect(creatureMoodFor('hibernate').sleep).toBe(2)
      expect(creatureMoodFor('off', true).attentive).toBe(false)
    })

    it('thinking turns faster and never dozes', () => {
      const c = new OrbitalCreature({ size: 64, rand: seq(0.99) })
      c.setMood(0, creatureMoodFor('thinking'))
      run(c, 0, DOZE_AFTER_MS + 5000)
      expect(c.doze).toBe(0)
      expect(c.out.spin).toBeCloseTo(TURN_RAD_S * 2.5, 1)
      expect(c.out.phase).toBe(2)
    })

    it('a tool turn spins now and then', () => {
      const c = new OrbitalCreature({ size: 64, rand: seq(0) })
      c.step(0, 0)
      c.setMood(0, creatureMoodFor('tool'))
      let maxSpin = 0
      run(c, 0, 3000, () => { maxSpin = Math.max(maxSpin, c.out.spin) })
      expect(maxSpin).toBeGreaterThan(TURN_RAD_S * 3 + 1)
    })

    it('waiting looks up and hops every few seconds', () => {
      const c = new OrbitalCreature({ size: 64, rand: seq(0.5) })
      c.step(0, 0)
      c.setMood(0, creatureMoodFor('idle', true))
      let hops = 0
      let wasHopping = false
      run(c, 0, 10_000, () => {
        if (c.hopping && !wasHopping) hops++
        wasHopping = c.hopping > 0
      })
      expect(hops).toBeGreaterThanOrEqual(3)
      expect(c.out.gaze[1]).toBeLessThan(-0.25)
      expect(c.doze).toBe(0)
    })

    it('settles with a hop when a turn ends, not into an error', () => {
      const c = new OrbitalCreature({ size: 64, rand: seq(0.99) })
      c.step(0, 0)
      c.setMood(0, creatureMoodFor('thinking'))
      c.setMood(10, creatureMoodFor('idle'))
      expect(c.hopping).toBe(1)
      const d = new OrbitalCreature({ size: 64, rand: seq(0.99) })
      d.step(0, 0)
      d.setMood(0, creatureMoodFor('tool'))
      d.setMood(10, creatureMoodFor('error'))
      expect(d.hopping).toBe(0)
    })

    it('error is still-ish and dim', () => {
      const c = new OrbitalCreature({ size: 64, rand: seq(0.99) })
      c.setMood(0, creatureMoodFor('error'))
      run(c, 0, 1000)
      expect(c.out.spin).toBeLessThan(TURN_RAD_S * 0.5)
      expect(c.out.alpha).toBeLessThan(1)
      expect(c.out.alpha).toBeGreaterThan(0.7)
    })

    it('off dozes at once and stays asleep on activity, still breathing; hibernate dozes deeper', () => {
      const off = new OrbitalCreature({ size: 64, rand: seq(0.99) })
      off.setMood(0, creatureMoodFor('off'))
      let now = run(off, 0, 6000)
      expect(off.doze).toBeGreaterThan(0.9)
      off.activity(now)
      expect(off.hopping).toBe(0)
      let lo = Infinity
      let hi = 0
      now = run(off, now, now + 9000, () => { lo = Math.min(lo, off.out.sx); hi = Math.max(hi, off.out.sx) })
      expect(off.doze).toBeGreaterThan(0.9)
      expect(hi - lo).toBeGreaterThan(0.03)
      const hib = new OrbitalCreature({ size: 64, rand: seq(0.99) })
      hib.setMood(0, creatureMoodFor('hibernate'))
      run(hib, 0, 6000)
      expect(hib.out.alpha).toBeLessThan(off.out.alpha)
      expect(hib.out.spin).toBeLessThan(off.out.spin)
    })
  })
})
