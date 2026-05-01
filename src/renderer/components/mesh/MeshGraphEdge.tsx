import { memo, useMemo } from 'react'
import { BaseEdge, getBezierPath } from '@xyflow/react'
import type { EdgeProps } from '@xyflow/react'
import { useMeshGraphStore, ANIMATION_DURATION_MS } from '../../stores/mesh-graph.store'

export interface MeshEdgeData {
  edgeType: 'channel' | 'message'
  channel?: string
}

export const MeshGraphEdge = memo(function MeshGraphEdge(props: EdgeProps) {
  const { id, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, style } = props
  const edgeData = data as unknown as MeshEdgeData | undefined
  const isChannel = edgeData?.edgeType === 'channel'

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

  const edgeStyle = isChannel
    ? { ...style, stroke: '#94a3b8', strokeWidth: 1, strokeDasharray: '4 4', opacity: 0.4 }
    : { ...style, stroke: '#6b7280', strokeWidth: 1.5, opacity: 0.6 }

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
