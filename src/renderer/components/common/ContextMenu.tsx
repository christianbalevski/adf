import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useCompactWebLayout } from '../../hooks/useCompactWebLayout'

export interface ContextMenuItem {
  label: string
  onSelect: () => void
  disabled?: boolean
  danger?: boolean
  /** Draw a hairline above this item. */
  separatorBefore?: boolean
  /** One muted line under the label, e.g. why the item is disabled. */
  hint?: string
}

interface ContextMenuProps {
  /** Pointer position (clientX/clientY) the menu opens at. `null` = closed. */
  position: { x: number; y: number } | null
  /** The menu's items; or `children`, a body of its own whose `role="menuitem"` buttons the keys move between. */
  items?: ContextMenuItem[]
  /** A body in place of `items`: choosing in it does not close the menu (it shows what it did). */
  children?: ReactNode
  onClose: () => void
  /**
   * How the menu sits on `position`: the default opens right and down from it;
   * `end` aligns the menu's right edge to it, `above` its bottom edge (a menu
   * opened from a button near the viewport bottom).
   */
  placement?: { x?: 'start' | 'end'; y?: 'below' | 'above' }
  /** Accessible name of the menu. */
  label?: string
  /**
   * The control that opened the menu (a popover's button): Escape and Tab
   * give the focus back to it, and a press on it is not outside, so its own
   * click toggles the menu.
   */
  anchor?: RefObject<HTMLElement | null>
}

const EDGE = 4

/**
 * Fixed-position menu anchored at the pointer and clamped to the viewport.
 * Rendered into a body portal so overflow containers never clip it. Closes on
 * outside pointerdown, Escape, window blur, any scroll, or after an item is
 * chosen. Arrow keys move focus between enabled items; Enter/Space select;
 * Escape and Tab give the focus back to what had it when the menu opened.
 */
