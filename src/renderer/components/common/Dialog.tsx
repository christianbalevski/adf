import { useEffect, useId, useRef } from 'react'

interface DialogProps {
  open: boolean
  onClose: () => void
  title: string
  children: React.ReactNode
  wide?: boolean
}

export function Dialog({ open, onClose, title, children, wide }: DialogProps) {
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
      className={`w-[calc(100%_-_2rem)] overflow-hidden rounded-[var(--adf-ui-container-radius)] border border-[var(--adf-ui-border)] bg-[var(--adf-ui-surface)] p-0 text-[var(--adf-ui-text)] [box-shadow:var(--adf-ui-dialog-shadow)] backdrop:bg-black/35 ${wide ? 'max-w-2xl' : 'max-w-md'}`}
      style={{ margin: 'auto', position: 'fixed', inset: 0, height: 'fit-content' }}
    >
      <div className="max-h-[calc(100dvh_-_2rem)] overflow-y-auto p-5">
        <h2 id={titleId} className="mb-4 text-[15px] font-semibold tracking-tight text-[var(--adf-ui-text)]">
          {title}
        </h2>
        {children}
      </div>
    </dialog>
  )
}
