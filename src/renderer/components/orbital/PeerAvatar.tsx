/**
 * Avatar for an agent that may be remote. With a DID it is the agent's
 * orbital; a remote peer without one keeps the icon its card advertises.
 */

import { memo } from 'react'
import { OrbitalAvatar } from './OrbitalAvatar'

export const PeerAvatar = memo(function PeerAvatar({
  did,
  icon,
  size,
  className
}: {
  did?: string | null
  icon?: string | null
  size: number
  className?: string
}) {
  if (did) return <OrbitalAvatar seed={did} size={size} className={className} />
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center leading-none select-none ${className ?? ''}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.8) }}
    >
      {icon || '🤖'}
    </span>
  )
})
