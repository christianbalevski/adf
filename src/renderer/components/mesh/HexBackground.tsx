import { memo, useEffect, useRef } from 'react'
import { useStoreApi } from '@xyflow/react'
import { HEX_SIZE, HEX_COL_W, HEX_ROW_H } from './fleet-layout'

/**
 * Global base terrain — the faint hex lattice covering the whole canvas
 * (the "ocean" every settlement sits in). The lattice is rasterized into a
 * canvas via a repeating tile and panned/zoomed with a CSS transform, so a
 * pan frame is a single compositor translate — no per-frame re-raster (the
 * old SVG pattern rewrote patternTransform every frame). Teal-tinged
 * strokes set the garden's key; the organic growth itself (moss beds, dew,
 * sprigs) lives in FleetGardenLayer — noise over absolute cells, so it
 * never repeats the way a pattern tile must. Two slow-breathing washes
 * (teal + violet) sit underneath in screen space like light through a
 * canopy — a pre-rasterized gradient div whose breathing animates opacity
 * only, so it composites instead of repainting.
 */

/* ── Anchored canvas driver (shared with FleetGardenLayer) ─────────────── */

/** Half-octave zoom buckets — CSS scaling between redraws never exceeds ~√2 */
const BUCKET_HI = Math.SQRT2
const BUCKET_LO = 1 / Math.SQRT2
const SETTLE_MS = 150
/** Margin never drops below this fraction before resolution starts yielding */
const MIN_PAD = 0.1

export interface AnchorView {
  tx: number
  ty: number
  zoom: number
  /** Viewport css size at draw time */
  W: number
  H: number
  /** Rendered margin per side, css px */
  padW: number
  padH: number
  /** Effective device-pixel ratio (may be reduced by the backing budget) */
  dpr: number
  dark: boolean
}

interface AnchoredStore {
  getState: () => { transform: [number, number, number] }
  subscribe: (listener: () => void) => () => void
}

/**
 * Drives a canvas that renders world-anchored content once per "anchor"
 * (viewport + margin, at the transform current at draw time) and then moves
 * it with pure CSS transforms. Panning costs one style write per frame —
 * zero drawing. The content is redrawn only when:
 *   - zoom leaves the half-octave bucket around the anchor (scaled content
 *     between redraws never looks worse than a mild blur),
 *   - `zoomInvalidates` reports a LOD change,
 *   - the visible world rect escapes the pre-rendered margin,
 *   - the theme flips, the element resizes, or
 *   - ~150ms after the viewport settles anywhere off-anchor, so the resting
 *     image is always drawn at the exact transform (pixel-parity at rest).
 * The backing store is budget-capped: the margin shrinks first, and only at
 * extreme viewport sizes does resolution yield — memory stays bounded no
 * matter the world or zoom.
 */
