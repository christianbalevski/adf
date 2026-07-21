import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useStoreApi } from '@xyflow/react'
import { useMeshStore } from '../../stores/mesh.store'
import { useMeshGraphStore } from '../../stores/mesh-graph.store'
import { useFleetStore } from '../../stores/fleet.store'
import { joinDir, type TerrainCell } from './fleet-layout'
import { hueFromPath, isDarkMode } from './FleetTerrainNode'
import type { FleetAgentStatus } from '../../../shared/types/ipc.types'

/**
 * Voices — the group-status layer, rendered above the whole canvas (like the
 * hover cards) rather than inside the React Flow world. That buys three
 * things the in-world chips couldn't do:
 *  - pixel-constant type: the font never warps with zoom, so a status is
 *    exactly as readable from orbit as up close (no growing truncation)
 *  - clean z-order: nothing from the node layer (start buttons, pips)
 *    pokes through
 *  - a semantic zoom hierarchy: far out only the ROOT dir speaks; closing
 *    in crossfades to the subdir voices; closer still everything yields to
 *    tile-level text. Territories without subdirs keep their voice longer.
 *
 * Rendering is split so pan/zoom never re-renders React: chips are derived in
 * WORLD coordinates from fleet events only and mounted once inside a single
 * transform-carrier div. Viewport changes arrive via a direct store
 * subscription that writes styles imperatively — a pan frame is one container
 * transform write; a zoom frame additionally rewrites each chip's
 * counter-scale (keeping type pixel-constant) and semantic-zoom alpha.
 */

