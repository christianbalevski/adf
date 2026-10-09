/**
 * An agent's orbital drawn live on a canvas: for the one large orbital on a
 * screen (agent overview, create screen). Small avatars use OrbitalAvatar.
 *
 * Motion follows `state` (orbital-motion.ts). `kick(amount)` on the ref, or a
 * change in `spinImpulse`, adds angular velocity that decays, so the shape
 * can turn as the user types. Reduced motion draws once at t = 0 and ignores
 * kicks.
 *
 * Building the shape runs on the main thread the first time a seed is drawn
 * (tens to a few hundred ms); fine for one orbital per screen.
 */

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { drawOrbital, orbitalFromSeed, type OrbitalSpec } from '../../lib/brand/orbital.js'
import { isOrbitalMoving, orbitalMotion, type OrbitalMotionState } from './orbital-motion'
import { useOrbitalTheme, usePrefersReducedMotion } from './orbital-env'
import { subscribeFrames } from './orbital-frame-loop'

/** rad/s added per unit of kick. */
const KICK_RAD_S = 1.2
/** Cap on the extra angular velocity, rad/s. */
const KICK_MAX = 8
/** Decay time constant of the extra velocity, s. */
const KICK_DECAY_S = 0.8

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
  /** Where the core looks, -1..1 each. */
  gaze?: [number, number]
  className?: string
}

export const LiveOrbital = forwardRef<LiveOrbitalHandle, LiveOrbitalProps>(function LiveOrbital(
  { seed, size, state = 'idle', spinImpulse, gaze, className },
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
    sim.current = { angle: 0, vel: 0, time: 0 }
  }, [seed])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(size * dpr)
    canvas.height = Math.round(size * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const draw = () => {
      const p = props.current
      const spec = specRef.current
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      if (!spec) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const m = orbitalMotion(p.state)
      const still = p.reduce
      drawOrbital(ctx, spec, {
        size: p.size,
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
      return !p.reduce && (isOrbitalMoving(orbitalMotion(p.state)) || Math.abs(sim.current.vel) > 0.01)
    }
    const onFrame = (_now: number, dt: number) => {
      const p = props.current
      const m = orbitalMotion(p.state)
      const s = sim.current
      s.angle += (m.spin + s.vel) * dt
      s.time += m.phase * dt
      s.vel *= Math.exp(-dt / KICK_DECAY_S)
      if (Math.abs(s.vel) <= 0.01) s.vel = 0
      draw()
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
  }, [seed, size, theme, reduce, state])

  useEffect(() => {
    redrawRef.current()
  }, [gaze?.[0], gaze?.[1]])

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ width: size, height: size }}
      aria-hidden="true"
    />
  )
})
