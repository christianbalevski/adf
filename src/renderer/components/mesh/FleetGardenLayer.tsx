import { memo, useEffect, useRef } from 'react'
import { useStoreApi } from '@xyflow/react'
import { HEX_SIZE, HEX_COL_W, HEX_ROW_H } from './fleet-layout'
import { attachAnchoredCanvas } from './HexBackground'

/**
 * Garden undergrowth — organic, non-repeating variation across the whole
 * lattice: mossy teal patches that pool and thin like real growth, with dew
 * specks and tiny circuit-leaf sprigs scattered through the denser beds.
 *
 * Everything derives from deterministic value noise over ABSOLUTE cell
 * coordinates — generated once in the mathematical sense: the same world
 * position always grows the same garden, across pans, sessions, and
 * machines, with no repeat period (the earlier SVG-pattern supertile read
 * as wallpaper).
 *
 * Canvas sits UNDER the React Flow pane (DOM order, no z-index) so land
 * territories, traces, and labels all paint over it. The noise field is
 * rendered once per anchor (viewport + margin) and panned/zoomed by CSS
 * transform — pan frames do zero drawing (the old version re-noised every
 * visible cell per frame). Redraws happen only on zoom-bucket crossings,
 * the detail-LOD threshold, margin escape, theme flips, resize, and a
 * settle pass ~150ms after the viewport rests (determinism makes every
 * redraw seamless).
 */

const fract = (x: number): number => x - Math.floor(x)
/** Deterministic 2D hash in [0,1) — fixed seed, same garden every session */
const h2 = (x: number, y: number): number => fract(Math.sin(x * 127.1 + y * 311.7) * 43758.5453)
const smooth = (t: number): number => t * t * (3 - 2 * t)

/** Bilinear value noise in [0,1) */
function vnoise(x: number, y: number): number {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const xf = smooth(x - xi)
  const yf = smooth(y - yi)
  const a = h2(xi, yi)
  const b = h2(xi + 1, yi)
  const c = h2(xi, yi + 1)
  const d = h2(xi + 1, yi + 1)
  return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf
}

/** Two-octave fbm — broad beds with finer ragged edges */
const growth = (q: number, r: number): number =>
  0.62 * vnoise(q * 0.3, r * 0.3) + 0.38 * vnoise(q * 0.73 + 13.7, r * 0.73 + 7.3)

/** Species blend — where the violet undergrowth takes over from the teal */
const species = (q: number, r: number): number => vnoise(q * 0.16 + 41.2, r * 0.16 + 87.9)

/** Dew + sprigs only where they resolve */
const DETAIL_ZOOM = 0.32

