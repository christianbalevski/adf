import { memo, useMemo } from 'react'
import { useStore } from '@xyflow/react'
import type { NodeProps, ReactFlowState } from '@xyflow/react'
import { useShallow } from 'zustand/react/shallow'
import { useMeshStore } from '../../stores/mesh.store'
import { useDocumentStore } from '../../stores/document.store'
import { useMeshGraphStore, type NodeActivity } from '../../stores/mesh-graph.store'
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

/**
 * Label content overflows the territory's cell rect: district names print
 * above the top row, the banner (name + pips, up to a 280px font plus its
 * district-clearance drop) hangs below the bottom edge, and both can spill
 * wide of the cells. With viewport culling (onlyRenderVisibleElements) the
 * node vanishes the moment its DECLARED rect leaves the screen — so the
 * label twin's declared rect is grown by these pads (MeshGraphView's layout
 * memo shifts the node position up-left and widens initialWidth/Height) and
 * the component offsets its content back by the same amount. World px.
 */
export const LABEL_PAD_X = 400
export const LABEL_PAD_TOP = 300
export const LABEL_PAD_BOTTOM = 800

/**
 * Unit-stack LOD tiers. Below the FAR threshold a unit tile drops all text
 * layout (name-fit math, status wrap, burn meta, context gauge) and fine
 * badges, keeping icon + coarse dots — at 0.35 a 16px status line is under
 * 6px on screen, sub-legible by construction, so nothing readable is lost.
 * Below the OVERVIEW threshold the unit stack renders nothing at all: the
 * terrain twin's polygon fill/border carries state (and the whole-tile
 * amber pendingFill carries HIL) from orbit.
 *
 * Both flags are BOOLEAN threshold subscriptions on the React Flow store —
 * tiles re-render when a tier is crossed, never per zoom frame. No
 * hysteresis gap: zoom only changes via discrete user gestures (no
 * oscillation source), and the content a crossing toggles is sub-legible at
 * the boundary, so a flip is visually silent.
 */
const UNIT_FAR_ZOOM = 0.35
const UNIT_OVERVIEW_ZOOM = 0.1
const farTierSelector = (s: ReactFlowState): boolean => s.transform[2] < UNIT_FAR_ZOOM
const overviewTierSelector = (s: ReactFlowState): boolean => s.transform[2] < UNIT_OVERVIEW_ZOOM

/** Stable empty stand-in while the far tier ignores the activity feed. */
const EMPTY_ACTIVITIES: (NodeActivity[] | undefined)[] = []

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

/** One-line "what it's doing right now" from the newest real action —
 *  no leading mark; only failures (✗) and message direction (→/←) annotate. */
