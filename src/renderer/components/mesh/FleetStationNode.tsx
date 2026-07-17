import { memo, useMemo, useState, useEffect } from 'react'
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
  detail?: { host?: string; agentCount?: number; firstSeen?: number; url?: string; source?: string }
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

const STATION_ICONS: Record<string, string> = {
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
  // Last-hop targeting: a cross-runtime message flies to this station node,
  // then lights the exact recipient tile. `station:peer:<runtimeId>` → id.
  const runtimeId = kind === 'peer' && id.startsWith('station:peer:') ? id.slice('station:peer:'.length) : null
  const peerAgentPings = useMeshGraphStore((s) => s.peerAgentPings)

  // Usage growth — busy stations ANNEX TILES like a growing settlement:
  // extra pads accrete around the platform at (24h-weighted, log-spaced)
  // traffic thresholds, and dissolve again as the channel goes quiet.
  const edgeHeat = useMeshGraphStore((s) => s.edgeHeat)
  const [decayTick, setDecayTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setDecayTick((n) => n + 1), 10 * 60_000)
    return () => clearInterval(t)
  }, [])
  const extraPadCount = useMemo(() => {
    void decayTick
    const now = Date.now()
    const WINDOW = 24 * 60 * 60 * 1000
    let count = 0
    for (const [key, entry] of Object.entries(edgeHeat)) {
      const [from, to] = key.split('|')
      if (from !== id && to !== id) continue
      count += entry.count * Math.max(0, 1 - (now - entry.lastAt) / WINDOW)
    }
    // ~3 msgs → first annex; ~12 → second; ~40 → third; ~150 → fourth…
    return Math.min(6, Math.floor(Math.log2(1 + count) / 1.6))
  }, [edgeHeat, id, decayTick])

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

  return (
    <div className="relative pointer-events-none" style={{ width: STATION_W, height: STATION_H }} title={`${label} — ${status}`}>
      <Handle type="target" position={Position.Top} style={handleStyle} />
      <Handle type="source" position={Position.Bottom} style={handleStyle} />
      <svg width={STATION_W} height={STATION_H} className="absolute inset-0 overflow-visible">
        {/* Pads re-enable pointer events so hover/click surface the stats
            card — the root div stays transparent so panning works between
            stations, but the platform itself is a real hit target. */}
        <g style={{ pointerEvents: 'auto', cursor: 'pointer' }}>
        {pads.map((p, i) => (
          <g key={i}>
            <polygon points={hexCorners(p.x, p.y, HEX_SIZE - 2)} fill={fill} stroke={ring} strokeWidth={2.5} strokeOpacity={0.45} />
            <polygon points={hexCorners(p.x, p.y, HEX_SIZE - 16)} fill="none" stroke={ring} strokeWidth={1} strokeDasharray="6 5" />
          </g>
        ))}
        {/* Remote agent tiles — one per agent in the peer's directory */}
        {agentPads.map((p) => (
          <g
            key={`agent-${p.agent.did ?? p.agent.handle}`}
            onMouseEnter={(e) =>
              setPeerAgentHover({ agent: p.agent, peerHost: detail?.host ?? label, x: e.clientX, y: e.clientY })
            }
            onMouseLeave={() => setPeerAgentHover(null)}
            // Click pins the FULL card readout (the hover card is a teaser).
            // stopPropagation keeps React Flow's station-card pin from also
            // firing on the same click.
            onClick={(e) => {
              e.stopPropagation()
              setPeerAgentHover(null)
              setPeerReadout({ agent: p.agent, peerHost: detail?.host ?? label, peerUrl: detail?.url })
            }}
          >
            <polygon
              points={hexCorners(p.x, p.y, HEX_SIZE - 2)}
              fill={dark ? 'rgba(45, 212, 191, 0.10)' : 'rgba(13, 148, 136, 0.08)'}
              stroke={dark ? 'rgba(94, 234, 212, 0.22)' : 'rgba(15, 118, 110, 0.2)'}
              strokeWidth={2}
            />
            <text x={p.x} y={p.y + 6} textAnchor="middle" fontSize={64} style={{ userSelect: 'none' }}>
              {p.agent.icon || '🤖'}
            </text>
            <text
              x={p.x}
              y={p.y + 62}
              textAnchor="middle"
              fontSize={26}
              fontWeight={600}
              fill={dark ? 'rgba(203,213,225,0.9)' : 'rgba(71,85,105,0.9)'}
              style={{ userSelect: 'none' }}
            >
              {p.agent.handle.length > 11 ? `${p.agent.handle.slice(0, 10)}…` : p.agent.handle}
            </text>
            {p.agent.card_verified && (
              <circle cx={p.x + HEX_SIZE * 0.52} cy={p.y - HEX_SIZE * 0.52} r={8} fill="#4ade80">
                <title>card signature verified</title>
              </circle>
            )}
          </g>
        ))}

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

        {/* Platform silhouette — the darker perimeter of the whole base */}
        <path
          d={platformBoundary}
          fill="none"
          stroke={kind === 'peer' && agentPads.length > 0
            ? (dark ? 'rgba(94, 234, 212, 0.6)' : 'rgba(15, 118, 110, 0.55)')
            : (dark ? 'rgba(148, 163, 184, 0.75)' : 'rgba(100, 116, 139, 0.7)')}
          strokeWidth={3}
          strokeLinecap="round"
        />
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
              fill={dark ? 'rgba(203,213,225,0.9)' : 'rgba(71,85,105,0.9)'}
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
              <tspan fill="#4ade80">●</tspan>
              <tspan fill={dark ? 'rgba(148,163,184,0.75)' : 'rgba(100,116,139,0.75)'} fontStyle="italic">
                {' '}{status}
              </tspan>
            </text>
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