export function attachAnchoredCanvas(opts: {
  canvas: HTMLCanvasElement
  store: AnchoredStore
  /** Backing-store budget, device px (× 4 bytes RGBA) */
  maxBackingPx: number
  /** Margin as a fraction of the viewport per side, before the budget cap */
  maxPad: number
  draw: (ctx: CanvasRenderingContext2D, view: AnchorView) => void
  /** Extra redraw trigger for zoom-dependent content (e.g. detail LOD) */
  zoomInvalidates?: (zoom: number, anchorZoom: number) => boolean
}): () => void {
  const { canvas, store, maxBackingPx, maxPad, draw, zoomInvalidates } = opts
  const ctx = canvas.getContext('2d')
  if (!ctx) return () => {}

  let anchor: AnchorView | null = null
  let settle: ReturnType<typeof setTimeout> | undefined

  const isDark = () => document.documentElement.classList.contains('dark')

  const redraw = () => {
    const rect = canvas.parentElement?.getBoundingClientRect()
    if (!rect || rect.width < 1 || rect.height < 1) return
    const [tx, ty, zoom] = store.getState().transform
    const W = rect.width
    const H = rect.height
    let dpr = Math.min(2, window.devicePixelRatio || 1)
    // Fit the margin (then, as a last resort, resolution) to the budget
    const fit = Math.sqrt(maxBackingPx / (W * H * dpr * dpr))
    let pad: number
    if (fit >= 1 + 2 * maxPad) pad = maxPad
    else if (fit >= 1 + 2 * MIN_PAD) pad = (fit - 1) / 2
    else {
      pad = MIN_PAD
      dpr *= fit / (1 + 2 * MIN_PAD)
    }
    const padW = Math.round(W * pad)
    const padH = Math.round(H * pad)
    const bw = Math.round((W + 2 * padW) * dpr)
    const bh = Math.round((H + 2 * padH) * dpr)
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw
      canvas.height = bh
    }
    canvas.style.left = `${-padW}px`
    canvas.style.top = `${-padH}px`
    canvas.style.width = `${W + 2 * padW}px`
    canvas.style.height = `${H + 2 * padH}px`
    canvas.style.transform = 'translate3d(0px, 0px, 0)'
    anchor = { tx, ty, zoom, W, H, padW, padH, dpr, dark: isDark() }
    draw(ctx, anchor)
  }

  const onSettle = () => {
    settle = undefined
    const a = anchor
    if (!a) return
    const [tx, ty, zoom] = store.getState().transform
    // Re-render at the exact resting transform — CSS-scaled or subpixel-
    // resampled content is only ever transitional
    if (tx !== a.tx || ty !== a.ty || zoom !== a.zoom) redraw()
  }

  const onTransform = () => {
    const a = anchor
    if (!a) {
      redraw()
      return
    }
    const [tx, ty, zoom] = store.getState().transform
    if (tx === a.tx && ty === a.ty && zoom === a.zoom) return
    if (settle) clearTimeout(settle)
    settle = setTimeout(onSettle, SETTLE_MS)
    const k = zoom / a.zoom
    let stale =
      k < BUCKET_LO || k > BUCKET_HI || (zoomInvalidates?.(zoom, a.zoom) ?? false)
    if (!stale) {
      // Has the visible world rect escaped the pre-rendered margin?
      const vx0 = -tx / zoom
      const vx1 = (a.W - tx) / zoom
      const vy0 = -ty / zoom
      const vy1 = (a.H - ty) / zoom
      const cx0 = (-a.padW - a.tx) / a.zoom
      const cx1 = (a.W + a.padW - a.tx) / a.zoom
      const cy0 = (-a.padH - a.ty) / a.zoom
      const cy1 = (a.H + a.padH - a.ty) / a.zoom
      stale = vx0 < cx0 || vx1 > cx1 || vy0 < cy0 || vy1 > cy1
    }
    if (stale) {
      redraw()
      return
    }
    // Pure compositor move — world stays anchored under the new transform
    const dx = (1 - k) * a.padW + tx - k * a.tx
    const dy = (1 - k) * a.padH + ty - k * a.ty
    canvas.style.transform = `translate3d(${dx}px, ${dy}px, 0) scale(${k})`
  }

  redraw()
  const unsub = store.subscribe(onTransform)
  const ro = new ResizeObserver(redraw)
  if (canvas.parentElement) ro.observe(canvas.parentElement)
  const mo = new MutationObserver(() => {
    if (anchor && anchor.dark !== isDark()) redraw()
  })
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  return () => {
    if (settle) clearTimeout(settle)
    unsub()
    ro.disconnect()
    mo.disconnect()
  }
}

/* ── Hex lattice ───────────────────────────────────────────────────────── */

// One pattern tile = two columns of flat-top hexes (period 2 cols × 1 row)
const TILE_W = 2 * HEX_COL_W
const TILE_H = HEX_ROW_H