function liveActivityLine(act: { type: string; toolName: string; args?: string; isError?: boolean }): string {
  const prefix = act.isError === true ? '✗ ' : act.type === 'message_sent' ? '→ ' : act.type === 'message_recv' ? '← ' : ''
  return truncate(`${prefix}${act.toolName}${act.args ? ' ' + act.args : ''}`, 34)
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
  // (Continuous zoom is a banner/district need — the heavy per-unit stack
  // lives in UnitLayer below, memoized behind boolean tier flags, so this
  // per-zoom-frame re-render only re-sizes the banner and district names.)
  const zoom = useStore((s) => s.transform[2])

  // Per-member selection (the MeshGraphNode pattern): fleet-wide churn keeps
  // every element identity below stable, so only THIS territory's members'
  // events re-render this (heavy) text stack.
  const memberAgents = useMeshStore(
    useShallow((s) => {
      const byPath = new Map(s.agents.map((a) => [a.filePath, a]))
      return members.map((m) => byPath.get(m.filePath))
    })
  )
  const memberPending = useMeshGraphStore(
    useShallow((s) => members.map((m) => !!s.pendingInteractions[m.filePath]))
  )
  const hoverDir = useFleetStore((s) => s.hoverDir)

  const own = useMemo(
    () => new Map(memberAgents.filter((a): a is FleetAgentStatus => !!a).map((a) => [a.filePath, a])),
    [memberAgents]
  )

  const labelColor = dark ? `hsla(${hue}, 35%, 72%, 0.95)` : `hsla(${hue}, 35%, 36%, 0.95)`

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
    // Outer rect = the node's declared (culling) rect: the territory box
    // grown by the label pads. Inner box restores the original coordinate
    // frame so every anchor below is untouched.
    <div
      className="pointer-events-none relative"
      style={{ width: width + 2 * LABEL_PAD_X, height: height + LABEL_PAD_TOP + LABEL_PAD_BOTTOM }}
    >
      <div className="absolute" style={{ left: LABEL_PAD_X, top: LABEL_PAD_TOP, width, height }}>
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

          {/* Units — identity is part of the tile. Memoized behind boolean
              zoom-tier flags: this layer never re-renders per zoom frame,
              only when a tier line is crossed (or its members change). */}
          <UnitLayer
            cells={cells}
            members={members}
            own={own}
            memberPending={memberPending}
            hue={hue}
            dark={dark}
          />
        </svg>

        {/* Banner under the cluster — the territory's name + state pips.
            (The voice chip floats over the capital plot now.) Anchored to the
            cells' centroid and bottom edge, not the bounding box, so the
            label visibly belongs to its cluster. */}
        <TerritoryBanner label={label} hue={hue} own={own}
          pendingCount={memberPending.filter(Boolean).length}
          anchor={{ ...bannerAnchor, y: bannerY }} nameSize={bannerNameSize}
          dark={dark} zoom={zoom} dir={dirPath} />
      </div>
    </div>
  )
})

/**
 * The per-unit SVG stacks — the heaviest content on the map (~15 elements
 * per unit at full detail). Zoom reaches this component ONLY as the two
 * boolean tier flags above, so it renders exactly three shapes:
 *
 *   zoom ≥ 0.35 (NEAR)       full stack — icon, fitted name, state dot,
 *                            status/burn text, context gauge, held/steward/
 *                            open/group badges, HIL "!" badge
 *   0.1 ≤ zoom < 0.35 (FAR)  icon + coarse dots: state dot, held/steward/
 *                            open dots, HIL as a pulsing amber disc (safety-
 *                            relevant, so it outlives the cosmetic badges);
 *                            no text layout math, no activity/burn reads
 *   zoom < 0.1 (OVERVIEW)    nothing — the terrain twin's polygon color
 *                            (and its amber HIL fill) is the whole story
 */
