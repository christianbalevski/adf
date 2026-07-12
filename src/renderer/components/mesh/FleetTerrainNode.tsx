import { memo } from 'react'
import type { NodeProps } from '@xyflow/react'
import type { TerrainNodeData } from './fleet-layout'

/**
 * Terrain region background — one per tracked directory. Static geography:
 * rendered behind agent nodes, not draggable or selectable.
 */
export const FleetTerrainNode = memo(function FleetTerrainNode({ data }: NodeProps) {
  const { label, dirPath, agentCount, width, height } = data as unknown as TerrainNodeData

  return (
    <div
      className="rounded-xl border border-dashed border-neutral-300 dark:border-neutral-700 bg-neutral-100/50 dark:bg-neutral-900/40 pointer-events-none"
      style={{ width, height }}
    >
      <div className="flex items-center gap-1.5 px-3 py-2 select-none">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-neutral-400 shrink-0">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
        <span className="text-[11px] font-medium text-neutral-500 dark:text-neutral-400 truncate" title={dirPath || undefined}>
          {label}
        </span>
        <span className="text-[10px] text-neutral-400 dark:text-neutral-600">
          {agentCount}
        </span>
      </div>
    </div>
  )
})
