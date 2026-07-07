import { useState, useRef, useCallback, useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * CSS tooltip replacing native `title` attributes, which Electron does not
 * render in hidden-titlebar windows (titleBarStyle: 'hidden'/'hiddenInset').
 * Rendered into a body portal with fixed positioning so it never gets
 * clipped by overflow containers.
 */
export function Tooltip({ tip, children, className }: { tip: string; children: ReactNode; className?: string }) {
  const [pos, setPos] = useState<{ x: number; y: number; below: boolean } | null>(null)
  const anchorRef = useRef<HTMLSpanElement>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const show = useCallback(() => {
    timerRef.current = setTimeout(() => {
      const r = anchorRef.current?.getBoundingClientRect()
      if (!r) return
      const below = r.top < 64
      const halfWidth = 132 // matches max-w below
      const x = Math.min(Math.max(r.left + r.width / 2, halfWidth + 8), window.innerWidth - halfWidth - 8)
      setPos({ x, y: below ? r.bottom + 6 : r.top - 6, below })
    }, 250)
  }, [])

  const hide = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = null
    setPos(null)
  }, [])

  useEffect(() => hide, [hide])

  return (
    <span ref={anchorRef} onMouseEnter={show} onMouseLeave={hide} className={className}>
      {children}
      {pos &&
        createPortal(
          <div
            className="fixed z-[1000] max-w-[264px] px-2 py-1.5 text-[10px] leading-snug rounded-md shadow-lg pointer-events-none bg-neutral-800 text-neutral-100 dark:bg-neutral-700 dark:text-neutral-100 border border-neutral-700 dark:border-neutral-600"
            style={{ left: pos.x, top: pos.y, transform: `translate(-50%, ${pos.below ? '0' : '-100%'})` }}
          >
            {tip}
          </div>,
          document.body
        )}
    </span>
  )
}
