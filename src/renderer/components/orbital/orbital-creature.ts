/**
 * The behaviour of a live orbital that acts like a small creature (home's
 * next-agent orbital), after ava on the site (adf-org BRAND.md section 6,
 * Sprite.astro). Pure: no DOM, no timers; LiveOrbital calls `step` once per
 * animation frame and reads `out`. Time is in ms (`now`) and s (`dt`).
 *
 * What it does:
 * - turns slowly and cycles its two-tone phase; breathes (about 2.5% scale);
 * - its core looks at things: a glance target (an input being typed in), a
 *   look-around beat, else the pointer anywhere in the window, else a slow
 *   wander. It leans a little (at most about 7 deg) toward the pointer;
 * - idle beats (a small hop, a spin, a look around) every 6 to 13 s, never
 *   while the user is typing or the pointer is moving over it;
 * - dozes after 20 s without pointer or keys (slower, dimmer, gaze down) and
 *   wakes on activity with a small hop;
 * - reactions: hop, spin, perk (hover), busy (faster phase while creating).
 *
 * Options scale it down for a smaller, quieter orbital (amplitude, gaze
 * range, beat spacing, doze delay). A mood (`setMood`, see creatureMoodFor in
 * orbital-motion.ts) layers an agent's real state on top: turn and phase
 * speed, dimming, forced doze, attentive perk hops, occasional tool spins,
 * and a small settle hop when a turn ends.
 *
 * `out` is one object reused every frame; nothing allocates per step.
 */

export interface CreatureFrame {
  /** Where the core looks, -1..1 each (y down). */
  gaze: [number, number]
  /** Axial spin rate, rad/s (base turn plus beats). */
  spin: number
  /** Multiplier on the spec's phase speed. */
  phase: number
  /** Opacity 0..1. */
  alpha: number
  /** Offset in CSS px (y < 0 is up). */
  x: number
  y: number
  /** Lean, rad (positive leans right). */
  rot: number
  /** Scale (squash and stretch, breath, perk). */
  sx: number
  sy: number
}

export interface CreatureOptions {
  /** Orbital size in CSS px; hops and the gaze falloff scale with it. */
  size: number
  /** 0..1 random source (tests pass a seeded one). */
  rand?: () => number
  /** Quiet time before dozing, ms. */
  dozeAfterMs?: number
  /** Scales movement: lean, hop height, squash, beat spin, perk lift. 1 = home. */
  amplitude?: number
  /** Scales how far the core looks, 0..1. */
  gazeRange?: number
  /** Idle beats come every beatMinMs + up to beatSpreadMs. */
  beatMinMs?: number
  beatSpreadMs?: number
}

/** An agent's state as the creature acts it out (creatureMoodFor). */
export interface CreatureMood {
  /** Multiplier on TURN_RAD_S. */
  turn: number
  /** Multiplier on the spec's phase speed. */
  phase: number
  /** Opacity ceiling 0..1. */
  alpha: number
  /** Idle beats allowed. */
  beats: boolean
  /** Never dozes (something is happening). */
  awake: boolean
  /** 0 normal; 1 dozing whatever the user does; 2 dozing deeper. */
  sleep: 0 | 1 | 2
  /** Looks up at the user, perked, with a small hop every few seconds. */
  attentive: boolean
  /** Occasional small spins (running a tool). */
  spins: boolean
  /** A turn is running; leaving it settles with a small hop. */
  active: boolean
}

export const CALM_MOOD: CreatureMood = {
  turn: 1, phase: 1, alpha: 1, beats: true, awake: false, sleep: 0, attentive: false, spins: false, active: false
}

/** Base axial turn, rad/s. Slow: the shape should read as resting, not busy. */
export const TURN_RAD_S = 0.25
/** Idle beats come every BEAT_MIN_MS + up to BEAT_SPREAD_MS. */
export const BEAT_MIN_MS = 6000
export const BEAT_SPREAD_MS = 7000
export const DOZE_AFTER_MS = 20000
/** No idle beat this soon after the user typed or moved the pointer nearby. */
const BEAT_QUIET_MS = 1500
const LEAN_MAX = 0.12
const MAX_HOPS = 3
const HOP_ANTICIPATION_MS = 110
/** Attentive: a small hop every ATTEND_MIN_MS + up to ATTEND_SPREAD_MS. */
export const ATTEND_MIN_MS = 2600
export const ATTEND_SPREAD_MS = 1200
/** Tool: a small spin every TOOL_SPIN_MIN_MS + up to TOOL_SPIN_SPREAD_MS. */
export const TOOL_SPIN_MIN_MS = 3500
export const TOOL_SPIN_SPREAD_MS = 4000