/** Flat-top hex path centered at (cx, cy) — same corners as hexCorners */
function traceHex(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number): void {
  for (let k = 0; k < 6; k++) {
    const a = (k * Math.PI) / 3
    const x = cx + size * Math.cos(a)
    const y = cy + size * Math.sin(a)
    if (k === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.closePath()
}

/** Atmosphere gradients — violet listed first so it paints on top, matching
 *  the old SVG draw order (teal ellipse first, violet second) */
const washBackground = (dark: boolean): string =>
  `radial-gradient(60% 50% at 82% 85%, ${
    dark ? 'rgba(167, 139, 250, 0.05)' : 'rgba(139, 92, 246, 0.035)'
  } 0%, rgba(167, 139, 250, 0) 100%), ` +
  `radial-gradient(55% 45% at 22% 18%, ${
    dark ? 'rgba(45, 212, 191, 0.07)' : 'rgba(20, 184, 166, 0.05)'
  } 0%, rgba(45, 212, 191, 0) 100%)`

export const HexBackground = memo(function HexBackground() {
  const washRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const store = useStoreApi()

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const tile = document.createElement('canvas')
    let pattern: CanvasPattern | null = null
    let patScaleX = 1
    let patScaleY = 1

    const renderTile = (zoom: number, dpr: number, dark: boolean, ctx: CanvasRenderingContext2D): void => {
      const stroke = dark ? 'rgba(94, 234, 212, 0.055)' : 'rgba(15, 118, 110, 0.07)'
      const fill = dark ? 'rgba(30, 41, 59, 0.22)' : 'rgba(245, 245, 244, 0.4)'
      const bw = Math.max(1, Math.round(TILE_W * zoom * dpr))
      const bh = Math.max(1, Math.round(TILE_H * zoom * dpr))
      tile.width = bw
      tile.height = bh
      const t = tile.getContext('2d')
      if (!t) return
      t.setTransform(bw / TILE_W, 0, 0, bh / TILE_H, 0, 0)
      t.lineWidth = 1.2
      t.strokeStyle = stroke
      t.fillStyle = fill
      // Same six hexes as the old SVG pattern: the two-column period pair
      // plus wrap-around copies so tile edges join seamlessly
      const cells: [number, number][] = [
        [0, 0],
        [HEX_COL_W, TILE_H / 2],
        [0, TILE_H],
        [HEX_COL_W, -TILE_H / 2],
        [TILE_W, 0],
        [TILE_W, TILE_H]
      ]
      for (const [cx, cy] of cells) {
        t.beginPath()
        traceHex(t, cx, cy, HEX_SIZE - 2)
        t.fill()
        t.stroke()
      }
      pattern = ctx.createPattern(tile, 'repeat')
      // The tile raster rounds to whole pixels; the pattern transform
      // restores the exact world period so lattice cells keep lining up
      // tile-for-tile with territories across the whole viewport
      patScaleX = (TILE_W * zoom * dpr) / bw
      patScaleY = (TILE_H * zoom * dpr) / bh
    }

    const detachCanvas = attachAnchoredCanvas({
      canvas,
      store,
      maxBackingPx: 12_000_000, // ≈48MB RGBA — pattern blits are cheap, margin can stay small
      maxPad: 0.25,
      draw: (ctx, v) => {
        renderTile(v.zoom, v.dpr, v.dark, ctx)
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.clearRect(0, 0, canvas.width, canvas.height)
        if (!pattern) return
        // Phase-lock the lattice: world origin sits at css (tx + pad)
        const m = new DOMMatrix()
          .translateSelf((v.tx + v.padW) * v.dpr, (v.ty + v.padH) * v.dpr)
          .scaleSelf(patScaleX, patScaleY)
        pattern.setTransform(m)
        ctx.fillStyle = pattern
        ctx.fillRect(0, 0, canvas.width, canvas.height)
      }
    })

    // Wash colors are theme-keyed; repaint the (static) gradient on flips
    const paintWash = () => {
      if (washRef.current) {
        washRef.current.style.background = washBackground(
          document.documentElement.classList.contains('dark')
        )
      }
    }
    paintWash()
    const mo = new MutationObserver(paintWash)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })

    return () => {
      detachCanvas()
      mo.disconnect()
    }
  }, [store])

  return (
    <>
      {/* Atmosphere — slow-breathing light washes, screen-space like a sky */}
      <div ref={washRef} className="hex-garden-wash absolute inset-0 pointer-events-none" style={{ zIndex: -10 }} />
      <canvas
        ref={canvasRef}
        className="absolute pointer-events-none"
        style={{ zIndex: -10, transformOrigin: '0 0', willChange: 'transform' }}
      />
    </>
  )
})
