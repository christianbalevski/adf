import { useEffect, type RefObject } from 'react'
import type { OrbitalCreature } from './orbital-creature'

/**
 * Feed a creature the window's pointer (relative to `box`'s centre) and keys,
 * so its core follows the pointer anywhere in the window and it dozes only
 * when the user is away. Off while `enabled` is false (reduced motion).
 */
export function useCreatureSenses(creature: OrbitalCreature, box: RefObject<HTMLElement | null>, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return
    const onMove = (e: PointerEvent) => {
      const r = box.current?.getBoundingClientRect()
      if (r) creature.pointer(performance.now(), e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2))
    }
    const onOut = (e: MouseEvent) => {
      if (!e.relatedTarget) creature.pointer(performance.now(), null)
    }
    const onKey = () => creature.activity(performance.now())
    window.addEventListener('pointermove', onMove, { passive: true })
    document.addEventListener('mouseout', onOut)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointermove', onMove)
      document.removeEventListener('mouseout', onOut)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [creature, box, enabled])
}