interface Hop { t0: number; dur: number; h: number }
type BeatKind = 'spin' | 'look'

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
const lerp = (a: number, b: number, k: number) => a + (b - a) * k
const ease = (dt: number, tauS: number) => 1 - Math.exp(-dt / tauS)

export class OrbitalCreature {
  readonly out: CreatureFrame = { gaze: [0, 0], spin: TURN_RAD_S, phase: 1, alpha: 1, x: 0, y: 0, rot: 0, sx: 1, sy: 1 }
  size: number
  private readonly rand: () => number
  private readonly dozeAfter: number
  private readonly amp: number
  private readonly gazeRange: number
  private readonly beatMin: number
  private readonly beatSpread: number
  private mood: CreatureMood = CALM_MOOD
  private nextAttend = 0
  private nextToolSpin = 0
  private started = false
  private clock = 0
  private lastActivity = 0
  private lastNearby = -Infinity
  private nextBeat = 0
  private beat: BeatKind | null = null
  private beatT0 = 0
  private beatDur = 0
  private readonly hops: Hop[] = []
  private nHops = 0
  /** Extra spin velocity, rad/s, decaying. */
  private spinVel = 0
  /** Pointer relative to the orbital's centre, px; null when it left the window. */
  private px = 0
  private py = 0
  private hasPointer = false
  private glanceX = 0
  private glanceY = 0
  private glanceUntil = -Infinity
  private perkTarget = 0
  private perkLevel = 0
  private busyOn = false
  private dz = 0
  private tilt = 0
  private gx = 0
  private gy = 0
  private tx = 0
  private ty = 0

  constructor(opts: CreatureOptions) {
    this.size = opts.size
    this.rand = opts.rand ?? Math.random
    this.dozeAfter = opts.dozeAfterMs ?? DOZE_AFTER_MS
    this.amp = opts.amplitude ?? 1
    this.gazeRange = opts.gazeRange ?? 1
    this.beatMin = opts.beatMinMs ?? BEAT_MIN_MS
    this.beatSpread = opts.beatSpreadMs ?? BEAT_SPREAD_MS
    for (let i = 0; i < MAX_HOPS; i++) this.hops.push({ t0: 0, dur: 0, h: 0 })
  }

  /** 0 awake .. 1 asleep. */
  get doze(): number { return this.dz }
  get busy(): boolean { return this.busyOn }
  get beating(): BeatKind | null { return this.beat }
  get hopping(): number { return this.nHops }
  get currentMood(): CreatureMood { return this.mood }

  /** The user did something (pointer, keys). Wakes it; a deep doze wakes with a hop. */
  activity(now: number): void {
    if (this.dz > 0.6 && this.mood.sleep === 0) {
      this.dz = 0.6
      this.hop(now, 0.08, 300)
    }
    this.lastActivity = now
  }

  /** Pointer position relative to the orbital's centre, px; null when it left. */
  pointer(now: number, x: number | null, y = 0): void {
    if (x === null) { this.hasPointer = false; return }
    this.px = x
    this.py = y
    this.hasPointer = true
    if (Math.hypot(x, y) < this.size * 1.5) this.lastNearby = now
    this.activity(now)
  }

  /** Look at a point (px from the centre) for `ms`. */
  look(now: number, x: number, y: number, ms = 1500): void {
    this.glanceX = x
    this.glanceY = y
    this.glanceUntil = now + ms
    this.lastNearby = now
    this.activity(now)
  }

  /** A hop in place: `h` is the height as a fraction of the size, `dur` the flight in ms. */
  hop(now: number, h = 0.12, dur = 340): void {
    let slot = 0
    if (this.nHops < MAX_HOPS) slot = this.nHops++
    // Full: replace the oldest.
    else for (let i = 1; i < MAX_HOPS; i++) if (this.hops[i].t0 < this.hops[slot].t0) slot = i
    const j = this.hops[slot]
    j.t0 = now
    j.dur = dur
    j.h = h * this.size * this.amp
  }

