import { memo, useMemo } from 'react'
import { useStore } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { useMeshStore } from '../../stores/mesh.store'
import { useMeshGraphStore } from '../../stores/mesh-graph.store'
import { useFleetStore } from '../../stores/fleet.store'
import { hexCorners, HEX_SIZE, type TerrainNodeData, type TerrainCell } from './fleet-layout'
import type { AgentState, FleetAgentStatus } from '../../../shared/types/ipc.types'

/**
 * Territory — a contiguous cluster of hex cells claimed by one tracked
 * folder. One cell per agent plus a padding ring, all tinted with the
 * folder's hue; subfolder districts get shifted shades of the same hue.
 *
 * State lights the land: an active agent's cell glows warm, pending-input
 * pulses amber, errors smoulder red, ghosts sit desaturated. Recent
 * activity brightens a cell and cools back down over a minute, so the
 * places where things are happening are literally the bright spots.
 *
 * Far zoom flips to strategy mode: the cells (with agent icons at their
 * centers) plus a scaled name banner do the talking.
 */

function hashPath(path: string): number {
  let h = 0
  for (let i = 0; i < path.length; i++) {
    h = (h * 31 + path.charCodeAt(i)) | 0
  }
  return h >>> 0
}

const hueFromPath = (path: string): number => hashPath(path) % 360

const PIP_COLOR: Partial<Record<AgentState, string>> = {
  active: 'bg-yellow-400',
  idle: 'bg-green-400',
  error: 'bg-red-400'
}

const isDarkMode = () => document.documentElement.classList.contains('dark')

/** Per-cell lighting derived from its agent's live state + recency. */
function cellFill(
  cell: TerrainCell,
  hue: number,
  dark: boolean,
  agent: FleetAgentStatus | undefined,
  lastActivityAt: number,
  districtIndex: number
): { fill: string; stroke: string; strokeWidth: number; pulse: boolean; dashed: boolean } {
  // District cells rotate lightness slightly so plots read apart
  const districtShift = districtIndex >= 0 ? (districtIndex % 3) * 5 + 6 : 0
  const baseL = dark ? 22 - districtShift * 0.6 : 88 - districtShift
  const baseS = dark ? 30 : 42

  if (!agent) {
    // Padding cell — quiet land
    return {
      fill: `hsla(${hue}, ${baseS - 12}%, ${baseL + (dark ? -4 : 4)}%, ${dark ? 0.35 : 0.5})`,
      stroke: `hsla(${hue}, ${baseS}%, ${dark ? 38 : 62}%, 0.25)`,
      strokeWidth: 1,
      pulse: false,
      dashed: false
    }
  }
  if (agent.online === false) {
    return {
      fill: `hsla(${hue}, 8%, ${dark ? 20 : 88}%, ${dark ? 0.5 : 0.6})`,
      stroke: `hsla(${hue}, 10%, ${dark ? 45 : 55}%, 0.4)`,
      strokeWidth: 1,
      pulse: false,
      dashed: true
    }
  }

  // Recency glow: activity in the last 60s brightens the cell
  const recency = Math.max(0, 1 - (Date.now() - lastActivityAt) / 60_000)

  if (agent.state === 'active') {
    return {
      fill: `hsla(45, 85%, ${dark ? 38 : 72}%, ${0.55 + 0.25 * recency})`,
      stroke: `hsla(45, 90%, ${dark ? 55 : 50}%, 0.8)`,
      strokeWidth: 2,
      pulse: true,
      dashed: false
    }
  }
  if (agent.state === 'error') {
    return {
      fill: `hsla(0, 65%, ${dark ? 30 : 80}%, 0.6)`,
      stroke: `hsla(0, 70%, ${dark ? 50 : 55}%, 0.7)`,
      strokeWidth: 1.5,
      pulse: false,
      dashed: false
    }
  }
  // idle & friends — home hue, brightened by recency
  return {
    fill: `hsla(${hue}, ${baseS + 8 + recency * 20}%, ${baseL + (dark ? recency * 8 : -recency * 6)}%, ${dark ? 0.55 : 0.75})`,
    stroke: `hsla(${hue}, ${baseS + 10}%, ${dark ? 45 : 55}%, 0.5)`,
    strokeWidth: 1.2,
    pulse: false,
    dashed: false
  }
}

