import { memo, useMemo } from 'react'
import { BaseEdge, useInternalNode, useStore } from '@xyflow/react'
import type { EdgeProps, InternalNode } from '@xyflow/react'
import { useMeshGraphStore, ANIMATION_DURATION_MS, type EdgeHeatEntry } from '../../stores/mesh-graph.store'
import { useFleetStore } from '../../stores/fleet.store'
import { HEX_COL_W, HEX_ROW_H, HEX_SIZE, axialToPixel } from './fleet-layout'

export interface MeshEdgeData {
  edgeType: 'channel' | 'message' | 'lineage'
  channel?: string
}

/**
 * Circuit-trace geometry: instead of free-angle bezier curves between node
 * centers, each edge is routed along the hex lattice — a diagonal leg along
 * the axial (1,0) direction (±30° in pixel space) followed by a vertical leg
 * along (0,1), with one rounded bend. The diagonal leg always comes first so
 * edges sharing a corridor overlap into visible trunks. Edges render beneath
 * the node tiles, so traces passing under territory are fine.
 */
export function nodeCenter(node: InternalNode): { x: number; y: number } {
  const w = node.measured?.width ?? node.initialWidth ?? 260
  const h = node.measured?.height ?? node.initialHeight ?? 120
  const { x, y } = node.internals.positionAbsolute
  return { x: x + w / 2, y: y + h / 2 }
}

type Pt = { x: number; y: number }

/** Nearest axial hex cell for a pixel point (inverse of axialToPixel) */
function pixelToAxial(p: Pt): { q: number; r: number } {
  const q = Math.round(p.x / HEX_COL_W)
  const r = Math.round(p.y / HEX_ROW_H - q / 2)
  return { q, r }
}

/** Rounded-corner radius at the trace bend — generous on long legs so the
 *  diagonal-to-vertical transition reads as a deliberate sweep, tighter on
 *  short escape stubs so they stay crisp instead of dissolving into a hook. */
const BEND_RADIUS = 64

/**
 * Traces plug into the hex border, not the center — like a trace meeting a
 * component pad. Lattice directions always cross the shared edge at its
 * midpoint, which sits one inradius from the center.
 */
const PAD_INSET = (HEX_SIZE - 2) * (Math.sqrt(3) / 2)

function unitVec(dx: number, dy: number): Pt | null {
  const len = Math.hypot(dx, dy)
  if (len < 1) return null
  return { x: dx / len, y: dy / len }
}

export interface TraceGeometry {
  s: Pt
  t: Pt
  bend: Pt | null
  outDir: Pt | null
  inDir: Pt | null
}

/**
 * Route between two node centers along the hex lattice — the single source
 * of truth for trace geometry, shared by this edge component (SVG path) and
 * FleetAmbienceLayer (canvas message pulses must ride the exact same wire).
 * Snap each center to its nearest axial cell, walk dq steps along (1,0) —
 * the ±30° diagonal — then dr steps along (0,1) — vertical; both ends
 * trimmed back to the hex border pad.
 */
export function traceRoute(sc: Pt, tc: Pt): TraceGeometry {
  const sa = pixelToAxial(sc)
  const ta = pixelToAxial(tc)
  const dq = ta.q - sa.q
  const dr = ta.r - sa.r
  // Bend choice uses all THREE lattice axes. Same-sign dq/dr: the +q
  // diagonal then vertical (bend at target q, source r). Opposite signs:
  // that pairing forces a huge overshoot-and-hairpin (down-right for the
  // full dq, then all the way back up), so ride the third axis (1,-1) —
  // the up-right diagonal — for min(|dq|,|dr|) steps and finish along
  // whichever axis has remainder. Every bend is then a gentle 60° turn
  // and the route hugs the direct line. Still a pure function of the
  // endpoint cells, so shared corridors keep stacking into trunks.
  let bend: Pt | null = null
  if (dq !== 0 && dr !== 0) {
    if (Math.sign(dq) !== Math.sign(dr)) {
      const diag = Math.min(Math.abs(dq), Math.abs(dr)) * Math.sign(dq)
      bend = axialToPixel(sa.q + diag, sa.r - diag)
    } else {
      bend = axialToPixel(ta.q, sa.r)
    }
  }
  // Trim both ends back to the hex border — the trace originates and
  // terminates at a pad on the tile edge, never under the icon.
  const outDir = unitVec((bend ?? tc).x - sc.x, (bend ?? tc).y - sc.y)
  const inDir = unitVec(tc.x - (bend ?? sc).x, tc.y - (bend ?? sc).y)
  if (!outDir || !inDir) return { s: sc, t: tc, bend, outDir: null, inDir: null }
  const s = { x: sc.x + outDir.x * PAD_INSET, y: sc.y + outDir.y * PAD_INSET }
  const t = { x: tc.x - inDir.x * PAD_INSET, y: tc.y - inDir.y * PAD_INSET }
  return { s, t, bend, outDir, inDir }
}

