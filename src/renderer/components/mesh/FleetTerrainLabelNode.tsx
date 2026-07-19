import { memo, useMemo } from 'react'
import { useStore } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { useMeshStore } from '../../stores/mesh.store'
import { useMeshGraphStore } from '../../stores/mesh-graph.store'
import { useFleetStore } from '../../stores/fleet.store'
import { HEX_SIZE, HEX_COL_W, HEX_ROW_H, joinDir, pathDirname, type TerrainNodeData } from './fleet-layout'
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

/**
 * Wrap a status line onto at most two centered lines — the hex is widest at
 * its mid-band, so wrapping beats the old single-line truncation that cut
 * most statuses down to noise.
 */
function wrapTwo(s: string, max: number): string[] {
  if (s.length <= max) return [s]
  let cut = s.lastIndexOf(' ', max)
  if (cut < max * 0.55) cut = max
  const first = s.slice(0, cut)
  let rest = s.slice(cut).trimStart()
  if (rest.length > max) rest = rest.slice(0, max - 1) + '…'
  return [first, rest]
}

/** One-line "what it's doing right now" from the newest activity entry. */
function liveActivityLine(act: { type: string; toolName: string; args?: string; isError?: boolean }): string {
  const mark =
    act.type === 'tool_start' ? (act.isError === undefined ? '▸' : act.isError ? '✗' : '✓')
    : act.type === 'llm' ? '◈'
    : act.type === 'message_sent' ? '›'
    : act.type === 'message_recv' ? '‹'
    : act.type === 'error' ? '!'
    : '·'
  return truncate(`${mark} ${act.toolName}${act.args ? ' ' + act.args : ''}`, 32)
}

/**
 * District name size — tracks a ~34px screen size so names read from far
 * orbit, with a world-unit cap so a zoomed-out label can't dwarf its plot
 * and a fit cap so long names stay inside their cluster's width.
 */
const districtNameSize = (zoom: number, span: number, nameLen: number) =>
  Math.min(clamp(34 / zoom, 30, 150), Math.max(26, (span * 1.1) / (0.6 * Math.max(4, nameLen))))


