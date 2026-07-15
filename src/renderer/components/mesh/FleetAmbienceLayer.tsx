import { memo, useEffect, useRef } from 'react'
import { useReactFlow } from '@xyflow/react'
import { useMeshGraphStore } from '../../stores/mesh-graph.store'
import { HEX_SIZE, pixelToAxialRounded, axialToPixel } from './fleet-layout'

/**
 * Ambient fireflies — hundreds of tiny motes shooting along the hex lattice
 * edges, fading in and out over a second or two. Pure ambience with a
 * telemetry undertone: emission density tracks each agent's state (active
 * spews, idle trickles, hibernate barely breathes) and color carries the
 * alert language (red = error, amber = needs you); everything else glows the
 * garden's bioluminescent teal.
 *
 * ONE canvas + ONE rAF loop, everything imperative: hundreds of individually
 * CSS-animated DOM nodes would jank pan/zoom (style recalc + layer
 * explosion), while a few hundred short strokes on a 2D canvas cost well
 * under a millisecond a frame and never touch React. World-anchored: the
 * viewport transform is read per frame, so motes stick to their lattice
 * edges through pan and zoom.
 */

export interface AmbienceEmitter {
  /** World-space tile center */
  x: number
  y: number
  state: string
  online: boolean
  filePath: string
}

interface Mote {
  /** Polyline of world-space points (hex corners) the mote travels */
  path: { x: number; y: number }[]
  /** Total path length, world units */
  length: number
  bornAt: number
  lifeMs: number
  color: string
  /** Peak alpha — ambience stays subtle, alerts glow a little harder */
  peak: number
}

/** Per-state emission rates (motes/second per agent) and colors */
const TEAL_DARK = '94, 234, 212' // teal-300
const TEAL_LIGHT = '15, 118, 110' // teal-700
const RED = '248, 113, 113'
const AMBER = '245, 158, 11'

const MAX_MOTES = 700
/** Ambient garden baseline — motes/second sprinkled across the world bbox */
const AMBIENT_RATE = 20
const FRAME_MS = 1000 / 30 // ambience doesn't need 60fps

function rateFor(e: AmbienceEmitter, needsYou: boolean): { rate: number; color: string; peak: number } | null {
  const dark = document.documentElement.classList.contains('dark')
  const teal = dark ? TEAL_DARK : TEAL_LIGHT
  if (needsYou) return { rate: 2.5, color: AMBER, peak: 0.9 }
  if (!e.online) return null
  switch (e.state) {
    case 'error':
      return { rate: 1.5, color: RED, peak: 0.85 }
    case 'active':
      return { rate: 4, color: teal, peak: 0.7 }
    case 'idle':
      return { rate: 1.1, color: teal, peak: 0.55 }
    case 'hibernate':
      return { rate: 0.15, color: teal, peak: 0.4 }
    default:
      return { rate: 0.3, color: teal, peak: 0.45 }
  }
}

/** Corner k (0-5) of the flat-top hex centered at c — matches hexCorners */
function corner(c: { x: number; y: number }, k: number): { x: number; y: number } {
  const a = (k * Math.PI) / 3
  return { x: c.x + (HEX_SIZE - 2) * Math.cos(a), y: c.y + (HEX_SIZE - 2) * Math.sin(a) }
}

/** Random walk along 2-3 edges of a hex near the given world point */
function makePath(wx: number, wy: number, rng: () => number): { path: Mote['path']; length: number } {
  // Snap to a cell at or next to the point so emitter motes hug their tile
  const { q, r } = pixelToAxialRounded(
    wx + (rng() - 0.5) * HEX_SIZE * 2.2,
    wy + (rng() - 0.5) * HEX_SIZE * 2.2
  )
  const center = axialToPixel(q, r)
  const start = Math.floor(rng() * 6)
  const dir = rng() < 0.5 ? 1 : -1
  const edges = 2 + Math.floor(rng() * 2) // 2-3 edges
  const path: Mote['path'] = []
  for (let i = 0; i <= edges; i++) {
    path.push(corner(center, ((start + i * dir) % 6 + 6) % 6))
  }
  let length = 0
  for (let i = 1; i < path.length; i++) {
    length += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y)
  }
  return { path, length }
}

/** Position at distance d along the polyline */
function pointAt(m: Mote, d: number): { x: number; y: number } {
  let rest = d
  for (let i = 1; i < m.path.length; i++) {
    const a = m.path[i - 1]
    const b = m.path[i]
    const seg = Math.hypot(b.x - a.x, b.y - a.y)
    if (rest <= seg) {
      const t = seg === 0 ? 0 : rest / seg
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
    }
    rest -= seg
  }
  return m.path[m.path.length - 1]
}