export const FleetGardenLayer = memo(function FleetGardenLayer() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const store = useStoreApi()

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    return attachAnchoredCanvas({
      canvas,
      store,
      // The noise field is infinite, so there is no whole-world raster to
      // cache — render viewport + margin and re-anchor on demand instead.
      // The budget caps the margin (resolution only yields at extreme
      // viewport sizes), so memory stays bounded and a redraw costs one
      // frame's worth of the old per-frame loop.
      maxBackingPx: 16_000_000, // ≈64MB RGBA
      maxPad: 0.5,
      // Crossing the detail threshold must redraw even inside a zoom bucket
      zoomInvalidates: (zoom, anchorZoom) => zoom > DETAIL_ZOOM !== anchorZoom > DETAIL_ZOOM,
      draw: (ctx, v) => {
        const { tx, ty, zoom, W, H, padW, padH, dpr, dark } = v
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.clearRect(0, 0, canvas.width, canvas.height)
        // Draw in world coordinates — the transform does all screen math
        ctx.setTransform(zoom * dpr, 0, 0, zoom * dpr, (tx + padW) * dpr, (ty + padH) * dpr)

        // Rendered cell range (axial: x = q·COL_W, y = (r + q/2)·ROW_H),
        // covering the margin so pans inside it never need a draw
        const wx0 = (-padW - tx) / zoom - HEX_SIZE
        const wx1 = (W + padW - tx) / zoom + HEX_SIZE
        const wy0 = (-padH - ty) / zoom - HEX_SIZE
        const wy1 = (H + padH - ty) / zoom + HEX_SIZE
        const q0 = Math.floor(wx0 / HEX_COL_W)
        const q1 = Math.ceil(wx1 / HEX_COL_W)

        const teal = dark ? '45, 212, 191' : '13, 148, 136'
        const violet = dark ? '167, 139, 250' : '139, 92, 246'
        const detail = zoom > DETAIL_ZOOM

        for (let q = q0; q <= q1; q++) {
          const r0 = Math.floor(wy0 / HEX_ROW_H - q / 2)
          const r1 = Math.ceil(wy1 / HEX_ROW_H - q / 2)
          for (let r = r0; r <= r1; r++) {
            const n = growth(q, r)
            if (n <= 0.58) continue
            const cx = q * HEX_COL_W
            const cy = (r + q / 2) * HEX_ROW_H
            const color = species(q, r) > 0.72 ? violet : teal
            // Moss bed — deeper growth, deeper tint (gently capped)
            const a = Math.min(0.09, (n - 0.58) * 0.45) * (dark ? 1 : 0.8)
            ctx.fillStyle = `rgba(${color}, ${a})`
            ctx.beginPath()
            for (let k = 0; k < 6; k++) {
              const ang = (k * Math.PI) / 3
              const px = cx + (HEX_SIZE - 2) * Math.cos(ang)
              const py = cy + (HEX_SIZE - 2) * Math.sin(ang)
              if (k === 0) ctx.moveTo(px, py)
              else ctx.lineTo(px, py)
            }
            ctx.closePath()
            ctx.fill()

            if (!detail) continue
            const k = h2(q * 3.1, r * 5.7)
            // Dew — tiny bright bead on a corner of the denser beds
            if (k > 0.9 && n > 0.66) {
              const ck = Math.floor(k * 100) % 6
              const ang = (ck * Math.PI) / 3
              ctx.fillStyle = `rgba(${color}, ${dark ? 0.28 : 0.22})`
              ctx.beginPath()
              ctx.arc(cx + HEX_SIZE * 0.72 * Math.cos(ang), cy + HEX_SIZE * 0.72 * Math.sin(ang), 4, 0, Math.PI * 2)
              ctx.fill()
            }
            // Sprig — stem + two leaf dashes + node dot, leaning into the bed
            if (k > 0.82 && k <= 0.86 && n > 0.62) {
              const ck = Math.floor(k * 1000) % 6
              const rootA = (ck * Math.PI) / 3
              const px0 = cx + HEX_SIZE * 0.62 * Math.cos(rootA)
              const py0 = cy + HEX_SIZE * 0.62 * Math.sin(rootA)
              const a2 = rootA + Math.PI
              const ux = Math.cos(a2)
              const uy = Math.sin(a2)
              const vx = -uy
              const vy = ux
              const L = HEX_SIZE * 0.22
              ctx.strokeStyle = `rgba(${color}, ${dark ? 0.18 : 0.15})`
              ctx.fillStyle = ctx.strokeStyle
              ctx.lineWidth = 2
              ctx.lineCap = 'round'
              ctx.beginPath()
              ctx.moveTo(px0, py0)
              ctx.lineTo(px0 + ux * L, py0 + uy * L)
              ctx.moveTo(px0 + ux * L * 0.45, py0 + uy * L * 0.45)
              ctx.lineTo(px0 + ux * L * 0.45 + (vx * 0.5 + ux * 0.4) * L * 0.5, py0 + uy * L * 0.45 + (vy * 0.5 + uy * 0.4) * L * 0.5)
              ctx.moveTo(px0 + ux * L * 0.7, py0 + uy * L * 0.7)
              ctx.lineTo(px0 + ux * L * 0.7 + (-vx * 0.5 + ux * 0.4) * L * 0.5, py0 + uy * L * 0.7 + (-vy * 0.5 + uy * 0.4) * L * 0.5)
              ctx.stroke()
              ctx.beginPath()
              ctx.arc(px0 + ux * L, py0 + uy * L, 2.5, 0, Math.PI * 2)
              ctx.fill()
            }
          }
        }
      }
    })
  }, [store])

  // Same slot as HexBackground (behind all nodes), one layer above it so
  // growth tints sit on top of the lattice fills
  return (
    <canvas
      ref={canvasRef}
      className="absolute pointer-events-none"
      style={{ zIndex: -9, transformOrigin: '0 0', willChange: 'transform' }}
    />
  )
})
