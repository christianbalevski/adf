const FOCUSABLE = 'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
const NESTED_SURFACE = 'dialog[open], [role="menu"], [role="listbox"], [data-compact-overlay]'

/** Preserve native modal and menu focus while containing full-screen navigation. */
export function activateCompactOverlay(root: HTMLElement, initialFocus: HTMLElement, onClose: () => void): () => void {
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
  // Hidden overlays already own their inert state. Do not restore a stale
  // value onto one that React opens in the same commit this overlay closes.
  const siblings = Array.from(document.body.children).filter((element): element is HTMLElement => element instanceof HTMLElement && element !== root && !element.hidden)
  const inertBefore = siblings.map(element => element.inert)
  siblings.forEach(element => { element.inert = true })
  initialFocus.focus({ preventScroll: true })

  const nestedSurface = (target: HTMLElement) => {
    const surface = target.closest(NESTED_SURFACE)
    return surface !== null && surface !== root
  }
  const keydown = (event: KeyboardEvent) => {
    if (root.inert || event.defaultPrevented) return
    const target = event.target instanceof HTMLElement ? event.target : null
    if (target && nestedSurface(target)) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
    } else if (event.key === 'Tab') {
      const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(element => !element.closest('[inert], [hidden]') && element.getClientRects().length > 0)
      const first = items[0] ?? root
      const last = items.at(-1) ?? root
      if (event.shiftKey && (document.activeElement === first || document.activeElement === root)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === root)) {
        event.preventDefault()
        first.focus()
      }
    }
  }
  const containFocus = (event: FocusEvent) => {
    if (root.inert || !(event.target instanceof HTMLElement)) return
    if (!root.contains(event.target) && !nestedSurface(event.target)) initialFocus.focus({ preventScroll: true })
  }
  document.addEventListener('keydown', keydown)
  document.addEventListener('focusin', containFocus)
  return () => {
    document.removeEventListener('keydown', keydown)
    document.removeEventListener('focusin', containFocus)
    siblings.forEach((element, index) => { element.inert = inertBefore[index] })
    if (previous?.isConnected && !previous.closest('[inert]')) previous.focus({ preventScroll: true })
  }
}
