import { memo, useMemo } from 'react'
import type { NodeProps } from '@xyflow/react'
import { useMeshStore } from '../../stores/mesh.store'
import { useMeshGraphStore } from '../../stores/mesh-graph.store'
import { useFleetStore } from '../../stores/fleet.store'
import { hexCorners, hexBoundaryPath, isUnder, HEX_SIZE, type TerrainNodeData } from './fleet-layout'
import { resolveLineage } from '../../../shared/utils/lineage'
import type { AgentState, FleetAgentStatus } from '../../../shared/types/ipc.types'

/**
 * Territory land — a contiguous cluster of hex cells claimed by one tracked
 * folder. One cell per agent plus a padding ring, tinted with the folder's
 * hue; subfolder districts get shifted shades of the same hue.
 *
 * This node renders ONLY the polygons (fills, state lighting, selection
 * rings) and sits below the message-trace edge layer. All text — identity,
 * badges, district labels, the banner — lives in FleetTerrainLabelNode, a
 * twin node above the edges, so traces run under the words. State lights the
 * land: active cells breathe a warm pulse, pending-input pulses an amber
 * ring, errors smoulder red, ghosts sit dimmed but clearly present. Lineage
 * is a LENS: dynasties get a family hue with the root darkest and each
 * generation a lighter shade.
 */

function hashPath(path: string): number {
  let h = 0
  for (let i = 0; i < path.length; i++) {
    h = (h * 31 + path.charCodeAt(i)) | 0
  }
  return h >>> 0
}

// Folder hues avoid the red/pink band (≈320°–40°) — red is the ERROR color,
// and an idle tile in a red-hued territory reads as a fleet on fire.
export const hueFromPath = (path: string): number => 40 + (hashPath(path) % 280)

/** Stable categorical hue for a model id — shared by the model lens and its legend. */
export const modelHue = (model: string): number => (hashPath(model) * 137) % 360

export const PIP_COLOR: Partial<Record<AgentState, string>> = {
  active: 'bg-yellow-400',
  idle: 'bg-green-400',
  error: 'bg-red-400'
}

export const isDarkMode = () => document.documentElement.classList.contains('dark')

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return `${Math.round(n)}`
}

interface CellStyle {
  fill: string
  stroke: string
  strokeWidth: number
  pulse: boolean
  dashed: boolean
}

/**
 * HIL-gated tile: amber overrides whatever the lens would paint — an agent
 * waiting on the human is the one state that must never blend into terrain.
 */
function pendingFill(dark: boolean): {
  fill: string; stroke: string; strokeWidth: number; pulse: boolean; dashed: boolean
} {
  return { fill: `hsla(40, 90%, ${dark ? 36 : 74}%, 0.7)`, stroke: `hsla(40, 95%, 50%, 0.9)`, strokeWidth: 2.5, pulse: true, dashed: false }
}

/**
 * Lens coloring — replaces state lighting with the answer to one question.
 * Padding cells stay quiet in every lens; needs-you/selection rings render on
 * top regardless (alerts are never lensed away).
 */
export interface LineageInfo {
  hue: number
  depth: number
  familySize: number
  broken: boolean
}

