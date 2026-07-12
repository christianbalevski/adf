import { memo, useMemo } from 'react'
import { BaseEdge, getBezierPath } from '@xyflow/react'
import type { EdgeProps } from '@xyflow/react'
import { useMeshGraphStore, ANIMATION_DURATION_MS, type EdgeHeatEntry } from '../../stores/mesh-graph.store'

export interface MeshEdgeData {
  edgeType: 'channel' | 'message' | 'lineage'
  channel?: string
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

  const [edgePath] = getBezierPath({
    sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition
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
      sourceX: targetX, sourceY: targetY, targetX: sourceX, targetY: sourceY,
      sourcePosition: targetPosition, targetPosition: sourcePosition
    })
    return path
  }, [activeAnim?.reversed, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition])

  // Message-frequency heat — hotter of both directions, decays purely by
  // timestamp at render time (no re-render timer; renders are frequent
  // enough via poll/animation churn). Never affects position.
  const fwdHeat = useMeshGraphStore((s) => (isMessage ? s.edgeHeat[`${source}|${target}`] ?? null : null))
  const revHeat = useMeshGraphStore((s) => (isMessage ? s.edgeHeat[`${target}|${source}`] ?? null : null))
  const now = Date.now()
  const heat = Math.max(heatOf(fwdHeat, now), heatOf(revHeat, now))

  const isLineage = edgeData?.edgeType === 'lineage'
  const edgeStyle = isLineage
    ? { ...style, stroke: '#a8a29e', strokeWidth: 1.5, strokeDasharray: '6 3', opacity: 0.5 }
    : isChannel
      ? { ...style, stroke: '#94a3b8', strokeWidth: 1, strokeDasharray: '4 4', opacity: 0.4 }
      : {
          ...style,
          stroke: heat > 0 ? lerpHex(HEAT_BASE_STROKE, HEAT_HOT_STROKE, heat) : HEAT_BASE_STROKE,
          strokeWidth: 1.5 + 2 * heat,
          opacity: 0.6 + 0.35 * heat
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
