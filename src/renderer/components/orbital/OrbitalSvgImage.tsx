/**
 * An agent's static orbital inside an SVG (fleet map tiles), centred on
 * (cx, cy). Same cached bitmap as OrbitalAvatar. In emoji mode it draws the
 * agent's emoji as <text> in the same box instead.
 */

import { memo } from 'react'
import { useAgentAvatarMode, useOrbitalImage } from './OrbitalAvatar'
import { useOrbitalTheme } from './orbital-env'
import { selectAgentAvatar } from './agent-avatar'

export const OrbitalSvgImage = memo(function OrbitalSvgImage({
  seed: orbitalSeed,
  cx,
  cy,
  size,
  icon,
  iconSeed
}: {
  seed: string | null | undefined
  cx: number
  cy: number
  size: number
  /** Emoji mode: the agent's configured icon. */
  icon?: string | null
  /** Emoji mode: seed for pickAgentIcon when there is no icon. Default: `seed`. */
  iconSeed?: string | null
}) {
  const choice = selectAgentAvatar(useAgentAvatarMode(), { seed: orbitalSeed, icon, iconSeed })
  const seed = choice.kind === 'orbital' ? choice.seed : null
  const theme = useOrbitalTheme()
  const url = useOrbitalImage(seed ? { seed, theme, kind: 'static' } : null)
  if (choice.kind === 'emoji') {
    if (!choice.emoji) return null
    // Same glyph metrics the emoji tiles used: 86 px text, baseline 30 px
    // below the centre, in a 96 px box (64 / 22 in a 72 px box).
    const fontSize = Math.floor(size * 0.9)
    return (
      <text x={cx} y={cy + Math.round(fontSize * 0.35)} textAnchor="middle" fontSize={fontSize} style={{ userSelect: 'none' }}>
        {choice.emoji}
      </text>
    )
  }
  if (!url) return null
  return <image href={url} x={cx - size / 2} y={cy - size / 2} width={size} height={size} />
})
