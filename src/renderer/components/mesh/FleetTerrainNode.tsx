import { memo, useMemo } from 'react'
import { useStore } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { useMeshStore } from '../../stores/mesh.store'
import { useMeshGraphStore } from '../../stores/mesh-graph.store'
import type { TerrainNodeData } from './fleet-layout'
import type { AgentState } from '../../../shared/types/ipc.types'

/**
 * Territory background — one per tracked directory ('root' variant), plus
 * lighter district plots for subdirectories ('sub'). Static geography:
 * rendered behind agent nodes, not draggable or selectable.
 *
 * Civ-style rendering: each territory is an organic hash-seeded blob (not a
 * rectangle) filled with a faint hex-tile grid, tinted by a deterministic
 * per-path hue. Semantic zoom: up close it's a quiet labeled region; zoomed
 * out the territory takes over the storytelling — big scaled name, state
 * pips, and a banner for the most recently active agent — so a distant map
 * still reads like a strategy-game overview.
 */

/** Small stable string hash → uint. */
function hashPath(path: string): number {
  let h = 0
  for (let i = 0; i < path.length; i++) {
    h = (h * 31 + path.charCodeAt(i)) | 0
  }
  return h >>> 0
}

const hueFromPath = (path: string): number => hashPath(path) % 360

