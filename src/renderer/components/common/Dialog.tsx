import { useEffect, useId, useRef } from 'react'

interface DialogProps {
  open: boolean
  onClose: () => void
  title: string
  children: React.ReactNode
  wide?: boolean
  extraWide?: boolean
}

export function Dialog({ open, onClose, title, children, wide, extraWide }: DialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
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
      aria-labelledby={titleId}
      className={`w-[calc(100%_-_2rem)] overflow-hidden rounded-[var(--adf-ui-container-radius)] border border-[var(--adf-ui-border)] bg-[var(--adf-ui-surface)] p-0 text-[var(--adf-ui-text)] [box-shadow:var(--adf-ui-dialog-shadow)] backdrop:bg-black/35 ${extraWide ? 'max-w-5xl' : wide ? 'max-w-2xl' : 'max-w-md'}`}
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
