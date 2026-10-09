/**
 * An agent's orbital drawn live on a canvas: for the one large orbital on a
 * screen (agent overview, create screen). Small avatars use OrbitalAvatar.
 *
 * Motion follows `state` (orbital-motion.ts). `kick(amount)` on the ref, or a
 * change in `spinImpulse`, adds angular velocity that decays, so the shape
 * can turn as the user types. Reduced motion draws once at t = 0 and ignores
 * kicks.
 *
 * With `creature` (an OrbitalCreature) it is alive instead: frames run all
 * the time (paused while the document is hidden or it is unmounted), the
 * shape turns slowly and cycles its phase whatever `state` says, and the
 * creature moves it: gaze, lean, hops, doze. The canvas redraws at most
 * DRAW_FPS; the creature's lean, hop and scale go on the canvas as a CSS
 * transform at the same rate (every frame during a hop). Reduced motion draws it once at t = 0, untransformed.
 *
 * In every mode the canvas is PAD times larger than `size` (laid out at
 * `size`, overflowing it evenly) and transparent, with a soft radial mask:
 * the faint fill around the shape fades out instead of ending in a square
 * at the canvas edge, and a hop or lean never clips.
 *
 * Building the shape runs on the main thread the first time a seed is drawn
 * (tens to a few hundred ms); fine for one orbital per screen.
 */

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { drawOrbital, orbitalFromSeed, type OrbitalSpec } from '../../lib/brand/orbital.js'
import type { OrbitalCreature } from './orbital-creature'
import { SpinCachedCreature } from './orbital-spin-cache'
import { isOrbitalMoving, orbitalMotion, type OrbitalMotionState } from './orbital-motion'
import { useOrbitalTheme, usePrefersReducedMotion } from './orbital-env'
import { subscribeFrames } from './orbital-frame-loop'

/** rad/s added per unit of kick. */
const KICK_RAD_S = 1.2
/** Cap on the extra angular velocity, rad/s. */
const KICK_MAX = 8
/** Decay time constant of the extra velocity, s. */
const KICK_DECAY_S = 0.8
/** Alive: canvas redraws per second at most (the CSS transform runs every frame). */
const DRAW_FPS = 30
/** Canvas size over `size`: room for the fill's faint edge to fade out, and for hops and lean. */
const PAD = 1.5
const CANVAS_MASK = 'radial-gradient(closest-side, #000 62%, rgba(0, 0, 0, 0.55) 82%, transparent 100%)'

export interface LiveOrbitalHandle {
  /** Add spin. Positive turns forward, negative back; 1 is one keystroke's worth. */
  kick: (amount?: number) => void
}

export interface LiveOrbitalProps {
  /** From orbitalSeedFor(). Null leaves the canvas empty. */
  seed: string | null | undefined
  /** CSS px, square. */
  size: number
  state?: OrbitalMotionState
  /** Any number; each change kicks by the difference (e.g. the draft's length). */
  spinImpulse?: number
  /** Where the core looks, -1..1 each. Ignored when `creature` drives it. */
  gaze?: [number, number]
  /** Alive mode: this creature drives the orbital every frame. Keep it stable. */
  creature?: OrbitalCreature | null
  className?: string
}

