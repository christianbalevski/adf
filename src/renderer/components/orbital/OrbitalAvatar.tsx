/**
 * An agent's orbital as a small avatar (24 to 40 px). Static from the cached
 * 96 px bitmap; while the agent is active and reduced motion is off, the
 * cached sprite strip plays instead (CSS steps(), no per-frame JS).
 * With Settings > Agent avatars on Emoji it draws the agent's emoji instead
 * and renders no orbital.
 */

import { memo, useEffect, useState } from 'react'
import type { AgentState } from '../../../shared/types/ipc.types'
import type { OrbitalCacheRequest } from '../../../shared/utils/orbital-cache-key'
import { loadOrbitalImage, peekOrbitalImage } from './orbital-images'
import { orbitalMotion, orbitalMotionStateFor } from './orbital-motion'
import { useOrbitalTheme, usePrefersReducedMotion } from './orbital-env'
import { ORBITAL_STRIP_FRAMES, ORBITAL_STRIP_SECONDS } from './orbital-geometry'
import { selectAgentAvatar, type AgentAvatarMode } from './agent-avatar'
import { useAppStore } from '../../stores/app.store'

export interface OrbitalAvatarProps {
  /** From orbitalSeedFor(). Null draws an empty box of the same size. */
  seed: string | null | undefined
  /** CSS px, square. */
  size: number
  /** Play the strip. Default: true when `state` is 'active'. */
  animated?: boolean
  /** Agent state; sets the opacity (off and suspended at 50%, hibernate dimmed). */
  state?: AgentState
  className?: string
  title?: string
  /** Emoji mode: the agent's configured icon. */
  icon?: string | null
  /** Emoji mode: seed for pickAgentIcon when there is no icon. Default: `seed`. */
  iconSeed?: string | null
  /** Emoji mode: font size in px. Default: 80% of `size`. */
  emojiSize?: number
}

/** The Settings > Agent avatars choice. */
export function useAgentAvatarMode(): AgentAvatarMode {
  return useAppStore((s) => s.agentAvatars)
}

/** Object URL of a cached orbital image; null while it loads or when `req` is null. */
export function useOrbitalImage(req: OrbitalCacheRequest | null): string | null {
  const [url, setUrl] = useState<string | null>(() => (req ? peekOrbitalImage(req) : null))
  const seed = req?.seed
  const theme = req?.theme
  const kind = req?.kind
  useEffect(() => {
    if (!seed || !theme || !kind) {
      setUrl(null)
      return
    }
    const r = { seed, theme, kind }
    const hit = peekOrbitalImage(r)
    setUrl(hit)
    if (hit) return
    let live = true
    loadOrbitalImage(r).then((u) => {
      if (live) setUrl(u)
    })
    return () => {
      live = false
    }
  }, [seed, theme, kind])
  return url
}

export const OrbitalAvatar = memo(function OrbitalAvatar({
  seed: orbitalSeed,
  size,
  animated,
  state,
  className,
  title,
  icon,
  iconSeed,
  emojiSize
}: OrbitalAvatarProps) {
  const choice = selectAgentAvatar(useAgentAvatarMode(), { seed: orbitalSeed, icon, iconSeed })
  // Emoji mode passes a null seed below, so no orbital is loaded or rendered.
  const seed = choice.kind === 'orbital' ? choice.seed : null
  const theme = useOrbitalTheme()
  const reduce = usePrefersReducedMotion()
  const play = (animated ?? state === 'active') && !reduce && !!seed
  const staticUrl = useOrbitalImage(seed ? { seed, theme, kind: 'static' } : null)
  const stripUrl = useOrbitalImage(play && seed ? { seed, theme, kind: 'strip' } : null)
  const alpha = state ? orbitalMotion(orbitalMotionStateFor(state)).alpha : 1

  const box = {
    width: size,
    height: size,
    opacity: alpha
  }

  if (choice.kind === 'emoji') {
    if (!choice.emoji) return <span aria-hidden="true" className={`inline-block shrink-0 ${className ?? ''}`} style={box} />
    return (
      <span
        role="img"
        aria-label={title}
        title={title}
        className={`inline-flex shrink-0 items-center justify-center leading-none select-none ${className ?? ''}`}
        style={{ ...box, fontSize: emojiSize ?? Math.round(size * 0.8) }}
      >
        {choice.emoji}
      </span>
    )
  }

  if (play && stripUrl) {
    return (
      <span
        role="img"
        aria-label={title}
        title={title}
        className={`adf-orbital-strip inline-block shrink-0 select-none ${className ?? ''}`}
        style={{
          ...box,
          backgroundImage: `url("${stripUrl}")`,
          backgroundSize: `${size * ORBITAL_STRIP_FRAMES}px ${size}px`,
          ['--orbital-strip-w' as string]: `${size * ORBITAL_STRIP_FRAMES}px`,
          animationDuration: `${ORBITAL_STRIP_SECONDS}s`,
          animationTimingFunction: `steps(${ORBITAL_STRIP_FRAMES})`
        }}
      />
    )
  }

  if (!staticUrl) {
    return <span aria-hidden="true" className={`inline-block shrink-0 ${className ?? ''}`} style={box} />
  }

  return (
    <img
      src={staticUrl}
      width={size}
      height={size}
      alt={title ?? ''}
      title={title}
      draggable={false}
      className={`inline-block shrink-0 select-none ${className ?? ''}`}
      style={box}
    />
  )
})
