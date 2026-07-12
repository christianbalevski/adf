import { memo, useMemo } from 'react'
import { BaseEdge, getBezierPath, useInternalNode, useStore, Position } from '@xyflow/react'
import type { EdgeProps, InternalNode } from '@xyflow/react'
import { useMeshGraphStore, ANIMATION_DURATION_MS, type EdgeHeatEntry } from '../../stores/mesh-graph.store'

export interface MeshEdgeData {
  edgeType: 'channel' | 'message' | 'lineage'
  channel?: string
}

/**
 * Floating-edge geometry: edges connect node borders along the line between
 * node centers, so paths simply follow wherever the territory layout puts
 * the nodes instead of forcing top-to-bottom workflow anchors.
 */
function nodeRect(node: InternalNode): { cx: number; cy: number; w: number; h: number } {
  const w = node.measured?.width ?? node.initialWidth ?? 260
  const h = node.measured?.height ?? node.initialHeight ?? 120
  const { x, y } = node.internals.positionAbsolute
  return { cx: x + w / 2, cy: y + h / 2, w, h }
}

function borderPoint(from: ReturnType<typeof nodeRect>, to: ReturnType<typeof nodeRect>): { x: number; y: number; side: Position } {
  const dx = to.cx - from.cx
  const dy = to.cy - from.cy
  if (dx === 0 && dy === 0) return { x: from.cx, y: from.cy, side: Position.Top }
  const scaleX = Math.abs(dx) / (from.w / 2)
  const scaleY = Math.abs(dy) / (from.h / 2)
  const scale = 1 / Math.max(scaleX, scaleY)
  const side =
    scaleX > scaleY
      ? dx > 0 ? Position.Right : Position.Left
      : dy > 0 ? Position.Bottom : Position.Top
  return { x: from.cx + dx * scale, y: from.cy + dy * scale, side }
}

/** Heat cooldown window — an edge fully cools 2 minutes after its last message */
const HEAT_COOLDOWN_MS = 120_000
const HEAT_BASE_STROKE = '#6b7280'
const HEAT_HOT_STROKE = '#8b5cf6'

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

/** Heat factor 0–1: linear timestamp decay scaled by clamped message count */
function heatOf(entry: EdgeHeatEntry | null, now: number): number {
  if (!entry) return 0
  const h = Math.max(0, 1 - (now - entry.lastAt) / HEAT_COOLDOWN_MS)
  return h * (0.4 + 0.6 * Math.min(1, entry.count / 10))
}

export const MeshGraphEdge = memo(function MeshGraphEdge(props: EdgeProps) {
  const { id, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, style } = props
  const edgeData = data as unknown as MeshEdgeData | undefined
  const isChannel = edgeData?.edgeType === 'channel'
  const isMessage = edgeData?.edgeType === 'message'

  const sourceNode = useInternalNode(source)
  const targetNode = useInternalNode(target)

  // Floating anchors between node borders; handle-based props are the fallback
  const geometry = useMemo(() => {
    if (!sourceNode || !targetNode) {
      return { sx: sourceX, sy: sourceY, tx: targetX, ty: targetY, sp: sourcePosition, tp: targetPosition }
    }
    const s = nodeRect(sourceNode)
    const t = nodeRect(targetNode)
    const sPoint = borderPoint(s, t)
    const tPoint = borderPoint(t, s)
    return { sx: sPoint.x, sy: sPoint.y, tx: tPoint.x, ty: tPoint.y, sp: sPoint.side, tp: tPoint.side }
  }, [sourceNode, targetNode, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition])

  const [edgePath] = getBezierPath({
    sourceX: geometry.sx,
    sourceY: geometry.sy,
    targetX: geometry.tx,
    targetY: geometry.ty,
    sourcePosition: geometry.sp,
    targetPosition: geometry.tp,
    curvature: 0.18
  })

  // O(1) index lookup instead of linear scan
  const fwdAnim = useMeshGraphStore((s) => s.activeAnimationIndex[`${source}|${target}`] ?? null)
  const revAnim = useMeshGraphStore((s) => s.activeAnimationIndex[`${target}|${source}`] ?? null)
  const activeAnim = useMemo(() => {
    if (fwdAnim) return { ...fwdAnim, reversed: false }
    if (revAnim) return { ...revAnim, reversed: true }
    return null
  }, [fwdAnim, revAnim])

  // Only compute reversed path when animation needs it
  const reversedPath = useMemo(() => {
    if (!activeAnim?.reversed) return null
    const [path] = getBezierPath({
      sourceX: geometry.tx,
      sourceY: geometry.ty,
      targetX: geometry.sx,
      targetY: geometry.sy,
      sourcePosition: geometry.tp,
      targetPosition: geometry.sp,
      curvature: 0.18
    })
    return path
  }, [activeAnim?.reversed, geometry])

  // Message-frequency heat — hotter of both directions, decays purely by
  // timestamp at render time (no re-render timer; renders are frequent
  // enough via poll/animation churn). Never affects position.
  const fwdHeat = useMeshGraphStore((s) => (isMessage ? s.edgeHeat[`${source}|${target}`] ?? null : null))
  const revHeat = useMeshGraphStore((s) => (isMessage ? s.edgeHeat[`${target}|${source}`] ?? null : null))
  const now = Date.now()
  const heat = Math.max(heatOf(fwdHeat, now), heatOf(revHeat, now))

  // At territory-overview zoom the edges are noise — fade them right down
  // so the map reads by region banner, not by spiderweb.
  const farView = useStore((s) => s.transform[2] < 0.4)

  const isLineage = edgeData?.edgeType === 'lineage'
  const edgeStyle = isLineage
    ? { ...style, stroke: '#a8a29e', strokeWidth: 1.5, strokeDasharray: '6 3', opacity: farView ? 0.12 : 0.5 }
    : isChannel
      ? { ...style, stroke: '#94a3b8', strokeWidth: 1, strokeDasharray: '4 4', opacity: farView ? 0.1 : 0.4 }
      : {
          ...style,
          stroke: heat > 0 ? lerpHex(HEAT_BASE_STROKE, HEAT_HOT_STROKE, heat) : HEAT_BASE_STROKE,
          strokeWidth: 1.5 + 2 * heat,
          opacity: (farView && heat === 0 ? 0.15 : 0.6) + 0.35 * heat
        }

  const animatedStyle = activeAnim
    ? { ...edgeStyle, stroke: '#8b5cf6', strokeWidth: 2.5, opacity: 1 }
    : edgeStyle

  // Pick the path matching the message direction
  const motionPath = activeAnim?.reversed ? reversedPath : edgePath

  return (
    <>
      <BaseEdge id={id} path={edgePath} style={animatedStyle} />
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
