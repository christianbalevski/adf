import { memo, useId } from 'react'
import { useStore } from '@xyflow/react'
import { hexCorners, HEX_SIZE, HEX_COL_W, HEX_ROW_H } from './fleet-layout'

/**
 * Global base terrain — a faint hex lattice covering the whole canvas,
 * extending beyond every territory (the "ocean" the settlements sit in).
 * Drawn in flow coordinates via patternTransform so territory cells (which
 * the layout snaps to this same lattice) line up tile-for-tile.
 */
export const HexBackground = memo(function HexBackground() {
  const patternId = useId()
  const [tx, ty, zoom] = useStore((s) => s.transform)
  const dark = document.documentElement.classList.contains('dark')

  const stroke = dark ? 'rgba(163,163,163,0.07)' : 'rgba(115,115,115,0.08)'
  const fill = dark ? 'rgba(38,38,38,0.25)' : 'rgba(245,245,244,0.4)'

  // One pattern tile = two columns of flat-top hexes (period 2 cols × 1 row)
  const tileW = 2 * HEX_COL_W
  const tileH = HEX_ROW_H

  return (
    <svg className="absolute inset-0 w-full h-full" style={{ zIndex: -10 }}>
      <defs>
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
      <rect width="100%" height="100%" fill={`url(#${patternId})`} />
    </svg>
  )
})
