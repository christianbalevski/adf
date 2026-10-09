import { useEffect, useRef, useState } from 'react'
import { LiveOrbital } from '../../orbital'
import { usePrefersReducedMotion } from '../../orbital/orbital-env'
import { OrbitalCreature } from '../../orbital/orbital-creature'
import { creatureMoodFor, QUIET_CREATURE, type OrbitalMotionState } from '../../orbital/orbital-motion'
import { useCreatureSenses } from '../../orbital/useCreatureSenses'

/**
 * The overview header's orbital, alive like home's but quieter
 * (QUIET_CREATURE): it turns and breathes, its core follows the pointer,
 * it has a subtle idle beat every 10 to 20 s and dozes after 30 s alone.
 * The agent's state rides on top (creatureMoodFor); a turn ending settles
 * it with a small hop. Hover perks it up; a click makes it hop and spin.
 * Reduced motion: drawn once, nothing moves.
 */
export function OverviewOrbital({ seed, size, state, waiting }: {
  seed: string | null | undefined
  size: number
  state: OrbitalMotionState
  waiting: boolean
}) {
  const [creature] = useState(() => new OrbitalCreature({ size, ...QUIET_CREATURE }))
  const box = useRef<HTMLDivElement>(null)
  const reduce = usePrefersReducedMotion()
  useCreatureSenses(creature, box, !reduce)
  useEffect(() => {
    creature.size = size
  }, [creature, size])
  useEffect(() => {
    creature.setMood(performance.now(), creatureMoodFor(state, waiting))
  }, [creature, state, waiting])

  return (
    <div
      ref={box}
      onPointerEnter={() => {
        if (reduce) return
        creature.perk(true)
        creature.hop(performance.now(), 0.05, 260)
      }}
      onPointerLeave={() => creature.perk(false)}
      onClick={() => {
        if (reduce) return
        const now = performance.now()
        creature.activity(now)
        creature.hop(now, 0.2, 420)
        creature.spin(6)
      }}
    >
      <LiveOrbital seed={seed} size={size} state={state} creature={creature} />
    </div>
  )
}
