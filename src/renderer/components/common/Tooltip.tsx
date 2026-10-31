import { useState, useRef, useCallback, useEffect, useLayoutEffect, useId, type CSSProperties, type FocusEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { arrow, autoUpdate, computePosition, flip, hide as hideClipped, offset, shift, type Placement } from '@floating-ui/dom'
import { isCompactWebLayout } from '../../hooks/useCompactWebLayout'

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
export function Tooltip({ tip, shortcut, children, className, style, delay = 500, disabled = false, placement = 'top', appearance = 'hint' }: {
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
  /** Preferred side of the control; flips when there is not enough room. */
  placement?: Placement
  /** Compact identity label, or the usual explanatory hint. */
  appearance?: 'hint' | 'label'
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ x: number; y: number; hidden: boolean; side: string; arrowX?: number; arrowY?: number } | null>(null)
  const anchorRef = useRef<HTMLSpanElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const arrowRef = useRef<HTMLSpanElement>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const id = useId()

  const show = useCallback((wait: number = delay) => {
    if (disabled) return
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      setOpen(true)
    }, wait)
  }, [delay, disabled])

  const hide = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = null
    setOpen(false)
    setPos(null)
  }, [])

  // Measure the actual text and follow the anchor through scrolling, resizing,
  // and layout changes. A fixed width estimate detaches short tips from icons.
  useLayoutEffect(() => {
    const anchor = anchorRef.current
    const tooltip = tooltipRef.current
    if (!open || !anchor || !tooltip) return
    let cancelled = false
    const update = () => {
      void computePosition(anchor, tooltip, {
        strategy: 'fixed',
        placement,
        middleware: [offset(8), flip({ padding: 8 }), shift({ padding: 8 }), hideClipped(), ...(arrowRef.current ? [arrow({ element: arrowRef.current, padding: 5 })] : [])],
      }).then(({ x, y, placement: resolvedPlacement, middlewareData }) => {
        if (!cancelled) setPos({ x, y, hidden: !!middlewareData.hide?.referenceHidden, side: resolvedPlacement.split('-')[0], arrowX: middlewareData.arrow?.x, arrowY: middlewareData.arrow?.y })
      })
    }
    const cleanup = autoUpdate(anchor, tooltip, update)
    return () => { cancelled = true; cleanup() }
  }, [open, placement, tip, shortcut, appearance])

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
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') hide() }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, hide])

  // While shown, the control inside the anchor is described by the tip.
  useEffect(() => {
    if (!open) return
    const target = anchorRef.current?.querySelector<HTMLElement>(FOCUSABLE) ?? anchorRef.current
    if (!target) return
    const before = target.getAttribute('aria-describedby')
    target.setAttribute('aria-describedby', before ? `${before} ${id}` : id)
    return () => {
      if (before) target.setAttribute('aria-describedby', before)
      else target.removeAttribute('aria-describedby')
    }
  }, [open, id])

  return (
    <span
      ref={anchorRef}
      // Touch browsers synthesize mouseenter after a tap, often without a
      // matching mouseleave. Only a real mouse should start hover hints there.
      onMouseEnter={() => { if (!isCompactWebLayout()) show() }}
      onMouseLeave={hide}
      onPointerEnter={(e) => { if (isCompactWebLayout() && e.pointerType === 'mouse') show() }}
      onPointerLeave={(e) => { if (isCompactWebLayout() && e.pointerType === 'mouse') hide() }}
      onPointerDown={(e) => { if (isCompactWebLayout() && e.pointerType === 'touch') hide() }}
      onFocus={onFocus}
      onBlur={hide}
      className={className}
      style={style}
    >
      {children}
      {open &&
        createPortal(
          <div
            id={id}
            ref={tooltipRef}
            role="tooltip"
            className={`fixed z-[1000] w-max max-w-[min(264px,calc(100vw-16px))] pointer-events-none bg-[var(--adf-ui-surface)] text-[var(--adf-ui-text)] border [overflow-wrap:anywhere] ${appearance === 'label'
              ? 'px-2 py-1 font-sans text-[11px] font-medium leading-4 rounded-[var(--adf-ui-control-radius)] border-hairline shadow-sm'
              : 'px-2 py-1.5 text-[10px] leading-snug whitespace-pre-line rounded-md border-[var(--adf-ui-border)] shadow-float'}`}
            style={{ left: pos?.x ?? 0, top: pos?.y ?? 0, visibility: pos && !pos.hidden ? 'visible' : 'hidden' }}
          >
            {appearance === 'label' && (
              <span
                ref={arrowRef}
                aria-hidden
                className={`absolute h-1.5 w-1.5 rotate-45 bg-[var(--adf-ui-surface)] border-hairline ${
                  pos?.side === 'left' ? 'border-t border-r' : pos?.side === 'top' ? 'border-b border-r' : pos?.side === 'bottom' ? 'border-t border-l' : 'border-b border-l'
                }`}
                style={{ left: pos?.arrowX, top: pos?.arrowY, [{ right: 'left', left: 'right', top: 'bottom', bottom: 'top' }[pos?.side ?? 'right']!]: -4 }}
              />
            )}
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