export const FleetTerrainLabelNode = memo(function FleetTerrainLabelNode({ data }: NodeProps) {
  const { label, dirPath, width, height, cells, members, districts } =
    data as unknown as TerrainNodeData
  const hue = useMemo(() => hueFromPath(dirPath), [dirPath])
  const dark = isDarkMode()
  // Semantic zoom for labels: far out the territory banner dominates; zooming
  // in shrinks it out of the way while district labels fade into focus.
  const zoom = useStore((s) => s.transform[2])

  const agents = useMeshStore((s) => s.agents)
  const pendingInteractions = useMeshGraphStore((s) => s.pendingInteractions)
  // Live activity feed — the tile's "what am I doing" line. The terrain twin
  // already re-renders per activity event for recency lighting, so this
  // subscription adds no new re-render cadence.
  const nodeActivities = useMeshGraphStore((s) => s.nodeActivities)
  const burn = useFleetStore((s) => s.burn)
  const stewards = useFleetStore((s) => s.stewards)
  const startingMap = useFleetStore((s) => s.starting)
  const hoverDir = useFleetStore((s) => s.hoverDir)

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
      const dir = pathDirname(a.filePath)
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

  // District name labels — anchored just OUTSIDE each satellite plot, on the
  // side facing away from the territory's center of mass: a north district
  // labels above itself, everything else below. Outward labels never print
  // across interior tiles, and only south districts share the banner's band
  // (the banner yields to them — see the clearance pass in render). The
  // group STATUS lives in FleetVoicesLayer, screen-space above the canvas.
  const districtLabels = useMemo(() => {
    const occupiedAll = cells.filter((c) => c.filePath)
    const centroidY = occupiedAll.reduce((s, c) => s + c.y, 0) / Math.max(1, occupiedAll.length)
    return districts.map((district) => {
      // Occupied cells only — the padding ring sits a row lower and skews
      // both the centroid and the edges away from the actual plot
      const owned = cells.filter((c) => c.district === district && c.filePath)
      if (owned.length === 0) return null
      const cx = owned.reduce((s, c) => s + c.x, 0) / owned.length
      const cy = owned.reduce((s, c) => s + c.y, 0) / owned.length
      const bottom = Math.max(...owned.map((c) => c.y))
      const top = Math.min(...owned.map((c) => c.y))
      const span = Math.max(...owned.map((c) => c.x)) - Math.min(...owned.map((c) => c.x)) + HEX_COL_W * 1.6
      const side: 'top' | 'bottom' = cy < centroidY - HEX_ROW_H * 0.4 ? 'top' : 'bottom'
      // Baseline sits well past the plot's edge tiles, floating over the
      // padding land rather than across the tile row
      const y = side === 'top' ? top - HEX_ROW_H * 0.72 : bottom + HEX_ROW_H * 0.92
      return { district, x: cx, y, side, span }
    }).filter((d): d is NonNullable<typeof d> => d !== null)
  }, [districts, cells])

  // Districts fade in from far orbit (they used to wait for mid-zoom), then
  // step back a little at close range where the tiles carry the detail
  const districtFadeIn = clamp((zoom - 0.13) / 0.15, 0, 1)
  const districtOpacity = districtFadeIn * clamp(1.45 - 0.55 * zoom, 0.6, 1)

  // Banner name size — computed here (and passed down) so the clearance
  // pass below can estimate the banner's box
  const bannerNameSize = (() => {
    const base = Math.max(30, Math.min(120, bannerAnchor.span * 0.1))
    const zoomBoost = Math.min(2.4, Math.max(0.5, 0.55 / zoom))
    const fitCap = (bannerAnchor.span * 1.15) / (0.6 * Math.max(4, label.length))
    return Math.max(24, Math.min(280, Math.min(base * zoomBoost, fitCap)))
  })()

  // Clearance pass: a south district's name owns the band under the
  // territory — when the banner's box overlaps one in x, the banner yields
  // and slides below it instead of printing across it. (Voice chips float
  // over the plots now, so only the names compete here.)
  let bannerDrop = 0
  if (districtFadeIn > 0) {
    const bannerHalfW = Math.max((bannerNameSize * 0.6 * label.length) / 2, 340)
    for (const d of districtLabels) {
      if (d.side !== 'bottom') continue
      const size = districtNameSize(zoom, d.span, d.district.length)
      const dHalfW = Math.max(d.span * 0.65, (size * 0.6 * d.district.length) / 2)
      if (Math.abs(d.x - bannerAnchor.x) > dHalfW + bannerHalfW) continue
      const dBottom = d.y + size * 0.15
      bannerDrop = Math.max(bannerDrop, dBottom + Math.max(24, size * 0.35) - bannerAnchor.y)
    }
  }
  // Drop ramps twice as fast as the label opacity so the banner is already
  // clear of the band by the time the chips become readable
  const bannerY = bannerAnchor.y + Math.max(0, bannerDrop) * Math.min(1, districtFadeIn * 2)

  return (
    <div className="pointer-events-none relative" style={{ width, height }}>
      <svg width={width} height={height} className="absolute inset-0 overflow-visible">
        {/* District labels — anchored outward of their plot, sized for a
            roughly constant screen footprint and faded in from far orbit
            (farther out still, the territory banner carries the story) */}
        {(() => {
          if (districtOpacity === 0) return null
          return districtLabels.map((d) => {
            const nameSize = districtNameSize(zoom, d.span, d.district.length)
            const hovered = hoverDir === joinDir(dirPath, d.district)
            return (
              <g key={`district-${d.district}`} style={{ userSelect: 'none' }} opacity={districtOpacity}>
                <text
                  x={d.x} y={d.y} textAnchor="middle" fontSize={nameSize} fontWeight={700}
                  fill={hovered ? (dark ? `hsla(${hue}, 45%, 82%, 1)` : `hsla(${hue}, 45%, 28%, 1)`) : labelColor}
                >
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
          const isGhostUnit = agent?.online === false
          const held = agent?.held

          // LOD — below nameZoom the tile is icon + lighting + badges (text
          // would be under ~4px on screen); detail text joins at detailZoom.
          const showName = zoom >= 0.14
          const showDetail = zoom >= 0.3

          // Name shrinks to fit the hex's mid-band instead of truncating at
          // a fixed length ("patternsca…"); only truly long names still clip.
          const nameFit = 240 / (0.62 * Math.max(6, handle.length))
          const nameSize = clamp(nameFit, 14, 26)
          // Truncate only when shrinking bottomed out at the 14px floor —
          // any name the fit formula sized fits by construction
          const name = nameFit < 14 ? truncate(handle, 26) : handle

          // Text stack, live-first: an ACTIVE agent shows its current tool
          // call (the status quote is stale the moment work starts); everyone
          // else gets their status wrapped onto up to two lines.
          const acts = nodeActivities[cell.filePath]
          const lastAct = acts && acts.length > 0 ? acts[acts.length - 1] : undefined
          const isLive = !isGhostUnit && agent?.state === 'active' && !!lastAct
          const statusLines = isGhostUnit
            ? [booting ? 'starting up…' : 'not started']
            : isLive
              ? [liveActivityLine(lastAct!)]
              : wrapTwo(String(agent?.status || agent?.state || ''), 28)

          // Vitals: burn only — the model id is hover-card/readout material
          // (and has its own lens); lifetime Σ + live rate is what commands.
          const agentBurn = burn?.perAgent[cell.filePath]
          const meta = agentBurn && agentBurn.totalTokens > 0
            ? `Σ ${formatTokens(agentBurn.totalTokens)}${agentBurn.tokensPerMin > 0 ? ` · ${formatTokens(agentBurn.tokensPerMin)}/m` : ''}`
            : ''

          // Context gauge — the RTS health bar: fullness of the context
          // window against the auto-compact threshold.
          const ctxFrac = !isGhostUnit && agent?.contextTokens && agent?.contextThreshold
            ? Math.min(1, agent.contextTokens / agent.contextThreshold)
            : null
          const stateDot = isGhostUnit
            ? null
            : agent?.state === 'active' ? '#facc15'
            : agent?.state === 'error' ? '#f87171'
            : agent?.state === 'idle' ? '#4ade80'
            : '#a3a3a3'
          return (
            <g
              key={`unit-${cell.q},${cell.r}`}
              opacity={isGhostUnit ? 0.45 : 1}
              style={{ userSelect: 'none', filter: isGhostUnit ? 'grayscale(0.9)' : undefined }}
            >
              <text x={cell.x} y={cell.y - 26} textAnchor="middle" fontSize={86}>
                {icon}
              </text>
              {showName && (
                <>
                  <text
                    x={cell.x}
                    y={cell.y + 44}
                    textAnchor="middle"
                    fontSize={nameSize}
                    fontWeight={600}
                    fill={nameColor}
                  >
                    {name}
                  </text>
                  {/* State dot beside the name — a colorblind-safe second
                      encoding (the hex fill alone had to carry state) */}
                  {stateDot && (
                    <circle
                      cx={cell.x - (0.62 * nameSize * name.length) / 2 - 12}
                      cy={cell.y + 44 - nameSize * 0.32}
                      r={5}
                      fill={stateDot}
                      style={agent?.state === 'active' ? { animation: 'hexPulse 1.6s ease-in-out infinite' } : undefined}
                    />
                  )}
                </>
              )}
              {showDetail && statusLines[0] && (
                <text
                  x={cell.x} y={cell.y + 70} textAnchor="middle" fontSize={16}
                  fontStyle={isLive ? undefined : 'italic'}
                  fontFamily={isLive ? 'ui-monospace, monospace' : undefined}
                  fill={statusColor}
                >
                  {statusLines[0]}
                </text>
              )}
              {showDetail && statusLines[1] && (
                <text x={cell.x} y={cell.y + 90} textAnchor="middle" fontSize={16} fontStyle="italic" fill={statusColor}>
                  {statusLines[1]}
                </text>
              )}
              {showDetail && meta && (
                <text x={cell.x} y={cell.y + 112} textAnchor="middle" fontSize={13} fill={metaColor}>
                  {meta}
                </text>
              )}
              {showDetail && ctxFrac !== null && (
                <g>
                  <rect
                    x={cell.x - 55} y={cell.y + 120} width={110} height={5} rx={2.5}
                    fill={dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.10)'}
                  />
                  <rect
                    x={cell.x - 55} y={cell.y + 120}
                    width={Math.max(4, 110 * ctxFrac)} height={5} rx={2.5}
                    fill={`hsla(${ctxFrac > 0.85 ? 0 : ctxFrac > 0.6 ? 40 : 145}, 70%, ${dark ? 55 : 45}%, 0.9)`}
                  />
                </g>
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
              {/* HIL "!" — lives in this text layer (not the terrain svg)
                  so it paints OVER the unit emoji, not under it */}
              {pendingInteractions[cell.filePath] && (
                <g
                  transform={`translate(${cell.x}, ${cell.y - HEX_SIZE * 0.62})`}
                  style={{ animation: 'hexPulse 1.6s ease-in-out infinite' }}
                >
                  <circle r={18} fill="#f59e0b" stroke={dark ? '#1c1917' : '#ffffff'} strokeWidth={3} />
                  <text y={7} textAnchor="middle" fontSize={24} fontWeight={800} fill="#ffffff">!</text>
                </g>
              )}
            </g>
          )
        })}
      </svg>

      {/* Banner under the cluster — the territory's name + state pips.
          (The voice chip floats over the capital plot now.) Anchored to the
          cells' centroid and bottom edge, not the bounding box, so the
          label visibly belongs to its cluster. */}
      <TerritoryBanner label={label} hue={hue} own={own}
        pendingCount={members.filter((m) => pendingInteractions[m.filePath]).length}
        anchor={{ ...bannerAnchor, y: bannerY }} nameSize={bannerNameSize}
        dark={dark} zoom={zoom} dir={dirPath} />
    </div>
  )
})

function TerritoryBanner({
  label,
  hue,
  own,
  pendingCount,
  anchor,
  nameSize,
  dark,
  zoom,
  dir
}: {
  label: string
  hue: number
  own: Map<string, FleetAgentStatus>
  pendingCount: number
  /** Cell-mass centroid x, cleared bottom-edge y, and horizontal span */
  anchor: { x: number; y: number; span: number }
  /** Name size — computed by the parent (shared with its clearance pass) */
  nameSize: number
  dark: boolean
  zoom: number
  /** Tracked-dir path — hover on its voice chip lights the name */
  dir: string
}) {
  const pips = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const a of own.values()) {
      const key = !a.online ? 'offline' : a.state
      counts[key] = (counts[key] ?? 0) + 1
    }
    return counts
  }, [own])

  // Zoom-adaptive: the banner leads the story from orbit (grows as you zoom
  // out) and hands over to districts and tiles as you zoom in — a crossfade,
  // not a pile-up: by the time local labels are legible the banner is a
  // faint watermark. Sizing lives in the parent (it drives the clearance
  // pass that keeps the banner out of south district labels).
  const subSize = Math.max(14, nameSize * 0.34)
  const pipSize = Math.max(10, nameSize * 0.22)
  const bannerOpacity = Math.min(1, Math.max(0.1, 1 - (zoom - 0.32) * 2.2))

  const bannerHovered = useFleetStore((s) => s.hoverDir === dir)
  const nameColor = bannerHovered
    ? (dark ? `hsla(${hue}, 48%, 84%, 1)` : `hsla(${hue}, 42%, 26%, 1)`)
    : (dark ? `hsla(${hue}, 40%, 76%, 0.95)` : `hsla(${hue}, 34%, 34%, 0.9)`)

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
    </div>
  )
}