const UnitLayer = memo(function UnitLayer({
  cells,
  members,
  own,
  memberPending,
  hue,
  dark
}: {
  cells: TerrainNodeData['cells']
  members: TerrainNodeData['members']
  own: Map<string, FleetAgentStatus>
  memberPending: boolean[]
  hue: number
  dark: boolean
}) {
  const far = useStore(farTierSelector)
  const overview = useStore(overviewTierSelector)

  const openFilePath = useDocumentStore((s) => s.filePath)
  const stewards = useFleetStore((s) => s.stewards)
  const controlGroups = useFleetStore((s) => s.controlGroups)
  const startingMap = useFleetStore((s) => s.starting)
  // The churny feeds are tier-gated: below the far line no status/burn text
  // renders, so fleet-wide activity events and the 5s burn poll must not
  // re-render a single far-tier tile.
  const burn = useFleetStore((s) => (far ? null : s.burn))
  // Live activity feed — the tile's "what am I doing" line. Per-path lists
  // keep identity unless that member logged something.
  const memberActivities = useMeshGraphStore(
    useShallow((s) => (far ? EMPTY_ACTIVITIES : members.map((m) => s.nodeActivities[m.filePath])))
  )

  const memberIndex = useMemo(() => new Map(members.map((m, i) => [m.filePath, i])), [members])
  const iconByPath = useMemo(() => new Map(members.map((m) => [m.filePath, m.icon])), [members])

  // Stewards — members whose DID exactly matches their directory's
  // designation. No history cascade: if a DID rotates, the user reappoints.
  const stewardCells = useMemo(() => {
    const set = new Set<string>()
    for (const a of own.values()) {
      if (!a.did) continue
      if (stewards[pathDirname(a.filePath)] === a.did) set.add(a.filePath)
    }
    return set
  }, [own, stewards])

  // Control-group membership → lowest digit per agent (RTS unit badge).
  // Lowest wins when an agent is in several groups — recall keys are 1-9,
  // and the smallest is the one you'll reach for first.
  const groupDigitByPath = useMemo(() => {
    const map = new Map<string, string>()
    for (const digit of Object.keys(controlGroups).sort()) {
      for (const fp of controlGroups[digit] ?? []) {
        if (!map.has(fp)) map.set(fp, digit)
      }
    }
    return map
  }, [controlGroups])

  const labelColor = dark ? `hsla(${hue}, 35%, 72%, 0.95)` : `hsla(${hue}, 35%, 36%, 0.95)`
  const nameColor = dark ? 'rgba(235,235,235,0.95)' : 'rgba(45,45,45,0.95)'
  const statusColor = dark ? 'rgba(190,190,190,0.75)' : 'rgba(90,90,90,0.75)'
  const metaColor = dark ? 'rgba(160,160,160,0.6)' : 'rgba(120,120,120,0.65)'

  if (overview) return null

  return (
    <>
      {cells.map((cell) => {
        if (!cell.filePath) return null
        const agent = own.get(cell.filePath)
        const icon = iconByPath.get(cell.filePath)
        const isGhostUnit = agent?.online === false
        const held = agent?.held
        const isPending = memberPending[memberIndex.get(cell.filePath) ?? -1] ?? false
        const stateDot = isGhostUnit
          ? null
          : agent?.state === 'active' ? '#facc15'
          : agent?.state === 'error' ? '#f87171'
          : agent?.state === 'idle' ? '#4ade80'
          : '#a3a3a3'

        if (far) {
          // FAR tier — icon + coarse dots, zero text layout. Dots sit on the
          // same anchors as their near-tier badges so a tier crossing doesn't
          // shift any mark.
          return (
            <g
              key={`unit-${cell.q},${cell.r}`}
              opacity={isGhostUnit ? 0.45 : 1}
              style={{ userSelect: 'none', filter: isGhostUnit ? 'grayscale(0.9)' : undefined }}
            >
              <text x={cell.x} y={cell.y - 26} textAnchor="middle" fontSize={86}>
                {icon}
              </text>
              {stateDot && <circle cx={cell.x} cy={cell.y + 30} r={8} fill={stateDot} />}
              {held && (
                <circle cx={cell.x + HEX_SIZE * 0.52} cy={cell.y - HEX_SIZE * 0.62} r={10} fill="#a3a3a3" />
              )}
              {stewardCells.has(cell.filePath) && (
                <circle cx={cell.x - HEX_SIZE * 0.52} cy={cell.y - HEX_SIZE * 0.62} r={10} fill={labelColor} />
              )}
              {cell.filePath === openFilePath && (
                <circle cx={cell.x + HEX_SIZE * 0.52} cy={cell.y + HEX_SIZE * 0.62} r={10} fill={dark ? '#60a5fa' : '#3b82f6'} />
              )}
              {/* HIL — safety-relevant, so it stays past the badges: the
                  same amber disc, minus the (sub-legible) "!" glyph */}
              {isPending && (
                <circle
                  cx={cell.x} cy={cell.y - HEX_SIZE * 0.62} r={18}
                  fill="#f59e0b" stroke={dark ? '#1c1917' : '#ffffff'} strokeWidth={3}
                  style={{ animation: 'hexPulse 1.6s ease-in-out infinite' }}
                />
              )}
            </g>
          )
        }

        // NEAR tier — the full identity stack, exactly the pre-LOD rendering.
        const handle = agent?.handle ?? members.find((m) => m.filePath === cell.filePath)?.handle ?? ''
        const booting = agent?.online === false && !!startingMap[cell.filePath]

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
        const acts = memberActivities[memberIndex.get(cell.filePath) ?? -1]
        // Newest real ACTION only — state flips aren't work (same rule the
        // activity pulse uses), so "state → active" never fills this slot
        let lastAct: NodeActivity | undefined
        if (acts) {
          for (let i = acts.length - 1; i >= 0; i--) {
            const t = acts[i].type
            if (t === 'tool_start' || t === 'message_sent' || t === 'message_recv') {
              lastAct = acts[i]
              break
            }
          }
        }
        const isLive = !isGhostUnit && agent?.state === 'active' && !!lastAct
        const statusLines = isGhostUnit
          ? [booting ? 'starting up…' : 'not started']
          : isLive
            ? [liveActivityLine(lastAct!)]
            : wrapTwo(String(agent?.status || agent?.state || ''), 30)

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
              y={cell.y + 36}
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
                cy={cell.y + 36 - nameSize * 0.32}
                r={5}
                fill={stateDot}
                style={agent?.state === 'active' ? { animation: 'hexPulse 1.6s ease-in-out infinite' } : undefined}
              />
            )}
            {statusLines[0] && (
              <text
                x={cell.x} y={cell.y + 62} textAnchor="middle" fontSize={16}
                fontStyle={isLive ? undefined : 'italic'}
                fontFamily={isLive ? 'ui-monospace, monospace' : undefined}
                fill={statusColor}
              >
                {statusLines[0]}
              </text>
            )}
            {statusLines[1] && (
              <text x={cell.x} y={cell.y + 82} textAnchor="middle" fontSize={16} fontStyle="italic" fill={statusColor}>
                {statusLines[1]}
              </text>
            )}
            {meta && (
              <text x={cell.x} y={cell.y + 104} textAnchor="middle" fontSize={13} fill={metaColor}>
                {meta}
              </text>
            )}
            {ctxFrac !== null && (
              <g>
                <rect
                  x={cell.x - 55} y={cell.y + 112} width={110} height={5} rx={2.5}
                  fill={dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.10)'}
                />
                <rect
                  x={cell.x - 55} y={cell.y + 112}
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
            {/* Open-in-dock badge — this unit owns the side panel and the
                bottom status bar right now. Blue like the Open button. */}
            {cell.filePath === openFilePath && (
              <g transform={`translate(${cell.x + HEX_SIZE * 0.52}, ${cell.y + HEX_SIZE * 0.62})`}>
                <title>Open in the side panel</title>
                <circle
                  r={14}
                  fill={dark ? 'rgba(30,58,138,0.85)' : 'rgba(219,234,254,0.95)'}
                  stroke={dark ? '#60a5fa' : '#3b82f6'}
                  strokeWidth={1.5}
                />
                <rect x={-6.5} y={-5} width={13} height={10} rx={1.5} fill="none" stroke={dark ? '#bfdbfe' : '#1d4ed8'} strokeWidth={1.6} />
                <line x1={2} y1={-5} x2={2} y2={5} stroke={dark ? '#bfdbfe' : '#1d4ed8'} strokeWidth={1.6} />
              </g>
            )}
            {/* Control-group badge — which digit recalls this unit */}
            {groupDigitByPath.has(cell.filePath) && (
              <g transform={`translate(${cell.x - HEX_SIZE * 0.52}, ${cell.y + HEX_SIZE * 0.62})`}>
                <circle
                  r={14}
                  fill={dark ? 'rgba(76,29,149,0.85)' : 'rgba(237,233,254,0.95)'}
                  stroke={dark ? '#a78bfa' : '#8b5cf6'}
                  strokeWidth={1.5}
                />
                <text y={5.5} textAnchor="middle" fontSize={15} fontWeight={700} fill={dark ? '#ddd6fe' : '#6d28d9'}>
                  {groupDigitByPath.get(cell.filePath)}
                </text>
              </g>
            )}
            {/* HIL "!" — lives in this text layer (not the terrain svg)
                so it paints OVER the unit emoji, not under it */}
            {isPending && (
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
    </>
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