/** Corner flattening resolution for canvas pulses — visually indistinguishable
 *  from the true quadratic at pulse-dot sizes. */
const CORNER_SEGMENTS = 8

/**
 * Flatten a trace (two legs + rounded quadratic corner, exactly mirroring
 * tracePath) into a polyline with cumulative arc lengths, so the ambience
 * canvas can place a pulse dot at any fraction of the wire — the canvas
 * equivalent of CSS offset-distance along the SVG path.
 */
export function traceSamples(g: TraceGeometry): { pts: Pt[]; cum: number[]; total: number } {
  const pts: Pt[] = [g.s]
  if (g.bend) {
    const d1x = g.bend.x - g.s.x
    const d1y = g.bend.y - g.s.y
    const d2x = g.t.x - g.bend.x
    const d2y = g.t.y - g.bend.y
    const l1 = Math.hypot(d1x, d1y)
    const l2 = Math.hypot(d2x, d2y)
    if (l1 >= 1 && l2 >= 1) {
      const r = Math.min(BEND_RADIUS, l1 / 2.5, l2 / 2.5)
      const ax = g.bend.x - (d1x / l1) * r
      const ay = g.bend.y - (d1y / l1) * r
      const bx = g.bend.x + (d2x / l2) * r
      const by = g.bend.y + (d2y / l2) * r
      pts.push({ x: ax, y: ay })
      for (let i = 1; i < CORNER_SEGMENTS; i++) {
        const u = i / CORNER_SEGMENTS
        const w0 = (1 - u) * (1 - u)
        const w1 = 2 * (1 - u) * u
        const w2 = u * u
        pts.push({
          x: w0 * ax + w1 * g.bend.x + w2 * bx,
          y: w0 * ay + w1 * g.bend.y + w2 * by
        })
      }
      pts.push({ x: bx, y: by })
    }
  }
  pts.push(g.t)
  const cum: number[] = [0]
  let total = 0
  for (let i = 1; i < pts.length; i++) {
    total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
    cum.push(total)
  }
  return { pts, cum, total }
}

/**
 * Two-leg polyline with a rounded bend: p1 → bend → p3, quadratic corner.
 * Pass bend = null for a straight lattice-aligned run.
 */
function tracePath(p1: Pt, bend: Pt | null, p3: Pt): string {
  if (!bend) return `M ${p1.x} ${p1.y} L ${p3.x} ${p3.y}`
  const d1x = bend.x - p1.x
  const d1y = bend.y - p1.y
  const d2x = p3.x - bend.x
  const d2y = p3.y - bend.y
  const l1 = Math.hypot(d1x, d1y)
  const l2 = Math.hypot(d2x, d2y)
  if (l1 < 1 || l2 < 1) return `M ${p1.x} ${p1.y} L ${p3.x} ${p3.y}`
  const r = Math.min(BEND_RADIUS, l1 / 2.5, l2 / 2.5)
  const ax = bend.x - (d1x / l1) * r
  const ay = bend.y - (d1y / l1) * r
  const bx = bend.x + (d2x / l2) * r
  const by = bend.y + (d2y / l2) * r
  return `M ${p1.x} ${p1.y} L ${ax} ${ay} Q ${bend.x} ${bend.y} ${bx} ${by} L ${p3.x} ${p3.y}`
}

/**
 * Heat accumulation window — 4 hours, long enough for message topology to
 * build up into a visible backbone rather than evaporating between bursts.
 */
const HEAT_WINDOW_MS = 4 * 60 * 60 * 1000
const HEAT_BASE_STROKE = '#52525b'
const HEAT_HOT_STROKE = '#7c3aed'

/** Weight threshold below which an edge is culled at far zoom */
const FAR_CULL_WEIGHT = 0.22

/** Linear interpolation between two hex colors (per RGB channel) */
function lerpHex(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16)
  const pb = parseInt(b.slice(1), 16)
  const mix = (shift: number) => {
    const ca = (pa >> shift) & 0xff
    const cb = (pb >> shift) & 0xff
    return Math.round(ca + (cb - ca) * t)
  }
  return `#${((mix(16) << 16) | (mix(8) << 8) | mix(0)).toString(16).padStart(6, '0')}`
}

