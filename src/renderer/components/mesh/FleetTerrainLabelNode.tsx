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
 * District name size — tracks a ~34px screen size so names read from far
 * orbit, with a world-unit cap so a zoomed-out label can't dwarf its plot
 * and a fit cap so long names stay inside their cluster's width.
 */
const districtNameSize = (zoom: number, span: number, nameLen: number) =>
  Math.min(clamp(34 / zoom, 30, 150), Math.max(26, (span * 1.1) / (0.6 * Math.max(4, nameLen))))

/**
 * Voice-chip visibility — the group status IS the strategic layer, so chips
 * surface from deep orbit and dissolve as you close in on the tiles they'd
 * otherwise cover (tile-level text takes over there).
 */
const chipFadeAt = (zoom: number) =>
  clamp((zoom - 0.06) / 0.06, 0, 1) * clamp((0.8 - zoom) / 0.3, 0, 1)

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

  // District labels — anchored just OUTSIDE each satellite plot, on the side
  // facing away from the territory's center of mass: a north district labels
  // above itself, everything else below. Outward labels never print across
  // interior tiles, and only south districts share the banner's band (the
  // banner yields to them — see the clearance pass in render). Voice: the
  // district's steward if appointed, otherwise the most recently active member.
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

      let voice = stewardByDir.get(joinDir(dirPath, district))
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
      const side: 'top' | 'bottom' = cy < centroidY - HEX_ROW_H * 0.4 ? 'top' : 'bottom'
      // Baseline sits well past the plot's edge tiles, floating over the
      // padding land rather than across the tile row
      const y = side === 'top' ? top - HEX_ROW_H * 0.72 : bottom + HEX_ROW_H * 0.92
      return { district, x: cx, y, side, voice, isSteward, span, cy }
    }).filter((d): d is NonNullable<typeof d> => d !== null)
  }, [districts, cells, dirPath, stewardByDir, own, nodeActivities])

  // The territory's own voice — root steward if appointed, else the most
  // recently active member — anchored over the CAPITAL plot (root-level
  // agents), falling back to the whole landmass when everyone lives in
  // districts. Rendered as an over-plot chip, not part of the banner.
  const territoryVoice = useMemo(() => {
    let voice = stewardByDir.get(dirPath)
    let isSteward = !!voice
    if (!voice) {
      let bestAt = -1
      for (const a of own.values()) {
        const acts = nodeActivities[a.filePath]
        const last = acts && acts.length > 0 ? acts[acts.length - 1].timestamp : 0
        const score = a.state === 'active' ? last + 1e15 : last
        if (score > bestAt) {
          bestAt = score
          voice = a
        }
      }
      isSteward = false
    }
    if (!voice) return null
    const capital = cells.filter((c) => c.district === '' && c.filePath)
    const base = capital.length > 0 ? capital : cells.filter((c) => c.filePath)
    if (base.length === 0) return null
    const cx = base.reduce((s, c) => s + c.x, 0) / base.length
    const cy = base.reduce((s, c) => s + c.y, 0) / base.length
    const span = Math.max(...base.map((c) => c.x)) - Math.min(...base.map((c) => c.x)) + HEX_COL_W * 1.6
    return { voice, isSteward, cx, cy, span }
  }, [cells, dirPath, stewardByDir, own, nodeActivities])

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

      {/* Voice chips — the group status floats OVER the plot it speaks for
          (territory chip over the capital, district chips over their plots),
          readable from deep orbit and dissolving as you close in on the
          tiles underneath. Hover lights the plot; click opens the readout. */}
      {(() => {
        const fade = chipFadeAt(zoom)
        if (fade === 0) return null
        // Screen-leaning font with a world cap so orbit stays readable
        // without the chip dwarfing its plot at mid zoom
        const font = Math.min(17 / zoom, 150)
        const chips = [
          territoryVoice && {
            key: 'territory',
            dir: dirPath,
            x: territoryVoice.cx,
            y: territoryVoice.cy,
            span: territoryVoice.span,
            voice: territoryVoice.voice,
            isSteward: territoryVoice.isSteward
          },
          ...districtLabels.map((d) => d.voice && {
            key: `district-${d.district}`,
            dir: joinDir(dirPath, d.district),
            x: d.x,
            y: d.cy,
            span: d.span,
            voice: d.voice,
            isSteward: d.isSteward
          })
        ].filter((c): c is NonNullable<typeof c> & { voice: FleetAgentStatus } =>
          !!c && !!c.voice && !!(c.voice.status || c.voice.handle))

        // Declutter: adjacent plots (capital + its ring of districts) can
        // put two chips in the same band — estimate each box and push the
        // lower one further down until they clear.
        const sized = chips.map((c) => {
          const chars = c.voice.handle.length + (c.voice.status?.length ?? 0) + 3
          const maxW = Math.max(c.span * 1.5, 1050)
          const w = Math.min(maxW, chars * font * 0.55 + font * 1.4)
          const lines = clamp(Math.ceil((chars * font * 0.52) / (maxW - font * 1.4)), 1, 3)
          const h = lines * font * 1.3 + font * 0.6
          return { ...c, maxW, w, h }
        }).sort((a, b) => a.y - b.y)
        const placed: { x: number; y: number; w: number; h: number }[] = []
        for (const c of sized) {
          for (const p of placed) {
            if (Math.abs(c.x - p.x) < (c.w + p.w) / 2 * 0.9 && Math.abs(c.y - p.y) < (c.h + p.h) / 2) {
              c.y = p.y + (p.h + c.h) / 2 + font * 0.3
            }
          }
          placed.push({ x: c.x, y: c.y, w: c.w, h: c.h })
        }

        return sized.map((c) => {
          return (
            <div
              key={`voice-${c.key}`}
              className="fleet-voice-chip absolute cursor-pointer"
              style={{
                left: c.x,
                top: c.y,
                transform: 'translate(-50%, -50%)',
                maxWidth: c.maxW,
                opacity: fade,
                // Once nearly dissolved, stop stealing hovers from the tiles
                pointerEvents: fade < 0.15 ? 'none' : 'auto',
                fontSize: font,
                lineHeight: 1.3,
                padding: `${font * 0.3}px ${font * 0.7}px`,
                borderRadius: font,
                background: dark ? 'rgba(15, 18, 22, 0.82)' : 'rgba(255, 255, 255, 0.88)',
                border: `1.5px solid hsla(${hue}, 30%, ${dark ? 55 : 45}%, 0.4)`,
                color: statusColor
              }}
              onClick={() => useFleetStore.getState().setReadoutDir(c.dir)}
              onMouseEnter={() => useFleetStore.getState().setHoverDir(c.dir)}
              onMouseLeave={() => useFleetStore.getState().setHoverDir(null)}
              title="Click for the full group readout"
            >
              <span style={{ display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                <span style={{ fontWeight: 600, color: nameColor }}>
                  {c.isSteward ? '♛ ' : ''}{c.voice.handle}
                </span>
                {c.voice.status ? <span style={{ fontStyle: 'italic' }}> — {c.voice.status}</span> : null}
              </span>
            </div>
          )
        })
      })()}

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
