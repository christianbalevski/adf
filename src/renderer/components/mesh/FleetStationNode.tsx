import { memo } from 'react'
import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { hexCorners, HEX_SIZE } from './fleet-layout'

export interface StationNodeData {
  kind: string
  label: string
  /** Adapter status: 'running' | 'error' | 'stopped' | … ('running' for web) */
  status: string
}

const NODE_W = 260
const NODE_H = 280

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
 * discord…) plus the web gateway for sys_fetch traffic. Message traces from
 * agents to a station are boundary crossings, the most attention-worthy
 * traffic on the map. Visual: a double-ring hex platform, deliberately not
 * territory — no folder tint, no land.
 */
export const FleetStationNode = memo(function FleetStationNode({ data }: NodeProps) {
  const { kind, label, status } = data as unknown as StationNodeData
  const dark = document.documentElement.classList.contains('dark')
  const cx = NODE_W / 2
  const cy = NODE_H / 2
  const ring = dark ? 'rgba(148,163,184,0.55)' : 'rgba(100,116,139,0.55)'
  const fill = dark ? 'rgba(30,41,59,0.55)' : 'rgba(241,245,249,0.75)'
  const handleStyle = { width: 6, height: 6, background: 'transparent', border: 'none' } as const

  return (
    <div className="relative pointer-events-none" style={{ width: NODE_W, height: NODE_H }} title={`${label} — ${status}`}>
      <Handle type="target" position={Position.Top} style={handleStyle} />
      <Handle type="source" position={Position.Bottom} style={handleStyle} />
      <svg width={NODE_W} height={NODE_H} className="absolute inset-0 overflow-visible">
        <polygon points={hexCorners(cx, cy, HEX_SIZE - 2)} fill={fill} stroke={ring} strokeWidth={2.5} />
        <polygon points={hexCorners(cx, cy, HEX_SIZE - 16)} fill="none" stroke={ring} strokeWidth={1} strokeDasharray="6 5" />
        <text x={cx} y={cy - 10} textAnchor="middle" fontSize={78} style={{ userSelect: 'none' }}>
          {STATION_ICONS[kind] ?? '📡'}
        </text>
        <text
          x={cx}
          y={cy + 62}
          textAnchor="middle"
          fontSize={24}
          fontWeight={600}
          fill={dark ? 'rgba(203,213,225,0.9)' : 'rgba(71,85,105,0.9)'}
          style={{ userSelect: 'none' }}
        >
          {label}
        </text>
        <circle cx={cx} cy={cy + 86} r={7} fill={STATUS_COLOR[status] ?? '#a3a3a3'} />
      </svg>
    </div>
  )
})
