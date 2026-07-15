import { memo, useMemo, useState, useEffect } from 'react'
import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { useMeshGraphStore } from '../../stores/mesh-graph.store'
import { hexCorners, HEX_SIZE, HEX_COL_W, HEX_ROW_H } from './fleet-layout'

export interface StationNodeData {
  kind: string
  label: string
  /** Adapter status: 'running' | 'error' | 'stopped' | … ('running' for web) */
  status: string
  /** Platform rotation in 60° CW steps (0 = support pads due south) — chosen
   *  so the pads face the fleet center from anywhere on the ring */
  facing?: number
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
  const { kind, label, status, facing = 0 } = data as unknown as StationNodeData
  const dark = document.documentElement.classList.contains('dark')

  // Usage growth — busy towers become hubs. Log-scaled, capped, and weighted
  // by a 24h recency window so the perimeter reflects the fleet's day: quiet
  // towers shrink back instead of memorializing all-time traffic.
  const edgeHeat = useMeshGraphStore((s) => s.edgeHeat)
  const [decayTick, setDecayTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setDecayTick((n) => n + 1), 10 * 60_000)
    return () => clearInterval(t)
  }, [])
  const scale = useMemo(() => {
    void decayTick
    const now = Date.now()
    const WINDOW = 24 * 60 * 60 * 1000
    let count = 0
    for (const [key, entry] of Object.entries(edgeHeat)) {
      const [from, to] = key.split('|')
      if (from !== id && to !== id) continue
      count += entry.count * Math.max(0, 1 - (now - entry.lastAt) / WINDOW)
    }
    return Math.min(1.6, 1 + Math.log2(1 + count) / 10)
  }, [edgeHeat, id, decayTick])

  // Icon pad = node center (lattice point); the two support pads rotate in
  // 60° lattice steps so the platform faces the fleet from any ring position
  const cx = STATION_W / 2
  const cy = STATION_H / 2
  const supportOffsets = [rotCW(-1, 1, facing), rotCW(1, 0, facing)].map((o) => ({
    x: o.q * HEX_COL_W,
    y: (o.r + o.q / 2) * HEX_ROW_H
  }))
  const pads = [{ x: cx, y: cy }, ...supportOffsets.map((o) => ({ x: cx + o.x, y: cy + o.y }))]
  // Label anchors on the support pair's midpoint, text stacking along facing
  const mx = (supportOffsets[0].x + supportOffsets[1].x) / 2
  const my = (supportOffsets[0].y + supportOffsets[1].y) / 2
  const mlen = Math.hypot(mx, my) || 1
  const ux = mx / mlen
  const uy = my / mlen
  const ring = dark ? 'rgba(148,163,184,0.55)' : 'rgba(100,116,139,0.5)'
  const fill = dark ? 'rgba(30,41,59,0.55)' : 'rgba(241,245,249,0.75)'
  const handleStyle = { width: 6, height: 6, background: 'transparent', border: 'none' } as const

  return (
    <div className="relative pointer-events-none" style={{ width: STATION_W, height: STATION_H }} title={`${label} — ${status}`}>
      <Handle type="target" position={Position.Top} style={handleStyle} />
      <Handle type="source" position={Position.Bottom} style={handleStyle} />
      <svg width={STATION_W} height={STATION_H} className="absolute inset-0 overflow-visible">
        <g transform={`translate(${cx} ${cy}) scale(${scale}) translate(${-cx} ${-cy})`} style={{ transition: 'transform 600ms ease-out' }}>
        {pads.map((p, i) => (
          <g key={i}>
            <polygon points={hexCorners(p.x, p.y, HEX_SIZE - 2)} fill={fill} stroke={ring} strokeWidth={2.5} />
            <polygon points={hexCorners(p.x, p.y, HEX_SIZE - 16)} fill="none" stroke={ring} strokeWidth={1} strokeDasharray="6 5" />
          </g>
        ))}
        {/* Icon pad — official brand mark when we have one, emoji otherwise */}
        {kind === 'telegram' || kind === 'discord' ? (
          <BrandIcon kind={kind} cx={cx} cy={cy} />
        ) : (
          <text x={cx} y={cy + 32} textAnchor="middle" fontSize={110} style={{ userSelect: 'none' }}>
            {STATION_ICONS[kind] ?? '📡'}
          </text>
        )}
        {/* Name + status on the support pads, stacked along the facing */}
        <text
          x={cx + mx}
          y={cy + my + 12}
          textAnchor="middle"
          fontSize={40}
          fontWeight={700}
          fill={dark ? 'rgba(203,213,225,0.9)' : 'rgba(71,85,105,0.9)'}
          style={{ userSelect: 'none' }}
        >
          {label}
        </text>
        <text
          x={cx + mx + ux * 40}
          y={cy + my + uy * 40 + 12}
          textAnchor="middle"
          fontSize={20}
          fontStyle="italic"
          fill={dark ? 'rgba(148,163,184,0.7)' : 'rgba(100,116,139,0.7)'}
          style={{ userSelect: 'none' }}
        >
          {status}
        </text>
        <circle cx={cx + mx + ux * 72} cy={cy + my + uy * 72} r={9} fill={STATUS_COLOR[status] ?? '#a3a3a3'} />
        </g>
      </svg>
    </div>
  )
})