export function ContextMenu({ position, items = [], children, onClose, placement, label, anchor }: ContextMenuProps) {
  const compact = useCompactWebLayout()
  const viewport = compact ? window.visualViewport : undefined
  const viewportWidth = viewport?.width ?? (compact ? window.innerWidth : 0)
  const viewportHeight = viewport?.height ?? (compact ? window.innerHeight : 0)
  const viewportLeft = viewport?.offsetLeft ?? 0
  const viewportTop = viewport?.offsetTop ?? 0
  const menuRef = useRef<HTMLDivElement>(null)
  // The menu's items in order: the buttons of `items`, or those of `children`.
  const menuItems = (): HTMLButtonElement[] =>
    Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])
  // Where the menu sits once measured; the edges it is anchored by stay put when its body grows.
  const [clamped, setClamped] = useState<{ x: number; y: number; right: number; bottom: number } | null>(null)
  // What had the focus when the menu opened: Escape and Tab give it back.
  const returnFocusRef = useRef<HTMLElement | null>(null)

  const open = position !== null

  // Measure after render, clamp into the viewport, then focus the first
  // enabled item. useLayoutEffect so the unclamped frame is never painted.
  useLayoutEffect(() => {
    if (!position) {
      setClamped(null)
      returnFocusRef.current = null
      return
    }
    const el = menuRef.current
    if (!el) return
    const before = document.activeElement
    if (!returnFocusRef.current && before instanceof HTMLElement && !el.contains(before)) returnFocusRef.current = before
    const r = el.getBoundingClientRect()
    const x = placement?.x === 'end' ? position.x - r.width : position.x
    const y = placement?.y === 'above' ? position.y - r.height : position.y
    const leftEdge = compact ? viewportLeft + EDGE : EDGE
    const topEdge = compact ? viewportTop + EDGE : EDGE
    const rightEdge = compact ? viewportLeft + viewportWidth : window.innerWidth
    const bottomEdge = compact ? viewportTop + viewportHeight : window.innerHeight
    const left = Math.max(leftEdge, Math.min(x, rightEdge - r.width - EDGE))
    const top = Math.max(topEdge, Math.min(y, bottomEdge - r.height - EDGE))
    setClamped({ x: left, y: top, right: window.innerWidth - left - r.width, bottom: window.innerHeight - top - r.height })
    // Focus moves into the menu: its first enabled item, else the menu itself
    // (so Escape and a disabled item's hint still reach a keyboard user).
    const first = menuItems().find((b) => !b.disabled)
    ;(first ?? el).focus()
  }, [position, placement?.x, placement?.y, compact, viewportLeft, viewportTop, viewportWidth, viewportHeight])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      if (anchor?.current?.contains(e.target as Node)) return
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose()
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        closeAndReturnFocus()
      }
    }
    const onScroll = (e: Event) => {
      // A long touch menu must be scrollable without dismissing itself.
      if (compact && e.target instanceof Node && menuRef.current?.contains(e.target)) return
      onClose()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('blur', onClose)
    window.addEventListener('scroll', onScroll, true)
    if (compact) viewport?.addEventListener('resize', onClose)
    window.addEventListener('resize', onClose)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('scroll', onScroll, true)
      if (compact) viewport?.removeEventListener('resize', onClose)
      window.removeEventListener('resize', onClose)
    }
  }, [open, onClose, compact, viewport])

  /** Close, and give the focus back to the anchor, else to what had it when the menu opened. */
  function closeAndReturnFocus() {
    const back = anchor?.current ?? returnFocusRef.current
    onClose()
    if (back?.isConnected) back.focus()
  }

  if (!position) return null

  const moveFocus = (from: number, delta: 1 | -1) => {
    const buttons = menuItems()
    const n = buttons.length
    for (let step = 1; step <= n; step++) {
      const idx = (from + delta * step + n * step) % n
      const b = buttons[idx]
      if (b && !b.disabled) {
        b.focus()
        return
      }
    }
  }

  const handleMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const current = menuItems().findIndex((b) => b === document.activeElement)
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      moveFocus(current, 1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      moveFocus(current === -1 ? 0 : current, -1)
    } else if (e.key === 'Home') {
      e.preventDefault()
      moveFocus(-1, 1)
    } else if (e.key === 'End') {
      e.preventDefault()
      moveFocus(0, -1)
    } else if (e.key === 'Tab' || e.key === 'Escape') {
      // Escape normally ends at the document listener first; here too, for a menu that has the focus without it.
      e.preventDefault()
      e.stopPropagation()
      closeAndReturnFocus()
    }
  }

  const select = (item: ContextMenuItem) => {
    if (item.disabled) return
    onClose()
    item.onSelect()
  }

  const at = clamped ?? position

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={handleMenuKeyDown}
      onContextMenu={(e) => e.preventDefault()}
      className="fixed z-[1000] outline-none bg-surface-raised border border-[var(--adf-ui-border)] shadow-float rounded-[var(--adf-ui-container-radius)] py-1 min-w-[180px] text-[12px] text-[var(--adf-ui-text)] select-none"
      style={{
        ...(compact ? {
          minWidth: Math.min(180, Math.max(0, viewportWidth - EDGE * 2)),
          maxWidth: Math.max(0, viewportWidth - EDGE * 2),
          maxHeight: Math.max(0, viewportHeight - EDGE * 2),
          overflowY: 'auto',
          overflowX: 'hidden',
          overscrollBehavior: 'contain',
          overflowWrap: 'anywhere'
        } : {}),
        ...(clamped && placement?.x === 'end' ? { right: clamped.right } : { left: at.x }),
        ...(clamped && placement?.y === 'above' ? { bottom: clamped.bottom } : { top: at.y }),
        visibility: clamped ? 'visible' : 'hidden'
      }}
    >
      {children ?? items.map((item, i) => (
        <div key={i}>
          {item.separatorBefore && <div className="border-t border-hairline my-1" />}
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            disabled={item.disabled}
            aria-disabled={item.disabled || undefined}
            onClick={() => select(item)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                select(item)
              }
            }}
            className={`${compact ? 'min-h-11 ' : ''}block w-full px-3 py-1.5 text-left outline-none hover:bg-[var(--adf-ui-surface-hover)] focus-visible:bg-[var(--adf-ui-surface-hover)] disabled:opacity-40 disabled:hover:bg-transparent ${
              item.danger ? 'text-[var(--adf-ui-danger)]' : ''
            }`}
          >
            {item.label}
          </button>
          {item.hint && (
            <div className="-mt-1 max-w-[260px] px-3 pb-1.5 text-[11px] text-[var(--adf-ui-text-muted)]">{item.hint}</div>
          )}
        </div>
      ))}
    </div>,
    document.body
  )
}