/**
 * Edge weight 0–1: log-scaled message volume, floored at 30% so accumulated
 * traffic never fully vanishes inside the window, scaled by linear recency.
 */
function weightOf(entry: EdgeHeatEntry | null, now: number): number {
  if (!entry) return 0
  const recency = Math.min(1, Math.max(0, 1 - (now - entry.lastAt) / HEAT_WINDOW_MS))
  const volume = Math.min(1, Math.log2(1 + entry.count) / 5)
  return volume * (0.3 + 0.7 * recency)
}

export const MeshGraphEdge = memo(function MeshGraphEdge(props: EdgeProps) {
  const { id, source, target, sourceX, sourceY, targetX, targetY, data, style } = props
  const edgeData = data as unknown as MeshEdgeData | undefined
  const isChannel = edgeData?.edgeType === 'channel'
  const isMessage = edgeData?.edgeType === 'message'

  const sourceNode = useInternalNode(source)
  const targetNode = useInternalNode(target)

  // Route along the hex lattice: snap each node center to its nearest axial
  // cell, walk dq steps along (1,0) — the ±30° diagonal — then dr steps along
  // (0,1) — vertical. Diagonal leg always first, so the route between any two
  // cells is deterministic and shared corridors stack into trunks.
  const geometry = useMemo(() => {
    // No fallback to React Flow handle coords: when either node isn't
    // resolvable (stale route, node not mounted yet) those coords are
    // garbage and draw arbitrary-angle lines across the map. Render nothing.
    if (!sourceNode || !targetNode) return null
    return traceRoute(nodeCenter(sourceNode), nodeCenter(targetNode))
  }, [sourceNode, targetNode, sourceX, sourceY, targetX, targetY])

  const edgePath = useMemo(
    () => (geometry ? tracePath(geometry.s, geometry.bend, geometry.t) : ''),
    [geometry]
  )

  // O(1) index lookup instead of linear scan
  const fwdAnim = useMeshGraphStore((s) => s.activeAnimationIndex[`${source}|${target}`] ?? null)
  const revAnim = useMeshGraphStore((s) => s.activeAnimationIndex[`${target}|${source}`] ?? null)
  const activeAnim = useMemo(() => {
    if (fwdAnim) return { ...fwdAnim, reversed: false }
    if (revAnim) return { ...revAnim, reversed: true }
    return null
  }, [fwdAnim, revAnim])

  // Only compute reversed path when animation needs it — same polyline
  // walked target → bend → source so pulses travel with the message
  const reversedPath = useMemo(() => {
    if (!activeAnim?.reversed || !geometry) return null
    return tracePath(geometry.t, geometry.bend, geometry.s)
  }, [activeAnim?.reversed, geometry])

  // Message-frequency weight — heavier of both directions, decays purely by
  // timestamp at render time (no re-render timer; renders are frequent
  // enough via poll/animation churn). Never affects position.
  const fwdHeat = useMeshGraphStore((s) => (isMessage ? s.edgeHeat[`${source}|${target}`] ?? null : null))
  const revHeat = useMeshGraphStore((s) => (isMessage ? s.edgeHeat[`${target}|${source}`] ?? null : null))
  const now = Date.now()
  const fwdWeight = weightOf(fwdHeat, now)
  const revWeight = weightOf(revHeat, now)
  const weight = Math.max(fwdWeight, revWeight)

  // At territory-overview zoom, light edges are noise and get culled almost
  // entirely — but heavy trunks keep strong opacity so the communication
  // backbone stays legible from orbit.
  const farView = useStore((s) => s.transform[2] < 0.4)

  // Selecting an agent lights up its whole communication web — traces
  // touching the selection get the accent and survive far-zoom culling.
  // Clicking a base station does the same for everything plugged into it,
  // including the dashed channel links (configured but quiet connections),
  // so "who uses telegram?" is one click.
  const touchesSelection = useFleetStore(
    (s) => isMessage && (s.selection.includes(source) || s.selection.includes(target))
  )
  const touchesStation = useFleetStore(
    (s) => s.selectedStation != null && (s.selectedStation === source || s.selectedStation === target)
  )

  const isLineage = edgeData?.edgeType === 'lineage'
  const edgeStyle = isLineage
    ? { ...style, stroke: '#a8a29e', strokeWidth: 1.5, strokeDasharray: '6 3', opacity: farView ? 0.12 : 0.5 }
    : isChannel
      ? touchesStation
        ? { ...style, stroke: HEAT_HOT_STROKE, strokeWidth: 2, strokeDasharray: '4 4', opacity: 0.9 }
        : { ...style, stroke: '#94a3b8', strokeWidth: 1, strokeDasharray: '4 4', opacity: farView ? 0.1 : 0.4 }
      : touchesSelection || touchesStation
        ? {
            ...style,
            stroke: HEAT_HOT_STROKE,
            strokeWidth: (2.5 + 6 * weight) * (farView ? 1.8 : 1),
            strokeLinecap: 'round' as const,
            opacity: 0.9
          }
        : {
            ...style,
            stroke: weight > 0 ? lerpHex(HEAT_BASE_STROKE, HEAT_HOT_STROKE, weight) : HEAT_BASE_STROKE,
            strokeWidth: (1.5 + 6 * weight) * (farView ? 1.8 : 1),
            strokeLinecap: 'round' as const,
            // Opacity tracks weight at every zoom — decayed traces stay
            // faint, but live topology reads clearly even from orbit
            opacity: farView
              ? weight < FAR_CULL_WEIGHT ? 0.08 : 0.6 + 0.35 * weight
              : 0.3 + 0.65 * weight
          }

  const animatedStyle = activeAnim
    ? { ...edgeStyle, stroke: '#8b5cf6', strokeWidth: Math.max(2.5, 1.5 + 6 * weight), opacity: 1 }
    : edgeStyle

  // Pick the path matching the message direction
  const motionPath = activeAnim?.reversed ? reversedPath : edgePath

  // Direction markers on the shared (undirected) trace: an arrowhead at each
  // end that RECEIVES traffic, a solder pad at an end that only sends. Sized
  // and colored with the trunk. Message edges only.
  const markers = useMemo(() => {
    if (!isMessage || !geometry?.outDir || !geometry?.inDir) return null
    const { s, t, outDir, inDir } = geometry
    const len = 9 + 9 * weight
    const half = 4.5 + 4.5 * weight
    const arrowAt = (tip: { x: number; y: number }, dir: { x: number; y: number }): string => {
      const bx = tip.x - dir.x * len
      const by = tip.y - dir.y * len
      const px = -dir.y
      const py = dir.x
      return `${tip.x},${tip.y} ${bx + px * half},${by + py * half} ${bx - px * half},${by - py * half}`
    }
    const arrows: string[] = []
    // source→target traffic (or a fresh edge with no heat yet): arrow at target
    if (fwdWeight > 0 || revWeight === 0) arrows.push(arrowAt(t, inDir))
    // target→source traffic: arrow at source, pointing back out of the trace
    if (revWeight > 0) arrows.push(arrowAt(s, { x: -outDir.x, y: -outDir.y }))
    return {
      // Pad only where nothing arrives — a pure origination point
      pad: revWeight > 0 ? null : { cx: s.x, cy: s.y, r: 3.5 + 3.5 * weight },
      arrows
    }
  }, [isMessage, geometry, weight, fwdWeight, revWeight])

  if (!geometry) return null

  return (
    <>
      <BaseEdge id={id} path={edgePath} style={animatedStyle} />
      {markers && (
        <g fill={animatedStyle.stroke as string} opacity={animatedStyle.opacity as number}>
          {markers.pad && <circle cx={markers.pad.cx} cy={markers.pad.cy} r={markers.pad.r} />}
          {markers.arrows.map((pts, i) => (
            <polygon key={i} points={pts} />
          ))}
        </g>
      )}
      {activeAnim && (
        // Energy flowing through the wire while a message is in flight — a
        // SINGLE animated dasharray path per active edge (CSS, not SMIL:
        // animateMotion's begin="0s" resolves against the SVG document
        // timeline, so a pulse inserted minutes after the map opened is
        // already "in the past" and never plays; CSS animations start when
        // the per-message keyed node mounts). The bright travelling packet
        // itself is drawn by FleetAmbienceLayer's canvas — the two per-
        // message offset-path circles were uncomposited and repainted the
        // whole layer every frame. Paused under .fleet-calm/.fleet-panning
        // via the .trace-flow rule in globals.css.
        <path
          key={activeAnim.id}
          className="trace-flow"
          d={motionPath!}
          fill="none"
          stroke="#a78bfa"
          strokeWidth={Math.max(3.5, 1.5 + 6 * weight)}
          strokeLinecap="round"
          strokeDasharray="16 26"
          style={{ animation: `traceFlow ${ANIMATION_DURATION_MS}ms linear forwards` }}
        />
      )}
    </>
  )
})