/** Cheap seeded PRNG (mulberry32) for deterministic per-territory jitter. */
function seededRandom(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Organic blob path: sample points around the rect perimeter, jitter them
 * inward with a seeded PRNG, then smooth with quadratic midpoint curves.
 */
function blobPath(width: number, height: number, seed: number): string {
  const rand = seededRandom(seed)
  const inset = Math.min(28, Math.min(width, height) * 0.06)
  const jitter = () => inset * (0.3 + rand() * 0.7)

  // Perimeter sample count scales with size so big territories stay organic
  const per = 2 * (width + height)
  const n = Math.max(8, Math.min(22, Math.round(per / 420)))
  const pts: [number, number][] = []
  for (let i = 0; i < n; i++) {
    const t = (i / n) * per
    let x: number
    let y: number
    if (t < width) {
      x = t
      y = 0 + jitter()
    } else if (t < width + height) {
      x = width - jitter()
      y = t - width
    } else if (t < 2 * width + height) {
      x = width - (t - width - height)
      y = height - jitter()
    } else {
      x = 0 + jitter()
      y = height - (t - 2 * width - height)
    }
    pts.push([x, y])
  }

  const mid = (a: [number, number], b: [number, number]): [number, number] =>
    [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
  let d = `M ${mid(pts[0], pts[1])[0].toFixed(1)} ${mid(pts[0], pts[1])[1].toFixed(1)}`
  for (let i = 1; i <= n; i++) {
    const p = pts[i % n]
    const m = mid(pts[i % n], pts[(i + 1) % n])
    d += ` Q ${p[0].toFixed(1)} ${p[1].toFixed(1)} ${m[0].toFixed(1)} ${m[1].toFixed(1)}`
  }
  return d + ' Z'
}

/** Flat-top hexagon outline for the tile pattern (28px wide). */
const HEX_TILE = 'M7,0 L21,0 L28,12 L21,24 L7,24 L0,12 Z'

const PIP_COLOR: Partial<Record<AgentState, string>> = {
  active: 'bg-yellow-400',
  idle: 'bg-green-400',
  error: 'bg-red-400'
}

const isDarkMode = () => document.documentElement.classList.contains('dark')

export const FleetTerrainNode = memo(function FleetTerrainNode({ data }: NodeProps) {
  const { label, dirPath, agentCount, width, height, variant, members } = data as unknown as TerrainNodeData
  const isSub = variant === 'sub'
  const hue = useMemo(() => hueFromPath(dirPath), [dirPath])
  const dark = isDarkMode()

  // Far-zoom banner kicks in when agent nodes have collapsed to dots
  const farView = useStore((s) => s.transform[2] < 0.4)

  const path = useMemo(() => blobPath(width, height, hashPath(dirPath)), [width, height, dirPath])
  const patternId = useMemo(() => `hex-${hashPath(dirPath).toString(36)}`, [dirPath])

  const fill = dark
    ? `hsla(${hue}, 34%, 42%, ${isSub ? 0.10 : 0.13})`
    : `hsla(${hue}, 42%, 55%, ${isSub ? 0.06 : 0.09})`
  const stroke = dark
    ? `hsla(${hue}, 32%, 62%, ${isSub ? 0.3 : 0.45})`
    : `hsla(${hue}, 30%, 45%, ${isSub ? 0.3 : 0.45})`
  const hexStroke = dark
    ? `hsla(${hue}, 40%, 68%, 0.10)`
    : `hsla(${hue}, 45%, 42%, 0.09)`
  const labelColor = dark ? `hsla(${hue}, 35%, 72%, 0.95)` : `hsla(${hue}, 35%, 38%, 0.95)`

  return (
    <div className="pointer-events-none relative" style={{ width, height }}>
      {/* Territory silhouette + hex tiles */}
      <svg width={width} height={height} className="absolute inset-0">
        <defs>
          <pattern id={patternId} width="42" height="24" patternUnits="userSpaceOnUse">
            <path d={HEX_TILE} transform="scale(0.98)" fill="none" stroke={hexStroke} strokeWidth="1" />
            <path d={HEX_TILE} transform="translate(21,12) scale(0.98)" fill="none" stroke={hexStroke} strokeWidth="1" />
          </pattern>
        </defs>
        <path d={path} fill={fill} stroke={stroke} strokeWidth={isSub ? 1 : 1.5} strokeDasharray={isSub ? '5 4' : '9 5'} />
        {!isSub && <path d={path} fill={`url(#${patternId})`} stroke="none" />}
      </svg>

      {/* Near-zoom corner header */}
      {!farView && (
        <div className={`relative flex items-center gap-1.5 select-none ${isSub ? 'px-4 py-2' : 'px-5 py-3'}`}>
          <svg
            width={isSub ? 10 : 12}
            height={isSub ? 10 : 12}
            viewBox="0 0 24 24"
            fill="none"
            stroke={labelColor}
            strokeWidth="2"
            className="shrink-0"
          >
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
          <span
            className={`font-medium truncate ${isSub ? 'text-[10px]' : 'text-[11px]'}`}
            style={{ color: labelColor }}
            title={dirPath || undefined}
          >
            {label}
          </span>
          <span className={`${isSub ? 'text-[9px]' : 'text-[10px]'} opacity-60`} style={{ color: labelColor }}>
            {agentCount}
          </span>
        </div>
      )}

      {/* Far-zoom labels — the distant map keeps telling the story */}
      {farView && isSub && (
        <div className="absolute inset-0 flex items-center justify-center select-none">
          <span
            className="font-semibold tracking-wide truncate max-w-[90%]"
            style={{ color: labelColor, fontSize: Math.max(20, Math.min(44, height * 0.11)) }}
          >
            {label} <span className="opacity-60">{agentCount}</span>
          </span>
        </div>
      )}
      {farView && !isSub && (
        <TerritoryBanner label={label} hue={hue} members={members} width={width} height={height} dark={dark} />
      )}
    </div>
  )
})

function TerritoryBanner({
  label,
  hue,
  members,
  width,
  height,
  dark
}: {
  label: string
  hue: number
  members: TerrainNodeData['members']
  width: number
  height: number
  dark: boolean
}) {
  const agents = useMeshStore((s) => s.agents)
  const nodeActivities = useMeshGraphStore((s) => s.nodeActivities)

  const { pips, star, needsYou } = useMemo(() => {
    const memberPaths = new Set(members.map((m) => m.filePath))
    const own = agents.filter((a) => memberPaths.has(a.filePath))
    const counts: Record<string, number> = {}
    for (const a of own) {
      const key = !a.online ? 'offline' : a.state
      counts[key] = (counts[key] ?? 0) + 1
    }
    const pendingMap = useMeshGraphStore.getState().pendingInteractions
    const needsYou = own.filter((a) => pendingMap[a.filePath]).length
    // Most recently active member gets the banner
    let star: { handle: string; icon?: string; status?: string } | null = null
    let bestAt = -1
    for (const a of own) {
      const acts = nodeActivities[a.filePath]
      const last = acts && acts.length > 0 ? acts[acts.length - 1].timestamp : 0
      const score = a.state === 'active' ? last + 1e15 : last
      if (score > bestAt) {
        bestAt = score
        star = { handle: a.handle, icon: a.icon, status: a.status }
      }
    }
    return { pips: counts, star, needsYou }
  }, [agents, nodeActivities, members])

  // Type scales with territory size so big regions stay legible from orbit
  const nameSize = Math.max(30, Math.min(150, Math.min(width, height) * 0.13))
  const subSize = Math.max(14, nameSize * 0.34)
  const pipSize = Math.max(10, nameSize * 0.24)

  const nameColor = dark ? `hsla(${hue}, 40%, 74%, 0.95)` : `hsla(${hue}, 32%, 38%, 0.85)`
  const chipBg = dark ? `hsla(${hue}, 30%, 16%, 0.85)` : `hsla(${hue}, 40%, 96%, 0.85)`
  const chipBorder = dark ? `hsla(${hue}, 30%, 55%, 0.4)` : `hsla(${hue}, 30%, 55%, 0.35)`
  const chipText = dark ? 'rgba(229,229,229,0.95)' : 'rgba(64,64,64,0.95)'

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center select-none px-4">
      <span
        className="font-bold tracking-wide truncate max-w-full leading-none"
        style={{ color: nameColor, fontSize: nameSize }}
      >
        {label}
      </span>
      <div className="flex items-center mt-3" style={{ gap: pipSize * 0.8, fontSize: subSize }}>
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
            <span
              className="rounded-full border-2 border-dashed"
              style={{ width: pipSize, height: pipSize, borderColor: nameColor }}
            />
            {pips.offline}
          </span>
        ) : null}
        {needsYou > 0 && (
          <span className="flex items-center font-bold text-amber-500" style={{ gap: pipSize * 0.35 }}>
            <span className="rounded-full bg-amber-400 animate-pulse" style={{ width: pipSize, height: pipSize }} />
            {needsYou}
          </span>
        )}
      </div>
      {star && (
        <div
          className="flex items-center mt-4 rounded-full border max-w-[92%]"
          style={{
            backgroundColor: chipBg,
            borderColor: chipBorder,
            gap: subSize * 0.4,
            padding: `${subSize * 0.3}px ${subSize * 0.9}px`
          }}
        >
          {star.icon && <span className="leading-none" style={{ fontSize: subSize * 1.15 }}>{star.icon}</span>}
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