export const LiveOrbital = forwardRef<LiveOrbitalHandle, LiveOrbitalProps>(function LiveOrbital(
  { seed, size, state = 'idle', spinImpulse, gaze, creature, className },
  ref
) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const theme = useOrbitalTheme()
  const reduce = usePrefersReducedMotion()

  // Mutable animation state, read by the frame loop without re-rendering.
  const sim = useRef({ angle: 0, vel: 0, time: 0 })
  const props = useRef({ state, gaze, theme, size, reduce })
  props.current = { state, gaze, theme, size, reduce }
  const specRef = useRef<OrbitalSpec | null>(null)
  const aliveRef = useRef<SpinCachedCreature | null>(null)
  const wakeRef = useRef<() => void>(() => {})
  const redrawRef = useRef<() => void>(() => {})

  useImperativeHandle(ref, () => ({
    kick(amount = 1) {
      if (props.current.reduce || !Number.isFinite(amount)) return
      const s = sim.current
      s.vel = Math.max(-KICK_MAX, Math.min(KICK_MAX, s.vel + amount * KICK_RAD_S))
      wakeRef.current()
    }
  }), [])

  const lastImpulse = useRef(spinImpulse)
  useEffect(() => {
    const prev = lastImpulse.current
    lastImpulse.current = spinImpulse
    if (prev === undefined || spinImpulse === undefined || reduce) return
    const d = spinImpulse - prev
    if (d === 0) return
    const s = sim.current
    s.vel = Math.max(-KICK_MAX, Math.min(KICK_MAX, s.vel + d * KICK_RAD_S))
    wakeRef.current()
  }, [spinImpulse, reduce])

  useEffect(() => {
    specRef.current = seed ? orbitalFromSeed(seed) : null
    aliveRef.current = null
    sim.current = { angle: 0, vel: 0, time: 0 }
  }, [seed])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const alive = !!creature && !reduce
    const box = size * PAD
    canvas.width = Math.round(box * dpr)
    canvas.height = Math.round(box * dpr)
    canvas.style.transform = ''
    canvas.style.opacity = ''
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const draw = () => {
      const p = props.current
      const spec = specRef.current
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      if (!spec) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const still = p.reduce
      if (creature) {
        // Alive (or its reduced-motion still): our own spin-cached Creature.
        let cr = aliveRef.current
        if (!cr || cr.spec !== spec) cr = aliveRef.current = new SpinCachedCreature(spec)
        cr.draw(ctx, {
          cx: box / 2,
          cy: box / 2,
          size: p.size,
          spin: still ? 0 : sim.current.angle,
          time: still ? 0 : sim.current.time,
          dark: p.theme === 'dark',
          gaze: still ? undefined : creature.out.gaze
        })
        return
      }
      const m = orbitalMotion(p.state)
      drawOrbital(ctx, spec, {
        size: p.size,
        cx: box / 2,
        cy: box / 2,
        theme: p.theme,
        t: still ? 0 : sim.current.time,
        spin: still ? 0 : sim.current.angle,
        alpha: m.alpha,
        gaze: still ? undefined : p.gaze
      })
    }

    let unsub: (() => void) | null = null
    const stop = () => {
      unsub?.()
      unsub = null
    }
    const needsFrames = () => {
      const p = props.current
      if (p.reduce) return false
      return alive || isOrbitalMoving(orbitalMotion(p.state)) || Math.abs(sim.current.vel) > 0.01
    }
    let lastDraw = -Infinity
    const onFrame = (now: number, dt: number) => {
      const p = props.current
      const s = sim.current
      // Alive: redraw and restyle at DRAW_FPS, every frame during a hop.
      const due = !alive || now - lastDraw >= 1000 / DRAW_FPS - 4
      if (alive && creature) {
        const o = creature.step(now, dt)
        s.angle += (o.spin + s.vel) * dt
        s.time += o.phase * dt
        if (due || creature.hopping > 0) {
          canvas.style.transform = `translate(${o.x.toFixed(2)}px,${o.y.toFixed(2)}px) rotate(${o.rot.toFixed(4)}rad) scale(${o.sx.toFixed(4)},${o.sy.toFixed(4)})`
          canvas.style.opacity = o.alpha.toFixed(3)
        }
      } else {
        const m = orbitalMotion(p.state)
        s.angle += (m.spin + s.vel) * dt
        s.time += m.phase * dt
      }
      s.vel *= Math.exp(-dt / KICK_DECAY_S)
      if (Math.abs(s.vel) <= 0.01) s.vel = 0
      if (due) {
        lastDraw = now
        draw()
      }
      if (!needsFrames()) stop()
    }
    const wake = () => {
      if (!unsub && needsFrames()) unsub = subscribeFrames(onFrame)
    }
    wakeRef.current = wake
    // While frames run, the next frame picks up a new gaze on its own.
    redrawRef.current = () => {
      if (!unsub) draw()
    }
    draw()
    wake()
    return () => {
      stop()
      wakeRef.current = () => {}
      redrawRef.current = () => {}
    }
  }, [seed, size, theme, reduce, state, creature])

  useEffect(() => {
    redrawRef.current()
  }, [gaze?.[0], gaze?.[1]])

  // Laid out at `size`; the canvas overflows it evenly on every side and
  // fades out radially, so the faint fill never ends in a hard square edge.
  const box = size * PAD
  const inset = (box - size) / 2
  return (
    <div className={className} style={{ position: 'relative', width: size, height: size }} aria-hidden="true">
      <canvas
        ref={canvasRef}
        style={{
          position: 'absolute',
          left: -inset,
          top: -inset,
          width: box,
          height: box,
          pointerEvents: 'none',
          transformOrigin: '50% 78%',
          // Its own compositor layer while alive: the per-frame transform then
          // moves a texture instead of repainting.
          willChange: creature ? 'transform, opacity' : undefined,
          maskImage: CANVAS_MASK,
          WebkitMaskImage: CANVAS_MASK
        }}
      />
    </div>
  )
})
