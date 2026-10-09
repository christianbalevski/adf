/**
 * An agent's static orbital inside an SVG (fleet map tiles), centred on
 * (cx, cy). Same cached bitmap as OrbitalAvatar.
 */

import { memo } from 'react'
import { useOrbitalImage } from './OrbitalAvatar'
import { useOrbitalTheme } from './orbital-env'

export const OrbitalSvgImage = memo(function OrbitalSvgImage({
  seed,
  cx,
  cy,
  size
}: {
  seed: string | null | undefined
  cx: number
  cy: number
  size: number
}) {
  const theme = useOrbitalTheme()
  const url = useOrbitalImage(seed ? { seed, theme, kind: 'static' } : null)
  if (!url) return null
  return <image href={url} x={cx - size / 2} y={cy - size / 2} width={size} height={size} />
})
