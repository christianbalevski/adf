import { memo, useMemo } from 'react'
import { BaseEdge, useInternalNode, useStore } from '@xyflow/react'
import type { EdgeProps, InternalNode } from '@xyflow/react'
import { useMeshGraphStore, ANIMATION_DURATION_MS, type EdgeHeatEntry } from '../../stores/mesh-graph.store'
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
function nodeCenter(node: InternalNode): { x: number; y: number } {
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

/** Rounded-corner radius at the trace bend */
const BEND_RADIUS = 24

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
  const r = Math.min(BEND_RADIUS, l1 / 2, l2 / 2)
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
const HEAT_BASE_STROKE = '#6b7280'
const HEAT_HOT_STROKE = '#8b5cf6'

/** Weight threshold below which an edge is culled at far zoom */
const FAR_CULL_WEIGHT = 0.35

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
    const sc: Pt = sourceNode ? nodeCenter(sourceNode) : { x: sourceX, y: sourceY }
    const tc: Pt = targetNode ? nodeCenter(targetNode) : { x: targetX, y: targetY }
    const sa = pixelToAxial(sc)
    const ta = pixelToAxial(tc)
    const dq = ta.q - sa.q
    const dr = ta.r - sa.r
    // Bend sits where the diagonal leg ends: axial (target q, source r)
    const bend = dq !== 0 && dr !== 0 ? axialToPixel(ta.q, sa.r) : null
    // Trim both ends back to the hex border — the trace originates and
    // terminates at a pad on the tile edge, never under the icon.
    const outDir = unitVec((bend ?? tc).x - sc.x, (bend ?? tc).y - sc.y)
    const inDir = unitVec(tc.x - (bend ?? sc).x, tc.y - (bend ?? sc).y)
    if (!outDir || !inDir) return { s: sc, t: tc, bend, outDir: null, inDir: null }
    const s = { x: sc.x + outDir.x * PAD_INSET, y: sc.y + outDir.y * PAD_INSET }
    const t = { x: tc.x - inDir.x * PAD_INSET, y: tc.y - inDir.y * PAD_INSET }
    return { s, t, bend, outDir, inDir }
  }, [sourceNode, targetNode, sourceX, sourceY, targetX, targetY])

  const edgePath = useMemo(
    () => tracePath(geometry.s, geometry.bend, geometry.t),
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
    if (!activeAnim?.reversed) return null
    return tracePath(geometry.t, geometry.bend, geometry.s)
  }, [activeAnim?.reversed, geometry])

  // Message-frequency weight — heavier of both directions, decays purely by
  // timestamp at render time (no re-render timer; renders are frequent
  // enough via poll/animation churn). Never affects position.
  const fwdHeat = useMeshGraphStore((s) => (isMessage ? s.edgeHeat[`${source}|${target}`] ?? null : null))
  const revHeat = useMeshGraphStore((s) => (isMessage ? s.edgeHeat[`${target}|${source}`] ?? null : null))
  const now = Date.now()
  const weight = Math.max(weightOf(fwdHeat, now), weightOf(revHeat, now))

  // At territory-overview zoom, light edges are noise and get culled almost
  // entirely — but heavy trunks keep strong opacity so the communication
  // backbone stays legible from orbit.
  const farView = useStore((s) => s.transform[2] < 0.4)

  const isLineage = edgeData?.edgeType === 'lineage'
  const edgeStyle = isLineage
    ? { ...style, stroke: '#a8a29e', strokeWidth: 1.5, strokeDasharray: '6 3', opacity: farView ? 0.12 : 0.5 }
    : isChannel
      ? { ...style, stroke: '#94a3b8', strokeWidth: 1, strokeDasharray: '4 4', opacity: farView ? 0.1 : 0.4 }
      : {
          ...style,
          stroke: weight > 0 ? lerpHex(HEAT_BASE_STROKE, HEAT_HOT_STROKE, weight) : HEAT_BASE_STROKE,
          strokeWidth: 1.5 + 6 * weight,
          strokeLinecap: 'round' as const,
          opacity: farView
            ? weight < FAR_CULL_WEIGHT ? 0.04 : 0.45 + 0.4 * weight
            : 0.6 + 0.35 * weight
        }

  const animatedStyle = activeAnim
    ? { ...edgeStyle, stroke: '#8b5cf6', strokeWidth: Math.max(2.5, 1.5 + 6 * weight), opacity: 1 }
    : edgeStyle

  // Pick the path matching the message direction
  const motionPath = activeAnim?.reversed ? reversedPath : edgePath

  // Origination pad + termination arrowhead — the trace reads as directed
  // wiring: a solder pad where it leaves the source tile, an arrow where it
  // enters the target. Message edges only; sized and colored with the trunk.
  const markers = useMemo(() => {
    if (!isMessage || !geometry.outDir || !geometry.inDir) return null
    const { s, t, inDir } = geometry
    const len = 9 + 9 * weight
    const half = 4.5 + 4.5 * weight
    const bx = t.x - inDir.x * len
    const by = t.y - inDir.y * len
    const px = -inDir.y
    const py = inDir.x
    return {
      pad: { cx: s.x, cy: s.y, r: 3.5 + 3.5 * weight },
      arrow: `${t.x},${t.y} ${bx + px * half},${by + py * half} ${bx - px * half},${by - py * half}`
    }
  }, [isMessage, geometry, weight])

  return (
    <>
      <BaseEdge id={id} path={edgePath} style={animatedStyle} />
      {markers && (
        <g fill={animatedStyle.stroke as string} opacity={animatedStyle.opacity as number}>
          <circle cx={markers.pad.cx} cy={markers.pad.cy} r={markers.pad.r} />
          <polygon points={markers.arrow} />
        </g>
      )}
      {activeAnim && (
        <circle r="5" fill="#8b5cf6" key={activeAnim.id}>
          <animateMotion
            dur={`${ANIMATION_DURATION_MS}ms`}
            repeatCount="1"
            fill="freeze"
            path={motionPath!}
          />
          <animate
            attributeName="opacity"
            values="1;1;0"
            dur={`${ANIMATION_DURATION_MS}ms`}
            repeatCount="1"
            fill="freeze"
          />
        </circle>
      )}
    </>
  )
})
