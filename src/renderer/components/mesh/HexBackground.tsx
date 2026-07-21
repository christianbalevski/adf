import { memo, useId } from 'react'
import { useStore } from '@xyflow/react'
import { hexCorners, HEX_SIZE, HEX_COL_W, HEX_ROW_H } from './fleet-layout'

/**
 * Global base terrain — the faint hex lattice covering the whole canvas
 * (the "ocean" every settlement sits in), drawn in flow coordinates via
 * patternTransform so territory cells line up tile-for-tile. Teal-tinged
 * strokes set the garden's key; the organic growth itself (moss beds, dew,
 * sprigs) lives in FleetGardenLayer — noise over absolute cells, so it
 * never repeats the way an SVG pattern must. Two slow-breathing washes
 * (teal + violet) sit underneath in screen space like light through a
 * canopy.
 */
export const HexBackground = memo(function HexBackground() {
  const patternId = useId()
  const tealWashId = useId()
  const violetWashId = useId()
  const [tx, ty, zoom] = useStore((s) => s.transform)
  const dark = document.documentElement.classList.contains('dark')

  const stroke = dark ? 'rgba(94, 234, 212, 0.055)' : 'rgba(15, 118, 110, 0.07)'
  const fill = dark ? 'rgba(30, 41, 59, 0.22)' : 'rgba(245, 245, 244, 0.4)'

  // One pattern tile = two columns of flat-top hexes (period 2 cols × 1 row)
  const tileW = 2 * HEX_COL_W
  const tileH = HEX_ROW_H

  return (
    <svg className="absolute inset-0 w-full h-full" style={{ zIndex: -10 }}>
      <defs>
        <radialGradient id={tealWashId}>
          <stop offset="0%" stopColor={dark ? 'rgba(45, 212, 191, 0.07)' : 'rgba(20, 184, 166, 0.05)'} />
          <stop offset="100%" stopColor="rgba(45, 212, 191, 0)" />
        </radialGradient>
        <radialGradient id={violetWashId}>
          <stop offset="0%" stopColor={dark ? 'rgba(167, 139, 250, 0.05)' : 'rgba(139, 92, 246, 0.035)'} />
          <stop offset="100%" stopColor="rgba(167, 139, 250, 0)" />
        </radialGradient>
        <pattern
          id={patternId}
          width={tileW}
          height={tileH}
          patternUnits="userSpaceOnUse"
          patternTransform={`translate(${tx} ${ty}) scale(${zoom})`}
        >
          <polygon points={hexCorners(0, 0, HEX_SIZE - 2)} fill={fill} stroke={stroke} strokeWidth={1.2} />
          <polygon points={hexCorners(HEX_COL_W, HEX_ROW_H / 2, HEX_SIZE - 2)} fill={fill} stroke={stroke} strokeWidth={1.2} />
          {/* wrap-around copies so tile edges join seamlessly */}
          <polygon points={hexCorners(0, tileH, HEX_SIZE - 2)} fill={fill} stroke={stroke} strokeWidth={1.2} />
          <polygon points={hexCorners(HEX_COL_W, -HEX_ROW_H / 2, HEX_SIZE - 2)} fill={fill} stroke={stroke} strokeWidth={1.2} />
          <polygon points={hexCorners(tileW, 0, HEX_SIZE - 2)} fill={fill} stroke={stroke} strokeWidth={1.2} />
          <polygon points={hexCorners(tileW, tileH, HEX_SIZE - 2)} fill={fill} stroke={stroke} strokeWidth={1.2} />
        </pattern>
      </defs>
      {/* Atmosphere — slow-breathing light washes, screen-space like a sky */}
      <g className="hex-garden-wash">
        <ellipse cx="22%" cy="18%" rx="55%" ry="45%" fill={`url(#${tealWashId})`} />
        <ellipse cx="82%" cy="85%" rx="60%" ry="50%" fill={`url(#${violetWashId})`} />
      </g>
      <rect width="100%" height="100%" fill={`url(#${patternId})`} />
    </svg>
  )
})
