import { useState, useRef, useCallback, useEffect, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * CSS tooltip replacing native `title` attributes, which Electron does not
 * render in hidden-titlebar windows (titleBarStyle: 'hidden'/'hiddenInset').
 * Rendered into a body portal with fixed positioning so it never gets
 * clipped by overflow containers.
 */
export function Tooltip({ tip, children, className, style, delay = 500, disabled = false }: {
  tip: string
  children?: ReactNode
  className?: string
  style?: CSSProperties
  /** Hover delay in ms. Raise it for hints the pointer crosses constantly (list rows). */
  delay?: number
  /** Hide and stop showing, e.g. while a popover from the same anchor is open. */
  disabled?: boolean
}) {
  const [pos, setPos] = useState<{ x: number; y: number; below: boolean } | null>(null)
  const anchorRef = useRef<HTMLSpanElement>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const show = useCallback(() => {
    if (disabled) return
    timerRef.current = setTimeout(() => {
      const r = anchorRef.current?.getBoundingClientRect()
      if (!r) return
      const below = r.top < 64
      const halfWidth = 132 // matches max-w below
      const x = Math.min(Math.max(r.left + r.width / 2, halfWidth + 8), window.innerWidth - halfWidth - 8)
      setPos({ x, y: below ? r.bottom + 6 : r.top - 6, below })
    }, delay)
  }, [delay, disabled])

  const hide = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = null
    setPos(null)
  }, [])

  useEffect(() => hide, [hide])
  useEffect(() => {
    if (disabled) hide()
  }, [disabled, hide])

  return (
    <span ref={anchorRef} onMouseEnter={show} onMouseLeave={hide} className={className} style={style}>
      {children}
      {pos &&
        createPortal(
          <div
            className="fixed z-[1000] max-w-[264px] px-2 py-1.5 text-[10px] leading-snug whitespace-pre-line [overflow-wrap:anywhere] rounded-md shadow-float pointer-events-none bg-[var(--adf-ui-surface)] text-[var(--adf-ui-text)] border border-[var(--adf-ui-border)]"
            style={{ left: pos.x, top: pos.y, transform: `translate(-50%, ${pos.below ? '0' : '-100%'})` }}
          >
            {tip}
          </div>,
          // A modal <dialog> lives in the browser top layer, which stacks above
          // every z-index — a body portal would render underneath it. Portal
          // into the dialog itself when the anchor is inside one (fixed
          // positioning stays viewport-relative either way).
          anchorRef.current?.closest('dialog') ?? document.body
        )}
    </span>
  )
}
