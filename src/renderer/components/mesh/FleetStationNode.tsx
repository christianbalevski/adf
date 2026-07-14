import { memo, useMemo } from 'react'
import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { useMeshGraphStore } from '../../stores/mesh-graph.store'
import { hexCorners, HEX_SIZE, HEX_COL_W, HEX_ROW_H } from './fleet-layout'

export interface StationNodeData {
  kind: string
  label: string
  /** Adapter status: 'running' | 'error' | 'stopped' | … ('running' for web) */
  status: string
}

/** Station footprint — the node's CENTER sits on the icon hex (a lattice
 *  point), so message traces terminate cleanly at the platform's main pad. */
export const STATION_W = 830
export const STATION_H = 560

const STATION_ICONS: Record<string, string> = {
  telegram: '✈️',
  email: '✉️',
  discord: '🎧',
  imessage: '💬',
  slack: '💼',
  web: '🌐'
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
  const { kind, label, status } = data as unknown as StationNodeData
  const dark = document.documentElement.classList.contains('dark')

  // Usage growth — busy towers become hubs. Log-scaled and capped so a
  // spammy day widens the platform, it doesn't swallow the map.
  const edgeHeat = useMeshGraphStore((s) => s.edgeHeat)
  const scale = useMemo(() => {
    let count = 0
    for (const [key, entry] of Object.entries(edgeHeat)) {
      const [from, to] = key.split('|')
      if (from === id || to === id) count += entry.count
    }
    return Math.min(1.6, 1 + Math.log2(1 + count) / 10)
  }, [edgeHeat, id])

  // Icon pad = node center (lattice point); support pads one row down
  const cx = STATION_W / 2
  const cy = STATION_H / 2
  const pads = [
    { x: cx, y: cy },
    { x: cx - HEX_COL_W, y: cy + HEX_ROW_H / 2 },
    { x: cx + HEX_COL_W, y: cy + HEX_ROW_H / 2 }
  ]
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
        {/* Icon pad */}
        <text x={cx} y={cy + 32} textAnchor="middle" fontSize={110} style={{ userSelect: 'none' }}>
          {STATION_ICONS[kind] ?? '📡'}
        </text>
        {/* Name + status across the support pads */}
        <text
          x={cx}
          y={cy + HEX_ROW_H / 2 + 10}
          textAnchor="middle"
          fontSize={40}
          fontWeight={700}
          fill={dark ? 'rgba(203,213,225,0.9)' : 'rgba(71,85,105,0.9)'}
          style={{ userSelect: 'none' }}
        >
          {label}
        </text>
        <text
          x={cx}
          y={cy + HEX_ROW_H / 2 + 46}
          textAnchor="middle"
          fontSize={20}
          fontStyle="italic"
          fill={dark ? 'rgba(148,163,184,0.7)' : 'rgba(100,116,139,0.7)'}
          style={{ userSelect: 'none' }}
        >
          {status}
        </text>
        <circle cx={cx} cy={cy + HEX_ROW_H / 2 + 76} r={9} fill={STATUS_COLOR[status] ?? '#a3a3a3'} />
        </g>
      </svg>
    </div>
  )
})