export const FleetAmbienceLayer = memo(function FleetAmbienceLayer({
  emitters
}: {
  emitters: AmbienceEmitter[]
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const emittersRef = useRef(emitters)
  emittersRef.current = emitters
  const { getViewport } = useReactFlow()

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const resize = () => {
      const rect = canvas.parentElement?.getBoundingClientRect()
      if (!rect) return
      canvas.width = Math.round(rect.width * dpr)
      canvas.height = Math.round(rect.height * dpr)
    }
    resize()
    const ro = new ResizeObserver(resize)
    if (canvas.parentElement) ro.observe(canvas.parentElement)

    const motes: Mote[] = []
    // Fractional spawn accumulators — rates are well under one mote per frame
    const debt = new Map<string, number>()
    let ambientDebt = 0
    const rng = Math.random
    let raf = 0
    let last = performance.now()
    let acc = 0

    const spawn = (wx: number, wy: number, color: string, peak: number) => {
      if (motes.length >= MAX_MOTES) return
      const { path, length } = makePath(wx, wy, rng)
      motes.push({
        path,
        length,
        bornAt: performance.now(),
        lifeMs: 1000 + rng() * 1200,
        color,
        peak
      })
    }

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      const dt = now - last
      last = now
      // Ambience runs at ~30fps — skip alternate frames, keep dt honest
      acc += dt
      if (acc < FRAME_MS) return
      const step = acc / 1000
      acc = 0
      if (document.hidden) return

      const vp = getViewport()
      const W = canvas.width
      const H = canvas.height
      ctx.clearRect(0, 0, W, H)

      const es = emittersRef.current
      const pending = useMeshGraphStore.getState().pendingInteractions

      // Spawn: per-agent by state, plus a garden baseline over the fleet bbox
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
      for (const e of es) {
        minX = Math.min(minX, e.x); maxX = Math.max(maxX, e.x)
        minY = Math.min(minY, e.y); maxY = Math.max(maxY, e.y)
      }
      for (const e of es) {
        const spec = rateFor(e, !!pending[e.filePath])
        if (!spec) continue
        const d = (debt.get(e.filePath) ?? 0) + spec.rate * step
        const n = Math.floor(d)
        debt.set(e.filePath, d - n)
        for (let i = 0; i < n; i++) spawn(e.x, e.y, spec.color, spec.peak)
      }
      if (es.length > 0 && Number.isFinite(minX)) {
        const dark = document.documentElement.classList.contains('dark')
        ambientDebt += AMBIENT_RATE * step
        const n = Math.floor(ambientDebt)
        ambientDebt -= n
        const padX = HEX_SIZE * 6
        const padY = HEX_SIZE * 6
        for (let i = 0; i < n; i++) {
          spawn(
            minX - padX + rng() * (maxX - minX + padX * 2),
            minY - padY + rng() * (maxY - minY + padY * 2),
            dark ? TEAL_DARK : TEAL_LIGHT,
            0.3
          )
        }
      }

      // Draw + reap. Screen = world * zoom + pan (canvas pixels = css * dpr)
      const z = vp.zoom * dpr
      const tx = vp.x * dpr
      const ty = vp.y * dpr
      ctx.lineCap = 'round'
      for (let i = motes.length - 1; i >= 0; i--) {
        const m = motes[i]
        const age = now - m.bornAt
        if (age >= m.lifeMs) {
          motes[i] = motes[motes.length - 1]
          motes.pop()
          continue
        }
        const t = age / m.lifeMs
        // Fade in fast, out slow — the classic firefly envelope
        const alpha = m.peak * (t < 0.25 ? t / 0.25 : 1 - (t - 0.25) / 0.75)
        const head = pointAt(m, m.length * t)
        const hx = head.x * z + tx
        const hy = head.y * z + ty
        if (hx < -40 || hy < -40 || hx > W + 40 || hy > H + 40) continue
        // Short trailing streak behind the head — "shooting" along the edge
        const tail = pointAt(m, Math.max(0, m.length * t - HEX_SIZE * 0.3))
        // Floors keep motes visible from orbit — at far zoom the swarm is
        // the whole point (density = fleet health at a glance)
        ctx.strokeStyle = `rgba(${m.color}, ${alpha * 0.5})`
        ctx.lineWidth = Math.max(1.2, 1.1 * z)
        ctx.beginPath()
        ctx.moveTo(tail.x * z + tx, tail.y * z + ty)
        ctx.lineTo(hx, hy)
        ctx.stroke()
        // Glowing head: soft halo + bright core
        ctx.fillStyle = `rgba(${m.color}, ${alpha * 0.25})`
        ctx.beginPath()
        ctx.arc(hx, hy, Math.max(3.5, 4.5 * z), 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = `rgba(${m.color}, ${alpha})`
        ctx.beginPath()
        ctx.arc(hx, hy, Math.max(1.6, 1.8 * z), 0, Math.PI * 2)
        ctx.fill()
      }
    }
    raf = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [getViewport])

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 w-full h-full pointer-events-none"
      style={{ zIndex: 4 }}
    />
  )
})