  /** Add spin, rad/s; decays over about a second. */
  spin(amount: number): void {
    this.spinVel = clamp(this.spinVel + amount, -10, 10)
  }

  /** Hovered: perks up (a little larger and higher). */
  perk(on: boolean): void { this.perkTarget = on ? 1 : 0 }

  /** Something is being made: phase runs faster, it turns faster, no dozing or idle beats. */
  setBusy(on: boolean): void { this.busyOn = on }

  /**
   * Act out an agent state (creatureMoodFor). Leaving an active turn for idle
   * or waiting settles with a small hop; becoming attentive hops soon.
   */
  setMood(now: number, mood: CreatureMood): void {
    const prev = this.mood
    if (prev === mood) return
    this.mood = mood
    if (mood.attentive && !prev.attentive) this.nextAttend = now + 400
    if (mood.spins && !prev.spins) this.nextToolSpin = now + 1500 + this.rand() * 2000
    // Not into an error or a doze: those stay still.
    if (prev.active && !mood.active && mood.sleep === 0 && mood.turn >= 1) this.hop(now, 0.07, 300)
    if (mood.sleep === 0 && prev.sleep > 0) this.lastActivity = now
  }

  /** Doze now (as if quiet for long enough). */
  sleep(now: number): void { this.lastActivity = now - this.dozeAfter - 1 }

