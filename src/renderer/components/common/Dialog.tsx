import { useEffect, useId, useRef } from 'react'

interface DialogProps {
  open: boolean
  onClose: () => void
  title: string
  children: React.ReactNode
  wide?: boolean
  extraWide?: boolean
  /** Block the native Escape cancel (e.g. while an operation is in flight). */
  preventClose?: boolean
  /**
   * Close when the backdrop is clicked. Defaults to true. Pass false on
   * dialogs that hold unsaved input: a stray click outside must not drop
   * a half-filled form. Escape and the close button still work either way.
   */
  lightDismiss?: boolean
}

export function Dialog({ open, onClose, title, children, wide, extraWide, preventClose, lightDismiss = true }: DialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const backdropPressRef = useRef(false)
  const titleId = useId()

  useEffect(() => {
    const el = dialogRef.current
    if (!el) return
    if (open) {
      el.showModal()
    } else {
      el.close()
    }
  }, [open])

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onCancel={(e) => { if (preventClose) e.preventDefault() }}
      onPointerDown={(e) => { backdropPressRef.current = e.target === dialogRef.current }}
      onClick={(e) => {
        // A click on the ::backdrop is dispatched to the <dialog> itself;
        // clicks inside the panel land on the content wrapper instead. The
        // pointerdown check keeps a text-drag that starts in the panel and
        // ends on the backdrop (which also targets the <dialog>) from closing.
        if (lightDismiss && !preventClose && backdropPressRef.current && e.target === dialogRef.current) onClose()
        backdropPressRef.current = false
      }}
      aria-labelledby={titleId}
      className={`w-[calc(100%_-_2rem)] overflow-hidden rounded-[var(--adf-ui-container-radius)] border border-[var(--adf-ui-border)] bg-[var(--adf-ui-surface)] p-0 text-[var(--adf-ui-text)] [box-shadow:var(--adf-ui-dialog-shadow)] open:[animation:meshFadeIn_150ms_ease-out] backdrop:bg-black/40 backdrop:backdrop-blur-sm backdrop:[animation:dialogBackdropIn_150ms_ease-out] ${extraWide ? 'max-w-5xl' : wide ? 'max-w-2xl' : 'max-w-md'}`}
      style={{ margin: 'auto', position: 'fixed', inset: 0, height: 'fit-content' }}
    >
      <div className="max-h-[calc(100dvh_-_2rem)] overflow-y-auto p-5">
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 id={titleId} className="text-[15px] font-semibold tracking-tight text-[var(--adf-ui-text)]">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={preventClose}
            aria-label="Close"
            className="-mr-1 -mt-1 shrink-0 rounded-[var(--adf-ui-control-radius)] p-1 text-[var(--adf-ui-text-muted)] transition-colors hover:bg-[var(--adf-ui-surface-hover)] hover:text-[var(--adf-ui-text)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--adf-ui-accent)]"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        {children}
      </div>
    </dialog>
  )
}
