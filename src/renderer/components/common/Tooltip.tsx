import { useState, useRef, useCallback, useEffect, useId, type CSSProperties, type FocusEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/** The control a tooltip describes: the first focusable element in its anchor. */
const FOCUSABLE = 'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

/**
 * CSS tooltip replacing native `title` attributes, which Electron does not
 * render in hidden-titlebar windows (titleBarStyle: 'hidden'/'hiddenInset').
 * Rendered into a body portal with fixed positioning so it never gets
 * clipped by overflow containers.
 *
 * Shows on hover and on keyboard focus (`:focus-visible`, so a click does not
 * leave it up), hides on Escape. While shown it is `role="tooltip"` and the
 * control inside the anchor names it in `aria-describedby`.
 */
export function Tooltip({ tip, shortcut, children, className, style, delay = 500, disabled = false }: {
  tip: string
  /** Key combination shown after the text, e.g. "Ctrl+,". */
  shortcut?: string
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
  const id = useId()

  const show = useCallback((wait: number = delay) => {
    if (disabled) return
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      const r = anchorRef.current?.getBoundingClientRect()
      if (!r) return
      const below = r.top < 64
      const halfWidth = 132 // matches max-w below
      const x = Math.min(Math.max(r.left + r.width / 2, halfWidth + 8), window.innerWidth - halfWidth - 8)
      setPos({ x, y: below ? r.bottom + 6 : r.top - 6, below })
    }, wait)
  }, [delay, disabled])

  const hide = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = null
    setPos(null)
  }, [])

  const onFocus = useCallback((e: FocusEvent) => {
    // Keyboard focus only: a click focuses the button too, and hover covers the pointer.
    let keyboard = true
    try { keyboard = (e.target as Element).matches(':focus-visible') } catch { /* no :focus-visible: treat as keyboard */ }
    if (keyboard) show(Math.min(delay, 300))
  }, [delay, show])

  useEffect(() => hide, [hide])
  useEffect(() => {
    if (disabled) hide()
  }, [disabled, hide])

  // Escape dismisses a shown tip without moving focus.
  useEffect(() => {
    if (!pos) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') hide() }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [pos, hide])

  // While shown, the control inside the anchor is described by the tip.
  useEffect(() => {
    if (!pos) return
    const target = anchorRef.current?.querySelector<HTMLElement>(FOCUSABLE) ?? anchorRef.current
    if (!target) return
    const before = target.getAttribute('aria-describedby')
    target.setAttribute('aria-describedby', before ? `${before} ${id}` : id)
    return () => {
      if (before) target.setAttribute('aria-describedby', before)
      else target.removeAttribute('aria-describedby')
    }
  }, [pos, id])

  return (
    <span
      ref={anchorRef}
      onMouseEnter={() => show()}
      onMouseLeave={hide}
      onFocus={onFocus}
      onBlur={hide}
      className={className}
      style={style}
    >
      {children}
      {pos &&
        createPortal(
          <div
            id={id}
            role="tooltip"
            className="fixed z-[1000] max-w-[264px] px-2 py-1.5 text-[10px] leading-snug whitespace-pre-line [overflow-wrap:anywhere] rounded-md shadow-float pointer-events-none bg-[var(--adf-ui-surface)] text-[var(--adf-ui-text)] border border-[var(--adf-ui-border)]"
            style={{ left: pos.x, top: pos.y, transform: `translate(-50%, ${pos.below ? '0' : '-100%'})` }}
          >
            {tip}
            {shortcut && <span className="ml-1.5 text-[var(--adf-ui-text-subtle)]">{shortcut}</span>}
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
