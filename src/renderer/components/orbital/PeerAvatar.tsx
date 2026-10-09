/**
 * Avatar for an agent that may be remote. With a DID it is the agent's
 * orbital (or, in emoji mode, its icon); a remote peer without one keeps the
 * icon its card advertises.
 */

import { memo } from 'react'
import { OrbitalAvatar } from './OrbitalAvatar'

export const PeerAvatar = memo(function PeerAvatar({
  did,
  icon,
  size,
  emojiSize,
  className
}: {
  did?: string | null
  icon?: string | null
  size: number
  /** Emoji font size in px. Default: 80% of `size`. */
  emojiSize?: number
  className?: string
}) {
  if (did) return <OrbitalAvatar seed={did} icon={icon} size={size} emojiSize={emojiSize} className={className} />
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center leading-none select-none ${className ?? ''}`}
      style={{ width: size, height: size, fontSize: emojiSize ?? Math.round(size * 0.8) }}
    >
      {icon || '🤖'}
    </span>
  )
})
