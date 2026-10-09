import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { IdentityDraft } from '../../../shared/types/ipc.types'
import { LiveOrbital, type LiveOrbitalHandle } from '../orbital'
import { usePrefersReducedMotion } from '../orbital/orbital-env'

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
 * The next agent's orbital, centred on home where the empty-state icon was,
 * seeded by its real DID (never shown). Typing in the name turns it
 * (spinImpulse); the DID alone decides the shape, and a name reroll brings a
 * new identity: the new shape comes in with a short fade-scale and a spin
 * kick (instant under reduced motion). `children` overlays the orbital box
 * (the reroll quip bubble).
 */
export function NextAgentOrbital({ did, spinImpulse, children }: {
  did: string | null
  spinImpulse: number
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

  return (
    <div className="relative" style={{ width: ORBITAL_PX, height: ORBITAL_PX }}>
      <div ref={box}>
        <LiveOrbital ref={orbital} seed={did} size={ORBITAL_PX} spinImpulse={spinImpulse} />
      </div>
      {children}
    </div>
  )
}

const ORBITAL_PX = 112