export interface VoiceTerrain {
  dirPath: string
  /** Terrain node origin in world coords (cells are node-relative) */
  x: number
  y: number
  cells: TerrainCell[]
  districts: string[]
  memberPaths: string[]
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const fadeIn = (z: number, a: number, b: number) => clamp((z - a) / (b - a), 0, 1)
const fadeOut = (z: number, a: number, b: number) => clamp((b - z) / (b - a), 0, 1)

/** Crossfade band: root voices hand over to district voices as plots resolve */
const CROSS_A = 0.3
const CROSS_B = 0.44

const FONT = 13
const LINE_H = FONT * 1.35
/** Fixed chip width — pan/zoom must never re-flow a voice mid-read */
const CHIP_MAX_W = 340
const MAX_LINES = 3

/** Zoom-settle debounce before declutter re-runs (never per gesture frame) */
const SETTLE_MS = 220

interface ChipSpec {
  key: string
  dir: string
  hue: number
  /** World-space anchor (plot centroid) */
  wx: number
  wy: number
  /** World-space plot width */
  span: number
  voice: FleetAgentStatus
  isSteward: boolean
  level: 'root' | 'district'
  hasDistricts: boolean
}

interface LaidOutChip extends ChipSpec {
  /** Estimated screen-px box (zoom-independent — type is pixel-constant) */
  w: number
  h: number
  /** Declutter push in screen px, applied inside the counter-scale */
  offY: number
}

/** Semantic-zoom opacity per level. Leaf voices (districts, and roots with
 *  no districts) stay up well past tile-text zoom — a sub-folder's status
 *  should survive the height you'd naturally inspect that sub-folder from. */
const alphaFor = (c: { level: 'root' | 'district'; hasDistricts: boolean }, zoom: number): number => {
  if (c.level === 'root') {
    const out = c.hasDistricts ? fadeOut(zoom, CROSS_A, CROSS_B) : fadeOut(zoom, 1.05, 1.35)
    return fadeIn(zoom, 0.05, 0.09) * out
  }
  return fadeIn(zoom, CROSS_A, CROSS_B) * fadeOut(zoom, 1.05, 1.35)
}

export const FleetVoicesLayer = memo(function FleetVoicesLayer({
  terrains
}: {
  terrains: VoiceTerrain[]
}) {
  const storeApi = useStoreApi()
  const agents = useMeshStore((s) => s.agents)
  const lastActivityAt = useMeshGraphStore((s) => s.lastActivityAt)
  const pendingInteractions = useMeshGraphStore((s) => s.pendingInteractions)
  const stewards = useFleetStore((s) => s.stewards)
  const lens = useFleetStore((s) => s.lens)
  const voicesOverride = useFleetStore((s) => s.voicesOverride)
  const dark = isDarkMode()
  const voicesOn = voicesOverride ?? lens === 'terrain'

  // Bumped (debounced) when a zoom gesture settles on a new level — the only
  // viewport-driven re-render this layer ever does
  const [layoutEpoch, setLayoutEpoch] = useState(0)

  const worldRef = useRef<HTMLDivElement | null>(null)
  const chipEls = useRef(new Map<string, HTMLDivElement>())
  const laidOutRef = useRef<LaidOutChip[]>([])
  const syncedZoomRef = useRef(NaN)
  const layoutZoomRef = useRef(NaN)
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // World-space chip anchors + voice selection — independent of the viewport
  const chips = useMemo<ChipSpec[]>(() => {
    const byPath = new Map(agents.map((a) => [a.filePath, a]))
    const byDid = new Map(agents.filter((a) => a.did).map((a) => [a.did!, a]))

    // An agent speaks ONCE, at the highest level it represents: a root
    // steward is excluded from its own district's pick (the district falls
    // to its next-best member, or goes silent if the steward was alone).
    const pickVoice = (
      paths: string[],
      stewardDid?: string,
      exclude?: string
    ): { voice?: FleetAgentStatus; isSteward: boolean } => {
      const steward = stewardDid ? byDid.get(stewardDid) : undefined
      if (steward && steward.filePath !== exclude) return { voice: steward, isSteward: true }
      let voice: FleetAgentStatus | undefined
      let bestAt = -1
      for (const p of paths) {
        if (p === exclude) continue
        const a = byPath.get(p)
        if (!a) continue
        const last = lastActivityAt[p] ?? 0
        const score = a.state === 'active' ? last + 1e15 : last
        if (score > bestAt) {
          bestAt = score
          voice = a
        }
      }
      return { voice, isSteward: false }
    }

    const out: ChipSpec[] = []
    for (const t of terrains) {
      const hue = hueFromPath(t.dirPath)
      const occupied = t.cells.filter((c) => c.filePath)
      if (occupied.length === 0) continue

      const anchorOf = (cells: TerrainCell[]) => {
        const cx = cells.reduce((s, c) => s + c.x, 0) / cells.length
        const cy = cells.reduce((s, c) => s + c.y, 0) / cells.length
        const span =
          Math.max(...cells.map((c) => c.x)) - Math.min(...cells.map((c) => c.x)) + 400
        return { wx: t.x + cx, wy: t.y + cy, span }
      }

      // Root voice speaks for the whole territory, anchored on the capital
      const capital = occupied.filter((c) => c.district === '')
      const { voice, isSteward } = pickVoice(t.memberPaths, stewards[t.dirPath])
      if (voice && (voice.status || voice.handle)) {
        out.push({
          key: `root:${t.dirPath}`,
          dir: t.dirPath,
          hue,
          ...anchorOf(capital.length > 0 ? capital : occupied),
          voice,
          isSteward,
          level: 'root',
          hasDistricts: t.districts.length > 0
        })
      }

      for (const district of t.districts) {
        const owned = occupied.filter((c) => c.district === district)
        if (owned.length === 0) continue
        const dir = joinDir(t.dirPath, district)
        const paths = owned.map((c) => c.filePath!).filter(Boolean)
        const dv = pickVoice(paths, stewards[dir], voice?.filePath)
        if (!dv.voice || (!dv.voice.status && !dv.voice.handle)) continue
        out.push({
          key: `district:${dir}`,
          dir,
          hue,
          ...anchorOf(owned),
          voice: dv.voice,
          isSteward: dv.isSteward,
          level: 'district',
          hasDistricts: false
        })
      }
    }
    return out
  }, [terrains, agents, lastActivityAt, stewards])

  // Box estimation + declutter (push lower chip down). Runs on chip-set
  // changes and on zoom settle (layoutEpoch), never per pan frame. All
  // pairwise terms are viewport-translation-free (offsets cancel in the
  // differences), so the result is pan-independent: world-anchored chips
  // can't jump while the camera moves.
  const laidOut = useMemo<LaidOutChip[]>(() => {
    const zoom = storeApi.getState().transform[2]
    layoutZoomRef.current = zoom
    const out: LaidOutChip[] = []
    for (const c of chips) {
      // The voice yields while its agent has an open approval/ask card —
      // chips float above the pane and would paint across the controls.
      if (pendingInteractions[c.voice.filePath]) continue
      const chars = c.voice.handle.length + (c.voice.status?.length ?? 0) + 3
      const lines = clamp(Math.ceil((chars * FONT * 0.52) / (CHIP_MAX_W - 20)), 1, MAX_LINES)
      const w = Math.min(CHIP_MAX_W, chars * FONT * 0.55 + 22)
      const h = lines * LINE_H + 12
      out.push({ ...c, w, h, offY: 0 })
    }
    out.sort((a, b) => a.wy - b.wy)
    const placed: { sx: number; sy: number; w: number; h: number }[] = []
    for (const c of out) {
      if (alphaFor(c, zoom) <= 0.02) continue
      const sx = c.wx * zoom
      let sy = c.wy * zoom
      for (const p of placed) {
        if (Math.abs(sx - p.sx) < ((c.w + p.w) / 2) * 0.9 && Math.abs(sy - p.sy) < (c.h + p.h) / 2) {
          sy = p.sy + (p.h + c.h) / 2 + 6
        }
      }
      placed.push({ sx, sy, w: c.w, h: c.h })
      c.offY = sy - c.wy * zoom
    }
    return out
    // layoutEpoch retriggers on zoom settle; zoom itself is read imperatively
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chips, pendingInteractions, layoutEpoch, storeApi])

  // Imperative viewport sync. Pan-only frames write ONE transform; zoom
  // frames also rewrite each chip's counter-scale + alpha (still no React).
  const applyViewport = useCallback(
    (force = false) => {
      const world = worldRef.current
      if (!world) return
      const [tx, ty, zoom] = storeApi.getState().transform
      world.style.transform = `translate(${tx}px, ${ty}px) scale(${zoom})`
      if (!force && zoom === syncedZoomRef.current) return
      syncedZoomRef.current = zoom
      world.style.visibility = zoom <= 0.05 ? 'hidden' : ''
      for (const c of laidOutRef.current) {
        const el = chipEls.current.get(c.key)
        if (!el) continue
        const alpha = alphaFor(c, zoom)
        // scale(1/zoom) cancels the carrier's scale (pixel-constant type);
        // the declutter push sits inside it so it stays in screen px
        el.style.transform = `translate(${c.wx}px, ${c.wy}px) scale(${1 / zoom}) translate(0px, ${c.offY}px) translate(-50%, -50%)`
        el.style.opacity = alpha.toFixed(3)
        // Faded chips stay MOUNTED and merely go invisible — the old
        // screen-cull unmounted them, which popped mid-pan
        el.style.visibility = alpha <= 0.02 ? 'hidden' : ''
        el.style.pointerEvents = alpha < 0.15 ? 'none' : 'auto'
      }
      if (zoom !== layoutZoomRef.current) {
        if (settleTimerRef.current) clearTimeout(settleTimerRef.current)
        settleTimerRef.current = setTimeout(() => {
          settleTimerRef.current = null
          if (storeApi.getState().transform[2] !== layoutZoomRef.current) setLayoutEpoch((e) => e + 1)
        }, SETTLE_MS)
      }
    },
    [storeApi]
  )

  // Restyle newly-committed chips before paint (they mount hidden)
  useLayoutEffect(() => {
    laidOutRef.current = laidOut
    applyViewport(true)
  }, [laidOut, voicesOn, applyViewport])

  useEffect(() => {
    const unsub = storeApi.subscribe((s, prev) => {
      if (s.transform !== prev.transform) applyViewport()
    })
    return () => {
      unsub()
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current)
    }
  }, [storeApi, applyViewport])

  if (!voicesOn) return null

  // Chips live above the React Flow pane but OUTSIDE its DOM tree, so wheel
  // gestures over a chip (two-finger pan, pinch = ctrl+wheel) never reach
  // the pane's zoom handler — re-dispatch them onto the pane so the map
  // keeps panning/zooming under the cursor.
  const forwardWheel = (e: React.WheelEvent) => {
    const pane = document.querySelector('.react-flow__pane')
    if (!pane) return
    pane.dispatchEvent(new WheelEvent('wheel', {
      deltaX: e.deltaX,
      deltaY: e.deltaY,
      deltaMode: e.deltaMode,
      clientX: e.clientX,
      clientY: e.clientY,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
      bubbles: true,
      cancelable: true
    }))
  }

  return (
    <div
      className="absolute inset-0 overflow-hidden pointer-events-none"
      style={{ zIndex: 5 }}
      onWheel={forwardWheel}
    >
      {/* The single transform carrier — panning moves ONLY this element */}
      <div
        ref={worldRef}
        className="absolute left-0 top-0"
        style={{ transformOrigin: '0 0', willChange: 'transform' }}
      >
        {laidOut.map((c) => (
          <div
            key={c.key}
            ref={(el) => {
              if (el) chipEls.current.set(c.key, el)
              else chipEls.current.delete(c.key)
            }}
            className="fleet-voice-chip absolute left-0 top-0 cursor-pointer"
            style={{
              // Absolutely-positioned shrink-to-fit is capped by the space
              // left of the viewport edge — a chip anchored near the edge
              // would squeeze narrower as you pan. max-content sizes to the
              // text alone; the edge clips it instead of re-flowing it.
              width: 'max-content',
              maxWidth: CHIP_MAX_W,
              // applyViewport reveals it pre-paint with the real alpha
              visibility: 'hidden',
              fontSize: FONT,
              lineHeight: 1.35,
              padding: '5px 10px',
              borderRadius: 12,
              background: dark ? 'rgba(15, 18, 22, 0.85)' : 'rgba(255, 255, 255, 0.9)',
              border: `1px solid hsla(${c.hue}, 30%, ${dark ? 55 : 45}%, 0.45)`,
              color: dark ? 'rgba(190,190,190,0.85)' : 'rgba(90,90,90,0.85)',
              boxShadow: dark ? '0 2px 10px rgba(0,0,0,0.35)' : '0 2px 10px rgba(0,0,0,0.08)'
            }}
            onClick={() => useFleetStore.getState().setReadoutDir(c.dir)}
            onMouseEnter={() => useFleetStore.getState().setHoverDir(c.dir)}
            onMouseLeave={() => useFleetStore.getState().setHoverDir(null)}
            onWheel={(e) => {
              // A long voice scrolls in place; only then keep the wheel from
              // doubling as a map pan (forwardWheel on the layer container)
              const body = e.currentTarget.querySelector('.fleet-voice-body')
              if (body && body.scrollHeight > body.clientHeight + 1) e.stopPropagation()
            }}
            title="Click for the full group readout"
          >
            <span
              className="fleet-voice-body"
              style={{ display: 'block', maxHeight: MAX_LINES * LINE_H, overflowY: 'auto' }}
            >
              <span style={{ fontWeight: 600, color: dark ? 'rgba(235,235,235,0.95)' : 'rgba(45,45,45,0.95)' }}>
                {c.isSteward ? '♛ ' : ''}{c.voice.handle}
              </span>
              {c.voice.status ? <span style={{ fontStyle: 'italic' }}> — {c.voice.status}</span> : null}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
})
