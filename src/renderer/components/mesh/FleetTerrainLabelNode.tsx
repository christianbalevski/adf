import { memo, useMemo } from 'react'
import { useStore } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { useMeshStore } from '../../stores/mesh.store'
import { useMeshGraphStore } from '../../stores/mesh-graph.store'
import { useFleetStore } from '../../stores/fleet.store'
import { HEX_SIZE, HEX_COL_W, HEX_ROW_H, type TerrainNodeData } from './fleet-layout'
import { hueFromPath, isDarkMode, truncate, formatTokens, PIP_COLOR } from './FleetTerrainNode'
import type { FleetAgentStatus } from '../../../shared/types/ipc.types'

/**
 * Text layer of a territory — identity (icon/name/status/vitals), badges,
 * district labels and the banner, rendered as a separate node ABOVE the edge
 * layer so message traces run under the words, never through them. The land
 * polygons live in FleetTerrainNode (below the edges); this node shares its
 * exact position and data. pointer-events: none throughout — labels are
 * scenery to the mouse.
 */
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export const FleetTerrainLabelNode = memo(function FleetTerrainLabelNode({ data }: NodeProps) {
  const { label, dirPath, width, height, cells, members, districts } =
    data as unknown as TerrainNodeData
  const hue = useMemo(() => hueFromPath(dirPath), [dirPath])
  const dark = isDarkMode()
  // Semantic zoom for labels: far out the territory banner dominates; zooming
  // in shrinks it out of the way while district labels fade into focus.
  const zoom = useStore((s) => s.transform[2])

  const agents = useMeshStore((s) => s.agents)
  const nodeActivities = useMeshGraphStore((s) => s.nodeActivities)
  const pendingInteractions = useMeshGraphStore((s) => s.pendingInteractions)
  const burn = useFleetStore((s) => s.burn)
  const stewards = useFleetStore((s) => s.stewards)
  const startingMap = useFleetStore((s) => s.starting)

  const memberPaths = useMemo(() => new Set(members.map((m) => m.filePath)), [members])
  const own = useMemo(
    () => new Map(agents.filter((a) => memberPaths.has(a.filePath)).map((a) => [a.filePath, a])),
    [agents, memberPaths]
  )
  const iconByPath = useMemo(() => new Map(members.map((m) => [m.filePath, m.icon])), [members])

  // Stewards — directory → the member agent whose DID exactly matches the
  // designation. No history cascade: if a DID rotates, the user reappoints.
  const stewardByDir = useMemo(() => {
    const map = new Map<string, FleetAgentStatus>()
    for (const a of own.values()) {
      if (!a.did) continue
      const dir = a.filePath.slice(0, a.filePath.lastIndexOf('/'))
      if (stewards[dir] === a.did) map.set(dir, a)
    }
    return map
  }, [own, stewards])
  const stewardCells = useMemo(() => {
    const set = new Set<string>()
    for (const a of stewardByDir.values()) set.add(a.filePath)
    return set
  }, [stewardByDir])

  const labelColor = dark ? `hsla(${hue}, 35%, 72%, 0.95)` : `hsla(${hue}, 35%, 36%, 0.95)`
  const nameColor = dark ? 'rgba(235,235,235,0.95)' : 'rgba(45,45,45,0.95)'
  const statusColor = dark ? 'rgba(190,190,190,0.75)' : 'rgba(90,90,90,0.75)'
  const metaColor = dark ? 'rgba(160,160,160,0.6)' : 'rgba(120,120,120,0.65)'

  // Banner anchor — center of mass and bottom edge of the OCCUPIED cells.
  // The padding ring sits a full row lower and skews the centroid, which is
  // what made labels float away from their clusters.
  const bannerAnchor = useMemo(() => {
    const occupied = cells.filter((c) => c.filePath)
    const base = occupied.length > 0 ? occupied : cells
    const cx = base.reduce((s, c) => s + c.x, 0) / Math.max(1, base.length)
    const bottom = Math.max(...base.map((c) => c.y)) + HEX_ROW_H * 0.72
    const span = Math.max(...base.map((c) => c.x)) - Math.min(...base.map((c) => c.x)) + HEX_COL_W * 2
    return { x: cx, y: bottom, span }
  }, [cells])

  // District labels — anchored under each satellite cluster (mirroring the
  // territory banner) with the district's voice: its steward if appointed,
  // otherwise the most recently active member.
  const districtLabels = useMemo(() => {
    return districts.map((district) => {
      // Occupied cells only — the padding ring sits a row lower and skews
      // both the centroid and the bottom edge away from the actual plot
      const owned = cells.filter((c) => c.district === district && c.filePath)
      if (owned.length === 0) return null
      const cx = owned.reduce((s, c) => s + c.x, 0) / owned.length
      const bottom = Math.max(...owned.map((c) => c.y))

      let voice = stewardByDir.get(`${dirPath}/${district}`)
      let isSteward = !!voice
      if (!voice) {
        let bestAt = -1
        for (const c of owned) {
          if (!c.filePath) continue
          const a = own.get(c.filePath)
          if (!a) continue
          const acts = nodeActivities[c.filePath]
          const last = acts && acts.length > 0 ? acts[acts.length - 1].timestamp : 0
          const score = a.state === 'active' ? last + 1e15 : last
          if (score > bestAt) {
            bestAt = score
            voice = a
          }
        }
        isSteward = false
      }
      const span = Math.max(...owned.map((c) => c.x)) - Math.min(...owned.map((c) => c.x)) + HEX_COL_W * 1.6
      // Baseline sits well past the lowest tile's bottom edge (0.5 rows),
      // floating over the padding land rather than across the tile row
      return { district, x: cx, y: bottom + HEX_ROW_H * 0.88, voice, isSteward, span }
    }).filter((d): d is NonNullable<typeof d> => d !== null)
  }, [districts, cells, dirPath, stewardByDir, own, nodeActivities])

  return (
    <div className="pointer-events-none relative" style={{ width, height }}>
      <svg width={width} height={height} className="absolute inset-0 overflow-visible">
        {/* District labels — bottom-anchored like the territory banner, sized
            for a roughly constant screen footprint and faded in as you zoom
            toward them (far out, the territory banner carries the story) */}
        {(() => {
          // Fade in as the user zooms toward the mid-band, then step back a
          // little at close range where the tiles themselves carry the detail
          const districtOpacity =
            clamp((zoom - 0.26) / 0.22, 0, 1) * clamp(1.45 - 0.55 * zoom, 0.6, 1)
          if (districtOpacity === 0) return null
          return districtLabels.map((d) => {
            // Screen-constant size, capped so long names fit their cluster
            const nameSize = Math.min(
              clamp(34 / zoom, 30, 92),
              Math.max(26, (d.span * 1.1) / (0.6 * Math.max(4, d.district.length)))
            )
            return (
              <g key={`district-${d.district}`} style={{ userSelect: 'none' }} opacity={districtOpacity}>
                <text x={d.x} y={d.y} textAnchor="middle" fontSize={nameSize} fontWeight={700} fill={labelColor}>
                  {d.district}
                </text>
              </g>
            )
          })
        })()}

        {/* Units — identity is part of the tile, scaling continuously */}
        {cells.map((cell) => {
          if (!cell.filePath) return null
          const agent = own.get(cell.filePath)
          const icon = iconByPath.get(cell.filePath)
          const handle = agent?.handle ?? members.find((m) => m.filePath === cell.filePath)?.handle ?? ''
          const booting = agent?.online === false && !!startingMap[cell.filePath]
          const status = agent?.online === false
            ? booting ? 'starting up…' : 'not started'
            : agent?.status || agent?.state || ''
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
              {stewardCells.has(cell.filePath) && (
                <g transform={`translate(${cell.x - HEX_SIZE * 0.52}, ${cell.y - HEX_SIZE * 0.62})`}>
                  <circle r={16} fill={dark ? 'rgba(64,64,64,0.9)' : 'rgba(250,250,250,0.9)'} stroke={labelColor} strokeWidth={1.5} />
                  <text y={6} textAnchor="middle" fontSize={17} fill={labelColor}>♛</text>
                </g>
              )}
            </g>
          )
        })}
      </svg>

      {/* District voice chips — HTML so the text can wrap (3-line clamp) on
          a subtle backing that keeps stacked labels from competing. Hover
          focuses the chip; click opens the full group readout. */}
      {(() => {
        const districtOpacity =
          clamp((zoom - 0.26) / 0.22, 0, 1) * clamp(1.45 - 0.55 * zoom, 0.6, 1)
        if (districtOpacity === 0) return null
        return districtLabels.map((d) => {
          if (!d.voice || (!d.voice.status && !d.voice.handle)) return null
          const nameSize = Math.min(
            clamp(34 / zoom, 30, 92),
            Math.max(26, (d.span * 1.1) / (0.6 * Math.max(4, d.district.length)))
          )
          const voiceSize = nameSize * 0.5
          return (
            <div
              key={`voice-${d.district}`}
              className="fleet-voice-chip absolute pointer-events-auto cursor-pointer"
              style={{
                left: d.x,
                top: d.y + nameSize * 0.45,
                transform: 'translateX(-50%)',
                maxWidth: Math.max(d.span * 1.25, 560),
                opacity: districtOpacity,
                fontSize: voiceSize,
                lineHeight: 1.3,
                padding: `${voiceSize * 0.3}px ${voiceSize * 0.7}px`,
                borderRadius: voiceSize,
                background: dark ? 'rgba(20, 24, 28, 0.72)' : 'rgba(255, 255, 255, 0.78)',
                border: `1.5px solid hsla(${hue}, 30%, ${dark ? 55 : 45}%, 0.35)`,
                color: statusColor
              }}
              onClick={() => useFleetStore.getState().setReadoutDir(`${dirPath}/${d.district}`)}
              title="Click for the full group readout"
            >
              <span style={{ display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                <span style={{ fontWeight: 600, color: nameColor }}>
                  {d.isSteward ? '♛ ' : ''}{d.voice.handle}
                </span>
                {d.voice.status ? <span style={{ fontStyle: 'italic' }}> — {d.voice.status}</span> : null}
              </span>
            </div>
          )
        })
      })()}

      {/* Banner under the cluster — pips + the territory's voice: the root
          steward when one is appointed, otherwise the most active agent.
          Anchored to the cells' centroid and bottom edge, not the bounding
          box, so the label visibly belongs to its cluster. */}
      <TerritoryBanner label={label} hue={hue} own={own} nodeActivities={nodeActivities}
        pendingCount={members.filter((m) => pendingInteractions[m.filePath]).length}
        steward={stewardByDir.get(dirPath)}
        anchor={bannerAnchor} dark={dark} zoom={zoom} dir={dirPath} />
    </div>
  )
})

function TerritoryBanner({
  label,
  hue,
  own,
  nodeActivities,
  pendingCount,
  steward,
  anchor,
  dark,
  zoom,
  dir
}: {
  label: string
  hue: number
  own: Map<string, FleetAgentStatus>
  nodeActivities: Record<string, { timestamp: number }[]>
  pendingCount: number
  /** Appointed voice of the territory — overrides the most-active heuristic */
  steward?: FleetAgentStatus
  /** Cell-mass centroid x, bottom-edge y, and horizontal span of the cluster */
  anchor: { x: number; y: number; span: number }
  dark: boolean
  zoom: number
  /** Tracked-dir path — the group readout target when the chip is clicked */
  dir: string
}) {
  const { pips, star } = useMemo(() => {
    const counts: Record<string, number> = {}
    let star: { handle: string; icon?: string; status?: string; steward?: boolean } | null = null
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
    if (steward) {
      star = { handle: steward.handle, icon: steward.icon, status: steward.status, steward: true }
    }
    return { pips: counts, star }
  }, [own, nodeActivities, steward])

  // Zoom-adaptive: the banner leads the story from orbit (grows as you zoom
  // out) and hands over to districts and tiles as you zoom in — a crossfade,
  // not a pile-up: by the time local labels are legible the banner is a
  // faint watermark.
  const base = Math.max(30, Math.min(120, anchor.span * 0.1))
  const zoomBoost = Math.min(2.4, Math.max(0.5, 0.55 / zoom))
  // Long names shrink to fit their cluster instead of truncating to "adf_pla…"
  const fitCap = (anchor.span * 1.15) / (0.6 * Math.max(4, label.length))
  const nameSize = Math.max(24, Math.min(280, Math.min(base * zoomBoost, fitCap)))
  const subSize = Math.max(14, nameSize * 0.34)
  const pipSize = Math.max(10, nameSize * 0.22)
  const bannerOpacity = Math.min(1, Math.max(0.1, 1 - (zoom - 0.32) * 2.2))

  const nameColor = dark ? `hsla(${hue}, 40%, 76%, 0.95)` : `hsla(${hue}, 34%, 34%, 0.9)`
  const chipBg = dark ? `hsla(${hue}, 30%, 14%, 0.9)` : `hsla(${hue}, 45%, 97%, 0.9)`
  const chipBorder = `hsla(${hue}, 30%, 55%, 0.4)`
  const chipText = dark ? 'rgba(229,229,229,0.95)' : 'rgba(64,64,64,0.95)'

  return (
    <div
      className="absolute flex flex-col items-center select-none w-max"
      style={{
        left: anchor.x,
        top: anchor.y,
        transform: 'translateX(-50%)',
        // Generous cap — the voice chip carries the group's status line, the
        // most load-bearing text on the map; don't let the territory name's
        // width starve it
        maxWidth: Math.max(anchor.span * 1.5, 640),
        opacity: bannerOpacity
      }}
    >
      <span className="font-bold tracking-wide whitespace-nowrap leading-none" style={{ color: nameColor, fontSize: nameSize }}>
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
          className="fleet-voice-chip flex items-center mt-2 rounded-full border max-w-[96%] pointer-events-auto cursor-pointer"
          style={{ backgroundColor: chipBg, borderColor: chipBorder, gap: subSize * 0.4, padding: `${subSize * 0.28}px ${subSize * 0.85}px` }}
          onClick={() => useFleetStore.getState().setReadoutDir(dir)}
          title="Click for the full group readout"
        >
          {star.steward && <span className="leading-none" style={{ fontSize: subSize, color: nameColor }}>♛</span>}
          {star.icon && <span className="leading-none" style={{ fontSize: subSize * 1.1 }}>{star.icon}</span>}
          <span className="font-semibold whitespace-nowrap" style={{ fontSize: subSize, color: chipText }}>
            {star.handle}
          </span>
          {star.status && (
            <span
              className="opacity-70"
              style={{
                fontSize: subSize * 0.9,
                color: chipText,
                // Two lines, not a hard truncate — the steward's status is
                // the group's status, the most load-bearing text up here
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden'
              }}
            >
              — {star.status}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
