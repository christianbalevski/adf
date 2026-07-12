import { memo, useMemo } from 'react'
import type { NodeProps } from '@xyflow/react'
import type { TerrainNodeData } from './fleet-layout'

/**
 * Terrain region background — one per tracked directory ('root' variant),
 * plus lighter district rects for subdirectories ('sub' variant). Static
 * geography: rendered behind agent nodes, not draggable or selectable.
 *
 * Texture: each region gets a deterministic hue from its path (very
 * desaturated tint + faint diagonal hatching) so different territories read
 * apart at a glance without shouting.
 */

/** Small stable string hash → hue in [0, 360). */
function hueFromPath(path: string): number {
  let h = 0
  for (let i = 0; i < path.length; i++) {
    h = (h * 31 + path.charCodeAt(i)) | 0
  }
  return ((h % 360) + 360) % 360
}

/** Inline SVG diagonal hatch, tinted by hue — data URI so no external fetch. */
function hatchDataUri(hue: number, opacity: number): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14">` +
    `<path d="M-3,3 l6,-6 M0,14 l14,-14 M11,17 l6,-6" stroke="hsl(${hue},45%,50%)" stroke-opacity="${opacity}" stroke-width="1"/>` +
    `</svg>`
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
}

export const FleetTerrainNode = memo(function FleetTerrainNode({ data }: NodeProps) {
  const { label, dirPath, agentCount, width, height, variant } = data as unknown as TerrainNodeData
  const isSub = variant === 'sub'
  const hue = useMemo(() => hueFromPath(dirPath), [dirPath])

  const style = useMemo<React.CSSProperties>(() => ({
    width,
    height,
    backgroundColor: `hsla(${hue}, 42%, 55%, ${isSub ? 0.045 : 0.07})`,
    backgroundImage: isSub ? undefined : hatchDataUri(hue, 0.05),
    borderColor: `hsla(${hue}, 30%, 50%, ${isSub ? 0.25 : 0.35})`
  }), [width, height, hue, isSub])

  return (
    <div
      className={`pointer-events-none border border-dashed ${
        isSub ? 'rounded-lg' : 'rounded-xl'
      }`}
      style={style}
    >
      <div className={`flex items-center gap-1.5 select-none ${isSub ? 'px-2.5 py-1' : 'px-3 py-2'}`}>
        <svg
          width={isSub ? 10 : 12}
          height={isSub ? 10 : 12}
          viewBox="0 0 24 24"
          fill="none"
          stroke={`hsla(${hue}, 35%, 45%, 0.9)`}
          strokeWidth="2"
          className="shrink-0"
        >
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
        <span
          className={`font-medium truncate ${isSub ? 'text-[10px]' : 'text-[11px]'} text-neutral-500 dark:text-neutral-400`}
          title={dirPath || undefined}
        >
          {label}
        </span>
        <span className={`${isSub ? 'text-[9px]' : 'text-[10px]'} text-neutral-400 dark:text-neutral-600`}>
          {agentCount}
        </span>
      </div>
    </div>
  )
})