export const FleetTerrainNode = memo(function FleetTerrainNode({ data }: NodeProps) {
  const { label, dirPath, agentCount, width, height, cells, members, districts } =
    data as unknown as TerrainNodeData
  const hue = useMemo(() => hueFromPath(dirPath), [dirPath])
  const dark = isDarkMode()

  const farView = useStore((s) => s.transform[2] < 0.4)

  const agents = useMeshStore((s) => s.agents)
  const nodeActivities = useMeshGraphStore((s) => s.nodeActivities)
  const pendingInteractions = useMeshGraphStore((s) => s.pendingInteractions)
  const focusedFilePath = useMeshGraphStore((s) => s.focusedFilePath)
  const selection = useFleetStore((s) => s.selection)

  const memberPaths = useMemo(() => new Set(members.map((m) => m.filePath)), [members])
  const own = useMemo(
    () => new Map(agents.filter((a) => memberPaths.has(a.filePath)).map((a) => [a.filePath, a])),
    [agents, memberPaths]
  )
  const selectedSet = useMemo(() => new Set(selection), [selection])
  const districtIndex = useMemo(() => new Map(districts.map((d, i) => [d, i])), [districts])

  const lastActivity = (filePath: string): number => {
    const acts = nodeActivities[filePath]
    return acts && acts.length > 0 ? acts[acts.length - 1].timestamp : 0
  }

  const labelColor = dark ? `hsla(${hue}, 35%, 72%, 0.95)` : `hsla(${hue}, 35%, 36%, 0.95)`

  return (
    <div className="pointer-events-none relative" style={{ width, height }}>
      <svg width={width} height={height} className="absolute inset-0 overflow-visible">
        {cells.map((cell) => {
          const agent = cell.filePath ? own.get(cell.filePath) : undefined
          const style = cellFill(
            cell, hue, dark, agent,
            cell.filePath ? lastActivity(cell.filePath) : 0,
            cell.district ? districtIndex.get(cell.district) ?? -1 : -1
          )
          const pending = cell.filePath ? pendingInteractions[cell.filePath] : undefined
          const isFocused = cell.filePath != null && cell.filePath === focusedFilePath
          const isSelected = cell.filePath != null && selectedSet.has(cell.filePath)
          return (
            <g key={`${cell.q},${cell.r}`}>
              <polygon
                points={hexCorners(cell.x, cell.y, HEX_SIZE - 2)}
                fill={style.fill}
                stroke={style.stroke}
                strokeWidth={style.strokeWidth}
                strokeDasharray={style.dashed ? '7 5' : undefined}
                className={style.pulse ? 'animate-pulse' : undefined}
              />
              {pending && (
                <polygon
                  points={hexCorners(cell.x, cell.y, HEX_SIZE - 6)}
                  fill="none"
                  stroke="#f59e0b"
                  strokeWidth={3}
                  className="animate-pulse"
                />
              )}
              {(isFocused || isSelected) && !pending && (
                <polygon
                  points={hexCorners(cell.x, cell.y, HEX_SIZE - 6)}
                  fill="none"
                  stroke={isFocused ? '#8b5cf6' : '#3b82f6'}
                  strokeWidth={2.5}
                  opacity={0.85}
                />
              )}
            </g>
          )
        })}

        {/* Far zoom: agent icons take over the cells */}
        {farView &&
          cells.map((cell) => {
            if (!cell.filePath) return null
            const member = members.find((m) => m.filePath === cell.filePath)
            const icon = member?.icon
            return (
              <text
                key={`icon-${cell.q},${cell.r}`}
                x={cell.x}
                y={cell.y + HEX_SIZE * 0.28}
                textAnchor="middle"
                fontSize={HEX_SIZE * 0.85}
                style={{ userSelect: 'none' }}
              >
                {icon || (member?.handle?.charAt(0)?.toUpperCase() ?? '·')}
              </text>
            )
          })}
      </svg>

      {/* Near-zoom corner label */}
      {!farView && (
        <div className="relative flex items-center gap-1.5 select-none px-6 py-4">
          <span className="text-[13px] font-semibold" style={{ color: labelColor }} title={dirPath || undefined}>
            {label}
          </span>
          <span className="text-[11px] opacity-60" style={{ color: labelColor }}>
            {agentCount}
          </span>
        </div>
      )}

      {/* Far-zoom banner */}
      {farView && (
        <TerritoryBanner label={label} hue={hue} own={own} nodeActivities={nodeActivities}
          pendingCount={members.filter((m) => pendingInteractions[m.filePath]).length}
          width={width} height={height} dark={dark} />
      )}
    </div>
  )
})

