import { memo, useId, useMemo } from 'react'
import { useStore } from '@xyflow/react'
import { hexCorners, HEX_SIZE, HEX_COL_W, HEX_ROW_H } from './fleet-layout'

/**
 * Global base terrain — the "ocean" every settlement sits in, styled as a
 * subtle futuristic garden: the hex lattice stays (flow-coordinate pattern so
 * territory cells line up tile-for-tile), but tiles get quiet organic
 * variation — mossy teal tints on some, dew specks and tiny circuit-leaf
 * sprigs on a few — from a deterministic hash over a 6×3-hex supertile, so
 * the repeat period is large enough to read as natural. Underneath, two
 * slow-breathing atmospheric washes (teal + violet) sit in screen space like
 * light through a canopy.
 */

/** Deterministic per-hex noise in [0,1) — stable across renders */
function hashCell(q: number, r: number): number {
  const n = (((q * 7919 + r * 104729) % 997) + 997) % 997
  return n / 997
}

export const HexBackground = memo(function HexBackground() {
  const patternId = useId()
  const tealWashId = useId()
  const violetWashId = useId()
  const [tx, ty, zoom] = useStore((s) => s.transform)
  const dark = document.documentElement.classList.contains('dark')

  const stroke = dark ? 'rgba(94, 234, 212, 0.055)' : 'rgba(15, 118, 110, 0.07)'
  const baseFill = dark ? 'rgba(30, 41, 59, 0.22)' : 'rgba(245, 245, 244, 0.4)'
  const mossFill = dark ? 'rgba(45, 212, 191, 0.05)' : 'rgba(13, 148, 136, 0.045)'
  const dew = dark ? 'rgba(94, 234, 212, 0.22)' : 'rgba(13, 148, 136, 0.18)'
  const sprig = dark ? 'rgba(94, 234, 212, 0.14)' : 'rgba(15, 118, 110, 0.13)'

  // Supertile = 6 columns × 3 rows of hexes (3 horizontal lattice periods) —
  // decorations hash on (q mod 6, r mod 3) so wrap copies at the tile edges
  // match exactly and the pattern joins seamlessly
  const tileW = 6 * HEX_COL_W
  const tileH = 3 * HEX_ROW_H

  const cells = useMemo(() => {
    const out: {
      x: number
      y: number
      moss: boolean
      dewCorner: number | null
      sprigCorner: number | null
    }[] = []
    for (let q = 0; q <= 6; q++) {
      for (let r = -1; r <= 3; r++) {
        const x = q * HEX_COL_W
        const y = r * HEX_ROW_H + (q % 2) * (HEX_ROW_H / 2)
        const h = hashCell(q % 6, ((r % 3) + 3) % 3)
        out.push({
          x,
          y,
          moss: h > 0.82,
          dewCorner: h > 0.6 && h <= 0.72 ? Math.floor(h * 100) % 6 : null,
          sprigCorner: h > 0.3 && h <= 0.36 ? Math.floor(h * 1000) % 6 : null
        })
      }
    }
    return out
  }, [])

  const cornerOf = (cx: number, cy: number, k: number, inset = 0.72) => ({
    x: cx + HEX_SIZE * inset * Math.cos((k * Math.PI) / 3),
    y: cy + HEX_SIZE * inset * Math.sin((k * Math.PI) / 3)
  })

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
          {cells.map((c, i) => (
            <g key={i}>
              <polygon
                points={hexCorners(c.x, c.y, HEX_SIZE - 2)}
                fill={baseFill}
                stroke={stroke}
                strokeWidth={1.2}
              />
              {c.moss && <polygon points={hexCorners(c.x, c.y, HEX_SIZE - 2)} fill={mossFill} />}
              {c.dewCorner !== null && (() => {
                const p = cornerOf(c.x, c.y, c.dewCorner)
                return <circle cx={p.x} cy={p.y} r={4} fill={dew} />
              })()}
              {c.sprigCorner !== null && (() => {
                // Circuit-leaf sprig: short stem with two leaf dashes and a
                // node dot, rooted near a corner, leaning toward hex center
                const p = cornerOf(c.x, c.y, c.sprigCorner, 0.62)
                const a = (c.sprigCorner * Math.PI) / 3 + Math.PI // lean inward
                const ux = Math.cos(a)
                const uy = Math.sin(a)
                const px = -uy
                const py = ux
                const L = HEX_SIZE * 0.22
                return (
                  <g stroke={sprig} strokeWidth={2} strokeLinecap="round" fill="none">
                    <path d={`M ${p.x} ${p.y} L ${p.x + ux * L} ${p.y + uy * L}`} />
                    <path d={`M ${p.x + ux * L * 0.45} ${p.y + uy * L * 0.45} l ${(px * 0.5 + ux * 0.4) * L * 0.5} ${(py * 0.5 + uy * 0.4) * L * 0.5}`} />
                    <path d={`M ${p.x + ux * L * 0.7} ${p.y + uy * L * 0.7} l ${(-px * 0.5 + ux * 0.4) * L * 0.5} ${(-py * 0.5 + uy * 0.4) * L * 0.5}`} />
                    <circle cx={p.x + ux * L} cy={p.y + uy * L} r={2.5} fill={sprig} stroke="none" />
                  </g>
                )
              })()}
            </g>
          ))}
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
