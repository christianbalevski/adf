import { memo, useMemo } from 'react'
import type { NodeProps } from '@xyflow/react'
import { useMeshStore } from '../../stores/mesh.store'
import { useMeshGraphStore } from '../../stores/mesh-graph.store'
import { useFleetStore } from '../../stores/fleet.store'
import { hexCorners, HEX_SIZE, HEX_ROW_H, type TerrainNodeData } from './fleet-layout'
import type { AgentState, FleetAgentStatus } from '../../../shared/types/ipc.types'

/**
 * Territory — a contiguous cluster of hex cells claimed by one tracked
 * folder. One cell per agent plus a padding ring, tinted with the folder's
 * hue; subfolder districts get shifted shades of the same hue.
 *
 * The tile IS the agent's identity at every zoom: icon, name, status and
 * vitals are SVG that scales continuously with the viewport — no LOD pops.
 * State lights the land: active cells breathe a warm pulse, pending-input
 * pulses an amber ring, errors smoulder red, ghosts sit dimmed but clearly
 * present, held agents carry a pause badge, and lineage shows as a violet
 * family glow around a selected agent's parent and children (no permanent
 * lines — adjacency plus highlight carries the relationship).
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

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return `${Math.round(n)}`
}

/** Per-cell lighting derived from its agent's live state + recency. */
function cellFill(
  hue: number,
  dark: boolean,
  agent: FleetAgentStatus | undefined,
  lastActivityAt: number,
  districtIndex: number
): { fill: string; stroke: string; strokeWidth: number; pulse: boolean; dashed: boolean } {
  const districtShift = districtIndex >= 0 ? (districtIndex % 3) * 5 + 6 : 0
  const baseL = dark ? 26 - districtShift * 0.6 : 88 - districtShift
  const baseS = dark ? 30 : 42

  if (!agent) {
    // Padding cell — quiet land
    return {
      fill: `hsla(${hue}, ${baseS - 12}%, ${baseL + (dark ? -6 : 4)}%, ${dark ? 0.4 : 0.5})`,
      stroke: `hsla(${hue}, ${baseS}%, ${dark ? 40 : 62}%, 0.28)`,
      strokeWidth: 1,
      pulse: false,
      dashed: false
    }
  }
  if (agent.online === false) {
    // Ghost — dimmed but unmistakably present at any theme
    return {
      fill: `hsla(${hue}, 12%, ${dark ? 32 : 85}%, ${dark ? 0.55 : 0.65})`,
      stroke: `hsla(${hue}, 16%, ${dark ? 55 : 50}%, 0.55)`,
      strokeWidth: 1.2,
      pulse: false,
      dashed: true
    }
  }

  const recency = Math.max(0, 1 - (Date.now() - lastActivityAt) / 60_000)

  if (agent.state === 'active') {
    // Whole-hex breathing glow — subtle, the hexPulse keyframe drives opacity
    return {
      fill: `hsla(45, 85%, ${dark ? 40 : 74}%, 0.5)`,
      stroke: `hsla(45, 90%, ${dark ? 58 : 48}%, 0.75)`,
      strokeWidth: 2,
      pulse: true,
      dashed: false
    }
  }
  if (agent.state === 'error') {
    return {
      fill: `hsla(0, 60%, ${dark ? 32 : 82}%, 0.55)`,
      stroke: `hsla(0, 70%, ${dark ? 52 : 55}%, 0.65)`,
      strokeWidth: 1.5,
      pulse: false,
      dashed: false
    }
  }
  return {
    fill: `hsla(${hue}, ${baseS + 8 + recency * 20}%, ${baseL + (dark ? 4 + recency * 8 : -recency * 6)}%, ${dark ? 0.6 : 0.75})`,
    stroke: `hsla(${hue}, ${baseS + 10}%, ${dark ? 48 : 55}%, 0.5)`,
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

  const agents = useMeshStore((s) => s.agents)
  const nodeActivities = useMeshGraphStore((s) => s.nodeActivities)
  const pendingInteractions = useMeshGraphStore((s) => s.pendingInteractions)
  const focusedFilePath = useMeshGraphStore((s) => s.focusedFilePath)
  const selection = useFleetStore((s) => s.selection)
  const family = useFleetStore((s) => s.family)
  const burn = useFleetStore((s) => s.burn)

  const memberPaths = useMemo(() => new Set(members.map((m) => m.filePath)), [members])
  const own = useMemo(
    () => new Map(agents.filter((a) => memberPaths.has(a.filePath)).map((a) => [a.filePath, a])),
    [agents, memberPaths]
  )
  const iconByPath = useMemo(() => new Map(members.map((m) => [m.filePath, m.icon])), [members])
  const selectedSet = useMemo(() => new Set(selection), [selection])
  const familySet = useMemo(() => new Set(family), [family])
  const districtIndex = useMemo(() => new Map(districts.map((d, i) => [d, i])), [districts])

  const lastActivity = (filePath: string): number => {
    const acts = nodeActivities[filePath]
    return acts && acts.length > 0 ? acts[acts.length - 1].timestamp : 0
  }

  const labelColor = dark ? `hsla(${hue}, 35%, 72%, 0.95)` : `hsla(${hue}, 35%, 36%, 0.95)`
  const nameColor = dark ? 'rgba(235,235,235,0.95)' : 'rgba(45,45,45,0.95)'
  const statusColor = dark ? 'rgba(190,190,190,0.75)' : 'rgba(90,90,90,0.75)'
  const metaColor = dark ? 'rgba(160,160,160,0.6)' : 'rgba(120,120,120,0.65)'

  // District mini-cluster labels — floated above each satellite cluster
  const districtLabels = useMemo(() => {
    return districts.map((district) => {
      const own = cells.filter((c) => c.district === district)
      if (own.length === 0) return null
      const cx = own.reduce((s, c) => s + c.x, 0) / own.length
      const top = Math.min(...own.map((c) => c.y))
      return { district, x: cx, y: top - HEX_ROW_H * 0.62 }
    }).filter((d): d is NonNullable<typeof d> => d !== null)
  }, [districts, cells])

  return (
    <div className="pointer-events-none relative" style={{ width, height }}>
      <svg width={width} height={height} className="absolute inset-0 overflow-visible">
        {/* Land */}
        {cells.map((cell) => {
          const agent = cell.filePath ? own.get(cell.filePath) : undefined
          const style = cellFill(
            hue, dark, agent,
            cell.filePath ? lastActivity(cell.filePath) : 0,
            cell.district ? districtIndex.get(cell.district) ?? -1 : -1
          )
          const pending = cell.filePath ? pendingInteractions[cell.filePath] : undefined
          const isFocused = cell.filePath != null && cell.filePath === focusedFilePath
          const isSelected = cell.filePath != null && selectedSet.has(cell.filePath)
          const isFamily = cell.filePath != null && familySet.has(cell.filePath) && !isSelected && !isFocused
          return (
            <g key={`${cell.q},${cell.r}`}>
              <polygon
                points={hexCorners(cell.x, cell.y, HEX_SIZE - 2)}
                fill={style.fill}
                stroke={style.stroke}
                strokeWidth={style.strokeWidth}
                strokeDasharray={style.dashed ? '7 5' : undefined}
                style={style.pulse ? { animation: 'hexPulse 2.4s ease-in-out infinite' } : undefined}
              />
              {pending && (
                <polygon
                  points={hexCorners(cell.x, cell.y, HEX_SIZE - 7)}
                  fill="none"
                  stroke="#f59e0b"
                  strokeWidth={3.5}
                  style={{ animation: 'hexPulse 1.6s ease-in-out infinite' }}
                />
              )}
              {(isFocused || isSelected) && !pending && (
                <polygon
                  points={hexCorners(cell.x, cell.y, HEX_SIZE - 7)}
                  fill="none"
                  stroke={isFocused ? '#8b5cf6' : '#3b82f6'}
                  strokeWidth={2.5}
                  opacity={0.85}
                />
              )}
              {/* Family glow — lineage without lines */}
              {isFamily && (
                <polygon
                  points={hexCorners(cell.x, cell.y, HEX_SIZE - 7)}
                  fill="rgba(139,92,246,0.10)"
                  stroke="#8b5cf6"
                  strokeWidth={2}
                  strokeDasharray="10 6"
                  opacity={0.7}
                />
              )}
            </g>
          )
        })}

        {/* District labels — float above each satellite mini-cluster */}
        {districtLabels.map((d) => (
          <text
            key={`district-${d.district}`}
            x={d.x}
            y={d.y}
            textAnchor="middle"
            fontSize={30}
            fontWeight={600}
            fill={labelColor}
            style={{ userSelect: 'none' }}
          >
            {d.district}
          </text>
        ))}

        {/* Units — identity is part of the tile, scaling continuously */}
        {cells.map((cell) => {
          if (!cell.filePath) return null
          const agent = own.get(cell.filePath)
          const icon = iconByPath.get(cell.filePath)
          const handle = agent?.handle ?? members.find((m) => m.filePath === cell.filePath)?.handle ?? ''
          const status = agent?.online === false ? 'not started' : agent?.status || agent?.state || ''
          const held = agent?.held
          const agentBurn = burn?.perAgent[cell.filePath]
          const meta = [
            agent?.model,
            agentBurn && agentBurn.totalTokens > 0
              ? `Σ ${formatTokens(agentBurn.totalTokens)}${agentBurn.tokensPerMin > 0 ? ` · ${formatTokens(agentBurn.tokensPerMin)}/m` : ''}`
              : null
          ].filter(Boolean).join('   ')
          const isGhostUnit = agent?.online === false
          return (
            <g
              key={`unit-${cell.q},${cell.r}`}
              opacity={isGhostUnit ? 0.45 : 1}
              style={{ userSelect: 'none', filter: isGhostUnit ? 'grayscale(0.9)' : undefined }}
            >
              <text x={cell.x} y={cell.y - 26} textAnchor="middle" fontSize={86}>
                {icon}
              </text>
              <text
                x={cell.x}
                y={cell.y + 46}
                textAnchor="middle"
                fontSize={26}
                fontWeight={600}
                fill={nameColor}
              >
                {truncate(handle, 18)}
              </text>
              {status && (
                <text x={cell.x} y={cell.y + 74} textAnchor="middle" fontSize={17} fontStyle="italic" fill={statusColor}>
                  {truncate(String(status), 26)}
                </text>
              )}
              {meta && (
                <text x={cell.x} y={cell.y + 98} textAnchor="middle" fontSize={14} fill={metaColor}>
                  {truncate(meta, 34)}
                </text>
              )}
              {held && (
                <g transform={`translate(${cell.x + HEX_SIZE * 0.52}, ${cell.y - HEX_SIZE * 0.62})`}>
                  <circle r={16} fill={dark ? 'rgba(64,64,64,0.9)' : 'rgba(250,250,250,0.9)'} stroke="#a3a3a3" strokeWidth={1.5} />
                  <rect x={-5.5} y={-6.5} width={4} height={13} rx={1} fill={dark ? '#e5e5e5' : '#525252'} />
                  <rect x={1.5} y={-6.5} width={4} height={13} rx={1} fill={dark ? '#e5e5e5' : '#525252'} />
                </g>
              )}
            </g>
          )
        })}
      </svg>

      {/* Territory label — top corner, always */}
      <div className="relative flex items-center gap-1.5 select-none px-6 py-4">
        <span className="text-[15px] font-semibold" style={{ color: labelColor }} title={dirPath || undefined}>
          {label}
        </span>
        <span className="text-[12px] opacity-60" style={{ color: labelColor }}>
          {agentCount}
        </span>
      </div>

      {/* Banner under the cluster — pips + star agent (scales with territory) */}
      <TerritoryBanner label={label} hue={hue} own={own} nodeActivities={nodeActivities}
        pendingCount={members.filter((m) => pendingInteractions[m.filePath]).length}
        width={width} height={height} dark={dark} />
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
