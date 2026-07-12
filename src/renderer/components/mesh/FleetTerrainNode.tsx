import { memo, useMemo } from 'react'
import { useStore } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { useMeshStore } from '../../stores/mesh.store'
import { useMeshGraphStore } from '../../stores/mesh-graph.store'
import type { TerrainNodeData } from './fleet-layout'
import type { AgentState } from '../../../shared/types/ipc.types'

/**
 * Territory background — one per tracked directory ('root' variant), plus
 * lighter district rects for subdirectories ('sub'). Static geography:
 * rendered behind agent nodes, not draggable or selectable.
 *
 * Civ-style semantic zoom: up close it's a quiet labeled region; zoomed out
 * the territory takes over the storytelling — big name, state pips, and a
 * banner for the most recently active agent, so a distant map still reads.
 *
 * Texture: each territory gets a deterministic hue from its path (soft tint,
 * faint diagonal hatching, tinted double border) so territories read apart
 * at a glance without shouting.
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

const PIP_COLOR: Partial<Record<AgentState, string>> = {
  active: 'bg-yellow-400',
  idle: 'bg-green-400',
  error: 'bg-red-400'
}

export const FleetTerrainNode = memo(function FleetTerrainNode({ data }: NodeProps) {
  const { label, dirPath, agentCount, width, height, variant, members } = data as unknown as TerrainNodeData
  const isSub = variant === 'sub'
  const hue = useMemo(() => hueFromPath(dirPath), [dirPath])

  // Far-zoom banner kicks in when agent nodes have collapsed to dots
  const farView = useStore((s) => s.transform[2] < 0.4)

  const style = useMemo<React.CSSProperties>(() => ({
    width,
    height,
    backgroundColor: `hsla(${hue}, 42%, 55%, ${isSub ? 0.05 : 0.08})`,
    backgroundImage: isSub ? undefined : hatchDataUri(hue, 0.05),
    borderColor: `hsla(${hue}, 30%, 50%, ${isSub ? 0.25 : 0.4})`,
    boxShadow: isSub ? undefined : `inset 0 0 0 3px hsla(${hue}, 40%, 55%, 0.08)`
  }), [width, height, hue, isSub])

  return (
    <div
      className={`pointer-events-none border border-dashed relative overflow-hidden ${
        isSub ? 'rounded-lg' : 'rounded-2xl'
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

      {/* Far-zoom territory banner — the distant map keeps telling the story */}
      {farView && !isSub && (
        <TerritoryBanner label={label} hue={hue} members={members} height={height} />
      )}
    </div>
  )
})

function TerritoryBanner({
  label,
  hue,
  members,
  height
}: {
  label: string
  hue: number
  members: TerrainNodeData['members']
  height: number
}) {
  const agents = useMeshStore((s) => s.agents)
  const nodeActivities = useMeshGraphStore((s) => s.nodeActivities)

  const { pips, star } = useMemo(() => {
    const memberPaths = new Set(members.map((m) => m.filePath))
    const own = agents.filter((a) => memberPaths.has(a.filePath))
    const counts: Record<string, number> = {}
    for (const a of own) {
      const key = !a.online ? 'offline' : a.state
      counts[key] = (counts[key] ?? 0) + 1
    }
    // Most recently active member gets the banner
    let star: { handle: string; icon?: string; status?: string; state?: AgentState } | null = null
    let bestAt = -1
    for (const a of own) {
      const acts = nodeActivities[a.filePath]
      const last = acts && acts.length > 0 ? acts[acts.length - 1].timestamp : 0
      const score = a.state === 'active' ? last + 1e15 : last
      if (score > bestAt) {
        bestAt = score
        star = { handle: a.handle, icon: a.icon, status: a.status, state: a.state }
      }
    }
    return { pips: counts, star }
  }, [agents, nodeActivities, members])

  // Scale type with territory size so big regions get bigger banners
  const big = height > 700

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-end pb-[8%] select-none">
      <span
        className={`font-semibold tracking-wide ${big ? 'text-5xl' : 'text-3xl'}`}
        style={{ color: `hsla(${hue}, 30%, 42%, 0.7)` }}
      >
        {label}
      </span>
      <div className="flex items-center gap-2 mt-2">
        {(['active', 'idle', 'error'] as const).map((s) =>
          pips[s] ? (
            <span key={s} className="flex items-center gap-1 text-lg font-medium text-neutral-500/80 dark:text-neutral-400/80">
              <span className={`w-3 h-3 rounded-full ${PIP_COLOR[s]}`} />
              {pips[s]}
            </span>
          ) : null
        )}
        {pips.offline ? (
          <span className="flex items-center gap-1 text-lg font-medium text-neutral-400/70 dark:text-neutral-500/70">
            <span className="w-3 h-3 rounded-full border-2 border-dashed border-neutral-400/70" />
            {pips.offline}
          </span>
        ) : null}
      </div>
      {star && (
        <div
          className="flex items-center gap-2 mt-3 px-4 py-1.5 rounded-full border backdrop-blur-[1px]"
          style={{
            backgroundColor: `hsla(${hue}, 40%, 96%, 0.75)`,
            borderColor: `hsla(${hue}, 30%, 55%, 0.35)`
          }}
        >
          {star.icon && <span className="text-xl leading-none">{star.icon}</span>}
          <span className="text-xl font-semibold text-neutral-600 dark:text-neutral-700">{star.handle}</span>
          {star.status && (
            <span className="text-lg text-neutral-500 dark:text-neutral-600 truncate max-w-[16em]">
              — {star.status}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
