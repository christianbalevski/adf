import { memo, useMemo, useRef } from 'react'
import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { useMeshGraphStore } from '../../stores/mesh-graph.store'
import { useFleetStore } from '../../stores/fleet.store'
import { hexCorners, hexSpiral, hexBoundaryPath, HEX_SIZE, HEX_COL_W, HEX_ROW_H } from './fleet-layout'
import type { RemotePeerAgent } from '../../../shared/types/ipc.types'

export interface StationNodeData {
  kind: string
  label: string
  /** Adapter status: 'running' | 'error' | 'stopped' | … ('running' for web) */
  status: string
  /** Platform rotation in 60° CW steps (0 = support pads due south) — chosen
   *  so the pads face the fleet center from anywhere on the ring */
  facing?: number
  /** Extra facts for the hover card (peer runtimes). `url` is the runtime's
   *  own base URL — file fetches go here, NOT to the card's self-declared
   *  endpoints (those may point at a relay we can't reach). */
  detail?: { host?: string; agentCount?: number; firstSeen?: number; url?: string; source?: string; ownerAlias?: string; ownerVerified?: boolean; isSelfOwned?: boolean }
  /** Peer runtimes: one platform tile per remote agent, hover for its card */
  peerAgents?: RemotePeerAgent[]
}

/** Station footprint — the node's CENTER sits on the icon hex (a lattice
 *  point), so message traces terminate cleanly at the platform's main pad. */
export const STATION_W = 830
export const STATION_H = 660

/** Rotate an axial offset k×60° clockwise (cube rotation). */
export function rotCW(q: number, r: number, k: number): { q: number; r: number } {
  for (let i = 0; i < k; i++) {
    const nq = -r
    const nr = q + r
    q = nq
    r = nr
  }
  return { q, r }
}

export const STATION_ICONS: Record<string, string> = {
  email: '✉️',
  imessage: '💬',
  slack: '💼',
  web: '🌐',
  peer: '🛰️'
}

/** Official brand glyphs (24×24 paths) for channels that have one. */
const TELEGRAM_PATH =
  'M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z'
const DISCORD_PATH =
  'M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189z'

/** Circle-badged brand mark centered on the icon pad. */
function BrandIcon({ kind, cx, cy }: { kind: string; cx: number; cy: number }) {
  const R = 64
  const brand = kind === 'telegram'
    ? { bg: '#2AABEE', path: TELEGRAM_PATH }
    : kind === 'discord'
      ? { bg: '#5865F2', path: DISCORD_PATH }
      : null
  if (!brand) return null
  const s = (R * 2 * 0.72) / 24
  return (
    <g>
      <circle cx={cx} cy={cy} r={R} fill={brand.bg} />
      <path d={brand.path} fill="#ffffff" transform={`translate(${cx - 12 * s} ${cy - 12 * s}) scale(${s})`} />
    </g>
  )
}

const STATUS_COLOR: Record<string, string> = {
  running: '#4ade80',
  connected: '#4ade80',
  error: '#f87171',
  stopped: '#a3a3a3'
}

/**
 * Allegiance color for a foreign runtime. Owned territories use warm folder
 * hues; foreign clusters get a reserved COOL band (205–250°: steel-blue →
 * blue), one deterministic hue per runtime so two remote hubs are
 * distinguishable and nothing collides with the owned palette. This is
 * structural — it rides on the cluster ground/border/label under every lens,
 * because you always need to know whose agents you're looking at.
 *
 * Violet (SELF_HUE) is carved OUT of the band: it's the player color — the
 * same violet as selection, founding, and your message pulses — reserved for
 * runtimes that share your owner DID. Ownership is a hue, not a caption.
 */
export const SELF_HUE = 258
export function factionHue(runtimeId: string): number {
  let h = 0
  for (let i = 0; i < runtimeId.length; i++) h = (h * 31 + runtimeId.charCodeAt(i)) >>> 0
  return 205 + (h % 46)
}