function lensFill(
  lens: 'burn' | 'model' | 'health' | 'lineage',
  dark: boolean,
  agent: FleetAgentStatus | undefined,
  burnHeat: number,
  pending: boolean,
  held: boolean | undefined,
  lineage?: LineageInfo | null
): CellStyle {
  const quiet: CellStyle = {
    fill: `hsla(220, 8%, ${dark ? 18 : 90}%, ${dark ? 0.35 : 0.45})`,
    stroke: `hsla(220, 8%, ${dark ? 34 : 65}%, 0.25)`,
    strokeWidth: 1,
    pulse: false,
    dashed: false
  }
  if (!agent) return quiet

  if (lens === 'burn') {
    if (agent.online === false || burnHeat <= 0) {
      return { ...quiet, dashed: agent.online === false }
    }
    // Cold steel-blue → hot ember; log-scaled upstream so mid burners read
    const hue = 210 - 190 * burnHeat
    return {
      fill: `hsla(${hue}, ${45 + 35 * burnHeat}%, ${dark ? 26 + 16 * burnHeat : 82 - 22 * burnHeat}%, ${0.5 + 0.4 * burnHeat})`,
      stroke: `hsla(${hue}, 70%, ${dark ? 55 : 45}%, ${0.35 + 0.5 * burnHeat})`,
      strokeWidth: 1 + 1.5 * burnHeat,
      pulse: burnHeat > 0.85,
      dashed: false
    }
  }

  if (lens === 'lineage') {
    // Dynasties: each founding root gets a family hue; the root is darkest
    // and every generation steps lighter. Solo agents stay neutral so the
    // families pop; a dashed ring means the parent chain broke (deleted
    // parent) or the agent is offline.
    if (!lineage || lineage.familySize < 2) {
      return { ...quiet, dashed: agent.online === false }
    }
    const step = Math.min(lineage.depth, 4)
    const L = dark ? 26 + step * 9 : 46 + step * 10
    return {
      fill: `hsla(${lineage.hue}, 52%, ${L}%, 0.8)`,
      stroke: `hsla(${lineage.hue}, 58%, ${dark ? Math.min(72, L + 16) : Math.max(28, L - 18)}%, 0.8)`,
      strokeWidth: lineage.depth === 0 ? 2.4 : 1.4,
      pulse: false,
      dashed: lineage.broken || agent.online === false
    }
  }

  if (lens === 'model') {
    if (!agent.model) return { ...quiet, dashed: agent.online === false }
    const hue = modelHue(agent.model)
    const ghost = agent.online === false
    return {
      fill: `hsla(${hue}, ${ghost ? 18 : 48}%, ${dark ? 30 : 80}%, ${ghost ? 0.4 : 0.65})`,
      stroke: `hsla(${hue}, 55%, ${dark ? 55 : 45}%, ${ghost ? 0.3 : 0.6})`,
      strokeWidth: 1.4,
      pulse: false,
      dashed: ghost
    }
  }

  // health — concentrate the problems, mute everything fine
  if (agent.state === 'error') {
    return { fill: `hsla(0, 72%, ${dark ? 34 : 74}%, 0.75)`, stroke: `hsla(0, 80%, 55%, 0.9)`, strokeWidth: 2.5, pulse: true, dashed: false }
  }
  if (pending) {
    return pendingFill(dark)
  }
  if (held) {
    return { fill: `hsla(215, 25%, ${dark ? 32 : 78}%, 0.6)`, stroke: `hsla(215, 30%, 55%, 0.6)`, strokeWidth: 1.5, pulse: false, dashed: false }
  }
  if (agent.online === false) {
    return { ...quiet, dashed: true }
  }
  return {
    fill: `hsla(140, 30%, ${dark ? 24 : 86}%, 0.5)`,
    stroke: `hsla(140, 35%, ${dark ? 42 : 55}%, 0.35)`,
    strokeWidth: 1,
    pulse: false,
    dashed: false
  }
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
  const { dirPath, width, height, cells, members, districts } =
    data as unknown as TerrainNodeData
  const hue = useMemo(() => hueFromPath(dirPath), [dirPath])
  const dark = isDarkMode()

  const agents = useMeshStore((s) => s.agents)
  const nodeActivities = useMeshGraphStore((s) => s.nodeActivities)
  const pendingInteractions = useMeshGraphStore((s) => s.pendingInteractions)
  const focusedFilePath = useMeshGraphStore((s) => s.focusedFilePath)
  const selection = useFleetStore((s) => s.selection)
  const lens = useFleetStore((s) => s.lens)
  const burn = useFleetStore((s) => s.burn)
  const startingMap = useFleetStore((s) => s.starting)
  const hoverDir = useFleetStore((s) => s.hoverDir)

  // Burn lens normalization — log-scaled against the fleet's hottest agent so
  // a 10x spread still reads as a gradient, not one red hex and a cold map
  const burnHeatOf = useMemo(() => {
    const perAgent = burn?.perAgent
    if (!perAgent) return () => 0
    let max = 0
    for (const e of Object.values(perAgent)) max = Math.max(max, e.tokensPerMin)
    if (max <= 0) return () => 0
    const logMax = Math.log1p(max)
    return (filePath: string) => {
      const tpm = perAgent[filePath]?.tokensPerMin ?? 0
      return tpm > 0 ? Math.log1p(tpm) / logMax : 0
    }
  }, [burn])

  // Dynasty index — parent references resolved through the SPEC cascade
  // (current DID → DID history → legacy config.id) via the shared
  // resolveLineage, then walked to the founding root. A parent that rotated
  // its DID keeps its family: children recorded the spawn-time DID, and the
  // cascade matches it against history. Computed only while the lens is up;
  // works identically for ghosts (DIDs come from adf_meta, not executors).
  const lineageIndex = useMemo(() => {
    if (lens !== 'lineage') return null
    const resolved = resolveLineage(agents)
    const orphanSet = new Set(resolved.orphaned)
    const info = new Map<string, { rootPath: string; depth: number; broken: boolean }>()
    const rootCounts = new Map<string, number>()
    for (const a of agents) {
      let cur = a.filePath
      let depth = 0
      const seen = new Set<string>()
      while (depth < 32) {
        const parent = resolved.parents.get(cur)
        if (!parent || seen.has(parent)) break
        seen.add(cur)
        cur = parent
        depth++
      }
      // broken marks the break POINT: a parent reference nobody matched.
      // Its descendants still form a family rooted at the orphan.
      info.set(a.filePath, { rootPath: cur, depth, broken: orphanSet.has(a.filePath) })
      rootCounts.set(cur, (rootCounts.get(cur) ?? 0) + 1)
    }
    return { info, rootCounts }
  }, [lens, agents])

  const lineageOf = (filePath: string): LineageInfo | null => {
    if (!lineageIndex) return null
    const li = lineageIndex.info.get(filePath)
    if (!li) return null
    return {
      hue: hueFromPath(li.rootPath),
      depth: li.depth,
      familySize: lineageIndex.rootCounts.get(li.rootPath) ?? 1,
      broken: li.broken
    }
  }

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

  // Civ-style silhouette: the landmass perimeter gets a firm outline while
  // interior cell borders fade back (strokeOpacity on the cells below) — the
  // cluster reads as one settlement, not a pile of tiles
  const boundaryPath = useMemo(() => hexBoundaryPath(cells, HEX_SIZE - 2), [cells])

  // Voice-chip hover: the whole territory (banner chip) or one district
  // (district chip) gets its border lifted into focus with the chip
  const territoryHovered = hoverDir === dirPath
  const hoveredDistrict = hoverDir && isUnder(hoverDir, dirPath)
    ? hoverDir.slice(dirPath.length + 1)
    : null
  const districtBoundaryPath = useMemo(() => {
    if (!hoveredDistrict) return null
    const owned = cells.filter((c) => c.district === hoveredDistrict)
    return owned.length > 0 ? hexBoundaryPath(owned, HEX_SIZE - 2) : null
  }, [cells, hoveredDistrict])

  return (
    <div className="pointer-events-none relative" style={{ width, height }}>
      <svg width={width} height={height} className="absolute inset-0 overflow-visible">
        {/* Land */}
        {cells.map((cell) => {
          const agent = cell.filePath ? own.get(cell.filePath) : undefined
          const pending = cell.filePath ? pendingInteractions[cell.filePath] : undefined
          // HIL-gated beats every lens: folder-hue terrain made the amber
          // ring invisible, so the whole tile goes amber while it waits
          const style = pending
            ? pendingFill(dark)
            : lens === 'terrain'
              ? cellFill(
                  hue, dark, agent,
                  cell.filePath ? lastActivity(cell.filePath) : 0,
                  cell.district ? districtIndex.get(cell.district) ?? -1 : -1
                )
              : lensFill(lens, dark, agent, cell.filePath ? burnHeatOf(cell.filePath) : 0, !!pending, agent?.held,
                  cell.filePath ? lineageOf(cell.filePath) : null)
          const isFocused = cell.filePath != null && cell.filePath === focusedFilePath
          const isSelected = cell.filePath != null && selectedSet.has(cell.filePath)
          // Booting: start commanded, executor not registered yet — the tile
          // must react to the click instantly, not when the poll catches up
          const isStarting = cell.filePath != null && !!startingMap[cell.filePath] && agent?.online === false
          return (
            <g key={`${cell.q},${cell.r}`}>
              <polygon
                points={hexCorners(cell.x, cell.y, HEX_SIZE - 2)}
                fill={style.fill}
                stroke={style.stroke}
                strokeWidth={style.strokeWidth}
                strokeOpacity={0.4}
                strokeDasharray={style.dashed ? '7 5' : undefined}
                style={style.pulse || isStarting ? { animation: 'hexPulse 2.4s ease-in-out infinite' } : undefined}
              />
              {isStarting && (
                <polygon
                  points={hexCorners(cell.x, cell.y, HEX_SIZE - 10)}
                  fill="none"
                  stroke={dark ? '#5eead4' : '#0d9488'}
                  strokeWidth={3}
                  strokeDasharray="26 17"
                  strokeLinecap="round"
                  style={{ animation: 'hexDashFlow 3.2s linear infinite' }}
                />
              )}
              {pending && (
                // Ring only — the "!" badge lives in the text-twin layer
                // (FleetTerrainLabelNode) so it paints over the unit emoji
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
              {/* Family glow retired — the lineage LENS (L) shows dynasties
                  map-wide with generation shading instead of a per-selection
                  violet ring that never said parent-or-child */}
            </g>
          )
        })}
        {/* Settlement silhouette — firm perimeter over the faded interior;
            lifts into focus with a hovered voice chip */}
        <path
          d={boundaryPath}
          fill="none"
          stroke={territoryHovered
            ? `hsla(${hue}, ${dark ? 45 : 48}%, ${dark ? 66 : 36}%, 0.9)`
            : `hsla(${hue}, ${dark ? 32 : 36}%, ${dark ? 56 : 40}%, ${dark ? 0.55 : 0.5})`}
          strokeWidth={territoryHovered ? 3.5 : 2.5}
          strokeLinecap="round"
          style={{ transition: 'stroke 150ms ease, stroke-width 150ms ease' }}
        />
        {districtBoundaryPath && (
          <path
            d={districtBoundaryPath}
            fill="none"
            stroke={`hsla(${hue}, ${dark ? 45 : 48}%, ${dark ? 66 : 36}%, 0.9)`}
            strokeWidth={3.5}
            strokeLinecap="round"
          />
        )}
      </svg>
    </div>
  )
})