  step(now: number, dt: number): CreatureFrame {
    const o = this.out
    if (!this.started) {
      this.started = true
      this.lastActivity = now
      this.nextBeat = now + this.beatMin + this.rand() * this.beatSpread
    }
    const m = this.mood
    const amp = this.amp
    this.clock += dt
    const quiet = now - this.lastActivity
    const dozy = !this.busyOn && !m.awake && (m.sleep > 0 || quiet > this.dozeAfter)
    this.dz = lerp(this.dz, dozy ? 1 : 0, ease(dt, dozy ? 1.4 : 0.25))
    if (this.dz < 0.001) this.dz = 0
    const dz = this.dz
    const deep = m.sleep === 2
    const perkT = Math.max(this.perkTarget, m.attentive ? 0.6 : 0)
    this.perkLevel = lerp(this.perkLevel, perkT * (1 - dz), ease(dt, 0.15))

    // Mood beats: attentive hops, tool spins.
    if (dz < 0.1 && !this.busyOn) {
      if (m.attentive && this.nHops === 0 && now >= this.nextAttend) {
        this.hop(now, 0.07, 280)
        this.nextAttend = now + ATTEND_MIN_MS + this.rand() * ATTEND_SPREAD_MS
      }
      if (m.spins && now >= this.nextToolSpin) {
        this.spin(2.5 * amp)
        this.nextToolSpin = now + TOOL_SPIN_MIN_MS + this.rand() * TOOL_SPIN_SPREAD_MS
      }
    }

    // Idle beats.
    if (!this.beat && this.nHops === 0 && !this.busyOn && m.beats && dz < 0.1 && now >= this.nextBeat) {
      if (now - this.lastNearby < BEAT_QUIET_MS) this.nextBeat = now + BEAT_QUIET_MS
      else {
        const r = this.rand()
        if (r < 0.45) this.hop(now, 0.1, 340)
        else if (r < 0.72) this.startBeat(now, 'spin', 800)
        else this.startBeat(now, 'look', 1900)
        this.nextBeat = now + this.beatMin + this.rand() * this.beatSpread
      }
    }
    let look: number | null = null
    let beatSpin = 0
    if (this.beat) {
      const u = (now - this.beatT0) / this.beatDur
      if (u >= 1) this.beat = null
      else if (this.beat === 'spin') beatSpin = 6 * amp * Math.sin(Math.PI * u)
      else look = Math.sin(u * Math.PI * 2)
    }

    // Spin and phase.
    this.spinVel *= Math.exp(-dt / 0.9)
    if (Math.abs(this.spinVel) < 0.01) this.spinVel = 0
    const base = TURN_RAD_S * (this.busyOn ? 4 : m.turn)
    o.spin = (base + beatSpin + (this.nHops ? amp : 0)) * (1 - (deep ? 0.85 : 0.7) * dz) + this.spinVel
    o.phase = (this.busyOn ? 4 : m.phase) * (1 - (deep ? 0.8 : 0.6) * dz)
    o.alpha = (this.busyOn ? 1 : m.alpha) * (1 - (deep ? 0.5 : 0.35) * dz)

    // Hops: anticipation crouch, flight with stretch, landing wobble.
    let lift = 0
    let sx = 1
    let sy = 1
    for (let i = 0; i < this.nHops; i++) {
      const j = this.hops[i]
      const el = now - j.t0
      if (el < 0) continue
      if (el < HOP_ANTICIPATION_MS) {
        const e = Math.sin((el / HOP_ANTICIPATION_MS) * Math.PI / 2)
        sx *= 1 + 0.1 * amp * e
        sy *= 1 - 0.12 * amp * e
        continue
      }
      const u = (el - HOP_ANTICIPATION_MS) / j.dur
      if (u < 1) {
        const st = Math.sin(Math.PI * u)
        lift += j.h * st
        sx *= 1 - 0.05 * amp * st
        sy *= 1 + 0.08 * amp * st
      } else {
        const tl = (u - 1) * j.dur
        if (tl > 700) {
          // Done: drop this slot (swap with the last live one).
          this.nHops--
          const last = this.hops[this.nHops]
          this.hops[this.nHops] = j
          this.hops[i] = last
          i--
          continue
        }
        const k = 0.1 * amp * Math.exp(-tl / 120) * Math.cos(tl / 40)
        sx *= 1 + k
        sy *= 1 - k
      }
    }
    const breath = 1 + (0.025 + 0.01 * dz) * Math.sin((this.clock * 2 * Math.PI) / lerp(4.6, deep ? 10 : 8, dz))
    const perk = 1 + 0.05 * this.perkLevel
    o.sx = sx * breath * perk
    o.sy = sy * breath * perk * (1 - 0.04 * dz)
    o.x = 0
    o.y = -(lift + 3 * amp * this.perkLevel)

    // Gaze: glance target, look-around, pointer, else a slow wander.
    let gx = 0.3 * Math.cos(this.clock * 0.37)
    let gy = 0.2 * Math.sin(this.clock * 0.23) - 0.08
    let leanT = 0
    if (now < this.glanceUntil) {
      this.toward(this.glanceX, this.glanceY)
      gx = this.tx
      gy = this.ty
    } else if (look !== null) {
      gx = look
      gy = -0.1
    } else if (this.hasPointer) {
      this.toward(this.px, this.py)
      gx = this.tx
      gy = this.ty
    } else if (m.attentive) {
      gx = 0
      gy = -0.6
    }
    // Attentive: at the user, or up, never down at the floor.
    if (m.attentive && gy > -0.3) gy = -0.3
    gx *= this.gazeRange
    gy *= this.gazeRange
    if (this.hasPointer) leanT = clamp(this.px / 500, -1, 1) * LEAN_MAX * amp
    if (dz > 0.01) {
      gx = lerp(gx, 0, dz)
      gy = lerp(gy, 0.55, dz)
    }
    const kg = ease(dt, 0.18)
    this.gx = lerp(this.gx, gx, kg)
    this.gy = lerp(this.gy, gy, kg)
    o.gaze[0] = this.gx
    o.gaze[1] = this.gy
    this.tilt = lerp(this.tilt, leanT * (1 - dz), ease(dt, 0.16))
    o.rot = this.tilt
    return o
  }

  private startBeat(now: number, kind: BeatKind, dur: number): void {
    this.beat = kind
    this.beatT0 = now
    this.beatDur = dur
  }

  /** Into (tx, ty): the unit direction toward (x, y) px, shorter within about one size of the centre. */
  private toward(x: number, y: number): void {
    const l = Math.hypot(x, y)
    const m = l < 1e-6 ? 0 : Math.min(1, l / (this.size * 1.2)) / l
    this.tx = x * m
    this.ty = y * m
  }
}
