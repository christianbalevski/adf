import { useState, useRef, useEffect, useCallback } from 'react'

/**
 * Agent avatar picker: the current emoji as a button, and the full emoji set
 * (emoji-mart, bundled data, no network) in a popover. The picker is a web
 * component, so it is mounted into a ref rather than rendered by React.
 *
 * emoji-mart and its data set are the single largest dependency the agent
 * panel drags in, and the closed button needs neither, so they are imported
 * only when the popover first opens.
 */
export function IconPicker({
  value,
  onChange,
  className
}: {
  value: string
  onChange: (icon: string) => void
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  const close = useCallback(() => setOpen(false), [])

  useEffect(() => {
    if (!open) return
    const host = hostRef.current
    if (!host) return
    // Theme follows the app's `dark` class, not the OS: Settings › Appearance
    // can pin either theme regardless of what the system prefers.
    const dark = document.documentElement.classList.contains('dark')
    let cancelled = false
    void Promise.all([import('emoji-mart'), import('@emoji-mart/data')]).then(
      ([{ Picker }, emojiData]) => {
        if (cancelled) return
        const picker = new Picker({
          data: emojiData.default,
          theme: dark ? 'dark' : 'light',
          set: 'native',
          previewPosition: 'none',
          skinTonePosition: 'search',
          navPosition: 'top',
          maxFrequentRows: 1,
          perLine: 9,
          emojiSize: 20,
          emojiButtonSize: 30,
          autoFocus: true,
          onEmojiSelect: (emoji: { native?: string }) => {
            if (emoji.native) onChangeRef.current(emoji.native)
            close()
          }
        }) as unknown as HTMLElement
        host.replaceChildren(picker)
      }
    )

    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      cancelled = true
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      host.replaceChildren()
    }
  }, [open, close])

  return (
    <div ref={rootRef} className={`relative inline-block ${className ?? ''}`}>
      <button
        type="button"
        onClick={() => setOpen((p) => !p)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Choose icon"
        className="h-8 w-12 flex items-center justify-center gap-1 rounded-[var(--adf-ui-control-radius)] border border-[var(--adf-ui-border)] bg-[var(--adf-ui-surface)] hover:bg-[var(--adf-ui-surface-hover)] outline-none focus-visible:ring-1 focus-visible:ring-[var(--adf-ui-focus)]"
      >
        <span className="text-base leading-none">{value}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--adf-ui-text-subtle)]" aria-hidden="true">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div
          ref={hostRef}
          role="dialog"
          aria-label="Icon picker"
          className="absolute left-0 top-full mt-1 z-50 rounded-[var(--adf-ui-container-radius)] overflow-hidden shadow-card"
        />
      )}
    </div>
  )
}
