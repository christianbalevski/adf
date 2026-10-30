import { useId, useLayoutEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import '../../styles/compact-web.css'

import { activateCompactOverlay } from './compact-overlay-focus'

/** Full-screen navigation, keeping the workspace mounted underneath. A normal
 * portal allows existing body-portaled menus and native dialogs above it. */
export function CompactOverlay({ open, title, onClose, children, id }: {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
  id?: string
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const hasOpened = useRef(false)
  if (open) hasOpened.current = true
  const closeRef = useRef<HTMLButtonElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const titleId = useId()

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!open || !root) return
    return activateCompactOverlay(root, closeRef.current ?? root, () => onCloseRef.current())
  }, [open])

  // Mount on first use, then retain searches, scroll and form state when closed.
  if (!hasOpened.current) return null
  return createPortal(
    <div ref={rootRef} id={id} role="dialog" aria-modal={open || undefined} aria-labelledby={titleId} tabIndex={-1} hidden={!open} inert={!open} data-compact-overlay className="compact-web-overlay">
      <header className="compact-web-overlay-header">
        <h2 id={titleId} className="min-w-0 truncate text-sm font-semibold">{title}</h2>
        <button ref={closeRef} type="button" onClick={onClose} aria-label={`Close ${title}`} className="compact-web-navigation-button">
          <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 6 12 12M18 6 6 18" /></svg>
          <span>Close</span>
        </button>
      </header>
      <div className="compact-web-overlay-content">{children}</div>
    </div>,
    document.body,
  )
}
