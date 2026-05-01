import { useEffect, useRef } from 'react'

interface DialogProps {
  open: boolean
  onClose: () => void
  title: string
  children: React.ReactNode
  wide?: boolean
}

export function Dialog({ open, onClose, title, children, wide }: DialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)

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
      className={`rounded-xl shadow-2xl border-none p-0 backdrop:bg-black/30 w-full dark:bg-neutral-800 ${wide ? 'max-w-2xl' : 'max-w-md'}`}
      style={{ margin: 'auto', position: 'fixed', inset: 0, height: 'fit-content' }}
    >
      <div className="p-5">
        <h2 className="text-lg font-semibold text-neutral-800 dark:text-neutral-100 mb-4">
          {title}
        </h2>
        {children}
      </div>
    </dialog>
  )
}
