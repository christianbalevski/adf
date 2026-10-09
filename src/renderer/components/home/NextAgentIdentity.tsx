import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { IdentityDraft } from '../../../shared/types/ipc.types'
import { LiveOrbital, type LiveOrbitalHandle } from '../orbital'
import { usePrefersReducedMotion } from '../orbital/orbital-env'
import { OrbitalCreature } from '../orbital/orbital-creature'

function discard(d: IdentityDraft | null): void {
  if (d) window.adfApi.discardIdentityDraft(d.draftId).catch(() => {})
}

/**
 * The next agent's identity, minted in main before the agent exists. The
 * private key never leaves main; this holds only { draftId, did }. `renew`
 * drops the current draft and mints another (on a name reroll, and after a
 * send, whose create consumed it). At most one mint is in flight: renews
 * that land while one is pending coalesce, and the stale result is discarded
 * on arrival and replaced by one fresh mint, so rapid rerolls never leak
 * drafts and the latest renew always wins. The draft is dropped on unmount.
 */
export interface IdentityDraftHandle {
  draft: IdentityDraft | null
  renew: () => void
  current: () => IdentityDraft | null
}

export function useIdentityDraft(): IdentityDraftHandle {
  const [draft, setDraft] = useState<IdentityDraft | null>(null)
  const held = useRef<IdentityDraft | null>(null)
  const seq = useRef(0)
  const alive = useRef(false)
  const inflight = useRef(false)

  const mint = useCallback(() => {
    const mine = seq.current
    inflight.current = true
    const settle = (): boolean => {
      inflight.current = false
      if (!alive.current) return false
      // A renew came in while this mint was out: mint once more for it.
      if (mine !== seq.current) { mint(); return false }
      return true
    }
    window.adfApi.mintIdentityDraft().then(
      (next) => {
        if (!settle()) { discard(next); return }
        held.current = next
        setDraft(next)
      },
      (err) => {
        if (!settle()) return
        console.warn('[home] Could not mint an identity draft:', err)
        setDraft(null)
      }
    )
  }, [])

  const renew = useCallback(() => {
    seq.current++
    discard(held.current)
    held.current = null
    if (!inflight.current) mint()
  }, [mint])

  useEffect(() => {
    alive.current = true
    renew()
    return () => {
      alive.current = false
      seq.current++
      discard(held.current)
      held.current = null
    }
  }, [renew])

  const current = useCallback(() => held.current, [])
  return { draft, renew, current }
}

/**
 * The creature behind home's orbital, one per home visit. HomeScreen owns it
 * so a send can reach it (`setBusy`, `spin`, `hop`).
 */
export function useHomeCreature(): OrbitalCreature {
  const [creature] = useState(() => new OrbitalCreature({ size: ORBITAL_PX }))
  return creature
}

/** Marks the inputs home's orbital glances at while they are focused or typed in. */
const LOOK_ATTR = 'data-orbital-look'
/** How long a glance holds after the last focus or keystroke, ms. */
const GLANCE_MS = 1800

/**
 * The next agent's orbital, centred on home where the empty-state icon was,
 * seeded by its real DID (never shown). Alive (see OrbitalCreature): it turns
 * and cycles its phase, its core follows the pointer anywhere in the window,
 * it has idle beats and dozes after a while. It glances at the name or the
 * composer while either is focused or typed in, and each keystroke in the
 * name turns it a little (spinImpulse covers a committed name). Hover perks
 * it up; a click makes it hop and spin. The DID alone decides the shape, and
 * a name reroll brings a new identity: the new shape comes in with a short
 * fade-scale and a spin kick. Reduced motion: drawn once, nothing moves.
 * `children` overlays the orbital box (the reroll quip bubble).
 */
export function NextAgentOrbital({ did, spinImpulse, creature, children }: {
  did: string | null
  spinImpulse: number
  creature: OrbitalCreature
  children?: React.ReactNode
}) {
  const orbital = useRef<LiveOrbitalHandle>(null)
  const box = useRef<HTMLDivElement>(null)
  const reduce = usePrefersReducedMotion()
  const lastDid = useRef(did)
  const kickNext = useRef(false)
  // The fade starts before paint, so the new shape's first frame is already
  // faded. The kick waits for the passive effect: LiveOrbital zeroes its spin
  // on a new seed in its own effect, which runs before this parent's.
  useLayoutEffect(() => {
    const prev = lastDid.current
    lastDid.current = did
    if (!prev || !did || prev === did || reduce) return
    kickNext.current = true
    box.current?.animate(
      [{ opacity: 0.25, transform: 'scale(0.92)' }, { opacity: 1, transform: 'scale(1)' }],
      { duration: 260, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' }
    )
  }, [did, reduce])
  useEffect(() => {
    if (!kickNext.current) return
    kickNext.current = false
    orbital.current?.kick(4)
  }, [did])

  // The window's pointer, keys and focus, as the creature sees them.
  useEffect(() => {
    if (reduce) return
    const centre = () => {
      const r = box.current?.getBoundingClientRect()
      return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null
    }
    const glance = (el: Element) => {
      const c = centre()
      if (!c) return
      const r = el.getBoundingClientRect()
      // The start of a wide field (where the text is), not its middle.
      creature.look(performance.now(), r.left + Math.min(r.width / 2, 120) - c.x, r.top + r.height / 2 - c.y, GLANCE_MS)
    }
    const lookTarget = (t: EventTarget | null) =>
      t instanceof Element ? t.closest(`[${LOOK_ATTR}]`) : null
    const onMove = (e: PointerEvent) => {
      const c = centre()
      if (c) creature.pointer(performance.now(), e.clientX - c.x, e.clientY - c.y)
    }
    const onOut = (e: MouseEvent) => {
      if (!e.relatedTarget) creature.pointer(performance.now(), null)
    }
    const onKey = () => creature.activity(performance.now())
    const onFocus = (e: FocusEvent) => {
      const t = lookTarget(e.target)
      if (t) glance(t)
    }
    const onInput = (e: Event) => {
      const t = lookTarget(e.target)
      if (!t) return
      glance(t)
      if (t.getAttribute(LOOK_ATTR) === 'name') {
        const del = (e as InputEvent).inputType?.startsWith('delete')
        orbital.current?.kick(del ? -0.6 : 0.6)
      }
    }
    window.addEventListener('pointermove', onMove, { passive: true })
    document.addEventListener('mouseout', onOut)
    window.addEventListener('keydown', onKey, true)
    document.addEventListener('focusin', onFocus)
    document.addEventListener('input', onInput, true)
    return () => {
      window.removeEventListener('pointermove', onMove)
      document.removeEventListener('mouseout', onOut)
      window.removeEventListener('keydown', onKey, true)
      document.removeEventListener('focusin', onFocus)
      document.removeEventListener('input', onInput, true)
    }
  }, [creature, reduce])

  return (
    <div className="relative" style={{ width: ORBITAL_PX, height: ORBITAL_PX }}>
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
          creature.spin(7)
        }}
      >
        <LiveOrbital ref={orbital} seed={did} size={ORBITAL_PX} spinImpulse={spinImpulse} creature={creature} />
      </div>
      {children}
    </div>
  )
}

const ORBITAL_PX = 112