/**
 * Base station — a perimeter structure marking where the fleet touches the
 * outside world: one per configured channel adapter (telegram, email,
 * discord…) plus the web gateway for sys_fetch traffic. A three-hex platform
 * (icon pad on top, two support pads below), lattice-aligned like everything
 * else on the map — stations are world objects that pan and zoom with the
 * terrain so traces stay geometrically honest. Deliberately not territory:
 * no folder tint, no land.
 */
export const FleetStationNode = memo(function FleetStationNode({ id, data }: NodeProps) {
  const { kind, label, status, facing = 0, peerAgents, detail } = data as unknown as StationNodeData
  const dark = document.documentElement.classList.contains('dark')
  const setPeerAgentHover = useFleetStore((s) => s.setPeerAgentHover)
  const setPeerReadout = useFleetStore((s) => s.setPeerReadout)
  const isSelected = useFleetStore((s) => s.selectedStation === id)
  // Last-hop targeting: a cross-runtime message flies to this station node,
  // then lights the exact recipient tile. `station:peer:<runtimeId>` → id.
  const runtimeId = kind === 'peer' && id.startsWith('station:peer:') ? id.slice('station:peer:'.length) : null
  const peerAgentPings = useMeshGraphStore((s) => s.peerAgentPings)
  const peerStreetHeat = useMeshGraphStore((s) => s.peerStreetHeat)
  // Arm timer for peer-agent hover cards — same 550ms contract as tiles
  const hoverArmRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Usage growth — busy stations ANNEX TILES like a growing settlement:
  // extra pads accrete around the platform at (24h-weighted, log-spaced)
  // traffic thresholds, and dissolve again as the channel goes quiet.
  // The selector returns the QUANTIZED count, so the node re-renders only
  // when an annex threshold is actually crossed — not on every message
  // (the old whole-map edgeHeat subscription re-rendered every station per
  // message). Decay re-evaluates whenever any heat entry changes; a silent
  // fleet keeps stale annexes until the next message, which is fine.
  const extraPadCount = useMeshGraphStore((s) => {
    const now = Date.now()
    const WINDOW = 24 * 60 * 60 * 1000
    let count = 0
    for (const [key, entry] of Object.entries(s.edgeHeat)) {
      const [from, to] = key.split('|')
      if (from !== id && to !== id) continue
      count += entry.count * Math.max(0, 1 - (now - entry.lastAt) / WINDOW)
    }
    // ~3 msgs → first annex; ~12 → second; ~40 → third; ~150 → fourth…
    return Math.min(6, Math.floor(Math.log2(1 + count) / 1.6))
  })

  // Icon pad = node center (lattice point); support pads rotate in 60°
  // lattice steps so the platform faces the fleet from any ring position.
  // Peer runtimes get a third support (a whole extra tile) — another
  // machine's fleet deserves a bigger pier than a chat channel.
  const cx = STATION_W / 2
  const cy = STATION_H / 2
  const baseSupports: [number, number][] = kind === 'peer'
    ? [[-1, 1], [1, 0], [0, 1]]
    : [[-1, 1], [1, 0]]
  const toPixel = (q: number, r: number) => {
    const o = rotCW(q, r, facing)
    return { x: o.q * HEX_COL_W, y: (o.r + o.q / 2) * HEX_ROW_H }
  }
  const supportOffsets = baseSupports.map(([q, r]) => toPixel(q, r))
  // Annex order: finish the flower around the icon pad, then push into the
  // second ring — filtered against pads the base shape already owns
  const GROWTH_SEQ: [number, number][] = [[0, 1], [1, -1], [-1, 0], [0, -1], [2, -1], [-2, 2]]
  const taken = new Set(baseSupports.map(([q, r]) => `${q},${r}`))
  const growthSlots = GROWTH_SEQ.filter(([q, r]) => !taken.has(`${q},${r}`))

  // Peer runtimes with a readable directory: the platform is POPULATED — one
  // tile per remote agent (hover for its card), so another machine's base
  // reads as a settlement, not a monolith. UNCAPPED: a 100-agent runtime
  // renders a 100-tile city (spiral rings around the icon pad). Falls back
  // to the plain platform when the peer's directory is unreachable.
  const agentPads = useMemo(() => {
    if (kind !== 'peer' || !peerAgents || peerAgents.length === 0) return []
    const slots = hexSpiral(peerAgents.length + 1).slice(1) // skip center (icon pad)
    return peerAgents.map((agent, i) => {
      const o = toPixel(slots[i][0], slots[i][1])
      return { x: cx + o.x, y: cy + o.y, agent }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, peerAgents, facing])
  // Populated platforms push the name/status label out past the last ring
  const agentRings = useMemo(() => {
    let r = 0
    while (3 * r * (r + 1) < agentPads.length) r++
    return r
  }, [agentPads.length])

  // Platform silhouette — every occupied cell in the (rotated) axial frame,
  // for the darker perimeter outline; interior pad borders fade back
  const platformCells = useMemo(() => {
    const out: { q: number; r: number; x: number; y: number }[] = []
    const push = (q0: number, r0: number) => {
      const o = rotCW(q0, r0, facing)
      out.push({ q: o.q, r: o.r, x: cx + o.q * HEX_COL_W, y: cy + (o.r + o.q / 2) * HEX_ROW_H })
    }
    push(0, 0)
    if (kind === 'peer' && peerAgents && peerAgents.length > 0) {
      for (const [q0, r0] of hexSpiral(peerAgents.length + 1).slice(1)) push(q0, r0)
    } else {
      for (const [q0, r0] of baseSupports) push(q0, r0)
      for (const [q0, r0] of growthSlots.slice(0, extraPadCount)) push(q0, r0)
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, peerAgents, facing, extraPadCount])
  const platformBoundary = useMemo(() => hexBoundaryPath(platformCells, HEX_SIZE - 2), [platformCells])

  const growthOffsets = agentPads.length > 0
    ? [] // populated peer platform grows by agents, not by traffic
    : growthSlots.slice(0, extraPadCount).map(([q, r]) => toPixel(q, r))
  const pads = [
    { x: cx, y: cy },
    // Base supports stay as empty pads where no agent occupies them
    ...supportOffsets
      .filter((o) => !agentPads.some((p) => p.x === cx + o.x && p.y === cy + o.y))
      .map((o) => ({ x: cx + o.x, y: cy + o.y })),
    ...growthOffsets.map((o) => ({ x: cx + o.x, y: cy + o.y }))
  ]
  // Label anchors on the support pads' centroid, text stacking along facing
  const mx = supportOffsets.reduce((s, o) => s + o.x, 0) / supportOffsets.length
  const my = supportOffsets.reduce((s, o) => s + o.y, 0) / supportOffsets.length
  const mlen = Math.hypot(mx, my) || 1
  const ux = mx / mlen
  const uy = my / mlen
  // Populated platforms: the support pads are agent tiles now, so the label
  // slides out just past the outermost occupied ring (still facing the fleet)
  const labelR = agentPads.length > 0 ? (agentRings + 0.85) * HEX_ROW_H : mlen
  const lx = ux * labelR
  const ly = uy * labelR
  const ring = dark ? 'rgba(148,163,184,0.55)' : 'rgba(100,116,139,0.5)'
  const fill = dark ? 'rgba(30,41,59,0.55)' : 'rgba(241,245,249,0.75)'
  const handleStyle = { width: 6, height: 6, background: 'transparent', border: 'none' } as const

  // Foreign allegiance palette — a per-runtime cool hue that marks this whole
  // cluster as another machine's, distinct from our warm folder territories.
  // Self-owned remote runtimes wear the player color (violet) instead of a
  // foreign hue — yours at a glance, RTS-style. Control is a separate axis:
  // the dashed perimeter below says "not commanded from here".
  const selfOwned = !!detail?.isSelfOwned
  const fh = selfOwned ? SELF_HUE : runtimeId ? factionHue(runtimeId) : 214
  const faction = {
    tileFill: `hsla(${fh}, ${dark ? 45 : 42}%, ${dark ? 56 : 48}%, ${dark ? 0.16 : 0.11})`,
    tileStroke: `hsla(${fh}, ${dark ? 62 : 55}%, ${dark ? 66 : 50}%, ${dark ? 0.34 : 0.30})`,
    border: `hsla(${fh}, 58%, ${dark ? 66 : 46}%, ${dark ? 0.6 : 0.55})`,
    label: `hsla(${fh}, ${dark ? 38 : 46}%, ${dark ? 74 : 44}%, 0.95)`,
    verifyDot: `hsl(${fh}, 60%, ${dark ? 62 : 46}%)`
  }
  // Aggregate cluster health — the one at-a-glance signal we can honestly give
  // for a foreign hub without per-tile polling: reachable (directory answered,
  // agent count known) vs not.
  const peerReachable = detail?.agentCount != null
  // Owner attribution for the banner. Self-owned carries NO caption — the
  // violet palette is the ownership signal (games never label your own base
  // "yours"; color does it). A peer's verified alias reads "owned by X";
  // an unverified alias is a self-claim and marked.
  const ownerLine: { text: string; self: boolean } | null =
    selfOwned ? null
    : detail?.ownerAlias
      ? { text: detail.ownerVerified ? `owned by ${detail.ownerAlias}` : `${detail.ownerAlias} · unverified`, self: false }
      : null

  return (
    <div className="relative pointer-events-none" style={{ width: STATION_W, height: STATION_H }} title={`${label} — ${status}`}>
      <Handle type="target" position={Position.Top} style={handleStyle} />
      <Handle type="source" position={Position.Bottom} style={handleStyle} />
      <svg width={STATION_W} height={STATION_H} className="absolute inset-0 overflow-visible">
        {/* Pads re-enable pointer events so hover/click surface the stats
            card — the root div stays transparent so panning works between
            stations, but the platform itself is a real hit target. The
            class doubles as the React Flow dragHandle: platforms move only
            when grabbed by their pads, never by the empty bounding box. */}
        <g className="station-drag-handle" style={{ pointerEvents: 'auto', cursor: 'pointer' }}>
        {pads.map((p, i) => (
          <g key={i}>
            <polygon points={hexCorners(p.x, p.y, HEX_SIZE - 2)} fill={fill} stroke={ring} strokeWidth={2.5} strokeOpacity={0.45} />
            <polygon points={hexCorners(p.x, p.y, HEX_SIZE - 16)} fill="none" stroke={ring} strokeWidth={1} strokeDasharray="6 5" />
          </g>
        ))}
        {/* Remote agent tiles — one per agent in the peer's directory.
            Hover arms on the SAME 550ms delay as local tiles (sweeping the
            cursor across a peer city must not strobe cards). */}
        {agentPads.map((p) => (
          <g
            key={`agent-${p.agent.did ?? p.agent.handle}`}
            onMouseEnter={(e) => {
              const x = e.clientX
              const y = e.clientY
              if (hoverArmRef.current) clearTimeout(hoverArmRef.current)
              hoverArmRef.current = setTimeout(() => {
                hoverArmRef.current = null
                setPeerAgentHover({ agent: p.agent, peerHost: detail?.host ?? label, peerSource: detail?.source, x, y })
              }, 550)
            }}
            onMouseLeave={() => {
              if (hoverArmRef.current) {
                clearTimeout(hoverArmRef.current)
                hoverArmRef.current = null
              }
              setPeerAgentHover(null)
            }}
            // Click pins the FULL card readout (the hover card is a teaser).
            // stopPropagation keeps React Flow's station-card pin from also
            // firing on the same click.
            onClick={(e) => {
              e.stopPropagation()
              setPeerAgentHover(null)
              setPeerReadout({ agent: p.agent, peerHost: detail?.host ?? label, peerUrl: detail?.url, peerSource: detail?.source })
            }}
          >
            <polygon
              points={hexCorners(p.x, p.y, HEX_SIZE - 2)}
              fill={faction.tileFill}
              stroke={faction.tileStroke}
              strokeWidth={2}
            />
            <text x={p.x} y={p.y + 6} textAnchor="middle" fontSize={64} style={{ userSelect: 'none' }}>
              {p.agent.icon || '🤖'}
            </text>
            {(() => {
              // Shrink-to-fit beats the old 11-char cut ("patternsca…") —
              // remote handles are identity, and the pad's mid-band has room
              const fit = 230 / (0.62 * Math.max(6, p.agent.handle.length))
              const nameSize = Math.min(26, Math.max(14, fit))
              // Truncate only when shrinking bottomed out at the 14px floor —
              // any name the fit formula sized fits by construction
              const name = fit < 14 ? p.agent.handle.slice(0, 25) + '…' : p.agent.handle
              const sub = p.agent.status || p.agent.description
              return (
                <>
                  <text
                    x={p.x}
                    y={p.y + 62}
                    textAnchor="middle"
                    fontSize={nameSize}
                    fontWeight={600}
                    fill={dark ? 'rgba(203,213,225,0.9)' : 'rgba(71,85,105,0.9)'}
                    style={{ userSelect: 'none' }}
                  >
                    {name}
                  </text>
                  {/* Live status when the peer serves one, description as the
                      static fallback — an empty lavender pad tells you nothing */}
                  {sub && (
                    <text
                      x={p.x}
                      y={p.y + 88}
                      textAnchor="middle"
                      fontSize={15}
                      fontStyle="italic"
                      fill={dark ? 'rgba(148,163,184,0.75)' : 'rgba(100,116,139,0.75)'}
                      style={{ userSelect: 'none' }}
                    >
                      {sub.length > 26 ? sub.slice(0, 25) + '…' : sub}
                    </text>
                  )}
                </>
              )
            })()}
            {p.agent.card_verified && (
              <circle cx={p.x + HEX_SIZE * 0.52} cy={p.y - HEX_SIZE * 0.52} r={8} fill="#4ade80">
                <title>card signature verified</title>
              </circle>
            )}
            {/* Serving badge — same 🌐 as local tiles; click opens the
                agent's site rebased on the runtime URL we discovered the
                peer at (the card's endpoints may name an unreachable relay) */}
            {(p.agent.mesh_routes?.length ?? 0) > 0 && detail?.url && (
              <g
                onClick={(e) => {
                  e.stopPropagation()
                  window.open(`${detail.url!.replace(/\/+$/, '')}/${encodeURIComponent(p.agent.handle)}/`, '_blank')
                }}
                style={{ cursor: 'pointer' }}
              >
                <circle cx={p.x - HEX_SIZE * 0.52} cy={p.y - HEX_SIZE * 0.52} r={20} fill={dark ? 'rgba(38,38,38,0.9)' : 'rgba(255,255,255,0.9)'} stroke={dark ? '#0369a1' : '#7dd3fc'} strokeWidth={2} />
                <text x={p.x - HEX_SIZE * 0.52} y={p.y - HEX_SIZE * 0.52 + 9} textAnchor="middle" fontSize={24} style={{ userSelect: 'none' }}>
                  🌐
                </text>
                <title>{`Serving a site — open ${p.agent.handle}/`}</title>
              </g>
            )}
          </g>
        ))}

        {/* Delivery streets — the PERSISTENT last hop. The map trunk ends at
            the platform gate (icon pad); each recipient that traffic actually
            reached gets a street from the gate to its tile, with the same
            heat/decay semantics as real traces. Trunk to the settlement,
            streets to the door — the final leg no longer evaporates with the
            delivery flash. */}
        {runtimeId && agentPads.map((p) => {
          const entry =
            (p.agent.did ? peerStreetHeat[`${runtimeId}|${p.agent.did}`] : undefined) ??
            peerStreetHeat[`${runtimeId}|${p.agent.handle}`]
          if (!entry) return null
          const recency = Math.min(1, Math.max(0, 1 - (Date.now() - entry.lastAt) / (4 * 60 * 60 * 1000)))
          const w = Math.min(1, Math.log2(1 + entry.count) / 5) * (0.3 + 0.7 * recency)
          if (w <= 0) return null
          const dx = p.x - cx
          const dy = p.y - cy
          const dist = Math.hypot(dx, dy)
          if (dist < 1) return null
          const ux2 = dx / dist
          const uy2 = dy / dist
          const inset = HEX_SIZE * 0.6
          const x1 = cx + ux2 * inset
          const y1 = cy + uy2 * inset
          const x2 = p.x - ux2 * inset
          const y2 = p.y - uy2 * inset
          const aLen = 16 + 10 * w
          const aHalf = 8 + 5 * w
          const stroke = `hsla(258, ${20 + 55 * w}%, ${dark ? 62 : 48}%, ${0.35 + 0.6 * w})`
          return (
            <g key={`street-${p.agent.did ?? p.agent.handle}`} style={{ pointerEvents: 'none' }}>
              <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={stroke} strokeWidth={3 + 6 * w} strokeLinecap="round" />
              <polygon
                fill={stroke}
                points={`${x2},${y2} ${x2 - ux2 * aLen + -uy2 * aHalf},${y2 - uy2 * aLen + ux2 * aHalf} ${x2 - ux2 * aLen - -uy2 * aHalf},${y2 - uy2 * aLen - ux2 * aHalf}`}
              />
            </g>
          )
        })}

        {/* Last-hop targeting — a cross-runtime message reached this station
            and is routed to its recipient tile: a connector sweeps from the
            station center to that tile, and the tile's edge pulses. Keyed by
            the ping timestamp so each new message replays the animation; base
            opacity 0 so elements rest invisible after the sweep (no fill-mode
            needed). */}
        {runtimeId && agentPads.map((p) => {
          const ts = Math.max(
            p.agent.did ? peerAgentPings[`${runtimeId}|${p.agent.did}`] ?? 0 : 0,
            peerAgentPings[`${runtimeId}|${p.agent.handle}`] ?? 0
          )
          if (!ts) return null
          const glow = dark ? 'rgba(94, 234, 212, 0.95)' : 'rgba(13, 148, 136, 0.9)'
          return (
            <g key={`hop-${p.agent.did ?? p.agent.handle}-${ts}`} style={{ pointerEvents: 'none' }}>
              <line
                x1={cx}
                y1={cy}
                x2={p.x}
                y2={p.y}
                stroke={glow}
                strokeWidth={6}
                strokeLinecap="round"
                strokeDasharray="14 10"
                style={{ opacity: 0, animation: 'stationHopFlow 1.6s ease-out' }}
              />
              <polygon
                points={hexCorners(p.x, p.y, HEX_SIZE - 2)}
                fill="none"
                stroke={glow}
                strokeWidth={5}
                style={{ opacity: 0, animation: 'stationHopRing 1.6s ease-out', transformBox: 'fill-box', transformOrigin: 'center' }}
              />
            </g>
          )
        })}

        {/* Platform silhouette — the darker perimeter of the whole base.
            Peer platforms are DASHED: whatever the ownership hue says, this
            base takes no orders from here (your local territories draw solid
            borders). Line style = control, hue = allegiance. */}
        <path
          d={platformBoundary}
          fill="none"
          stroke={kind === 'peer' && agentPads.length > 0
            ? faction.border
            : (dark ? 'rgba(148, 163, 184, 0.75)' : 'rgba(100, 116, 139, 0.7)')}
          strokeWidth={3}
          strokeLinecap="round"
          strokeDasharray={kind === 'peer' ? '18 12' : undefined}
        />
        {/* Selection ring — player violet, same accent the lit traces wear */}
        {isSelected && (
          <path
            d={platformBoundary}
            fill="none"
            stroke="#8b5cf6"
            strokeWidth={7}
            strokeLinecap="round"
            opacity={0.85}
            style={{ pointerEvents: 'none' }}
          />
        )}
        {/* Icon pad — official brand mark when we have one, emoji otherwise */}
        {kind === 'telegram' || kind === 'discord' ? (
          <BrandIcon kind={kind} cx={cx} cy={cy} />
        ) : (
          <text x={cx} y={cy + 32} textAnchor="middle" fontSize={110} style={{ userSelect: 'none' }}>
            {STATION_ICONS[kind] ?? '📡'}
          </text>
        )}
        {/* Name + status. Populated peer platforms read like territories:
            the name sits centered BELOW the settlement (the facing-vector
            stack collides with itself on horizontal facings) and at
            territory-class weight — another machine's runtime is a place,
            not a gadget. Plain stations keep the compact facing layout. */}
        {agentPads.length > 0 ? (
          <g>
            <text
              x={cx}
              y={cy + (agentRings + 1.0) * HEX_ROW_H + 64}
              textAnchor="middle"
              fontSize={78}
              fontWeight={800}
              fill={faction.label}
              style={{ userSelect: 'none', letterSpacing: '0.04em' }}
            >
              {label}
            </text>
            <text
              x={cx}
              y={cy + (agentRings + 1.0) * HEX_ROW_H + 108}
              textAnchor="middle"
              fontSize={26}
              style={{ userSelect: 'none' }}
            >
              <tspan fill={peerReachable ? '#4ade80' : '#fbbf24'}>●</tspan>
              <tspan fill={dark ? 'rgba(148,163,184,0.75)' : 'rgba(100,116,139,0.75)'} fontStyle="italic">
                {' '}{status}
              </tspan>
            </text>
            {/* Owner line — verifiable via the shared delegation. "your runtime"
                when the owner DID matches ours; a peer's alias otherwise. An
                unverified alias is a self-claim, marked as such. */}
            {ownerLine && (
              <text
                x={cx}
                y={cy + (agentRings + 1.0) * HEX_ROW_H + 148}
                textAnchor="middle"
                fontSize={26}
                fontWeight={600}
                fill={ownerLine.self ? faction.label : (dark ? 'rgba(148,163,184,0.85)' : 'rgba(71,85,105,0.85)')}
                style={{ userSelect: 'none' }}
              >
                {ownerLine.text}
              </text>
            )}
          </g>
        ) : (
          <g>
            <text
              x={cx + lx}
              y={cy + ly + 12}
              textAnchor="middle"
              fontSize={40}
              fontWeight={700}
              fill={dark ? 'rgba(203,213,225,0.9)' : 'rgba(71,85,105,0.9)'}
              style={{ userSelect: 'none' }}
            >
              {label}
            </text>
            <text
              x={cx + lx + ux * 40}
              y={cy + ly + uy * 40 + 12}
              textAnchor="middle"
              fontSize={20}
              fontStyle="italic"
              fill={dark ? 'rgba(148,163,184,0.7)' : 'rgba(100,116,139,0.7)'}
              style={{ userSelect: 'none' }}
            >
              {status}
            </text>
            <circle cx={cx + lx + ux * 72} cy={cy + ly + uy * 72} r={9} fill={STATUS_COLOR[status] ?? '#a3a3a3'} />
          </g>
        )}
        </g>
      </svg>
    </div>
  )
})