function TerritoryBanner({
  label,
  hue,
  own,
  nodeActivities,
  pendingCount,
  width,
  height,
  dark
}: {
  label: string
  hue: number
  own: Map<string, FleetAgentStatus>
  nodeActivities: Record<string, { timestamp: number }[]>
  pendingCount: number
  width: number
  height: number
  dark: boolean
}) {
  const { pips, star } = useMemo(() => {
    const counts: Record<string, number> = {}
    let star: { handle: string; icon?: string; status?: string } | null = null
    let bestAt = -1
    for (const a of own.values()) {
      const key = !a.online ? 'offline' : a.state
      counts[key] = (counts[key] ?? 0) + 1
      const acts = nodeActivities[a.filePath]
      const last = acts && acts.length > 0 ? acts[acts.length - 1].timestamp : 0
      const score = a.state === 'active' ? last + 1e15 : last
      if (score > bestAt) {
        bestAt = score
        star = { handle: a.handle, icon: a.icon, status: a.status }
      }
    }
    return { pips: counts, star }
  }, [own, nodeActivities])

  const nameSize = Math.max(30, Math.min(120, Math.min(width, height) * 0.12))
  const subSize = Math.max(14, nameSize * 0.34)
  const pipSize = Math.max(10, nameSize * 0.22)

  const nameColor = dark ? `hsla(${hue}, 40%, 76%, 0.95)` : `hsla(${hue}, 34%, 34%, 0.9)`
  const chipBg = dark ? `hsla(${hue}, 30%, 14%, 0.9)` : `hsla(${hue}, 45%, 97%, 0.9)`
  const chipBorder = `hsla(${hue}, 30%, 55%, 0.4)`
  const chipText = dark ? 'rgba(229,229,229,0.95)' : 'rgba(64,64,64,0.95)'

  return (
    <div className="absolute left-0 right-0 flex flex-col items-center select-none px-4" style={{ top: '100%', marginTop: -nameSize * 0.2 }}>
      <span className="font-bold tracking-wide truncate max-w-full leading-none" style={{ color: nameColor, fontSize: nameSize }}>
        {label}
      </span>
      <div className="flex items-center mt-2" style={{ gap: pipSize * 0.8, fontSize: subSize }}>
        {(['active', 'idle', 'error'] as const).map((s) =>
          pips[s] ? (
            <span key={s} className="flex items-center font-semibold" style={{ gap: pipSize * 0.35, color: nameColor }}>
              <span className={`rounded-full ${PIP_COLOR[s]}`} style={{ width: pipSize, height: pipSize }} />
              {pips[s]}
            </span>
          ) : null
        )}
        {pips.offline ? (
          <span className="flex items-center font-semibold opacity-60" style={{ gap: pipSize * 0.35, color: nameColor }}>
            <span className="rounded-full border-2 border-dashed" style={{ width: pipSize, height: pipSize, borderColor: nameColor }} />
            {pips.offline}
          </span>
        ) : null}
        {pendingCount > 0 && (
          <span className="flex items-center font-bold text-amber-500" style={{ gap: pipSize * 0.35 }}>
            <span className="rounded-full bg-amber-400 animate-pulse" style={{ width: pipSize, height: pipSize }} />
            {pendingCount}
          </span>
        )}
      </div>
      {star && (
        <div
          className="flex items-center mt-2 rounded-full border max-w-[92%]"
          style={{ backgroundColor: chipBg, borderColor: chipBorder, gap: subSize * 0.4, padding: `${subSize * 0.28}px ${subSize * 0.85}px` }}
        >
          {star.icon && <span className="leading-none" style={{ fontSize: subSize * 1.1 }}>{star.icon}</span>}
          <span className="font-semibold whitespace-nowrap" style={{ fontSize: subSize, color: chipText }}>
            {star.handle}
          </span>
          {star.status && (
            <span className="truncate opacity-70" style={{ fontSize: subSize * 0.9, color: chipText }}>
              — {star.status}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
